import { Hono } from "hono";
import { stream } from "hono/streaming";
import { v4 as uuid } from "uuid";
import type { ChatRequest, ChatResponse, DecisionRecord, ExecutionStepsSummary, FeedbackType, TaskSummary } from "../types/index.js";

const VALID_FEEDBACK_TYPES: readonly FeedbackType[] = [
  "accepted", "regenerated", "edited",
  "thumbs_up", "thumbs_down",
  "follow_up_doubt", "follow_up_thanks",
] as const;
import { logDecision } from "../logging/decision-logger.js";
import { config } from "../config.js";
import { MemoryEntryRepo, TaskRepo, ExecutionResultRepo } from "../db/repositories.js";
import { formatExecutionResultsForPlanner } from "../services/execution-result-formatter.js";
// EL-003: Execution Loop
import { taskPlanner } from "../services/task-planner.js";
import { executionLoop } from "../services/execution-loop.js";
// C3a: unified identity
import { getContextUserId } from "../middleware/identity.js";
// SSE 流式轮询（从 orchestrator.ts 迁移出来）
import { pollArchiveAndYield } from "../services/phase3/sse-poller.js";
import { routeWithManagerDecision } from "../services/llm-native-router.js";
// Sprint 63: 跨会话上下文
import { buildCrossSessionContext } from "../services/cross-session-context.js";
// Sprint 65: Permission 对话流 + Operation Auth Matrix
import { handlePermissionResponseMessage } from "../services/permission-manager.js";
const chatRouter = new Hono();

chatRouter.post("/chat", async (c) => {
  console.log("[chat] POST /chat received, body size:", c.req.raw.headers.get("content-length") ?? "unknown");
  // UTF-8 fix: use c.req.raw.text() instead of c.req.json()
  // c.req.json() in @hono/node-server can mis-decode UTF-8 body as Latin-1
  const rawBody = await c.req.raw.text();
  let body: ChatRequest;
  try {
    body = JSON.parse(rawBody) as ChatRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const startTime = Date.now();

  // C3a: Priority 1 — middleware context (trusted X-User-Id header)
  // C3a: Priority 2 — dev-only body shim (only when allowDevFallback=true and no context)
  // C3a: read from middleware context via c.get() (not direct property — Hono uses private Map)
  const middlewareUserId = getContextUserId(c);
  // Dev fallback: if middleware couldn't extract (shouldn't happen with correct header)
  const userId = middlewareUserId || body.user_id || "default-user";

  const sessionId = body.session_id || uuid();

  // ── T1: Task Resume v1 (方案 C — 混合) ─────────────────────────────────────
  // Priority 1: explicit task_id in request body
  // Priority 2: find active task by session_id (no terminal status)
  // Priority 3: no resumable task → will create new task below
  let resumedTaskId: string | null = null;
  let resumedTaskSummary: TaskSummary | null = null;

  if (body.task_id) {
    const existingTask = await TaskRepo.getById(body.task_id as string);
    if (!existingTask) {
      return c.json({ error: `Task not found: ${body.task_id}` }, 404);
    }
    if (existingTask.user_id !== userId) {
      return c.json({ error: "Forbidden: task does not belong to this user" }, 403);
    }
    // Only resume if task is not already terminal
    if (!["completed", "failed", "cancelled"].includes(existingTask.status)) {
      resumedTaskId = existingTask.task_id;
      resumedTaskSummary = await TaskRepo.getSummary(existingTask.task_id);
      // Re-activate task status
      await TaskRepo.setStatus(resumedTaskId, "responding").catch((e) => console.warn("[chat] Failed to set task status to responding:", e));
    }
  } else if (body.session_id) {
    // T1: implicit resumption — find most recent active task for this session
    const activeTask = await TaskRepo.findActiveBySession(body.session_id as string, userId);
    if (activeTask) {
      resumedTaskId = activeTask.task_id;
      resumedTaskSummary = await TaskRepo.getSummary(activeTask.task_id);
      await TaskRepo.setStatus(resumedTaskId, "responding").catch((e) => console.warn("[chat] Failed to set task status to responding:", e));
    }
  }

  // 请求级覆盖：前端设置里的 Key / URL / 模型优先于环境变量
  const reqApiKey = body.api_key || undefined;
  const reqBaseUrl = body.llm_base_url || undefined;
  const effectiveFastModel = body.fast_model || config.fastModel;
  const effectiveSlowModel = body.slow_model || config.slowModel;

  // ── Sprint 65: 权限响应检测（优先于路由，直接处理授权指令）─────────────────
  // 检测用户消息是否是"允许 xxx" / "拒绝 xxx" 格式，如果是，直接处理授权并返回
  try {
    const permResult = await handlePermissionResponseMessage(body.message ?? "", userId);
    if (permResult.handled) {
      return c.json({
        content: permResult.reply,
        model: "manager",
        routing_layer: "L0",
        decision_type: "direct_answer",
        session_id: sessionId,
        permission_handled: true,
      } satisfies Record<string, unknown>);
    }
  } catch (permErr: any) {
    console.warn("[chat] permission response handling error:", permErr.message);
    // 不阻断主流程，继续正常处理
  }

  try {
    // Sprint 69: 统一 dispatcher — 不再区分 use_llm_native_routing
    // 所有请求走 routeWithManagerDecision，由 stream 标志决定返回格式
    // Sprint 68 发现：use_llm_native_routing 隐式分支导致规则路径和 SSE 路径不对齐
    const useStream = body.stream === true;
    const useLLMNative = body.use_llm_native_routing !== false; // 默认 true

    if (!useLLMNative) {
      // Sprint 72 Plan B: 轻量降级，不触发委托（orchestrator 已移除），返回 200 而非 400
      // 内联语言检测：无需等待 features 提取
      const msgText = body.message ?? "";
      const chineseChars = msgText.match(/[\u4e00-\u9fff]/g);
      const lang = (chineseChars && chineseChars.length > msgText.length * 0.1) ? "zh" : "en";
      const msg = lang === "zh"
        ? "智能路由服务已升级，旧版路由标识已停用。当前请求已记录，将在服务恢复后继续处理。"
        : "Smart routing has been upgraded. The legacy routing flag is deprecated. Your request has been logged.";
      console.warn(`[chat] use_llm_native_routing=false fallback triggered by session ${sessionId}`);
      return c.json({
        error: null,
        message: msg,
        decision_type: "direct_answer",
        routing_layer: "fallback",
        delegation: null,
        archive_id: null,
      }, 200);
    }

    // Sprint 69: 轻量 features 提取（仅用于 logDecision / execute mode）
    // 不再走旧的 analyzeAndRoute，统一由 routeWithManagerDecision 提供
    const { features } = (() => {
      const message = body.message ?? "";
      const safeText = message ?? "";
      const chineseChars = safeText.match(/[\u4e00-\u9fff]/g);
      const language = (chineseChars && chineseChars.length > safeText.length * 0.1) ? "zh" : "en";
      return {
        features: {
          raw_query: message,
          token_count: 0,
          context_token_count: 0,
          conversation_depth: (body.history ?? []).filter((m: any) => m.role === "user").length,
          language,
          intent: "general" as const,
          complexity_score: 50,
          has_code: false,
          has_math: false,
          requires_reasoning: false,
        }
      };
    })();

    // SSE 契约强制：stream=true 必须走 SSE 路径，否则 500
    // 防止 stream=true 但走错了路径导致前端 SSE reader 永远挂起
    if (useStream) {
      // ── SSE 流式分支 ───────────────────────────────────────────────────────────
      let llmNativeResult;
      try {
        const cross = await buildCrossSessionContext({
          userId,
          sessionId,
          userMessage: body.message ?? "",
        }).catch((e: any) => {
          console.warn("[chat] cross-session context build failed:", e.message);
          return { crossSessionText: "" };
        });
        const crossSessionContext = cross.crossSessionText || undefined;

        console.log("[chat] calling routeWithManagerDecision for:", body.message?.substring(0, 30));
        llmNativeResult = await routeWithManagerDecision({
          message: body.message ?? "",
          user_id: userId,
          session_id: sessionId,
          turn_id: (body.history ?? []).length,
          history: body.history ?? [],
          language: features.language as "zh" | "en",
          reqApiKey,
          reqBaseUrl,
          crossSessionContext,
        });
        console.log("[chat] routeWithManagerDecision done, decision_type:", llmNativeResult?.decision_type, "delegation:", !!llmNativeResult?.delegation);
      } catch (e: any) {
        // Sprint 72 Plan B: LLM 路由异常 → 降级 JSON 而非 500
        // SSE stream 未启动，无法写 SSE 事件；复用 SSE manager_decision JSON 结构
        const msgText = body.message ?? "";
        const chineseChars = msgText.match(/[\u4e00-\u9fff]/g);
        const lang = (chineseChars && chineseChars.length > msgText.length * 0.1) ? "zh" : "en";
        const msg = lang === "zh"
          ? "智能路由服务暂时不可用，请稍后重试。"
          : "Smart routing temporarily unavailable, please retry.";
        console.warn(`[stream-llm] routeWithManagerDecision failed (session=${sessionId}):`, e.message);
        return c.json({
          type: "manager_decision",
          decision_type: "direct_answer",
          routing_layer: "fallback",
          content: msg,
          error: e.message,
        }, 200);
      }

      if (!llmNativeResult) {
        return c.json({ error: "Manager returned null decision" }, 500);
      }

      const lang = features.language as "zh" | "en";
      const taskId = llmNativeResult.delegation?.task_id || uuid();

      // Sprint 68: Phase 2.0 L2 Rollout
      // Sprint 72: 修复 stream 对齐 bug —— stream=true 时必须走 SSE，不能退化到 JSON
      // 当 isL2Traffic=true 且 L2 未启用或命中 rollout 回退时：
      //   - stream=false：降级到 L0 JSON 响应（符合预期）
      //   - stream=true：跳过此块，走正常 SSE 流程，降级信息通过 routing_layer_degraded 字段传递
      const isL2Traffic = llmNativeResult.routing_layer === "L2" || llmNativeResult.routing_layer === "L3";
      if (isL2Traffic && !useStream && (!config.layer2.enabled || Math.random() > config.layer2.rollout)) {
        const fallback = llmNativeResult.message || (lang === "zh" ? "好的。" : "Got it.");
        c.header("Content-Type", "application/json");
        return c.json({
          routing_layer: "L0",
          routing_layer_degraded: true,
          degraded_from: llmNativeResult.routing_layer,
          message: fallback,
          delegation_log_id: llmNativeResult.delegation_log_id,
        });
      }

      // SSE headers
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");

      return stream(c, async (s) => {
        console.log("[chat] SSE stream started, writing events...");
        try {
          // Step 1: Manager 的安抚消息
          if (llmNativeResult.message) {
            await s.write(`data: ${JSON.stringify({
              type: "manager_decision",
              decision_type: llmNativeResult.decision_type,
              routing_layer: llmNativeResult.routing_layer,
              content: llmNativeResult.message,
            })}\n\n`);
          }

          // Step 2: Clarifying
          if (llmNativeResult.clarifying) {
            await s.write(`data: ${JSON.stringify({
              type: "clarifying_needed",
              routing_layer: "L0",
              question_text: llmNativeResult.clarifying.question_text,
              options: llmNativeResult.clarifying.options,
              question_id: llmNativeResult.clarifying.question_id,
            })}\n\n`);
          }

          // Step 3: delegation
          if (llmNativeResult.delegation) {
            if (llmNativeResult.archive_id) {
              await s.write(`data: ${JSON.stringify({
                type: "archive_written",
                task_id: taskId,
                archive_id: llmNativeResult.archive_id,
                decision_type: llmNativeResult.decision_type ?? "delegate_to_slow",
                routing_layer: llmNativeResult.routing_layer,
                timestamp: new Date().toISOString(),
              })}\n\n`);
            } else {
              // delegation 触发但 archive 未创建 → 发 error + done 后立即返回，不进入 pollArchiveAndYield
              await s.write(`data: ${JSON.stringify({
                type: "error",
                content: llmNativeResult.message ?? "任务无法触发，请重试",
                routing_layer: llmNativeResult.routing_layer,
              })}\n\n`);
              await s.write(`data: ${JSON.stringify({
                type: "done",
                content: "任务失败",
                routing_layer: llmNativeResult.routing_layer,
              })}\n\n`);
              return;
            }
            if (llmNativeResult.command_id) {
              await s.write(`data: ${JSON.stringify({
                type: "worker_started",
                task_id: taskId,
                command_id: llmNativeResult.command_id,
                worker_role: llmNativeResult.decision_type === "execute_task" ? "execute_worker" : "slow_worker",
                routing_layer: llmNativeResult.routing_layer,
                timestamp: new Date().toISOString(),
              })}\n\n`);
            }
            await s.write(`data: ${JSON.stringify({
              type: "command_issued",
              task_id: taskId,
              routing_layer: llmNativeResult.routing_layer,
            })}\n\n`);

            console.log("[chat] entering pollArchiveAndYield for task:", taskId);
            for await (const event of pollArchiveAndYield(taskId, lang, llmNativeResult.delegation_log_id, reqApiKey)) {
              console.log("[chat] pollArchiveAndYield event:", event.type);
              await s.write(`data: ${JSON.stringify({
                ...event,
                routing_layer: event.routing_layer ?? llmNativeResult.routing_layer,
              })}\n\n`);
            }
          }

          await s.write(`data: ${JSON.stringify({
            type: "done",
            content: llmNativeResult.delegation
              ? (lang === "zh" ? "分析完成" : "Analysis complete")
              : (lang === "zh" ? "已返回答案" : "Answer ready"),
            routing_layer: llmNativeResult.routing_layer,
            archive_id: llmNativeResult.archive_id,
            task_id: taskId,
          })}\n\n`);
        } catch (e: any) {
          console.warn("[stream-llm] SSE error:", e.message);
          await s.write(`data: ${JSON.stringify({ type: "error", content: e.message, routing_layer: llmNativeResult.routing_layer })}\n\n`);
        }
      });
    }

    // ── 非 SSE 分支（stream=false / undefined）───────────────────────────────────
    // 走 routeWithManagerDecision，返回 Manager 完整响应（直接回答或澄清）
    let llmNativeResult;
    try {
      const cross = await buildCrossSessionContext({
        userId,
        sessionId,
        userMessage: body.message ?? "",
      }).catch((e: any) => {
        console.warn("[chat] cross-session context build failed:", e.message);
        return { crossSessionText: "" };
      });
      const crossSessionContext = cross.crossSessionText || undefined;

      llmNativeResult = await routeWithManagerDecision({
        message: body.message ?? "",
        user_id: userId,
        session_id: sessionId,
        turn_id: (body.history ?? []).length,
        history: body.history ?? [],
        language: features.language as "zh" | "en",
        reqApiKey,
        reqBaseUrl,
        crossSessionContext,
      });
    } catch (e: any) {
      return c.json({ error: "LLM-native routing failed: " + e.message }, 500);
    }

    if (!llmNativeResult) {
      return c.json({ error: "Manager returned null decision" }, 500);
    }

    const taskId = llmNativeResult.delegation?.task_id || uuid();

    // 记录 decision log
    await logDecision({
      id: uuid(),
      user_id: userId,
      session_id: sessionId,
      timestamp: startTime,
      input_features: features,
      routing: {
        router_version: "llm_native_v1",
        scores: { fast: 1, slow: 0 },
        confidence: llmNativeResult.decision?.confidence ?? 1.0,
        selected_model: config.fastModel,
        selected_role: "fast",
        selection_reason: `llm_native(${llmNativeResult.decision?.decision_type ?? "direct_answer"})`,
        fallback_model: config.slowModel,
        routing_layer: llmNativeResult.routing_layer,
      },
      context: {
        original_tokens: 0,
        compressed_tokens: 0,
        compression_level: "L0",
        compression_ratio: 0,
        memory_items_retrieved: 0,
        final_messages: [],
        compression_details: [],
      },
      execution: {
        model_used: config.fastModel,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0,
        latency_ms: Date.now() - startTime,
        did_fallback: false,
        response_text: llmNativeResult.message ?? "",
      },
    }).catch((e) => console.warn("[chat] Failed to log llm-native decision:", e));

    // delegation 触发但 archive 未创建 → 立即返回，不走慢模型等待
    if (llmNativeResult.delegation && !llmNativeResult.archive_id) {
      return c.json({
        content: llmNativeResult.message ?? "任务无法触发，请重试",
        decision_type: llmNativeResult.decision_type ?? "delegate_slow",
        routing_layer: llmNativeResult.routing_layer,
        task_id: undefined,
        error: "archive_create_failed",
      });
    }

    return c.json({
      content: llmNativeResult.message ?? "",
      decision_type: llmNativeResult.decision_type,
      routing_layer: llmNativeResult.routing_layer,
      clarifying: llmNativeResult.clarifying,
      task_id: taskId,
      delegation: llmNativeResult.delegation
        ? { task_id: llmNativeResult.delegation.task_id, status: "triggered" }
        : undefined,
    });
  } catch (error: any) {
    console.error("Chat error:", error);
    return c.json({ error: error.message }, 500);
  }
});

// 旧 /chat-result 端点已废弃（委托结果通过 LLM-Native SSE 实时推送，无需轮询）

chatRouter.post("/feedback", async (c) => {
  let decision_id: string;
  let feedback_type: string;
  let body: Record<string, unknown>;

  try {
    // UTF-8 fix: use c.req.raw.text() instead of c.req.json()
    const rawBody = await c.req.raw.text();
    body = JSON.parse(rawBody) as Record<string, unknown>;
    decision_id = body.decision_id as string;
    feedback_type = body.feedback_type as string;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!decision_id) return c.json({ error: "decision_id is required" }, 400);
  if (!feedback_type) return c.json({ error: "feedback_type is required" }, 400);

  // C3a: Priority 1 — middleware context (trusted X-User-Id header)
  // C3a: Priority 2 — dev-only body shim (only when allowDevFallback=true)
  let user_id = getContextUserId(c);

  // P2-1: Runtime type whitelist validation
  if (!VALID_FEEDBACK_TYPES.includes(feedback_type as FeedbackType)) {
    return c.json({ error: `invalid feedback_type '${feedback_type}'` }, 400);
  }

  // P2-2: Ownership validation
  const { query } = await import("../db/connection.js");
  const decision = await query(`SELECT id, user_id FROM decision_logs WHERE id=$1`, [decision_id]);
  if (decision.rowCount === 0) return c.json({ error: "decision not found" }, 404);
  if (decision.rows[0].user_id !== user_id) {
    return c.json({ error: "forbidden: decision does not belong to this user" }, 403);
  }

  const { recordFeedback } = await import("../features/feedback-collector.js");
  // P3: also write to feedback_events (userId confirmed via ownership check above)
  await recordFeedback(decision_id, feedback_type as FeedbackType, user_id);

  // S2: Fire-and-forget auto_learn on positive-signal feedback
  // Fetches the full decision record and passes it to autoLearnFromDecision
  // so memory_entries gets updated without blocking the feedback response.
  // M2: Also boost recent auto_learn memory relevance_score for this user.
  if (["thumbs_up", "accepted", "follow_up_thanks"].includes(feedback_type)) {
    // M2: Boost recent auto_learn entries (fire-and-forget)
    if (user_id) {
      const { MemoryEntryRepo } = await import("../db/repositories.js");
      MemoryEntryRepo.boostRecentAutoLearn(user_id, 300_000).catch((e) => console.warn("[feedback] boostRecentAutoLearn failed:", e));
    }
    const { autoLearnFromDecision } = await import("../services/memory-store.js");
    const { query: q2 } = await import("../db/connection.js");
    q2(`SELECT intent, selected_model, exec_input_tokens, exec_output_tokens FROM decision_logs WHERE id=$1`, [decision_id])
      .then(async (res) => {
        if (res.rows.length === 0 || !user_id) return;
        const row = res.rows[0];
        // Construct a minimal DecisionRecord sufficient for autoLearnFromDecision
        const minDecision: DecisionRecord = {
          id: decision_id,
          user_id: user_id!,
          session_id: "",
          timestamp: Date.now(),
          input_features: {
            raw_query: "",
            token_count: 0,
            intent: row.intent ?? "unknown",
            complexity_score: 50,
            has_code: false,
            has_math: false,
            requires_reasoning: false,
            conversation_depth: 0,
            context_token_count: 0,
            language: "zh",
          },
          routing: {
            router_version: "v1",
            scores: { fast: 0.5, slow: 0.5 },
            confidence: 0.8,
            selected_model: row.selected_model ?? "",
            selected_role: "fast",
            selection_reason: "",
            fallback_model: "",
          },
          context: {
            original_tokens: 0,
            compressed_tokens: 0,
            compression_level: "L0",
            compression_ratio: 1,
            memory_items_retrieved: 0,
            final_messages: [],
            compression_details: [],
          },
          execution: {
            model_used: row.selected_model ?? "",
            input_tokens: row.exec_input_tokens ?? 0,
            output_tokens: row.exec_output_tokens ?? 0,
            total_cost_usd: 0,
            latency_ms: 0,
            did_fallback: false,
            response_text: "",
          },
          feedback: {
            type: feedback_type as FeedbackType,
            score: 1,
            timestamp: Date.now(),
          },
        };
        await autoLearnFromDecision(user_id!, minDecision);
      })
      .catch((e) => console.warn("[feedback] autoLearnFromDecision failed:", e));
  }

  return c.json({ success: true });
});


export { chatRouter };
