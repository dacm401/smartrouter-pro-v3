// Phase 3.0: Execute Worker Loop
// backend/src/services/phase3/execute-worker-loop.ts
//
// 职责：后台轮询 task_commands WHERE command_type = 'execute_plan' AND status = 'queued'
//       → 调用 TaskPlanner.plan() + ExecutionLoop.run()
//       → 写回 task_archives.slow_execution
//       → 写 task_commands status = completed/failed
//
// 使用方式：在 index.ts 中 import { startExecuteWorker } from "./services/phase3/execute-worker-loop.js"

import { TaskArchiveRepo, TaskCommandRepo, TaskWorkerResultRepo } from "../../db/task-archive-repo.js";
import { taskPlanner } from "../task-planner.js";
import { executionLoop } from "../execution-loop.js";
import { config } from "../../config.js";
import type { CommandPayload, WorkerResult } from "../../types/index.js";

// 执行单个 execute 命令
async function executePlanCommand(
  commandRecord: {
    id: string;
    task_id: string;
    archive_id: string;
    user_id: string;
    payload_json: CommandPayload;
  }
): Promise<void> {
  const { id, task_id, archive_id, user_id, payload_json } = commandRecord;
  const startTime = Date.now();

  // 更新状态为 running
  await TaskCommandRepo.updateStatus(id, "running", { started_at: new Date() });
  await TaskArchiveRepo.updateState(archive_id, "running");

  try {
    const goal = payload_json.goal ?? payload_json.task_brief ?? "执行任务";
    const sessionId = archive_id; // 复用 archive_id 作为 session_id

    // Step 1: 生成执行计划
    let plan;
    try {
      plan = await taskPlanner.plan({
        taskId: task_id,
        goal,
        userId: user_id,
        sessionId,
      });
    } catch (planErr: any) {
      console.warn(`[execute-worker] TaskPlanner.plan failed for ${task_id}: ${planErr.message}`);
      // 即使 plan 失败也尝试执行（用空计划）
      plan = undefined;
    }

    const planStepCount = plan?.steps.length ?? 0;
    console.log(`[execute-worker] Executing task ${task_id} with ${planStepCount} steps`);

    // Step 2: 运行执行循环
    let finalContent = "";
    let completedSteps = 0;
    let toolCalls = 0;

    try {
      if (plan) {
        const loopResult = await executionLoop.run(plan, {
          taskId: task_id,
          userId: user_id,
          sessionId,
          model: config.slowModel, // 从配置读取 slow 模型
          maxSteps: 10,
          maxToolCalls: 20,
        });
        finalContent = loopResult.finalContent ?? "";
        completedSteps = loopResult.completedSteps ?? 0;
        toolCalls = loopResult.toolCallsExecuted ?? 0;
      } else {
        // 无计划时直接用目标文字作为内容
        finalContent = `已收到任务：${goal}`;
      }
    } catch (loopErr: any) {
      console.error(`[execute-worker] ExecutionLoop.run failed for ${task_id}: ${loopErr.message}`);
      finalContent = `[执行出错] ${loopErr.message}`;
    }

    const totalMs = Date.now() - startTime;

    // 构造 WorkerResult
    const workerResult: WorkerResult = {
      task_id: task_id,
      worker_type: "execute_worker",
      status: plan ? "completed" : "partial",
      summary: finalContent.substring(0, 300),
      structured_result: {
        plan_steps: plan?.steps.map((s) => ({ id: s.id, title: s.title, type: s.type })) ?? [],
        completed_steps: completedSteps,
        tool_calls: toolCalls,
        final_content: finalContent,
      },
      confidence: 0.80,
    };

    // 写 task_worker_results（Phase 3 新表）
    await TaskWorkerResultRepo.create({
      task_id: task_id,
      archive_id: archive_id,
      command_id: id,
      user_id: user_id,
      worker_role: "execute_worker",
      result: workerResult,
      started_at: new Date(startTime),
    });

    // 写 task_archives.slow_execution（供 pollArchiveAndYield 轮询感知）
    await TaskArchiveRepo.setSlowExecution(archive_id, {
      result: finalContent,
      plan_steps: plan?.steps.length ?? 0,
      completed_steps: completedSteps,
      tool_calls: toolCalls,
      confidence: 0.80,
      completed_at: new Date().toISOString(),
    });
    // ✅ 通知 SSE poller：任务完成（sse-poller.ts line 241 依赖 status === "done"）
    await TaskArchiveRepo.updateState(archive_id, "done");

    // 更新 task_commands 状态为 completed
    await TaskCommandRepo.updateStatus(id, "completed", { finished_at: new Date() });
    // 更新 task_archives 状态为 done
    await TaskArchiveRepo.updateState(archive_id, "done");

    console.log(`[execute-worker] Completed task ${task_id} in ${totalMs}ms, ${completedSteps}/${planStepCount} steps`);
  } catch (err: any) {
    console.error(`[execute-worker] Failed to execute command ${id}:`, err.message);
    try {
      await TaskCommandRepo.updateStatus(id, "failed", {
        finished_at: new Date(),
        error_message: err.message,
      });
      await TaskArchiveRepo.updateState(archive_id, "failed");
      await TaskArchiveRepo.setSlowExecution(archive_id, {
        result: "",
        errors: [err.message],
        completed_at: new Date().toISOString(),
      });
      await TaskArchiveRepo.updateState(archive_id, "failed");
    } catch (updateErr: any) {
      console.error("[execute-worker] Failed to update status:", updateErr.message);
    }
  }
}

// 轮询循环
async function pollLoop(): Promise<void> {
  const POLL_INTERVAL_MS = 3000;

  while (true) {
    try {
      const { query } = await import("../../db/connection.js");
      const result = await query(
        `SELECT *
         FROM task_commands
         WHERE status = 'queued'
           AND command_type IN ('execute_plan', 'execute_research')
         ORDER BY
           CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
           issued_at ASC
         LIMIT 5`
      );

      if (result.rows.length > 0) {
        console.log(`[execute-worker] Found ${result.rows.length} queued execute command(s)`);
      }

      for (const row of result.rows) {
        const payload_json: CommandPayload = typeof row.payload_json === "string"
          ? JSON.parse(row.payload_json)
          : row.payload_json;

        await executePlanCommand({
          id: row.id,
          task_id: row.task_id,
          archive_id: row.archive_id,
          user_id: row.user_id,
          payload_json,
        });
      }
    } catch (err: any) {
      console.error("[execute-worker] Poll error:", err.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 启动入口 ─────────────────────────────────────────────────────────────

let workerStarted = false;

export function startExecuteWorker(): void {
  if (workerStarted) {
    console.log("[execute-worker] Already started, skipping");
    return;
  }
  workerStarted = true;

  console.log("[execute-worker] Starting execute worker loop...");
  pollLoop().catch((err) => {
    console.error("[execute-worker] Unhandled error in poll loop:", err.message);
    workerStarted = false;
  });
}
