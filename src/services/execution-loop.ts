/**
 * Execution Loop — executes a plan step by step.
 *
 * Approach (EL-003):
 * - Sequential state machine: runs steps in plan order, no branching.
 * - For `tool_call` steps: calls the model with Function Calling tools enabled.
 *   The model decides whether to emit a tool call based on the current context.
 *   The loop executes the tool and appends the result back to messages.
 * - For `reasoning` steps: calls the model without tools; model generates
 *   an intermediate conclusion which is appended to messages.
 * - For `synthesis` steps: calls the model to produce the final answer.
 * - Hard guards: max steps, max tool calls, per-tool timeout, no-progress abort.
 * - All execution events written to task_traces for auditability.
 *
 * Scope (v1):
 * - Linear plan execution only
 * - No dynamic re-planning
 * - No parallel tool execution
 * - No step-level retries (hard failure → loop aborts)
 */

import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import type { ChatMessage } from "../types/index.js";
import type { ExecutionPlan, ExecutionStep } from "../types/index.js";
import { callModelWithTools, callModelFull } from "../models/model-gateway.js";
import { toolRegistry } from "../tools/registry.js";
import { toolExecutor, type ToolHandlerContext } from "../tools/executor.js";
import { TaskRepo } from "../db/repositories.js";

// ── Loop configuration ────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_TOOL_CALLS = 20;
const DEFAULT_SLOW_MODEL = config.slowModel;

/** Context for a single execution run */
export interface LoopContext {
  taskId: string;
  userId: string;
  sessionId: string;
  model?: string;
  maxSteps?: number;
  maxToolCalls?: number;
}

/** Final result of a completed execution loop */
export interface LoopResult {
  taskId: string;
  plan: ExecutionPlan;
  messages: ChatMessage[];
  finalContent: string;
  completedSteps: number;
  totalSteps: number;
  toolCallsExecuted: number;
  reason: "completed" | "step_cap" | "tool_cap" | "no_progress" | "error";
}

// ── System prompt for the execution model ────────────────────────────────────

function buildLoopSystemPrompt(stepTitle: string, stepDescription: string, isLastStep: boolean): string {
  const base = "You are executing a task step. You have access to registered tools via Function Calling.";

  const stepInstruction = isLastStep
    ? `This is the FINAL step. Your job is to synthesize all information gathered so far and produce a clear, complete answer to the user's original question. Do NOT call tools in the final step — synthesize directly.`
    : `Current step: "${stepTitle}". ${stepDescription}. Execute this step using the available tools if needed. If the step can be completed with reasoning alone, produce your conclusion directly.`;

  return `${base}\n\n${stepInstruction}`;
}

// ── Trace helpers ─────────────────────────────────────────────────────────────

async function writeTrace(params: {
  taskId: string;
  stepId: string;
  type: "step_start" | "step_complete" | "step_failed" | "loop_start" | "loop_end";
  detail: Record<string, unknown>;
}): Promise<void> {
  try {
    await TaskRepo.createTrace({
      id: uuid(),
      task_id: params.taskId,
      type: params.type,
      detail: params.detail,
    });
  } catch (e) {
    console.warn("[execution-loop] Failed to write trace:", e);
  }
}

// ── Count tool calls in message array ─────────────────────────────────────────

function countToolCalls(messages: ChatMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray((msg as any).tool_calls)) {
      count += (msg as any).tool_calls.length;
    }
  }
  return count;
}

// ── Execution Loop ────────────────────────────────────────────────────────────

export class ExecutionLoop {
  /**
   * Execute a plan end-to-end.
   *
   * Returns a LoopResult containing the final message content and loop stats.
   * All step events are written to task_traces.
   */
  async run(initialPlan: ExecutionPlan, ctx: LoopContext): Promise<LoopResult> {
    const {
      taskId,
      userId,
      sessionId,
      model = DEFAULT_SLOW_MODEL,
      maxSteps = DEFAULT_MAX_STEPS,
      maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    } = ctx;

    const messages: ChatMessage[] = [];
    let currentStepIndex = initialPlan.current_step_index;
    let toolCallsExecuted = 0;
    let lastToolCallCount = 0;
    let consecutiveNoProgress = 0;

    // Deep-copy the steps array so that step mutations (status, error) do not
    // leak back into the caller's original plan object.
    const plan: ExecutionPlan = {
      ...initialPlan,
      steps: initialPlan.steps.map((s) => ({ ...s })),
    };

    await writeTrace({
      taskId,
      stepId: "loop",
      type: "loop_start",
      detail: {
        total_steps: plan.steps.length,
        max_steps: maxSteps,
        max_tool_calls: maxToolCalls,
        model,
      },
    });

    try {
      // ── Step loop ───────────────────────────────────────────────────────────
      while (currentStepIndex < plan.steps.length && currentStepIndex < maxSteps) {
        const step = plan.steps[currentStepIndex];
        const isLastStep = currentStepIndex === plan.steps.length - 1;

        await writeTrace({
          taskId,
          stepId: step.id,
          type: "step_start",
          detail: {
            step_index: currentStepIndex,
            step_title: step.title,
            step_type: step.type,
            tool_name: step.tool_name,
          },
        });

        step.status = "running";

        let stepError: string | undefined;

        try {
          if (step.type === "tool_call") {
            await this.#executeToolStep(
              step, messages, model, taskId, userId, sessionId, plan.steps, currentStepIndex
            );
            const newCalls = countToolCalls(messages) - lastToolCallCount;
            toolCallsExecuted += newCalls;
            lastToolCallCount = countToolCalls(messages);
            // Emit of any tool call counts as meaningful progress — reset no-progress counter
            if (newCalls > 0) {
              consecutiveNoProgress = 0;
            }
          } else if (step.type === "reasoning") {
            await this.#executeReasoningStep(
              step, messages, model, taskId, plan.steps, currentStepIndex
            );
            // Check for no-progress: reasoning step with no new tool calls
            if (countToolCalls(messages) === lastToolCallCount) {
              consecutiveNoProgress++;
            } else {
              consecutiveNoProgress = 0;
            }
          } else {
            // synthesis / unknown — treat as final synthesis
            await this.#executeSynthesisStep(
              step, messages, model, taskId, plan.steps, currentStepIndex
            );
          }

          step.status = "completed";
        } catch (err: unknown) {
          step.status = "failed";
          stepError = err instanceof Error ? err.message : String(err);
          step.error = stepError;

          await writeTrace({
            taskId,
            stepId: step.id,
            type: "step_failed",
            detail: { error: stepError },
          });

          // All step errors → re-throw so outer catch aborts the loop uniformly.
          // GuardrailRejection (has isGuardrailRejection=true) is hard policy signal;
          // other errors (DB failures, etc.) also cannot be safely continued.
          throw err;
        }

        // Advance to next step after successful completion
        currentStepIndex++;

        await writeTrace({
          taskId,
          stepId: step.id,
          type: "step_complete",
          detail: {
            step_index: currentStepIndex - 1,
            step_type: step.type,
            tool_calls_this_step: step.type === "tool_call"
              ? countToolCalls(messages) - lastToolCallCount
              : 0,
          },
        });

        // ── Hard abort checks ───────────────────────────────────────────────
        if (toolCallsExecuted >= maxToolCalls) {
          await writeTrace({ taskId, stepId: "loop", type: "loop_end", detail: { reason: "tool_cap", tool_calls: toolCallsExecuted } });
          return this.#buildResult(plan, messages, currentStepIndex, toolCallsExecuted, "tool_cap");
        }

        if (consecutiveNoProgress >= 3) {
          await writeTrace({ taskId, stepId: "loop", type: "loop_end", detail: { reason: "no_progress", consecutive_no_progress: consecutiveNoProgress } });
          return this.#buildResult(plan, messages, currentStepIndex, toolCallsExecuted, "no_progress");
        }
      }

      // ── Determine end reason ──────────────────────────────────────────────
      let reason: LoopResult["reason"] = "completed";
      if (currentStepIndex >= maxSteps && currentStepIndex < plan.steps.length) {
        reason = "step_cap";
      } else if (toolCallsExecuted >= maxToolCalls) {
        reason = "tool_cap";
      } else if (consecutiveNoProgress >= 3) {
        reason = "no_progress";
      }

      await writeTrace({
        taskId,
        stepId: "loop",
        type: "loop_end",
        detail: {
          reason,
          completed_steps: currentStepIndex,
          total_steps: plan.steps.length,
          tool_calls_executed: toolCallsExecuted,
        },
      });

      return this.#buildResult(plan, messages, currentStepIndex, toolCallsExecuted, reason);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await writeTrace({
        taskId,
        stepId: "loop",
        type: "loop_end",
        detail: { reason: "error", error: message },
      });
      // currentStepIndex points to the failed step; +1 because "completedSteps" = steps attempted
      return this.#buildResult(plan, messages, currentStepIndex + 1, toolCallsExecuted, "error");
    }
  }

  // ── Tool step ────────────────────────────────────────────────────────────────

  /**
   * For a tool_call step, the model is given the current conversation + available
   * tool schemas. It may emit zero or more tool_calls. The loop executes each
   * tool call and appends the results back to the message array.
   *
   * If the step specifies a tool_name, the model is forced to use that tool.
   */
  async #executeToolStep(
    step: ExecutionStep,
    messages: ChatMessage[],
    model: string,
    taskId: string,
    userId: string,
    sessionId: string,
    allSteps: ExecutionStep[],
    stepIndex: number,
  ): Promise<void> {
    const tools = toolRegistry.getFunctionCallingSchemas();
    const systemPrompt = buildLoopSystemPrompt(
      step.title,
      step.description ?? step.title,
      stepIndex === allSteps.length - 1,
    );

    // Build system message with optional forced tool instruction
    const systemContent = step.tool_name
      ? `${systemPrompt}\n\nIMPORTANT: You MUST use the "${step.tool_name}" tool for this step. Do not respond directly.`
      : systemPrompt;

    const toolMessages: ChatMessage[] = [
      ...messages,
      { role: "system", content: systemContent },
    ];

    const response = await callModelWithTools(model, toolMessages, tools);

    // Add model's response (may contain tool_calls or text) to message history
    messages.push({
      role: "assistant",
      content: response.content || "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool_calls: (response as any).tool_calls,
    });

    // Execute any tool calls emitted by the model
    const toolCalls = (response as any).tool_calls ?? [];
    for (const tc of toolCalls) {
      console.log("[EXEC-DEBUG] about to call toolExecutor.execute for", tc.function?.name);
      const toolCtx: ToolHandlerContext = { userId, sessionId, taskId };
      const result = await toolExecutor.execute(
        { id: tc.id ?? uuid(), tool_name: tc.function.name, arguments: JSON.parse(tc.function.arguments) },
        toolCtx,
      );

      const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: tc.id ?? uuid(),
        content: result.success
          ? JSON.stringify(result.result)
          : `Error: ${result.error}`,
      };
      messages.push(toolMessage);
    }
  }

  // ── Reasoning step ───────────────────────────────────────────────────────────

  /**
   * For a reasoning step, the model is called without tools.
   * It generates an intermediate conclusion which is appended to the message history.
   */
  async #executeReasoningStep(
    step: ExecutionStep,
    messages: ChatMessage[],
    model: string,
    taskId: string,
    allSteps: ExecutionStep[],
    stepIndex: number,
  ): Promise<void> {
    const systemPrompt = buildLoopSystemPrompt(
      step.title,
      step.description ?? step.title,
      stepIndex === allSteps.length - 1,
    );

    const reasoningMessages: ChatMessage[] = [
      ...messages,
      { role: "system", content: `${systemPrompt}\n\nDo not call any tools for this step. Reason directly and produce your conclusion.` },
    ];

    const response = await callModelFull(model, reasoningMessages);
    messages.push({ role: "assistant", content: response.content || "" });
  }

  // ── Synthesis step ───────────────────────────────────────────────────────────

  /**
   * For a synthesis step (final step), the model produces the final answer
   * without tools. The content is appended to messages.
   */
  async #executeSynthesisStep(
    step: ExecutionStep,
    messages: ChatMessage[],
    model: string,
    taskId: string,
    allSteps: ExecutionStep[],
    stepIndex: number,
  ): Promise<void> {
    const systemPrompt = buildLoopSystemPrompt(
      step.title,
      step.description ?? step.title,
      true, // always last for synthesis
    );

    const synthesisMessages: ChatMessage[] = [
      ...messages,
      { role: "system", content: `${systemPrompt}\n\nThis is the final synthesis. Produce a clear, complete answer.` },
    ];

    const response = await callModelFull(model, synthesisMessages);
    messages.push({ role: "assistant", content: response.content || "" });
  }

  // ── Result builder ───────────────────────────────────────────────────────────

  #buildResult(
    plan: ExecutionPlan,
    messages: ChatMessage[],
    completedSteps: number,
    toolCallsExecuted: number,
    reason: LoopResult["reason"],
  ): LoopResult {
    // Extract final assistant content from the last message
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    return {
      taskId: plan.task_id,
      plan,
      messages,
      finalContent: lastAssistant?.content || "",
      completedSteps,
      totalSteps: plan.steps.length,
      toolCallsExecuted: toolCallsExecuted,
      reason,
    };
  }
}

/** Shared singleton instance */
export const executionLoop = new ExecutionLoop();
