import type {
  AIMessage,
  AIToolDefinition,
  AICompletionResponse,
  AIToolCall,
  AIUsage,
} from "@jarvis/core";
import type {
  OpenAIMessage,
  OpenAITool,
  OpenAICompletionResponse,
} from "./types.js";

export function convertMessages(messages: AIMessage[]): OpenAIMessage[] {
  return messages.map((msg) => {
    const converted: OpenAIMessage = {
      role: msg.role,
      content: msg.content,
    };

    if (msg.name) {
      converted.name = msg.name;
    }

    if (msg.role === "tool" && msg.toolCallId) {
      converted.tool_call_id = msg.toolCallId;
    }

    return converted;
  });
}

export function convertTools(tools: AIToolDefinition[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function convertToolChoice(
  toolChoice: "auto" | "none" | { type: "function"; function: { name: string } }
): "auto" | "none" | { type: "function"; function: { name: string } } {
  return toolChoice;
}

const FINISH_REASON_MAP: Record<string, AICompletionResponse["finishReason"]> = {
  stop: "stop",
  tool_calls: "tool_calls",
  length: "length",
  content_filter: "content_filter",
};

export function convertResponse(
  response: OpenAICompletionResponse,
  requestId?: string
): AICompletionResponse {
  const choice = response.choices[0];

  if (!choice) {
    return {
      message: {
        role: "assistant",
        content: "No response from provider.",
      },
      finishReason: "stop",
      model: response.model,
      requestId,
    };
  }

  const finishReason =
    FINISH_REASON_MAP[choice.finish_reason || "stop"] || "stop";

  let toolCalls: AIToolCall[] | undefined;
  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    toolCalls = choice.message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseToolArguments(tc.function.arguments),
    }));
  }

  const usage: AIUsage | undefined = response.usage
    ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      }
    : undefined;

  return {
    message: {
      role: "assistant",
      content: choice.message.content,
      toolCalls,
    },
    finishReason,
    usage,
    model: response.model,
    requestId,
  };
}

function parseToolArguments(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}
