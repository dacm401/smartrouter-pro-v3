const pg = require('pg');
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/smartrouter',
});

async function main() {
  try {
    // Check what's in the queued commands
    const cmd = await pool.query(
      `SELECT id, command_type, status, issued_at, payload_json::text as payload
       FROM task_commands
       WHERE status IN ('queued', 'running')
       ORDER BY issued_at DESC
       LIMIT 3`
    );
    console.log('=== Queued/Running commands ===');
    cmd.rows.forEach(r => {
      console.log(`id=${r.id.slice(0,8)}...`);
      console.log(`  type=${r.command_type} status=${r.status}`);
      console.log(`  payload=${r.payload.slice(0,200)}...`);
    });

    // Also check what task_archives.state is for the pending ones
    const archives = await pool.query(
      `SELECT ta.id, ta.state, ta.status, ta.user_input
       FROM task_archives ta
       JOIN task_commands tc ON tc.archive_id = ta.id
       WHERE tc.status = 'queued'
       LIMIT 5`
    );
    console.log('\n=== Archives for queued commands ===');
    archives.rows.forEach(r => {
      console.log(`id=${r.id.slice(0,8)}... state=${r.state} status=${r.status}`);
      console.log(`  user_input=${r.user_input.slice(0,100)}`);
    });
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
