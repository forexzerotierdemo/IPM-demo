// Deploys web/ to Vercel as a static site, straight through the REST API:
// upload every file by its sha1, then create a production deployment that
// references them. No build step — the front end is the live tree with one
// file replaced, exactly as §7 intends.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT: DEMO, env } = require('./env');

const ROOT = path.join(DEMO, 'web');
const TEAM = env.VERCEL_TEAM_ID;
const PROJECT = env.VERCEL_PROJECT || 'ipm-crm-demo';

if (!env.VERCEL_TOKEN || !TEAM) {
  console.error('.env needs VERCEL_TOKEN and VERCEL_TEAM_ID');
  process.exit(1);
}
const auth = { Authorization: 'Bearer ' + env.VERCEL_TOKEN };

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

(async () => {
  const rels = walk(ROOT);
  console.log(rels.length, 'files');

  const files = [];
  for (const rel of rels) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const sha = crypto.createHash('sha1').update(buf).digest('hex');
    const r = await fetch(`https://api.vercel.com/v2/files?teamId=${TEAM}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/octet-stream',
                 'x-vercel-digest': sha, 'Content-Length': String(buf.length) },
      body: buf,
    });
    if (!r.ok) { console.error('upload failed', rel, r.status, (await r.text()).slice(0, 200)); process.exit(1); }
    files.push({ file: rel, sha, size: buf.length });
  }
  console.log('uploaded');

  const body = {
    name: PROJECT,
    files,
    target: 'production',
    projectSettings: { framework: null, buildCommand: null, installCommand: null,
                       outputDirectory: null, devCommand: null },
  };
  const r = await fetch(`https://api.vercel.com/v13/deployments?teamId=${TEAM}&skipAutoDetectionConfirmation=1`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) { console.error('deploy failed', r.status, JSON.stringify(j).slice(0, 800)); process.exit(1); }
  console.log('deployment:', j.url);
  console.log('id:', j.id, 'state:', j.readyState);

  // Poll until it is actually serving.
  for (let i = 0; i < 60; i++) {
    await new Promise(s => setTimeout(s, 3000));
    const s = await fetch(`https://api.vercel.com/v13/deployments/${j.id}?teamId=${TEAM}`, { headers: auth })
      .then(x => x.json());
    if (['READY', 'ERROR', 'CANCELED'].includes(s.readyState)) {
      console.log('final:', s.readyState);
      console.log('url: https://' + s.url);
      if (s.alias && s.alias.length) console.log('alias:', s.alias.map(a => 'https://' + a).join(' '));
      process.exit(s.readyState === 'READY' ? 0 : 1);
    }
  }
  console.log('still building; check the dashboard');
})();
