export interface OpenAIAdapterConfig {
  apiKey?: string;
  defaultModel?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAICompletionParams {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  signal?: AbortSignal | null;
}

export interface OpenAICompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
