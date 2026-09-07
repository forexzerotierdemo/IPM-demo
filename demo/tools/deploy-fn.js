// Deploy supabase/functions/api to the project — no Supabase CLI needed.
//   node tools/deploy-fn.js
const fs = require('fs');
const path = require('path');
const { ROOT, env } = require('./env');

const code = fs.readFileSync(path.join(ROOT, 'supabase/functions/api/index.ts'), 'utf8');

// verify_jwt is false because the function checks the caller itself, with
// db.auth.getUser(), and needs to see the request even when the header is
// missing so it can answer a clean 401 in the app's own error shape.
const meta = { name: 'api', entrypoint_path: 'index.ts', verify_jwt: false };

const fd = new FormData();
fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
fd.append('file', new Blob([code], { type: 'text/typescript' }), 'index.ts');

fetch(`https://api.supabase.com/v1/projects/${env.REF}/functions/deploy?slug=api`, {
  method: 'POST', headers: { Authorization: 'Bearer ' + env.SBP }, body: fd,
}).then(async r => {
  const t = await r.text();
  if (!r.ok) { console.error(r.status, t.slice(0, 600)); process.exit(1); }
  const j = JSON.parse(t);
  console.log(`deployed api v${j.version} (${j.status})`);
}).catch(e => { console.error(e.message); process.exit(1); });
