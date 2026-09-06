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
  IKnowledgeRetriever,
  KnowledgeContextConfig,
  IPermissionChecker,
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";
import type { AgentPolicy, AgentResolution } from "@jarvis/core";
import type { AgentRegistry } from "./registry.js";
import { rankAgentCandidates, isAmbiguous } from "./agent-router.js";
import { isToolAllowed, resolveAllowedToolId, scopedToolRegistry } from "./agent-policy.js";
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
  private readonly permissionChecker: IPermissionChecker | null;
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
    this.permissionChecker = config.permissionChecker ?? null;
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
      const { agent, policy, resolution } = this.selectAgent(request, context);
      context.agentId = agent.id;
      await this.initializeAgent(agent, context, policy);

      const agentContext = {
        userId: context.auth.userId,
        conversationId: context.conversationId,
        traceId: context.traceId,
        memoryManager: this.memoryStore ?? createNoopMemoryStore(),
        // Sprint 6.9 — least privilege. The agent sees only the tools its
        // policy grants, so an agent that looks a tool up directly (the Meta
        // and Google agents both preload account context this way) cannot
        // reach a provider it does not own.
        toolRegistry: this.scopeRegistryForAgent(policy),
        auditLogger: this.auditLogger,
      };

      await agent.initialize(agentContext);

      if (process.env.NODE_ENV === "development") {
        console.log(JSON.stringify({
          level: "debug",
          event: "agent_resolution",
          conversationId: context.conversationId,
          agentId: agent.id,
          domain: resolution.domain,
          status: resolution.status,
          confidence: resolution.confidence,
          reason: resolution.reason,
          ...(resolution.candidates ? { candidates: resolution.candidates } : {}),
        }));
      }

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
          context,
          policy
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

  // -----------------------------------------------------------------------
  // Sprint 6.8 — server-controlled agent resolution
  // -----------------------------------------------------------------------

  /**
   * Chooses the agent for this request. The decision is the server's.
   *
   * A client MAY name an agent, but the name is treated as a request and not
   * as an instruction: the agent must exist, be healthy, be marked
   * `clientSelectable`, and the caller's role must clear the agent's permission
   * floor. That matters more after Sprint 6 than it did before, because the
   * agent choice now selects a TOOL ALLOWLIST — without these checks, naming an
   * agent would be a way to pick your own privileges.
   *
   * Otherwise the deterministic router ranks candidates and the first one that
   * is registered, healthy and permitted wins. Ranked candidates rather than a
   * single answer is what lets a deployment with WhatsApp or n8n unconfigured
   * fall through to the general assistant instead of failing.
   */
  private selectAgent(
    request: JarvisRequest,
    context: SessionContext
  ): { agent: IAgent; policy: AgentPolicy | undefined; resolution: AgentResolution } {
    const requestedId = request.agentId;

    if (requestedId) {
      const agent = this.agentRegistry.get(requestedId);
      if (!agent) {
        throw new JarvisError("AGENT_NOT_FOUND", `Agent not found: ${requestedId}`);
      }
      if (agent.getStatus() === "disabled") {
        throw new JarvisError("AGENT_ERROR", `Agent is disabled: ${requestedId}`);
      }
      if (agent.getStatus() === "error") {
        throw new JarvisError("AGENT_ERROR", `Agent is in error state: ${requestedId}`);
      }

      const policy = this.agentRegistry.getPolicy(requestedId);

      if (policy && !policy.clientSelectable) {
        throw new JarvisError(
          "AUTHORIZATION_FAILED",
          `Agent "${requestedId}" cannot be selected directly`
        );
      }

      if (policy && !this.isRolePermitted(policy, context)) {
        throw new JarvisError(
          "AUTHORIZATION_FAILED",
          `Your role is not permitted to use agent "${requestedId}"`
        );
      }

      return {
        agent,
        policy,
        resolution: {
          status: "resolved",
          agentId: agent.id,
          domain: policy?.domain,
          confidence: 1,
          reason: "explicitly requested by client and permitted by policy",
        },
      };
    }

    const candidates = rankAgentCandidates(
      request.message ?? "",
      request.conversationHistory
    );
    const ambiguous = isAmbiguous(candidates);

    for (const candidate of candidates) {
      const agent = this.agentRegistry.get(candidate.agentId);
      if (!agent) continue;

      const status = agent.getStatus();
      if (status === "disabled" || status === "error") continue;

      const policy = this.agentRegistry.getPolicy(candidate.agentId);
      // A role that cannot use this agent is not an error — the next candidate,
      // and ultimately the general assistant, is the right destination.
      if (policy && !this.isRolePermitted(policy, context)) continue;

      return {
        agent,
        policy,
        resolution: {
          status: ambiguous ? "ambiguous" : "resolved",
          agentId: agent.id,
          domain: candidate.domain,
          confidence: candidate.confidence,
          reason: candidate.reason,
          ...(ambiguous
            ? {
                candidates: candidates
                  .filter((c) => c.domain !== "general")
                  .map((c) => c.agentId),
              }
            : {}),
        },
      };
    }

    // Nothing the router named is registered. This is the Sprint 1-5 path and
    // the path any registry built without the standard agent ids takes.
    const available = this.agentRegistry
      .getAll()
      .find((a) => a.getStatus() === "ready" || a.getStatus() === "idle");
    if (!available) {
      throw new JarvisError("AGENT_ERROR", "No available agents");
    }

    return {
      agent: available,
      policy: this.agentRegistry.getPolicy(available.id),
      resolution: {
        status: "resolved",
        agentId: available.id,
        confidence: 0.1,
        reason: "no routed agent was registered; first available agent used",
      },
    };
  }

  /**
   * Whether the caller's role clears the agent's permission floor.
   *
   * Reuses the tool permission model rather than inventing a second one: an
   * agent requiring `execute` is asking for exactly the permission its tools
   * would demand, so an agent can never be a way around what a role may reach.
   * With no permission checker wired the check is skipped — the tool layer
   * still performs its own, so this is a narrowing gate, never the only one.
   */
  private isRolePermitted(policy: AgentPolicy, context: SessionContext): boolean {
    if (!this.permissionChecker) return true;
    return policy.requiredPermissions.every((perm) =>
      this.permissionChecker!.hasPermission(context.auth.role, "tools", perm)
    );
  }

  /** The tool view an agent is given, narrowed to its policy. */
  private scopeRegistryForAgent(policy: AgentPolicy | undefined): {
    get(toolId: string): ITool | undefined;
    getAll(): ITool[];
  } {
    const base = this.toolRegistry ?? {
      get: () => undefined,
      getAll: () => [],
    };
    if (!policy) return base;
    return scopedToolRegistry(base, policy.allowedTools);
  }

  private async initializeAgent(
    agent: IAgent,
    context: SessionContext,
    policy: AgentPolicy | undefined
  ): Promise<void> {
    if (agent.getStatus() === "idle") {
      await agent.initialize({
        userId: context.auth.userId,
        conversationId: context.conversationId,
        traceId: context.traceId,
        memoryManager: this.memoryStore ?? createNoopMemoryStore(),
        toolRegistry: this.scopeRegistryForAgent(policy),
        auditLogger: this.auditLogger,
      });
    }
  }

  private async executeTools(
    actions: Array<{ toolId: string; toolCallId?: string; params: Record<string, unknown> }>,
    context: SessionContext,
    policy: AgentPolicy | undefined
  ): Promise<{ results: ToolExecutionResult[]; pendingAction?: Record<string, unknown> }> {
    const results: ToolExecutionResult[] = [];
    const executionId = crypto.randomUUID();
    let capturedPendingAction: Record<string, unknown> | undefined;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      const stepStartedAt = new Date();

      // ---------------------------------------------------------------------
      // Sprint 6.10 — allowlist gate.
      //
      // FIRST, before the pending-action branch, before the approval check and
      // before the executor. A tool outside the agent's policy is not "an
      // action awaiting approval" — it is an action this agent may never take,
      // and creating an approval for it would put a request in front of a human
      // that should never have been asked. Denials are audited so an agent
      // repeatedly reaching outside its policy is visible.
      //
      // The policy is read from the REGISTRY, never from `agent.tools`: the
      // instance is ordinary code and could report anything.
      // ---------------------------------------------------------------------
      if (policy && !isToolAllowed(action.toolId, policy.allowedTools)) {
        const reason = `Agent "${policy.agentId}" is not authorized to use tool "${action.toolId}"`;

        results.push({
          executionId,
          toolId: action.toolId,
          toolCallId: action.toolCallId,
          status: "permission_denied",
          error: reason,
          startedAt: stepStartedAt,
          completedAt: new Date(),
          durationMs: Date.now() - stepStartedAt.getTime(),
        });

        await this.auditLogger.log({
          userId: context.auth.userId,
          agentId: policy.agentId,
          toolId: action.toolId,
          action: "agent.tool_denied",
          result: "rejected",
          traceId: context.traceId,
          ipAddress: context.ipAddress,
          metadata: {
            reason,
            domain: policy.domain,
            executionId,
            stepIndex: i,
          },
        });

        continue;
      }

      // Both spellings of a tool name reach the same registry id, so the rest
      // of the loop works on the canonical one.
      if (policy) {
        const canonical = resolveAllowedToolId(action.toolId, policy.allowedTools);
        if (canonical) action.toolId = canonical;
      }

      // Check if this is a write tool that needs pending-action flow
      const tool = this.toolRegistry?.get(action.toolId);
      const needsConfirmation = tool?.requiresApproval === true;

      // ---------------------------------------------------------------------
      // Sprint 6.10 — fail closed when nothing is left to gate a write.
      //
      // Normally either the pending-action flow or ToolApprovalService stands
      // between a side-effecting tool and the provider. If a container is wired
      // with neither, that gap would silently turn every agent into an
      // autonomous writer. A policy that says writes need approval is taken at
      // its word instead: with no gate available, the write does not happen.
      // ---------------------------------------------------------------------
      if (
        policy?.writesRequireApproval &&
        tool &&
        tool.risk !== "READ_ONLY" &&
        !this.toolApprovalService &&
        !(needsConfirmation && this.pendingActionService && context.conversationId)
      ) {
        const reason = `Tool "${action.toolId}" requires approval but no approval service is configured`;

        results.push({
          executionId,
          toolId: action.toolId,
          toolCallId: action.toolCallId,
          status: "permission_denied",
          error: reason,
          startedAt: stepStartedAt,
          completedAt: new Date(),
          durationMs: Date.now() - stepStartedAt.getTime(),
        });

        await this.auditLogger.log({
          userId: context.auth.userId,
          agentId: policy.agentId,
          toolId: action.toolId,
          action: "agent.approval_gate_missing",
          result: "rejected",
          traceId: context.traceId,
          ipAddress: context.ipAddress,
          metadata: { reason, risk: tool.risk, executionId, stepIndex: i },
        });

        continue;
      }

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
