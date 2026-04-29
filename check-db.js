const { query } = require('./dist/db/connection.js');
(async () => {
  const r = await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'task%'");
  console.log(r.rows.map(x => x.table_name).join('\n'));
  const c = await query("SELECT conname, conrelid::regclass, confrelid::regclass FROM pg_constraint WHERE conname LIKE '%task%' AND contype='f'");
  console.log('\nFK constraints:');
  c.rows.forEach(row => console.log(row.conname, '->', row.confrelid));
})();
