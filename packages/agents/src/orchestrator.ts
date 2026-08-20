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
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";
import type { AgentRegistry } from "./registry.js";
import { ToolDescriptionBuilder, ToolPlanValidator, ToolPlanParser } from "./tool-planner.js";

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
  private readonly toolRegistry: { get(toolId: string): ITool | undefined; getAll(): ITool[] } | null;
  private readonly toolApprovalService: IToolApprovalService | null;
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
    this.toolRegistry = config.toolRegistry ?? null;
    this.toolApprovalService = config.toolApprovalService ?? null;
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
      const agent = this.selectAgent(request.agentId);
      await this.initializeAgent(agent, context);

      const agentContext = {
        userId: context.auth.userId,
        conversationId: context.conversationId,
        traceId: context.traceId,
        memoryManager: createNoopMemoryStore(),
        toolRegistry: this.toolRegistry ?? {
          get: () => undefined,
          getAll: () => [],
        },
        auditLogger: this.auditLogger,
      };

      await agent.initialize(agentContext);

      const userMessage = await this.injectMemoryContext(
        request.message,
        context.auth.userId,
      );

      let currentInput: AgentInput = {
        message: userMessage,
        conversationId: context.conversationId,
        metadata: request.metadata,
      };

      let totalToolExecutions = 0;
      let depth = 0;

      while (depth < this.maxOrchestrationDepth) {
        const output = await agent.process(currentInput);

        if (!output.actions || output.actions.length === 0) {
          await this.auditRequest(context, "success", startedAt);

          this.extractMemoryAsync(
            request.message,
            output.message,
            context.auth.userId,
            context.conversationId,
          ).catch(() => {});

          return this.buildSuccessResponse(
            output.message,
            traceId,
            context,
            output.metadata
          );
        }

        if (totalToolExecutions + output.actions.length > this.maxToolExecutions) {
          throw new JarvisError(
            "INTERNAL_ERROR",
            "Tool execution limit exceeded",
            { maxToolExecutions: this.maxToolExecutions, requested: output.actions.length }
          );
        }

        const toolResults = await this.executeTools(
          output.actions,
          context
        );
        totalToolExecutions += output.actions.length;

        currentInput = {
          message: output.message,
          conversationId: context.conversationId,
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
  ): Promise<  MemoryRecallResult[]> {
    if (!this.memoryStore) return [];

    try {
      const listResult = await this.memoryStore.list({
        userId,
        limit: 50,
        includeExpired: false,
      });

      if (listResult.memories.length === 0) return [];

      const results:   MemoryRecallResult[] = [];
      for (const memory of listResult.memories) {
        const embedding = (memory.metadata?.embedding as number[]) ?? null;
        if (!embedding || embedding.length === 0) continue;

        const queryEmbedding = await this.getQueryEmbedding(query);
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

  private selectAgent(agentId?: string): IAgent {
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
        memoryManager: createNoopMemoryStore(),
        toolRegistry: this.toolRegistry ?? {
          get: () => undefined,
          getAll: () => [],
        },
        auditLogger: this.auditLogger,
      });
    }
  }

  private async executeTools(
    actions: Array<{ toolId: string; params: Record<string, unknown> }>,
    context: SessionContext
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    const executionId = crypto.randomUUID();

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      const stepStartedAt = new Date();

      const request: ToolExecutionRequest = {
        toolId: action.toolId,
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
        const tool = this.toolRegistry.get(action.toolId);
        if (tool) {
          const check = await this.toolApprovalService.checkPreExecution(
            tool,
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
      results.push(result);
    }

    return results;
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
