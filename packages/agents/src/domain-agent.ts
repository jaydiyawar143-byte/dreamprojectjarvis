// ---------------------------------------------------------------------------
// Sprint 6.1 — Shared base for the specialized domain agents.
//
// `ConversationalAssistant` and `MetaAdsAgent` each carry their own copy of the
// provider conversation loop. Those two are stable Sprint 1-5 code with tests
// pinned to their exact behaviour, so they are left alone; this class holds the
// same loop once for everything Sprint 6 adds, and the new agents contribute
// only what actually differs between them — the prompt, the server-authoritative
// context they preload, and their allowlist.
//
// Two extension points, both deliberately narrow:
//
//   buildSystemPrompt()  inject context the SERVER resolved (account ids,
//                        retrieved passages) rather than context the model
//                        asked for.
//   normalizeActions()   last-chance rewrite of outgoing tool calls, used to
//                        pin ids the model must not choose for itself.
//
// Neither can widen the tool allowlist: the Orchestrator checks every action
// against the registry-held policy after these hooks have run.
// ---------------------------------------------------------------------------

import { sanitizeToolResult } from "@jarvis/tools";

import { BaseAgent } from "./base-agent.js";
import { withCurrentDate } from "./temporal-context.js";
import type {
  AgentContext,
  AgentInput,
  AgentOutput,
  AgentCategory,
  AgentConfig,
  AICompletionResponse,
  AIMessage,
  AIToolCall,
  AIToolDefinition,
  ConversationMessage,
  IAIProvider,
  ToolExecutionResult,
} from "@jarvis/core";

export interface DomainAgentConfig {
  provider: IAIProvider;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Tool definitions offered to the model. The API filters these to the
   * agent's allowlist before construction; the Orchestrator enforces the same
   * allowlist again at execution time, so this list is a prompt-shaping
   * convenience and never the security boundary.
   */
  tools?: AIToolDefinition[];
}

interface ConversationState {
  userMessage: string;
  assistantResponse: AICompletionResponse;
}

export interface AgentAction {
  toolId: string;
  toolCallId?: string;
  params: Record<string, unknown>;
}

export abstract class DomainAgent extends BaseAgent {
  protected provider: IAIProvider;
  protected providerModel?: string;
  protected providerSystemPrompt: string;
  protected providerTools?: AIToolDefinition[];

  private conversationStates = new Map<string, ConversationState>();
  /**
   * Context keyed by conversation rather than a single `this.context`.
   *
   * One agent instance serves every concurrent request, so a second
   * conversation initializing mid-flight would otherwise overwrite the first
   * one's user id — and the user id is what scopes every tool call.
   */
  protected activeContexts = new Map<string, AgentContext>();

  constructor(
    id: string,
    name: string,
    description: string,
    category: AgentCategory,
    allowedTools: string[],
    defaultSystemPrompt: string,
    config: DomainAgentConfig
  ) {
    super(id, name, description, category, allowedTools, {
      model: config.model || config.provider.defaultModel,
      temperature: config.temperature ?? 0.4,
      maxTokens: config.maxTokens ?? 4096,
      systemPrompt: config.systemPrompt || defaultSystemPrompt,
    } as Partial<AgentConfig>);

    this.provider = config.provider;
    this.providerModel = config.model;
    this.providerSystemPrompt = config.systemPrompt || defaultSystemPrompt;
    this.providerTools = config.tools;
  }

  override async initialize(context: AgentContext): Promise<void> {
    await super.initialize(context);
    this.activeContexts.set(context.conversationId ?? "__default__", context);
  }

  /**
   * System prompt for this turn. Override to prepend context the server
   * resolved. The base implementation returns the configured prompt unchanged.
   */
  protected async buildSystemPrompt(
    _input: AgentInput,
    _context: AgentContext | undefined
  ): Promise<string> {
    return this.providerSystemPrompt;
  }

  /** Override to pin parameters the model must not choose. */
  protected normalizeActions(
    actions: AgentAction[],
    _context: AgentContext | undefined,
    _conversationId: string
  ): AgentAction[] {
    return actions;
  }

  async process(input: AgentInput): Promise<AgentOutput> {
    this.status = "processing";
    const conversationId = input.conversationId ?? "__default__";

    try {
      const context = this.activeContexts.get(conversationId) ?? this.context;
      const toolResults = input.metadata?.toolResults as
        | ToolExecutionResult[]
        | undefined;

      // Dated HERE rather than inside `buildSystemPrompt`, because three
      // subclasses override that hook and compose from `providerSystemPrompt`
      // directly. Dating the hook would have silently skipped all of them, and
      // silently skipped the next one written the same way. This is the one
      // point every domain agent's prompt actually passes through.
      const systemPrompt = withCurrentDate(await this.buildSystemPrompt(input, context));

      let messages: AIMessage[];

      if (toolResults && toolResults.length > 0) {
        const state = this.conversationStates.get(conversationId);
        if (state) {
          messages = this.buildToolResultMessages(
            state.userMessage,
            state.assistantResponse,
            toolResults,
            input.conversationHistory,
            systemPrompt
          );
        } else {
          // No recorded assistant turn to attach the results to. Replaying the
          // original question is the honest fallback: fabricating a synthetic
          // tool-call turn would put words in the model's mouth.
          messages = this.buildInitialMessages(
            input.message,
            input.conversationHistory,
            systemPrompt
          );
        }
      } else {
        messages = this.buildInitialMessages(
          input.message,
          input.conversationHistory,
          systemPrompt
        );
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
          userMessage:
            toolResults && toolResults.length > 0
              ? this.conversationStates.get(conversationId)?.userMessage ??
                input.message
              : input.message,
          assistantResponse: response,
        });

        const actions = this.normalizeActions(
          response.message.toolCalls.map((tc) => ({
            toolId: tc.name,
            toolCallId: tc.id,
            params: { ...tc.arguments } as Record<string, unknown>,
          })),
          context,
          conversationId
        );

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
    } finally {
      this.activeContexts.delete(conversationId);
    }
  }

  // -------------------------------------------------------------------------
  // Message assembly
  // -------------------------------------------------------------------------

  protected buildInitialMessages(
    userMessage: string,
    conversationHistory: ConversationMessage[] | undefined,
    systemPrompt: string
  ): AIMessage[] {
    const messages: AIMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    for (const msg of conversationHistory ?? []) {
      messages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }

    messages.push({ role: "user", content: userMessage });
    return messages;
  }

  protected buildToolResultMessages(
    originalUserMessage: string,
    assistantResponse: AICompletionResponse,
    toolResults: ToolExecutionResult[],
    conversationHistory: ConversationMessage[] | undefined,
    systemPrompt: string
  ): AIMessage[] {
    const messages: AIMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    for (const msg of conversationHistory ?? []) {
      messages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }

    messages.push({ role: "user", content: originalUserMessage });
    messages.push({
      role: "assistant",
      content: assistantResponse.message.content ?? "",
      toolCalls: assistantResponse.message.toolCalls,
    });

    const toolCallsById = new Map<string, AIToolCall>();
    for (const tc of assistantResponse.message.toolCalls ?? []) {
      toolCallsById.set(tc.id, tc);
    }

    for (const tr of toolResults) {
      let toolCallId = tr.toolCallId;
      if (!toolCallId) {
        const matching =
          toolCallsById.get(tr.toolId) ?? [...toolCallsById.values()].shift();
        if (matching) toolCallId = matching.id;
      }

      messages.push({
        role: "tool",
        content: this.buildToolResultEnvelope(tr),
        name: tr.toolId,
        toolCallId,
      });
    }

    return messages;
  }

  /**
   * Renders one tool result for the model.
   *
   * The status is stated before the data, and a failure says so in words the
   * prompt rules key off, because the failure mode this guards against is a
   * model narrating plausible numbers over a call that never returned any.
   */
  protected buildToolResultEnvelope(tr: ToolExecutionResult): string {
    const lines: string[] = [];
    lines.push(`TOOL: ${tr.toolId}`);
    lines.push(`STATUS: ${tr.status.toUpperCase()}`);

    if (
      (tr.status === "approval_required" || tr.status === "approval_pending") &&
      tr.approvalId
    ) {
      lines.push(`APPROVAL_ID: ${tr.approvalId}`);
      lines.push(
        "ACTION: This action is waiting on human approval. Present it to the user with the approval ID and ask them to confirm. Do NOT claim it was executed, and do NOT say you are unable to proceed."
      );
    }

    if (tr.status === "permission_denied") {
      lines.push(
        "ACTION: This agent is not authorized to perform that action. Tell the user plainly and do not retry it."
      );
    }

    if (tr.error) {
      lines.push(`ERROR: ${tr.error}`);
    }

    if (tr.durationMs !== undefined) {
      lines.push(`DURATION: ${tr.durationMs}ms`);
    }

    if (tr.result) {
      if (tr.result.success) {
        // Sprint 9.9 — bound and de-secret the payload before it is written
        // into a prompt. `sanitizeToolResult` has existed since Phase 9 with a
        // full test suite and NO production call site; this is the one place
        // every tool result passes through on its way to a model, so it is
        // where the cap and the secret patterns actually have to apply.
        //
        // Tool results are the largest untrusted thing in a conversation: a
        // scraped page, a Meta insights payload, a document extract. Truncation
        // is visible to the model (the sanitizer appends its own marker) rather
        // than silent.
        const safe = sanitizeToolResult(tr.result);
        const dataStr =
          safe.result.data !== undefined
            ? JSON.stringify(safe.result.data, null, 2)
            : undefined;
        lines.push(
          dataStr && dataStr !== "undefined"
            ? `DATA: ${dataStr}`
            : "DATA: (empty — no data returned)"
        );
        if (safe.truncated) {
          lines.push(
            "NOTE: This result was truncated because it exceeded the size limit. Do not assume the omitted part agrees with what you can see."
          );
        }
      } else {
        lines.push(`DATA_RETRIEVAL_FAILED: ${tr.result.error ?? "unknown error"}`);
        lines.push(
          "DO NOT fabricate, estimate or infer any values. No data was retrieved."
        );
      }
    } else if (
      tr.status !== "approval_required" &&
      tr.status !== "approval_pending"
    ) {
      lines.push("DATA: (no result — tool did not execute)");
      lines.push(
        "DO NOT fabricate, estimate or infer any values. No data was retrieved."
      );
    }

    return lines.join("\n");
  }
}
