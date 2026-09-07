// Run SQL against the demo project.
//   node tools/sql.js migrations/02_schema.sql
//   node tools/sql.js "select count(*) from visits"
//   node tools/sql.js -            (reads stdin)
const fs = require('fs');
const { runSql } = require('./env');

const arg = process.argv[2];
if (!arg) { console.error('usage: node tools/sql.js <file|sql|->'); process.exit(1); }

const query = arg === '-' ? fs.readFileSync(0, 'utf8')
            : fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8')
            : arg;

runSql(query)
  .then(out => console.log(typeof out === 'string' ? out.slice(0, 4000)
                                                   : JSON.stringify(out, null, 1).slice(0, 8000)))
  .catch(e => { console.error(e.message); process.exit(1); });
