import { query } from './dist/db/connection.js';

async function fix() {
  console.log('Adding missing delegation_logs columns...');

  await query(`
    ALTER TABLE delegation_logs
    ADD COLUMN IF NOT EXISTS did_rerank BOOLEAN NOT NULL DEFAULT false
  `).catch(e => console.log('did_rerank:', e.message));

  await query(`
    ALTER TABLE delegation_logs
    ADD COLUMN IF NOT EXISTS rerank_reason TEXT
  `).catch(e => console.log('rerank_reason:', e.message));

  await query(`
    ALTER TABLE delegation_logs
    ADD COLUMN IF NOT EXISTS execution_correct BOOLEAN
  `).catch(e => console.log('execution_correct:', e.message));

  // Also fix: ensure delegation_logs has delegation_log_id so G4 back-write works
  // Check if id column can be used as the back-write target
  const cols = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'delegation_logs' AND column_name IN ('id', 'execution_status', 'execution_result')
  `);
  console.log('delegation_logs key columns:', cols.rows.map(x => x.column_name).join(', '));

  console.log('Done.');
}

fix().catch(e => { console.error(e); process.exit(1); });
