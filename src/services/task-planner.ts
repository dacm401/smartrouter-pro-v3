/**
 * Task Planner — decomposes a complex user goal into an ordered execution plan.
 *
 * Approach (EL-002):
 * - Uses the main model with Function Calling to produce a structured plan.
 * - The model is instructed via a planning system prompt to emit a `plan_task` tool call
 *   containing the step sequence.
 * - This avoids a separate LLM call: planning happens in the same model invocation
 *   as the first loop iteration.
 * - Plans are linear (no branching, no self-reflection loops).
 *
 * Scope (v1):
 * - Linear step sequence only
 * - No dynamic re-planning
 * - No step-level retries
 * - Plan written to task_traces for auditability
 */

import { v4 as uuid } from "uuid";
import type { ChatMessage } from "../types/index.js";
import type { ExecutionPlan, ExecutionStep } from "../types/index.js";
import { callModelWithTools } from "../models/model-gateway.js";
import { toolRegistry } from "../tools/registry.js";
import { TaskRepo } from "../db/repositories.js";

/** Planning model: use configured slow model (Qwen2.5-72B via OpenRouter) */
import { config } from "../config.js";
const DEFAULT_PLANNER_MODEL = config.slowModel;

/** The tool name the model calls to submit a plan */
const PLANNER_TOOL_NAME = "plan_task";

/** The OpenAI-format tool schema for plan_task */
const PLAN_TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: PLANNER_TOOL_NAME,
    description:
      "Submit a structured execution plan for the user's goal. " +
      "Call this tool once with the complete plan. Do not respond with plain text.",
    parameters: {
      type: "object",
      properties: {
        goal_summary: {
          type: "string",
          description: "A one-sentence summary of the user's goal.",
        },
        steps: {
          type: "array",
          description: "Ordered list of steps to achieve the goal.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Short title for this step (max 10 words).",
              },
              description: {
                type: "string",
                description: "What this step does (1–2 sentences).",
              },
              kind: {
                type: "string",
                description: "Step type: 'tool_call' (calls a registered tool) or 'reasoning' (model generates the answer internally).",
                enum: ["tool_call", "reasoning"],
              },
              tool_name: {
                type: "string",
                description: "Name of the tool to call. Required if kind is 'tool_call'.",
              },
              expected_output: {
                type: "string",
                description: "What this step should produce (1 sentence).",
              },
            },
            required: ["title", "description", "kind", "expected_output"],
          },
        },
      },
      required: ["goal_summary", "steps"],
    },
  },
};

const PLANNER_SYSTEM_PROMPT = `You are a task planner. Your job is to break down complex user goals into an ordered sequence of steps.

Rules:
- Keep the plan as short as possible. Use the minimum number of steps needed.
- Each step must be either:
  - 'tool_call': requires calling a registered tool (memory_search, task_read, task_update, task_create, http_request, web_search)
  - 'reasoning': the model can complete this step without calling any tool
- Never call a tool for a 'reasoning' step.
- List steps in the correct execution order.
- If a tool is needed, specify the exact tool_name from the available tools.
- Be precise in 'expected_output': describe exactly what the step produces.

Return your plan by calling the plan_task tool. Do not respond with plain text.`;

export class TaskPlanner {
  /**
   * Produce an ExecutionPlan for a given goal.
   *
   * Uses Function Calling with the main model to generate a structured plan.
   * The plan is written to task_traces (type: "planning") for auditability.
   */
  async plan(params: {
    taskId: string;
    goal: string;
    userId: string;
    sessionId: string;
    model?: string;
    /** Optional execution result context to inform the planner (RR-003) */
    executionResultContext?: string;
  }): Promise<ExecutionPlan> {
    const { taskId, goal, userId, sessionId, model = DEFAULT_PLANNER_MODEL, executionResultContext } = params;

    const messages: ChatMessage[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      ...(executionResultContext
        ? [{ role: "system" as const, content: executionResultContext }]
        : []),
      {
        role: "user",
        content: `Goal: ${goal}\n\nAvailable tools:\n${toolRegistry.listTools().map((t) => `- ${t.name}: ${t.description}`).join("\n")}`,
      },
    ];

    const tools = [PLAN_TOOL_SCHEMA, ...toolRegistry.getFunctionCallingSchemas()];

    const response = await callModelWithTools(model, messages, tools);

    let plan = this.parsePlanFromResponse(response, taskId);

    // Fallback: if model didn't use plan_task tool, synthesize a minimal single-step plan
    if (!plan) {
      plan = this.synthesizeFallbackPlan(taskId, goal);
    }

    // Write the plan to traces for auditability
    try {
      await TaskRepo.createTrace({
        id: uuid(),
        task_id: taskId,
        type: "planning",
        detail: {
          goal,
          model,
          steps: plan.steps.map((s) => ({ id: s.id, title: s.title, type: s.type, tool_name: s.tool_name })),
          tool_calls_in_plan: plan.steps.filter((s) => s.tool_name).length,
        },
      });
    } catch (e) {
      console.warn("[planner] Failed to write planning trace:", e);
    }

    return plan;
  }

  /**
   * Parse the plan from the model's tool_call response.
   * Returns null if plan_task was not called.
   */
  private parsePlanFromResponse(
    response: import("../models/providers/base-provider.js").ModelResponse,
    taskId: string
  ): ExecutionPlan | null {
    const planCall = response.tool_calls?.find((tc) => tc.function.name === PLANNER_TOOL_NAME);
    if (!planCall) return null;

    let parsed: {
      goal_summary?: string;
      steps?: Array<{
        title?: string;
        description?: string;
        kind?: string;
        tool_name?: string;
        expected_output?: string;
      }>;
    };
    try {
      parsed = JSON.parse(planCall.function.arguments);
    } catch {
      console.warn("[planner] Failed to parse plan arguments:", planCall.function.arguments);
      return null;
    }

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }

    // Build steps with empty depends_on first (IDs are not yet known during map)
    const steps: ExecutionStep[] = parsed.steps.map((s, i) => ({
      id: uuid(),
      title: s.title ?? `Step ${i + 1}`,
      type: s.kind === "tool_call" ? "tool_call" : "reasoning",
      tool_name: s.kind === "tool_call" ? s.tool_name : undefined,
      depends_on: [],
      status: "pending",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } satisfies ExecutionStep));

    // Wire linear dependency chain now that all IDs are assigned
    for (let i = 1; i < steps.length; i++) {
      steps[i].depends_on = [steps[i - 1].id];
    }

    return { task_id: taskId, steps, current_step_index: 0 };
  }

  /**
   * Synthesize a minimal single-step plan when the model doesn't produce structured output.
   * This is a graceful fallback, not an error condition.
   */
  private synthesizeFallbackPlan(taskId: string, goal: string): ExecutionPlan {
    return {
      task_id: taskId,
      steps: [
        {
          id: uuid(),
          title: "Complete task",
          type: "reasoning",
          depends_on: [],
          status: "pending",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } satisfies ExecutionStep,
      ],
      current_step_index: 0,
    };
  }
}

export const taskPlanner = new TaskPlanner();
