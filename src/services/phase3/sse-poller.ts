/**
 * SSE Poller — 从 orchestrator.ts 提取的 SSE 流式轮询逻辑
 * 轮询 TaskArchive，感知状态变化，推送 SSE 事件
 */
import type { RoutingLayer } from "../../types/index.js";
import { callModelFull, callModelStream } from "../../models/model-gateway.js";
import { config } from "../../config.js";
import type { ChatMessage } from "../../types/index.js";
import type { DelegationLogExecutionUpdate } from "../../types/index.js";
import {
  TaskArchiveRepo,
  TaskWorkerResultRepo,
  TaskArchiveEventRepo,
} from "../../db/task-archive-repo.js";
import { DelegationLogRepo } from "../../db/repositories.js";

// ── SSE 事件类型 ─────────────────────────────────────────────────────────────

export interface SSEEvent {
  type: "status" | "result" | "error" | "done" | "chunk" | "fast_reply"
       | "worker_completed" | "manager_synthesized"; // Phase 3.0
  /** Sprint 73: 统一使用 content 字段，stream 保留兼容 */
  content?: string;
  stream?: string;
  /** 路由分层（L0/L1/L2/L3） */
  routing_layer?: RoutingLayer;
  /** Clarifying 事件可选字段 */
  options?: string[];
  question_id?: string;
  /** worker_completed 事件字段 */
  task_id?: string;
  command_id?: string;
  worker_type?: string;
  summary?: string;
  /** manager_synthesized 事件字段 */
  final_content?: string;
  confidence?: number;
}

// ── Manager Synthesis Prompt ───────────────────────────────────────────────────

const MANAGER_SYNTHESIS_PROMPT = {
  zh: (workerResult: string) =>
`用户的问题已经被执行专家分析完毕。
下面是执行专家的原始分析结果：

---
${workerResult}
---

请将以上分析结果整合成一段自然、简洁的回复，直接面向用户。
要求：
- 不重复"以下是分析结果"等废话
- 直接用自然的段落或要点呈现结论
- 如果有多个发现，按重要性排序
- 如果有数据或引用，说明来源
- 保持与用户对话的语气，不要写成报告`,
  en: (workerResult: string) =>
`The user's question has been analyzed by the execution specialist.
Here is the specialist's raw analysis:

---
${workerResult}
---

Please synthesize this into a natural, concise response for the user.
Requirements:
- Don't repeat filler like "Here are the analysis results"
- Present conclusions naturally as paragraphs or bullet points
- If multiple findings, order by importance
- If data or citations, mention the source
- Keep a conversational tone, not a report style`,
};

// ── Manager Synthesis ──────────────────────────────────────────────────────────

async function synthesizeManagerOutput(
  taskId: string,
  workerResult: string,
  confidence: number,
  lang: "zh" | "en"
): Promise<string | null> {
  try {
    const archive = await TaskArchiveRepo.getById(taskId);
    if (!archive) return workerResult;

    const userInput = archive.user_input ?? "";

    const systemPrompt = lang === "zh"
      ? "你是 SmartRouter Pro 的管理模型（Manager）。负责把执行专家的结果整合成最终回复。"
      : "You are SmartRouter Pro's Manager model. Your job is to synthesize execution results into the final user-facing response.";

    const userPrompt = MANAGER_SYNTHESIS_PROMPT[lang](workerResult);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `用户原始问题：${userInput}\n\n${userPrompt}` },
    ];

    const resp = await callModelFull(config.fastModel, messages);
    return resp.content.trim() || workerResult;
  } catch (e: any) {
    console.warn("[synthesizeManagerOutput] Manager synthesis failed:", e.message);
    return null;
  }
}

/**
 * 流式 Manager Synthesis — 边生成边 yield SSE chunk 事件。
 * yield { type: "chunk", content: string }
 * yield { type: "chunk", content: "" }  // 结束
 */
async function* synthesizeManagerOutputStream(
  taskId: string,
  workerResult: string,
  confidence: number,
  lang: "zh" | "en",
  reqApiKey?: string
): AsyncGenerator<{ type: "chunk"; content: string; routing_layer: RoutingLayer }> {
  try {
    const archive = await TaskArchiveRepo.getById(taskId);
    if (!archive) return;

    const userInput = archive.user_input ?? "";

    const systemPrompt = lang === "zh"
      ? "你是 SmartRouter Pro 的管理模型（Manager）。负责把执行专家的结果整合成最终回复。"
      : "You are SmartRouter Pro's Manager model. Your job is to synthesize execution results into the final user-facing response.";

    const userPrompt = MANAGER_SYNTHESIS_PROMPT[lang](workerResult);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `用户原始问题：${userInput}\n\n${userPrompt}` },
    ];

    let firstChunk = true;
    let buffer = "";

    for await (const chunk of callModelStream(config.fastModel, messages, reqApiKey)) {
      buffer += chunk;
      if (firstChunk) {
        // 第一个 chunk 前发一个状态消息，让前端知道开始流式输出了
        yield {
          type: "chunk",
          content: lang === "zh" ? "📝 正在整理回复...\n" : "📝 Organizing response...\n",
          routing_layer: "L2",
        };
        firstChunk = false;
      }
      yield { type: "chunk", content: chunk, routing_layer: "L2" };
    }

    // 空结果降级为原始 worker 结果
    if (!buffer.trim()) {
      yield { type: "chunk", content: `\n\n${workerResult}`, routing_layer: "L2" };
    }
  } catch (e: any) {
    console.warn("[synthesizeManagerOutputStream] Stream failed, falling back to raw result:", e.message);
    yield { type: "chunk", content: `\n\n${workerResult}`, routing_layer: "L2" };
  }
}

// ── Sleep Helper ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── SSE Poller ────────────────────────────────────────────────────────────────

/**
 * 轮询 TaskArchive，感知状态变化，推送 SSE 事件
 * 嵌入用户体验安抚消息（30s/60s/120s 节点）
 * @param delegation_log_id G4: delegation_logs 主键 ID，用于异步回写 execution 结果
 * @param reqApiKey 可选的 API Key（用于流式 Manager Synthesis）
 */
export async function* pollArchiveAndYield(
  taskId: string,
  lang: "zh" | "en",
  delegation_log_id?: string,
  reqApiKey?: string
): AsyncGenerator<SSEEvent> {
  // 自适应轮询间隔
  const getPollInterval = (elapsedMs: number): number => {
    if (elapsedMs < 10000) return 2000;
    if (elapsedMs < 60000) return 3000;
    return 5000;
  };

  const MESSAGES = {
    zh: {
      running30s: "🔄 任务比较复杂，正在深度分析...",
      running60s: "⏳ 资料已找到，正在整理对比...",
      running120s: "🔄 仍在执行，请继续等待...",
      done: "慢模型分析完成，结果如下：",
    },
    en: {
      running30s: "🔄 Task is complex, analyzing deeply...",
      running60s: "⏳ Data found, comparing results...",
      running120s: "🔄 Still running, please wait...",
      done: "Slow model analysis complete:",
    },
  };

  const msgs = MESSAGES[lang] ?? MESSAGES.zh;
  const startTime = Date.now();
  let lastStatusTime = startTime;
  let lastPingTime = startTime;
  let sentResult = false;

  while (true) {
    const task = await TaskArchiveRepo.getById(taskId);
    if (!task) break;

    const elapsed = Date.now() - startTime;

    // SSE Keepalive ping：每 15s 发一次，防止浏览器/代理断连
    if (elapsed - lastPingTime >= 15000) {
      yield { type: "status", stream: "", routing_layer: "L2" }; // 空内容，客户端忽略但保活
      lastPingTime = Date.now();
    }

    // 安抚消息（30s / 60s / 120s 节点）
    if (task.status === "running" || task.status === "pending") {
      if (elapsed > 30000 && elapsed < 31000 && lastStatusTime < 30000) {
        yield { type: "status", stream: msgs.running30s, routing_layer: "L2" };
        lastStatusTime = Date.now();
      } else if (elapsed > 60000 && elapsed < 61000 && lastStatusTime < 60000) {
        yield { type: "status", stream: msgs.running60s, routing_layer: "L2" };
        lastStatusTime = Date.now();
      } else if (elapsed > 120000 && elapsed < 121000) {
        const sixtySecondMarker = Math.floor((elapsed - 120000) / 60000);
        if (elapsed < 120000 + 60000 * sixtySecondMarker + 1000 && elapsed >= 120000 + 60000 * sixtySecondMarker) {
          yield { type: "status", stream: msgs.running120s, routing_layer: "L2" };
          lastStatusTime = Date.now();
        }
      }
    }

    if (task.status === "done") {
      if (!task.delivered) {
        const execution: Record<string, unknown> = task.slow_execution ?? {};
        const workerResult = typeof execution.result === "string"
          ? execution.result
          : "";
        const workerConfidence = (execution.confidence as number) ?? 0.7;

        // 写入 worker_completed 事件到 DB
        try {
          await TaskArchiveEventRepo.create({
            archive_id: taskId,
            task_id: taskId,
            event_type: "worker_completed",
            payload: {
              worker_role: execution.worker_role ?? "slow_worker",
              summary: workerResult.substring(0, 200),
              confidence: workerConfidence,
            },
            actor: (execution.worker_role as string) ?? "slow_worker",
          });
        } catch (e: any) {
          console.warn("[pollArchiveAndYield] worker_completed event write failed:", e.message);
        }

        // 推送 worker_completed SSE 事件
        yield {
          type: "worker_completed",
          task_id: taskId,
          command_id: taskId,
          worker_type: execution.worker_role as any ?? "slow_worker",
          summary: workerResult.substring(0, 200),
          routing_layer: "L2",
        };

        // G4: 回写 delegation_logs execution 结果
        if (delegation_log_id) {
          let cost_usd: number | null = null;
          let latency_ms: number | null = null;

          try {
            const workerResultRecord = await TaskWorkerResultRepo.getByCommandId(taskId);
            if (workerResultRecord) {
              cost_usd = workerResultRecord.cost_usd;
              if (workerResultRecord.started_at && workerResultRecord.completed_at) {
                latency_ms = new Date(workerResultRecord.completed_at).getTime()
                  - new Date(workerResultRecord.started_at).getTime();
              }
            }
          } catch (e: any) {
            console.warn("[pollArchiveAndYield] getByCommandId failed:", e.message);
          }

          if (latency_ms === null && execution.started_at) {
            const startedMs = new Date(execution.started_at as string).getTime();
            latency_ms = startedMs > 0 ? Date.now() - startedMs : null;
          }

          const execUpdate: Partial<DelegationLogExecutionUpdate> = {
            execution_status: "success",
            execution_correct: true, // G4: Worker 执行成功，标记 execution_correct
            model_used: (execution.worker_role as string) ?? "slow_worker",
            latency_ms: latency_ms ?? undefined,
            cost_usd: cost_usd ?? undefined,
          };
          DelegationLogRepo.updateExecution(delegation_log_id, execUpdate as DelegationLogExecutionUpdate)
            .catch((e) => console.warn("[delegation-log] updateExecution failed:", e.message));
        }

        // Manager Synthesis — 流式输出，边生成边推送到前端
        sentResult = true;
        try {
          // 发一个"开始整理"的提示
          yield {
            type: "result",
            content: `${msgs.done}\n\n`,
            routing_layer: "L2",
          };

          // 流式 yield chunks，直接推给前端
          for await (const chunkEvent of synthesizeManagerOutputStream(taskId, workerResult, workerConfidence, lang, reqApiKey)) {
            yield chunkEvent;
          }
        } catch (e: any) {
          console.warn("[pollArchiveAndYield] Manager synthesis failed, using raw result:", e.message);
          yield {
            type: "result",
            content: `${msgs.done}\n\n${workerResult}`,
            routing_layer: "L2",
          };
        }

        // SSE1: 成功路径也发送 done 事件（与 failed/timeout 路径一致）
        yield { type: "done", content: lang === "zh" ? "分析完成" : "Analysis complete", routing_layer: "L2" };

        await TaskArchiveRepo.markDelivered(taskId).catch((e) =>
          console.warn("[pollArchiveAndYield] markDelivered failed:", e?.message)
        );
      }
      break;
    }

    if (task.status === "failed") {
      // G4: 回写 delegation_logs execution 结果（failed）
      if (delegation_log_id) {
        const exec = task.slow_execution as Record<string, unknown> | null;
        const errors = (Array.isArray(exec?.errors) ? exec.errors : []) as string[];
        DelegationLogRepo.updateExecution(delegation_log_id, {
          execution_status: "failed",
          execution_correct: false, // G4: Worker 执行失败，标记 execution_correct
          error_message: errors[0] ?? "Unknown error",
        }).catch((e) => console.warn("[delegation-log] updateExecution failed:", e.message));
      }
      const exec = task.slow_execution as Record<string, unknown> | null;
      const errors = (Array.isArray(exec?.errors) ? exec.errors : []) as string[];
      if (!sentResult) {
        yield { type: "error", content: `任务执行失败: ${errors[0] ?? "Unknown error"}`, routing_layer: "L2" };
      }
      yield { type: "done", content: lang === "zh" ? "执行失败" : "Execution failed", routing_layer: "L2" };
      await TaskArchiveRepo.markDelivered(taskId).catch((e) =>
        console.warn("[pollArchiveAndYield] markDelivered failed:", e?.message)
      );
      break;
    }

    // G4: 超时检测（超过 180s 未完成，标记为 timeout）
    if (elapsed > 180_000 && (task.status === "running" || task.status === "pending")) {
      if (delegation_log_id) {
        DelegationLogRepo.updateExecution(delegation_log_id, {
          execution_status: "timeout",
          execution_correct: false, // G4: Worker 超时，标记 execution_correct
          error_message: "Task execution exceeded 180s timeout",
        }).catch((e) => console.warn("[delegation-log] updateExecution timeout failed:", e.message));
      }
      if (!sentResult) {
        yield {
          type: "error",
          content: lang === "zh"
            ? "⏱ 任务执行超时（180s），请稍后重试或简化问题"
            : "⏱ Task execution timed out (180s), please retry or simplify your request",
          routing_layer: "L2",
        };
      }
      yield { type: "done", content: lang === "zh" ? "任务超时" : "Task timed out", routing_layer: "L2" };
      await TaskArchiveRepo.markDelivered(taskId).catch((e) =>
        console.warn("[pollArchiveAndYield] markDelivered failed:", e?.message)
      );
      break;
    }

    const interval = getPollInterval(Date.now() - startTime);
    await sleep(interval);
  }
}
