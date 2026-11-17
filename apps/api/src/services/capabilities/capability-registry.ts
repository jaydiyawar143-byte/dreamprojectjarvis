// ---------------------------------------------------------------------------
// CapabilityRegistry — UEE-2: the read-only catalogue of what the engine may
// consider doing, derived from sources that already decide it.
//
// WHAT IT IS. A gatherer. It reads three things that already exist and are
// already authoritative —
//
//   the tool registry                 which tools are registered in THIS process
//   the registered agents' policies   which of them an agent is allowed to hold
//   the caller's n8n allow-list       which workflows THIS user registered
//
// — snapshots their metadata, and hands it to the UEE-1 derivation
// (`deriveCapabilities` in @jarvis/core). The rules live there, once, pure and
// tested. This file adds none of its own; it decides only WHAT TO PUT IN.
//
// WHAT IT IS NOT.
//   - Not `CapabilityService`. That answers "what can you do for this person
//     right now" from live integration state (connected, scopes granted). This
//     answers a structural question — "does it exist, may an agent hold it" —
//     and deliberately reads NO integration: provider health is observed by the
//     one component allowed to observe it, never inferred here.
//   - Not an authority. Nothing consults a catalogue to permit anything. The
//     executor, the permission checker, the approval store and the access gate
//     decide as they always did, and a capability listed here is not an
//     approval, a permission or a grant.
//   - Not an executor or a router. It has one method, and it only reads.
//
// WHAT IT NEVER DOES.
//   - Hand a tool object to anything. The derivation gets a snapshot of each
//     tool's metadata, so `execute` and `validate` are not even within reach.
//   - Widen an allowlist, add an agent, or count a policy of an agent this
//     process did not register: an agent that is not running grants nothing.
//   - Offer another user's workflow, an inactive one, or a webhook path.
//   - Make the sandbox available. It is stated unavailable, always, as a fixed
//     fact of this release; a tool that is the sandbox by its id is listed
//     unavailable beside it.
// ---------------------------------------------------------------------------

import {
  deriveCapabilities,
  type AgentPolicy,
  type CapabilityDescriptor,
  type CapabilityOrigin,
  type CapabilityRejectionReason,
  type CapabilityScope,
  type CapabilityToolInput,
  type CapabilityUnavailableReason,
  type ExecutionKind,
  type ITool,
  type RejectedCapability,
} from "@jarvis/core";

import type { ToolRegistryPort } from "./capability-service.js";

/** The tool that triggers a user's registered workflow. A workflow is only offered where this is registered. */
const WORKFLOW_RUNNER_TOOL_ID = "n8n.trigger";

/**
 * One user's registered workflows. `IN8nRepository.listWorkflowsForUser` is
 * this: the rows of that one user, by construction.
 */
export interface UserWorkflowSource {
  listWorkflowsForUser(userId: string): Promise<ReadonlyArray<{ id: string; userId: string; name: string; isActive: boolean }>>;
}

export interface CapabilityRegistryDeps {
  /** Read for metadata only. */
  tools: ToolRegistryPort;
  /**
   * The policies of the agents registered in this process, read at CALL time:
   * some agents register conditionally and later. See `policiesOfRegisteredAgents`.
   */
  agentPolicies: () => readonly AgentPolicy[];
  /** Absent: no workflow is offered. */
  workflows?: UserWorkflowSource;
}

/** An unavailable capability, as far as a reader needs to know why. */
export interface UnavailableCapabilitySummary {
  readonly id: string;
  readonly kind: ExecutionKind;
  readonly origin: CapabilityOrigin;
  readonly reason: CapabilityUnavailableReason;
  readonly scope: CapabilityScope;
}

/** Something that could not be read in full. The catalogue is then partial, and says so. */
export type CapabilityCatalogueDegradation = "n8n_workflows_unreadable";

/**
 * What can be considered, for one user, at one moment. A snapshot: frozen, and
 * not changed by anything that happens afterwards.
 */
export interface CapabilityCatalogue {
  /**
   * Whom this catalogue was built for (UEE-3). The workflows in it are that
   * user's, and only that user's: a consumer that routes for someone else must
   * refuse it, so one account's catalogue can never stand in for another's.
   * Empty when the caller was not a real user id.
   */
  readonly forUser: string;
  /** Registered, valid, enabled and held by a registered agent. Sorted by id. */
  readonly available: readonly CapabilityDescriptor[];
  /** Registered, and not usable: disabled, not granted, or the sandbox. Sorted by id. */
  readonly unavailable: readonly UnavailableCapabilitySummary[];
  /** Offered and refused: an unregistered id in an allowlist, bad metadata, a foreign workflow. */
  readonly rejected: readonly RejectedCapability[];
  /**
   * The sandbox, always. A fixed fact of this release, stated whether or not a
   * sandbox-shaped tool exists, so nothing has to infer it from an absence.
   */
  readonly sandbox: { readonly status: "unavailable"; readonly reason: "sandbox_not_exposed" };
  readonly degraded: readonly CapabilityCatalogueDegradation[];
}

/** What a planner (or any reader) needs from the registry. */
export interface CapabilityCataloguePort {
  catalogue(userId: string): Promise<CapabilityCatalogue>;
}

/**
 * The policies of the agents that are actually registered. An agent with a
 * compiled-in policy but no registration (the automation agent, with n8n
 * unconfigured) holds nothing; an agent registered with no policy at all is
 * skipped rather than read as unrestricted.
 */
export function policiesOfRegisteredAgents(agents: {
  getAll(): ReadonlyArray<{ id: string }>;
  getPolicy(agentId: string): AgentPolicy | undefined;
}): readonly AgentPolicy[] {
  const policies: AgentPolicy[] = [];
  for (const agent of agents.getAll()) {
    const policy = agents.getPolicy(agent.id);
    if (policy) policies.push(policy);
  }
  return policies;
}

/** A tool's metadata, copied. Never the object. */
function metadataOf(tool: ITool): CapabilityToolInput {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: tool.category,
    risk: tool.risk,
    requiresApproval: tool.requiresApproval,
    requiredPermissions: [...tool.requiredPermissions],
    enabled: tool.enabled,
  };
}

const SANDBOX_STATE = Object.freeze({ status: "unavailable" as const, reason: "sandbox_not_exposed" as const });

export class CapabilityRegistry implements CapabilityCataloguePort {
  constructor(private readonly deps: CapabilityRegistryDeps) {}

  /**
   * The catalogue for one user. Reads; changes nothing and runs nothing.
   *
   * `userId` is the authenticated caller. It selects whose workflows are read
   * and is checked again by the derivation, which refuses a record that is not
   * theirs. A caller that is not a real user id gets no workflows, and still
   * gets the native capabilities, which are the deployment's rather than theirs.
   */
  async catalogue(userId: string): Promise<CapabilityCatalogue> {
    const tools = this.deps.tools.getAll().map(metadataOf);
    const agents = this.deps.agentPolicies().map((policy) => ({
      agentId: policy.agentId,
      allowedTools: [...policy.allowedTools],
      writesRequireApproval: policy.writesRequireApproval,
    }));

    const degraded: CapabilityCatalogueDegradation[] = [];
    let n8nWorkflows: { userId: string; records: Array<{ id: string; userId: string; name: string; isActive: boolean }> } | undefined;

    // Asked only where there is something to run them with, and only about the caller.
    if (this.deps.workflows && typeof userId === "string" && userId.trim().length > 0 && tools.some((tool) => tool.id === WORKFLOW_RUNNER_TOOL_ID)) {
      try {
        const rows = await this.deps.workflows.listWorkflowsForUser(userId);
        n8nWorkflows = {
          userId,
          // Active rows only, and only the four fields a capability is made of: the webhook path stays where it is.
          records: rows
            .filter((row) => row !== null && typeof row === "object" && row.isActive === true)
            .map((row) => ({ id: row.id, userId: row.userId, name: row.name, isActive: true })),
        };
      } catch {
        // The words of a database failure are not for a catalogue. No workflows, and the catalogue says so.
        degraded.push("n8n_workflows_unreadable");
      }
    }

    const derived = deriveCapabilities({ tools, agents, ...(n8nWorkflows ? { n8nWorkflows } : {}) });

    const available = derived.capabilities.filter((capability) => capability.availability.status === "available");
    const unavailable: UnavailableCapabilitySummary[] = [];
    for (const capability of derived.capabilities) {
      if (capability.availability.status === "unavailable") {
        unavailable.push(
          Object.freeze({
            id: capability.id,
            kind: capability.kind,
            origin: capability.origin,
            reason: capability.availability.reason,
            scope: capability.scope,
          })
        );
      }
    }

    return Object.freeze({
      forUser: typeof userId === "string" ? userId : "",
      available: Object.freeze(available),
      unavailable: Object.freeze(unavailable),
      rejected: derived.rejected as readonly RejectedCapability[],
      sandbox: SANDBOX_STATE,
      degraded: Object.freeze(degraded),
    });
  }
}

export type { CapabilityRejectionReason };
