import OpenAI from "openai";
import type {
  IAIProvider,
  AICompletionRequest,
  AICompletionResponse,
} from "@jarvis/core";
import {
  CircuitBreaker,
  JarvisError,
  providerFailureLogRecord,
  type CircuitTransition,
  type RetryPolicy,
} from "@jarvis/core";
import type { OpenAIAdapterConfig } from "./types.js";
import {
  convertMessages,
  convertTools,
  convertToolChoice,
  convertResponse,
} from "./message-converter.js";
import { executeWithRetry } from "./error-handler.js";

/**
 * R-27 — what the user sees while the circuit is open. Stable, and says
 * nothing about the circuit, its counts or the provider's last error.
 */
const UNAVAILABLE_MESSAGE = "The AI service is temporarily unavailable. Please try again in a moment.";

function logCircuitTransition(transition: CircuitTransition): void {
  console.log(JSON.stringify({
    level: transition.to === "open" ? "warn" : "info",
    event: "ai_provider_circuit",
    provider: "openai",
    from: transition.from,
    to: transition.to,
    consecutiveFailures: transition.consecutiveFailures,
  }));
}

export class OpenAIAdapter implements IAIProvider {
  readonly id = "openai";
  readonly name = "OpenAI";
  readonly defaultModel: string;

  private client: OpenAI;
  private timeoutMs: number;
  private maxRetries: number;
  private retryPolicy: Partial<Omit<RetryPolicy, "maxRetries">>;
  /**
   * R-27 — one breaker per adapter instance: this key, in this process. The
   * API builds one adapter and shares it, so an outage opens it for everyone —
   * for `openDurationMs`, never for longer than a restart.
   */
  private breaker: CircuitBreaker;

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
    this.retryPolicy = config.retryPolicy ?? {};
    this.breaker = new CircuitBreaker(config.circuitBreaker, { onTransition: logCircuitTransition });

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

    const permit = this.breaker.acquire();
    if (!permit) {
      // Transient, so the agent stays in service and the next request can
      // probe once the open duration has passed.
      throw new JarvisError("AI_PROVIDER_UNAVAILABLE", UNAVAILABLE_MESSAGE, { transient: true });
    }

    let response: OpenAI.ChatCompletion;
    try {
      response = await executeWithRetry(
        async () => {
          const result = await this.client.chat.completions.create(params, {
            signal: request.signal ?? undefined,
          });
          return result as OpenAI.ChatCompletion;
        },
        this.maxRetries,
        request.signal ?? undefined,
        { policy: this.retryPolicy }
      );
    } catch (error) {
      // executeWithRetry always throws a classified JarvisError. Only a
      // transient failure counts against the provider's health.
      if ((error as JarvisError).details?.transient === true) {
        this.breaker.recordTransientFailure(permit);
      } else {
        this.breaker.recordNeutral(permit);
      }
      // R-31 — the response carries a fixed message; the provider's own
      // account of the failure goes to the log, once, after the retries.
      const record = providerFailureLogRecord(this.id, error);
      if (record) console.log(JSON.stringify(record));
      throw error;
    }
    this.breaker.recordSuccess(permit);

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
