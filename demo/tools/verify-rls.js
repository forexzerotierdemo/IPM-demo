// §6.6 — prove the policies before showing anyone. Logs in through GoTrue as
// each demo account and counts what PostgREST will actually hand that JWT.
const { env, login } = require('./env');

const ACCOUNTS = ['admin', 'manager', 'area', 'leader', 'engineer', 'client'];
const TABLES = ['v_clients', 'v_sites', 'v_visits', 'v_reports', 'v_users',
                'v_devices', 'invoices', 'chemicals', 'audit_log'];

async function count(token, table) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id`, {
    headers: { apikey: env.ANON, Authorization: 'Bearer ' + token,
               Prefer: 'count=exact', Range: '0-0' },
  });
  if (!r.ok) return 'ERR' + r.status;
  const cr = r.headers.get('content-range') || '';
  return cr.split('/')[1] ?? '?';
}

(async () => {
  const head = ['account'.padEnd(10), ...TABLES.map(t => t.padStart(11))].join('');
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const a of ACCOUNTS) {
    const token = await login(`${a}@demo.foxcrm.app`);
    const perms = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/my_permissions`, {
      method: 'POST',
      headers: { apikey: env.ANON, Authorization: 'Bearer ' + token,
                 'Content-Type': 'application/json' },
      body: '{}',
    }).then(r => r.json());
    const granted = Object.values(perms || {}).filter(Boolean).length;
    const row = [];
    for (const t of TABLES) row.push(String(await count(token, t)).padStart(11));
    console.log(a.padEnd(10) + row.join('') + `   (${granted} perms)`);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
