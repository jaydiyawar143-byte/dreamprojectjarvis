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
  RetrievedChunk,
} from "@jarvis/core";
import { JarvisError, decideSurface, classifyToolFailures, toClientErrorDetails } from "@jarvis/core";
import type { SurfaceDecision } from "@jarvis/core";
import type { AgentPolicy, AgentResolution, ISkillContextProvider } from "@jarvis/core";
import { renderSkillContext } from "@jarvis/core";
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

/**
 * What knowledge retrieval produced for one turn.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED A BARE `string`.
 *
 * Knowledge injection used to return the augmented prompt and nothing
 * else, which meant the retrieved passages existed for exactly as long as it
 * took to concatenate them into a string and were then unrecoverable. A
 * Knowledge surface needs the SAME passages as structured rows — document,
 * chunk, page, score — and the only two ways to get them were to parse them
 * back out of the prompt, or to run retrieval a second time. Parsing generated
 * text is brittle; a second retrieval is a second embedding call and a second
 * chance for the two to disagree about what was cited.
 *
 * So the method now returns both. `message` is byte-identical to what it
 * returned before — every existing RAG test pins that string, and they all
 * still pass — and `chunks` is the same array the block was built from, which
 * is what makes a citation on screen provably the passage the model was shown.
 *
 * `outcome` distinguishes the four ways this can produce no passages, because
 * "the retriever is off", "this message was not worth searching for", "nothing
 * matched" and "retrieval threw" are four different things and only the last
 * is a problem.
 * ---------------------------------------------------------------------------
 */
export interface KnowledgeInjection {
  /** The prompt, with the knowledge block prepended when there was one. */
  message: string;
  /** The passages the block was built from, in the order they were used. */
  chunks: RetrievedChunk[];
  outcome: "retrieved" | "empty" | "skipped" | "disabled" | "failed";
  /** ISO timestamp of the retrieval, or null when none ran. */
  retrievedAt: string | null;
}

const DEFAULT_MAX_TOOL_EXECUTIONS = 10;
const DEFAULT_MAX_ORCHESTRATION_DEPTH = 5;
const DEFAULT_RELEVANCE_THRESHOLD = 0.3;
const DEFAULT_MAX_MEMORIES = 5;
const DEFAULT_CONTEXT_BUDGET_CHARS = 2000;

/**
 * How long a memory-subsystem health answer is trusted.
 *
 * Short enough that an outage is noticed within a conversational beat, long
 * enough that a burst of turns does not re-probe a remote provider for each
 * one. Failures expire sooner than successes so recovery is picked up quickly.
 */
const MEMORY_AVAILABILITY_TTL_MS = 60_000;
const MEMORY_UNAVAILABILITY_TTL_MS = 10_000;

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
  /** S3 — semantic planning context. Null keeps the prompt exactly as it was. */
  private readonly skillContextProvider: ISkillContextProvider | null;
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
    this.skillContextProvider = config.skillContext ?? null;
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

      // ---------------------------------------------------------------------
      // Memory and knowledge, CONCURRENTLY.
      //
      // Both take the ORIGINAL message as their query — recalled memories are
      // about the user, and folding them into the retrieval vector would pull
      // the search away from what was actually asked — so neither depends on
      // the other's result. Only the final string depends on both. Run in
      // series they cost two sequential embedding calls plus two sequential
      // database round trips in front of every single turn, on the critical
      // path of a person waiting for an answer out loud.
      //
      // The composed prompt is BYTE-IDENTICAL to what serial execution
      // produced: knowledge block, then memory block, then the message.
      // ---------------------------------------------------------------------
      const [withMemory, knowledgeResult, skillBlock] = await Promise.all([
        this.injectMemoryContext(request.message, context.auth.userId),
        this.retrieveKnowledgeContext(request.message, context.auth.userId),
        this.buildSkillBlock(context.auth.userId, policy),
      ]);

      const knowledge = knowledgeResult.applyTo(withMemory);
      // S3 — the skill block is the OUTERMOST prefix, ahead of knowledge and
      // memory. Those two are about this request; this is standing orientation
      // about what works right now, and reads as a preamble to both. Empty
      // string when there is no provider or nothing to say, which is why this
      // is a concatenation rather than a branch: with no port the string is
      // byte-identical to what every existing prompt test pins.
      const userMessage = skillBlock + knowledge.message;

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

            // ---------------------------------------------------------------
            // A surface even on the failure path.
            //
            // §32: when a provider cannot answer, say so — do not fall back to
            // silence. Without this, a maps search that failed because the user
            // has not shared their location produced a bare error and no panel,
            // so the one thing that could have told them what to DO about it
            // never appeared.
            // ---------------------------------------------------------------
            const failureSurface = decideSurface({
              message: request.message,
              toolResults: allToolResults,
              activeContextKeys: readActiveContextKeys(request.metadata),
            });
            await this.auditSurfaceDecision(context, failureSurface);

            // -------------------------------------------------------------
            // SAY WHAT ACTUALLY FAILED.
            //
            // This used to return one fixed sentence, "Data retrieval failed.",
            // with the real cause in `details.reason` — which no client reads.
            // A Gmail draft rejected for having no recipient, a Google account
            // that was never connected, and a genuine outage all reached the
            // user as the same four words, none of which say what to do.
            //
            // The fixed sentence was itself a fix for something worse (it used
            // to blame Meta Ads on every path), and the lesson taken then was
            // "say less" when it should have been "classify, then say". The
            // classifier only recognises failures whose remedy is known and
            // refuses to surface anything that does not look like prose
            // written for a person, so an unrecognised failure still collapses
            // to the old generic message rather than leaking a payload.
            // -------------------------------------------------------------
            const classified = classifyToolFailures(
              toolSummary.executions
                .filter((e) => !e.success)
                .map((e) => ({
                  toolId: e.toolId,
                  ...(e.error ? { error: e.error } : {}),
                  ...(e.status ? { status: String(e.status) } : {}),
                }))
            );

            return this.buildErrorResponse(
              new JarvisError(
                "TOOL_EXECUTION_FAILED",
                classified.message,
                {
                  toolExecution: toolSummary,
                  reason: failedTools,
                  // The stable code a client may branch on, kept separate from
                  // the prose so the wording can change without breaking it.
                  failureCode: classified.code,
                  actionable: classified.actionable,
                  ...(failureSurface.directive ? { surface: failureSurface.directive } : {}),
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

          // ---------------------------------------------------------------
          // Contextual surface.
          //
          // Decided from the ORIGINAL message and the tool results that
          // actually came back — never from `output.message`, which is the
          // model's prose and is exactly the thing a surface must not be
          // built out of. `decideSurface` returns null far more often than
          // not, and a null is the normal, correct outcome.
          //
          // It rides `metadata` because `pendingAction` already does: the
          // client, the route and the persistence layer all forward this
          // object unchanged, so a surface needs no new transport.
          // ---------------------------------------------------------------
          const surfaceDecision = decideSurface({
            message: request.message,
            toolResults: allToolResults,
            activeContextKeys: readActiveContextKeys(request.metadata),
            // The last few things the USER said, for follow-ups that carry no
            // subject of their own ("Tokyo bhi").
            recentUserMessages: (request.conversationHistory ?? [])
              .filter((m) => m.role === "user")
              .slice(-6)
              .map((m) => m.content),
            // The passages the model was actually shown, so a Knowledge
            // surface cites what was retrieved rather than what was written.
            knowledge: {
              chunks: knowledge.chunks,
              retrievedAt: knowledge.retrievedAt,
              outcome: knowledge.outcome,
            },
          });

          if (surfaceDecision.directive) {
            responseMetadata.surface = surfaceDecision.directive;
          }

          // Audited whichever way it went. "Why did a panel appear" and "why
          // did one NOT appear" are both questions worth being able to answer,
          // and the rationale carries no user data — only the intent label,
          // the confidence and a one-line outcome.
          await this.auditSurfaceDecision(context, surfaceDecision);

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

  /**
   * Whether memory can be used, without paying for the answer every turn.
   *
   * `memoryStore.isAvailable()` is not a local check: it probes the embedding
   * provider, which for OpenAI is a live `GET /v1/models` over the network.
   * Measured from this deployment, that call costs ~1.3 seconds — and the
   * orchestrator was making it TWICE per turn, once here and once again inside
   * `recallMemories`, for ~2.7 seconds of dead time in front of every answer,
   * spoken or typed. That was the largest single component of chat latency.
   *
   * A health answer is not stale after one second, so it is cached briefly.
   * Positives are held longer than negatives: a system that has just come back
   * should be used again promptly, whereas one that was fine a moment ago
   * almost certainly still is — and if it is not, every path below this is
   * fail-open and the turn proceeds without memory rather than breaking.
   */
  private memoryAvailability: { value: boolean; until: number } | null = null;

  private async isMemoryAvailable(): Promise<boolean> {
    if (!this.memoryStore) return false;

    const now = Date.now();
    if (this.memoryAvailability && now < this.memoryAvailability.until) {
      return this.memoryAvailability.value;
    }

    try {
      const value = await this.memoryStore.isAvailable();
      this.memoryAvailability = {
        value,
        until: now + (value ? MEMORY_AVAILABILITY_TTL_MS : MEMORY_UNAVAILABILITY_TTL_MS),
      };
      return value;
    } catch {
      this.memoryAvailability = { value: false, until: now + MEMORY_UNAVAILABILITY_TTL_MS };
      return false;
    }
  }

  private async injectMemoryContext(
    userMessage: string,
    userId: string,
  ): Promise<string> {
    if (!this.memoryStore) return userMessage;

    try {
      const isAvailable = await this.isMemoryAvailable();
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
      const isAvailable = await this.isMemoryAvailable();
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
  /**
   * Retrieval, separated from the string it will eventually be prepended to.
   *
   * The split exists so retrieval can run CONCURRENTLY with memory recall: the
   * search depends only on the user's original words, while the composition
   * depends on both. `applyTo` is pure and synchronous, so the prompt is built
   * the moment both halves are in hand — and built in the same order as before,
   * which is what keeps the prompt byte-identical.
   */
  /**
   * The skill block for this turn, or "" — Skill System V1, S3.
   *
   * SEMANTIC CONTEXT ONLY. What comes back is prose prepended to the message.
   * It does not touch `providerTools`, which the agent still receives in full,
   * and it is not consulted by `executeTools`, which re-checks every call
   * against `policy.allowedTools` regardless of what this said. A skill named
   * here is not thereby authorized; a tool absent from here is not thereby
   * forbidden.
   *
   * NO POLICY, NO CONTEXT. Without a policy there is no allowlist to intersect
   * against, so there is no way to promise the agent can reach what the block
   * would describe. Silence is the honest answer, and it is also what the
   * Sprint 1-5 registries (which carry no policies) already get.
   *
   * FAILURE IS NOT THE USER'S PROBLEM. A capability report needs live
   * integration state, which can be slow or down. Every failure mode returns
   * "" and the turn proceeds exactly as it does today; none of them aborts a
   * conversation over missing ORIENTATION.
   */
  private async buildSkillBlock(
    userId: string,
    policy: AgentPolicy | undefined
  ): Promise<string> {
    if (!this.skillContextProvider || !policy) return "";

    const startedAt = Date.now();
    try {
      const contexts = await this.skillContextProvider.forAgent(
        userId,
        new Set(policy.allowedTools)
      );
      const block = renderSkillContext(contexts);

      // Logged because this is the one place S3 adds work to the critical
      // path of every turn. A regression here is a regression everyone feels,
      // and it should be visible before it is felt.
      if (process.env.NODE_ENV === "development") {
        console.log(JSON.stringify({
          level: "debug",
          event: "skill_context_built",
          agentId: policy.agentId,
          skills: contexts.length,
          durationMs: Date.now() - startedAt,
        }));
      }

      return block ? block + "\n\n" : "";
    } catch (error) {
      console.log(JSON.stringify({
        level: "warn",
        event: "skill_context_failed",
        agentId: policy.agentId,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }));
      return "";
    }
  }

  private async retrieveKnowledgeContext(
    query: string,
    userId: string,
  ): Promise<{ applyTo: (message: string) => KnowledgeInjection }> {
    /** The unchanged-prompt outcome, in every shape it can occur. */
    const untouched = (why: KnowledgeInjection["outcome"]) => ({
      applyTo: (message: string): KnowledgeInjection => ({
        message,
        chunks: [],
        outcome: why,
        retrievedAt: null,
      }),
    });

    if (!this.knowledgeRetriever || !this.knowledgeConfig.enabled) return untouched("disabled");

    // Cheap gate first: acknowledgements and greetings carry nothing to search
    // for, and skipping them avoids an embedding call per confirmation turn.
    if (!shouldRetrieveKnowledge(query)) return untouched("skipped");

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
      if (selected.length === 0) return untouched("empty");

      const block = formatKnowledgeBlock(
        selected,
        this.knowledgeConfig.contextBudgetChars,
      );
      if (!block) return untouched("empty");

      const retrievedAt = new Date().toISOString();
      return {
        applyTo: (message: string): KnowledgeInjection => ({
          // BYTE-IDENTICAL to what this method returned before it was given a
          // typed contract. The prompt is the thing every existing RAG test
          // pins, and the structured evidence beside it must cost the answer
          // nothing.
          message: block + "\n\n" + message,
          chunks: selected,
          outcome: "retrieved",
          retrievedAt,
        }),
      };
    } catch (error) {
      // Logged rather than silently swallowed: a persistently failing retriever
      // should be visible in the logs even though it never breaks a request.
      console.log(JSON.stringify({
        level: "warn",
        event: "knowledge_retrieval_failed",
        userId,
        error: error instanceof Error ? error.message : String(error),
      }));
      return untouched("failed");
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

    // R-30 — the router named agents that ARE registered, and none of them can
    // serve this request (the general assistant is always among them). Taking
    // whichever other agent happens to be ready here answered plain requests
    // with the Meta Ads agent, its prompt and its tools, and told nobody.
    if (candidates.some((candidate) => this.agentRegistry.get(candidate.agentId))) {
      throw new JarvisError("AGENT_ERROR", "No available agents");
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
        // R-31 — `details.cause` goes to the browser only as an error code.
        details: toClientErrorDetails(error.details),
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

  /**
   * Records that JARVIS decided to show — or not to show — a surface.
   *
   * Both outcomes are logged. "Why did a map appear" and "why did nothing
   * appear when I asked for a route" are the same class of question, and only
   * one of them is answerable if the null case is silent.
   *
   * Deliberately carries NO user content: the intent label, the confidence and
   * a one-line outcome, plus the surface type when there is one. The message
   * itself is already audited by `auditRequest`; repeating it here would put a
   * second copy of everything the user says into the audit trail for no gain.
   */
  private async auditSurfaceDecision(
    context: SessionContext,
    decision: SurfaceDecision
  ): Promise<void> {
    const directive = decision.directive;
    try {
      await this.auditLogger.log({
        userId: context.auth.userId,
        agentId: context.agentId,
        action: directive ? `surface.${directive.op}` : "surface.none",
        result: "success",
        traceId: context.traceId,
        ipAddress: context.ipAddress,
        metadata: {
          intent: decision.rationale.intent,
          confidence: decision.rationale.confidence,
          outcome: decision.rationale.outcome,
          ...(directive?.op === "open" ? { surfaceType: directive.surface.type } : {}),
        },
      });
    } catch {
      // A surface is a convenience. Failing the user's whole request because
      // the audit sink was briefly unavailable would not be.
    }
  }
}

/**
 * Which surfaces the client says are already on screen.
 *
 * Sent by the browser on each turn, because only the browser knows: a surface
 * may have closed itself on an idle timer since the last message. Validated
 * strictly and silently dropped if malformed — a bad hint costs a reuse, which
 * is a duplicate panel, not a wrong answer.
 */
function readActiveContextKeys(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.activeSurfaceKeys;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 160)
    .slice(0, 4);
}
