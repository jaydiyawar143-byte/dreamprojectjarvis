import type { IAgent, AgentPolicy } from "@jarvis/core";
import { getAgentPolicy } from "./agent-policy.js";

export interface AgentRegistryOptions {
  /**
   * Refuse to register an agent that has no server-authoritative policy.
   *
   * The production container sets this, which is what makes "an agent always
   * has an allowlist" a property of the deployment rather than a convention.
   * It is off by default so the Sprint 1-5 test suites — which construct bare
   * agents to exercise the Orchestrator — keep working unchanged.
   */
  requirePolicy?: boolean;
}

export class AgentRegistry {
  private agents: Map<string, IAgent> = new Map();
  private policies: Map<string, AgentPolicy> = new Map();
  private readonly requirePolicy: boolean;

  constructor(options: AgentRegistryOptions = {}) {
    this.requirePolicy = options.requirePolicy ?? false;
  }

  /**
   * Registers an agent and binds its policy.
   *
   * The policy is stored HERE, beside the agent, rather than read off the
   * instance at check time: an agent object is ordinary code that could report
   * any `tools` array it liked, and the allowlist has to be the thing the
   * server decided.
   *
   * A policy is bound when the caller passes one, or when the registry is in
   * `requirePolicy` mode — where it is resolved from the compiled-in table by
   * agent id and registration fails if the table has no entry. Outside that
   * mode a bare `register(agent)` binds nothing and the agent runs unrestricted,
   * which is how the Sprint 1-5 suites exercise the Orchestrator with ad-hoc
   * tools. Production constructs the registry with `requirePolicy: true`, so
   * "every agent has an allowlist" holds by construction there rather than by
   * anyone remembering to pass one.
   */
  register(agent: IAgent, policy?: AgentPolicy): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent with id "${agent.id}" is already registered`);
    }

    const resolved =
      policy ?? (this.requirePolicy ? getAgentPolicy(agent.id) : undefined);

    if (!resolved && this.requirePolicy) {
      throw new Error(
        `Agent "${agent.id}" has no policy; registration refused under requirePolicy`
      );
    }

    if (resolved && resolved.agentId !== agent.id) {
      throw new Error(
        `Policy mismatch: policy is for "${resolved.agentId}" but agent id is "${agent.id}"`
      );
    }

    this.agents.set(agent.id, agent);
    if (resolved) {
      this.policies.set(agent.id, resolved);
    }
  }

  unregister(agentId: string): void {
    this.agents.delete(agentId);
    this.policies.delete(agentId);
  }

  get(agentId: string): IAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * The agent's tool allowlist and permission floor, or undefined when the
   * agent was registered without one (only possible outside `requirePolicy`).
   */
  getPolicy(agentId: string): AgentPolicy | undefined {
    return this.policies.get(agentId);
  }

  getAll(): IAgent[] {
    return Array.from(this.agents.values());
  }

  getByCategory(category: string): IAgent[] {
    return this.getAll().filter((agent) => agent.category === category);
  }

  /** Agents whose policy places them in `domain`. */
  getByDomain(domain: string): IAgent[] {
    return this.getAll().filter(
      (agent) => this.policies.get(agent.id)?.domain === domain
    );
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
