import { BaseAgent } from "../base-agent.js";
import type {
  AgentInput,
  AgentOutput,
  IAIProvider,
  AIMessage,
  AIToolDefinition,
  ToolResult,
} from "@jarvis/core";

export interface ConversationalAssistantConfig {
  provider: IAIProvider;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: AIToolDefinition[];
}

export class ConversationalAssistant extends BaseAgent {
  private provider: IAIProvider;
  private providerModel?: string;
  private providerSystemPrompt?: string;
  private providerTools?: AIToolDefinition[];

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
      const toolResults = input.metadata?.toolResults as
        | Array<{ toolCallId?: string; toolId: string; result: ToolResult }>
        | undefined;

      const messages = this.buildMessages(input.message, toolResults);

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
        const actions = response.message.toolCalls.map((tc) => ({
          toolId: tc.name,
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

  private buildMessages(
    userMessage: string,
    toolResults?: Array<{ toolCallId?: string; toolId: string; result: ToolResult }>
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
      content: userMessage,
    });

    if (toolResults && toolResults.length > 0) {
      for (const tr of toolResults) {
        messages.push({
          role: "tool",
          content: JSON.stringify(tr.result),
          name: tr.toolId,
          toolCallId: tr.toolCallId,
        });
      }
    }

    return messages;
  }
}
