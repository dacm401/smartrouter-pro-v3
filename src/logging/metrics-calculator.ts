import { DecisionRepo, GrowthRepo } from "../db/repositories.js";
import type { DashboardData } from "../types/index.js";

export async function calculateDashboard(userId: string): Promise<DashboardData> {
  const [todayStats, recentDecisions, growth] = await Promise.all([
    DecisionRepo.getTodayStats(userId), DecisionRepo.getRecent(userId, 20), GrowthRepo.getProfile(userId),
  ]);

  const tokenFlow = { fast_tokens: 0, slow_tokens: 0, compressed_tokens: 0, fallback_tokens: 0 };
  for (const d of recentDecisions) {
    const tokens = (d.exec_input_tokens || 0) + (d.exec_output_tokens || 0);
    if (d.did_fallback) tokenFlow.fallback_tokens += tokens;
    else if (d.selected_role === "fast") tokenFlow.fast_tokens += tokens;
    else tokenFlow.slow_tokens += tokens;
    tokenFlow.compressed_tokens += (d.context_original_tokens || 0) - (d.context_compressed_tokens || 0);
  }

  const savingRate = todayStats.total_cost > 0 ? Math.round((todayStats.saved_cost / (todayStats.total_cost + todayStats.saved_cost)) * 100) : 0;

  return {
    today: {
      total_requests: todayStats.total_requests, fast_count: todayStats.fast_count, slow_count: todayStats.slow_count,
      fallback_count: todayStats.fallback_count, total_tokens: todayStats.total_tokens,
      total_cost: Math.round(todayStats.total_cost * 10000) / 10000,
      saved_cost: Math.round(todayStats.saved_cost * 10000) / 10000, saving_rate: savingRate,
      avg_latency_ms: todayStats.avg_latency, satisfaction_proxy: todayStats.satisfaction_rate || 0,
    },
    token_flow: tokenFlow,
    recent_decisions: recentDecisions.map(mapDecisionRow),
    growth,
  };
}

function mapDecisionRow(row: any): any {
  // row 来自 delegation_logs，字段体系与 decision_logs 不同
  const scores = (row.llm_scores || {}) as Record<string, number>;
  const calibrated = (row.calibrated_scores || {}) as Record<string, number>;
  return {
    id: row.id,
    timestamp: new Date(row.created_at).getTime(),
    input_features: {
      raw_query: (row as any).user_input || '',  // delegation_logs 无此字段，尝试从关联表获取
      intent: 'unknown',
      complexity_score: 0,
      token_count: 0,
      has_code: false,
      has_math: false,
    },
    routing: {
      router_version: row.routing_layer || 'unknown',
      scores: { fast: scores.direct_answer ?? 0, slow: Math.max(scores.delegate_to_slow ?? 0, scores.execute_task ?? 0) },
      confidence: row.llm_confidence ?? 0,
      selected_model: row.model_used || '',
      selected_role: row.routed_action || '',
      selection_reason: row.routing_reason || '',
    },
    context: { original_tokens: 0, compressed_tokens: 0, compression_level: 'L0', compression_ratio: 0 },
    execution: {
      model_used: row.model_used || '',
      input_tokens: 0,
      output_tokens: 0,
      total_cost_usd: parseFloat(row.cost_usd) || 0,
      latency_ms: row.latency_ms || 0,
      did_fallback: false,
    },
    feedback: undefined, // delegation_logs 无 feedback 字段，后续可关联 feedback_events
  };
}
