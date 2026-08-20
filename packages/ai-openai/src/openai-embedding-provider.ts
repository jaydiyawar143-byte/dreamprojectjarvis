import OpenAI from "openai";
import type {
  IEmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";

export interface OpenAIEmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
}

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 1536;

export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  readonly id = "openai-embedding";
  readonly name = "OpenAI Embedding Provider";
  readonly dimensions: number;

  private client: OpenAI;
  private model: string;
  private timeoutMs: number;

  constructor(config: OpenAIEmbeddingConfig = {}) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "OpenAI API key is required. Set OPENAI_API_KEY environment variable."
      );
    }

    this.model = config.model ?? process.env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    this.dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;
    this.timeoutMs = config.timeoutMs ?? (Number(process.env.OPENAI_TIMEOUT_MS) || 30000);

    this.client = new OpenAI({
      apiKey,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model ?? this.model;

    try {
      const response = await this.client.embeddings.create({
        model,
        input: request.input,
      });

      const embeddings = response.data.map(
        (item: { embedding: number[] }) => item.embedding
      );

      return {
        embeddings,
        model: response.model,
        usage: response.usage
          ? {
              promptTokens: response.usage.prompt_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof JarvisError) throw error;

      const message =
        error instanceof Error ? error.message : "Unknown embedding error";

      if (message.includes("rate_limit") || message.includes("429")) {
        throw new JarvisError(
          "RATE_LIMITED",
          "OpenAI embedding rate limit exceeded",
          { retryAfter: 60 }
        );
      }

      if (message.includes("invalid") || message.includes("400")) {
        throw new JarvisError(
          "INVALID_REQUEST",
          "Invalid embedding request",
          { detail: "Check input text and model parameters" }
        );
      }

      throw new JarvisError(
        "MEMORY_EMBEDDING_FAILED",
        "Embedding generation failed",
        { provider: "openai", model }
      );
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
