import type {
  IAgent,
  AgentContext,
  AgentInput,
  AgentOutput,
  AgentStatus,
  AgentConfig,
  AgentCategory,
} from "@jarvis/core";

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

  async shutdown(): Promise<void> {
    this.status = "disabled";
    this.context = undefined;
  }
}
