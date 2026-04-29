import { query } from './dist/db/connection.js';

async function fix() {
  await query('ALTER TABLE delegation_logs ADD COLUMN IF NOT EXISTS rerank_gap REAL');
  await query("ALTER TABLE delegation_logs ADD COLUMN IF NOT EXISTS rerank_rules JSONB NOT NULL DEFAULT '[]'");
  await query('ALTER TABLE delegation_logs ADD COLUMN IF NOT EXISTS execution_correct BOOLEAN');
  await query('ALTER TABLE delegation_logs ADD COLUMN IF NOT EXISTS error_message TEXT');
  await query('ALTER TABLE delegation_logs ADD COLUMN IF NOT EXISTS model_used VARCHAR(100)');
  await query('ALTER TABLE delegation_logs ADD COLUMN IF NOT EXISTS latency_ms INTEGER');
  await query('ALTER TABLE delegation_logs ADD COLUMN IF NOT EXISTS cost_usd REAL');
  await query('ALTER TABLE delegation_logs ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ');

  const r = await query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='delegation_logs' ORDER BY ordinal_position"
  );
  console.log('delegation_logs columns:', r.rows.map(x => x.column_name).join(', '));
}

fix().catch(e => { console.error(e.message); process.exit(1); });
