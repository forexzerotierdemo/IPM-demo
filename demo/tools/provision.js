// Give ONE prospect a demo of their own.
//
//   node tools/provision.js "Acme Foods"
//
// The shared sandbox (see README, "Several prospects at once") is one
// dataset: concurrent testers see each other's work. That is fine for a
// link sent to one prospect at a time and wrong for anything else. The
// honest fix is not a schema trick — it is a separate database. This
// creates one, applies every migration, mints the logins, takes the
// snapshot, and prints the config to drop into a deployment.
//
// WHAT IT COSTS. A Supabase project per prospect. Free-tier organisations
// are limited (commonly two active projects), so past that this bills.
// The script tells you what it is about to create and waits for you to
// type yes.
//
// WHAT IT DOES NOT DO. It does not deploy a second front end. One Vercel
// deployment serves whichever project its js/config.js points at, so the
// simplest use is: provision, then run tools/deploy-web.js against a
// second Vercel project with the printed values in .env. Two commands,
// not one, because pointing a live demo at a different database is not
// something a script should do behind your back.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { ROOT, env } = require('./env');

const api = (p, init = {}) =>
  fetch('https://api.supabase.com/v1' + p, {
    ...init,
    headers: { Authorization: 'Bearer ' + env.SBP,
               'Content-Type': 'application/json', ...(init.headers || {}) },
  });

const ask = q => new Promise(res => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, a => { rl.close(); res(a.trim()); });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A password nobody has to remember but which is not guessable either.
const strongPassword = () =>
  'Db' + Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64')
    .replace(/[^A-Za-z0-9]/g, '') + '9x';

(async () => {
  const label = process.argv.slice(2).join(' ').trim();
  if (!label) {
    console.error('usage: node tools/provision.js "Prospect name"');
    process.exit(1);
  }
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const name = `foxcrm-demo-${slug}`.slice(0, 50);

  // ---- what exists already --------------------------------------------
  const orgs = await api('/organizations').then(r => r.json());
  const org = orgs[0];
  const projects = await api('/projects').then(r => r.json());
  console.log(`organisation : ${org.name} (${org.id})`);
  console.log(`existing     : ${projects.length} project(s) — ` +
              projects.map(p => p.name).join(', '));
  if (projects.some(p => p.name === name)) {
    console.error(`\nA project called "${name}" already exists. Nothing done.`);
    process.exit(1);
  }

  console.log(`\nAbout to create a NEW Supabase project "${name}" in ${org.name}.`);
  console.log('Free-tier organisations are limited to a small number of active');
  console.log('projects; past that this will bill to the account.');
  if ((await ask('Type yes to continue: ')).toLowerCase() !== 'yes') {
    console.log('Nothing done.');
    process.exit(0);
  }

  // ---- create ----------------------------------------------------------
  const dbPass = strongPassword();
  const created = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      name, organization_id: org.id, region: 'eu-west-1',
      db_pass: dbPass, plan: 'free',
    }),
  });
  const proj = await created.json();
  if (!created.ok) {
    console.error('create failed:', JSON.stringify(proj).slice(0, 400));
    process.exit(1);
  }
  console.log(`\ncreated ${proj.id} — waiting for it to come up...`);

  // Provisioning takes a couple of minutes; poll rather than guess.
  let ref = proj.id, status = proj.status;
  for (let i = 0; i < 60 && status !== 'ACTIVE_HEALTHY'; i++) {
    await sleep(10000);
    const s = await api(`/projects/${ref}`).then(r => r.json());
    status = s.status;
    process.stdout.write(`  ${status}\r`);
  }
  if (status !== 'ACTIVE_HEALTHY') {
    console.error(`\nProject is ${status}, not healthy. Finish it by hand.`);
    process.exit(1);
  }
  console.log('\n  ACTIVE_HEALTHY');

  // ---- keys -------------------------------------------------------------
  const keys = await api(`/projects/${ref}/api-keys?reveal=true`).then(r => r.json());
  const anon = keys.find(k => k.name === 'anon')?.api_key;
  const service = keys.find(k => k.name === 'service_role')?.api_key;
  const url = `https://${ref}.supabase.co`;

  const runSql = async (query) => {
    const r = await api(`/projects/${ref}/database/query`, {
      method: 'POST', body: JSON.stringify({ query }) });
    const t = await r.text();
    if (!r.ok) throw new Error(t.slice(0, 600));
    return t;
  };

  // ---- the whole database, in order ------------------------------------
  const dir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  console.log(`\napplying ${files.length} migrations`);
  for (const f of files) {
    // 13_seed_users links profiles to auth accounts, so the accounts have
    // to exist first — same ordering note as the README's build steps.
    if (f.startsWith('13_')) await makeAccounts();
    process.stdout.write(`  ${f} ... `);
    try { await runSql(fs.readFileSync(path.join(dir, f), 'utf8')); console.log('ok'); }
    catch (e) { console.log('FAILED'); console.error(e.message); process.exit(1); }
  }

  async function makeAccounts() {
    console.log('  creating the demo logins');
    const accounts = [
      ['admin', 'demo1234'], ['manager', 'demo1234'], ['area', 'demo1234'],
      ['leader', 'demo1234'], ['engineer', 'demo1234'], ['engineer2', 'demo1234'],
      ['client', 'demo1234'], ['trial', 'trial1234'], ['trial2', 'trial1234'],
      ['trial3', 'trial1234'], ['trial4', 'trial1234'],
    ];
    for (const [who, pw] of accounts) {
      const r = await fetch(`${url}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { apikey: service, Authorization: 'Bearer ' + service,
                   'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${who}@demo.foxcrm.app`, password: pw,
                               email_confirm: true }),
      });
      if (!r.ok && r.status !== 422) {
        console.error(`  ${who}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      }
    }
  }

  // 13_ runs the profile link; re-run it in case accounts were made after.
  await runSql(fs.readFileSync(path.join(dir, '13_seed_users.sql'), 'utf8'));

  // ---- the baseline every trial restores to -----------------------------
  console.log('\ntaking the snapshot');
  await runSql('SELECT demo_snapshot_take();');

  // ---- project-level settings -------------------------------------------
  await api(`/projects/${ref}/postgrest`, {
    method: 'PATCH', body: JSON.stringify({ max_rows: 1000 }) });
  await api(`/projects/${ref}/config/auth`, {
    method: 'PATCH', body: JSON.stringify({ disable_signup: true,
                                            external_anonymous_users_enabled: false }) });

  console.log(`
─────────────────────────────────────────────────────────────
  ${label} now has a demo of their own.

  Put these in a .env for the deployment that serves them,
  then run:  node tools/tools-columns.js && node tools/deploy-web.js

REF=${ref}
SUPABASE_URL=${url}
ANON=${anon}
SERVICE=${service}
SBP=<your management token>
VERCEL_TOKEN=<...>
VERCEL_TEAM_ID=<...>
VERCEL_PROJECT=foxcrm-demo-${slug}

  Database password (store it, it is not shown again):
  ${dbPass}

  Logins are the same as the shared demo. Nothing they do here
  can be seen by any other prospect.
─────────────────────────────────────────────────────────────`);
})().catch(e => { console.error(e.message); process.exit(1); });
