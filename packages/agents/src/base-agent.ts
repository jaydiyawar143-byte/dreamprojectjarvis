import type {
  IAgent,
  AgentContext,
  AgentInput,
  AgentOutput,
  AgentStatus,
  AgentConfig,
  AgentCategory,
} from "@jarvis/core";
import { classifyProviderFailure } from "@jarvis/core";

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
   * Every classified provider failure leaves the agent "ready": a missing key
   * (R-21), a transient failure or open circuit (R-24, R-27), an exceeded
   * context window or a cancelled call (R-25, R-26), and — since R-30 — a
   * rejected key, missing access or an unknown model too. The provider's health
   * is tracked by the provider chain and the adapter's circuit breaker, not by
   * the agent; taking the agent out of service for it is how a plain request
   * ended up with the Meta Ads agent.
   *
   * Only an unexpected failure marks the agent "error", as before.
   */
  protected statusAfterFailure(error: unknown): AgentStatus {
    return classifyProviderFailure(error) === "unexpected" ? "error" : "ready";
  }

  async shutdown(): Promise<void> {
    this.status = "disabled";
    this.context = undefined;
  }
}
