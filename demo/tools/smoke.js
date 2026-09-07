// End-to-end smoke test: logs in through GoTrue as each demo account and
// exercises the paths app.js actually calls, through the same PostgREST /
// RPC / Edge surface the shim uses. This is the §12 "run the existing suite
// against the demo" idea, cut down to what one file can cover.
const { env, login } = require('./env');

const PROBES = [
  ['GET  /dashboard',       t => rpc(t, 'dashboard_summary')],
  ['GET  /auth/me',         t => rest(t, 'v_users?select=*&limit=1')],
  ['GET  /settings',        t => rest(t, 'settings?select=*')],
  ['GET  /service-types',   t => rest(t, 'service_types?select=*&order=name_en')],
  ['GET  /report-options',  t => rest(t, 'report_options?select=*&order=kind,sort_order')],
  ['GET  /clients',         t => rest(t, 'v_clients?select=*&order=name_en')],
  ['GET  /sites',           t => rest(t, 'v_sites?select=*&order=client_en,name')],
  ['GET  /visits?from..to', t => rest(t, 'v_visits?select=*&scheduled_start=gte.2000-01-01&order=scheduled_start')],
  ['GET  /visits/:id',      t => rest(t, 'v_visits?select=*&limit=1')],
  ['GET  /reports',         t => rest(t, 'v_reports?select=*&order=scheduled_start')],
  ['GET  /devices',         t => rest(t, 'v_devices?select=*&order=type,code')],
  ['GET  /agents',          t => rest(t, 'v_users?select=*&role=in.(agent,area_manager,team_leader)&active=eq.1')],
  ['GET  /chemicals',       t => rest(t, 'chemicals?select=*&order=name_en')],
  ['GET  /invoices',        t => rest(t, 'invoices?select=*&order=issue_date')],
  ['GET  /contracts',       t => rest(t, 'contracts?select=*')],
  ['GET  /areas',           t => rest(t, 'areas?select=*&order=sort_order')],
  ['GET  /notifications',   t => rest(t, 'notifications?select=*')],
  ['RPC  my_permissions',   t => rpc(t, 'my_permissions')],
  ['EDGE /dispatch/grid',   t => edge(t, '/dispatch/grid')],
  ['EDGE /engineers/scorecard', t => edge(t, '/engineers/scorecard')],
  ['EDGE /unported/thing',  t => edge(t, '/some/unported/route')],
];

const H = t => ({ apikey: env.ANON, Authorization: 'Bearer ' + t });

async function rest(t, q) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${q}`, { headers: H(t) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || j.hint || r.status);
  return Array.isArray(j) ? `${j.length} rows` : 'ok';
}
async function rpc(t, name) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { ...H(t), 'Content-Type': 'application/json' }, body: '{}' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || r.status);
  return Object.keys(j || {}).length + ' keys';
}
async function edge(t, path) {
  const r = await fetch(`${env.SUPABASE_URL}/functions/v1/api${path}`, { headers: H(t) });
  const j = await r.json().catch(() => null);
  if (r.status === 501) return 'not ported (501, handled)';
  if (!r.ok) throw new Error((j && j.error) || r.status);
  return Object.keys(j || {}).join(',').slice(0, 40);
}

(async () => {
  const accounts = process.argv[2] ? [process.argv[2]]
    : ['admin', 'manager', 'area', 'leader', 'engineer', 'client'];
  let fails = 0;
  for (const a of accounts) {
    console.log(`\n=== ${a}@demo.foxcrm.app ===`);
    let token;
    try { token = await login(`${a}@demo.foxcrm.app`); }
    catch (e) { console.log('  LOGIN FAILED:', e.message); fails++; continue; }
    for (const [label, fn] of PROBES) {
      try { console.log(`  ok   ${label.padEnd(28)} ${await fn(token)}`); }
      catch (e) { console.log(`  FAIL ${label.padEnd(28)} ${e.message}`); fails++; }
    }
  }
  console.log(fails ? `\n${fails} failure(s)` : '\nall probes passed');
  process.exit(fails ? 1 : 0);
})();
