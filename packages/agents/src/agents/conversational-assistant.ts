import { BaseAgent } from "../base-agent.js";

import { buildRoundMessages, type ToolRound } from "../tool-rounds.js";
import { withCurrentDate } from "../temporal-context.js";
import type {
  AgentInput,
  AgentOutput,
  IAIProvider,
  AIMessage,
  AIToolDefinition,
  AICompletionResponse,
  ToolExecutionResult,
  ConversationMessage,
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
  /** S4 — every completed round of this turn, oldest first. */
  rounds: ToolRound[];
  /** The assistant turn whose tool calls are still awaiting results. */
  pending: AICompletionResponse | null;
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
        if (state?.pending) {
          // S4 — close the open round, then replay every round of this turn.
          state.rounds.push({ assistant: state.pending, results: toolResults });
          state.pending = null;
          messages = this.buildToolResultMessages(
            state.userMessage,
            state.rounds,
            input.conversationHistory
          );
        } else {
          messages = this.buildInitialMessages(input.message, input.conversationHistory);
          this.conversationStates.set(conversationId, {
            userMessage: input.message,
            rounds: [],
            pending: null,
          });
        }
      } else {
        messages = this.buildInitialMessages(input.message, input.conversationHistory);
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
        const existing = this.conversationStates.get(conversationId);
        const continuing = Boolean(toolResults && toolResults.length > 0 && existing);
        this.conversationStates.set(conversationId, {
          userMessage: continuing ? (existing?.userMessage ?? input.message) : input.message,
          rounds: continuing ? (existing?.rounds ?? []) : [],
          pending: response,
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
      this.status = this.statusAfterFailure(error);
      throw error;
    }
  }

  private buildInitialMessages(userMessage: string, conversationHistory?: ConversationMessage[]): AIMessage[] {
    const messages: AIMessage[] = [];

    if (this.providerSystemPrompt) {
      messages.push({
        role: "system",
        // Dated per turn. Without this the model has no idea what "last 7
        // days" means and reaches for a date out of its training era.
        content: withCurrentDate(this.providerSystemPrompt),
      });
    }

    if (conversationHistory && conversationHistory.length > 0) {
      for (const msg of conversationHistory) {
        messages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }
    }

    messages.push({
      role: "user",
      content: userMessage,
    });

    return messages;
  }

  private buildToolResultMessages(
    originalUserMessage: string,
    rounds: readonly ToolRound[],
    conversationHistory?: ConversationMessage[]
  ): AIMessage[] {
    return buildRoundMessages({
      // Dated per turn. Without this the model has no idea what "last 7 days"
      // means and reaches for a date out of its training era.
      systemPrompt: this.providerSystemPrompt ? withCurrentDate(this.providerSystemPrompt) : "",
      ...(conversationHistory ? { conversationHistory } : {}),
      userMessage: originalUserMessage,
      rounds,
      renderEnvelope: (tr) => this.buildToolResultEnvelope(tr),
    });
  }

  private buildToolResultEnvelope(tr: ToolExecutionResult): string {
    const lines: string[] = [];
    lines.push(`TOOL: ${tr.toolId}`);
    lines.push(`STATUS: ${tr.status.toUpperCase()}`);

    if (tr.status === "approval_required" && tr.approvalId) {
      lines.push(`APPROVAL_ID: ${tr.approvalId}`);
      lines.push("ACTION: The tool execution is pending human approval. Present the approval request to the user with the approval ID so they can approve or reject it. Do NOT say you cannot proceed.");
    }

    if (tr.status === "approval_pending" && tr.approvalId) {
      lines.push(`APPROVAL_ID: ${tr.approvalId}`);
      lines.push("ACTION: Waiting for human approval. Inform the user that their approval is pending.");
    }

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
    } else if (tr.status !== "approval_required" && tr.status !== "approval_pending") {
      lines.push("DATA: (no result — tool did not execute)");
      lines.push("DO NOT fabricate or estimate metrics. Data was NOT retrieved from Meta API.");
    }

    return lines.join("\n");
  }
}
