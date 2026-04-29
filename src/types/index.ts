// SmartRouter Pro - 核心类型定义

export type IntentType =
  | "simple_qa"
  | "reasoning"
  | "creative"
  | "code"
  | "math"
  | "translation"
  | "summarization"
  | "chat"
  | "research"
  | "general"   // LLM-native routing: Fast model self-judges, no hardcoded intent
  | "unknown";

export type CompressionLevel = "L0" | "L1" | "L2" | "L3";

export type ModelRole = "fast" | "slow" | "compressor";

export type FeedbackType =
  | "accepted"
  | "regenerated"
  | "edited"
  | "thumbs_up"
  | "thumbs_down"
  | "follow_up_doubt"
  | "follow_up_thanks";

export interface InputFeatures {
  raw_query: string;
  token_count: number;
  intent: IntentType;
  complexity_score: number;
  has_code: boolean;
  has_math: boolean;
  requires_reasoning: boolean;
  conversation_depth: number;
  context_token_count: number;
  language: string;
}

export interface RoutingDecision {
  router_version: string;
  scores: { fast: number; slow: number };
  confidence: number;
  selected_model: string;
  selected_role: ModelRole;
  selection_reason: string;
  fallback_model: string;
  /** Phase 2.0: 显式路由分层（L0/L1/L2/L3） */
  routing_layer?: "L0" | "L1" | "L2" | "L3";
}

export interface CompressionDetail {
  turn_index: number;
  role: "user" | "assistant";
  action: "kept" | "summarized" | "structured" | "removed";
  original_tokens: number;
  compressed_tokens: number;
  summary?: string;
}

export interface ContextResult {
  original_tokens: number;
  compressed_tokens: number;
  compression_level: CompressionLevel;
  compression_ratio: number;
  memory_items_retrieved: number;
  final_messages: ChatMessage[];
  compression_details: CompressionDetail[];
}

export interface ExecutionResult {
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  latency_ms: number;
  did_fallback: boolean;
  fallback_reason?: string;
  response_text: string;
  quality_score?: number;
}

export interface DecisionRecord {
  id: string;
  user_id: string;
  session_id: string;
  timestamp: number;
  input_features: InputFeatures;
  routing: RoutingDecision;
  context: ContextResult;
  execution: ExecutionResult;
  feedback?: { type: FeedbackType; score: number; timestamp: number };
  learning_signal?: {
    routing_correct: boolean;
    cost_saved_vs_always_slow: number;
    quality_delta: number;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  metadata?: { tokens?: number; compressed?: boolean; original_content?: string };
  /** Tool calls emitted by the model (assistant messages with Function Calling) */
  tool_calls?: ToolCall[];
  /** ID of the tool call this message is responding to (tool messages only) */
  tool_call_id?: string;
  /** P4: ID of the routing DecisionRecord this message is responding to, used for implicit feedback detection */
  decision_id?: string;
}

export interface ChatRequest {
  user_id: string;
  session_id: string;
  message: string;
  history: ChatMessage[];
  preferences?: { mode: "quality" | "balanced" | "cost"; compression_level?: CompressionLevel };
  /** 前端设置透传：可覆盖后端环境变量 */
  api_key?: string;
  /** 前端设置透传：LLM API Base URL（Sprint 72 reqBaseUrl 透传） */
  llm_base_url?: string;
  fast_model?: string;
  slow_model?: string;
  /** EL-003: If true, route this request through TaskPlanner + ExecutionLoop (multi-step execution). */
  execute?: boolean;
  /** T1: Explicit task resumption. If provided, system validates ownership and resumes the task. */
  task_id?: string;
  /** S1: If true, return SSE stream instead of a single JSON response. */
  stream?: boolean;
  /** Phase 3.0: If true, use LLM-Native Manager-Worker routing instead of orchestrator. */
  use_llm_native_routing?: boolean;
}

export interface ChatResponse {
  message: string;
  decision: DecisionRecord;
  /** T1: The task_id associated with this response. Present when a task was created or resumed. */
  task_id?: string;
  /**
   * O-001/O-006: Delegation info — present when slow model is triggered in background.
   * The fast model gives an immediate acknowledgment; the slow result comes via polling
   * as a separate message (wrapped by the fast model with its humanized prompt).
   */
  delegation?: {
    task_id: string;
    status: "triggered";
  };
  /** Phase 3.0: Clarifying info — present when Manager requests user clarification. */
  clarifying?: ClarifyQuestion;
}

export interface IdentityMemory {
  user_id: string;
  response_style: "concise" | "detailed" | "balanced";
  expertise_level: "beginner" | "intermediate" | "expert";
  domains: string[];
  quality_sensitivity: number;
  cost_sensitivity: number;
  preferred_fast_model: string;
  preferred_slow_model: string;
  updated_at: number;
}

export interface BehavioralMemory {
  id: string;
  user_id: string;
  trigger_pattern: string;
  observation: string;
  learned_action: string;
  strength: number;
  reinforcement_count: number;
  last_activated: number;
  source_decision_ids: string[];
  created_at: number;
}

export interface GrowthProfile {
  user_id: string;
  level: number;
  level_name: string;
  level_progress: number;
  /** @deprecated Use satisfaction_rate. This field previously reflected fake routing_correct data. */
  routing_accuracy: number;
  /**
   * Daily satisfaction rate history (positive feedback / all feedback).
   * Renamed from routing_accuracy_history which was based on routing_correct = always-null.
   */
  satisfaction_history: { date: string; value: number }[];
  cost_saving_rate: number;
  total_saved_usd: number;
  satisfaction_rate: number;
  total_interactions: number;
  behavioral_memories_count: number;
  milestones: { date: string; event: string }[];
  recent_learnings: { date: string; learning: string }[];
}

export interface DashboardData {
  today: {
    total_requests: number;
    fast_count: number;
    slow_count: number;
    fallback_count: number;
    total_tokens: number;
    total_cost: number;
    saved_cost: number;
    saving_rate: number;
    avg_latency_ms: number;
    /**
     * Proxy metric for routing quality: satisfaction rate (positive feedback / all feedback).
     * Renamed from routing_accuracy which was a pseudo-metric backed by always-null routing_correct.
     */
    satisfaction_proxy: number;
  };
  token_flow: { fast_tokens: number; slow_tokens: number; compressed_tokens: number; fallback_tokens: number };
  recent_decisions: DecisionRecord[];
  growth: GrowthProfile;
}

export interface ModelPricing {
  model: string;
  input_per_1k: number;
  output_per_1k: number;
}

// ── Task entities ───────────────────────────────────────────────────────────

export type TaskMode = "direct" | "research" | "execute";
export type TaskStatus = "pending" | "running" | "waiting_subagent" | "completed" | "failed" | "blocked";
export type ComplexityLevel = "low" | "medium" | "high";
export type RiskLevel = "low" | "medium" | "high";

export interface Task {
  task_id: string;
  user_id: string;
  session_id: string;
  title: string;
  mode: TaskMode;
  status: TaskStatus;
  complexity: ComplexityLevel;
  risk: RiskLevel;
  goal: string | null;
  budget_profile: Record<string, any>;
  tokens_used: number;
  tool_calls_used: number;
  steps_used: number;
  summary_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskListItem {
  task_id: string;
  title: string;
  mode: TaskMode;
  status: TaskStatus;
  complexity: ComplexityLevel;
  risk: RiskLevel;
  updated_at: string;
  session_id: string;
}

export interface TaskSummary {
  task_id: string;
  summary_id: string;
  goal: string | null;
  confirmed_facts: string[];
  completed_steps: string[];
  blocked_by: string[];
  next_step: string | null;
  summary_text: string | null;
  version: number;
  updated_at: string;
}

export type TraceType =
  | "classification"
  | "routing"
  | "response"
  | "planning"
  | "guardrail"
  | "step_start"
  | "step_complete"
  | "step_failed"
  | "loop_start"
  | "loop_end"
  | "error"
  // O-001: Orchestrator trace types
  | "orchestrator_delegated"
  | "orchestrator_delegation_failed";

export interface TaskTrace {
  trace_id: string;
  task_id: string;
  type: TraceType;
  detail: Record<string, any> | null;
  created_at: string;
}

/** Human-readable summary of a trace */
export interface TraceSummary {
  trace_id: string;
  type: TraceType;
  summary: string;
  created_at: string;
}

// ── Memory entries (MC-001) ──────────────────────────────────────────────────

export type MemoryCategory = "preference" | "fact" | "context" | "instruction" | "skill" | "behavioral";
export type MemorySource = "manual" | "extracted" | "feedback" | "auto_learn";

export interface MemoryEntry {
  id: string;
  user_id: string;
  category: MemoryCategory;
  content: string;
  importance: number;   // 1–5
  tags: string[];
  source: MemorySource;
  relevance_score: number; // 0.0–1.0, defaults to 0.5
  created_at: string;   // ISO 8601 string (outward API)
  updated_at: string;
}

export interface MemoryEntryInput {
  user_id: string;
  category: MemoryCategory;
  content: string;
  importance?: number;   // defaults to 3
  tags?: string[];
  source?: MemorySource;
  relevance_score?: number; // defaults based on source (manual=0.5, auto_learn=0.3)
}

export interface MemoryEntryUpdate {
  content?: string;
  importance?: number;
  tags?: string[];
  category?: MemoryCategory;
}

// ── Memory Retrieval (MR-001) ────────────────────────────────────────────────

/**
 * Context signal passed into the retrieval pipeline.
 * Currently lightweight: userMessage for keyword extraction,
 * with room to extend to embeddings or topic signals in MR-003.
 */
export interface MemoryRetrievalContext {
  /** The raw user message from the chat request */
  userMessage: string;
  /** Optional explicit keyword signals for retrieval (MR-003 may auto-extract) */
  keywords?: string[];
}

/**
 * A memory entry with a computed retrieval score and human-readable reason.
 * Used by the v2 retrieval pipeline.
 */
export interface MemoryRetrievalResult {
  entry: MemoryEntry;
  /** Composite score (higher = more relevant). Range not normalized. */
  score: number;
  /** Plain-language reason for the score, useful for debugging */
  reason: string;
}

/**
 * Per-category injection policy for the retrieval pipeline.
 * Controls which memories are eligible for injection based on category.
 */
export interface MemoryCategoryPolicy {
  /** Minimum importance level required for this category to be injected (1–5) */
  minImportance: number;
  /** If true, inject up to `maxCount` memories from this category regardless of score */
  alwaysInject: boolean;
  /** Max number of entries to inject from this category (default: 2) */
  maxCount?: number;
}

// ── Evidence System (Layer 6 / E1) ─────────────────────────────────────────

/** Source of an evidence record — the retrieval method that produced it */
export type EvidenceSource = "web_search" | "http_request" | "manual";

export interface Evidence {
  evidence_id: string;
  task_id: string;
  user_id: string;
  source: EvidenceSource;
  content: string;
  source_metadata: Record<string, unknown> | null;
  relevance_score: number | null;
  created_at: string;  // ISO 8601 string (outward API)
}

export interface EvidenceInput {
  task_id: string;
  user_id: string;
  source: EvidenceSource;
  content: string;
  source_metadata?: Record<string, unknown>;
  relevance_score?: number;
}

// ── Tool System (EL-001) ────────────────────────────────────────────────────

export type ToolScope = "internal" | "external";

export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required: boolean;
  enum?: string[];
}

/**
 * Tool definition — the contract between the model and the execution layer.
 * Used for both Function Calling schema injection and lightweight parse validation.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  scope: ToolScope;
}

/**
 * A tool invocation issued by the model.
 */
export interface ToolCall {
  id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

/**
 * Result of executing a single tool call.
 */
export interface ToolResult {
  call_id: string;
  tool_name: string;
  success: boolean;
  result: unknown;
  error?: string;
  latency_ms: number;
}

// ── Execution Plan (EL-002 / EL-003) ──────────────────────────────────────

export type StepType = "reasoning" | "tool_call" | "synthesis" | "unknown";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "blocked";

export interface ExecutionStep {
  id: string;
  title: string;
  type: StepType;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  depends_on: string[];
  status: StepStatus;
  result?: unknown;
  error?: string;
  /** Optional longer description for step context (e.g. system-prompt generation) */
  description?: string;
}

/**
 * A full execution plan produced by the planner.
 */
export interface ExecutionPlan {
  task_id: string;
  steps: ExecutionStep[];
  current_step_index: number;
}

// ── Execution Result Persistence (ER-002) ────────────────────────────────────

/** Lightweight summary of one execution step (written to execution_results.steps_summary) */
export interface ExecutionStepSummary {
  index: number;
  title: string;
  type: StepType;
  status: "pending" | "in_progress" | "completed" | "failed";
  tool_name?: string;
  error?: string;
}

/** steps_summary JSONB shape stored in execution_results */
export interface ExecutionStepsSummary {
  totalSteps: number;
  completedSteps: number;
  toolCallsExecuted: number;
  steps: ExecutionStepSummary[];
}

/** A completed execution result record */
export interface ExecutionResultRecord {
  id: string;
  task_id: string | null;
  user_id: string;
  session_id: string;
  final_content: string | null;
  steps_summary: ExecutionStepsSummary | null;
  memory_entries_used: string[];
  model_used: string | null;
  tool_count: number;
  duration_ms: number | null;
  reason: string | null;
  created_at: string;
}

/** Input for saving a new execution result */
export interface ExecutionResultInput {
  task_id: string | null;
  user_id: string;
  session_id: string;
  final_content: string;
  steps_summary: ExecutionStepsSummary;
  memory_entries_used?: string[];
  model_used?: string;
  tool_count: number;
  duration_ms?: number;
  reason: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// Phase 3.0: Manager-Worker Runtime
// ══════════════════════════════════════════════════════════════════════════════

// ── ManagerDecision ────────────────────────────────────────────────────────────

/**
 * ManagerDecision — Phase 3.0 Fast Manager 的标准输出协议。
 * 职责：只表达"下一步怎么做"，不包含最终回答内容本身。
 * 流转：Fast Model → Runtime Orchestrator → 各 Worker / Archive
 */
export interface ManagerDecision {
  /** Schema 版本，用于协议演进校验 */
  schema_version: "manager_decision_v1";
  /** 决策类型：Fast Manager 决定的下一步处理路径 */
  decision_type: ManagerDecisionType;
  /** 兼容现有前端/评测体系，与 decision_type 存在逻辑映射 */
  routing_layer: RoutingLayer;
  /** 决策原因，供日志/trace/debug 使用 */
  reason: string;
  /** 决策置信度 0.0 ~ 1.0 */
  confidence: number;
  /** 是否需要写入/更新 Task Archive */
  needs_archive: boolean;
  /** direct_answer 时的回复草稿 */
  direct_response?: DirectResponse;
  /** ask_clarification 时的澄清问题 */
  clarification?: ClarifyQuestion;
  /** delegate_to_slow / execute_task 时的结构化命令 */
  command?: CommandPayload;
}

// ── Gating: Decision Features (G1) ────────────────────────────────────────────

/**
 * DecisionFeatures — 结构化特征标签，供 system_confidence 计算和 Policy Gate 使用。
 * 由 Manager LLM 在 G1 阶段输出。
 */
export interface DecisionFeatures {
  /** 请求缺少关键信息（目标/范围/格式不明确） */
  missing_info: boolean;
  /** 需要长链推理或多步分析 */
  needs_long_reasoning: boolean;
  /** 需要外部工具（web_search/http_request/代码执行）*/
  needs_external_tool: boolean;
  /** 涉及高风险操作（金融/医疗/安全） */
  high_risk_action: boolean;
  /** 请求过于模糊，无法直接处理 */
  query_too_vague: boolean;
  /** 需要多步骤操作或跨文件处理 */
  requires_multi_step: boolean;
  /** 引用了之前的对话或任务（继续/接着上次的/补充完整） */
  is_continuation: boolean;
}

// ── Gating: Policy Override (G2) ───────────────────────────────────────────────

/**
 * PolicyOverride — G2 Policy-Calibrated Gate 对某个动作的修正记录。
 */
export interface PolicyOverride {
  /** 规则名称 */
  rule: string;
  /** 修正类型 */
  action: "penalize" | "block" | "boost" | "force";
  /** 被修正的动作 */
  target: ManagerDecisionType;
  /** 修正前分数 */
  original_score: number;
  /** 修正后分数 */
  adjusted_score: number;
  /** 修正原因 */
  reason: string;
}

// ── Gating: GatingConfig ───────────────────────────────────────────────────────

/**
 * GatingConfig — G2 Policy Gate 的可配置参数。
 * 所有阈值/权重可通过 config.ts 覆盖，不写死在代码里。
 */
export interface GatingConfig {
  /** 各动作基础阈值（低于阈值则该动作不可选） */
  thresholds: {
    direct_answer: number;
    ask_clarification: number;
    delegate_to_slow: number;
    execute_task: number;
  };
  /** Clarification 体验成本惩罚权重（降低其 effective score）*/
  clarification_cost_weight: number;
  /** Rerank 触发阈值 */
  rerank: {
    /** top1 - top2 差值小于此值时触发 rerank */
    top_gap_threshold: number;
    /** system_confidence 低于此值时触发 rerank */
    confidence_threshold: number;
    /** 高成本动作在此 confidence 以下触发 rerank */
    high_cost_confidence_floor: number;
  };
  /** 成本惩罚系数 */
  cost_penalty: {
    /** 每 1000 token 额外惩罚系数 */
    delegate_token_penalty: number;
    /** 每 10s latency 额外惩罚系数 */
    latency_penalty: number;
  };
}

// ── Knowledge Boundary Signals (KB-1) ─────────────────────────────────────────

/**
 * KnowledgeBoundarySignalType — 知识边界信号类型。
 *
 * 【设计原则】
 * - 这是信号，不是动作指令
 * - 不直接决定路由，只供 G1/G2/G3 校准使用
 * - 不做 pattern → action 的硬映射
 */
export type KnowledgeBoundarySignalType =
  /** 依赖当前外部事实，而非参数内稳定知识 */
  | "realtime_external_fact"
  /** 依赖当前运行环境才能回答的事实（如今天星期几、现在几点） */
  | "current_environment_fact"
  /** 明确涉及模型训练截止日期之后的事件 */
  | "post_training_event"
  /** 实时天气、温度、降雨、空气质量 */
  | "live_weather_data"
  /** 实时股价、汇率、指数、成交、涨跌 */
  | "live_market_data"
  /** 最新新闻、今日头条、刚发生的事件 */
  | "live_news_data"
  /** 比赛比分、赛果、排名变化 */
  | "live_result_or_score"
  /** 强依赖"今天/现在/最新/本周"等时间语的公共事实 */
  | "time_sensitive_public_fact";

/**
 * KnowledgeBoundarySignal — 知识边界信号输出。
 *
 * 由 detectKnowledgeBoundarySignals() 生成，供 G1/G2/G3 校准使用。
 * 不做动作决定，只做知识边界标记和强度评估。
 */
export interface KnowledgeBoundarySignal {
  /** 规则唯一标识（用于 trace/benchmark/调试） */
  id: string;
  /** 信号类型 */
  type: KnowledgeBoundarySignalType;
  /**
   * 命中强度（0~1）。
   * 表示"系统对该请求命中知识边界的确信程度"，不是动作置信度。
   */
  strength: number;
  /** 命中原因描述（用于 trace/debug） */
  reasons: string[];
  /** 命中的 pattern 片段（用于解释性复盘） */
  matched_patterns: string[];
}

/**
 * KnowledgeBoundaryContext — 信号检测的输入上下文（第一版只依赖 message）。
 */
export interface KnowledgeBoundaryContext {
  locale?: string;
  now?: string;
}

// ── G4: Delegation Learning Loop ────────────────────────────────────────────────

/**
 * DelegationLog — Gated Delegation v2 的完整决策事实表。
 *
 * 记录每个委托决策的完整生命周期：
 * G0(LLM原始输出) → G1(系统置信度) → G2(Policy校准) → G3(Rerank) → 执行结果
 *
 * 用于：离线分析、benchmark 改进、用户层面行为学习。
 * 注意：执行结果字段在请求完成前为 NULL，通过 async writeback 填充。
 */
export interface DelegationLog {
  id: string;
  user_id: string;
  session_id: string;
  turn_id: number;
  task_id?: string;
  routing_version: string;

  // G0: LLM 原始输出
  llm_scores: Record<ManagerDecisionType, number>;
  llm_confidence: number;

  // G1: System Confidence
  system_confidence: number;

  // G2: Policy Calibration
  calibrated_scores: Record<ManagerDecisionType, number>;
  policy_overrides: PolicyOverride[];
  g2_final_action: ManagerDecisionType;

  // G3: Rerank
  did_rerank: boolean;
  rerank_gap?: number;
  rerank_rules: string[];
  g3_final_action?: ManagerDecisionType;

  // 最终路由决策
  routed_action: ManagerDecisionType;
  routing_reason?: string;
  // Sprint 68: 显式路由层（L0/L1/L2/L3），用于分层监控和 L2 灰度分析
  routing_layer?: RoutingLayer;

  // 执行结果（异步回写）
  execution_status?: "pending" | "success" | "failed" | "timeout";
  execution_correct?: boolean;
  error_message?: string;
  model_used?: string;
  latency_ms?: number;
  cost_usd?: number;

  // G4: 四层成功标准（异步回填，不阻塞主流程）
  // routing_success: manager 是否选对了动作（benchmark 离线分析后回填）
  routing_success?: boolean;
  // value_success: Worker 产出比 Fast 直答是否有增益（Fast/Slow 双跑对比分析后回填）
  value_success?: "better" | "same" | "worse";
  // user_success: 用户是否未追问/未改写（同 session 后续 turn 分析后回填）
  user_success?: boolean;

  created_at: string;
  executed_at?: string;
}

/** DelegationLog 写入输入（不含 generated 字段） */
export interface DelegationLogInput {
  /** 可选：外部指定 UUID（用于 G4-C 异步回写，传入后 save() 使用该 ID 而非重新生成） */
  id?: string;
  user_id: string;
  session_id: string;
  turn_id: number;
  task_id?: string;
  routing_version?: string;
  llm_scores: Record<ManagerDecisionType, number>;
  llm_confidence: number;
  system_confidence: number;
  calibrated_scores: Record<ManagerDecisionType, number>;
  policy_overrides: PolicyOverride[];
  g2_final_action: ManagerDecisionType;
  did_rerank: boolean;
  rerank_gap?: number;
  rerank_rules: string[];
  g3_final_action?: ManagerDecisionType;
  routed_action: ManagerDecisionType;
  routing_reason?: string;
  // Sprint 68: 显式路由层（L0/L1/L2/L3），用于分层监控和 L2 灰度分析
  routing_layer?: RoutingLayer;

  // G4: 四层成功标准（异步回填，首次写入时为空）
  routing_success?: boolean;
  value_success?: "better" | "same" | "worse";
  user_success?: boolean;
}

/** DelegationLog 执行结果回写 */
export interface DelegationLogExecutionUpdate {
  execution_status: "success" | "failed" | "timeout";
  execution_correct?: boolean;
  error_message?: string;
  model_used?: string;
  latency_ms?: number;
  cost_usd?: number;
  // G4: 四层成功标准（异步回填）
  routing_success?: boolean;
  value_success?: "better" | "same" | "worse";
  user_success?: boolean;
}

/** 决策类型枚举（Phase 0 精简版，4 种） */
export type ManagerDecisionType =
  | "direct_answer"
  | "ask_clarification"
  | "delegate_to_slow"
  | "execute_task";

/** 路由层（兼容现有 L0/L1/L2/L3） */
export type RoutingLayer = "L0" | "L1" | "L2" | "L3";

/** decision_type ↔ routing_layer 默认映射表 */
export const DECISION_TO_LAYER: Record<ManagerDecisionType, RoutingLayer> = {
  direct_answer: "L0",
  ask_clarification: "L0",
  delegate_to_slow: "L2",
  execute_task: "L3",
};

/** 路由层 → decision_type 反向映射（用于旧 router fallback） */
export const LAYER_TO_DECISION: Record<RoutingLayer, ManagerDecisionType> = {
  L0: "direct_answer",
  L1: "direct_answer",
  L2: "delegate_to_slow",
  L3: "execute_task",
};

// ── DirectResponse ─────────────────────────────────────────────────────────────

/** Fast Manager 直接回答时的回复草稿。仅当 decision_type = "direct_answer" 时出现。 */
export interface DirectResponse {
  style: "concise" | "natural" | "structured";
  content: string;
  max_tokens_hint?: number;
}

// ── ClarifyQuestion（复用 Phase 1.5）──────────────────────────────────────────

/** 澄清问题结构，与 Phase 1.5 Clarifying 完全对齐。 */
export interface ClarifyQuestion {
  question_id: string;
  question_text: string;
  options?: ClarifyOption[];
  allow_free_text?: boolean;
  clarification_reason: string;
  missing_fields?: string[];
}

export interface ClarifyOption {
  label: string;
  value: string;
}

// ── CommandPayload ─────────────────────────────────────────────────────────────

/** Manager → Worker 的结构化任务命令。仅当 decision_type = "delegate_to_slow" 或 "execute_task" 时出现。 */
export interface CommandPayload {
  /** 命令类型（Phase 0 精简版，4 种） */
  command_type: CommandType;
  /** 任务类型描述 */
  task_type: string;
  /** Manager 压缩后的任务摘要 */
  task_brief: string;
  /** 最终目标 */
  goal: string;
  /** 约束条件列表 */
  constraints?: string[];
  /** 输入材料引用 */
  input_materials?: InputMaterial[];
  /** 输出格式要求 */
  required_output?: RequiredOutput;
  /** 允许使用的工具列表（execute_task 时必填） */
  tools_allowed?: string[];
  /** 优先级 */
  priority?: "low" | "normal" | "high";
  /** 超时秒数建议 */
  timeout_sec?: number;
  /** Worker 类型提示 */
  worker_hint?: WorkerHint;
}

/** 命令类型枚举（Phase 0 精简版，4 种） */
export type CommandType =
  | "delegate_analysis"
  | "delegate_summarization"
  | "execute_plan"
  | "execute_research";

/** Worker 类型提示 */
export type WorkerHint =
  | "slow_analyst"
  | "execute_worker"
  | "search_worker";

// ── InputMaterial ──────────────────────────────────────────────────────────────

/** Command 的输入材料。 */
export interface InputMaterial {
  type: InputMaterialType;
  content?: string;
  ref_id?: string;
  title?: string;
  importance?: number;
}

export type InputMaterialType =
  | "user_query"
  | "excerpt"
  | "evidence_ref"
  | "memory_ref"
  | "archive_fact";

// ── RequiredOutput ─────────────────────────────────────────────────────────────

/** Manager 对 Worker 产出的格式要求。 */
export interface RequiredOutput {
  format: OutputFormat;
  sections?: string[];
  must_include?: string[];
  max_points?: number;
  tone?: "neutral" | "professional" | "concise";
}

export type OutputFormat =
  | "structured_analysis"
  | "bullet_summary"
  | "answer"
  | "json";

// ── WorkerResult ───────────────────────────────────────────────────────────────

/** Worker → Manager 的结构化结果。Worker 完成后写入 Archive，Manager 读取后统一对外表达。 */
export interface WorkerResult {
  task_id: string;
  worker_type: WorkerHint;
  status: WorkerResultStatus;
  summary: string;
  structured_result: Record<string, unknown>;
  confidence: number;
  ask_for_more_context?: string[];
  error_message?: string;
  /** Worker 执行过程详情（由 worker-prompt.ts parseWorkerResult 填充） */
  execution_details?: {
    steps_taken?: string[];
    sources_used?: string[];
    errors_encountered?: string[];
  };
}

export type WorkerResultStatus =
  | "completed"
  | "partial"
  | "failed"
  | "needs_clarification";

// ── ajv 简化校验 Schema ────────────────────────────────────────────────────────

/**
 * ajv 运行时校验用简化 JSON Schema。
 * 用法：ajv.addSchema(managerDecisionJsonSchema, 'ManagerDecision')
 */
export const managerDecisionJsonSchema = {
  $id: "https://smartrouter.pro/schemas/manager-decision-v1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "decision_type",
    "routing_layer",
    "reason",
    "confidence",
    "needs_archive",
  ],
  properties: {
    schema_version: { type: "string", const: "manager_decision_v1" },
    decision_type: {
      type: "string",
      enum: ["direct_answer", "ask_clarification", "delegate_to_slow", "execute_task"],
    },
    routing_layer: { type: "string", enum: ["L0", "L1", "L2", "L3"] },
    reason: { type: "string", minLength: 1, maxLength: 300 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    needs_archive: { type: "boolean" },
    direct_response: {
      type: "object",
      additionalProperties: false,
      required: ["style", "content"],
      properties: {
        style: { type: "string", enum: ["concise", "natural", "structured"] },
        content: { type: "string", minLength: 1, maxLength: 2000 },
        max_tokens_hint: { type: "integer", minimum: 1, maximum: 2000 },
      },
    },
    clarification: {
      type: "object",
      additionalProperties: false,
      required: ["question_id", "question_text", "clarification_reason"],
      properties: {
        question_id: { type: "string", minLength: 1, maxLength: 100 },
        question_text: { type: "string", minLength: 1, maxLength: 500 },
        options: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "value"],
            properties: {
              label: { type: "string", minLength: 1, maxLength: 200 },
              value: { type: "string", minLength: 1, maxLength: 100 },
            },
          },
          maxItems: 10,
        },
        allow_free_text: { type: "boolean" },
        clarification_reason: { type: "string", minLength: 1, maxLength: 300 },
        missing_fields: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
        },
      },
    },
    command: {
      type: "object",
      additionalProperties: false,
      required: ["command_type", "task_type", "task_brief", "goal"],
      properties: {
        command_type: {
          type: "string",
          enum: ["delegate_analysis", "delegate_summarization", "execute_plan", "execute_research"],
        },
        task_type: { type: "string", minLength: 1, maxLength: 100 },
        task_brief: { type: "string", minLength: 1, maxLength: 4000 },
        goal: { type: "string", minLength: 1, maxLength: 1000 },
        constraints: {
          type: "array",
          items: { type: "string", maxLength: 300 },
          maxItems: 20,
        },
        input_materials: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: {
              type: {
                type: "string",
                enum: ["user_query", "excerpt", "evidence_ref", "memory_ref", "archive_fact"],
              },
              content: { type: "string", maxLength: 4000 },
              ref_id: { type: "string", maxLength: 100 },
              title: { type: "string", maxLength: 200 },
              importance: { type: "number", minimum: 0, maximum: 1 },
            },
          },
          maxItems: 30,
        },
        required_output: {
          type: "object",
          additionalProperties: false,
          properties: {
            format: {
              type: "string",
              enum: ["structured_analysis", "bullet_summary", "answer", "json"],
            },
            sections: { type: "array", items: { type: "string" }, maxItems: 20 },
            must_include: { type: "array", items: { type: "string" }, maxItems: 20 },
            max_points: { type: "integer", minimum: 1, maximum: 20 },
            tone: { type: "string", enum: ["neutral", "professional", "concise"] },
          },
        },
        tools_allowed: { type: "array", items: { type: "string" }, maxItems: 20 },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        timeout_sec: { type: "integer", minimum: 1, maximum: 3600 },
        worker_hint: { type: "string", enum: ["slow_analyst", "execute_worker", "search_worker"] },
      },
    },
  },
  allOf: [
    {
      if: { properties: { decision_type: { const: "direct_answer" } } },
      then: { required: ["direct_response"] },
    },
    {
      if: { properties: { decision_type: { const: "ask_clarification" } } },
      then: { required: ["clarification"] },
    },
    {
      if: { properties: { decision_type: { enum: ["delegate_to_slow", "execute_task"] } } },
      then: { required: ["command"] },
    },
  ],
};

// ── SSE Phase 3.0 事件 ────────────────────────────────────────────────────────

export type SSEEventTypePhase3 =
  | "manager_decision"
  | "clarifying_needed"
  | "command_issued"
  | "archive_written"     // Phase 3.0: Archive 已写入（来自 task_archive_events.archive_created）
  | "worker_started"     // Phase 3.0: Worker 开始执行
  | "worker_progress"    // Phase 3.0: Worker 执行中（进度报告）
  | "worker_completed"   // Phase 3.0: Worker 执行完成
  | "manager_synthesized" // Phase 3.0: Manager 合成最终输出
  | "done"               // SSE 流结束信号（所有路径统一发送）
  | "result"             // 文本结果（慢模型直出）
  | "error"              // 错误事件
  | "status"             // 状态消息（安抚/进度）
  | "chunk"              // 流式文本块
  | "fast_reply";        // Fast 模型直接回复

export interface SSEManagerDecisionEvent {
  type: "manager_decision";
  decision: ManagerDecision;
  timestamp: string;
}

export interface SSECommandIssuedEvent {
  type: "command_issued";
  command_id: string;
  delegated_to: WorkerHint;
  task_id: string;
  timestamp: string;
}

/** Phase 3.0: task_archives 写入完成（来自 task_archive_events.archive_created） */
export interface SSEArchiveWrittenEvent {
  type: "archive_written";
  task_id: string;
  archive_id: string;
  decision_type: string;
  routing_layer: string;
  timestamp: string;
}

/** Phase 3.0: Worker 开始执行（来自 task_archive_events.worker_started） */
export interface SSEWorkerStartedEvent {
  type: "worker_started";
  task_id: string;
  command_id: string;
  worker_role: string;
  routing_layer: string;
  timestamp: string;
}

export interface SSEWorkerCompletedEvent {
  type: "worker_completed";
  task_id: string;
  command_id: string;
  worker_type: WorkerHint;
  summary: string;
  timestamp: string;
}

/** Phase 3.0: Manager 合成最终输出（来自 task_archive_events.manager_synthesized） */
export interface SSEManagerSynthesizedEvent {
  type: "manager_synthesized";
  task_id: string;
  final_content: string;
  confidence: number;
  routing_layer: string;
  timestamp: string;
}

/** SSE done 事件 — 统一流结束信号（Fast直答 / Delegation成功 / Delegation失败 / 超时均发送） */
export interface SSEDoneEvent {
  type: "done";
  /** 可选的状态文本（如 "分析完成" / "已返回答案"） */
  stream?: string;
  routing_layer?: RoutingLayer;
  archive_id?: string;
  task_id?: string;
}

/** SSE result 事件 — 慢模型文本结果 */
export interface SSEResultEvent {
  type: "result";
  stream: string;
  routing_layer?: RoutingLayer;
}

/** SSE error 事件 — 错误通知 */
export interface SSEErrorEvent {
  type: "error";
  stream?: string;
  routing_layer?: RoutingLayer;
}

/** SSE status 事件 — 安抚/进度消息 */
export interface SSEStatusEvent {
  type: "status";
  stream: string;
  routing_layer?: RoutingLayer;
}

// ── Task Archive Repository Types ─────────────────────────────────────────────

/** task_archives 表记录（Phase 3.0 扩展版） */
export interface TaskArchiveRecord {
  id: string;
  session_id: string;
  turn_id: number;
  command: Record<string, unknown> | null;
  user_input: string;
  constraints: string[];
  task_type: string;
  task_brief: Record<string, unknown> | null;
  /** Phase 3.0: Manager 决策 JSONB */
  manager_decision: Record<string, unknown> | null;
  fast_observations: Record<string, unknown>[];
  slow_execution: Record<string, unknown> | null;
  state: string;
  status: string;
  delivered: boolean;
  created_at: string;
  updated_at: string;
}

/** task_commands 表记录（Phase 3.0 新表） */
export interface TaskCommandRecord {
  id: string;
  task_id: string;
  archive_id: string;
  user_id: string;
  issuer_role: string;
  command_type: string;
  worker_hint: string | null;
  priority: string;
  status: CommandStatus;
  payload_json: CommandPayload;
  idempotency_key: string | null;
  timeout_sec: number | null;
  issued_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

export type CommandStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** task_worker_results 表记录（Phase 3.0 新表） */
export interface TaskWorkerResultRecord {
  id: string;
  task_id: string;
  archive_id: string;
  command_id: string;
  user_id: string;
  worker_role: string;
  result_type: string;
  status: string;
  summary: string;
  result_json: Record<string, unknown>;
  confidence: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_usd: number | null;
  started_at: string | null;
  completed_at: string;
  error_message: string | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Phase 4.1: Data Classification + Permission Layer
// ══════════════════════════════════════════════════════════════════════════════

// ── 数据分类枚举 ─────────────────────────────────────────────────────────────

/**
 * 数据分类级别 — 控制数据暴露范围。
 * 用于 Permission Layer 做暴露决策。
 */
export enum DataClassification {
  /** 仅本地小模型可见，不暴露给云端 */
  LOCAL_ONLY = "local_only",
  /** 可生成摘要后暴露（摘要由本地小模型生成） */
  LOCAL_SUMMARY_SHAREABLE = "local_summary_shareable",
  /** 可直接发送给云端模型 */
  CLOUD_ALLOWED = "cloud_allowed",
}

// ── 分类上下文 ────────────────────────────────────────────────────────────────

/** 数据类型来源 */
export type DataSource = "user" | "system" | "third_party";

/** 数据敏感级别 */
export type SensitivityLevel = "public" | "internal" | "confidential" | "secret";

/**
 * 分类上下文 — 用于 DataClassifier 决定数据的分类级别。
 */
export interface ClassificationContext {
  /** 数据类型 */
  dataType:
    | "conversation_history"
    | "task_archive"
    | "memory"
    | "tool_result"
    | "user_profile"
    | "web_content"
    | "api_response";
  /** 敏感级别 */
  sensitivity: SensitivityLevel;
  /** 数据来源 */
  source: DataSource;
  /** 是否包含 PII（个人身份信息） */
  hasPII: boolean;
  /** 数据年龄（小时），用于动态调整分类 */
  ageHours?: number;
  /** 用户是否明确标记为敏感 */
  userMarkedSensitive?: boolean;
}

// ── 数据分类结果 ──────────────────────────────────────────────────────────────

/**
 * 分类结果 — DataClassifier.classify() 的返回值。
 */
export interface ClassificationResult {
  /** 分类级别 */
  classification: DataClassification;
  /** 分类原因 */
  reason: string;
  /** 置信度 0.0 ~ 1.0 */
  confidence: number;
  /** 是否有 PII */
  hasPII: boolean;
  /** 建议的处理方式 */
  suggestedHandling: "expose" | "summarize" | "redact" | "block";
}

// ── 权限上下文 ────────────────────────────────────────────────────────────────

/**
 * 权限校验上下文 — 用于 PermissionChecker 决定是否允许暴露。
 */
export interface PermissionContext {
  /** Session ID */
  sessionId: string;
  /** User ID */
  userId: string;
  /** 请求的暴露级别 */
  requestedTier: DataClassification;
  /** Feature Flags */
  featureFlags: Record<string, boolean>;
  /** 用户配置的数据偏好 */
  userDataPreferences?: UserDataPreferences;
  /** 目标模型类型 */
  targetModel: "local_7b" | "cloud_72b" | "unknown";
}

/** 用户数据偏好配置 */
export interface UserDataPreferences {
  /** 是否允许云端访问对话历史 */
  allowCloudConversationHistory?: boolean;
  /** 是否允许云端访问记忆 */
  allowCloudMemory?: boolean;
  /** 是否允许云端访问工具结果 */
  allowCloudToolResults?: boolean;
  /** 额外允许暴露的数据类型 */
  extraAllowedTypes?: string[];
  /** 额外禁止暴露的数据类型 */
  extraBlockedTypes?: string[];
}

// ── 权限校验结果 ──────────────────────────────────────────────────────────────

/** 权限校验结果 */
export interface PermissionResult {
  /** 是否允许暴露 */
  allowed: boolean;
  /** 最终允许的分类级别（可能与 requestedTier 不同） */
  tier: DataClassification;
  /** 原因说明 */
  reason?: string;
  /** 降级处理建议 */
  fallbackAction?: "reject" | "summarize" | "redact" | "allow";
  /** 需要执行的脱敏规则 ID 列表 */
  redactionRuleIds?: string[];
  /** 需要摘要的长度上限 */
  summaryMaxLength?: number;
}

// ── 数据暴露决策记录 ──────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// Phase 4.2: Data Redaction Engine
// ══════════════════════════════════════════════════════════════════════════════

// ── 脱敏动作类型 ─────────────────────────────────────────────────────────────

/**
 * 脱敏动作类型
 */
export enum RedactionAction {
  /** 用脱敏字符替换（如 138****5678） */
  MASK = "mask",
  /** 哈希处理（不可逆） */
  HASH = "hash",
  /** 截断处理 */
  TRUNCATE = "truncate",
  /** 替换为指定文本 */
  REPLACE = "replace",
  /** 完全移除字段 */
  REMOVE = "remove",
}

// ── 脱敏规则匹配条件 ─────────────────────────────────────────────────────────

/**
 * 脱敏规则匹配条件
 */
export interface RedactionMatchCondition {
  /** JSON path 匹配，如 "user.profile.phone" */
  fieldPath?: string;
  /** 数据类型匹配 */
  dataType?: string;
  /** 正则表达式匹配 */
  regex?: string;
  /** 关键词匹配 */
  keywords?: string[];
}

// ── 脱敏规则配置 ─────────────────────────────────────────────────────────────

/**
 * 脱敏规则配置
 */
export interface RedactionConfig {
  /** 脱敏字符（默认 "*"） */
  maskChar?: string;
  /** 脱敏模式："last4" | "first6_last4" | "email_style" | "full" */
  maskPattern?: "last4" | "first3_last4" | "first6_last4" | "email_style" | "full";
  /** 替换文本（用于 REPLACE 动作） */
  replacement?: string;
  /** 截断最大长度（用于 TRUNCATE 动作） */
  maxLength?: number;
  /** 是否保留原始值的长度信息 */
  preserveLength?: boolean;
}

// ── 脱敏规则 ─────────────────────────────────────────────────────────────────

/**
 * 数据脱敏规则
 */
export interface DataRedactionRule {
  /** 规则唯一 ID */
  id: string;
  /** 规则名称 */
  name: string;
  /** 规则描述 */
  description?: string;
  /** 匹配条件 */
  match: RedactionMatchCondition;
  /** 脱敏动作 */
  action: RedactionAction;
  /** 脱敏配置 */
  config: RedactionConfig;
  /** 优先级（数字越大优先级越高） */
  priority?: number;
  /** 是否启用 */
  enabled?: boolean;
}

// ── 脱敏结果 ─────────────────────────────────────────────────────────────────

/**
 * 脱敏结果
 */
export interface RedactedContent {
  /** 脱敏后的内容 */
  content: string | object;
  /** 原始内容（可选，用于审计） */
  originalContent?: string | object;
  /** 应用的规则 ID 列表 */
  appliedRuleIds: string[];
  /** 脱敏统计 */
  stats: {
    totalMatches: number;
    fieldsRedacted: number;
    charactersMasked: number;
  };
  /** 是否完全脱敏（无法恢复） */
  isFullyRedacted: boolean;
  /** 脱敏原因 */
  reason?: string;
}

// ── 脱敏上下文 ────────────────────────────────────────────────────────────────

/**
 * 脱敏操作上下文
 */
export interface RedactionContext {
  /** Session ID */
  sessionId: string;
  /** User ID */
  userId: string;
  /** 数据类型 */
  dataType: ClassificationContext["dataType"];
  /** 目标暴露级别 */
  targetClassification: DataClassification;
  /** 是否启用审计日志 */
  enableAudit?: boolean;
}

// ── 内置脱敏规则 ─────────────────────────────────────────────────────────────

/**
 * 默认脱敏规则集（8 条内置规则）
 */
export const DEFAULT_REDACTION_RULES: DataRedactionRule[] = [
  {
    id: "phone_cn",
    name: "中国手机号脱敏",
    description: "脱敏 11 位中国手机号，保留前 3 位和后 4 位",
    match: {
      regex: "(?<!\\d)1[3-9]\\d{9}(?!\\d)",
    },
    action: RedactionAction.MASK,
    config: {
      maskPattern: "first3_last4",
      maskChar: "*",
    },
    priority: 100,
    enabled: true,
  },
  {
    id: "email",
    name: "邮箱地址脱敏",
    description: "脱敏邮箱地址，保留域名",
    match: {
      regex: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
    },
    action: RedactionAction.MASK,
    config: {
      maskPattern: "email_style",
      maskChar: "*",
    },
    priority: 90,
    enabled: true,
  },
  {
    id: "id_card_cn",
    name: "中国身份证脱敏",
    description: "脱敏 18 位身份证号，保留前 6 位和后 4 位",
    match: {
      regex: "(?<!\\d)\\d{17}[\\dXx](?!\\d)",
    },
    action: RedactionAction.MASK,
    config: {
      maskPattern: "first6_last4",
      maskChar: "*",
    },
    priority: 110,
    enabled: true,
  },
  {
    id: "api_key",
    name: "API Key 脱敏",
    description: "脱敏各类 API Key、Secret、Token",
    match: {
      regex: "(api[_-]?key|secret[_-]?key|access[_-]?token|bearer|auth)\\s*[:=]\\s*[\\w-]+",
      keywords: ["sk-", "api_", "secret_", "Bearer "],
    },
    action: RedactionAction.REPLACE,
    config: {
      replacement: "***REDACTED***",
    },
    priority: 120,
    enabled: true,
  },
  {
    id: "ip_address",
    name: "IP 地址脱敏",
    description: "脱敏 IPv4 地址",
    match: {
      regex: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b",
    },
    action: RedactionAction.REPLACE,
    config: {
      replacement: "***.***.***.***",
    },
    priority: 80,
    enabled: true,
  },
  {
    id: "credit_card",
    name: "信用卡号脱敏",
    description: "脱敏信用卡号，保留后 4 位",
    match: {
      regex: "\\b(?:\\d{4}[- ]?){3}\\d{4}\\b",
    },
    action: RedactionAction.MASK,
    config: {
      maskPattern: "last4",
      maskChar: "*",
    },
    priority: 115,
    enabled: true,
  },
  {
    id: "bank_account",
    name: "银行账号脱敏",
    description: "脱敏银行账号，保留后 6 位",
    match: {
      regex: "\\b\\d{16,19}\\b",
    },
    action: RedactionAction.MASK,
    config: {
      maskPattern: "last4",
      maskChar: "*",
    },
    priority: 105,
    enabled: true,
  },
  {
    id: "password",
    name: "密码字段脱敏",
    description: "脱敏密码字段",
    match: {
      fieldPath: "*password*",
      keywords: ["password", "pwd", "passwd", "secret"],
    },
    action: RedactionAction.REPLACE,
    config: {
      replacement: "***HIDDEN***",
    },
    priority: 130,
    enabled: true,
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// Phase 4.3 — SmallModelGuard（小模型守卫）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 小模型守卫检查结果
 */
export interface GuardResult {
  /** 是否通过 */
  passed: boolean;
  /** 违规类型（如果未通过） */
  violationType?: GuardViolationType;
  /** 违规详情 */
  details?: string;
  /** 被拦截的内容（如果需要审计） */
  blockedContent?: string;
  /** 建议的修复方式 */
  suggestion?: string;
}

/**
 * 守卫动作类型
 */
export enum GuardAction {
  /** 允许通过 */
  ALLOW = "allow",
  /** 拒绝请求 */
  DENY = "deny",
  /** 标记为可疑但允许通过 */
  FLAG = "flag",
  /** 降级到慢模型处理 */
  ESCALATE = "escalate",
  /** 静默拦截（不返回具体原因） */
  SILENT_DENY = "silent_deny",
}

/**
 * 违规类型
 */
export enum GuardViolationType {
  /** 潜在提示注入 */
  PROMPT_INJECTION = "prompt_injection",
  /** 敏感数据暴露 */
  DATA_LEAKAGE = "data_leakage",
  /** 模型拒绝攻击 */
  REFUSAL_ATTACK = "refusal_attack",
  /** 系统 prompt 提取尝试 */
  SYSTEM_PROMPT_EXTRACTION = "system_prompt_extraction",
  /** 恶意指令 */
  MALICIOUS_INSTRUCTION = "malicious_instruction",
  /** 越狱尝试 */
  JAILBREAK = "jailbreak",
  /** 角色扮演攻击 */
  ROLE_PLAYING_ATTACK = "role_playing_attack",
  /** 内容安全违规 */
  CONTENT_VIOLATION = "content_violation",
}

/**
 * 安全规则匹配条件
 */
export interface GuardMatchCondition {
  /** 正则表达式匹配 */
  regex?: string;
  /** 关键词匹配 */
  keywords?: string[];
  /** 模式匹配（预定义） */
  patterns?: GuardPattern[];
}

/**
 * 预定义安全模式
 */
export enum GuardPattern {
  /** URL 链接 */
  URL = "url",
  /** 文件路径 */
  FILE_PATH = "file_path",
  /** 代码块 */
  CODE_BLOCK = "code_block",
  /** Base64 编码 */
  BASE64 = "base64",
  /** JSON 数据 */
  JSON_DATA = "json_data",
  /** SQL 注入特征 */
  SQL_INJECTION = "sql_injection",
  /** 命令注入特征 */
  COMMAND_INJECTION = "command_injection",
}

/**
 * 小模型安全规则
 */
export interface SmallModelGuardRule {
  /** 规则 ID */
  id: string;
  /** 规则名称 */
  name: string;
  /** 匹配条件 */
  match: GuardMatchCondition;
  /** 违规类型 */
  violationType: GuardViolationType;
  /** 动作 */
  action: GuardAction;
  /** 规则配置 */
  config: GuardRuleConfig;
  /** 优先级（数字越大优先级越高） */
  priority: number;
  /** 是否启用 */
  enabled: boolean;
  /** 规则描述 */
  description?: string;
}

/**
 * 守卫规则配置
 */
export interface GuardRuleConfig {
  /** 自定义正则表达式（用于 regex 模式） */
  customRegex?: string;
  /** 自定义关键词列表 */
  customKeywords?: string[];
  /** 置信度阈值（0-1） */
  confidenceThreshold?: number;
  /** 是否启用 AI 检测（LLM 判断） */
  enableAIDetection?: boolean;
  /** 是否记录审计日志 */
  auditLog?: boolean;
}

/**
 * 小模型守卫配置
 */
export interface SmallModelGuardConfig {
  /** 规则列表 */
  rules?: SmallModelGuardRule[];
  /** 是否默认启用所有规则 */
  defaultEnabled?: boolean;
  /** 默认动作（未匹配任何规则时） */
  defaultAction?: GuardAction;
  /** 是否启用 AI 检测模式 */
  enableAIDetection?: boolean;
  /** AI 检测的置信度阈值 */
  confidenceThreshold?: number;
  /** 是否启用静默模式 */
  silentMode?: boolean;
}

/**
 * 守卫检查上下文
 */
export interface GuardContext {
  /** Session ID */
  sessionId: string;
  /** 用户 ID */
  userId?: string;
  /** 输入类型 */
  inputType: "user_message" | "tool_result" | "system_context";
  /** 是否为测试模式 */
  testMode?: boolean;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 默认安全规则集
 */
export const DEFAULT_GUARD_RULES: SmallModelGuardRule[] = [
  {
    id: "jailbreak_attempt",
    name: "越狱尝试检测",
    match: {
      patterns: [GuardPattern.CODE_BLOCK],
      keywords: [
        "ignore previous instructions",
        "ignore all instructions",
        "ignore all rules",
        "disregard your instructions",
        "你现在是",
        "你现在不是",
        "forget all rules",
        "forget all instructions",
        "new instructions",
        "override",
        "打破规则",
        "绕过限制",
        "没有限制",
      ],
    },
    violationType: GuardViolationType.JAILBREAK,
    action: GuardAction.DENY,
    config: {
      confidenceThreshold: 0.8,
      auditLog: true,
    },
    priority: 100,
    enabled: true,
    description: "检测常见的越狱尝试模式",
  },
  {
    id: "prompt_injection",
    name: "提示注入检测",
    match: {
      keywords: [
        "injected prompt",
        "新的系统提示",
        "system prompt:",
        "ignore the above",
        "above instructions",
        "previous instructions",
        "你是一个",
        "你是",
      ],
    },
    violationType: GuardViolationType.PROMPT_INJECTION,
    action: GuardAction.FLAG,
    config: {
      confidenceThreshold: 0.7,
      auditLog: true,
    },
    priority: 90,
    enabled: true,
    description: "检测提示注入攻击",
  },
  {
    id: "system_prompt_extraction",
    name: "系统 Prompt 提取尝试",
    match: {
      keywords: [
        "repeat your system prompt",
        "show your instructions",
        "what are your instructions",
        "输出你的系统提示",
        "显示系统指令",
        "print system prompt",
        "reveal your prompt",
      ],
    },
    violationType: GuardViolationType.SYSTEM_PROMPT_EXTRACTION,
    action: GuardAction.DENY,
    config: {
      auditLog: true,
    },
    priority: 95,
    enabled: true,
    description: "检测尝试提取系统 prompt 的行为",
  },
  {
    id: "refusal_attack",
    name: "拒绝攻击检测",
    match: {
      keywords: [
        "I cannot comply",
        "I won't help",
        "I'm sorry but",
        "I refuse",
        "as an AI",
        "ethical concerns",
        "harmful",
        "我不能",
        "我不可以",
        "抱歉不能",
      ],
    },
    violationType: GuardViolationType.REFUSAL_ATTACK,
    action: GuardAction.FLAG,
    config: {
      confidenceThreshold: 0.6,
      auditLog: false,
    },
    priority: 50,
    enabled: true,
    description: "检测模型拒绝攻击（尝试让模型拒绝正常请求）",
  },
  {
    id: "role_playing_attack",
    name: "角色扮演攻击检测",
    match: {
      keywords: [
        "roleplay as",
        "pretend to be",
        "act as if",
        "simulate a",
        "扮演一个",
        "扮演",
        "假设你是",
        "你现在是角色",
      ],
    },
    violationType: GuardViolationType.ROLE_PLAYING_ATTACK,
    action: GuardAction.FLAG,
    config: {
      confidenceThreshold: 0.7,
      auditLog: true,
    },
    priority: 95,
    enabled: true,
    description: "检测角色扮演攻击",
  },
  {
    id: "command_injection",
    name: "命令注入检测",
    match: {
      patterns: [GuardPattern.COMMAND_INJECTION],
      regex: "(rm\\s+-rf|rm\\s+-r|del\\s+/[sqf]|format\\s+[a-z]:|(;|\\||&&)\\s*(rm|del|format|mkdir|chmod|wget|curl|nc|bash|sh)\\b)",
      keywords: [
        "rm -rf",
        "rm -r /",
        "; rm",
        "| rm",
        "&& rm",
        "del /s",
        "/etc/passwd",
        "nc attacker",
      ],
    },
    violationType: GuardViolationType.MALICIOUS_INSTRUCTION,
    action: GuardAction.DENY,
    config: {
      auditLog: true,
    },
    priority: 110,
    enabled: true,
    description: "检测命令注入攻击",
  },
  {
    id: "sql_injection",
    name: "SQL 注入检测",
    match: {
      patterns: [GuardPattern.SQL_INJECTION],
      regex: "('|(\\'\\'))\\s*(or|and|union|select|insert|delete|drop)\\b",
    },
    violationType: GuardViolationType.MALICIOUS_INSTRUCTION,
    action: GuardAction.DENY,
    config: {
      auditLog: true,
    },
    priority: 110,
    enabled: true,
    description: "检测 SQL 注入攻击",
  },
  {
    id: "data_leakage_keywords",
    name: "敏感数据关键词检测",
    match: {
      keywords: [
        "password",
        "secret",
        "api_key",
        "api-key",
        "token",
        "private key",
        "密钥",
        "密码",
        "token",
      ],
    },
    violationType: GuardViolationType.DATA_LEAKAGE,
    action: GuardAction.FLAG,
    config: {
      confidenceThreshold: 0.8,
      auditLog: true,
    },
    priority: 70,
    enabled: true,
    description: "检测可能的敏感数据泄露",
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// Sprint 62: Prompt Template System
// ══════════════════════════════════════════════════════════════════════════════

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  content: PromptTemplateContent;
  scope: "global" | "user_id" | "session_id";
  is_active: boolean;
  created_by: string;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PromptTemplateContent {
  /** 核心规则列表 */
  core_rules: string[];
  /** 场景策略映射 */
  mode_policy: Record<string, string>;
  /** 决策 JSON Schema 描述 */
  decision_schema: {
    fields: string[];
    format: "json" | "yaml";
    example?: string;
  };
  /** 授权规则 */
  authorization_rules: {
    fast: string[];
    slow: string[];
  };
  /** Sprint 65: 信息安全规则（Fast 守门人 PII 管控） */
  security_and_permissions?: {
    blocked?: string[];
    important?: string[];
    necessary?: string[];
    principle?: string;
  };
  /** Sprint 65: Worker 委托规则 */
  worker_delegation?: string[];
  /** Hook 钩子映射 */
  hooks?: Record<string, string>;
  /** 变量定义 */
  variable_definitions?: PromptVariable[];
}

export interface PromptVariable {
  name: string;
  source: "memory" | "context" | "session" | "user" | "computed";
  description: string;
  required?: boolean;
}

export interface PromptTemplateInput {
  name: string;
  description?: string;
  content: PromptTemplateContent;
  scope?: "global" | "user_id" | "session_id";
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface PromptTemplateUpdate {
  name?: string;
  description?: string;
  content?: PromptTemplateContent;
  is_active?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
}
