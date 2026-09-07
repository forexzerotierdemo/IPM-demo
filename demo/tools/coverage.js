// What is actually live, route by route.
//
// routes.json is Appendix C — all 250 @route decorators from server.py with
// the target the guide assigned each one. This walks the 83 it marked "Edge
// Function" (the computed ones) and asks the deployed demo whether each is
// answered yet: an RPC the shim calls, a handler in the Edge Function, or
// still a 501.
//
// GET only, and only routes with no path parameters — a POST would change
// the demo data and a /(\d+) needs an id this script has no business
// guessing. Those are reported as "not probed" rather than counted either way.
const fs = require('fs');
const path = require('path');
const { ROOT, env, login } = require('./env');

const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'routes.json'), 'utf8'));

// Paths the SHIM answers itself (RPC or PostgREST) instead of forwarding to
// the Edge Function. Kept in step with the ROUTES table in web/js/api.js.
const SHIM = [
  [/^\/auth\/(login|logout|me)$/, 'shim: Supabase Auth'],
  [/^\/dashboard$/, 'RPC dashboard_summary'],
  [/^\/settings$/, 'shim: settings map'],
  [/^\/agents$/, 'PostgREST v_users'],
  [/^\/my-team$/, 'PostgREST v_users'],
  [/^\/permissions$/, 'PostgREST role/user_permissions'],
  [/^\/dispatch\/grid$/, 'RPC dispatch_grid'],
  [/^\/dispatch\/cell$/, 'RPC dispatch_cell'],
  [/^\/dispatch\/sla$/, 'RPC dispatch_sla'],
  [/^\/dispatch\/move$/, 'RPC dispatch_move'],
  [/^\/shifts\/week$/, 'RPC shift_week'],
  [/^\/visits\/\(\\d\+\)\/report$/, 'shim: upsert report'],
  [/^\/dispatch\/optimize$/, 'Edge Function'],
  [/^\/analytics$/, 'RPC analytics'],
  [/^\/permissions\/catalog$/, 'RPC permissions_catalog'],
  [/^\/reports\/drafts$/, 'RPC reports_drafts'],
  [/^\/devices\/generate$/, 'RPC devices_generate'],
  [/^\/devices\/assign$/, 'RPC devices_assign'],
  [/^\/clients\/\(\\d\+\)\/analytics$/, 'RPC client_analytics'],
  [/^\/clients\/\(\\d\+\)\/statement$/, 'RPC client_statement'],
  [/^\/clients\/\(\\d\+\)\/pest-trends$/, 'RPC client_pest_trends'],
  // The QR chain. The 3-letter+digits form is the printed trap label; the
  // 32-hex form is the legacy floor-plan marker token, which this demo does
  // not use (no site maps are seeded) and which stays unported.
  [/^\/scan\/\(\[A-Za-z\]\{3\}\\d\{4,\}\)$/, 'RPC scan_lookup / scan_record'],
  [/^\/devices\/\(\\d\+\)\/history$/, 'RPC device_history'],
  [/^\/visits\/\(\\d\+\)\/devices$/, 'RPC visit_devices'],
  [/^\/visits\/\(\\d\+\)\/followup$/, 'RPC visit_followup'],
  // The action buttons (37_actions.sql) and search (38_search.sql).
  [/^\/health$/, 'RPC health'],
  [/^\/audit$/, 'RPC list_audit'],
  [/^\/search$/, 'RPC search'],
  [/^\/clients\/\(\\d\+\)\/status$/, 'RPC set_client_status'],
  [/^\/sites\/\(\\d\+\)\/status$/, 'RPC set_site_status'],
  [/^\/clients\/\(\\d\+\)\/sites$/, 'RPC add_site'],
  [/^\/visits\/\(\\d\+\)\/checkin$/, 'RPC visit_checkin'],
  [/^\/visits\/\(\\d\+\)\/checkout$/, 'RPC visit_checkout'],
  [/^\/visits\/\(\\d\+\)\/rating$/, 'RPC rate_visit'],
  [/^\/visits\/\(\\d\+\)\/signature$/, 'RPC save_signature'],
  [/^\/visits\/\(\\d\+\)\/usage$/, 'RPC record_usage'],
  [/^\/usage\/\(\\d\+\)$/, 'RPC delete_usage'],
  [/^\/chemicals\/\(\\d\+\)\/stock$/, 'RPC adjust_stock'],
  [/^\/chemicals\/\(\\d\+\)\/transactions$/, 'RPC chemical_transactions'],
  [/^\/issues\/\(\\d\+\)\/(approve|decline|receive|dispute)$/, 'RPC issue actions'],
  [/^\/returns\/\(\\d\+\)\/(approve|decline|receive|dispute)$/, 'RPC handle_return'],
  [/^\/cash\/\(\\d\+\)\/(approve|decline)$/, 'RPC handle_cash'],
  [/^\/visit-requests\/\(\\d\+\)\/(approve|decline)$/, 'RPC handle_visit_request'],
  [/^\/notifications\/read$/, 'RPC mark_notifications_read'],
  // The permission matrix as a control surface (41_rbac_trial.sql).
  [/^\/permissions\/roles\/\(\\w\+\)$/, 'RPC update_role_permissions'],
  [/^\/permissions\/users\/\(\\d\+\)$/, 'RPC get/update_user_permissions'],
  [/^\/issues\/balance$/, 'RPC issues_balance'],
  [/^\/leads\/\(\\d\+\)\/convert$/, 'RPC convert_lead'],
];

// The shim's GENERIC resource table answers /<resource> and /<resource>/<id>
// for everything it lists, straight off PostgREST — so a route Appendix C
// marked "Edge Function" may already be live without any handler existing.
// Read the list out of api.js itself so this cannot drift from the shim.
const RESOURCES = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'web/js/api.js'), 'utf8');
  const block = src.slice(src.indexOf('const RESOURCES = {'), src.indexOf('\n};', src.indexOf('const RESOURCES = {')));
  return [...block.matchAll(/^\s*"([a-z0-9-]+)":/gm)].map(m => m[1]);
})();
// routes.json carries the raw decorator pattern, e.g. /leads/(\d+). Normalise
// the id group to a number before asking whether the generic table would take
// it, or every by-id write looks unported when it is in fact live.
const genericHandles = (p) => {
  const norm = p.replace(/\(\\d\+\)/g, '1');
  const m = /^\/([a-z][a-z0-9-]*)(?:\/(\d+))?$/.exec(norm);
  return m && RESOURCES.includes(m[1]);
};

(async () => {
  const token = await login('admin@demo.foxcrm.app');
  const H = { apikey: env.ANON, Authorization: 'Bearer ' + token };

  const edge = routes.filter(r => r.target === 'Edge Function');
  const live = [], dead = [], skipped = [];

  for (const r of edge) {
    const shim = SHIM.find(([re]) => re.test(r.path));
    if (shim) { live.push({ ...r, how: shim[1] }); continue; }
    if (genericHandles(r.path)) {
      live.push({ ...r, how: 'PostgREST (generic table)' }); continue;
    }
    if (r.method !== 'GET' || /\(|\\d/.test(r.path)) {
      skipped.push(r); continue;
    }
    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/api${r.path}`, { headers: H });
    if (res.status === 501) dead.push(r);
    else if (res.ok) live.push({ ...r, how: 'Edge Function' });
    else {
      const j = await res.json().catch(() => null);
      // A 4xx that is not 501 means the handler EXISTS and objected to the
      // request (a missing query param, a permission). That is ported.
      dead.push({ ...r, note: (j && j.error) || res.status, exists: true });
    }
  }

  const show = (title, list, fmt) => {
    console.log(`\n${title} (${list.length})`);
    list.forEach(r => console.log('  ' + fmt(r)));
  };

  show('LIVE — answered today', live,
       r => `${r.method.padEnd(6)} ${r.path.padEnd(34)} ${r.how}`);
  show('DEAD — still 501', dead.filter(r => !r.exists),
       r => `${r.method.padEnd(6)} ${r.path.padEnd(34)} ${r.handler}`);
  const odd = dead.filter(r => r.exists);
  if (odd.length) show('ANSWERED BUT ERRORED', odd,
       r => `${r.method.padEnd(6)} ${r.path.padEnd(34)} ${r.note}`);
  show('NOT PROBED — writes or id-in-path', skipped,
       r => `${r.method.padEnd(6)} ${r.path.padEnd(34)} ${r.handler}`);

  // ---- the blind spot -------------------------------------------------
  // Everything above walks the 83 routes Appendix C called "Edge Function".
  // A route it called "PostgREST" is assumed served — but it is only served
  // if the shim's generic table actually recognises the path. /scan/<CODE>
  // was marked PostgREST, matched nothing, fell through to the Edge Function
  // and 501'd, and this tool reported full coverage throughout. So: list the
  // PostgREST-marked routes that neither the routing table nor the generic
  // table handles. They are unported, whatever the appendix says.
  const gap = routes.filter(r => r.target === 'PostgREST')
    .filter(r => !SHIM.some(([re]) => re.test(r.path)))
    .filter(r => !genericHandles(r.path));
  show('MARKED PostgREST BUT UNHANDLED — falls through to a 501', gap,
       r => `${r.method.padEnd(6)} ${r.path.padEnd(34)} ${r.handler}`);

  console.log(`\n${live.length} of ${edge.length} computed routes live, ` +
              `${dead.filter(r => !r.exists).length} still 501, ` +
              `${skipped.length} not probed.`);
  console.log(`${gap.length} route(s) marked PostgREST that nothing answers.`);
})().catch(e => { console.error(e.message); process.exit(1); });
