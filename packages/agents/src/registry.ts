import type { IAgent } from "@jarvis/core";

export class AgentRegistry {
  private agents: Map<string, IAgent> = new Map();

  register(agent: IAgent): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent with id "${agent.id}" is already registered`);
    }
    this.agents.set(agent.id, agent);
  }

  unregister(agentId: string): void {
    this.agents.delete(agentId);
  }

  get(agentId: string): IAgent | undefined {
    return this.agents.get(agentId);
  }

  getAll(): IAgent[] {
    return Array.from(this.agents.values());
  }

  getByCategory(category: string): IAgent[] {
    return this.getAll().filter((agent) => agent.category === category);
  }

  async initializeAll(
    context: Parameters<IAgent["initialize"]>[0]
  ): Promise<void> {
    for (const agent of this.agents.values()) {
      await agent.initialize(context);
    }
  }

  async shutdownAll(): Promise<void> {
    for (const agent of this.agents.values()) {
      await agent.shutdown();
    }
  }
}

export const agentRegistry = new AgentRegistry();
