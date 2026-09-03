import type {
  IOrchestrator,
  OrchestratorConfig,
  JarvisRequest,
  JarvisResponse,
  SessionContext,
  IAgent,
  AgentInput,
  ToolExecutionRequest,
  IToolExecutor,
  AuditLogger,
  ToolExecutionResult,
  ToolExecutionSummary,
  ToolExecutionEntry,
  IMemoryStore,
  IMemoryExtractor,
  IEmbeddingProvider,
  IToolApprovalService,
  MemoryStoreRequest,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryDeleteRequest,
  MemoryUpdateRequest,
  MemoryListRequest,
  MemoryListResult,
  MemoryRecord,
  MemoryContextConfig,
  ITool,
  ConversationMessage,
  IKnowledgeRetriever,
  KnowledgeContextConfig,
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";
import type { AgentRegistry } from "./registry.js";
import { ToolDescriptionBuilder, ToolPlanValidator, ToolPlanParser } from "./tool-planner.js";
import {
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  DEFAULT_KNOWLEDGE_MIN_SCORE,
  DEFAULT_MAX_KNOWLEDGE_CHUNKS,
  formatKnowledgeBlock,
  selectKnowledgeChunks,
  shouldRetrieveKnowledge,
} from "./knowledge-context.js";

const DEFAULT_MAX_TOOL_EXECUTIONS = 10;
const DEFAULT_MAX_ORCHESTRATION_DEPTH = 5;
const DEFAULT_RELEVANCE_THRESHOLD = 0.3;
const DEFAULT_MAX_MEMORIES = 5;
const DEFAULT_CONTEXT_BUDGET_CHARS = 2000;

const createNoopMemoryStore = (): IMemoryStore => ({
  id: "noop-memory",
  name: "Noop Memory Store",
  store: async (_request: MemoryStoreRequest): Promise<MemoryRecord[]> => [],
  getById: async (): Promise<MemoryRecord | null> => null,
  recall: async (_request: MemoryRecallRequest): Promise<MemoryRecallResult[]> => [],
  list: async (_request: MemoryListRequest): Promise<MemoryListResult> => ({ memories: [], total: 0, hasMore: false }),
  delete: async (_request: MemoryDeleteRequest): Promise<number> => 0,
  deleteAll: async (): Promise<number> => 0,
  update: async (_request: MemoryUpdateRequest): Promise<MemoryRecord> => {
    throw new JarvisError("MEMORY_ERROR", "No memory store configured");
  },
  findSimilar: async (): Promise<MemoryRecord[]> => [],
  count: async (): Promise<number> => 0,
  isAvailable: async (): Promise<boolean> => false,
});

export class Orchestrator implements IOrchestrator {
  private readonly maxToolExecutions: number;
  private readonly maxOrchestrationDepth: number;
  private readonly memoryStore: IMemoryStore | null;
  private readonly memoryExtractor: IMemoryExtractor | null;
  private readonly embeddingProvider: IEmbeddingProvider | null;
  private readonly memoryConfig: Required<MemoryContextConfig>;
  private readonly knowledgeRetriever: IKnowledgeRetriever | null;
  private readonly knowledgeConfig: Required<KnowledgeContextConfig>;
  private readonly toolRegistry: { get(toolId: string): ITool | undefined; getAll(): ITool[] } | null;
  private readonly toolApprovalService: IToolApprovalService | null;
  private readonly pendingActionService: import("./pending-action-service.js").PendingActionService | null;
  private readonly toolDescriptionBuilder: ToolDescriptionBuilder;
  private readonly toolPlanValidator: ToolPlanValidator;
  private readonly toolPlanParser: ToolPlanParser;

  constructor(
    private agentRegistry: AgentRegistry,
    private toolExecutor: IToolExecutor,
    private auditLogger: AuditLogger,
    config: OrchestratorConfig = {}
  ) {
    this.maxToolExecutions = config.maxToolExecutions ?? DEFAULT_MAX_TOOL_EXECUTIONS;
    this.maxOrchestrationDepth = config.maxOrchestrationDepth ?? DEFAULT_MAX_ORCHESTRATION_DEPTH;
    this.memoryStore = config.memoryStore ?? null;
    this.memoryExtractor = config.memoryExtractor ?? null;
    this.embeddingProvider = config.embeddingProvider ?? null;
    this.memoryConfig = {
      relevanceThreshold: config.memory?.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD,
      maxMemories: config.memory?.maxMemories ?? DEFAULT_MAX_MEMORIES,
      contextBudgetChars: config.memory?.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS,
      extractionEnabled: config.memory?.extractionEnabled ?? true,
      extractionExpiryDays: config.memory?.extractionExpiryDays ?? 90,
    };
    this.knowledgeRetriever = config.knowledgeRetriever ?? null;
    this.knowledgeConfig = {
      enabled: config.knowledge?.enabled ?? true,
      maxChunks: config.knowledge?.maxChunks ?? DEFAULT_MAX_KNOWLEDGE_CHUNKS,
      minScore: config.knowledge?.minScore ?? DEFAULT_KNOWLEDGE_MIN_SCORE,
      contextBudgetChars:
        config.knowledge?.contextBudgetChars ?? DEFAULT_KNOWLEDGE_BUDGET_CHARS,
    };
    this.toolRegistry = config.toolRegistry ?? null;
    this.toolApprovalService = config.toolApprovalService ?? null;
    this.pendingActionService = (config as unknown as { pendingActionService?: import("./pending-action-service.js").PendingActionService }).pendingActionService ?? null;
    this.toolDescriptionBuilder = new ToolDescriptionBuilder();
    this.toolPlanValidator = new ToolPlanValidator();
    this.toolPlanParser = new ToolPlanParser();
  }

  async process(
    request: JarvisRequest,
    context: SessionContext
  ): Promise<JarvisResponse> {
    const traceId = context.traceId;
    const startedAt = new Date();

    try {
      const agent = this.selectAgent(request);
      context.agentId = agent.id;
      await this.initializeAgent(agent, context);

      const agentContext = {
        userId: context.auth.userId,
        conversationId: context.conversationId,
        traceId: context.traceId,
        memoryManager: this.memoryStore ?? createNoopMemoryStore(),
        toolRegistry: this.toolRegistry ?? {
          get: () => undefined,
          getAll: () => [],
        },
        auditLogger: this.auditLogger,
      };

      await agent.initialize(agentContext);

      const withMemory = await this.injectMemoryContext(
        request.message,
        context.auth.userId,
      );

      // The retrieval query is the ORIGINAL message, not the memory-augmented
      // one: recalled memories are about the user, and folding them into the
      // query vector would pull the search away from what was actually asked.
      const userMessage = await this.injectKnowledgeContext(
        withMemory,
        request.message,
        context.auth.userId,
      );

      if (process.env.NODE_ENV === "development") {
        console.log(JSON.stringify({
          level: "debug",
          event: "context_resolution",
          conversationId: context.conversationId,
          hasHistory: (request.conversationHistory?.length ?? 0) > 0,
          historyLength: request.conversationHistory?.length ?? 0,
          messagePreview: request.message.substring(0, 120),
          agentId: agent.id,
        }));
      }

      let currentInput: AgentInput = {
        message: userMessage,
        conversationId: context.conversationId,
        conversationHistory: request.conversationHistory ?? [],
        metadata: request.metadata,
      };

      let allToolResults: ToolExecutionResult[] = [];
      let totalToolExecutions = 0;
      let depth = 0;
      let pendingActionData: Record<string, unknown> | undefined;

      while (depth < this.maxOrchestrationDepth) {
        const output = await agent.process(currentInput);

        if (!output.actions || output.actions.length === 0) {
          const toolSummary = this.buildToolExecutionSummary(allToolResults);

          if (toolSummary.total > 0 && toolSummary.allFailed) {
            const failedTools = toolSummary.executions
              .filter((e) => !e.success)
              .map((e) => `${e.toolId}: ${e.error ?? e.status}`)
              .join("; ");

            await this.auditRequest(context, "failure", startedAt, `All tool executions failed: ${failedTools}`);

            this.logStructuredToolExecution(context, toolSummary, startedAt);

            return this.buildErrorResponse(
              new JarvisError(
                "TOOL_EXECUTION_FAILED",
                "Data retrieval failed. Meta Ads data could not be fetched.",
                {
                  toolExecution: toolSummary,
                  reason: failedTools,
                }
              ),
              traceId,
              context
            );
          }

          await this.auditRequest(context, "success", startedAt);

          this.logStructuredToolExecution(context, toolSummary, startedAt);

          this.extractMemoryAsync(
            request.message,
            output.message,
            context.auth.userId,
            context.conversationId,
          ).catch(() => {});

          const responseMetadata: Record<string, unknown> = {
            ...output.metadata,
          };
          if (toolSummary.total > 0) {
            responseMetadata.toolExecution = toolSummary;
          }
          if (pendingActionData) {
            responseMetadata.pendingAction = pendingActionData;
          }

          return this.buildSuccessResponse(
            output.message,
            traceId,
            context,
            responseMetadata
          );
        }

        if (totalToolExecutions + output.actions.length > this.maxToolExecutions) {
          throw new JarvisError(
            "INTERNAL_ERROR",
            "Tool execution limit exceeded",
            { maxToolExecutions: this.maxToolExecutions, requested: output.actions.length }
          );
        }

        const { results: toolResults, pendingAction } = await this.executeTools(
          output.actions,
          context
        );
        allToolResults.push(...toolResults);
        if (pendingAction) {
          pendingActionData = pendingAction;
        }
        totalToolExecutions += output.actions.length;

        if (process.env.NODE_ENV === "development") {
          console.log(JSON.stringify({
            level: "debug",
            event: "tool_execution_round",
            conversationId: context.conversationId,
            depth: depth + 1,
            toolsCalled: output.actions.map((a) => a.toolId),
            results: toolResults.map((r) => ({
              toolId: r.toolId,
              status: r.status,
              hasApprovalId: !!r.approvalId,
            })),
          }));
        }

        currentInput = {
          message: output.message,
          conversationId: context.conversationId,
          conversationHistory: request.conversationHistory ?? [],
          metadata: {
            ...request.metadata,
            toolResults,
            depth: depth + 1,
          },
        };

        depth++;
      }

      throw new JarvisError(
        "INTERNAL_ERROR",
        "Orchestration depth limit exceeded",
        { maxDepth: this.maxOrchestrationDepth }
      );
    } catch (error) {
      if (error instanceof JarvisError) {
        await this.auditRequest(context, "failure", startedAt, error.message);
        return this.buildErrorResponse(error, traceId, context);
      }

      const message = error instanceof Error ? error.message : "Unexpected error";
      await this.auditRequest(context, "failure", startedAt, message);
      return this.buildErrorResponse(
        new JarvisError("INTERNAL_ERROR", "Internal processing error"),
        traceId,
        context
      );
    }
  }

  // -----------------------------------------------------------------------
  // Memory recall + context injection
  // -----------------------------------------------------------------------

  private async injectMemoryContext(
    userMessage: string,
    userId: string,
  ): Promise<string> {
    if (!this.memoryStore) return userMessage;

    try {
      const isAvailable = await this.memoryStore.isAvailable();
      if (!isAvailable) return userMessage;

      const memories = await this.recallMemories(userMessage, userId);
      if (memories.length === 0) return userMessage;

      return this.formatMemoryBlock(memories) + "\n\n" + userMessage;
    } catch {
      return userMessage;
    }
  }

  private async recallMemories(
    query: string,
    userId: string,
  ): Promise<MemoryRecallResult[]> {
    if (!this.memoryStore) return [];

    try {
      const isAvailable = await this.memoryStore.isAvailable();
      if (!isAvailable) return [];

      const queryEmbedding = await this.getQueryEmbedding(query);
      if (queryEmbedding && queryEmbedding.length > 0) {
        try {
          const results = await this.memoryStore.recall({
            userId,
            query,
            embedding: queryEmbedding,
            limit: this.memoryConfig.maxMemories,
            minImportance: this.memoryConfig.relevanceThreshold,
          });
          if (results && results.length > 0) {
            return results;
          }
        } catch {
          // Fall through to manual list-and-loop logic on DB recall failure
        }
      }

      const listResult = await this.memoryStore.list({
        userId,
        limit: 50,
        includeExpired: false,
      });

      if (listResult.memories.length === 0) return [];

      const results: MemoryRecallResult[] = [];
      for (const memory of listResult.memories) {
        const embedding = (memory.metadata?.embedding as number[]) ?? null;
        if (!embedding || embedding.length === 0) continue;

        if (!queryEmbedding) continue;

        let dot = 0;
        for (let i = 0; i < Math.min(queryEmbedding.length, embedding.length); i++) {
          dot += queryEmbedding[i] * embedding[i];
        }

        if (dot >= this.memoryConfig.relevanceThreshold) {
          const hoursSinceAccess = memory.lastAccessedAt
            ? (Date.now() - memory.lastAccessedAt.getTime()) / (1000 * 60 * 60)
            : 168;
          const recencyScore = Math.exp(-hoursSinceAccess / 168);

          results.push({
            memory,
            semanticScore: dot,
            recencyScore,
            finalScore: dot * 0.7 + recencyScore * 0.3,
          });
        }
      }

      results.sort((a, b) => b.finalScore - a.finalScore);
      return results.slice(0, this.memoryConfig.maxMemories);
    } catch {
      return [];
    }
  }

  private async getQueryEmbedding(query: string): Promise<number[] | null> {
    if (!this.embeddingProvider) return null;
    try {
      const result = await this.embeddingProvider.embed({ input: query });
      return result.embeddings[0] ?? null;
    } catch {
      return null;
    }
  }

  private formatMemoryBlock(
    memories:   MemoryRecallResult[],
  ): string {
    const lines: string[] = ["<user_memories>"];
    let totalChars = 0;

    for (const item of memories) {
      const m = item.memory;
      const line = `[${m.type}] ${m.content}`;
      if (totalChars + line.length > this.memoryConfig.contextBudgetChars) break;
      lines.push(line);
      totalChars += line.length;
    }

    lines.push("</user_memories>");
    return lines.join("\n");
  }


  // -----------------------------------------------------------------------
  // Sprint 3.7 — Knowledge (RAG) retrieval + context injection
  // -----------------------------------------------------------------------

  /**
   * Prepends a knowledge block when the user's own documents have something
   * relevant to say about the request.
   *
   * Fail-open throughout, exactly like memory injection: a retriever that is
   * absent, a query that is not worth retrieving, an empty result, a provider
   * outage or a database error all return the message untouched. Knowledge is
   * an enhancement, and no failure in it may take down a conversation that
   * would otherwise have worked.
   *
   * @param message  the message to prepend onto, memory block included
   * @param query    the original user text, used as the retrieval query
   */
  private async injectKnowledgeContext(
    message: string,
    query: string,
    userId: string,
  ): Promise<string> {
    if (!this.knowledgeRetriever || !this.knowledgeConfig.enabled) return message;

    // Cheap gate first: acknowledgements and greetings carry nothing to search
    // for, and skipping them avoids an embedding call per confirmation turn.
    if (!shouldRetrieveKnowledge(query)) return message;

    try {
      const result = await this.knowledgeRetriever.retrieve(userId, query, {
        topK: this.knowledgeConfig.maxChunks,
        similarityThreshold: this.knowledgeConfig.minScore,
      });

      const selected = selectKnowledgeChunks(
        result?.results ?? [],
        this.knowledgeConfig.minScore,
        this.knowledgeConfig.maxChunks,
      );

      // Nothing relevant: leave the prompt alone rather than inject an empty
      // block. An empty block invites the model to explain an absence it was
      // never asked about.
      if (selected.length === 0) return message;

      const block = formatKnowledgeBlock(
        selected,
        this.knowledgeConfig.contextBudgetChars,
      );
      if (!block) return message;

      return block + "\n\n" + message;
    } catch (error) {
      // Logged rather than silently swallowed: a persistently failing retriever
      // should be visible in the logs even though it never breaks a request.
      console.log(JSON.stringify({
        level: "warn",
        event: "knowledge_retrieval_failed",
        userId,
        error: error instanceof Error ? error.message : String(error),
      }));
      return message;
    }
  }

  // -----------------------------------------------------------------------
  // Async memory extraction
  // -----------------------------------------------------------------------

  private async extractMemoryAsync(
    userMessage: string,
    assistantMessage: string,
    userId: string,
    conversationId?: string,
  ): Promise<void> {
    if (!this.memoryExtractor || !this.memoryConfig.extractionEnabled) return;

    try {
      const isAvailable = await this.memoryExtractor.isAvailable();
      if (!isAvailable) return;

      await this.memoryExtractor.extract({
        userId,
        messages: [
          { role: "user", content: userMessage },
          { role: "assistant", content: assistantMessage },
        ],
        conversationId,
        expiryDays: this.memoryConfig.extractionExpiryDays,
      });
    } catch {
      // Extraction failure must not affect the response
    }
  }

  // -----------------------------------------------------------------------
  // Existing methods (unchanged)
  // -----------------------------------------------------------------------

  private selectAgent(request: JarvisRequest): IAgent {
    const agentId = request.agentId;
    if (agentId) {
      const agent = this.agentRegistry.get(agentId);
      if (!agent) {
        throw new JarvisError("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
      }
      if (agent.getStatus() === "disabled") {
        throw new JarvisError("AGENT_ERROR", `Agent is disabled: ${agentId}`);
      }
      if (agent.getStatus() === "error") {
        throw new JarvisError("AGENT_ERROR", `Agent is in error state: ${agentId}`);
      }
      return agent;
    }

    // Try Meta intent routing if query relates to Meta Ads
    if (request.message && isMetaAdsQuery(request.message, request.conversationHistory)) {
      const metaAgent = this.agentRegistry.get("meta-ads-agent");
      if (metaAgent && metaAgent.getStatus() !== "disabled" && metaAgent.getStatus() !== "error") {
        return metaAgent;
      }
    }

    const agents = this.agentRegistry.getAll();
    const available = agents.find((a) => a.getStatus() === "ready" || a.getStatus() === "idle");
    if (!available) {
      throw new JarvisError("AGENT_ERROR", "No available agents");
    }
    return available;
  }

  private async initializeAgent(agent: IAgent, context: SessionContext): Promise<void> {
    if (agent.getStatus() === "idle") {
      await agent.initialize({
        userId: context.auth.userId,
        conversationId: context.conversationId,
        traceId: context.traceId,
        memoryManager: this.memoryStore ?? createNoopMemoryStore(),
        toolRegistry: this.toolRegistry ?? {
          get: () => undefined,
          getAll: () => [],
        },
        auditLogger: this.auditLogger,
      });
    }
  }

  private async executeTools(
    actions: Array<{ toolId: string; toolCallId?: string; params: Record<string, unknown> }>,
    context: SessionContext
  ): Promise<{ results: ToolExecutionResult[]; pendingAction?: Record<string, unknown> }> {
    const results: ToolExecutionResult[] = [];
    const executionId = crypto.randomUUID();
    let capturedPendingAction: Record<string, unknown> | undefined;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      const stepStartedAt = new Date();

      // Check if this is a write tool that needs pending-action flow
      const tool = this.toolRegistry?.get(action.toolId);
      const needsConfirmation = tool?.requiresApproval === true;

      if (needsConfirmation && this.pendingActionService && context.conversationId) {
        // Create a pending action instead of executing directly
        const pendingService = this.pendingActionService as import("./pending-action-service.js").PendingActionService;
        try {
          const { pendingAction, message } = await pendingService.createPendingAction({
            conversationId: context.conversationId,
            userId: context.auth.userId,
            toolId: action.toolId,
            action: action.toolId,
            params: action.params,
            riskLevel: (tool?.risk ?? "EXTERNAL_SIDE_EFFECT") as import("@jarvis/core").RiskLevel,
          });

          // Return a result that tells the agent to present the pending action
          const pendingResult: ToolExecutionResult = {
            executionId,
            toolId: action.toolId,
            toolCallId: action.toolCallId,
            status: "approval_required",
            approvalId: pendingAction.approvalId,
            error: message,
            startedAt: stepStartedAt,
            completedAt: new Date(),
            durationMs: Date.now() - stepStartedAt.getTime(),
          };
          results.push(pendingResult);
          capturedPendingAction = {
            id: pendingAction.id,
            toolId: pendingAction.toolId,
            action: pendingAction.action,
            params: pendingAction.params,
            riskLevel: pendingAction.riskLevel,
            state: pendingAction.state,
            approvalId: pendingAction.approvalId,
            expiresAt: pendingAction.expiresAt,
            summary: message,
          };
          continue;
        } catch {
          // Fall through to normal execution if pending action creation fails
        }
      }

      const request: ToolExecutionRequest = {
        toolId: action.toolId,
        toolCallId: action.toolCallId,
        params: action.params,
        userId: context.auth.userId,
        role: context.auth.role,
        agentId: context.agentId,
        conversationId: context.conversationId,
        traceId: context.traceId,
        ipAddress: context.ipAddress,
        executionId,
        stepIndex: i,
      };

      if (this.toolApprovalService && this.toolRegistry) {
        const toolForApproval = this.toolRegistry.get(action.toolId);
        if (toolForApproval) {
          const check = await this.toolApprovalService.checkPreExecution(
            toolForApproval,
            action.params,
            {
              userId: context.auth.userId,
              role: context.auth.role,
              executionId,
              stepIndex: i,
              traceId: context.traceId,
              conversationId: context.conversationId,
            }
          );

          if (!check.allowed && check.requiresApproval) {
            const approvalResult: ToolExecutionResult = {
              executionId,
              toolId: action.toolId,
              toolCallId: action.toolCallId,
              status: "approval_required",
              approvalId: check.approvalId,
              error: check.reason,
              startedAt: stepStartedAt,
              completedAt: new Date(),
              durationMs: Date.now() - stepStartedAt.getTime(),
            };
            results.push(approvalResult);
            continue;
          }

          if (!check.allowed) {
            const deniedResult: ToolExecutionResult = {
              executionId,
              toolId: action.toolId,
              toolCallId: action.toolCallId,
              status: "permission_denied",
              error: check.reason,
              startedAt: stepStartedAt,
              completedAt: new Date(),
              durationMs: Date.now() - stepStartedAt.getTime(),
            };
            results.push(deniedResult);
            continue;
          }
        }
      }

      const result = await this.toolExecutor.execute(request);
      result.toolCallId = action.toolCallId;
      results.push(result);
    }

    return { results, pendingAction: capturedPendingAction };
  }

  // -----------------------------------------------------------------------
  // Tool execution summary & structured logging
  // -----------------------------------------------------------------------

  private buildToolExecutionSummary(results: ToolExecutionResult[]): ToolExecutionSummary {
    const executions: ToolExecutionEntry[] = results.map((r) => ({
      toolId: r.toolId,
      toolCallId: r.toolCallId,
      status: r.status,
      success: r.status === "completed",
      error: r.error,
      durationMs: r.durationMs,
    }));

    const succeeded = executions.filter((e) => e.status === "completed").length;
    const failed = executions.filter((e) =>
      ["failed", "timed_out"].includes(e.status)
    ).length;
    const denied = executions.filter((e) =>
      ["permission_denied", "approval_required", "approval_pending", "approval_denied"].includes(e.status)
    ).length;

    return {
      total: executions.length,
      succeeded,
      failed,
      denied,
      allSucceeded: executions.length > 0 && succeeded === executions.length,
      allFailed: executions.length > 0 && (succeeded + denied) === 0 && failed > 0,
      executions,
    };
  }

  private logStructuredToolExecution(
    context: SessionContext,
    summary: ToolExecutionSummary,
    startedAt: Date
  ): void {
    const totalDurationMs = Date.now() - startedAt.getTime();
    const redactedExecutions = summary.executions.map((e) => ({
      tool: e.toolId,
      status: e.status,
      success: e.success,
      error: e.error,
      durationMs: e.durationMs,
    }));

    console.log(JSON.stringify({
      level: "info",
      event: "tool_execution_summary",
      traceId: context.traceId,
      userId: context.auth.userId,
      totalTools: summary.total,
      succeeded: summary.succeeded,
      failed: summary.failed,
      denied: summary.denied,
      allSucceeded: summary.allSucceeded,
      allFailed: summary.allFailed,
      totalDurationMs,
      executions: redactedExecutions,
    }));
  }

  // -----------------------------------------------------------------------
  // Tool intelligence — description injection & plan validation
  // -----------------------------------------------------------------------

  buildToolSystemPrompt(): string {
    if (!this.toolRegistry) return "";
    const tools = this.toolRegistry.getAll();
    return this.toolDescriptionBuilder.formatForSystemPrompt(tools);
  }

  validateToolPlan(
    plan: { intent: string; requiresTools: boolean; steps: Array<{ tool: string; params: Record<string, unknown>; dependsOn?: number }> }
  ): { valid: boolean; errors: string[] } {
    if (!this.toolRegistry) {
      return { valid: false, errors: ["No tool registry configured"] };
    }
    const tools = this.toolRegistry.getAll();
    return this.toolPlanValidator.validate(plan, tools);
  }

  parseToolPlan(modelOutput: string): ReturnType<ToolPlanParser["parse"]> {
    return this.toolPlanParser.parse(modelOutput);
  }

  private buildSuccessResponse(
    message: string,
    traceId: string,
    context: SessionContext,
    metadata?: Record<string, unknown>
  ): JarvisResponse {
    return {
      success: true,
      data: {
        message,
        conversationId: context.conversationId ?? "",
        agentId: context.agentId,
        metadata,
      },
      traceId,
      timestamp: new Date().toISOString(),
    };
  }

  private buildErrorResponse(
    error: JarvisError,
    traceId: string,
    _context: SessionContext
  ): JarvisResponse {
    return {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
      traceId,
      timestamp: new Date().toISOString(),
    };
  }

  private async auditRequest(
    context: SessionContext,
    result: "success" | "failure",
    startedAt: Date,
    errorMessage?: string
  ): Promise<void> {
    await this.auditLogger.log({
      userId: context.auth.userId,
      agentId: context.agentId,
      action: "orchestrator.process",
      result,
      traceId: context.traceId,
      ipAddress: context.ipAddress,
      metadata: {
        durationMs: new Date().getTime() - startedAt.getTime(),
        ...(errorMessage && { error: errorMessage }),
      },
    });
  }
}

function isMetaAdsQuery(message: string, history?: ConversationMessage[]): boolean {
  const normalized = message.toLowerCase();

  // 1. Explicit non-Meta platforms or generic tech tools (Highest priority overrides context / keywords)
  const nonMetaPlatformTriggers = [
    /\bgoogle\b/i,
    /\blinkedin\b/i,
    /\badwords\b/i,
    /\bgmail\b/i,
    /\bemail\b/i,
    /\bpython\b/i,
    /\bjavascript\b/i,
    /\btypescript\b/i,
    /\bcalendar\b/i,
    /\bpdf\b/i,
    /\bwebsite\b/i,
    /\bexcel\b/i,
  ];

  const hasExplicitNonMetaPlatform = nonMetaPlatformTriggers.some((pattern) => pattern.test(normalized));
  if (hasExplicitNonMetaPlatform) {
    return false;
  }

  // 2. Explicit Meta Ads triggers
  const explicitMetaTriggers = [
    /\bmeta\b/i,
    /\bfacebook\b/i,
    /\binsta\b/i,
    /\binstagram\b/i,
  ];

  const hasExplicitMeta = explicitMetaTriggers.some((pattern) => pattern.test(normalized));
  if (hasExplicitMeta) {
    return true;
  }

  // 3. Strong Meta Ads domain terminologies
  const strongDomainTriggers = [
    /\bcpa\b/i,
    /\broas\b/i,
    /\bctr\b/i,
    /\bcpc\b/i,
    /\bcpm\b/i,
    /\badset\b/i,
    /\badsets\b/i,
    /\bad\s+set\b/i,
    /\bad\s+sets\b/i,
    /\bcreatives?\b/i,
    /\bbadh\s+raha\b/i,
    /\bworst\s+perform\b/i,
  ];

  const hasStrongDomainIntent = strongDomainTriggers.some((pattern) => pattern.test(normalized));
  if (hasStrongDomainIntent) {
    return true;
  }

  // 4. Generic Meta keywords (requires history context to disambiguate)
  const genericMetaKeywords = [
    /\bcampaign\b/i,
    /\bcampaigns\b/i,
    /\bad\b/i,
    /\bads\b/i,
    /\bbudget\b/i,
    /\bbudgets\b/i,
    /\bperformance\b/i,
    /\boptimize\b/i,
    /\bpause\b/i,
    /\bresume\b/i,
    /\banalytics\b/i,
    /\baccount\b/i,
  ];

  const hasGenericMetaKeyword = genericMetaKeywords.some((pattern) => pattern.test(normalized));
  if (hasGenericMetaKeyword) {
    if (history && history.length > 0) {
      const recentMessages = history.slice(-3); // Look at the last 3 turns
      for (const msg of recentMessages) {
        const content = msg.content.toLowerCase();
        const isMeta = explicitMetaTriggers.some(p => p.test(content)) ||
                       strongDomainTriggers.some(p => p.test(content));
        if (isMeta) {
          return true;
        }
      }
    }
  }

  return false;
}
