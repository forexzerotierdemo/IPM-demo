// The dispatch board, exercised the way app.js exercises it: through a real
// JWT, so the §6 policies and the permission gates are in force. Checks the
// response SHAPES against what the renderers in app.js actually read —
// §12's failure #4 is response shapes drifting from the Python handlers.
const { env, login } = require('./env');

const rpc = async (token, fn, args = {}) => {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: env.ANON, Authorization: 'Bearer ' + token,
               'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || j.hint || `HTTP ${r.status}`);
  return j;
};

const ym = (d) => d.toISOString().slice(0, 10);
const monthStart = () => { const d = new Date(); d.setUTCDate(1); return ym(d); };
const monthEnd = () => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1, 0); return ym(d); };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  const admin = await login('admin@demo.foxcrm.app');
  const engineer = await login('engineer@demo.foxcrm.app');
  // An area manager holds dispatch.view but only over their own patch — the
  // right account to prove the board is SCOPED and not merely filtered.
  const area = await login('area@demo.foxcrm.app');

  // ---- grid ------------------------------------------------------------
  console.log('\n/dispatch/grid');
  const g = await rpc(admin, 'dispatch_grid', { p_from: monthStart(), p_to: monthEnd() });
  check('has from/to/days/engineers/cells',
        ['from', 'to', 'days', 'engineers', 'cells'].every(k => k in g),
        Object.keys(g).join(','));
  check('days covers the month', Array.isArray(g.days) && g.days.length >= 28,
        String(g.days && g.days.length));
  check('engineers are {id, full_name}',
        g.engineers.length > 0 && 'id' in g.engineers[0] && 'full_name' in g.engineers[0],
        JSON.stringify(g.engineers[0]));
  check('cells are {agent_id,date,count,first,last}',
        g.cells.length > 0 &&
        ['agent_id', 'date', 'count', 'first', 'last'].every(k => k in g.cells[0]),
        JSON.stringify(g.cells[0]));
  check('first <= last within a cell', g.cells.every(c => c.first <= c.last));
  check('every cell belongs to a listed engineer',
        g.cells.every(c => g.engineers.some(e => e.id === c.agent_id)));
  console.log(`       ${g.cells.length} cells, ${g.engineers.length} engineers, ` +
              `${g.cells.reduce((a, c) => a + c.count, 0)} visits`);

  // The 62-day guard.
  let guarded = false;
  try { await rpc(admin, 'dispatch_grid', { p_from: '2026-01-01', p_to: '2026-12-31' }); }
  catch (e) { guarded = /two months/.test(e.message); }
  check('refuses more than two months', guarded);

  // Filters.
  const oneAgent = g.engineers[0].id;
  const gf = await rpc(admin, 'dispatch_grid',
                       { p_from: monthStart(), p_to: monthEnd(), p_agent: oneAgent });
  check('?agent filters engineers and cells',
        gf.engineers.length === 1 && gf.cells.every(c => c.agent_id === oneAgent));

  // ---- the board is scoped, not just filtered --------------------------
  const ga = await rpc(area, 'dispatch_grid', { p_from: monthStart(), p_to: monthEnd() });
  const adminTotal = g.cells.reduce((a, c) => a + c.count, 0);
  const areaTotal = ga.cells.reduce((a, c) => a + c.count, 0);
  check('an area manager sees strictly less of the board than admin',
        areaTotal > 0 && areaTotal < adminTotal, `${areaTotal} vs ${adminTotal}`);

  // An engineer holds no dispatch.view at all, so the board is refused
  // outright rather than merely coming back empty.
  let noBoard = '';
  try { await rpc(engineer, 'dispatch_grid', { p_from: monthStart(), p_to: monthEnd() }); }
  catch (e) { noBoard = e.message; }
  check('an engineer gets no board at all', /Not permitted/.test(noBoard), noBoard || '(allowed!)');

  // ---- cell ------------------------------------------------------------
  console.log('\n/dispatch/cell');
  const busiest = g.cells.slice().sort((a, b) => b.count - a.count)[0];
  const cell = await rpc(admin, 'dispatch_cell',
                         { p_date: busiest.date, p_agent: busiest.agent_id });
  check('has date/agent_id/visits',
        ['date', 'agent_id', 'visits'].every(k => k in cell));
  check('visits are {id,time,site_name,status,area_id}',
        cell.visits.length > 0 &&
        ['id', 'time', 'site_name', 'status', 'area_id'].every(k => k in cell.visits[0]),
        JSON.stringify(cell.visits[0]));
  check('cell count matches the grid cell', cell.visits.length === busiest.count,
        `${cell.visits.length} vs ${busiest.count}`);
  check('time is HH:MM', cell.visits.every(v => /^\d{2}:\d{2}$/.test(v.time)));

  // ---- sla -------------------------------------------------------------
  console.log('\n/dispatch/sla');
  const sla = await rpc(admin, 'dispatch_sla');
  check('has items/counts', 'items' in sla && 'counts' in sla);
  check('counts always carry all three tiers',
        ['ok', 'due_soon', 'overdue'].every(k => k in sla.counts),
        JSON.stringify(sla.counts));
  check('counts sum to items', Object.values(sla.counts).reduce((a, b) => a + b, 0)
        === sla.items.length);
  if (sla.items.length) {
    check('items carry what the strip renders',
          ['client_id', 'client_en', 'client_ar', 'site_name', 'frequency',
           'last_service', 'days_overdue', 'status'].every(k => k in sla.items[0]),
          Object.keys(sla.items[0]).join(','));
  }

  // ---- move ------------------------------------------------------------
  console.log('\n/dispatch/move');
  // Pick a scheduled visit in the future so the demo data is not disturbed
  // in a way anyone would notice, and remember where it was.
  const future = await fetch(
    `${env.SUPABASE_URL}/rest/v1/visits?select=id,agent_id,site_id,scheduled_start` +
    `&status=eq.scheduled&order=scheduled_start.desc&limit=1`,
    { headers: { apikey: env.ANON, Authorization: 'Bearer ' + admin } }).then(r => r.json());
  const target = future[0];
  // The engineer to hand it to has to be permitted in that branch's area —
  // otherwise the move is refused for a reason that has nothing to do with
  // what this test is asking about.
  const site = await fetch(
    `${env.SUPABASE_URL}/rest/v1/sites?select=area_id&id=eq.${target.site_id}`,
    { headers: { apikey: env.ANON, Authorization: 'Bearer ' + admin } }).then(r => r.json());
  const permitted = await fetch(
    `${env.SUPABASE_URL}/rest/v1/agent_areas?select=agent_id&area_id=eq.${site[0].area_id}`,
    { headers: { apikey: env.ANON, Authorization: 'Bearer ' + admin } }).then(r => r.json());
  const permittedIds = new Set(permitted.map(r => r.agent_id));
  const otherAgent = g.engineers.find(e => e.id !== target.agent_id && permittedIds.has(e.id))
                  || g.engineers.find(e => permittedIds.has(e.id));

  // A day the branch is not open must be refused, by name.
  const closed = await fetch(
    `${env.SUPABASE_URL}/rest/v1/site_service_days?select=weekday&site_id=eq.${target.site_id}`,
    { headers: { apikey: env.ANON, Authorization: 'Bearer ' + admin } }).then(r => r.json());
  const open = new Set(closed.map(r => r.weekday));
  const shutWd = [0, 1, 2, 3, 4, 5, 6].find(w => !open.has(w));
  if (shutWd !== undefined) {
    // find a date in the next fortnight whose app-weekday is shutWd
    let probe = null;
    for (let i = 1; i <= 14; i++) {
      const d = new Date(Date.now() + i * 86400000);
      if ((d.getUTCDay() + 6) % 7 === shutWd) { probe = ym(d); break; }
    }
    let msg = '';
    try { await rpc(admin, 'dispatch_move',
                    { p_visit_ids: [target.id], p_agent_id: target.agent_id, p_date: probe }); }
    catch (e) { msg = e.message; }
    check('refuses a day the branch is shut, naming the branch and the day',
          /is not open on a/.test(msg), msg || '(it allowed the move)');
  }

  // One branch, one day, one van.
  const sameDay = await fetch(
    `${env.SUPABASE_URL}/rest/v1/visits?select=id,site_id,scheduled_start` +
    `&site_id=eq.${target.site_id}&id=neq.${target.id}&limit=1`,
    { headers: { apikey: env.ANON, Authorization: 'Bearer ' + admin } }).then(r => r.json());
  if (sameDay.length) {
    let msg = '';
    try { await rpc(admin, 'dispatch_move',
                    { p_visit_ids: [target.id], p_agent_id: target.agent_id,
                      p_date: sameDay[0].scheduled_start.slice(0, 10) }); }
    catch (e) { msg = e.message; }
    check('refuses two vans at one branch on one day',
          /one branch, one day, one van/.test(msg), msg || '(it allowed the move)');
  }

  // A move that IS drivable must go through, and be undoable.
  const openWd = [...open][0];
  let goodDate = null;
  for (let i = 1; i <= 14; i++) {
    const d = new Date(Date.now() + i * 86400000);
    if ((d.getUTCDay() + 6) % 7 === openWd) { goodDate = ym(d); break; }
  }
  const clash = await fetch(
    `${env.SUPABASE_URL}/rest/v1/visits?select=id&site_id=eq.${target.site_id}` +
    `&scheduled_start=like.${goodDate}*&id=neq.${target.id}`,
    { headers: { apikey: env.ANON, Authorization: 'Bearer ' + admin } }).then(r => r.json());
  if (goodDate && !clash.length && otherAgent) {
    const before = target.scheduled_start;
    const res = await rpc(admin, 'dispatch_move',
                          { p_visit_ids: [target.id], p_agent_id: otherAgent.id, p_date: goodDate });
    check('accepts a drivable move', res.moved === 1 && res.date === goodDate,
          JSON.stringify(res));
    const after = await fetch(
      `${env.SUPABASE_URL}/rest/v1/visits?select=agent_id,scheduled_start&id=eq.${target.id}`,
      { headers: { apikey: env.ANON, Authorization: 'Bearer ' + admin } }).then(r => r.json());
    check('the diary actually moved',
          after[0].agent_id === otherAgent.id && after[0].scheduled_start.startsWith(goodDate),
          JSON.stringify(after[0]));
    // put it back exactly as it was
    await fetch(`${env.SUPABASE_URL}/rest/v1/visits?id=eq.${target.id}`, {
      method: 'PATCH',
      headers: { apikey: env.ANON, Authorization: 'Bearer ' + admin,
                 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ agent_id: target.agent_id, scheduled_start: before }),
    });
    console.log('       (visit restored)');
  }

  // An engineer holds no dispatch.view, so the board refuses him outright.
  let denied = '';
  try { await rpc(engineer, 'dispatch_move',
                  { p_visit_ids: [target.id], p_agent_id: otherAgent.id, p_date: goodDate }); }
  catch (e) { denied = e.message; }
  check('an engineer cannot move work', /Not permitted/.test(denied), denied || '(allowed!)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
