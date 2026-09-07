// The QR scan chain, exercised as each role that meets it.
//
// The point of the feature is the ENGINEER standing at a trap with a phone,
// and that is the role most likely to be broken by a permission model built
// from the office's point of view — an agent holds maps.view but not
// devices.view, so anything gated on the registry silently tells them the
// code is unknown.
const { env, login } = require('./env');

const H = t => ({ apikey: env.ANON, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
const rpc = async (t, fn, a = {}) => {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: H(t), body: JSON.stringify(a) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || j.hint || `HTTP ${r.status}`);
  return j;
};
const rest = async (t, q) =>
  (await fetch(`${env.SUPABASE_URL}/rest/v1/${q}`, { headers: H(t) })).json();

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const refused = async (fn) => {
  try { await fn(); return null; } catch (e) { return e.message; }
};

(async () => {
  const admin = await login('admin@demo.foxcrm.app', 'demo1234');
  const engineer = await login('engineer@demo.foxcrm.app', 'demo1234');
  const client = await login('client@demo.foxcrm.app', 'demo1234');

  // A trap belonging to the portal customer (client 1), so the portal case
  // is a real read rather than a refusal by accident.
  const dev = (await rest(admin,
    'devices?select=code,type,client_id,site_id&client_id=eq.1&type=eq.light_trap&limit=1'))[0];
  const code = dev.code;
  console.log(`\n/scan/${code}  (${dev.type}, client 1)`);

  // ---- the engineer: the whole reason the feature exists ---------------
  const d = await rpc(engineer, 'scan_lookup', { p_code: code });
  check('an ENGINEER can read a trap (maps.view, no devices.view)',
        d.code === code, JSON.stringify(d).slice(0, 80));
  check('landing carries identity, owner and branch',
        !!d.type && !!d.client_en && 'site_name' in d);
  check('history is a list and details is a STRING (app.js parses it)',
        Array.isArray(d.history) &&
        (d.history.length === 0 || typeof d.history[0].details === 'string'));
  check('lower-case code resolves too',
        (await rpc(engineer, 'scan_lookup', { p_code: code.toLowerCase() })).code === code);
  check('an unknown code is refused by name',
        (await refused(() => rpc(engineer, 'scan_lookup', { p_code: 'ZZZ9999' })))
          === 'Unknown device code');

  // ---- filing a reading -------------------------------------------------
  console.log('\nfiling a reading');
  const before = (await rpc(engineer, 'scan_lookup', { p_code: code })).history.length;
  const res = await rpc(engineer, 'scan_record', {
    p_code: code, p_status: 'needs_service',
    p_findings: 'Sheet full, lamp flickering',
    p_details: { fly_count: '31', lamp_status: 'damaged', lamp_action: 'next_visit',
                 sheet_status: 'full', pests_found: ['housefly', 'fruitfly'],
                 consumption_pct: '80', NOT_A_FIELD: 'x' } });
  check('the engineer can file a reading', res.ok === true, JSON.stringify(res));
  const after = await rpc(engineer, 'scan_lookup', { p_code: code });
  check('it lands in the history', after.history.length === before + 1);
  check('the trap status follows the reading', after.status === 'needs_service', after.status);

  const det = JSON.parse(after.history[0].details);
  check('junk keys are dropped', !('NOT_A_FIELD' in det), JSON.stringify(det));
  check('another type\'s field is dropped', !('consumption_pct' in det));
  check('numbers are coerced', typeof det.fly_count === 'number', String(det.fly_count));
  check('a tick-list is joined', det.pests_found === 'housefly,fruitfly', det.pests_found);
  check('a deferred fix is carried to the next visit',
        after.promised.some(p => p.field === 'lamp_action' && p.fault === 'damaged'),
        JSON.stringify(after.promised));

  // ---- the portal customer ---------------------------------------------
  console.log('\nthe customer portal');
  const cd = await rpc(client, 'scan_lookup', { p_code: code });
  check('a customer can read their OWN trap without maps.view', cd.code === code);
  check('...and cannot file a reading (no maps.edit)',
        (await refused(() => rpc(client, 'scan_record', { p_code: code, p_status: 'ok' })))
          === 'Not permitted');

  const other = (await rest(admin, 'devices?select=code&client_id=eq.2&limit=1'))[0];
  check('...and cannot read another company\'s trap',
        (await refused(() => rpc(client, 'scan_lookup', { p_code: other.code })))
          === 'No permission', other.code);

  // ---- the report -------------------------------------------------------
  console.log('\nthe report');
  const vid = after.history[0].visit_id;
  if (vid) {
    const cov = await rpc(engineer, 'visit_devices', { p_visit_id: vid });
    check('coverage counts the traps on that visit',
          typeof cov.total === 'number' && Array.isArray(cov.devices),
          `${cov.scanned}/${cov.total}`);

    const fu = await rpc(engineer, 'visit_followup', { p_visit_id: vid });
    check('the follow-up sheet has {visit, groups}', 'visit' in fu && 'groups' in fu);
    check('the visit header carries what the sheet prints',
          ['id', 'scheduled_start', 'visit_number', 'client_en', 'agent_name', 'site_name']
            .every(k => k in fu.visit), Object.keys(fu.visit).join(','));
    const types = Object.keys(fu.groups);
    check('the reading appears in the report, grouped by trap type',
          types.length > 0 &&
          Object.values(fu.groups).flat().some(r => r.code === code),
          types.join(','));
    const row = Object.values(fu.groups).flat().find(r => r.code === code);
    check('...with details as an OBJECT here (the sheet does not parse)',
          row && typeof row.details === 'object' && row.details.fly_count === 31,
          JSON.stringify(row && row.details));
  } else {
    console.log('  (no in-progress visit to file against — report checks skipped)');
  }

  // ---- a stranger's visit ----------------------------------------------
  const foreign = (await rest(admin,
    `visits?select=id&agent_id=neq.5&limit=1`))[0];
  if (foreign) {
    check('an engineer cannot open another engineer\'s follow-up sheet',
          (await refused(() => rpc(engineer, 'visit_followup', { p_visit_id: foreign.id })))
            !== null, 'visit ' + foreign.id);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
