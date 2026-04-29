import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "../types/index.js";
import type { ModelProvider, ModelResponse, ToolParam } from "./providers/base-provider.js";
import { openaiProvider } from "./providers/openai.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { config } from "../config.js";

const providers: ModelProvider[] = [openaiProvider, anthropicProvider];

export async function callModel(model: string, messages: ChatMessage[]): Promise<string> {
  const response = await callModelFull(model, messages);
  return response.content;
}

export async function callModelFull(
  model: string,
  messages: ChatMessage[],
  tools?: ToolParam[]
): Promise<ModelResponse> {
  const provider = providers.find((p) => p.supports(model));
  if (!provider) throw new Error(`No provider found for model: ${model}`);
  try { return await provider.chat(model, messages, tools); }
  catch (error: any) { console.error(`Model call failed [${model}]:`, error.message); throw error; }
}

/**
 * Call the model with Function Calling tools enabled.
 * Returns the full ModelResponse (may contain tool_calls).
 */
export async function callModelWithTools(
  model: string,
  messages: ChatMessage[],
  tools: ToolParam[]
): Promise<ModelResponse> {
  const provider = providers.find((p) => p.supports(model));
  if (!provider) throw new Error(`No provider found for model: ${model}`);
  try { return await provider.chat(model, messages, tools); }
  catch (error: any) { console.error(`Model call failed with tools [${model}]:`, error.message); throw error; }
}

export function getAvailableModels(): string[] {
  return ["gpt-4o-mini", "gpt-4o", "claude-3-5-haiku-20241022", "claude-3-5-sonnet-20241022"];
}

// Re-export callOpenAIWithOptions from the OpenAI provider for use by other modules
export { callOpenAIWithOptions } from "./providers/openai.js";

/**
 * Streaming model call — yields content chunks as they arrive from the provider.
 * OpenAI-compatible models use the OpenAI streaming API.
 * Anthropic (claude-*) models use the Anthropic streaming API.
 *
 * Usage:
 *   for await (const chunk of callModelStream(model, messages)) {
 *     // chunk is a string (may be empty string for empty deltas)
 *   }
 */
export async function* callModelStream(
  model: string,
  messages: ChatMessage[],
  reqApiKey?: string
): AsyncGenerator<string> {
  if (model.startsWith("claude-")) {
    // Anthropic streaming path
    const anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const stream = anthropicClient.messages.stream({
      model,
      max_tokens: 4096,
      system: systemMsg?.content || "",
      messages: nonSystemMsgs.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  } else {
    // OpenAI-compatible streaming path (gpt-*, o1, o3, provider/model, etc.)
    const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: reqApiKey || config.openaiApiKey,
    };
    if (!reqApiKey && config.openaiBaseUrl) {
      clientOptions.baseURL = config.openaiBaseUrl;
    } else if (reqApiKey && config.openaiBaseUrl) {
      // When using a custom key, still use the configured base URL
      // (e.g. SiliconFlow gateway). Only override if key is from the same gateway.
      clientOptions.baseURL = config.openaiBaseUrl;
    }
    const openaiClient = new OpenAI(clientOptions);

    const stream = await openaiClient.chat.completions.create({
      model,
      messages: messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })),
      temperature: 0.3,
      max_tokens: 4096,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}
