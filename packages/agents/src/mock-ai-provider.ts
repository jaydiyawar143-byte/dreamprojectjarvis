import type {
  IAIProvider,
  AICompletionRequest,
  AICompletionResponse,
} from "@jarvis/core";

export interface MockProviderConfig {
  textResponse?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  shouldFail?: boolean;
  failureMessage?: string;
  timeoutMs?: number;
  delayMs?: number;
  model?: string;
}

export class MockAIProvider implements IAIProvider {
  readonly id = "mock";
  readonly name = "Mock AI Provider";
  readonly defaultModel: string;

  private config: MockProviderConfig;
  private callCount = 0;
  private lastRequest: AICompletionRequest | null = null;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      textResponse: "Mock response",
      shouldFail: false,
      failureMessage: "Mock provider failure",
      model: "mock-model-v1",
      ...config,
    };
    this.defaultModel = this.config.model!;
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.callCount++;
    this.lastRequest = request;

    if (this.config.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
    }

    if (this.config.shouldFail) {
      throw new Error(this.config.failureMessage);
    }

    const model = request.model || this.defaultModel;

    if (this.config.toolCalls && this.config.toolCalls.length > 0) {
      const hasToolsInRequest = request.tools && request.tools.length > 0;
      if (hasToolsInRequest) {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: this.config.toolCalls.map((tc, i) => ({
              id: `mock-call-${this.callCount}-${i}`,
              name: tc.name,
              arguments: tc.arguments,
            })),
          },
          finishReason: "tool_calls",
          model,
          requestId: request.requestId,
        };
      }
    }

    return {
      message: {
        role: "assistant",
        content: this.config.textResponse!,
      },
      finishReason: "stop",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
      model,
      requestId: request.requestId,
    };
  }

  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }

  async isAvailable(): Promise<boolean> {
    return !this.config.shouldFail;
  }

  getCallCount(): number {
    return this.callCount;
  }

  getLastRequest(): AICompletionRequest | null {
    return this.lastRequest;
  }

  reset(): void {
    this.callCount = 0;
    this.lastRequest = null;
  }
}
