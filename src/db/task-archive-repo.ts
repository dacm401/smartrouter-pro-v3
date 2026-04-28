// Phase 3.0: Manager-Worker Runtime — Task Archive Repository
// backend/src/db/task-archive-repo.ts

import { v4 as uuid } from "uuid";
import { query } from "./connection.js";
import type {
  ManagerDecision,
  CommandPayload,
  WorkerResult,
  TaskArchiveRecord,
  TaskCommandRecord,
  TaskWorkerResultRecord,
  CommandStatus,
} from "../types/index.js";

// ── TaskArchiveRepo ────────────────────────────────────────────────────────────

export const TaskArchiveRepo = {
  /**
   * 创建 Archive 记录。
   * Phase 3.0: ManagerDecision 生成后立即调用。
   * 依赖：task_archives 表有 manager_decision 和 user_id 列（migration 010）。
   */
  async create(input: {
    task_id?: string;
    session_id: string;
    user_id: string;
    decision: ManagerDecision;
    user_input: string;
    task_brief?: string;
    goal?: string;
  }): Promise<{ id: string }> {
    // 用传入的 task_id 作为主键，这样 pollArchiveAndYield(taskId) 能直接 getById 找到
    const id = input.task_id ?? uuid();
    // command 字段：Phase 3.0 用 decision.command payload；为 null 时传 '{}'::jsonb 避免 COALESCE 类型不匹配
    const commandJson = input.decision.command
      ? JSON.stringify(input.decision.command)
      : "{}";
    await query(
      `INSERT INTO task_archives
        (id, session_id, user_id, manager_decision, command,
         user_input, task_brief, state, status, constraints,
         fast_observations, slow_execution)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,'delegated','pending','{}','[]'::jsonb,'{}'::jsonb)`,
      [
        id,
        input.session_id,
        input.user_id,
        JSON.stringify(input.decision),
        commandJson,
        input.user_input,
        input.task_brief ? JSON.stringify({ brief: input.task_brief, goal: input.goal }) : null,
      ]
    );
    return { id };
  },

  /**
   * 按 session_id 读取最新的 Archive（Phase 0 主要读取路径）。
   */
  async getBySession(
    sessionId: string,
    userId: string
  ): Promise<TaskArchiveRecord | null> {
    const result = await query(
      `SELECT * FROM task_archives
       WHERE session_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId, userId]
    );
    return result.rows[0] as TaskArchiveRecord | null;
  },

  /**
   * 按 ID 读取 Archive。
   */
  async getById(id: string): Promise<TaskArchiveRecord | null> {
    const result = await query(
      `SELECT * FROM task_archives WHERE id = $1 LIMIT 1`,
      [id]
    );
    return result.rows[0] as TaskArchiveRecord | null;
  },

  /**
   * 更新 state（Phase 3.0 状态机）。
   * Phase 3.0 states: new / clarifying / delegated / executing /
   *                    waiting_result / synthesizing / completed / failed / cancelled
   */
  async updateState(
    archiveId: string,
    newState: string
  ): Promise<void> {
    // 同时更新 status（供 sse-poller.ts 轮询感知）
    // state: chattering/clarifying/delegated/running/done/failed/cancelled
    // status: pending/running/done/failed/cancelled（与 state 语义对齐）
    const statusMap: Record<string, string> = {
      delegated: "pending",
      running: "running",
      done: "done",
      failed: "failed",
      cancelled: "cancelled",
    };
    const newStatus = statusMap[newState] ?? "pending";
    await query(
      `UPDATE task_archives SET state = $1, status = $2 WHERE id = $3`,
      [newState, newStatus, archiveId]
    );
  },

  /**
   * 追加 fast_observations（Manager 执行过程中记录）。
   */
  async appendFastObservation(
    archiveId: string,
    observation: { timestamp: number; observation: string }
  ): Promise<void> {
    await query(
      `UPDATE task_archives
       SET fast_observations = fast_observations || $1::jsonb
       WHERE id = $2`,
      [JSON.stringify([observation]), archiveId]
    );
  },

  /**
   * 更新 slow_execution（Worker 执行完成后写入）。
   */
  async setSlowExecution(
    archiveId: string,
    execution: Record<string, unknown>
  ): Promise<void> {
    await query(
      `UPDATE task_archives SET slow_execution = $1 WHERE id = $2`,
      [JSON.stringify(execution), archiveId]
    );
  },

  /**
   * 标记为已投递（delivered=true）。
   */
  async markDelivered(archiveId: string): Promise<void> {
    await query(
      `UPDATE task_archives SET delivered = true, state = 'completed' WHERE id = $1`,
      [archiveId]
    );
  },
} as const;

// ── TaskCommandRepo ────────────────────────────────────────────────────────────

export const TaskCommandRepo = {
  /**
   * 创建 Command 记录（幂等插入）。
   * Phase 3.0: ManagerDecision.decision_type ∈ {delegate_to_slow, execute_task} 时调用。
   */
  async create(input: {
    task_id: string;
    archive_id: string;
    user_id: string;
    command_type: string;
    worker_hint?: string;
    priority?: string;
    payload: CommandPayload;
    idempotency_key?: string;
    timeout_sec?: number;
  }): Promise<{ id: string; status: string }> {
    const id = uuid();
    const result = await query(
      `INSERT INTO task_commands
        (id, task_id, archive_id, user_id, command_type, worker_hint,
         priority, payload_json, idempotency_key, timeout_sec)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO UPDATE SET status = 'queued' RETURNING id, status`,
      [
        id,
        input.task_id,
        input.archive_id,
        input.user_id,
        input.command_type,
        input.worker_hint ?? null,
        input.priority ?? "normal",
        JSON.stringify(input.payload),
        input.idempotency_key ?? null,
        input.timeout_sec ?? null,
      ]
    );
    // ON CONFLICT 在 pg 上需要事先建 UNIQUE index
    // idempotency_key_idx 在 migration 010 中已创建
    return { id: result.rows[0].id, status: result.rows[0].status };
  },

  /**
   * 按 ID 读取 Command。
   */
  async getById(id: string): Promise<TaskCommandRecord | null> {
    const result = await query(
      `SELECT * FROM task_commands WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (!result.rows[0]) return null;
    return mapCommandRow(result.rows[0]);
  },

  /**
   * 取 Archive 最新 queued Command（Worker 拉取时调用）。
   * Phase 3.0: worker 从这里拿 command，不读 history。
   */
  async getLatestQueued(archiveId: string): Promise<TaskCommandRecord | null> {
    const result = await query(
      `SELECT * FROM task_commands
       WHERE archive_id = $1 AND status = 'queued'
       ORDER BY issued_at DESC LIMIT 1`,
      [archiveId]
    );
    if (!result.rows[0]) return null;
    return mapCommandRow(result.rows[0]);
  },

  /**
   * 更新 Command status（Worker 启动/完成/失败时调用）。
   */
  async updateStatus(
    id: string,
    status: CommandStatus,
    patch?: {
      started_at?: Date;
      finished_at?: Date;
      error_message?: string;
    }
  ): Promise<void> {
    await query(
      `UPDATE task_commands
       SET status = $1,
           started_at = COALESCE($2, started_at),
           finished_at = COALESCE($3, finished_at),
           error_message = $4
       WHERE id = $5`,
      [
        status,
        patch?.started_at?.toISOString() ?? null,
        patch?.finished_at?.toISOString() ?? null,
        patch?.error_message ?? null,
        id,
      ]
    );
  },
} as const;

// ── TaskWorkerResultRepo ──────────────────────────────────────────────────────

export const TaskWorkerResultRepo = {
  /**
   * 创建 Worker Result（Worker 完成后调用）。
   */
  async create(input: {
    task_id: string;
    archive_id: string;
    command_id: string;
    user_id: string;
    worker_role: string;
    result: WorkerResult;
    tokens_input?: number;
    tokens_output?: number;
    cost_usd?: number;
    started_at?: Date;
  }): Promise<{ id: string }> {
    const id = uuid();
    await query(
      `INSERT INTO task_worker_results
        (id, task_id, archive_id, command_id, user_id, worker_role,
         result_type, status, summary, result_json, confidence,
         tokens_input, tokens_output, cost_usd, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        input.task_id,
        input.archive_id,
        input.command_id,
        input.user_id,
        input.worker_role,
        input.result.structured_result
          ? Object.keys(input.result.structured_result)[0] ?? "analysis"
          : "analysis",
        input.result.status,
        input.result.summary,
        JSON.stringify(input.result.structured_result ?? {}),
        input.result.confidence ?? null,
        input.tokens_input ?? null,
        input.tokens_output ?? null,
        input.cost_usd ?? null,
        input.started_at?.toISOString() ?? null,
      ]
    );
    return { id };
  },

  /**
   * 按 Command ID 读取结果（Manager 汇总时调用）。
   */
  async getByCommandId(commandId: string): Promise<TaskWorkerResultRecord | null> {
    const result = await query(
      `SELECT * FROM task_worker_results WHERE command_id = $1 LIMIT 1`,
      [commandId]
    );
    if (!result.rows[0]) return null;
    return mapResultRow(result.rows[0]);
  },

  /**
   * 按 task_id 读取所有结果（Manager 汇总时调用）。
   */
  async listByTask(taskId: string): Promise<TaskWorkerResultRecord[]> {
    const result = await query(
      `SELECT * FROM task_worker_results
       WHERE task_id = $1 ORDER BY completed_at ASC`,
      [taskId]
    );
    return result.rows.map(mapResultRow);
  },
} as const;

// ── TaskArchiveEventRepo ───────────────────────────────────────────────────────

export type ArchiveEventType =
  // Phase 3.0 SSE events
  | "archive_created"
  | "worker_started"
  | "worker_completed"
  | "manager_synthesized"
  // Phase 4 Audit events
  | "permission_denied"
  | "redaction_applied"
  | "approval_requested"
  | "approval_granted"
  | "approval_rejected";

export interface TaskArchiveEventRecord {
  id: string;
  archive_id: string;
  task_id: string | null;
  event_type: ArchiveEventType;
  payload: Record<string, unknown>;
  actor: string | null;
  user_id: string | null;
  created_at: string;
}

export const TaskArchiveEventRepo = {
  /**
   * 写入 Archive 生命周期事件。
   * Phase 3.0 SSE：archive_written / worker_started / worker_completed / manager_synthesized
   * Phase 4 Audit：permission_denied / redaction_applied / approval_requested 等
   */
  async create(input: {
    archive_id: string;
    task_id?: string;
    event_type: ArchiveEventType;
    payload?: Record<string, unknown>;
    actor?: string;
    user_id?: string;
  }): Promise<{ id: string }> {
    const id = uuid();
    await query(
      `INSERT INTO task_archive_events
        (id, archive_id, task_id, event_type, payload, actor, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        input.archive_id,
        input.task_id ?? null,
        input.event_type,
        JSON.stringify(input.payload ?? {}),
        input.actor ?? null,
        input.user_id ?? null,
      ]
    );
    return { id };
  },

  /**
   * 按 archive_id 读取完整事件时间线（用于调试 / 前端 timeline 展示）。
   */
  async listByArchive(archiveId: string): Promise<TaskArchiveEventRecord[]> {
    const result = await query(
      `SELECT * FROM task_archive_events
       WHERE archive_id = $1
       ORDER BY created_at ASC`,
      [archiveId]
    );
    return result.rows as TaskArchiveEventRecord[];
  },

  /**
   * 按 task_id 读取事件（查找某个任务的所有相关事件）。
   */
  async listByTask(taskId: string): Promise<TaskArchiveEventRecord[]> {
    const result = await query(
      `SELECT * FROM task_archive_events
       WHERE task_id = $1
       ORDER BY created_at ASC`,
      [taskId]
    );
    return result.rows as TaskArchiveEventRecord[];
  },

  /**
   * 按事件类型过滤（审计查询：permission_denied / approval_* 等）。
   */
  async listByEventType(
    eventType: ArchiveEventType,
    limit = 100
  ): Promise<TaskArchiveEventRecord[]> {
    const result = await query(
      `SELECT * FROM task_archive_events
       WHERE event_type = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [eventType, limit]
    );
    return result.rows as TaskArchiveEventRecord[];
  },
} as const;

// ── 行列映射 ──────────────────────────────────────────────────────────────────

function mapCommandRow(row: Record<string, unknown>): TaskCommandRecord {
  return {
    ...row,
    payload_json: typeof row.payload_json === "string"
      ? JSON.parse(row.payload_json as string)
      : row.payload_json,
  } as TaskCommandRecord;
}

function mapResultRow(row: Record<string, unknown>): TaskWorkerResultRecord {
  return {
    ...row,
    result_json: typeof row.result_json === "string"
      ? JSON.parse(row.result_json as string)
      : row.result_json,
  } as TaskWorkerResultRecord;
}
