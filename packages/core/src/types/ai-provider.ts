export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: AIToolCall[];
}

export interface AIToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * S8.7 — the most tool definitions one model request may carry: OpenAI's chat
 * completions limit, the strictest provider this build uses. Every tool an
 * agent may call is sent on every turn, so a census test holds the general
 * assistant's native tools plus MCP_LIMITS.toolsTotal within it.
 */
export const MAX_TOOLS_PER_MODEL_REQUEST = 128;

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
