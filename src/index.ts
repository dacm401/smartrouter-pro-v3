import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { query } from "./db/connection.js";
import { identityMiddleware } from "./middleware/identity.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { chatRouter } from "./api/chat.js";
import { dashboardRouter } from "./api/dashboard.js";
import { taskRouter } from "./api/tasks.js";
import { memoryRouter } from "./api/memory.js";
import { evidenceRouter } from "./api/evidence.js";
import { healthRouter } from "./api/health.js";
import { archiveRouter } from "./api/archive.js";
// Sprint 48: Auth v1 — JWT token endpoint (public, no identity middleware)
import { authRouter } from "./api/auth.js";
// Sprint 62: Prompt Templates API
import { default as promptTemplatesRouter } from "./api/prompt-templates.js";
// Sprint 63: Sessions Summary API
import { sessionsRouter } from "./api/sessions.js";
// Sprint 64: Permission-Gated Worker Architecture
import { createPermissionsRouter, createWorkspacesRouter } from "./api/permissions.js";
// Phase 3.0: 启动后台 Worker 轮询循环
import { startSlowWorker } from "./services/phase3/slow-worker-loop.js";
import { startExecuteWorker } from "./services/phase3/execute-worker-loop.js";

const app = new Hono();

app.use("/*", cors());
// Sprint 71 debug: log OPTIONS preflight
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    console.log("[CORS] OPTIONS preflight for", c.req.path);
    return new Response(null, { status: 204 });
  }
  return next();
});
// P2-2: Rate limiting — runs before identity so even unauthenticated callers are throttled
app.use("/api/*", rateLimitMiddleware);
app.use("/v1/*", rateLimitMiddleware);
// C3a: mount identity middleware on all API routes
app.use("/api/*", identityMiddleware);
app.use("/v1/*", identityMiddleware);
// H1: Runtime Health Dashboard — public, no identity middleware
app.route("/health", healthRouter);
// Sprint 48: Auth — public, no identity middleware (it's the login endpoint)
app.route("/auth", authRouter);
app.route("/api", chatRouter);
app.route("/api", dashboardRouter);
app.route("/v1/tasks", taskRouter);
app.route("/v1/memory", memoryRouter);
app.route("/v1/evidence", evidenceRouter);
app.route("/v1", archiveRouter);
app.route("/v1/prompt-templates", promptTemplatesRouter);
app.route("/v1/sessions", sessionsRouter);
app.route("/v1/permissions", createPermissionsRouter());
app.route("/v1/workspaces", createWorkspacesRouter());

console.log(`
╔══════════════════════════════════════════╗
║     SmartRouter Pro v1.0               ║
║     透明的、会成长的 AI 智能运行时       ║
║     Port: ${config.port}                          ║
╚══════════════════════════════════════════╝
`);

// Sprint 69: Block startup if DB is unreachable — fail fast with a clear message
const authUsers = process.env.AUTH_USERS;
const authHint = authUsers
  ? `  → Auth: ${authUsers.split(",").length} user(s) loaded`
  : "  → Auth: using dev fallback (admin:changeme) ⚠  set AUTH_USERS for production";

try {
  const start = Date.now();
  await query("SELECT 1");
  const latency = Date.now() - start;
  console.log(`  ✅ Database connected (${latency}ms)\n${authHint}\n`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  ❌ Database FAILED to connect: ${msg}`);
  console.error(`\n  → Is PostgreSQL running on ${config.databaseUrl}?`);
  console.error(`  → Start via Docker: docker run -d -p 5432:5432 \\`);
  console.error(`    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=smartrouter postgres:16-alpine\n`);
  process.exit(1);
}

serve({ fetch: app.fetch, port: config.port });

// Phase 3.0: 启动后台 Worker（独立轮询循环，不阻塞 HTTP 请求）
startSlowWorker();
startExecuteWorker();
