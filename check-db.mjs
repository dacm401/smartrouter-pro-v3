import { query } from './dist/db/connection.js';
const r = await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'task%'");
console.log('Tables:', r.rows.map(x => x.table_name).join(', '));
const c = await query("SELECT conname, confrelid::regclass as ref FROM pg_constraint WHERE contype='f' AND conname LIKE '%task%'");
console.log('FKs:', c.rows.map(x => `${x.conname} -> ${x.ref}`).join(', '));
