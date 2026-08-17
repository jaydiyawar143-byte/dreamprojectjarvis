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
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";
import type { AgentRegistry } from "./registry.js";

const DEFAULT_MAX_TOOL_EXECUTIONS = 10;
const DEFAULT_MAX_ORCHESTRATION_DEPTH = 5;

export class Orchestrator implements IOrchestrator {
  private readonly maxToolExecutions: number;
  private readonly maxOrchestrationDepth: number;

  constructor(
    private agentRegistry: AgentRegistry,
    private toolExecutor: IToolExecutor,
    private auditLogger: AuditLogger,
    config: OrchestratorConfig = {}
  ) {
    this.maxToolExecutions = config.maxToolExecutions ?? DEFAULT_MAX_TOOL_EXECUTIONS;
    this.maxOrchestrationDepth = config.maxOrchestrationDepth ?? DEFAULT_MAX_ORCHESTRATION_DEPTH;
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
        memoryManager: {
          store: async () => {},
          recall: async () => [],
        },
        toolRegistry: {
          get: () => undefined,
          getAll: () => [],
        },
        auditLogger: this.auditLogger,
      };

      await agent.initialize(agentContext);

      let currentInput: AgentInput = {
        message: request.message,
        conversationId: context.conversationId,
        metadata: request.metadata,
      };

      let totalToolExecutions = 0;
      let depth = 0;

      while (depth < this.maxOrchestrationDepth) {
        const output = await agent.process(currentInput);

        if (!output.actions || output.actions.length === 0) {
          await this.auditRequest(context, "success", startedAt);
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
        memoryManager: {
          store: async () => {},
          recall: async () => [],
        },
        toolRegistry: {
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

    for (const action of actions) {
      const request: ToolExecutionRequest = {
        toolId: action.toolId,
        params: action.params,
        userId: context.auth.userId,
        role: context.auth.role,
        agentId: context.agentId,
        conversationId: context.conversationId,
        traceId: context.traceId,
        ipAddress: context.ipAddress,
      };

      const result = await this.toolExecutor.execute(request);
      results.push(result);
    }

    return results;
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
