export interface ClaudeAdapterConfig {
  apiKey?: string;
  defaultModel?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: "text"; text: string }>;
}

export interface ClaudeSystemMessage {
  type: "text";
  text: string;
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeCompletionParams {
  model: string;
  system?: ClaudeSystemMessage[];
  messages: ClaudeMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: ClaudeTool[];
  tool_choice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
}

export interface ClaudeCompletionResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }>;
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
