import Anthropic from "@anthropic-ai/sdk";
import type {
  IAIProvider,
  AICompletionRequest,
  AICompletionResponse,
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";
import type { ClaudeAdapterConfig } from "./types.js";
import {
  convertMessages,
  convertTools,
  convertToolChoice,
  convertResponse,
} from "./message-converter.js";
import { executeWithRetry } from "./error-handler.js";

export class ClaudeAdapter implements IAIProvider {
  readonly id = "claude";
  readonly name = "Claude (Anthropic)";
  readonly defaultModel: string;

  private client: Anthropic;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(config: ClaudeAdapterConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable."
      );
    }

    this.defaultModel = config.defaultModel ?? (process.env.CLAUDE_DEFAULT_MODEL || "claude-sonnet-4-20250514");
    this.timeoutMs = config.timeoutMs ?? (Number(process.env.CLAUDE_TIMEOUT_MS) || 30000);
    this.maxRetries = config.maxRetries ?? (Number(process.env.CLAUDE_MAX_RETRIES) || 2);

    this.client = new Anthropic({
      apiKey,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const model = request.model || this.defaultModel;
    const { system, messages } = convertMessages(request.messages);

    const params: Anthropic.MessageCreateParams = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (system) {
      params.system = system;
    }

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = convertTools(request.tools) as Anthropic.Tool[];
    }

    const toolChoice = request.toolChoice ? convertToolChoice(request.toolChoice) : undefined;
    if (toolChoice) {
      params.tool_choice = toolChoice as Anthropic.Messages.ToolChoice;
    }

    const response = await executeWithRetry(
      async () => {
        const result = await this.client.messages.create(params);
        return result;
      },
      this.maxRetries,
      request.signal ?? undefined
    );

    return convertResponse(response as unknown as import("./types.js").ClaudeCompletionResponse, request.requestId);
  }

  async listModels(): Promise<string[]> {
    return [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-3-5-haiku-20241022",
      "claude-3-5-sonnet-20241022",
    ];
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: this.defaultModel,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      return true;
    } catch {
      return false;
    }
  }
}
