import { BaseAgent } from "../base-agent.js";
import type {
  AgentInput,
  AgentOutput,
  IAIProvider,
  AIMessage,
  AIToolDefinition,
  AIToolCall,
  AICompletionResponse,
  ToolExecutionResult,
} from "@jarvis/core";

export interface ConversationalAssistantConfig {
  provider: IAIProvider;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: AIToolDefinition[];
}

interface ConversationState {
  userMessage: string;
  assistantResponse: AICompletionResponse;
}

export class ConversationalAssistant extends BaseAgent {
  private provider: IAIProvider;
  private providerModel?: string;
  private providerSystemPrompt?: string;
  private providerTools?: AIToolDefinition[];

  private conversationStates = new Map<string, ConversationState>();

  constructor(config: ConversationalAssistantConfig) {
    super(
      "conversational-assistant",
      "JARVIS Assistant",
      "Core AI conversational assistant for general questions and tasks",
      "ai-core",
      [],
      {
        model: config.model || config.provider.defaultModel,
        temperature: config.temperature ?? 0.7,
        maxTokens: config.maxTokens ?? 4096,
        systemPrompt: config.systemPrompt,
      }
    );
    this.provider = config.provider;
    this.providerModel = config.model;
    this.providerSystemPrompt = config.systemPrompt;
    this.providerTools = config.tools;
  }

  async process(input: AgentInput): Promise<AgentOutput> {
    this.status = "processing";

    try {
      const conversationId = input.conversationId ?? "__default__";
      const toolResults = input.metadata?.toolResults as
        | ToolExecutionResult[]
        | undefined;

      let messages: AIMessage[];

      if (toolResults && toolResults.length > 0) {
        const state = this.conversationStates.get(conversationId);
        if (state) {
          messages = this.buildToolResultMessages(
            state.userMessage,
            state.assistantResponse,
            toolResults
          );
        } else {
          messages = this.buildInitialMessages(input.message);
          this.conversationStates.set(conversationId, {
            userMessage: input.message,
            assistantResponse: { message: { role: "assistant", content: "" }, finishReason: "stop", model: "" },
          });
        }
      } else {
        messages = this.buildInitialMessages(input.message);
        this.conversationStates.delete(conversationId);
      }

      const response = await this.provider.complete({
        messages,
        model: this.providerModel,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        tools: this.providerTools,
        requestId: input.metadata?.requestId as string | undefined,
        traceId: input.metadata?.traceId as string | undefined,
      });

      if (response.message.toolCalls && response.message.toolCalls.length > 0) {
        this.conversationStates.set(conversationId, {
          userMessage: toolResults && toolResults.length > 0
            ? (this.conversationStates.get(conversationId)?.userMessage ?? input.message)
            : input.message,
          assistantResponse: response,
        });

        const actions = response.message.toolCalls.map((tc) => ({
          toolId: tc.name,
          toolCallId: tc.id,
          params: tc.arguments,
        }));

        this.status = "ready";

        return {
          message: response.message.content || "",
          actions,
          metadata: {
            model: response.model,
            usage: response.usage,
            finishReason: response.finishReason,
          },
        };
      }

      this.conversationStates.delete(conversationId);

      this.status = "ready";

      return {
        message: response.message.content || "No response generated.",
        metadata: {
          model: response.model,
          usage: response.usage,
          finishReason: response.finishReason,
        },
      };
    } catch (error) {
      this.status = "error";
      throw error;
    }
  }

  private buildInitialMessages(userMessage: string): AIMessage[] {
    const messages: AIMessage[] = [];

    if (this.providerSystemPrompt) {
      messages.push({
        role: "system",
        content: this.providerSystemPrompt,
      });
    }

    messages.push({
      role: "user",
      content: userMessage,
    });

    return messages;
  }

  private buildToolResultMessages(
    originalUserMessage: string,
    assistantResponse: AICompletionResponse,
    toolResults: ToolExecutionResult[]
  ): AIMessage[] {
    const messages: AIMessage[] = [];

    if (this.providerSystemPrompt) {
      messages.push({
        role: "system",
        content: this.providerSystemPrompt,
      });
    }

    messages.push({
      role: "user",
      content: originalUserMessage,
    });

    messages.push({
      role: "assistant",
      content: assistantResponse.message.content ?? "",
      toolCalls: assistantResponse.message.toolCalls,
    });

    const toolCallsById = new Map<string, AIToolCall>();
    if (assistantResponse.message.toolCalls) {
      for (const tc of assistantResponse.message.toolCalls) {
        toolCallsById.set(tc.id, tc);
      }
    }

    for (const tr of toolResults) {
      let toolCallId = tr.toolCallId;
      if (!toolCallId) {
        const matching = toolCallsById.get(tr.toolId)
          ?? [...toolCallsById.values()].shift();
        if (matching) {
          toolCallId = matching.id;
        }
      }

      const envelope = this.buildToolResultEnvelope(tr);

      messages.push({
        role: "tool",
        content: envelope,
        name: tr.toolId,
        toolCallId,
      });
    }

    return messages;
  }

  private buildToolResultEnvelope(tr: ToolExecutionResult): string {
    const lines: string[] = [];
    lines.push(`TOOL: ${tr.toolId}`);
    lines.push(`STATUS: ${tr.status.toUpperCase()}`);

    if (tr.error) {
      lines.push(`ERROR: ${tr.error}`);
    }

    if (tr.durationMs !== undefined) {
      lines.push(`DURATION: ${tr.durationMs}ms`);
    }

    if (tr.result) {
      if (tr.result.success) {
        if (tr.result.data !== undefined) {
          const dataStr = JSON.stringify(tr.result.data, null, 2);
          if (dataStr && dataStr !== "undefined") {
            lines.push(`DATA: ${dataStr}`);
          } else {
            lines.push("DATA: (empty — no data returned)");
          }
        } else {
          lines.push("DATA: (empty — no data returned)");
        }
      } else {
        lines.push(`DATA_RETRIEVAL_FAILED: ${tr.result.error ?? "unknown error"}`);
        lines.push("DO NOT fabricate or estimate metrics. Data was NOT retrieved from Meta API.");
      }
    } else {
      lines.push("DATA: (no result — tool did not execute)");
      lines.push("DO NOT fabricate or estimate metrics. Data was NOT retrieved from Meta API.");
    }

    return lines.join("\n");
  }
}
