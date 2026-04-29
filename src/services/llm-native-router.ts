// Phase 3.0: LLM-Native Router — ManagerDecision 驱动的路由
// backend/src/services/llm-native-router.ts
//
// 职责：
// 1. 调用 Fast 模型生成 ManagerDecision JSON
// 2. 用 parseAndValidate() 校验
// 3. 按 decision_type 路由：direct_answer / ask_clarification / delegate_to_slow / execute_task
//
// Phase 1：轻量接入，不改旧 orchestrator，双轨并行
//
// Phase 4.1 增强：Permission Layer 预留点
// Phase 4.2 增强：Redaction Engine 集成
// - 在数据暴露给云端模型之前，根据 fallbackAction 执行脱敏
// - 使用 config.permission.redaction feature flag 控制

import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { callModelFull, callOpenAIWithOptions } from "../models/model-gateway.js";
import type { ChatMessage } from "../types/index.js";
import type {
  ManagerDecision,
  ManagerDecisionType,
  RoutingLayer,
  DirectResponse,
  ClarifyQuestion,
  CommandPayload,
  ExecutionPlan,
  WorkerHint,
  DecisionFeatures,
} from "../types/index.js";
import { DECISION_TO_LAYER } from "../types/index.js";
import { parseAndValidate } from "./decision-validator.js";
import { taskPlanner } from "./task-planner.js";
import { DelegationLogRepo } from "../db/repositories.js";

// Phase 4: Permission Layer + Redaction imports (lazy loaded to avoid circular deps)
let phase4Module: typeof import("./phase4/index.js") | null = null;

async function getPhase4() {
  if (!phase4Module) {
    phase4Module = await import("./phase4/index.js");
  }
  return phase4Module;
}

// ── Gating: Gated Delegation v2 ───────────────────────────────────────────────

import { calculateSystemConfidence, getSelectedAction } from "./gating/system-confidence.js";
import { calibrateWithPolicy } from "./gating/policy-calibrator.js";
import { shouldRerank, ruleBasedRerank } from "./gating/delegation-reranker.js";
import { DEFAULT_GATING_CONFIG } from "./gating/gating-config.js";
import type { CalibratedDecision } from "./gating/policy-calibrator.js";
import type { RerankResult } from "./gating/delegation-reranker.js";
// KB-1: Knowledge Boundary Signals
import { detectKnowledgeBoundarySignals } from "./gating/knowledge-boundary-signals.js";
import type { KnowledgeBoundarySignal } from "../types/index.js";

export interface GatedDelegationContext {
  llmScores: Record<ManagerDecisionType, number>;
  llmConfidenceHint: number;
  features: DecisionFeatures;
  systemConfidence: number;
  /** G2: Policy 校准后的各动作分数 */
  calibratedScores: Record<ManagerDecisionType, number>;
  finalAction: ManagerDecisionType;
  policyOverrides: import("../types/index.js").PolicyOverride[];
  rerankResult?: RerankResult;
  /** 最终用于路由的 action（可能经过 rerank） */
  routedAction: ManagerDecisionType;
  /** KB-1: 知识边界信号（可选，用于 trace/debug） */
  knowledgeBoundarySignals?: KnowledgeBoundarySignal[];
}

/**
 * Gated Delegation 完整流程：G1 → G2 → G3
 *
 * @param llmScores                 LLM 输出的各动作原始分数
 * @param llmConfidenceHint         LLM 自报置信度
 * @param features                  LLM 输出的结构化特征
 * @param knowledgeBoundarySignals   KB-1: 知识边界信号（可选）
 * @returns GatedDelegationContext（含所有中间结果，供 trace/debug/benchmark 使用）
 */
export function runGatedDelegation(
  llmScores: Record<ManagerDecisionType, number>,
  llmConfidenceHint: number,
  features: DecisionFeatures,
  knowledgeBoundarySignals?: KnowledgeBoundarySignal[]
): GatedDelegationContext {
  // G1: 计算 system_confidence（含 KB 知识边界校准）
  const systemConfidence = calculateSystemConfidence(
    llmScores,
    llmConfidenceHint,
    features,
    DEFAULT_GATING_CONFIG,
    knowledgeBoundarySignals
  );

  // G2: Policy 校准（含 KB 知识边界校准）
  const calibrated: CalibratedDecision = calibrateWithPolicy(
    llmScores,
    features,
    DEFAULT_GATING_CONFIG,
    knowledgeBoundarySignals
  );

  // G3: 判断是否需要 rerank
  let rerankResult: RerankResult | undefined;
  let routedAction = calibrated.finalAction;

  if (shouldRerank(calibrated.adjustedScores, systemConfidence, calibrated.finalAction, DEFAULT_GATING_CONFIG)) {
    rerankResult = ruleBasedRerank(
      calibrated.adjustedScores,
      features,
      calibrated.finalAction
    );
    routedAction = rerankResult.finalAction;
  }

  return {
    llmScores,
    llmConfidenceHint,
    features,
    systemConfidence,
    calibratedScores: calibrated.adjustedScores,
    finalAction: calibrated.finalAction,
    policyOverrides: calibrated.policyOverrides,
    rerankResult,
    routedAction,
    // KB-1: 保留知识边界信号供 trace/debug 使用
    knowledgeBoundarySignals,
  };
}

// ── Manager Prompt ────────────────────────────────────────────────────────────

function buildManagerSystemPrompt(lang: "zh" | "en", crossSessionContext?: string): string {
  // 中文版 prompt
  const zhPrompt = `你是 SmartRouter Pro 的 Manager（管理模型）。

理解用户请求后，对四个动作分别打分（0.0~1.0），然后输出完整决策 JSON。

【四种动作】
- direct_answer: 直接回答（最低成本，用于闲聊/简单问答/打招呼）
- ask_clarification: 请求澄清（需要用户补充关键信息）
- delegate_to_slow: 委托慢模型（深度分析/多步推理/知识截止日期外内容）
- execute_task: 执行任务（需要工具调用/代码执行/多步操作）

【打分原则】
- 每个动作独立打分（0.0~1.0），分数反映"该动作是否是最优选择"
- 分数不是"该动作是否可能"，而是"相对其他动作是否最优"
- direct_answer 和 ask_clarification 成本较低，可以较低阈值通过
- delegate_to_slow 和 execute_task 成本较高（token/latency/风险），需要更高分数才值得
- ask_clarification 不是零成本——它会打断用户、增加对话轮次

【决策特征】
- missing_info: 请求是否缺少关键信息（目标/范围/格式不明确）
- needs_long_reasoning: 是否需要长链推理或多步分析
- needs_external_tool: 是否需要外部工具（web_search/http_request/代码执行）
- high_risk_action: 是否涉及高风险操作（金融决策/医疗建议/安全相关）
- query_too_vague: 请求是否过于模糊，无法直接处理
- requires_multi_step: 是否需要多步骤操作或跨文件处理
- is_continuation: 请求是否引用了之前的对话或任务（如"继续""接着上次的""把之前的XX补充完整"）

【输出格式】（必须严格使用此 JSON Schema）

{
  "schema_version": "manager_decision_v2",
  "scores": {
    "direct_answer": 0.0~1.0,
    "ask_clarification": 0.0~1.0,
    "delegate_to_slow": 0.0~1.0,
    "execute_task": 0.0~1.0
  },
  "confidence_hint": 0.0~1.0,
  "features": {
    "missing_info": boolean,
    "needs_long_reasoning": boolean,
    "needs_external_tool": boolean,
    "high_risk_action": boolean,
    "query_too_vague": boolean,
    "requires_multi_step": boolean
  },
  "rationale": "一句话决策理由",
  "decision_type": "四个动作之一（与最高分对应）",
  "direct_response": { "content": "当 decision_type=direct_answer 时的回复内容" },
  "clarification": { "question_text": "当 decision_type=ask_clarification 时的澄清问题" },
  "command": { "task_brief": "当 decision_type=delegate/execute 时的任务摘要", "constraints": ["约束1"] }
}

【输出规则】
- 只输出 JSON 对象，不输出其他文字
- JSON 用代码块包裹：\`\`\`json ... \`\`\`
- 必须包含所有字段`;

  // 英文版 prompt
  const enPrompt = `You are SmartRouter Pro's Manager model.

After understanding the user's request, score each of the four actions (0.0~1.0), then output the complete decision JSON.

【Four Actions】
- direct_answer: Direct reply (lowest cost, for chat/simple Q&A/greetings)
- ask_clarification: Request clarification (needs user to provide key info)
- delegate_to_slow: Delegate to slow model (deep analysis/multi-step reasoning/knowledge cutoff)
- execute_task: Execute task (needs tool calling/code execution/multi-step operations)

【Scoring Principles】
- Score each action independently (0.0~1.0), reflecting "is this the optimal choice"
- Score reflects "relative optimal" not "is this possible"
- direct_answer and ask_clarification have lower cost, can pass with lower thresholds
- delegate_to_slow and execute_task have higher cost (token/latency/risk), need higher scores
- ask_clarification is NOT zero-cost — it interrupts the user and increases conversation turns

【Decision Features】
- missing_info: Is key information missing (goal/scope/format unclear)
- needs_long_reasoning: Does it need long-chain reasoning or multi-step analysis
- needs_external_tool: Does it need external tools (web_search/http_request/code execution)
- high_risk_action: Does it involve high-risk operations (financial/medical/security)
- query_too_vague: Is the request too vague to handle directly
- requires_multi_step: Does it need multi-step operations or cross-file handling
- is_continuation: Does the request reference a previous conversation or task (e.g. "continue", "continue from where we left off", "complete the code from before")

【Output Format】（must use this exact JSON Schema）

{
  "schema_version": "manager_decision_v2",
  "scores": {
    "direct_answer": 0.0~1.0,
    "ask_clarification": 0.0~1.0,
    "delegate_to_slow": 0.0~1.0,
    "execute_task": 0.0~1.0
  },
  "confidence_hint": 0.0~1.0,
  "features": {
    "missing_info": boolean,
    "needs_long_reasoning": boolean,
    "needs_external_tool": boolean,
    "high_risk_action": boolean,
    "query_too_vague": boolean,
    "requires_multi_step": boolean,
    "is_continuation": boolean
  },
  "rationale": "One-sentence decision reason",
  "decision_type": "direct_answer|ask_clarification|delegate_to_slow|execute_task",
  "direct_response": { "content": "Reply content when decision_type=direct_answer" },
  "clarification": { "question_text": "Clarifying question when decision_type=ask_clarification" },
  "command": { "task_brief": "Task summary when decision_type=delegate/execute", "constraints": ["constraint1"] }
}

【Output Rules】
- Output JSON ONLY, no other text
- Wrap JSON in code block: \`\`\`json ... \`\`\`
- All fields are required`;

  const base = lang === "zh" ? zhPrompt : enPrompt;
  if (!crossSessionContext) return base;

  // Sprint 63: 追加跨会话上下文（供路由决策参考）
  const contextSection = `

【跨会话上下文】（以下信息来自历史对话，请参考）
${crossSessionContext}

【决策影响】
- 如果 context 显示有未完成任务或续写需求，请提高 delegate_to_slow 或 execute_task 的分数
- 如果 context 显示用户偏好使用 fast 模型处理简单任务，可适当提高 direct_answer 分数`;

  return base + contextSection;
}

// ── 入参 ─────────────────────────────────────────────────────────────────────

export interface LLMNativeRouterInput {
  message: string;
  user_id: string;
  session_id: string;
  /** 当前 session 内请求序号（用于 delegation_logs.turn_id） */
  turn_id: number;
  history: ChatMessage[];
  language: "zh" | "en";
  reqApiKey?: string;
  /** Sprint 72: 用户在前端设置的 LLM API URL，优先于 config.openaiBaseUrl */
  reqBaseUrl?: string;
  /** Sprint 63: 跨会话上下文（active task + history facts） */
  crossSessionContext?: string;
}

export interface LLMNativeRouterResult {
  /** Gated Delegation 上下文（含 G1/G2/G3 全部中间结果） */
  gating?: GatedDelegationContext;
  /** 最终返回给用户的文本 */
  message: string;
  /** ManagerDecision（供 SSE 推送） */
  decision: ManagerDecision | null;
  /** 委托信息（有委托时返回 task_id） */
  delegation?: { task_id: string; status: "triggered" };
  /** 澄清问题（有澄清请求时返回） */
  clarifying?: ClarifyQuestion;
  /** 路由层 */
  routing_layer: RoutingLayer;
  /** 决策类型 */
  decision_type: ManagerDecisionType | null;
  /** Manager JSON 原始文本（调试用） */
  raw_manager_output?: string;
  /** execute_task 的执行计划（Phase 2 新增） */
  execution_plan?: ExecutionPlan;
  /** Phase 3.0: 创建的 archive_id（用于 SSE archive_written 事件） */
  archive_id?: string;
  /** Phase 3.0: 创建的 command_id（用于 SSE worker_started 事件） */
  command_id?: string;
  /** G4: delegation_logs 表的主键 ID（用于异步回写 execution 结果） */
  delegation_log_id?: string;
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

export async function routeWithManagerDecision(
  input: LLMNativeRouterInput
): Promise<LLMNativeRouterResult> {
  const { message, user_id, session_id, turn_id, history, language, reqApiKey, reqBaseUrl, crossSessionContext } = input;

  // Step 1: 调用 Fast 模型，传递 Manager Prompt（含 cross-session 上下文）
  const managerOutput = await callManagerModel({ message, history, language, reqApiKey, reqBaseUrl, crossSessionContext });

  // Step 1.5 (KB-1): 检测知识边界信号
  // fail-open：检测异常不阻断主流程，只记录 warning
  let kbSignals: KnowledgeBoundarySignal[] | undefined;
  try {
    kbSignals = detectKnowledgeBoundarySignals(message, { locale: language });
  } catch (e: any) {
    console.warn("[llm-native-router] KB signal detection failed (fail-open):", e.message);
  }

  // Step 2: 解析 G1 多动作打分格式（manager_decision_v2）
  const gatedResult = parseGatedDecision(managerOutput, kbSignals);

  // Step 3: 不合法 → fallback，返回 L0 direct_answer
  if (!gatedResult) {
    // 尝试旧 v1 格式作为 backward compatibility fallback
    const decision = parseAndValidate(managerOutput);
    if (decision) {
      return routeByDecision(decision, { message, user_id, session_id, language, reqApiKey, raw: managerOutput });
    }
    // Sprint 72 fix: LLM 有时返回截断/乱码 JSON（如 scores 字段不完整），直接吐出 JSON 是错误的
    // 改为：如果 managerOutput 看起来像 JSON（非自然语言），使用 fallback
    const trimmed = managerOutput.trim();
    const looksLikeJSON = trimmed.startsWith("{") || trimmed.startsWith("```") || trimmed.startsWith("json");
    const fallbackMsg = language === "zh" ? "好的，让我看看。" : "Got it, let me check.";
    console.warn("[llm-native-router] ManagerDecision parse failed, fallback to direct_answer. looksLikeJSON:", looksLikeJSON);
    return {
      message: looksLikeJSON ? fallbackMsg : (trimmed || fallbackMsg),
      decision: null,
      routing_layer: "L0",
      decision_type: "direct_answer",
      raw_manager_output: managerOutput,
      delegation_log_id: undefined,
    };
  }

  // Step 4: 按 Gated Delegation 最终结果路由（KB signals 已在 gatedResult.knowledgeBoundarySignals 中）
  const v2Decision = tryParseV2Decision(managerOutput);
  return routeByGatedDecision(gatedResult, { message, user_id, session_id, turn_id, language, reqApiKey, rawOutput: managerOutput, v2Decision });
}

// ── Fast Manager 调用 ─────────────────────────────────────────────────────────

async function callManagerModel(input: {
  message: string;
  history: ChatMessage[];
  language: "zh" | "en";
  reqApiKey?: string;
  /** Sprint 72: 用户在前端设置的 LLM API URL，优先于 config.openaiBaseUrl */
  reqBaseUrl?: string;
  /** Sprint 63: cross-session context */
  crossSessionContext?: string;
}): Promise<string> {
  const { message, history, language, reqApiKey, reqBaseUrl, crossSessionContext } = input;

  const systemPrompt = buildManagerSystemPrompt(language, crossSessionContext);
  // 保留最近 6 轮对话作为上下文，不传全量 history（Manager 只读当前任务）
  const recentHistory = history.filter((m) => m.role !== "system").slice(-6);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...recentHistory,
    { role: "user", content: message },
  ];

  try {
    if (reqApiKey) {
      const resp = await callOpenAIWithOptions(
        config.fastModel,
        messages,
        reqApiKey,
        reqBaseUrl || config.openaiBaseUrl || undefined
      );
      return resp.content;
    }
    const resp = await callModelFull(config.fastModel, messages);
    return resp.content;
  } catch (e: any) {
    console.error("[llm-native-router] Manager model call failed:", e.message);
    throw e;
  }
}

// ── Gated Delegation: 解析 v2 格式 ───────────────────────────────────────────

/** 尝试解析 v2 decision JSON（用于路由字段提取） */
function tryParseV2Decision(text: string): Record<string, unknown> | null {
  try {
    const match =
      text.match(/```json\s*([\s\S]*?)\s*```/)?.[1] ??
      text.match(/```\s*([\s\S]*?)\s*```/)?.[1] ??
      text.match(/(\{[\s\S]*\})/)?.[1];
    if (!match) return null;
    return JSON.parse(match.trim());
  } catch {
    return null;
  }
}

function parseGatedDecision(
  text: string,
  kbSignals?: KnowledgeBoundarySignal[]
): GatedDelegationContext | null {
  try {
    const match =
      text.match(/```json\s*([\s\S]*?)\s*```/)?.[1] ??
      text.match(/```\s*([\s\S]*?)\s*```/)?.[1] ??
      text.match(/(\{[\s\S]*\})/)?.[1];

    if (!match) return null;
    const raw = JSON.parse(match.trim());

    // Sprint 72 fix: 同时接受 v1 和 v2
    // 模型偶尔输出 v1（仅含 scores/features）而非要求的 v2（全量决策字段）
    if (!["manager_decision_v2", "manager_decision_v1"].includes(raw.schema_version)) return null;

    // v1/v2 共用 scores 字段结构，直接取用
    const scores: Record<ManagerDecisionType, number> = {
      direct_answer: raw.scores?.direct_answer ?? 0,
      ask_clarification: raw.scores?.ask_clarification ?? 0,
      delegate_to_slow: raw.scores?.delegate_to_slow ?? 0,
      execute_task: raw.scores?.execute_task ?? 0,
    };

    // v1 有 confidence_hint；v2 有 confidence_hint（统一用此字段）
    const llmConfidenceHint = typeof raw.confidence_hint === "number"
      ? Math.max(0, Math.min(1, raw.confidence_hint))
      : 0.5;

    const features: DecisionFeatures = {
      missing_info: Boolean(raw.features?.missing_info),
      needs_long_reasoning: Boolean(raw.features?.needs_long_reasoning),
      needs_external_tool: Boolean(raw.features?.needs_external_tool),
      high_risk_action: Boolean(raw.features?.high_risk_action),
      query_too_vague: Boolean(raw.features?.query_too_vague),
      requires_multi_step: Boolean(raw.features?.requires_multi_step),
      is_continuation: Boolean(raw.features?.is_continuation),
    };

    // KB-1: 传入知识边界信号，供 G1/G2 校准使用
    return runGatedDelegation(scores, llmConfidenceHint, features, kbSignals);
  } catch (e) {
    console.warn("[parseGatedDecision] failed:", (e as Error).message);
    return null;
  }
}

// ── Gated Delegation: 按 Gated 结果路由 ──────────────────────────────────────

interface GatedRouteContext {
  message: string;
  user_id: string;
  session_id: string;
  turn_id: number;
  task_id?: string;
  language: "zh" | "en";
  reqApiKey?: string;
  /** 原始字符串（用于 raw_manager_output） */
  rawOutput: string;
  /** 解析后的 v2 decision（用于路由字段） */
  v2Decision: Record<string, unknown> | null;
}

async function routeByGatedDecision(
  gated: GatedDelegationContext,
  ctx: GatedRouteContext
): Promise<LLMNativeRouterResult> {
  const { message, user_id, session_id, turn_id, task_id, language, reqApiKey, rawOutput, v2Decision } = ctx;

  // 构建向后兼容的 V1 ManagerDecision（用于 SSE/Archive/旧逻辑）
  const decision: ManagerDecision = {
    schema_version: "manager_decision_v1",
    decision_type: gated.routedAction,
    routing_layer: DECISION_TO_LAYER[gated.routedAction],
    reason: `Gated: ${gated.routedAction} (G1 score=${gated.llmScores[gated.routedAction]?.toFixed(2)}, G2 adjusted, system_conf=${gated.systemConfidence.toFixed(2)})`,
    confidence: gated.systemConfidence,
    needs_archive: gated.routedAction !== "direct_answer",
    direct_response: gated.routedAction === "direct_answer"
      ? { style: "natural" as const, content: (v2Decision?.direct_response as { content?: string })?.content || (language === "zh" ? "好的。" : "Got it.") }
      : undefined,
    clarification: gated.routedAction === "ask_clarification"
      ? { question_id: "q1", question_text: (v2Decision?.clarification as { question_text?: string })?.question_text ?? (language === "zh" ? "能再具体一点吗？" : "Could you be more specific?"), clarification_reason: gated.features.query_too_vague ? "请求模糊" : "需要更多信息" }
      : undefined,
    command: (gated.routedAction === "delegate_to_slow" || gated.routedAction === "execute_task")
      ? {
          command_type: gated.routedAction === "execute_task" ? "execute_plan" as const : "delegate_analysis" as const,
          task_type: "analysis",
          task_brief: (v2Decision?.command as { task_brief?: string })?.task_brief ?? message.substring(0, 200),
          goal: (v2Decision?.command as { task_brief?: string })?.task_brief ?? message,
          constraints: v2Decision && Array.isArray((v2Decision.command as { constraints?: unknown[] })?.constraints) ? (v2Decision.command as { constraints: unknown[] }).constraints as string[] : [],
        }
      : undefined,
  };

  // G4: 委托决策日志（fire-and-forget，不阻塞主流程）
  // G1→G2→G3→路由的完整事实写入 delegation_logs，用于离线分析和 benchmark 改进
  // 生成 UUID 用于异步回写 execution 结果（G4-C 的最后一环）
  const delegation_log_id = uuid();
  DelegationLogRepo.save({
    id: delegation_log_id,
    user_id: user_id,
    session_id: session_id,
    turn_id: turn_id,
    task_id: task_id,
    llm_scores: gated.llmScores,
    llm_confidence: gated.llmConfidenceHint,
    system_confidence: gated.systemConfidence,
    calibrated_scores: gated.calibratedScores,
    policy_overrides: gated.policyOverrides,
    g2_final_action: gated.finalAction,
    did_rerank: Boolean(gated.rerankResult),
    rerank_rules: gated.rerankResult ? [gated.rerankResult.reason ?? "reranked"].filter(Boolean) : [],
    g3_final_action: gated.rerankResult ? gated.routedAction : undefined,
    routed_action: gated.routedAction,
    routing_reason: `Gated: ${gated.routedAction} (sys_conf=${gated.systemConfidence.toFixed(3)})`,
    // Sprint 68: 显式路由层，用于分层监控和 L2 灰度分析
    routing_layer: DECISION_TO_LAYER[gated.routedAction],
  }).catch((e) => console.warn("[delegation-log] write failed:", e.message));

  // Gated Delegation 日志（console.debug 级别，不阻塞主流程）
  console.log("[llm-native-router] Gated Delegation:", {
    llmScores: gated.llmScores,
    llmConfidenceHint: gated.llmConfidenceHint,
    systemConfidence: gated.systemConfidence.toFixed(3),
    routedAction: gated.routedAction,
    routingLayer: DECISION_TO_LAYER[gated.routedAction],
    reranked: gated.rerankResult?.reranked ?? false,
    rerankReason: gated.rerankResult?.reason,
    policyOverrides: gated.policyOverrides.length,
    features: gated.features,
    // KB-1: 知识边界信号（如果有）
    kbSignals: gated.knowledgeBoundarySignals?.map((s) => ({
      type: s.type,
      strength: s.strength.toFixed(2),
      reasons: s.reasons,
    })) ?? [],
  });

  // 按最终路由动作分发，携带 delegation_log_id 供 SSE 异步回写使用
  return routeByDecision(decision, { ...ctx, raw: rawOutput, delegation_log_id });
}

// ── 决策路由 ─────────────────────────────────────────────────────────────────

interface RouteContext {
  message: string;
  user_id: string;
  session_id: string;
  language: "zh" | "en";
  reqApiKey?: string;
  raw: string;
  /** G4: delegation_logs 主键 ID（用于异步回写 execution 结果） */
  delegation_log_id?: string;
}

async function routeByDecision(
  decision: ManagerDecision,
  ctx: RouteContext
): Promise<LLMNativeRouterResult> {
  const { message, user_id, session_id, language, reqApiKey, raw, delegation_log_id } = ctx;

  switch (decision.decision_type) {
    case "direct_answer": {
      const dr = decision.direct_response as DirectResponse | undefined;
      const reply = dr?.content || (language === "zh" ? "好的。" : "Got it.");
      return {
        message: reply,
        decision,
        routing_layer: "L0",
        decision_type: "direct_answer",
        raw_manager_output: raw,
        delegation_log_id,
      };
    }

    case "ask_clarification": {
      const cq = decision.clarification as ClarifyQuestion | undefined;
      const questionText = cq?.question_text?.trim() || (language === "zh" ? "能再具体一点吗？" : "Could you be more specific?");
      const clarifyingMessage = cq?.options?.length
        ? `${questionText} ${cq.options.map((o) => `"${o.label}"`).join(" / ")}`
        : questionText;

      // B39-02 fix: ask_clarification 写 task_archives，便于追踪 ClarifyQuestion 后续状态
      const clarifyingTaskId = uuid();
      try {
        const { TaskArchiveRepo, TaskArchiveEventRepo } = await import("../db/task-archive-repo.js");
        await TaskArchiveRepo.create({
          task_id: clarifyingTaskId,
          user_id,
          session_id,
          decision,
          user_input: message,
        });
        // create 默认 state=delegated，改为 clarifying 以便追踪
        await TaskArchiveRepo.updateState(clarifyingTaskId, "clarifying");
        // Phase 3.0: 写入 archive_written 事件
        await TaskArchiveEventRepo.create({
          archive_id: clarifyingTaskId,
          task_id: clarifyingTaskId,
          event_type: "archive_created",
          payload: { decision_type: "ask_clarification", question_text: cq?.question_text },
          actor: "fast_manager",
          user_id,
        });
      } catch (e: any) {
        console.warn("[llm-native-router] Clarifying archive create failed:", e.message);
      }

      return {
        message: clarifyingMessage,
        decision,
        routing_layer: "L0" as RoutingLayer,
        decision_type: "ask_clarification",
        clarifying: cq,
        archive_id: clarifyingTaskId,
        raw_manager_output: raw,
        delegation_log_id,
      };
    }

    case "delegate_to_slow": {
      const command = decision.command as CommandPayload | undefined;
      const taskId = uuid();
      let processedCommand = command;

      // Phase 4.1 + 4.2: Permission Layer + Redaction Engine
      // 目的：在数据暴露给云端模型之前，检查是否允许暴露，必要时执行脱敏
      if (config.permission.enabled) {
        try {
          const pl = await getPhase4();
          // 构建分类上下文：task_brief 是暴露给云端的核心数据
          const classificationCtx = {
            dataType: "task_archive" as const,
            sensitivity: "internal" as const,
            source: "system" as const,
            hasPII: false,
            ageHours: 0,
          };
          const classification = new pl.DataClassifier().classify(command?.task_brief ?? "", classificationCtx);
          const permissionCtx = {
            sessionId: session_id,
            userId: user_id,
            requestedTier: classification.classification,
            featureFlags: {
              use_permission_layer: config.permission.enabled,
              use_data_classification: config.permission.dataClassification,
              use_redaction: config.permission.redaction,
            },
            userDataPreferences: config.permission.userDataPreferences,
            targetModel: "cloud_72b" as const,
          };
          const permission = pl.PermissionChecker.fromClassification(classification.classification, permissionCtx);

          console.log("[llm-native-router] Phase 4 Permission Check:", {
            taskId,
            dataType: "task_brief",
            classification: classification.classification,
            permissionAllowed: permission.allowed,
            fallbackAction: permission.fallbackAction,
          });

          // Phase 4.2: 根据 fallbackAction 执行脱敏
          if (permission.fallbackAction === "redact" && config.permission.redaction) {
            const redactionEngine = pl.getRedactionEngine();
            const redactionCtx = {
              sessionId: session_id,
              userId: user_id,
              dataType: "task_archive" as const,
              targetClassification: classification.classification,
              enableAudit: true,
            };

            if (command) {
              const redactedBrief = redactionEngine.redact(command.task_brief ?? "", redactionCtx);
              const redactedWorkerHint = redactionEngine.redact(command.worker_hint ?? "", redactionCtx);

              processedCommand = {
                ...command,
                task_brief: redactedBrief.content as string,
                worker_hint: redactedWorkerHint.content as WorkerHint,
              };

              console.log("[llm-native-router] Phase 4.2 Redaction Applied:", {
                taskId,
                briefStats: redactedBrief.stats,
                workerHintStats: redactedWorkerHint.stats,
              });
            }
          } else if (permission.fallbackAction === "reject" || !permission.allowed) {
            // 拒绝暴露，回退到 direct_answer
            return {
              message: language === "zh"
                ? "抱歉，这个问题涉及敏感信息，无法交给更专业的模型处理。"
                : "Sorry, this request involves sensitive information and cannot be processed by the cloud model.",
              decision,
              routing_layer: "L0",
              decision_type: "direct_answer",
              raw_manager_output: raw,
              delegation_log_id,
            };
          }
        } catch (e: any) {
          console.warn("[llm-native-router] Permission layer check failed:", e.message);
        }
      }

      // Phase 3.0: 写入 TaskArchive + archive_written 事件
      let archiveRecord: { id: string } | null = null;
      try {
        const { TaskArchiveRepo, TaskArchiveEventRepo } = await import("../db/task-archive-repo.js");
        archiveRecord = await TaskArchiveRepo.create({
          task_id: taskId,
          user_id,
          session_id,
          decision,
          user_input: message,
        });
        await TaskArchiveEventRepo.create({
          archive_id: archiveRecord.id,
          task_id: taskId,
          event_type: "archive_created",
          payload: { decision_type: "delegate_to_slow", command_type: command?.command_type ?? "research" },
          actor: "fast_manager",
          user_id,
        });
      } catch (e: any) {
        console.warn("[llm-native-router] TaskArchive create failed:", e.message);
      }

      // Phase 3.0: 写入 task_commands + worker_started 事件
      let commandRecord: { id: string } | null = null;
      try {
        const { TaskCommandRepo, TaskArchiveEventRepo } = await import("../db/task-archive-repo.js");
        if (processedCommand) {
          commandRecord = await TaskCommandRepo.create({
            task_id: taskId,
            archive_id: taskId,
            user_id,
            command_type: processedCommand.command_type,
            worker_hint: processedCommand.worker_hint,
            priority: processedCommand.priority ?? "normal",
            payload: processedCommand,
          });
          // Phase 3.0: worker_started 事件
          await TaskArchiveEventRepo.create({
            archive_id: taskId,
            task_id: taskId,
            event_type: "worker_started",
            payload: { worker_role: processedCommand.worker_hint ?? "slow_worker", command_id: commandRecord.id },
            actor: "slow_worker",
            user_id,
          });
        }
      } catch (e: any) {
        console.warn("[llm-native-router] TaskCommand create failed:", e.message);
      }

      const fastReply = language === "zh"
        ? "这个问题比较深，我正在请更专业的模型帮你分析，稍等一下～"
        : "This is complex. I'm getting a more specialized model to analyze it, please wait...";

      return {
        message: fastReply,
        decision,
        delegation: { task_id: taskId, status: "triggered" },
        routing_layer: "L2",
        decision_type: "delegate_to_slow",
        raw_manager_output: raw,
        archive_id: archiveRecord?.id ?? taskId,
        command_id: commandRecord?.id,
        delegation_log_id,
      };
    }

    case "execute_task": {
      const command = decision.command as CommandPayload | undefined;
      const taskId = uuid();
      let processedCommand = command;

      // Phase 4.1 + 4.2: Permission Layer + Redaction Engine
      if (config.permission.enabled) {
        try {
          const pl = await getPhase4();
          const classificationCtx = {
            dataType: "task_archive" as const,
            sensitivity: "internal" as const,
            source: "system" as const,
            hasPII: false,
            ageHours: 0,
          };
          const classification = new pl.DataClassifier().classify(command?.task_brief ?? "", classificationCtx);
          const permissionCtx = {
            sessionId: session_id,
            userId: user_id,
            requestedTier: classification.classification,
            featureFlags: {
              use_permission_layer: config.permission.enabled,
              use_data_classification: config.permission.dataClassification,
              use_redaction: config.permission.redaction,
            },
            userDataPreferences: config.permission.userDataPreferences,
            targetModel: "cloud_72b" as const,
          };
          const permission = pl.PermissionChecker.fromClassification(classification.classification, permissionCtx);

          console.log("[llm-native-router] Phase 4 Permission Check (execute_task):", {
            taskId,
            dataType: "task_brief",
            classification: classification.classification,
            permissionAllowed: permission.allowed,
            fallbackAction: permission.fallbackAction,
          });

          // Phase 4.2: 根据 fallbackAction 执行脱敏
          if (permission.fallbackAction === "redact" && config.permission.redaction) {
            const redactionEngine = pl.getRedactionEngine();
            const redactionCtx = {
              sessionId: session_id,
              userId: user_id,
              dataType: "task_archive" as const,
              targetClassification: classification.classification,
              enableAudit: true,
            };

            if (command) {
              const redactedBrief = redactionEngine.redact(command.task_brief ?? "", redactionCtx);
              const redactedWorkerHint = redactionEngine.redact(command.worker_hint ?? "", redactionCtx);

              processedCommand = {
                ...command,
                task_brief: redactedBrief.content as string,
                worker_hint: redactedWorkerHint.content as WorkerHint,
              };

              console.log("[llm-native-router] Phase 4.2 Redaction Applied (execute_task):", {
                taskId,
                briefStats: redactedBrief.stats,
              });
            }
          }
        } catch (e: any) {
          console.warn("[llm-native-router] Permission layer check failed:", e.message);
        }
      }

      // Step 1: 写入 TaskArchive + archive_written 事件
      let archiveRecord2: { id: string } | null = null;
      try {
        const { TaskArchiveRepo, TaskArchiveEventRepo } = await import("../db/task-archive-repo.js");
        archiveRecord2 = await TaskArchiveRepo.create({
          task_id: taskId,
          user_id,
          session_id,
          decision,
          user_input: message,
          task_brief: command?.task_brief,
          goal: command?.goal,
        });
        await TaskArchiveEventRepo.create({
          archive_id: archiveRecord2.id,
          task_id: taskId,
          event_type: "archive_created",
          payload: { decision_type: "execute_task", command_type: processedCommand?.command_type ?? "execute_plan" },
          actor: "fast_manager",
          user_id,
        });
      } catch (e: any) {
        console.warn("[llm-native-router] TaskArchive create failed:", e.message);
      }

      // Step 2: 写入 task_commands + worker_started 事件
      let commandRecord2: { id: string } | null = null;
      try {
        const { TaskCommandRepo, TaskArchiveEventRepo } = await import("../db/task-archive-repo.js");
        if (processedCommand) {
          commandRecord2 = await TaskCommandRepo.create({
            task_id: taskId,
            archive_id: taskId,
            user_id,
            command_type: processedCommand.command_type ?? "execute_plan",
            worker_hint: processedCommand.worker_hint ?? "execute_worker",
            priority: processedCommand.priority ?? "normal",
            payload: processedCommand,
            timeout_sec: processedCommand.timeout_sec,
          });
          await TaskArchiveEventRepo.create({
            archive_id: taskId,
            task_id: taskId,
            event_type: "worker_started",
            payload: { worker_role: processedCommand.worker_hint ?? "execute_worker", command_id: commandRecord2.id },
            actor: "execute_worker",
            user_id,
          });
        }
      } catch (e: any) {
        console.warn("[llm-native-router] TaskCommand create failed:", e.message);
      }

      const fastReply = language === "zh"
        ? "好的，正在处理这个任务，稍等一下～"
        : "Got it. Processing this task, please wait...";

      // Phase 3.0: P0-3 — execute_task 接入 TaskPlanner，生成 ExecutionPlan
      let execution_plan;
      try {
        execution_plan = await taskPlanner.plan({
          taskId,
          goal: command?.goal ?? message,
          userId: user_id,
          sessionId: session_id,
          model: config.slowModel,
        });
        console.log("[llm-native-router] execute_task: ExecutionPlan generated:", {
          taskId,
          steps: execution_plan.steps.length,
        });
      } catch (e: any) {
        console.warn("[llm-native-router] TaskPlanner.plan failed:", e.message);
        // TaskPlanner 失败不影响主流程，继续返回 delegation
      }

      return {
        message: fastReply,
        decision,
        delegation: { task_id: taskId, status: "triggered" },
        routing_layer: "L3",
        decision_type: "execute_task",
        raw_manager_output: raw,
        archive_id: archiveRecord2?.id ?? taskId,
        command_id: commandRecord2?.id,
        execution_plan,
        delegation_log_id,
      };
    }

    default: {
      console.warn("[llm-native-router] Unknown decision_type:", (decision as any).decision_type);
      return {
        message: language === "zh" ? "好的，让我看看。" : "Got it.",
        decision,
        routing_layer: "L0",
        decision_type: null,
        raw_manager_output: raw,
        delegation_log_id,
      };
    }
  }
}

// ── Test-only exports（仅供单元测试访问内部函数） ────────────────────────────────

/** @internal — 仅供测试使用 */
export { tryParseV2Decision, parseGatedDecision };

