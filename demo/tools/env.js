// Shared config for every script in this folder: where the demo root is, and
// the credentials, read from demo/.env (see .env.example). Nothing here is
// committed — .env is gitignored, and the service-role key must never leave it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

if (!fs.existsSync(ENV_PATH)) {
  console.error(`No ${ENV_PATH}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)
    .filter(l => l.trim() && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

for (const k of ['SBP', 'REF', 'SUPABASE_URL', 'ANON']) {
  if (!env[k]) { console.error(`.env is missing ${k}`); process.exit(1); }
}

// Run one SQL statement or file against the project, through the Management
// API — no psql and no Supabase CLI needed.
async function runSql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${env.REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.SBP, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 2000)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// Sign in as a demo account and return its access token.
async function login(email, password = 'demo1234') {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${email}: ${j.error_description || j.msg || r.status}`);
  return j.access_token;
}

module.exports = { ROOT, env, runSql, login };
