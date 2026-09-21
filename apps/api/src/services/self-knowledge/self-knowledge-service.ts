// ---------------------------------------------------------------------------
// SelfKnowledgeService — answers "what are you?" from the running process.
//
// CapabilityService already answers "what can you do?" by deriving it from the
// live tool registry, agent policy and integration state. What it cannot
// answer is anything about JARVIS ITSELF: which build is running, which
// environment, which model is actually behind the assistant. Those questions
// used to have no source at all, so the only honest answer was silence — and
// the failure mode of silence is a model that invents a version number.
//
// SAME RULE AS CAPABILITIES: derive, never claim. Every field here comes from
// an object the composition root actually constructed, or from build metadata
// passed in at construction. Nothing is written down as a fact about the
// system.
//
// THREE THINGS THIS DELIBERATELY CANNOT DO.
//
//   1. It cannot read a file. There is no fs import; the version and commit
//      arrive as values.
//   2. It cannot run a command. There is no child_process import, so "which
//      commit is this?" can never become `git rev-parse` in a request path.
//   3. It cannot read the environment. There is no `process.env` access in
//      this file. The composition root reads THREE NAMED variables and passes
//      their values in. That is what makes "this service cannot leak a secret"
//      a property of the code rather than a promise — it has nothing to leak
//      from, so no future edit can accidentally widen it into an env dump.
//
// It composes CapabilityService through a narrow port rather than extending or
// re-implementing it, for the same reason CapabilityService takes a
// ToolRegistryPort: one derivation of "what can you do", reused.
// ---------------------------------------------------------------------------

import type {
  CapabilityReport,
  CapabilitySummary,
  IntegrationCapabilityView,
} from "@jarvis/core";

/**
 * The subset of CapabilityService this needs. Narrow, so a test can fake it
 * and so this service can never reach a credential of its own.
 */
export interface CapabilityReadPort {
  report(userId: string): Promise<CapabilityReport>;
  connectedIntegrations(userId: string): Promise<IntegrationCapabilityView[]>;
}

/**
 * The identity of the model actually wired into this process.
 *
 * Only the three public identity fields of IAIProvider. An API key is not
 * reachable through this shape, which is why the port is declared here rather
 * than passing the provider itself.
 */
export interface ModelIdentityPort {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  isAvailable(): Promise<boolean>;
}

/**
 * Build metadata, supplied by the composition root.
 *
 * `version` and `gitCommit` are whatever the build stamped. A deployment that
 * stamps nothing gets `null` for the commit and reports it as unknown — which
 * is the honest answer, and far better than a number that looks authoritative
 * and is wrong.
 */
export interface BuildMetadata {
  name: string;
  version: string;
  /** Null when the build did not stamp one. Never derived by running git. */
  gitCommit: string | null;
  environment: string;
}

export interface SelfKnowledgeDeps {
  build: BuildMetadata;
  capabilities: CapabilityReadPort | null;
  model: ModelIdentityPort;
}

// ---------------------------------------------------------------------------

export interface SelfModelView {
  provider: string;
  providerName: string;
  model: string;
  /**
   * Whether the provider can actually answer right now. A configured provider
   * that is rate-limited or has no key reports false, so "which model are you
   * using" cannot be answered with one that is not working.
   */
  available: boolean;
}

export interface SelfIntegrationView {
  id: string;
  name: string;
  /** Masked upstream by CapabilityService. Never a full account id or email. */
  account: string | null;
  health: string;
}

export interface SelfKnowledge {
  identity: BuildMetadata;
  model: SelfModelView;
  /**
   * Null when integration state is unavailable (no encryption key), which is
   * the same condition that disables CapabilityService. Reported as unknown
   * rather than as zero, because "I have no capabilities" and "I cannot see my
   * capabilities" are different answers.
   */
  capabilities: CapabilitySummary | null;
  connectedIntegrations: SelfIntegrationView[] | null;
}

// ---------------------------------------------------------------------------

export class SelfKnowledgeService {
  constructor(private readonly deps: SelfKnowledgeDeps) {}

  /**
   * Everything JARVIS can truthfully say about itself for one user.
   *
   * Scoped to a user because half the answer is: integrations are connected
   * per user, and so is what the assistant can currently do for them.
   */
  async describe(userId: string): Promise<SelfKnowledge> {
    const model = await this.describeModel();

    if (!this.deps.capabilities) {
      return {
        identity: { ...this.deps.build },
        model,
        capabilities: null,
        connectedIntegrations: null,
      };
    }

    const [report, connected] = await Promise.all([
      this.deps.capabilities.report(userId),
      this.deps.capabilities.connectedIntegrations(userId),
    ]);

    return {
      identity: { ...this.deps.build },
      model,
      capabilities: report.summary,
      connectedIntegrations: connected.map((i) => ({
        id: i.integration,
        name: i.name,
        account: i.account,
        health: i.health,
      })),
    };
  }

  private async describeModel(): Promise<SelfModelView> {
    let available = false;
    try {
      available = await this.deps.model.isAvailable();
    } catch {
      // An availability probe that throws means "not usable right now". It is
      // never a reason to fail the whole self-description, and the provider's
      // error text is an internal detail that must not reach the answer.
      available = false;
    }

    return {
      provider: this.deps.model.id,
      providerName: this.deps.model.name,
      model: this.deps.model.defaultModel,
      available,
    };
  }
}
