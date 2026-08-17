import OpenAI from "openai";
import type {
  IAIProvider,
  AICompletionRequest,
  AICompletionResponse,
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";
import type { OpenAIAdapterConfig } from "./types.js";
import {
  convertMessages,
  convertTools,
  convertToolChoice,
  convertResponse,
} from "./message-converter.js";
import { executeWithRetry } from "./error-handler.js";

export class OpenAIAdapter implements IAIProvider {
  readonly id = "openai";
  readonly name = "OpenAI";
  readonly defaultModel: string;

  private client: OpenAI;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(config: OpenAIAdapterConfig = {}) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "OpenAI API key is required. Set OPENAI_API_KEY environment variable."
      );
    }

    this.defaultModel = config.defaultModel ?? (process.env.OPENAI_DEFAULT_MODEL || "gpt-4o");
    this.timeoutMs = config.timeoutMs ?? (Number(process.env.OPENAI_TIMEOUT_MS) || 30000);
    this.maxRetries = config.maxRetries ?? (Number(process.env.OPENAI_MAX_RETRIES) || 2);

    this.client = new OpenAI({
      apiKey,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const model = request.model || this.defaultModel;

    const params: OpenAI.ChatCompletionCreateParams = {
      model,
      messages: convertMessages(request.messages) as OpenAI.ChatCompletionMessageParam[],
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    };

    if (request.tools && request.tools.length > 0) {
      params.tools = convertTools(request.tools) as OpenAI.ChatCompletionTool[];
    }

    if (request.toolChoice) {
      params.tool_choice = convertToolChoice(request.toolChoice) as OpenAI.ChatCompletionToolChoiceOption;
    }

    const response = await executeWithRetry(
      async () => {
        const result = await this.client.chat.completions.create(params, {
          signal: request.signal ?? undefined,
        });
        return result;
      },
      this.maxRetries,
      request.signal ?? undefined
    );

    return convertResponse(response as import("./types.js").OpenAICompletionResponse, request.requestId);
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await this.client.models.list();
      return response.data.map((m: { id: string }) => m.id).sort();
    } catch {
      return [this.defaultModel];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
