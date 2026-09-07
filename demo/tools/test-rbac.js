// The permission matrix, as a control surface rather than a picture.
//
// The question this answers is the one that matters: does ticking a box on
// the Permissions screen actually change what that person can DO? A matrix
// that saves without taking effect is worse than no matrix, because it
// tells the owner they have made a decision they have not made.
const { env, login } = require('./env');

const H = t => ({ apikey: env.ANON, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
const rpc = async (t, fn, a = {}) => {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: H(t), body: JSON.stringify(a) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || j.hint || `HTTP ${r.status}`);
  return j;
};
const rest = async (t, q, init) =>
  fetch(`${env.SUPABASE_URL}/rest/v1/${q}`, { headers: H(t), ...init });
const refused = async fn => { try { await fn(); return null; } catch (e) { return e.message; } };

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  const admin = await login('admin@demo.foxcrm.app', 'demo1234');
  const trialUser = () => login('trial@demo.foxcrm.app', 'trial1234');

  console.log('\nthe matrix lists trial');
  const cat = await rpc(admin, 'permissions_catalog');
  check('trial is one of the roles', cat.roles.includes('trial'), cat.roles.join(','));
  check('roles read down the org chart, visitor last',
        cat.roles[0] === 'admin' && cat.roles[cat.roles.length - 1] === 'trial');
  check('its matrix is populated',
        Object.keys(cat.roles_effective.trial || {}).length === 75);
  check('admin refuses to be edited',
        (await refused(() => rpc(admin, 'update_role_permissions',
          { p_role: 'admin', p_perms: { 'clients.view': false } })))
          === 'The admin role always has full access and cannot be edited');

  // ---- ticking a box changes what a trial user can do -----------------
  console.log('\nticking a box takes effect');
  const before = await rpc(await trialUser(), 'my_permissions');
  check('a trial user cannot delete a client to begin with',
        before['clients.delete'] === false);

  // GRANT it, exactly as the screen does.
  await rpc(admin, 'update_role_permissions',
            { p_role: 'trial', p_perms: { 'clients.delete': true } });
  const t1 = await trialUser();
  const after = await rpc(t1, 'my_permissions');
  check('...the UI now offers it', after['clients.delete'] === true);

  const made = await (await rest(admin, 'clients', {
    method: 'POST', headers: { ...H(admin), Prefer: 'return=representation' },
    body: JSON.stringify({ name_en: 'RBAC Probe Co', status: 'active' }) })).json();
  const probeId = made[0].id;
  const del1 = await rest(t1, `clients?id=eq.${probeId}`, {
    method: 'DELETE', headers: { ...H(t1), Prefer: 'return=minimal' } });
  const gone = (await (await rest(admin, `clients?select=id&id=eq.${probeId}`)).json()).length === 0;
  check('...and the DATABASE lets it through, not just the menu', gone,
        `HTTP ${del1.status}`);

  // WITHDRAW it again.
  await rpc(admin, 'update_role_permissions',
            { p_role: 'trial', p_perms: { 'clients.delete': false } });
  const t2 = await trialUser();
  check('withdrawing it puts the answer back',
        (await rpc(t2, 'my_permissions'))['clients.delete'] === false);

  const made2 = await (await rest(admin, 'clients', {
    method: 'POST', headers: { ...H(admin), Prefer: 'return=representation' },
    body: JSON.stringify({ name_en: 'RBAC Probe Two', status: 'active' }) })).json();
  await rest(t2, `clients?id=eq.${made2[0].id}`, {
    method: 'DELETE', headers: { ...H(t2), Prefer: 'return=minimal' } });
  const stillThere = (await (await rest(admin, `clients?select=id&id=eq.${made2[0].id}`)).json()).length === 1;
  check('...and the row survives the attempt', stillThere);
  await rest(admin, `clients?id=eq.${made2[0].id}`, {
    method: 'DELETE', headers: { ...H(admin), Prefer: 'return=minimal' } });

  // ---- one person, not a whole role -----------------------------------
  console.log('\nper-user overrides');
  const eng = (await (await rest(admin, 'users?select=id,role&email=eq.engineer@demo.foxcrm.app')).json())[0];
  const got = await rpc(admin, 'get_user_permissions', { p_user_id: eng.id });
  check('it separates inherited from given',
        'role_effective' in got && 'overrides' in got && 'effective' in got);
  check('with nothing set, effective matches the role',
        got.effective['invoices.view'] === got.role_effective['invoices.view']);

  await rpc(admin, 'update_user_permissions',
            { p_user_id: eng.id, p_perms: { 'invoices.view': true } });
  const g2 = await rpc(admin, 'get_user_permissions', { p_user_id: eng.id });
  check('a per-user grant beats the role', g2.effective['invoices.view'] === true &&
        g2.role_effective['invoices.view'] === false);
  const engTok = await login('engineer@demo.foxcrm.app', 'demo1234');
  check('...and the engineer really can see invoices now',
        (await (await rest(engTok, 'invoices?select=id&limit=1')).json()).length > 0);

  // null clears it — "not set" is a different answer from "denied"
  await rpc(admin, 'update_user_permissions',
            { p_user_id: eng.id, p_perms: { 'invoices.view': null } });
  const g3 = await rpc(admin, 'get_user_permissions', { p_user_id: eng.id });
  check('null clears the override rather than denying',
        !('invoices.view' in g3.overrides) && g3.effective['invoices.view'] === false);
  const engTok2 = await login('engineer@demo.foxcrm.app', 'demo1234');
  check('...and the invoices are hidden again',
        (await (await rest(engTok2, 'invoices?select=id&limit=1')).json()).length === 0);

  check('an admin user cannot be per-user edited',
        /Admin users always have full access/.test(
          await refused(() => rpc(admin, 'update_user_permissions',
            { p_user_id: 1, p_perms: { 'clients.view': false } })) || ''));

  // ---- and nobody else may touch any of it ----------------------------
  console.log('\nwho may change it');
  const t3 = await trialUser();
  check('a trial user cannot edit the matrix',
        (await refused(() => rpc(t3, 'update_role_permissions',
          { p_role: 'trial', p_perms: { 'users.delete': true } }))) === 'Not permitted');
  const mgr = await login('manager@demo.foxcrm.app', 'demo1234');
  check('a manager cannot either',
        (await refused(() => rpc(mgr, 'update_role_permissions',
          { p_role: 'agent', p_perms: { 'invoices.view': true } }))) === 'Not permitted');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
