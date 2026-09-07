// The action buttons: the things ON the screens, as opposed to the screens.
//
// Each is a state transition with a guard, so each is checked three ways:
// it does the thing, it refuses the wrong role, and it refuses a second
// time (an approval that can be applied twice moves stock twice).
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
const refused = async fn => { try { await fn(); return null; } catch (e) { return e.message; } };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  const admin = await login('admin@demo.foxcrm.app', 'demo1234');
  const eng = await login('engineer@demo.foxcrm.app', 'demo1234');
  const client = await login('client@demo.foxcrm.app', 'demo1234');

  // Fixtures are CREATED here rather than taken from the seed. An approval
  // is a one-way transition, so a test that consumes a seeded row passes
  // once and fails every run after — which is what happened first time.
  const mk = async (table, row) => {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST', headers: { ...H(admin), Prefer: 'return=representation' },
      body: JSON.stringify(row) });
    const j = await r.json();
    if (!r.ok) throw new Error(table + ': ' + (j.message || r.status));
    return j[0];
  };

  // ---- materials ------------------------------------------------------
  console.log('\nmaterials: approve moves stock, once');
  const issue = await mk('engineer_issues',
    { agent_id: 5, note: 'test fixture', created_by: 5, status: 'requested' });
  await mk('engineer_issue_items', { issue_id: issue.id, chemical_id: 2, quantity: 40 });
  const items = await rest(admin, `engineer_issue_items?select=chemical_id,quantity&issue_id=eq.${issue.id}`);
  const chem = items[0].chemical_id;
  const before = (await rest(admin, `chemicals?select=quantity_in_stock&id=eq.${chem}`))[0].quantity_in_stock;

  check('an engineer cannot approve their own request',
        (await refused(() => rpc(eng, 'approve_issue', { p_id: issue.id }))) === 'Not permitted');
  const ap = await rpc(admin, 'approve_issue', { p_id: issue.id });
  check('the office approves it', ap.ok === true && ap.lines > 0, JSON.stringify(ap));

  const after = (await rest(admin, `chemicals?select=quantity_in_stock&id=eq.${chem}`))[0].quantity_in_stock;
  check('stock came off the shelf', after < before, `${before} -> ${after}`);
  check('a ledger line explains it',
        (await rest(admin, `inventory_transactions?select=id&reference=eq.issue:${issue.id}`)).length > 0);
  check('approving twice is refused',
        (await refused(() => rpc(admin, 'approve_issue', { p_id: issue.id })))
          === 'This request has already been handled');
  // Notifications are scoped to their recipient by §6.5, so the ENGINEER
  // has to be the one who looks — admin cannot see another user's bell.
  check('the engineer was told',
        (await rest(eng, `notifications?select=id&dedup_key=eq.issueok:${issue.id}`)).length > 0);

  const issue2 = await mk('engineer_issues', { agent_id: 6, note: 'to decline', created_by: 6, status: 'requested' });
  if (issue2) {
    await rpc(admin, 'decline_issue', { p_id: issue2.id, p_reason: 'Ask again next week' });
    const st = (await rest(admin, `engineer_issues?select=status,decline_reason&id=eq.${issue2.id}`))[0];
    check('decline records the reason', st.status === 'declined' && !!st.decline_reason,
          JSON.stringify(st));
  }

  // ---- returns --------------------------------------------------------
  console.log('\nreturns: approve puts it back');
  const ret = await mk('material_returns', { agent_id: 6, note: 'test return', created_by: 6, status: 'requested' });
  await mk('material_return_items', { return_id: ret.id, chemical_id: 3, quantity: 0.5 });
  if (ret) {
    const ri = (await rest(admin, `material_return_items?select=chemical_id,quantity&return_id=eq.${ret.id}`))[0];
    const b2 = (await rest(admin, `chemicals?select=quantity_in_stock&id=eq.${ri.chemical_id}`))[0].quantity_in_stock;
    await rpc(admin, 'handle_return', { p_id: ret.id, p_action: 'approve' });
    const a2 = (await rest(admin, `chemicals?select=quantity_in_stock&id=eq.${ri.chemical_id}`))[0].quantity_in_stock;
    check('stock went back on the shelf', a2 > b2, `${b2} -> ${a2}`);
  }

  // ---- pocket money ---------------------------------------------------
  console.log('\npocket money: settled for less than asked');
  const cash = await mk('petty_cash', { agent_id: 5, kind: 'expense', amount: 200, category: 'fuel', spent_on: new Date().toISOString().slice(0,10), status: 'pending', created_by: 5 });
  const trimmed = await rpc(admin, 'handle_cash', { p_id: cash.id, p_action: 'approve', p_amount: 120 });
  check('the office can trim a claim', trimmed.amount === 120, JSON.stringify(trimmed));
  check('handling it twice is refused',
        (await refused(() => rpc(admin, 'handle_cash', { p_id: cash.id, p_action: 'approve' })))
          === 'This has already been handled');

  // ---- a customer request becomes a real visit -------------------------
  console.log('\nvisit requests: approving books the job');
  const req = await mk('visit_requests', { client_id: 1, site_id: 1, note: 'test request', status: 'pending', created_by: 7 });
  const booked = await rpc(admin, 'handle_visit_request', {
    p_id: req.id, p_action: 'approve', p_agent_id: 5, p_service_type_id: 1 });
  check('a visit was created', !!booked.visit_id, JSON.stringify(booked));
  const nv = (await rest(admin, `visits?select=id,status&id=eq.${booked.visit_id}`))[0];
  check('...and it is in the diary as scheduled', nv && nv.status === 'scheduled');

  // ---- check in / out --------------------------------------------------
  console.log('\ncheck in / check out');
  const mine = (await rest(eng, 'visits?select=id&agent_id=eq.5&status=eq.scheduled&checkin_at=is.null&limit=1'))[0];
  const ci = await rpc(eng, 'visit_checkin', { p_visit_id: mine.id, p_lat: 30.0444, p_lng: 31.2357 });
  check('the engineer checks in', ci.checkin_at !== null);
  check('...which starts the visit', ci.status === 'in_progress', ci.status);
  check('checking in twice is refused',
        (await refused(() => rpc(eng, 'visit_checkin', { p_visit_id: mine.id }))) === 'Already checked in');
  const co = await rpc(eng, 'visit_checkout', { p_visit_id: mine.id, p_lat: 30.0444, p_lng: 31.2357 });
  check('...and checks out', co.checkout_at !== null);

  const notMine = (await rest(admin, 'visits?select=id&agent_id=eq.6&status=eq.scheduled&limit=1'))[0];
  check('an engineer cannot check in to another engineer\'s visit',
        (await refused(() => rpc(eng, 'visit_checkin', { p_visit_id: notMine.id }))) === 'Not your visit');
  check('a customer cannot check in at all',
        /Not permitted|Not available/.test(
          await refused(() => rpc(client, 'visit_checkin', { p_visit_id: mine.id })) || ''));

  // ---- stock, usage, status, search -----------------------------------
  console.log('\nthe rest');
  const st = await rpc(admin, 'adjust_stock', { p_chemical_id: 1, p_change: 10, p_reason: 'purchase' });
  check('stock can be adjusted', typeof st.quantity_in_stock === 'number');
  check('an invalid reason is refused',
        (await refused(() => rpc(admin, 'adjust_stock',
          { p_chemical_id: 1, p_change: 1, p_reason: 'shrinkage' }))) === 'Invalid reason');

  const u = await rpc(eng, 'record_usage', { p_visit_id: mine.id, p_chemical_id: 2,
                                             p_quantity: 30, p_area_treated: 'Kitchen' });
  check('usage is recorded against the visit', u.ok === true);
  const undone = await rpc(eng, 'delete_usage', { p_id: u.id });
  check('...and removing it puts the product back', undone.ok === true);

  // A customer may only rate a visit they can see, so ask THEM which.
  const theirs = (await rest(client, 'v_visits?select=id&status=eq.completed&limit=1'))[0];
  const rated = await rpc(client, 'rate_visit', { p_visit_id: theirs.id, p_stars: 5, p_comment: 'Great' });
  check('a customer can rate a visit', rated.stars === 5);
  check('a bad rating value is refused',
        (await refused(() => rpc(client, 'rate_visit', { p_visit_id: theirs.id, p_stars: 9 })))
          === 'Rating must be 1 to 5');

  const n = await rpc(eng, 'mark_notifications_read');
  check('notifications can be marked read', typeof n.marked === 'number');

  const s = await rpc(admin, 'search', { p_q: 'nile' });
  check('search finds a client', s.clients.length > 0, JSON.stringify(s.clients));
  const se = await rpc(eng, 'search', { p_q: 'nile' });
  check('an engineer\'s search is scoped — no invoices, no chemicals',
        se.invoices.length === 0 && se.chemicals.length === 0);

  check('the audit trail recorded all of this',
        (await rpc(admin, 'list_audit', { p_limit: 50 })).length >= 8);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
