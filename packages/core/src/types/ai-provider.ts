export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface AIToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AIToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AIUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AICompletionRequest {
  messages: AIMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: AIToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  requestId?: string;
  traceId?: string;
  signal?: AbortSignal;
}

export interface AICompletionResponse {
  message: {
    role: "assistant";
    content: string | null;
    toolCalls?: AIToolCall[];
  };
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
  usage?: AIUsage;
  model: string;
  requestId?: string;
}

export interface IAIProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;

  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
  listModels(): Promise<string[]>;
  isAvailable(): Promise<boolean>;
}
