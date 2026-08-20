import type {
  AIMessage,
  AIToolDefinition,
  AICompletionResponse,
  AIToolCall,
  AIUsage,
} from "@jarvis/core";
import type {
  ClaudeMessage,
  ClaudeTool,
  ClaudeCompletionResponse,
} from "./types.js";

export function convertMessages(messages: AIMessage[]): {
  system: string;
  messages: ClaudeMessage[];
} {
  const systemParts: string[] = [];
  const claudeMessages: ClaudeMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "tool") {
      claudeMessages.push({
        role: "user",
        content: JSON.stringify({ tool_result: msg.toolCallId, content: msg.content }),
      });
      continue;
    }

    claudeMessages.push({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    });
  }

  return {
    system: systemParts.join("\n\n"),
    messages: claudeMessages,
  };
}

export function convertTools(tools: AIToolDefinition[]): ClaudeTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function convertToolChoice(
  toolChoice: "auto" | "none" | { type: "function"; function: { name: string } }
): { type: "auto" } | { type: "any" } | { type: "tool"; name: string } | undefined {
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return undefined;
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return { type: "tool", name: toolChoice.function.name };
  }
  return { type: "auto" };
}

const FINISH_REASON_MAP: Record<string, AICompletionResponse["finishReason"]> = {
  end_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
};

export function convertResponse(
  response: ClaudeCompletionResponse,
  requestId?: string
): AICompletionResponse {
  let textContent: string | null = null;
  const toolCalls: AIToolCall[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      textContent = (textContent ?? "") + block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    }
  }

  const finishReason =
    FINISH_REASON_MAP[response.stop_reason ?? "end_turn"] ?? "stop";

  const usage: AIUsage | undefined = response.usage
    ? {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      }
    : undefined;

  return {
    message: {
      role: "assistant",
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    finishReason,
    usage,
    model: response.model,
    requestId,
  };
}
