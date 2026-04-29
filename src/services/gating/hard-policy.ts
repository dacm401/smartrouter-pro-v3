/**
 * HardPolicy — 硬编码核心安全/成本规则。
 *
 * 【设计原则】
 * 这些规则无条件执行，LLM 不可覆盖。
 * 仅包含真正涉及安全、成本底线、缺信息风险的场景。
 *
 * 所有其他可配置阈值（如阈值本身、惩罚系数）都在 gating-config.ts 里。
 */

import type { DecisionFeatures, ManagerDecisionType } from "../../types/index.js";

export interface HardPolicyRule {
  id: string;
  description: string;
  /** 触发条件 */
  condition: (features: DecisionFeatures) => boolean;
  /** 修正动作 */
  action: "block" | "penalize" | "boost";
  /** 作用于哪个动作 */
  target: ManagerDecisionType;
  /** 惩罚系数（仅 penalize 时使用）：final_score = score * (1 - penalty) */
  penalty?: number;
}

/** 硬编码规则列表 */
export const HARD_POLICY_RULES: HardPolicyRule[] = [
  {
    id: "execute_requires_info",
    description: "execute_task 在信息缺失时禁止直接通过",
    condition: (f) => f.missing_info || f.query_too_vague,
    action: "block",
    target: "execute_task",
  },
  {
    id: "delegate_blocked_without_goal",
    description: "信息缺失时强烈不建议 delegate_to_slow（50% 惩罚）",
    condition: (f) => f.missing_info,
    action: "penalize",
    target: "delegate_to_slow",
    penalty: 0.5,
  },
  {
    id: "high_risk_blocks_execute",
    description: "高风险动作禁止 execute_task",
    condition: (f) => f.high_risk_action,
    action: "block",
    target: "execute_task",
  },
  {
    id: "clarification_boost_when_vague",
    description: "请求模糊时 boost ask_clarification（更容易触发）",
    condition: (f) => f.query_too_vague,
    action: "boost",
    target: "ask_clarification",
  },
  // ── Sprint 70 fix: needs_external_tool / requires_multi_step / needs_long_reasoning
  // 根因：LLM 将"查AAPL股价"判定为 direct_answer（L0），Hard Policy 无拦截规则
  // 修复：外部工具/多步/长推理场景 → 禁止 direct_answer + 抬升 delegate_to_slow
  {
    id: "external_tool_blocks_direct_answer",
    description: "需要外部工具时禁止 direct_answer",
    condition: (f) => f.needs_external_tool,
    action: "block",
    target: "direct_answer",
  },
  {
    id: "external_tool_boosts_delegate",
    description: "需要外部工具时抬升 delegate_to_slow（弥补阈值差距）",
    condition: (f) => f.needs_external_tool,
    action: "boost",
    target: "delegate_to_slow",
  },
  {
    id: "multi_step_blocks_direct_answer",
    description: "多步操作时禁止 direct_answer",
    condition: (f) => f.requires_multi_step,
    action: "block",
    target: "direct_answer",
  },
  {
    id: "multi_step_boosts_delegate",
    description: "多步操作时抬升 delegate_to_slow",
    condition: (f) => f.requires_multi_step,
    action: "boost",
    target: "delegate_to_slow",
  },
  {
    id: "long_reasoning_blocks_direct_answer",
    description: "长链推理时禁止 direct_answer",
    condition: (f) => f.needs_long_reasoning,
    action: "block",
    target: "direct_answer",
  },
  {
    id: "long_reasoning_boosts_delegate",
    description: "长链推理时抬升 delegate_to_slow",
    condition: (f) => f.needs_long_reasoning,
    action: "boost",
    target: "delegate_to_slow",
  },
];
