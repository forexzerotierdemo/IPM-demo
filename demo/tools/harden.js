// Project-level settings that cannot be set from SQL, applied through the
// Management API. Re-runnable; prints what it changed.
//
//   * PostgREST max-rows — the cap on a single read. Without it a signed-in
//     prospect can pull an entire table in one request with ?limit=100000.
//     A cap does not make exfiltration impossible (they can paginate), but
//     it turns one request into hundreds, which is slow, obvious in the
//     logs, and rate-limitable.
//   * Auth — confirm self-signup is off, so the anon key cannot be used to
//     mint accounts on the project.
const { env } = require('./env');

const MAX_ROWS = 1000;
const api = (path, init = {}) =>
  fetch(`https://api.supabase.com/v1/projects/${env.REF}${path}`, {
    ...init,
    headers: { Authorization: 'Bearer ' + env.SBP,
               'Content-Type': 'application/json', ...(init.headers || {}) },
  });

(async () => {
  // ---- PostgREST row cap ---------------------------------------------
  const before = await api('/postgrest').then(r => r.json());
  console.log('postgrest max_rows was:', before.max_rows);
  if (String(before.max_rows) !== String(MAX_ROWS)) {
    const r = await api('/postgrest', {
      method: 'PATCH',
      body: JSON.stringify({ max_rows: MAX_ROWS }),
    });
    const j = await r.json();
    if (!r.ok) { console.error('  FAILED:', JSON.stringify(j).slice(0, 300)); process.exit(1); }
    console.log('postgrest max_rows now:', j.max_rows);
  } else {
    console.log('postgrest max_rows already', MAX_ROWS);
  }

  // ---- auth settings ---------------------------------------------------
  const auth = await api('/config/auth').then(r => r.json());
  const flags = {
    disable_signup: auth.disable_signup,
    external_email_enabled: auth.external_email_enabled,
    external_anonymous_users_enabled: auth.external_anonymous_users_enabled,
    jwt_exp: auth.jwt_exp,
    security_refresh_token_reuse_interval: auth.security_refresh_token_reuse_interval,
  };
  console.log('auth:', JSON.stringify(flags));

  const want = {};
  // Nobody signs up for this project. The seven demo logins are minted with
  // the service key and that is the only way in.
  if (auth.disable_signup !== true) want.disable_signup = true;
  // Anonymous sign-in would hand a JWT to anyone holding the public anon key.
  if (auth.external_anonymous_users_enabled !== false) want.external_anonymous_users_enabled = false;

  if (Object.keys(want).length) {
    const r = await api('/config/auth', { method: 'PATCH', body: JSON.stringify(want) });
    const j = await r.json();
    if (!r.ok) { console.error('  auth PATCH FAILED:', JSON.stringify(j).slice(0, 300)); process.exit(1); }
    console.log('auth tightened:', JSON.stringify(want));
  } else {
    console.log('auth already tight');
  }
})().catch(e => { console.error(e.message); process.exit(1); });
