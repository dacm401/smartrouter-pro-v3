import { query } from './dist/db/connection.js';

async function fix() {
  console.log('Step 1: Drop errant FKs pointing to tasks(id)');
  await query('ALTER TABLE task_commands DROP CONSTRAINT IF EXISTS task_commands_task_id_fkey');
  await query('ALTER TABLE task_worker_results DROP CONSTRAINT IF EXISTS task_worker_results_task_id_fkey');
  await query('ALTER TABLE task_summaries DROP CONSTRAINT IF EXISTS task_summaries_task_id_fkey');
  await query('ALTER TABLE task_traces DROP CONSTRAINT IF EXISTS task_traces_task_id_fkey');
  await query('ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_task_id_fkey');

  console.log('Step 2: Create delegation_logs (Migration 012)');
  await query(`
    CREATE TABLE IF NOT EXISTS delegation_logs (
      id                   VARCHAR(36) PRIMARY KEY,
      user_id              VARCHAR(64) NOT NULL,
      session_id           VARCHAR(64) NOT NULL,
      turn_id              INTEGER     NOT NULL DEFAULT 0,
      task_id              VARCHAR(64),
      routing_version      VARCHAR(20) NOT NULL DEFAULT 'v2',
      llm_scores           JSONB       NOT NULL,
      llm_confidence       REAL        NOT NULL,
      system_confidence    REAL        NOT NULL,
      calibrated_scores    JSONB       NOT NULL,
      policy_overrides     JSONB       NOT NULL DEFAULT '[]',
      g2_final_action      VARCHAR(30),
      features             JSONB       NOT NULL DEFAULT '{}',
      execution_status     VARCHAR(20),
      execution_result     TEXT,
      execution_time_ms    INTEGER,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log('Step 3: Create task_archive_events (Migration 011)');
  await query(`
    CREATE TABLE IF NOT EXISTS task_archive_events (
      id          VARCHAR(36) PRIMARY KEY,
      archive_id  VARCHAR(36),
      task_id     VARCHAR(36),
      event_type  VARCHAR(50) NOT NULL,
      payload     JSONB      NOT NULL DEFAULT '{}',
      actor       VARCHAR(50),
      user_id     VARCHAR(64),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_dl_session ON delegation_logs(session_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dl_task ON delegation_logs(task_id) WHERE task_id IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tae_archive ON task_archive_events(archive_id, created_at ASC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tae_task ON task_archive_events(task_id) WHERE task_id IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tae_event ON task_archive_events(event_type, created_at DESC)`);

  console.log('Done.');
  const r = await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'task%'");
  console.log('Tables now:', r.rows.map(x => x.table_name).join(', '));
  const c = await query("SELECT conname, confrelid::regclass as ref FROM pg_constraint WHERE contype='f' AND conname LIKE '%task%'");
  console.log('FKs now:', c.rows.map(x => `${x.conname}->${x.ref}`).join(', '));
}

fix().catch(e => { console.error(e); process.exit(1); });
