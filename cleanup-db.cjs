const pg = require('pg');
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/smartrouter',
});

async function main() {
  try {
    // 清理 orphan queued commands (没有对应 archive 的命令)
    const orphaned = await pool.query(
      `DELETE FROM task_commands
       WHERE status = 'queued'
         AND command_type NOT LIKE 'execute%'
       RETURNING id`
    );
    console.log(`Deleted ${orphaned.rowCount} orphaned queued commands`);

    // 清理 pending clarifying archives (旧会话残留)
    const archives = await pool.query(
      `DELETE FROM task_archives
       WHERE state IN ('clarifying', 'chattering')
         AND status = 'pending'
         AND delivered = false
       RETURNING id`
    );
    console.log(`Deleted ${archives.rowCount} orphaned pending archives`);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
