import type {
  IAgent,
  AgentContext,
  AgentInput,
  AgentOutput,
  AgentStatus,
  AgentConfig,
  AgentCategory,
} from "@jarvis/core";

/** What a failed turn says about the agent that ran it. */
type TurnFailure = "not_configured" | "transient" | "request" | "permanent" | "unexpected";

/**
 * Provider failures that will fail the same way on the next request until
 * someone changes the configuration.
 */
const PERMANENT_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "AI_PROVIDER_AUTH_FAILED", // the provider rejected the server's key (R-29)
  "AUTHENTICATION_REQUIRED", // an authentication failure reported the older way
  "AUTHORIZATION_FAILED", // the key has no access to the model or project
  "INVALID_REQUEST", // an unknown model, or a request the provider rejects
]);

/**
 * Classifies a failed turn from the error's `code` and its `details.transient`
 * and `details.aborted`, which the provider adapters set in `toJarvisError`.
 *
 * The fields are read rather than testing `instanceof JarvisError`, so a second
 * copy of @jarvis/core in the module graph cannot change the answer.
 */
function classifyTurnFailure(error: unknown): TurnFailure {
  const { code, details } = (error ?? {}) as {
    code?: unknown;
    details?: { transient?: unknown; aborted?: unknown };
  };

  if (code === "AI_PROVIDER_NOT_CONFIGURED") return "not_configured";
  if (code === "RATE_LIMITED" || code === "AI_PROVIDER_UNAVAILABLE" || details?.transient === true) {
    return "transient";
  }
  if (code === "CONTEXT_LENGTH_EXCEEDED" || details?.aborted === true) return "request";
  if (typeof code === "string" && PERMANENT_PROVIDER_CODES.has(code)) return "permanent";
  return "unexpected";
}

export abstract class BaseAgent implements IAgent {
  id: string;
  name: string;
  description: string;
  category: AgentCategory;
  tools: string[];
  config: AgentConfig;

  protected context?: AgentContext;
  protected status: AgentStatus = "idle";

  constructor(
    id: string,
    name: string,
    description: string,
    category: AgentCategory,
    tools: string[] = [],
    config: Partial<AgentConfig> = {}
  ) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.category = category;
    this.tools = tools;
    this.config = {
      model: config.model || "gpt-4",
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 4096,
      systemPrompt: config.systemPrompt,
      customSettings: config.customSettings,
    };
  }

  async initialize(context: AgentContext): Promise<void> {
    this.context = context;
    this.status = "ready";
  }

  abstract process(input: AgentInput): Promise<AgentOutput>;

  getStatus(): AgentStatus {
    return this.status;
  }

  /**
   * The status to take after a turn fails.
   *
   * The orchestrator never selects an agent in "error", and nothing resets it,
   * so this decides whether one failure takes the agent out of service for the
   * life of the process.
   *
   * - Not configured (R-21): a state of the deployment, not a fault in the
   *   agent. Every request gets the same actionable 503.
   * - Transient (R-24, R-27): a timeout, rate limit, 5xx or open provider
   *   circuit says nothing about the next request. Marking it "error" turned
   *   one blip into "No available agents" until restart.
   * - Request (R-25, R-26): an exceeded context window belongs to one
   *   conversation, and a cancelled call to one caller.
   * - Permanent and unexpected: "error", as before.
   */
  protected statusAfterFailure(error: unknown): AgentStatus {
    switch (classifyTurnFailure(error)) {
      case "not_configured":
      case "transient":
      case "request":
        return "ready";
      case "permanent":
      case "unexpected":
        return "error";
    }
  }

  async shutdown(): Promise<void> {
    this.status = "disabled";
    this.context = undefined;
  }
}
