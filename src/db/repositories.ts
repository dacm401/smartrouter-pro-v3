import { v4 as uuid } from "uuid";
import { query } from "./connection.js";
import type { DecisionRecord, BehavioralMemory, IdentityMemory, GrowthProfile, Task, TaskListItem, TaskSummary, TaskTrace, MemoryEntry, MemoryEntryInput, MemoryEntryUpdate, ExecutionResultRecord, ExecutionResultInput, Evidence, EvidenceInput, DelegationLog, DelegationLogInput, DelegationLogExecutionUpdate, PromptTemplate, PromptTemplateInput, PromptTemplateUpdate } from "../types/index.js";
import { GROWTH_LEVELS } from "../config.js";
import { getEmbedding } from "../services/embedding.js";

export const DecisionRepo = {
  async save(d: DecisionRecord): Promise<void> {
    await query(
      `INSERT INTO decision_logs (
        id, user_id, session_id, query_preview, intent, complexity_score,
        input_token_count, has_code, has_math,
        router_version, fast_score, slow_score, confidence,
        selected_model, selected_role, selection_reason,
        context_original_tokens, context_compressed_tokens,
        compression_level, compression_ratio,
        model_used, exec_input_tokens, exec_output_tokens,
        total_cost_usd, latency_ms, did_fallback, fallback_reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [
        d.id, d.user_id, d.session_id,
        d.input_features.raw_query.substring(0, 200),
        d.input_features.intent, d.input_features.complexity_score,
        d.input_features.token_count, d.input_features.has_code, d.input_features.has_math,
        d.routing.router_version, d.routing.scores.fast, d.routing.scores.slow,
        d.routing.confidence, d.routing.selected_model, d.routing.selected_role,
        d.routing.selection_reason, d.context.original_tokens, d.context.compressed_tokens,
        d.context.compression_level, d.context.compression_ratio,
        d.execution.model_used, d.execution.input_tokens, d.execution.output_tokens,
        d.execution.total_cost_usd, d.execution.latency_ms, d.execution.did_fallback,
        d.execution.fallback_reason || null,
      ]
    );
  },

  async updateFeedback(id: string, feedbackType: string, feedbackScore: number): Promise<void> {
    await query(`UPDATE decision_logs SET feedback_type=$1, feedback_score=$2 WHERE id=$3`, [feedbackType, feedbackScore, id]);
  },

  async getRecent(userId: string, limit = 20): Promise<any[]> {
    // delegation_logs 是系统实际写入的表，decision_logs 已废弃
    const result = await query(
      `SELECT * FROM delegation_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },

  async getById(id: string): Promise<{ id: string; user_id: string } | null> {
    const result = await query(`SELECT id, user_id FROM decision_logs WHERE id=$1`, [id]);
    if (result.rows.length === 0) return null;
    return result.rows[0];
  },

  /** Get the latest decision log for a task (ordered by created_at DESC) */
  async getByTaskId(taskId: string): Promise<any | null> {
    // First get session_id from the task
    const taskResult = await query(`SELECT session_id FROM tasks WHERE id=$1`, [taskId]);
    if (taskResult.rows.length === 0) return null;
    const sessionId = taskResult.rows[0].session_id;
    if (!sessionId) return null;
    const result = await query(
      `SELECT * FROM decision_logs WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  },

  async getTodayStats(userId: string): Promise<any> {
    // delegation_logs 是系统实际写入的表，decision_logs 已废弃
    const result = await query(
      `SELECT
        COUNT(*)::int as total_requests,
        COUNT(*) FILTER (WHERE routed_action = 'direct_answer')::int as fast_count,
        COUNT(*) FILTER (WHERE routed_action IN ('delegate_to_slow', 'execute_task'))::int as slow_count,
        COUNT(*) FILTER (WHERE execution_status = 'timeout' OR execution_status = 'error')::int as fallback_count,
        COALESCE(SUM(latency_ms), 0)::int as total_latency,
        COALESCE(SUM(cost_usd), 0)::float as total_cost,
        0::float as saved_cost,
        COALESCE(AVG(latency_ms), 0)::int as avg_latency,
        0 as satisfaction_rate
      FROM delegation_logs
      WHERE user_id = $1 AND created_at >= CURRENT_DATE`,
      [userId]
    );
    const row = result.rows[0] || {};
    // saved_cost 暂时无法计算（需要 baseline 对比），保留 0
    // satisfaction_rate 需要从 feedback_events 关联，暂保留 0
    return {
      total_requests: Number(row.total_requests) || 0,
      fast_count: Number(row.fast_count) || 0,
      slow_count: Number(row.slow_count) || 0,
      fallback_count: Number(row.fallback_count) || 0,
      total_tokens: 0, // delegation_logs 无 token 字段
      total_cost: Number(row.total_cost) || 0,
      saved_cost: 0,
      saving_rate: 0,
      avg_latency_ms: Number(row.avg_latency) || 0,
      satisfaction_rate: 0,
    };
  },

  /**
   * Computes daily satisfaction rate — the fraction of decisions with positive
   * feedback among all decisions that received any feedback.
   * Replaces the old getRoutingAccuracyHistory which relied on routing_correct,
   * a field that was always NULL (always hardcoded to true at logDecision time).
   * We have no ground-truth correctness label; satisfaction_score is the
   * honest proxy for routing quality.
   */
  async getRoutingAccuracyHistory(userId: string, days = 30): Promise<{ date: string; value: number }[]> {
    const result = await query(
      `WITH base AS (
        SELECT
          d.id,
          d.created_at::date as date,
          d.feedback_score,
          CASE
            WHEN fe.signal_level IS NOT NULL AND fe.signal_level <= 1 THEN true
            WHEN fe.signal_level IS NULL AND d.feedback_score IS NOT NULL THEN true
            ELSE false
          END as has_l1_signal
        FROM decision_logs d
        LEFT JOIN feedback_events fe ON fe.decision_id = d.id AND fe.user_id = d.user_id
        WHERE d.user_id = $1 AND d.created_at >= CURRENT_DATE - $2::int
      )
      SELECT
        date,
        CASE WHEN COUNT(*) FILTER (WHERE has_l1_signal = true) > 0
          THEN ROUND(
            COUNT(*) FILTER (WHERE has_l1_signal = true AND base.feedback_score > 0)::float /
            COUNT(*) FILTER (WHERE has_l1_signal = true)::float * 100
          )
          ELSE NULL END as value
      FROM base
      GROUP BY date
      ORDER BY date`,
      [userId, days]
    );
    return result.rows
      .filter((r: any) => r.value !== null)
      .map((r: any) => ({ date: r.date.toISOString().split("T")[0], value: Number(r.value) }));
  },

  /** Sprint 23: 30-day cost ROI stats for Dashboard */
  async getCostStats(userId: string): Promise<{
    total_spent_usd: number;
    baseline_spent_usd: number;
    saved_usd: number;
    saved_percent: number;
    task_count: number;
    period_days: number;
  }> {
    // Import pricing here to avoid circular dependency
    const { calcBaselineCost } = await import("../config/pricing.js");

    const result = await query(
      `SELECT
        COUNT(*)::int as task_count,
        COALESCE(SUM(exec_input_tokens), 0)::int as total_input_tokens,
        COALESCE(SUM(exec_output_tokens), 0)::int as total_output_tokens,
        COALESCE(SUM(total_cost_usd), 0)::float as total_spent_usd
      FROM decision_logs
      WHERE user_id = $1
        AND created_at >= NOW() - INTERVAL '30 days'
        AND exec_input_tokens IS NOT NULL`,
      [userId],
    );

    const row = result.rows[0] ?? {
      task_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_spent_usd: 0,
    };

    const baseline_spent_usd = calcBaselineCost(
      Number(row.total_input_tokens),
      Number(row.total_output_tokens),
    );
    const saved_usd = Math.max(0, baseline_spent_usd - Number(row.total_spent_usd));
    const saved_percent =
      baseline_spent_usd > 0
        ? Math.round((saved_usd / baseline_spent_usd) * 100)
        : 0;

    return {
      total_spent_usd: Number(row.total_spent_usd),
      baseline_spent_usd,
      saved_usd,
      saved_percent,
      task_count: row.task_count,
      period_days: 30,
    };
  },
};

// ── Feedback Events ───────────────────────────────────────────────────────────

export interface FeedbackEvent {
  id: string;
  decision_id: string;
  user_id: string;
  event_type: string;
  signal_level: number;
  source: "ui" | "auto_detect" | "system";
  raw_data: Record<string, unknown> | null;
  created_at: Date;
}

/** Maps FeedbackType → { signal_level, source } */
const SIGNAL_CONFIG: Record<string, { signal_level: number; source: "ui" | "auto_detect" | "system" }> = {
  thumbs_up:        { signal_level: 1, source: "ui" },
  thumbs_down:      { signal_level: 1, source: "ui" },
  follow_up_thanks: { signal_level: 2, source: "auto_detect" },
  follow_up_doubt:  { signal_level: 2, source: "auto_detect" },
  regenerated:      { signal_level: 3, source: "auto_detect" },
  edited:           { signal_level: 3, source: "system" },
  accepted:         { signal_level: 1, source: "system" },
};

export const FeedbackEventRepo = {
  async save(event: {
    decisionId: string;
    userId: string;
    eventType: string;
    rawData?: Record<string, unknown>;
  }): Promise<void> {
    const config = SIGNAL_CONFIG[event.eventType] ?? { signal_level: 3, source: "system" as const };
    await query(
      `INSERT INTO feedback_events (id, decision_id, user_id, event_type, signal_level, source, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuid(), event.decisionId, event.userId, event.eventType, config.signal_level, config.source, event.rawData ? JSON.stringify(event.rawData) : null]
    );
  },

  /**
   * Batch-retrieves feedback events for a set of decision IDs.
   * Returns a Map: decisionId → signal_level (the signal level of the event,
   * which is deterministic per decision since each event_type maps to one signal_level).
   *
   * Used by analyzeAndLearn() to implement P5 signal-level gating:
   *   L1 (signal_level=1) → enters truth stats + eligibility
   *   L2 (signal_level=2) → enters eligibility only
   *   L3 (signal_level=3) → excluded from all learning logic
   *
   * If no event exists for a decision_id → not present in the returned Map.
   * analyzeAndLearn falls back to feedback_score != null as the L1/legacy heuristic.
   */
  async getByDecisionIds(userId: string, decisionIds: string[]): Promise<Map<string, number>> {
    if (decisionIds.length === 0) return new Map();
    const result = await query(
      `SELECT decision_id, signal_level
       FROM feedback_events
       WHERE user_id = $1 AND decision_id = ANY($2)`,
      [userId, decisionIds]
    );
    const map = new Map<string, number>();
    for (const row of result.rows) {
      // For deterministic behaviour: if multiple events exist for the same decision_id
      // (should not happen in normal flow, but guard against it), use the LOWEST signal_level
      // (most trustworhy signal wins).  signal_level: 1=strongest, 3=weakest.
      const existing = map.get(row.decision_id);
      if (existing === undefined || row.signal_level < existing) {
        map.set(row.decision_id, Number(row.signal_level));
      }
    }
    return map;
  },
};

export const MemoryRepo = {
  async getIdentity(userId: string): Promise<IdentityMemory | null> {
    const result = await query(`SELECT * FROM identity_memories WHERE user_id=$1`, [userId]);
    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
      user_id: r.user_id, response_style: r.response_style, expertise_level: r.expertise_level,
      domains: r.domains || [], quality_sensitivity: r.quality_sensitivity, cost_sensitivity: r.cost_sensitivity,
      preferred_fast_model: r.preferred_fast_model, preferred_slow_model: r.preferred_slow_model,
      updated_at: new Date(r.updated_at).getTime(),
    };
  },

  async upsertIdentity(mem: Partial<IdentityMemory> & { user_id: string }): Promise<void> {
    await query(
      `INSERT INTO identity_memories (user_id, response_style, expertise_level, domains, quality_sensitivity, cost_sensitivity)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         response_style = COALESCE($2, identity_memories.response_style),
         expertise_level = COALESCE($3, identity_memories.expertise_level),
         domains = COALESCE($4, identity_memories.domains),
         quality_sensitivity = COALESCE($5, identity_memories.quality_sensitivity),
         cost_sensitivity = COALESCE($6, identity_memories.cost_sensitivity),
         updated_at = NOW()`,
      [mem.user_id, mem.response_style || "balanced", mem.expertise_level || "intermediate", mem.domains || [], mem.quality_sensitivity ?? 0.5, mem.cost_sensitivity ?? 0.5]
    );
  },

  async getBehavioralMemories(userId: string): Promise<BehavioralMemory[]> {
    const result = await query(`SELECT * FROM behavioral_memories WHERE user_id=$1 AND strength > 0.1 ORDER BY strength DESC LIMIT 50`, [userId]);
    return result.rows.map((r: any) => ({
      id: r.id, user_id: r.user_id, trigger_pattern: r.trigger_pattern, observation: r.observation,
      learned_action: r.learned_action, strength: r.strength, reinforcement_count: r.reinforcement_count,
      last_activated: new Date(r.last_activated || r.created_at).getTime(),
      source_decision_ids: r.source_decision_ids || [], created_at: new Date(r.created_at).getTime(),
    }));
  },

  async saveBehavioralMemory(mem: BehavioralMemory): Promise<void> {
    await query(
      `INSERT INTO behavioral_memories (id, user_id, trigger_pattern, observation, learned_action, strength, reinforcement_count, last_activated, source_decision_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [mem.id, mem.user_id, mem.trigger_pattern, mem.observation, mem.learned_action, mem.strength, mem.reinforcement_count, new Date(mem.last_activated).toISOString(), mem.source_decision_ids]
    );
  },

  async reinforceMemory(id: string, delta: number): Promise<void> {
    await query(
      `UPDATE behavioral_memories SET strength = LEAST(1.0, GREATEST(0.0, strength + $1)), reinforcement_count = reinforcement_count + 1, last_activated = NOW(), updated_at = NOW() WHERE id = $2`,
      [delta, id]
    );
  },

  async decayMemories(): Promise<void> {
    await query(`UPDATE behavioral_memories SET strength = strength * 0.98 WHERE last_activated < NOW() - INTERVAL '7 days'`);
  },
};

export const TaskRepo = {
  async list(userId: string, sessionId?: string): Promise<TaskListItem[]> {
    let sql = `SELECT id as task_id, title, mode, status, complexity, risk, updated_at, session_id
      FROM tasks WHERE user_id=$1`;
    const params: any[] = [userId];
    if (sessionId) {
      sql += ` AND session_id=$2`;
      params.push(sessionId);
    }
    sql += ` ORDER BY updated_at DESC LIMIT 100`;
    const result = await query(sql, params);
    return result.rows.map((r: any) => ({
      task_id: r.task_id,
      title: r.title || "",
      mode: r.mode,
      status: r.status,
      complexity: r.complexity,
      risk: r.risk,
      updated_at: new Date(r.updated_at).toISOString(),
      session_id: r.session_id,
    }));
  },

  async getById(taskId: string): Promise<Task | null> {
    const result = await query(`SELECT * FROM tasks WHERE id=$1`, [taskId]);
    if (result.rows.length === 0) return null;
    const r: any = result.rows[0];
    return {
      task_id: r.id,
      user_id: r.user_id,
      session_id: r.session_id,
      title: r.title || "",
      mode: r.mode,
      status: r.status,
      complexity: r.complexity,
      risk: r.risk,
      goal: r.goal || null,
      budget_profile: typeof r.budget_profile === "object" ? r.budget_profile : {},
      tokens_used: r.tokens_used || 0,
      tool_calls_used: r.tool_calls_used || 0,
      steps_used: r.steps_used || 0,
      summary_ref: r.summary_ref || null,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  },

  async create(data: {
    id: string;
    user_id: string;
    session_id: string;
    title: string;
    mode: string;
    complexity: string;
    risk: string;
    goal?: string;
    tokens_used?: number;
    status?: string;
  }): Promise<void> {
    await query(
      `INSERT INTO tasks (id, user_id, session_id, title, mode, complexity, risk, goal, tokens_used, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [data.id, data.user_id, data.session_id, data.title, data.mode, data.complexity, data.risk, data.goal || null, data.tokens_used || 0, data.status || "completed"]
    );
  },

  /** T1: Find the most recently active (non-terminal) task for a session+user pair. */
  async findActiveBySession(sessionId: string, userId: string): Promise<Task | null> {
    const result = await query(
      `SELECT * FROM tasks
       WHERE session_id=$1 AND user_id=$2 AND status NOT IN ('completed','failed','cancelled')
       ORDER BY updated_at DESC LIMIT 1`,
      [sessionId, userId]
    );
    if (result.rows.length === 0) return null;
    const r: any = result.rows[0];
    return {
      task_id: r.id,
      user_id: r.user_id,
      session_id: r.session_id,
      title: r.title || "",
      mode: r.mode,
      status: r.status,
      complexity: r.complexity,
      risk: r.risk,
      goal: r.goal || null,
      budget_profile: typeof r.budget_profile === "object" ? r.budget_profile : {},
      tokens_used: r.tokens_used || 0,
      tool_calls_used: r.tool_calls_used || 0,
      steps_used: r.steps_used || 0,
      summary_ref: r.summary_ref || null,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    };
  },

  /** T1: Set task status directly (used by PATCH /v1/tasks/:id with action) */
  async setStatus(taskId: string, status: string): Promise<void> {
    await query(
      `UPDATE tasks SET status=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, status]
    );
  },

  async updateExecution(taskId: string, tokensUsed: number): Promise<void> {
    await query(
      `UPDATE tasks SET tokens_used=$2, steps_used=steps_used+1, updated_at=NOW() WHERE id=$1`,
      [taskId, tokensUsed]
    );
  },

  async getSummary(taskId: string): Promise<TaskSummary | null> {
    const result = await query(`SELECT * FROM task_summaries WHERE task_id=$1`, [taskId]);
    if (result.rows.length === 0) return null;
    const r: any = result.rows[0];
    return {
      task_id: r.task_id,
      summary_id: r.id,
      goal: r.goal || null,
      confirmed_facts: r.confirmed_facts || [],
      completed_steps: r.completed_steps || [],
      blocked_by: r.blocked_by || [],
      next_step: r.next_step || null,
      summary_text: r.summary_text || null,
      version: r.version || 1,
      updated_at: new Date(r.updated_at).toISOString(),
    };
  },

  async getTraces(taskId: string, options?: { type?: string; limit?: number }): Promise<TaskTrace[]> {
    const typeFilter = options?.type;
    const limit = options?.limit ?? 100;

    let sql = `SELECT * FROM task_traces WHERE task_id=$1`;
    const params: any[] = [taskId];

    if (typeFilter) {
      sql += ` AND type=$2`;
      params.push(typeFilter);
    }
    sql += ` ORDER BY created_at ASC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await query(sql, params);
    return result.rows.map((r: any) => {
      let detail: Record<string, any> | null = null;
      if (r.detail) {
        try {
          detail = typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail;
        } catch {
          detail = { raw: r.detail };
        }
      }
      return {
        trace_id: r.id,
        task_id: r.task_id,
        type: r.type as import("../types/index.js").TraceType,
        detail,
        created_at: new Date(r.created_at).toISOString(),
      };
    });
  },

  async createTrace(data: { id: string; task_id: string; type: string; detail?: Record<string, any> | null }): Promise<void> {
    await query(
      `INSERT INTO task_traces (id, task_id, type, detail) VALUES ($1, $2, $3, $4)`,
      [data.id, data.task_id, data.type, data.detail ? JSON.stringify(data.detail) : null]
    );
  },
};

export const GrowthRepo = {
  async getProfile(userId: string): Promise<GrowthProfile> {
    const stats = await DecisionRepo.getTodayStats(userId);
    const history = await DecisionRepo.getRoutingAccuracyHistory(userId);
    const memories = await MemoryRepo.getBehavioralMemories(userId);

    const totalResult = await query(`SELECT COUNT(*)::int as total FROM decision_logs WHERE user_id=$1`, [userId]);
    const totalInteractions = totalResult.rows[0]?.total || 0;

    let currentLevel = GROWTH_LEVELS[0];
    for (const lvl of GROWTH_LEVELS) {
      if (totalInteractions >= lvl.min_interactions) currentLevel = lvl;
    }
    const nextLevel = GROWTH_LEVELS.find((l) => l.level === currentLevel.level + 1) || currentLevel;
    const progress = nextLevel === currentLevel ? 100 : Math.round(((totalInteractions - currentLevel.min_interactions) / (nextLevel.min_interactions - currentLevel.min_interactions)) * 100);

    const savedResult = await query(`SELECT COALESCE(SUM(cost_saved_vs_slow), 0)::float as total_saved FROM decision_logs WHERE user_id=$1`, [userId]);
    const milestonesResult = await query(`SELECT title, created_at FROM growth_milestones WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`, [userId]);

    const recentMemories = memories.sort((a, b) => b.created_at - a.created_at).slice(0, 5);

    return {
      user_id: userId, level: currentLevel.level, level_name: currentLevel.name, level_progress: progress,
      routing_accuracy: stats.satisfaction_rate || 0,  // was pulled from fake routing_correct history; now honest satisfaction proxy
      satisfaction_history: history,  // honest proxy: daily satisfaction rate (positive feedback / all feedback)
      cost_saving_rate: stats.total_cost > 0 ? Math.round((stats.saved_cost / (stats.total_cost + stats.saved_cost)) * 100) : 0,
      total_saved_usd: savedResult.rows[0]?.total_saved || 0,
      satisfaction_rate: stats.satisfaction_rate || 0, total_interactions: totalInteractions,
      behavioral_memories_count: memories.length,
      milestones: milestonesResult.rows.map((r: any) => ({ date: new Date(r.created_at).toISOString().split("T")[0], event: r.title })),
      recent_learnings: recentMemories.map((m) => ({ date: new Date(m.created_at).toISOString().split("T")[0], learning: m.observation })),
    };
  },

  async addMilestone(userId: string, type: string, title: string, value?: number): Promise<void> {
    await query(`INSERT INTO growth_milestones (id, user_id, milestone_type, title, metric_value) VALUES ($1, $2, $3, $4, $5)`,
      [uuid(), userId, type, title, value || null]);
  },
};

// ── Memory entries (MC-001) ────────────────────────────────────────────────────

export const MemoryEntryRepo = {
  async create(data: MemoryEntryInput): Promise<MemoryEntry> {
    const id = uuid();
    // M2: default relevance_score based on source (manual=0.5, auto_learn=0.3)
    const relevanceScore = data.relevance_score ?? (data.source === "auto_learn" ? 0.3 : 0.5);
    const result = await query(
      `INSERT INTO memory_entries (id, user_id, category, content, importance, tags, source, relevance_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        data.user_id,
        data.category,
        data.content,
        data.importance ?? 3,
        data.tags ?? [],
        data.source ?? "manual",
        relevanceScore,
      ]
    );
    const entry = mapMemoryRow(result.rows[0]);

    // Sprint 25: Async fire-and-forget embedding generation
    setImmediate(async () => {
      try {
        const embedding = await getEmbedding(data.content);
        if (embedding) {
          const vectorStr = `[${embedding.join(",")}]`;
          await query(
            `UPDATE memory_entries SET embedding = $1::vector WHERE id = $2`,
            [vectorStr, id]
          );
        }
      } catch {
        // Silent fail: embedding is optional
      }
    });

    return entry;
  },

  /**
   * M2: Boost relevance_score for recent auto_learn entries when positive feedback received.
   * Increases score by 0.3 (capped at 1.0) for entries within the time window.
   */
  async boostRecentAutoLearn(userId: string, windowMs: number = 300_000): Promise<void> {
    const since = new Date(Date.now() - windowMs).toISOString();
    await query(
      `UPDATE memory_entries
       SET relevance_score = LEAST(relevance_score + 0.3, 1.0)
       WHERE user_id = $1
         AND source = 'auto_learn'
         AND created_at > $2`,
      [userId, since]
    );
  },

  /**
   * Sprint 25: Vector similarity search using pgvector.
   * Returns entries ordered by cosine similarity (highest first).
   */
  async searchByVector(
    userId: string,
    queryEmbedding: number[],
    limit: number = 20,
    category?: string
  ): Promise<Array<MemoryEntry & { similarity: number }>> {
    const vectorStr = `[${queryEmbedding.join(",")}]`;
    const params: unknown[] = [userId, vectorStr, limit];
    let categoryClause = "";

    if (category) {
      params.push(category);
      categoryClause = `AND category = $${params.length}`;
    }

    const result = await query(
      `SELECT *,
              1 - (embedding <=> $2::vector) AS similarity
       FROM memory_entries
       WHERE user_id = $1
         AND embedding IS NOT NULL
         ${categoryClause}
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      params
    );

    return result.rows.map((r: any) => ({
      ...mapMemoryRow(r),
      similarity: parseFloat(r.similarity),
    }));
  },

  async getById(id: string, userId: string): Promise<MemoryEntry | null> {
    const result = await query(
      `SELECT * FROM memory_entries WHERE id=$1 AND user_id=$2`,
      [id, userId]
    );
    if (result.rows.length === 0) return null;
    return mapMemoryRow(result.rows[0]);
  },

  async list(
    userId: string,
    opts?: { category?: string; limit?: number }
  ): Promise<MemoryEntry[]> {
    let sql = `SELECT * FROM memory_entries WHERE user_id=$1`;
    const params: any[] = [userId];
    if (opts?.category) {
      sql += ` AND category=$2`;
      params.push(opts.category);
    }
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length + 1}`;
    params.push(opts?.limit ?? 100);
    const result = await query(sql, params);
    return result.rows.map(mapMemoryRow);
  },

  async update(
    id: string,
    userId: string,
    data: MemoryEntryUpdate
  ): Promise<MemoryEntry | null> {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (data.content !== undefined) {
      sets.push(`content=$${idx++}`);
      params.push(data.content);
    }
    if (data.importance !== undefined) {
      sets.push(`importance=$${idx++}`);
      params.push(data.importance);
    }
    if (data.tags !== undefined) {
      sets.push(`tags=$${idx++}`);
      params.push(data.tags);
    }
    if (data.category !== undefined) {
      sets.push(`category=$${idx++}`);
      params.push(data.category);
    }
    if (sets.length === 0) return this.getById(id, userId);
    sets.push(`updated_at=NOW()`);
    params.push(id, userId);
    const result = await query(
      `UPDATE memory_entries SET ${sets.join(", ")} WHERE id=$${idx++} AND user_id=$${idx} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return null;
    return mapMemoryRow(result.rows[0]);
  },

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM memory_entries WHERE id=$1 AND user_id=$2`,
      [id, userId]
    );
    return (result.rowCount ?? 0) > 0;
  },

  async getTopForUser(userId: string, limit: number): Promise<MemoryEntry[]> {
    const result = await query(
      `SELECT * FROM memory_entries
       WHERE user_id=$1
       ORDER BY importance DESC, updated_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(mapMemoryRow);
  },

  /**
   * Fetch recent memory entries for a given user + category within the past N days.
   * Used by analyzeAndLearn() for deduplication: avoids writing the same auto_learn
   * observation twice within the time window.
   */
  async findRecent(userId: string, category: string, days: number): Promise<MemoryEntry[]> {
    const result = await query(
      `SELECT * FROM memory_entries
       WHERE user_id=$1 AND category=$2
         AND created_at > NOW() - ($3 || ' days')::INTERVAL
       ORDER BY created_at DESC`,
      [userId, category, days]
    );
    return result.rows.map(mapMemoryRow);
  },
};

export const ExecutionResultRepo = {
  async save(r: ExecutionResultInput): Promise<ExecutionResultRecord> {
    const id = uuid();
    const result = await query(
      `INSERT INTO execution_results (
        id, task_id, user_id, session_id,
        final_content, steps_summary, memory_entries_used,
        model_used, tool_count, duration_ms, reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        id,
        r.task_id,
        r.user_id,
        r.session_id,
        r.final_content,
        JSON.stringify(r.steps_summary),
        r.memory_entries_used ?? [],
        r.model_used ?? null,
        r.tool_count,
        r.duration_ms ?? null,
        r.reason,
      ]
    );
    return mapExecutionResultRow(result.rows[0]);
  },

  async getByTaskId(taskId: string): Promise<ExecutionResultRecord | null> {
    const result = await query(
      `SELECT * FROM execution_results WHERE task_id=$1 LIMIT 1`,
      [taskId]
    );
    if (result.rows.length === 0) return null;
    return mapExecutionResultRow(result.rows[0]);
  },

  async listByUser(
    userId: string,
    limit = 20
  ): Promise<ExecutionResultRecord[]> {
    const result = await query(
      `SELECT * FROM execution_results
       WHERE user_id=$1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(mapExecutionResultRow);
  },
};

function mapExecutionResultRow(r: any): ExecutionResultRecord {
  return {
    id: r.id,
    task_id: r.task_id,
    user_id: r.user_id,
    session_id: r.session_id,
    final_content: r.final_content,
    steps_summary: r.steps_summary ?? null,
    memory_entries_used: r.memory_entries_used ?? [],
    model_used: r.model_used,
    tool_count: r.tool_count ?? 0,
    duration_ms: r.duration_ms ?? null,
    reason: r.reason,
    created_at: new Date(r.created_at).toISOString(),
  };
}

function mapMemoryRow(r: any): MemoryEntry {
  return {
    id: r.id,
    user_id: r.user_id,
    category: r.category,
    content: r.content,
    importance: r.importance,
    tags: r.tags ?? [],
    source: r.source,
    relevance_score: r.relevance_score ?? 0.5,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

// ── Evidence Repository (Layer 6 / E1) ──────────────────────────────────────

function mapEvidenceRow(r: any): Evidence {
  return {
    evidence_id: r.evidence_id,
    task_id: r.task_id,
    user_id: r.user_id,
    source: r.source,
    content: r.content,
    source_metadata: r.source_metadata ?? null,
    relevance_score: r.relevance_score ?? null,
    created_at: new Date(r.created_at).toISOString(),
  };
}

// ── Delegation Archive (O-005) ───────────────────────────────────────────────
// 慢模型任务档案：每个委托任务的完整记录
// 慢模型每个任务独立对话，共享知识靠档案，不靠上下文累积
// 档案查询用于新任务启动时获取相关历史上下文

export interface DelegationArchiveEntry {
  id: string;
  task_id: string;
  user_id: string;
  session_id: string;
  original_message: string;
  delegation_prompt: string;
  slow_result: string | null;
  related_task_ids: string[];
  status: "pending" | "completed" | "failed";
  processing_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

export const DelegationArchiveRepo = {
  /**
   * 档案创建（O-006：慢模型在后台完成后再写档案，所以直接写 completed）
   * 也可以先写 pending 再 complete，但 O-006 场景下慢模型完成后一起写更简单
   */
  async create(data: {
    task_id: string;
    user_id: string;
    session_id: string;
    original_message: string;
    delegation_prompt: string;
    slow_result?: string;
    processing_ms?: number;
  }): Promise<DelegationArchiveEntry> {
    const id = uuid();
    const status = data.slow_result !== undefined ? "completed" : "pending";
    const result = await query(
      `INSERT INTO delegation_archive
        (id, task_id, user_id, session_id, original_message, delegation_prompt, slow_result, status, processing_ms, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id, data.task_id, data.user_id, data.session_id,
        data.original_message, data.delegation_prompt,
        data.slow_result ?? null, status,
        data.processing_ms ?? null,
        status === "completed" ? new Date() : null,
      ]
    );
    const entry = mapDelegationArchiveRow(result.rows[0]);
    // Phase 5: side-channel write to IArchiveStorage (non-blocking)
    phase5SideChannelWrite(entry).catch((e) =>
      console.warn("[DelegationArchiveRepo.save] phase5 side-channel write failed:", e?.message)
    );
    return entry;
  },

  /**
   * 档案完成：慢模型执行完毕后写入结果
   * 注意：不再在慢模型对话中累积历史，任务间共享靠档案库
   */
  async complete(data: {
    task_id: string;
    slow_result: string;
    processing_ms: number;
  }): Promise<void> {
    await query(
      `UPDATE delegation_archive
       SET slow_result=$1, status='completed', processing_ms=$2, completed_at=NOW()
       WHERE task_id=$3`,
      [data.slow_result, data.processing_ms, data.task_id]
    );
    // Phase 5: side-channel update to IArchiveStorage (non-blocking)
    const entry = await DelegationArchiveRepo.getById(data.task_id);
    if (entry) {
      phase5SideChannelUpdate(entry.id, data.slow_result, data.processing_ms, "completed").catch((e) =>
        console.warn("[DelegationArchiveRepo.complete] phase5 side-channel update failed:", e?.message)
      );
    }
  },

  /**
   * 档案失败
   */
  async fail(task_id: string, error: string): Promise<void> {
    await query(
      `UPDATE delegation_archive SET status='failed', completed_at=NOW() WHERE task_id=$1`,
      [task_id]
    );
    // Phase 5: side-channel update (non-blocking)
    const entry = await DelegationArchiveRepo.getById(task_id);
    if (entry) {
      phase5SideChannelUpdate(entry.id, error, 0, "failed").catch((e) =>
        console.warn("[DelegationArchiveRepo.fail] phase5 side-channel update failed:", e?.message)
      );
    }
  },

  /**
   * 查询用户最近的已完成档案（用于新任务启动时获取上下文）
   * 返回最近 N 条，不传历史对话，靠档案共享知识
   */
  async getRecentByUser(userId: string, limit = 5): Promise<DelegationArchiveEntry[]> {
    const result = await query(
      `SELECT * FROM delegation_archive
       WHERE user_id=$1 AND status='completed'
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(mapDelegationArchiveRow);
  },

  /**
   * 查询单个档案
   */
  async getById(taskId: string): Promise<DelegationArchiveEntry | null> {
    const result = await query(
      `SELECT * FROM delegation_archive WHERE task_id=$1`,
      [taskId]
    );
    if (result.rows.length === 0) return null;
    return mapDelegationArchiveRow(result.rows[0]);
  },

  /**
   * 按 session 列出所有档案
   */
  async listBySession(userId: string, sessionId: string): Promise<DelegationArchiveEntry[]> {
    const result = await query(
      `SELECT * FROM delegation_archive
       WHERE user_id=$1 AND session_id=$2
       ORDER BY created_at ASC`,
      [userId, sessionId]
    );
    return result.rows.map(mapDelegationArchiveRow);
  },

  /**
   * O-007: 检测是否有 pending 的委托任务
   * 用于安抚功能：慢模型处理期间用户再发消息时，检测是否有未完成的任务
   */
  async hasPending(userId: string, sessionId: string): Promise<boolean> {
    const result = await query(
      `SELECT COUNT(*) as cnt FROM delegation_archive
       WHERE user_id=$1 AND session_id=$2 AND status='pending'`,
      [userId, sessionId]
    );
    return parseInt(result.rows[0]?.cnt ?? "0") > 0;
  },

  /**
   * O-007: 获取当前 session 中所有 pending 的任务信息
   */
  async getPendingBySession(userId: string, sessionId: string): Promise<DelegationArchiveEntry[]> {
    const result = await query(
      `SELECT * FROM delegation_archive
       WHERE user_id=$1 AND session_id=$2 AND status='pending'
       ORDER BY created_at ASC`,
      [userId, sessionId]
    );
    return result.rows.map(mapDelegationArchiveRow);
  },
};

function mapDelegationArchiveRow(r: any): DelegationArchiveEntry {
  return {
    id: r.id,
    task_id: r.task_id,
    user_id: r.user_id,
    session_id: r.session_id,
    original_message: r.original_message,
    delegation_prompt: r.delegation_prompt,
    slow_result: r.slow_result,
    related_task_ids: r.related_task_ids ?? [],
    status: r.status,
    processing_ms: r.processing_ms,
    created_at: new Date(r.created_at).toISOString(),
    completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  };
}

// ── Phase 5: Archive Storage Side-Channel ─────────────────────────────────────
// DelegationArchiveRepo 写入 DB 主表，同时可选写入 IArchiveStorage（side-channel）。
// 用途：数据主权（本地文件系统）/ S3 备份 / 快速人工审查（JSON 可读）。
// 当 STORAGE_BACKEND=local|s3|pg（非 pg-table）且 USE_PHASE5_ARCHIVE=true 时激活。
// Phase 5 storage is lazy-loaded to avoid circular deps.

let _phase5Storage: import("../services/phase5/storage-backend.js").IArchiveStorage | null = null;
let _phase5StorageAttempted = false;

async function getPhase5Storage() {
  if (_phase5Storage || _phase5StorageAttempted) return _phase5Storage;
  _phase5StorageAttempted = true;
  // Only activate when explicitly configured (not default pg-table flow)
  if (process.env.USE_PHASE5_ARCHIVE !== "true") return null;
  try {
    const { getIArchiveStorage } = await import("../services/phase5/storage-registry.js");
    _phase5Storage = await getIArchiveStorage();
  } catch (e) {
    console.warn("[DelegationArchiveRepo] Phase 5 storage unavailable:", (e as Error).message);
  }
  return _phase5Storage;
}

/**
 * 将 DelegationArchiveEntry 转换为 ArchiveDocument 格式，
 * 用于 Phase 5 side-channel 写入（IArchiveStorage）。
 */
function toArchiveDocument(entry: DelegationArchiveEntry): import("../services/phase5/storage-backend.js").ArchiveDocument {
  return {
    id: entry.id,
    task_id: entry.task_id,
    session_id: entry.session_id,
    user_id: entry.user_id,
    manager_decision: { delegation_prompt: entry.delegation_prompt },
    user_input: entry.original_message,
    state: entry.status === "completed" ? "completed" : entry.status === "failed" ? "failed" : "delegated",
    status: entry.status,
    constraints: { related_task_ids: entry.related_task_ids ?? [] },
    fast_observations: [],
    slow_execution: entry.slow_result ? { result: entry.slow_result, processing_ms: entry.processing_ms } : {},
    created_at: entry.created_at,
    updated_at: entry.completed_at ?? entry.created_at,
  };
}

/**
 * Phase 5 side-channel 写入（非阻塞，失败不影响主 DB 流程）。
 */
async function phase5SideChannelWrite(entry: DelegationArchiveEntry): Promise<void> {
  const storage = await getPhase5Storage();
  if (!storage) return;
  try {
    const doc = toArchiveDocument(entry);
    await storage.save(doc);
    console.log(`[Phase5] Archive side-channel write: ${entry.id} → ${process.env.STORAGE_BACKEND}`);
  } catch (e) {
    console.warn(`[Phase5] Side-channel write failed for ${entry.id}:`, (e as Error).message);
  }
}

async function phase5SideChannelUpdate(id: string, slow_result: string, processing_ms: number, status: string): Promise<void> {
  const storage = await getPhase5Storage();
  if (!storage) return;
  try {
    await storage.update(id, {
      slow_execution: { result: slow_result, processing_ms },
      status,
      state: status === "completed" ? "completed" : status === "failed" ? "failed" : "delegated",
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`[Phase5] Side-channel update failed for ${id}:`, (e as Error).message);
  }
}

export interface TaskArchiveEntry {
  id: string;
  session_id: string;
  turn_id: number;
  command: {
    action: string;
    task: string;
    constraints: string[];
    query_keys: string[];
  };
  user_input: string;
  constraints: string[];
  fast_observations: Array<{ timestamp: number; observation: string }>;
  slow_execution: {
    started_at?: string;
    deviations?: string[];
    result?: string;
    errors?: string[];
  };
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  delivered: boolean;
  created_at: string;
  updated_at: string;
}

export const TaskArchiveRepo = {
  async create(data: {
    task_id: string;
    session_id: string;
    turn_id?: number;
    command: TaskArchiveEntry["command"];
    user_input: string;
    constraints?: string[];
    user_id?: string;
  }): Promise<TaskArchiveEntry> {
    const id = uuid();
    const result = await query(
      `INSERT INTO task_archives
        (id, session_id, turn_id, command, user_input, constraints, status, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING *`,
      [
        id,
        data.session_id,
        data.turn_id ?? 0,
        JSON.stringify(data.command),
        data.user_input,
        data.constraints ?? [],
        data.user_id ?? null,
      ]
    );
    return mapTaskArchiveRow(result.rows[0]);
  },

  async getById(id: string): Promise<TaskArchiveEntry | null> {
    const result = await query(
      `SELECT * FROM task_archives WHERE id=$1`,
      [id]
    );
    if (result.rows.length === 0) return null;
    return mapTaskArchiveRow(result.rows[0]);
  },

  async updateStatus(id: string, status: TaskArchiveEntry["status"]): Promise<void> {
    await query(
      `UPDATE task_archives SET status=$1, updated_at=NOW() WHERE id=$2`,
      [status, id]
    );
  },

  async appendObservation(
    id: string,
    observation: { timestamp: number; observation: string }
  ): Promise<void> {
    await query(
      `UPDATE task_archives
       SET fast_observations = fast_observations || $1::jsonb,
           updated_at = NOW()
       WHERE id=$2`,
      [JSON.stringify([observation]), id]
    );
  },

  async writeExecution(data: {
    id: string;
    status: "done" | "failed";
    result?: string;
    errors?: string[];
    started_at?: string;
    deviations?: string[];
  }): Promise<void> {
    const exec = {
      started_at: data.started_at ?? null,
      deviations: data.deviations ?? [],
      result: data.result ?? null,
      errors: data.errors ?? [],
    };
    await query(
      `UPDATE task_archives
       SET slow_execution=$1, status=$2, updated_at=NOW()
       WHERE id=$3`,
      [JSON.stringify(exec), data.status, data.id]
    );
  },

  async markDelivered(id: string): Promise<void> {
    await query(
      `UPDATE task_archives SET delivered=TRUE, updated_at=NOW() WHERE id=$1`,
      [id]
    );
  },

  async getBySession(sessionId: string, limit = 10): Promise<TaskArchiveEntry[]> {
    const result = await query(
      `SELECT * FROM task_archives
       WHERE session_id=$1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sessionId, limit]
    );
    return result.rows.map(mapTaskArchiveRow);
  },

  async listPending(sessionId: string): Promise<TaskArchiveEntry[]> {
    const result = await query(
      `SELECT * FROM task_archives
       WHERE session_id=$1 AND status NOT IN ('done', 'failed', 'cancelled')
       ORDER BY created_at ASC`,
      [sessionId]
    );
    return result.rows.map(mapTaskArchiveRow);
  },

  async hasPending(sessionId: string): Promise<boolean> {
    const result = await query(
      `SELECT COUNT(*) as cnt FROM task_archives
       WHERE session_id=$1 AND status NOT IN ('done', 'failed', 'cancelled')`,
      [sessionId]
    );
    return parseInt(result.rows[0]?.cnt ?? "0") > 0;
  },

  /** 看板视图：按 userId 查最近任务（看板/Archive 列表） */
  async getRecent(userId: string, limit = 50): Promise<TaskArchiveEntry[]> {
    const result = await query(
      `SELECT * FROM task_archives
       WHERE user_id=$1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(mapTaskArchiveRow);
  },
};

function mapTaskArchiveRow(r: any): TaskArchiveEntry {
  return {
    id: r.id,
    session_id: r.session_id,
    turn_id: r.turn_id,
    command: r.command,
    user_input: r.user_input,
    constraints: r.constraints ?? [],
    fast_observations: r.fast_observations ?? [],
    slow_execution: r.slow_execution ?? {},
    status: r.status,
    delivered: r.delivered ?? false,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

export const EvidenceRepo = {
  async create(input: EvidenceInput): Promise<Evidence> {
    const id = uuid();
    const result = await query(
      `INSERT INTO evidence (evidence_id, task_id, user_id, source, content, source_metadata, relevance_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        input.task_id,
        input.user_id,
        input.source,
        input.content,
        input.source_metadata ? JSON.stringify(input.source_metadata) : null,
        input.relevance_score ?? null,
      ]
    );
    return mapEvidenceRow(result.rows[0]);
  },

  async getById(evidenceId: string): Promise<Evidence | null> {
    const result = await query(
      `SELECT * FROM evidence WHERE evidence_id=$1`,
      [evidenceId]
    );
    if (result.rows.length === 0) return null;
    return mapEvidenceRow(result.rows[0]);
  },

  async listByTask(taskId: string): Promise<Evidence[]> {
    const result = await query(
      `SELECT * FROM evidence WHERE task_id=$1 ORDER BY created_at ASC`,
      [taskId]
    );
    return result.rows.map(mapEvidenceRow);
  },

  async listByUser(userId: string, limit = 100): Promise<Evidence[]> {
    const result = await query(
      `SELECT * FROM evidence WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(mapEvidenceRow);
  },

  /** Sprint 32 P2: 按相关性排序，获取用户的证据列表（供 Task Brief relevant_facts） */
  async getEvidenceForUser(userId: string, limit = 20): Promise<Evidence[]> {
    const result = await query(
      `SELECT * FROM evidence
       WHERE user_id=$1 AND (relevance_score IS NULL OR relevance_score > 0.1)
       ORDER BY relevance_score DESC NULLS LAST, created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(mapEvidenceRow);
  },
};

// ── G4: Delegation Learning Loop ────────────────────────────────────────────────

function mapDelegationLogRow(row: any): DelegationLog {
  return {
    id: row.id,
    user_id: row.user_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    task_id: row.task_id,
    routing_version: row.routing_version,
    llm_scores: row.llm_scores,
    llm_confidence: row.llm_confidence,
    system_confidence: row.system_confidence,
    calibrated_scores: row.calibrated_scores,
    policy_overrides: row.policy_overrides,
    g2_final_action: row.g2_final_action,
    did_rerank: row.did_rerank,
    rerank_gap: row.rerank_gap,
    rerank_rules: row.rerank_rules,
    g3_final_action: row.g3_final_action,
    routed_action: row.routed_action,
    routing_reason: row.routing_reason,
    routing_layer: row.routing_layer,
    execution_status: row.execution_status,
    execution_correct: row.execution_correct,
    error_message: row.error_message,
    model_used: row.model_used,
    latency_ms: row.latency_ms,
    cost_usd: row.cost_usd ? Number(row.cost_usd) : undefined,
    // G4: 四层成功标准（异步回填）
    routing_success: row.routing_success,
    value_success: row.value_success,
    user_success: row.user_success,
    created_at: row.created_at,
    executed_at: row.executed_at,
  };
}

export const DelegationLogRepo = {
  /**
   * 写入一条委托决策记录（G4 日志 pipeline 的核心方法）。
   * 执行结果字段在异步执行完成后由 updateExecution() 回写。
   */
  async save(d: DelegationLogInput): Promise<DelegationLog> {
    const id = d.id ?? uuid();
    await query(
      `INSERT INTO delegation_logs (
        id, user_id, session_id, turn_id, task_id, routing_version,
        llm_scores, llm_confidence,
        system_confidence,
        calibrated_scores, policy_overrides, g2_final_action,
        did_rerank, rerank_gap, rerank_rules, g3_final_action,
        routed_action, routing_reason, routing_layer,
        routing_success, value_success, user_success
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,
        $9,
        $10,$11,$12,
        $13,$14,$15,$16,
        $17,$18,$19,
        $20,$21,$22
      )`,
      [
        id,
        d.user_id,
        d.session_id,
        d.turn_id,
        d.task_id ?? null,
        d.routing_version ?? "v2",
        JSON.stringify(d.llm_scores),
        d.llm_confidence,
        d.system_confidence,
        JSON.stringify(d.calibrated_scores),
        JSON.stringify(d.policy_overrides),
        d.g2_final_action,
        d.did_rerank,
        d.rerank_gap ?? null,
        JSON.stringify(d.rerank_rules),
        d.g3_final_action ?? null,
        d.routed_action,
        d.routing_reason ?? null,
        d.routing_layer ?? null,
        // G4: 四层成功标准，首次写入时均为 null（异步回填）
        d.routing_success ?? null,
        d.value_success ?? null,
        d.user_success ?? null,
      ]
    );

    const result = await query(`SELECT * FROM delegation_logs WHERE id=$1`, [id]);
    return mapDelegationLogRow(result.rows[0]);
  },

  /**
   * 回写执行结果（fire-and-forget，由执行完成后的 callback 调用）。
   * G4: 同时回填 routing_success / value_success / user_success（如果传入）。
   */
  async updateExecution(id: string, update: DelegationLogExecutionUpdate): Promise<void> {
    await query(
      `UPDATE delegation_logs SET
        execution_status = $1,
        execution_correct = $2,
        error_message = $3,
        model_used = $4,
        latency_ms = $5,
        cost_usd = $6,
        executed_at = NOW(),
        routing_success = $8,
        value_success = $9,
        user_success = $10
       WHERE id = $7`,
      [
        update.execution_status,
        update.execution_correct ?? null,
        update.error_message ?? null,
        update.model_used ?? null,
        update.latency_ms ?? null,
        update.cost_usd ?? null,
        id,
        update.routing_success ?? null,
        update.value_success ?? null,
        update.user_success ?? null,
      ]
    );
  },

  /**
   * 按 user_id 分页查询（供离线分析 dashboard 使用）。
   */
  async listByUser(userId: string, limit = 100, offset = 0): Promise<DelegationLog[]> {
    const result = await query(
      `SELECT * FROM delegation_logs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    return result.rows.map(mapDelegationLogRow);
  },

  /**
   * 查询 session 内所有 turn（供 conversation replay 使用）。
   */
  async listBySession(sessionId: string): Promise<DelegationLog[]> {
    const result = await query(
      `SELECT * FROM delegation_logs
       WHERE session_id = $1
       ORDER BY turn_id ASC`,
      [sessionId]
    );
    return result.rows.map(mapDelegationLogRow);
  },

  /**
   * 查询指定路由动作的统计（供 benchmark 分析使用）。
   * 支持按 routed_action / g2_final_action / g3_final_action 筛选。
   */
  async getActionStats(
    userId: string,
    field: "routed_action" | "g2_final_action" | "g3_final_action",
    since?: Date
  ): Promise<Record<string, number>> {
    const sinceClause = since
      ? `AND created_at >= '${since.toISOString()}'`
      : "";
    const result = await query(
      `SELECT ${field}, COUNT(*)::int as count
       FROM delegation_logs
       WHERE user_id = $1 ${sinceClause}
       GROUP BY ${field}
       ORDER BY count DESC`,
      [userId]
    );
    return Object.fromEntries(result.rows.map((r) => [r[field], r.count]));
  },

  /**
   * 查询 G3 rerank 触发率和纠正率（供 benchmark 评估 G3 价值）。
   */
  async getRerankStats(userId: string): Promise<{
    total: number;
    rerank_count: number;
    rerank_rate: number;
    corrected_count: number;
    correction_rate: number;
  }> {
    const result = await query(
      `SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE did_rerank = true)::int as rerank_count,
        COUNT(*) FILTER (WHERE did_rerank = true AND g2_final_action != g3_final_action)::int as corrected_count
       FROM delegation_logs
       WHERE user_id = $1 AND execution_status IS NOT NULL`,
      [userId]
    );
    const row = result.rows[0];
    return {
      total: row.total,
      rerank_count: row.rerank_count,
      rerank_rate: row.total > 0 ? row.rerank_count / row.total : 0,
      corrected_count: row.corrected_count,
      correction_rate: row.rerank_count > 0 ? row.corrected_count / row.rerank_count : 0,
    };
  },

  /**
   * 查询 benchmark 核心指标（供自动化 benchmark 脚本调用）。
   * 返回值可直接被 benchmark runner 消费。
   */
  async getBenchmarkMetrics(userId: string): Promise<{
    total_decisions: number;
    action_distribution: Record<string, number>;
    execution_success_rate: number;
    avg_latency_ms: number;
    avg_cost_usd: number;
    rerank_stats: { rate: number; correction_rate: number };
    routing_agreement_rate: number;
    routing_success_rate: number;      // G4-1: 路由准确率（vs benchmark ground truth）
    execution_correct_rate: number;    // G4-2: 执行正确率（Worker 执行结果质量）
    value_success_rate: number;        // G4-3: 价值增益率（Fast vs Slow 对比）
    user_success_rate: number;        // G4-4: 用户满意率
  }> {
    const result = await query(
      `WITH exec AS (
        SELECT
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE execution_status = 'success')::int as success_count,
          AVG(latency_ms)::int as avg_latency,
          AVG(cost_usd)::float as avg_cost
        FROM delegation_logs
        WHERE user_id = $1 AND execution_status IS NOT NULL
      ),
      action AS (
        SELECT routed_action, COUNT(*)::int as cnt
        FROM delegation_logs WHERE user_id = $1
        GROUP BY routed_action
      ),
      rerank AS (
        SELECT
          COUNT(*) FILTER (WHERE did_rerank = true)::int as rerank_count,
          COUNT(*) FILTER (WHERE did_rerank = true AND g2_final_action = g3_final_action)::int as agreed_count
        FROM delegation_logs WHERE user_id = $1
      ),
      g4 AS (
        SELECT
          COUNT(*) FILTER (WHERE routing_success = true)::int    as routing_ok,
          COUNT(*) FILTER (WHERE routing_success IS NOT NULL)::int as routing_total,
          COUNT(*) FILTER (WHERE execution_correct = true)::int  as exec_ok,
          COUNT(*) FILTER (WHERE execution_correct IS NOT NULL)::int as exec_total,
          COUNT(*) FILTER (WHERE value_success = 'better')::int  as value_ok,
          COUNT(*) FILTER (WHERE value_success IS NOT NULL)::int as value_total,
          COUNT(*) FILTER (WHERE user_success = true)::int       as user_ok,
          COUNT(*) FILTER (WHERE user_success IS NOT NULL)::int as user_total
        FROM delegation_logs WHERE user_id = $1
      )
      SELECT
        exec.total,
        exec.success_count,
        exec.avg_latency,
        exec.avg_cost,
        exec.success_count::float / NULLIF(exec.total, 0) as success_rate,
        rerank.rerank_count,
        rerank.agreed_count,
        rerank.rerank_count::float / NULLIF(exec.total, 0) as rerank_rate,
        (rerank.rerank_count - rerank.agreed_count)::float / NULLIF(rerank.rerank_count, 0) as correction_rate,
        rerank.agreed_count::float / NULLIF(rerank.rerank_count, 0) as agreement_rate,
        g4.routing_ok::float  / NULLIF(g4.routing_total, 0) as routing_success_rate,
        g4.exec_ok::float     / NULLIF(g4.exec_total,     0) as execution_correct_rate,
        g4.value_ok::float    / NULLIF(g4.value_total,    0) as value_success_rate,
        g4.user_ok::float    / NULLIF(g4.user_total,     0) as user_success_rate
      FROM exec, rerank, g4`,
      [userId]
    );
    const row = result.rows[0];

    const actionResult = await query(
      `SELECT routed_action, COUNT(*)::int as cnt
       FROM delegation_logs WHERE user_id = $1 GROUP BY routed_action`,
      [userId]
    );

    return {
      total_decisions: row.total ?? 0,
      action_distribution: Object.fromEntries(actionResult.rows.map((r) => [r.routed_action, r.cnt])),
      execution_success_rate: row.success_rate ?? 0,
      avg_latency_ms: row.avg_latency ?? 0,
      avg_cost_usd: row.avg_cost ?? 0,
      rerank_stats: {
        rate: row.rerank_rate ?? 0,
        correction_rate: row.correction_rate ?? 0,
      },
      routing_agreement_rate: row.agreement_rate ?? 1,
      routing_success_rate: row.routing_success_rate ?? 0,
      execution_correct_rate: row.execution_correct_rate ?? 0,
      value_success_rate: row.value_success_rate ?? 0,
      user_success_rate: row.user_success_rate ?? 0,
    };
  },
};

// ── Sprint 62: Prompt Template Repository ────────────────────────────────────

function mapPromptTemplateRow(r: any): PromptTemplate {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    version: r.version,
    content: typeof r.content === "string" ? JSON.parse(r.content) : r.content,
    scope: r.scope,
    is_active: r.is_active,
    created_by: r.created_by ?? "system",
    tags: r.tags ?? [],
    metadata: r.metadata ?? {},
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

export const PromptTemplateRepo = {
  async create(input: PromptTemplateInput & { created_by?: string }): Promise<PromptTemplate> {
    const id = uuid();
    const result = await query(
      `INSERT INTO prompt_templates (id, name, description, version, content, scope, created_by, tags, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        input.name,
        input.description ?? "",
        1,
        JSON.stringify(input.content),
        input.scope ?? "global",
        input.created_by ?? "system",
        input.tags ?? [],
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    return mapPromptTemplateRow(result.rows[0]);
  },

  async getById(id: string): Promise<PromptTemplate | null> {
    const result = await query(`SELECT * FROM prompt_templates WHERE id=$1`, [id]);
    if (result.rows.length === 0) return null;
    return mapPromptTemplateRow(result.rows[0]);
  },

  async update(id: string, update: PromptTemplateUpdate): Promise<PromptTemplate | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (update.name !== undefined) { fields.push(`name=$${idx++}`); values.push(update.name); }
    if (update.description !== undefined) { fields.push(`description=$${idx++}`); values.push(update.description); }
    if (update.content !== undefined) { fields.push(`content=$${idx++}`); values.push(JSON.stringify(update.content)); }
    if (update.is_active !== undefined) { fields.push(`is_active=$${idx++}`); values.push(update.is_active); }
    if (update.tags !== undefined) { fields.push(`tags=$${idx++}`); values.push(update.tags); }
    if (update.metadata !== undefined) { fields.push(`metadata=$${idx++}`); values.push(JSON.stringify(update.metadata)); }

    if (fields.length === 0) return this.getById(id);

    fields.push(`updated_at=NOW()`);
    if (update.content !== undefined) fields.push(`version=version+1`);

    values.push(id);
    const result = await query(
      `UPDATE prompt_templates SET ${fields.join(", ")} WHERE id=$${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return null;
    return mapPromptTemplateRow(result.rows[0]);
  },

  async setActive(id: string): Promise<void> {
    // 先关闭同 scope 下所有模板
    const template = await this.getById(id);
    if (!template) return;
    await query(
      `UPDATE prompt_templates SET is_active=FALSE WHERE scope=$1 AND is_active=TRUE`,
      [template.scope]
    );
    await query(`UPDATE prompt_templates SET is_active=TRUE, updated_at=NOW() WHERE id=$1`, [id]);
  },

  async getActive(scope = "global"): Promise<PromptTemplate | null> {
    const result = await query(
      `SELECT * FROM prompt_templates WHERE scope=$1 AND is_active=TRUE LIMIT 1`,
      [scope]
    );
    if (result.rows.length === 0) return null;
    return mapPromptTemplateRow(result.rows[0]);
  },

  async list(scope?: string): Promise<PromptTemplate[]> {
    const sql = scope
      ? `SELECT * FROM prompt_templates WHERE scope=$1 ORDER BY is_active DESC, updated_at DESC`
      : `SELECT * FROM prompt_templates ORDER BY is_active DESC, updated_at DESC`;
    const result = await query(sql, scope ? [scope] : []);
    return result.rows.map(mapPromptTemplateRow);
  },

  async delete(id: string): Promise<void> {
    await query(`DELETE FROM prompt_templates WHERE id=$1`, [id]);
  },
};

// Sprint 63: 跨会话上下文查询
export const SessionContextRepo = {
  /** 查询用户最近的 sessions（7天内，有过 slow 模型调用） */
  async getRecentSessions(userId: string, limit = 5): Promise<any[]> {
    const result = await query(
      `SELECT s.id, s.active_topic, s.slow_count, s.total_requests, s.turn_count,
              s.created_at, s.updated_at,
              ss.summary_text, ss.topic, ss.key_facts, ss.decisions_made, ss.open_questions
       FROM sessions s
       LEFT JOIN session_summaries ss ON ss.session_id = s.id
       WHERE s.user_id = $1 AND s.slow_count > 0
       ORDER BY s.updated_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },

  /** 查询用户所有未完成任务（跨 session） */
  async getIncompleteTasks(userId: string, limit = 5): Promise<any[]> {
    const result = await query(
      `SELECT t.id, t.title, t.mode, t.status, t.goal,
              ts.next_step, ts.blocked_by, ts.completed_steps,
              t.session_id, t.updated_at
       FROM tasks t
       LEFT JOIN task_summaries ts ON ts.task_id = t.id
       WHERE t.user_id = $1 AND t.status NOT IN ('completed', 'failed', 'cancelled')
       ORDER BY t.updated_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },

  /** 从 session_summaries 表查询关键事实 */
  async getRecentKeyFacts(userId: string, limit = 3): Promise<string[]> {
    const result = await query(
      `SELECT ss.key_facts
       FROM session_summaries ss
       WHERE ss.user_id = $1
       ORDER BY ss.created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    const facts: string[] = [];
    for (const row of result.rows) {
      const kf: string[] = row.key_facts || [];
      facts.push(...kf.slice(0, 2));
    }
    return facts.slice(0, limit);
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// Sprint 64 — Permission-Gated Worker Architecture
// ══════════════════════════════════════════════════════════════════════════════

// ── PermissionRequestRepo ──────────────────────────────────────────────────

export interface PermissionRequestInput {
  id: string;
  task_id: string;
  worker_id: string;
  user_id: string;
  session_id: string;
  field_name: string;
  field_key: string;
  purpose: string;
  value_preview?: string;
  status?: "pending" | "approved" | "denied" | "expired";
  expires_in?: number;
  approved_scope?: string;
}

export interface PermissionRequestRecord {
  id: string;
  task_id: string;
  worker_id: string;
  user_id: string;
  session_id: string;
  field_name: string;
  field_key: string;
  purpose: string;
  value_preview?: string;
  status: "pending" | "approved" | "denied" | "expired";
  expires_in: number;
  approved_scope?: string;
  created_at: string;
  resolved_at?: string;
  resolved_by?: string;
}

export const PermissionRequestRepo = {
  async create(input: PermissionRequestInput): Promise<PermissionRequestRecord> {
    const result = await query(
      `INSERT INTO permission_requests
       (id, task_id, worker_id, user_id, session_id, field_name, field_key,
        purpose, value_preview, status, expires_in, approved_scope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        input.id, input.task_id, input.worker_id, input.user_id, input.session_id,
        input.field_name, input.field_key, input.purpose,
        input.value_preview ?? null,
        input.status ?? "pending",
        input.expires_in ?? 300,
        input.approved_scope ?? null,
      ]
    );
    return result.rows[0] as PermissionRequestRecord;
  },

  async approve(id: string, resolvedBy: string, approvedScope?: string): Promise<void> {
    await query(
      `UPDATE permission_requests
       SET status='approved', resolved_at=NOW(), resolved_by=$1, approved_scope=$2
       WHERE id=$3`,
      [resolvedBy, approvedScope ?? null, id]
    );
  },

  async deny(id: string, resolvedBy: string): Promise<void> {
    await query(
      `UPDATE permission_requests
       SET status='denied', resolved_at=NOW(), resolved_by=$1
       WHERE id=$2`,
      [resolvedBy, id]
    );
  },

  async getPending(userId: string): Promise<PermissionRequestRecord[]> {
    const result = await query(
      `SELECT * FROM permission_requests
       WHERE user_id=$1 AND status='pending'
         AND created_at > NOW() - INTERVAL '5 minutes'
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows as PermissionRequestRecord[];
  },

  async getByTask(taskId: string): Promise<PermissionRequestRecord[]> {
    const result = await query(
      `SELECT * FROM permission_requests WHERE task_id=$1 ORDER BY created_at DESC`,
      [taskId]
    );
    return result.rows as PermissionRequestRecord[];
  },

  async expireOld(): Promise<void> {
    await query(
      `UPDATE permission_requests SET status='expired'
       WHERE status='pending' AND created_at < NOW() - INTERVAL '5 minutes'`
    );
  },

  async getById(id: string): Promise<PermissionRequestRecord | null> {
    const result = await query(
      `SELECT * FROM permission_requests WHERE id=$1 LIMIT 1`,
      [id]
    );
    return result.rows.length > 0 ? (result.rows[0] as PermissionRequestRecord) : null;
  },
};

// ── TaskWorkspaceRepo ──────────────────────────────────────────────────────

export interface TaskWorkspaceInput {
  id: string;
  task_id: string;
  user_id: string;
  session_id: string;
  objective: string;
  constraints?: string[];
  shared_outputs?: Record<string, unknown>;
}

export interface TaskWorkspaceRecord {
  id: string;
  task_id: string;
  user_id: string;
  session_id: string;
  objective: string;
  constraints: string[];
  shared_outputs: Record<string, unknown>;
  access_log: unknown[];
  created_at: string;
  updated_at: string;
}

export const TaskWorkspaceRepo = {
  async create(input: TaskWorkspaceInput): Promise<TaskWorkspaceRecord> {
    const result = await query(
      `INSERT INTO task_workspaces
       (id, task_id, user_id, session_id, objective, constraints, shared_outputs)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        input.id, input.task_id, input.user_id, input.session_id,
        input.objective,
        input.constraints ?? [],
        JSON.stringify(input.shared_outputs ?? {}),
      ]
    );
    return result.rows[0] as TaskWorkspaceRecord;
  },

  async getByTask(taskId: string): Promise<TaskWorkspaceRecord | null> {
    const result = await query(
      `SELECT * FROM task_workspaces WHERE task_id=$1 LIMIT 1`,
      [taskId]
    );
    return result.rows.length > 0 ? (result.rows[0] as TaskWorkspaceRecord) : null;
  },

  async getActiveByUser(userId: string, limit = 3): Promise<TaskWorkspaceRecord[]> {
    const result = await query(
      `SELECT * FROM task_workspaces WHERE user_id=$1 ORDER BY updated_at DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows as TaskWorkspaceRecord[];
  },

  async updateOutputs(taskId: string, outputs: Record<string, unknown>): Promise<void> {
    await query(
      `UPDATE task_workspaces
       SET shared_outputs = shared_outputs || $1::jsonb, updated_at = NOW()
       WHERE task_id=$2`,
      [JSON.stringify(outputs), taskId]
    );
  },

  async appendAccessLog(
    taskId: string,
    entry: { worker_id: string; action: string; keys: string[]; ts?: string }
  ): Promise<void> {
    const logEntry = { ...entry, ts: entry.ts ?? new Date().toISOString() };
    await query(
      `UPDATE task_workspaces
       SET access_log = access_log || $1::jsonb, updated_at = NOW()
       WHERE task_id=$2`,
      [JSON.stringify(logEntry), taskId]
    );
  },

  /** 获取其他 Worker 已产出的内容（排除自身 workerId） */
  async getPeerOutputs(
    taskId: string,
    excludeWorkerId?: string
  ): Promise<Record<string, unknown>> {
    const ws = await this.getByTask(taskId);
    if (!ws) return {};
    if (!excludeWorkerId) return ws.shared_outputs;
    const out = { ...ws.shared_outputs };
    delete out[excludeWorkerId];
    return out;
  },
};

// ── ScopedTokenRepo ────────────────────────────────────────────────────────

export interface ScopedTokenRecord {
  id: string;
  token: string;
  task_id: string;
  worker_id: string;
  user_id: string;
  scope: string[];
  expires_at: string;
  created_at: string;
}

export const ScopedTokenRepo = {
  async create(input: {
    id: string;
    token: string;
    task_id: string;
    worker_id: string;
    user_id: string;
    scope: string[];
    expires_at: string;
  }): Promise<ScopedTokenRecord> {
    const result = await query(
      `INSERT INTO scoped_tokens (id, token, task_id, worker_id, user_id, scope, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [input.id, input.token, input.task_id, input.worker_id,
       input.user_id, input.scope, input.expires_at]
    );
    return result.rows[0] as ScopedTokenRecord;
  },

  async validate(token: string): Promise<ScopedTokenRecord | null> {
    const result = await query(
      `SELECT * FROM scoped_tokens WHERE token=$1 AND expires_at > NOW() LIMIT 1`,
      [token]
    );
    return result.rows.length > 0 ? (result.rows[0] as ScopedTokenRecord) : null;
  },

  async revoke(token: string): Promise<void> {
    await query(`DELETE FROM scoped_tokens WHERE token=$1`, [token]);
  },

  async revokeByTask(taskId: string): Promise<void> {
    await query(`DELETE FROM scoped_tokens WHERE task_id=$1`, [taskId]);
  },

  async cleanup(): Promise<void> {
    await query(`DELETE FROM scoped_tokens WHERE expires_at < NOW()`);
  },
};
