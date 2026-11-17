// ---------------------------------------------------------------------------
// UEE-1 — execution capability descriptors, and the unified execution outcome.
//
// WHAT THIS IS. Vocabulary and two pure functions for the Unified Execution
// Engine to come. A capability descriptor says what something that JARVIS can
// do IS, from facts that already exist and can be checked: the tool a registry
// holds, the allowlists agents are given, the shared-connection table, the voice
// policy, the caller's own registered n8n workflows. `deriveCapabilities` reads
// those and returns descriptors. It does not choose one, run one or route to one.
//
// WHAT THIS IS NOT. It is not an executor and not a router: `ToolExecutor` stays
// the only place anything runs (UEE-0 pins that). It holds no registry, no
// repository, no model and no clock; nothing in it is asynchronous. It is not the
// capability REPORT either (`types/capability.ts`), which answers "can this run
// for this person right now" from live integration state. This answers a
// narrower, structural question — "does this exist, and may an agent hold it" —
// because status must be observed, never assumed, and a pure function cannot
// observe a connection.
//
// NAMES THAT ARE NOT THE OBVIOUS ONES, and why:
//   - `UnifiedExecutionOutcome`, not `ExecutionOutcome`: that name is core's S5
//     projection of a whole turn from audit rows (`execution-outcome.ts`), a
//     different thing, and exporting a second one from this barrel is an error.
//   - `DerivedCapabilityAvailability`, not `CapabilityAvailability`: that name is
//     the integration-state axis of the capability report.
//
// THREE KINDS, NOT INTERCHANGEABLE. Native tools, n8n workflows and the sandbox
// differ in who owns them, what they can do and how they fail; a descriptor says
// which it is and never lets one pass for another. An MCP tool is a native-kind
// capability (it runs as an `ITool`, through the executor) of its own ORIGIN, so
// it is never mistaken for a registry tool. A workflow is the caller's own
// allow-listed workflow, run by the one runner tool.
//
// FAIL SAFE, EVERYWHERE.
//   - Only what is registered AND valid becomes a descriptor. An id an allowlist
//     names that no tool registered is REJECTED, not believed.
//   - Only an allowlist grants. A tool's own `enabled: true` grants nothing.
//   - What cannot be known is `unknown`, never a guess: data egress and
//     idempotency are stated only by a verified fact the caller supplies, and a
//     fact with a value outside the contract is ignored.
//   - A shared connection's Organization scope comes only from the shared table.
//     Nothing here maps an Organization to anything: where no mapping exists the
//     scope is `unresolved`, and a descriptor can never carry one it was not given.
//   - Bad metadata, duplicate ids and malformed inputs are listed as rejected.
//     Nothing throws.
//
// THE SANDBOX IS NEVER AVAILABLE IN THIS RELEASE. A tool is recognised as the
// sandbox by its id, not by what it says about itself. However it is registered,
// enabled, allowlisted, named by an agent or "unlocked" by a fact, its
// availability is `sandbox_not_exposed`. Lifting that is a deliberate change to
// `deriveCapabilities` and its tests, made in the stage that gives the sandbox an
// Organization mapping and a value-free audit projection (UEE-5) — not a flag.
// ---------------------------------------------------------------------------

import { classifyToolFailure } from "./tool-failure-classifier.js";
import type { AgentPolicy } from "./types/agent.js";
import type { ToolExecutionResult } from "./types/execution.js";
import type { N8nWorkflowRecord } from "./types/n8n.js";
import { SHARED_CONNECTION_TOOLS, SHARED_INTEGRATION_CONNECTORS, type SharedIntegrationId } from "./types/tenant.js";
import {
  RiskLevelSchema,
  ToolCategorySchema,
  ToolPermissionSchema,
  type RiskLevel,
  type ToolCategory,
  type ToolPermission,
} from "./types/tool.js";
import { VOICE_REFUSED_TOOLS } from "./voice-tool-policy.js";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** How a capability is carried out. Three, and not interchangeable. */
export const EXECUTION_KINDS = ["native", "n8n_workflow", "sandbox"] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

export function isExecutionKind(value: unknown): value is ExecutionKind {
  return typeof value === "string" && (EXECUTION_KINDS as readonly string[]).includes(value);
}

/**
 * Where a capability comes from. Finer than the kind, so an MCP tool and a
 * registry tool, both native-kind, are never confused.
 */
export type CapabilityOrigin = "tool_registry" | "mcp" | "n8n_allowlist" | "sandbox";

/**
 * Whose authority it runs under.
 *
 *   user          the caller's own account (`ToolContext.userId`). Not a claim
 *                 that nothing is shared: a tool not in the shared table is
 *                 decided per account.
 *   organization  a deployment-wide connection an Organization owns, with what
 *                 the tool does through it. From `SHARED_CONNECTION_TOOLS` only.
 *   unresolved    no mapping exists. The sandbox, today.
 */
export type CapabilityScope =
  | { readonly kind: "user" }
  | { readonly kind: "organization"; readonly integration: SharedIntegrationId; readonly access: "read" | "write" }
  | { readonly kind: "unresolved" };

/** Where the data a capability handles may go. Never inferred: only stated. */
export const CAPABILITY_DATA_EGRESS = ["none", "provider", "public_web", "unknown"] as const;
export type CapabilityDataEgress = (typeof CAPABILITY_DATA_EGRESS)[number];

/** Whether doing it twice is safe. */
export const CAPABILITY_IDEMPOTENCY = ["read_only", "idempotent_keyed", "not_idempotent", "unknown"] as const;
export type CapabilityIdempotency = (typeof CAPABILITY_IDEMPOTENCY)[number];

/**
 * The deadline that applies. `executor_default` is the deadline `ToolExecutor`
 * gives a call unless the caller sets one — a statement about the executor, not
 * a promise about the tool. `long_running` cannot be carried by it.
 */
export const CAPABILITY_TIMEOUT_CLASSES = ["executor_default", "long_running", "unknown"] as const;
export type CapabilityTimeoutClass = (typeof CAPABILITY_TIMEOUT_CLASSES)[number];

/** Whether a spoken turn may start it (`VOICE_REFUSED_TOOLS`). */
export type CapabilitySpokenTurn = "may_start" | "refused";

/** Facts the CALLER has verified and supplies. Each is ignored unless it is a value of the contract. */
export interface CapabilityFacts {
  dataEgress?: CapabilityDataEgress;
  idempotency?: CapabilityIdempotency;
  timeoutClass?: CapabilityTimeoutClass;
}

/** Why a derived capability cannot be used. */
export type CapabilityUnavailableReason =
  /** Registered with `enabled: false`. */
  | "disabled"
  /** No agent's allowlist (or not the agent asked about) holds it. */
  | "not_granted"
  /** The sandbox. Always, in this release. */
  | "sandbox_not_exposed"
  /** The caller's workflow is switched off. */
  | "workflow_inactive"
  /** The runner tool is disabled, or no agent may run it. */
  | "workflow_runner_unavailable";

/**
 * Whether the engine may consider it. STRUCTURAL: registered, valid, granted,
 * not the sandbox. It says nothing about whether a provider is connected — that
 * is observed, and `CapabilityView` reports it.
 */
export type DerivedCapabilityAvailability =
  | { readonly status: "available" }
  | { readonly status: "unavailable"; readonly reason: CapabilityUnavailableReason };

/** One thing JARVIS can do, as far as can be known without running anything. */
export interface CapabilityDescriptor {
  /** The tool's registry id, or `n8n.workflow:<id>` for a caller's workflow. */
  readonly id: string;
  readonly kind: ExecutionKind;
  readonly origin: CapabilityOrigin;
  readonly name: string;
  readonly description: string;
  /** The registry tool `ToolExecutor` runs for it: its own id, or the workflow runner's. */
  readonly toolId: string;
  readonly requiredPermissions: readonly ToolPermission[];
  readonly risk: RiskLevel;
  /** The stricter of the tool's own word and a holding agent's `writesRequireApproval`. */
  readonly approval: "required" | "not_required";
  readonly scope: CapabilityScope;
  readonly dataEgress: CapabilityDataEgress;
  readonly idempotency: CapabilityIdempotency;
  readonly timeoutClass: CapabilityTimeoutClass;
  readonly spokenTurn: CapabilitySpokenTurn;
  /** Agent ids whose allowlist names `toolId`, sorted. Empty: nobody holds it. */
  readonly agents: readonly string[];
  readonly availability: DerivedCapabilityAvailability;
}

export type CapabilityRejectionReason =
  | "not_registered"
  | "invalid_metadata"
  | "duplicate_id"
  | "foreign_workflow"
  | "workflow_runner_unavailable";

/** Something offered that was not made a capability, and where it was offered from. */
export interface RejectedCapability {
  readonly id: string;
  readonly reason: CapabilityRejectionReason;
  readonly source: "tool_registry" | "agent_allowlist" | "n8n_allowlist";
}

export interface DerivedCapabilities {
  /** Sorted by id. */
  readonly capabilities: readonly CapabilityDescriptor[];
  /** Sorted by id, then reason, then source. */
  readonly rejected: readonly RejectedCapability[];
}

/**
 * The part of an `ITool` this reads. Never its methods: a tool's `execute` and
 * `validate` are never called, and an object that carries them is not changed.
 */
export interface CapabilityToolInput {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  risk: RiskLevel;
  requiresApproval: boolean;
  requiredPermissions: readonly ToolPermission[];
  enabled: boolean;
}

export interface DeriveCapabilitiesInput {
  /** What the registry holds. */
  tools: readonly CapabilityToolInput[];
  /** The agents' policies. Only `allowedTools` grants. */
  agents: ReadonlyArray<Pick<AgentPolicy, "agentId" | "allowedTools" | "writesRequireApproval">>;
  /** Judge availability for this agent alone. Omitted: any agent. */
  forAgent?: string;
  /**
   * The CALLER's own registered workflows (`listWorkflowsForUser`). `userId` is
   * who is asking: a record that is not theirs is rejected. The webhook path is
   * not read and not carried.
   */
  n8nWorkflows?: { userId: string; records: ReadonlyArray<Pick<N8nWorkflowRecord, "id" | "userId" | "name" | "isActive">> };
  /** Verified facts by capability id (or tool id). Defaults to nothing. */
  facts?: Readonly<Record<string, CapabilityFacts>>;
  /** Defaults to `SHARED_CONNECTION_TOOLS`. */
  sharedConnectionTools?: Readonly<Record<string, { integration: SharedIntegrationId; access: "read" | "write" }>>;
}

/** What `resolveCapability` answers when it will not hand a capability over. */
export type CapabilityResolution =
  | { readonly ok: true; readonly capability: CapabilityDescriptor }
  | { readonly ok: false; readonly reason: CapabilityUnavailableReason | CapabilityRejectionReason | "unknown_capability" };

// ---------------------------------------------------------------------------
// Fixed facts about the world this derives from
// ---------------------------------------------------------------------------

/** The one tool that triggers a caller's registered workflow (`N8nTriggerWorkflowTool`). */
const WORKFLOW_RUNNER_TOOL_ID = "n8n.trigger";

/** The id a workflow capability has: the tool namespace cannot produce it. */
const WORKFLOW_ID_PREFIX = "n8n.workflow:";

/** A tool id that is the sandbox, by the id alone. A pattern, not a name list: a renamed one is still caught. */
const SANDBOX_TOOL_ID = /^(?:n8n[.:_-])?sandbox[.:_-]/i;

const UNIDENTIFIED = "(unidentified)";

// ---------------------------------------------------------------------------
// Reading what is handed in
// ---------------------------------------------------------------------------

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/\s/.test(value);

interface ValidTool {
  id: string;
  name: string;
  description: string;
  risk: RiskLevel;
  requiresApproval: boolean;
  requiredPermissions: readonly ToolPermission[];
  enabled: boolean;
}

/** The tool's metadata, or null. Reads nine properties and calls nothing. */
function readTool(raw: unknown): ValidTool | null {
  if (!isRecord(raw)) return null;
  const { id, name, description, category, risk, requiresApproval, requiredPermissions, enabled } = raw;

  // The workflow namespace is reserved: a tool cannot take a workflow's id.
  if (!isId(id) || id.startsWith(WORKFLOW_ID_PREFIX)) return null;
  if (typeof name !== "string" || typeof description !== "string") return null;
  if (!ToolCategorySchema.safeParse(category).success) return null;
  const parsedRisk = RiskLevelSchema.safeParse(risk);
  if (!parsedRisk.success) return null;
  if (typeof requiresApproval !== "boolean" || typeof enabled !== "boolean") return null;
  if (!Array.isArray(requiredPermissions)) return null;

  const permissions: ToolPermission[] = [];
  for (const permission of requiredPermissions as unknown[]) {
    const parsed = ToolPermissionSchema.safeParse(permission);
    if (!parsed.success) return null;
    permissions.push(parsed.data);
  }
  return { id, name, description, risk: parsedRisk.data, requiresApproval, requiredPermissions: permissions, enabled };
}

interface ReadAgent {
  agentId: string;
  allowed: ReadonlySet<string>;
  /** Anything but an explicit `false` is strict. */
  writesRequireApproval: boolean;
}

function readAgents(raw: unknown): ReadAgent[] {
  if (!Array.isArray(raw)) return [];
  const agents: ReadAgent[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry) || !isId(entry.agentId)) continue;
    const allowed = new Set<string>();
    if (Array.isArray(entry.allowedTools)) {
      for (const toolId of entry.allowedTools as unknown[]) if (isId(toolId)) allowed.add(toolId);
    }
    agents.push({ agentId: entry.agentId, allowed, writesRequireApproval: entry.writesRequireApproval !== false });
  }
  return agents;
}

function pick<T extends string>(values: readonly T[], candidate: unknown): T | undefined {
  return typeof candidate === "string" && (values as readonly string[]).includes(candidate) ? (candidate as T) : undefined;
}

/** A verified fact for the first id that states one, or undefined. */
function factFor<K extends keyof CapabilityFacts>(facts: unknown, ids: readonly string[], key: K, values: readonly NonNullable<CapabilityFacts[K]>[]): NonNullable<CapabilityFacts[K]> | undefined {
  if (!isRecord(facts)) return undefined;
  for (const id of ids) {
    const entry = hasOwn(facts, id) ? facts[id] : undefined;
    if (isRecord(entry)) {
      const value = pick(values, entry[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function classify(id: string): { kind: ExecutionKind; origin: CapabilityOrigin } {
  if (SANDBOX_TOOL_ID.test(id)) return { kind: "sandbox", origin: "sandbox" };
  if (id.startsWith("mcp.")) return { kind: "native", origin: "mcp" };
  return { kind: "native", origin: "tool_registry" };
}

function scopeOf(id: string, kind: ExecutionKind, table: unknown): CapabilityScope {
  // No Organization is mapped to the sandbox, so none is claimed for it, whatever a table says.
  if (kind === "sandbox") return Object.freeze({ kind: "unresolved" as const });
  const entry = isRecord(table) && hasOwn(table, id) ? table[id] : undefined;
  if (isRecord(entry) && typeof entry.integration === "string" && hasOwn(SHARED_INTEGRATION_CONNECTORS, entry.integration) && (entry.access === "read" || entry.access === "write")) {
    return Object.freeze({ kind: "organization" as const, integration: entry.integration as SharedIntegrationId, access: entry.access });
  }
  return Object.freeze({ kind: "user" as const });
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

const freezeList = <T>(items: readonly T[]): readonly T[] => Object.freeze([...items]);

/**
 * Derive the capabilities of a deployment, for a caller, from what is handed in.
 *
 * Pure and total: any input produces a result, nothing is thrown, nothing is
 * called, and the same input in any order gives the same output. The result and
 * everything in it is frozen.
 */
export function deriveCapabilities(input: DeriveCapabilitiesInput): DerivedCapabilities {
  const source: Record<string, unknown> = isRecord(input) ? input : {};
  const rejected = new Map<string, RejectedCapability>();
  const reject = (id: string, reason: CapabilityRejectionReason, from: RejectedCapability["source"]): void => {
    rejected.set(`${id}\u0000${reason}\u0000${from}`, { id, reason, source: from });
  };

  const agents = readAgents(source.agents);
  const agentFilter = source.forAgent;
  const filtering = agentFilter !== undefined;

  /** Agents that hold `toolId`, and whether the one asked about may use it. */
  const holders = (toolId: string): { ids: string[]; policies: ReadAgent[]; eligible: boolean } => {
    const policies = agents.filter((agent) => agent.allowed.has(toolId));
    const ids = [...new Set(policies.map((agent) => agent.agentId))].sort();
    const eligible = filtering ? typeof agentFilter === "string" && ids.includes(agentFilter) : ids.length > 0;
    return { ids, policies, eligible };
  };

  // ---- the registry: validate, and refuse an id that is not one thing -------
  const rawTools: unknown[] = Array.isArray(source.tools) ? (source.tools as unknown[]) : [];
  const idCounts = new Map<string, number>();
  for (const raw of rawTools) {
    const id = isRecord(raw) && isId(raw.id) ? raw.id : null;
    if (id !== null) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  const tools = new Map<string, ValidTool>();
  const seen = new Set<string>();
  for (const raw of rawTools) {
    const id = isRecord(raw) && isId(raw.id) ? raw.id : null;
    if (id !== null) seen.add(id);
    if (id !== null && (idCounts.get(id) ?? 0) > 1) {
      reject(id, "duplicate_id", "tool_registry");
      continue;
    }
    const tool = readTool(raw);
    if (!tool) {
      reject(id ?? UNIDENTIFIED, "invalid_metadata", "tool_registry");
      continue;
    }
    tools.set(tool.id, tool);
  }

  // ---- an allowlist is believed only for a tool something registered --------
  for (const agent of agents) {
    for (const toolId of agent.allowed) if (!seen.has(toolId)) reject(toolId, "not_registered", "agent_allowlist");
  }

  const approvalFor = (tool: ValidTool, policies: readonly ReadAgent[]): "required" | "not_required" =>
    tool.requiresApproval || (tool.risk !== "READ_ONLY" && policies.some((policy) => policy.writesRequireApproval)) ? "required" : "not_required";

  const spokenFor = (toolId: string): CapabilitySpokenTurn => (hasOwn(VOICE_REFUSED_TOOLS, toolId) ? "refused" : "may_start");

  const descriptors: CapabilityDescriptor[] = [];
  const sharedTable = source.sharedConnectionTools === undefined ? SHARED_CONNECTION_TOOLS : source.sharedConnectionTools;
  const facts = source.facts;

  // ---- native, MCP and sandbox-kind capabilities: one per registered tool ----
  for (const tool of [...tools.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    // The runner is represented by the workflows it runs, not listed beside them.
    if (tool.id === WORKFLOW_RUNNER_TOOL_ID) continue;

    const { kind, origin } = classify(tool.id);
    const held = holders(tool.id);

    const availability: DerivedCapabilityAvailability =
      kind === "sandbox"
        ? { status: "unavailable", reason: "sandbox_not_exposed" }
        : !tool.enabled
          ? { status: "unavailable", reason: "disabled" }
          : !held.eligible
            ? { status: "unavailable", reason: "not_granted" }
            : { status: "available" };

    // Facts describe a tool someone verified. The sandbox's egress is chosen when
    // a sandbox is created, so no fact is taken for it.
    const stated = kind === "sandbox" ? undefined : facts;
    descriptors.push(
      Object.freeze({
        id: tool.id,
        kind,
        origin,
        name: tool.name,
        description: tool.description,
        toolId: tool.id,
        requiredPermissions: freezeList(tool.requiredPermissions),
        risk: tool.risk,
        approval: approvalFor(tool, held.policies),
        scope: scopeOf(tool.id, kind, sharedTable),
        dataEgress: factFor(stated, [tool.id], "dataEgress", CAPABILITY_DATA_EGRESS) ?? "unknown",
        idempotency:
          kind === "sandbox"
            ? "unknown"
            : tool.risk === "READ_ONLY"
              ? "read_only"
              : (factFor(stated, [tool.id], "idempotency", CAPABILITY_IDEMPOTENCY) ?? "unknown"),
        timeoutClass: kind === "sandbox" ? "long_running" : (factFor(stated, [tool.id], "timeoutClass", CAPABILITY_TIMEOUT_CLASSES) ?? "executor_default"),
        spokenTurn: spokenFor(tool.id),
        agents: freezeList(held.ids),
        availability: Object.freeze(availability),
      })
    );
  }

  // ---- the caller's registered workflows, run by the one runner tool ---------
  const registered = source.n8nWorkflows;
  if (isRecord(registered) && isId(registered.userId) && Array.isArray(registered.records)) {
    const records = registered.records as unknown[];
    const workflowCounts = new Map<string, number>();
    for (const record of records) {
      if (isRecord(record) && isId(record.id)) workflowCounts.set(record.id, (workflowCounts.get(record.id) ?? 0) + 1);
    }

    const runner = tools.get(WORKFLOW_RUNNER_TOOL_ID);
    const runnerHeld = holders(WORKFLOW_RUNNER_TOOL_ID);

    for (const record of records) {
      const workflowId = isRecord(record) && isId(record.id) ? record.id : null;
      const capabilityId = `${WORKFLOW_ID_PREFIX}${workflowId ?? UNIDENTIFIED}`;

      if (!isRecord(record) || workflowId === null || typeof record.name !== "string" || typeof record.isActive !== "boolean" || !isId(record.userId)) {
        reject(capabilityId, "invalid_metadata", "n8n_allowlist");
        continue;
      }
      if ((workflowCounts.get(workflowId) ?? 0) > 1) {
        reject(capabilityId, "duplicate_id", "n8n_allowlist");
        continue;
      }
      // Another account's workflow is not this caller's to be offered.
      if (record.userId !== registered.userId) {
        reject(capabilityId, "foreign_workflow", "n8n_allowlist");
        continue;
      }
      // Nothing to inherit a risk, a permission or an approval rule from: refuse, do not guess them.
      if (!runner) {
        reject(capabilityId, "workflow_runner_unavailable", "n8n_allowlist");
        continue;
      }

      const runnerUsable = runner.enabled && runnerHeld.eligible;
      const availability: DerivedCapabilityAvailability = !runnerUsable
        ? { status: "unavailable", reason: "workflow_runner_unavailable" }
        : !record.isActive
          ? { status: "unavailable", reason: "workflow_inactive" }
          : { status: "available" };

      descriptors.push(
        Object.freeze({
          id: capabilityId,
          kind: "n8n_workflow" as const,
          origin: "n8n_allowlist" as const,
          name: record.name,
          description: "A workflow this account registered in n8n, triggered through the approval-gated runner.",
          toolId: WORKFLOW_RUNNER_TOOL_ID,
          requiredPermissions: freezeList(runner.requiredPermissions),
          risk: runner.risk,
          approval: approvalFor(runner, runnerHeld.policies),
          // Decided per account: the runner reads the caller's own allow-list.
          scope: Object.freeze({ kind: "user" as const }),
          // A workflow's payload goes to the n8n instance, by what it is.
          dataEgress: factFor(facts, [capabilityId, WORKFLOW_RUNNER_TOOL_ID], "dataEgress", CAPABILITY_DATA_EGRESS) ?? "provider",
          // The runner claims an execution slot under a key derived from the user, workflow and payload.
          idempotency: factFor(facts, [capabilityId, WORKFLOW_RUNNER_TOOL_ID], "idempotency", CAPABILITY_IDEMPOTENCY) ?? "idempotent_keyed",
          timeoutClass: factFor(facts, [capabilityId, WORKFLOW_RUNNER_TOOL_ID], "timeoutClass", CAPABILITY_TIMEOUT_CLASSES) ?? "executor_default",
          spokenTurn: spokenFor(WORKFLOW_RUNNER_TOOL_ID),
          agents: freezeList(runnerHeld.ids),
          availability: Object.freeze(availability),
        })
      );
    }
  }

  const capabilities = descriptors.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const refusals = [...rejected.values()].sort((a, b) =>
    a.id !== b.id ? (a.id < b.id ? -1 : 1) : a.reason !== b.reason ? (a.reason < b.reason ? -1 : 1) : a.source < b.source ? -1 : a.source > b.source ? 1 : 0
  );
  return Object.freeze({
    capabilities: Object.freeze(capabilities.map((capability) => capability)),
    rejected: Object.freeze(refusals.map((refusal) => Object.freeze(refusal))),
  });
}

/**
 * The capability for `id` if it exists AND may be used; otherwise why not.
 *
 * The only way a caller should turn an id into a capability: an unknown,
 * rejected, ungranted or sandbox id is refused here, in one place.
 */
export function resolveCapability(derived: DerivedCapabilities, id: string): CapabilityResolution {
  const unknown: CapabilityResolution = { ok: false, reason: "unknown_capability" };
  if (typeof id !== "string" || id.length === 0 || !isRecord(derived)) return unknown;

  // Searched, never indexed by name: an id such as "constructor" finds nothing.
  const found = Array.isArray(derived.capabilities) ? derived.capabilities.find((capability) => capability.id === id) : undefined;
  if (found) {
    return found.availability.status === "available" ? { ok: true, capability: found } : { ok: false, reason: found.availability.reason };
  }

  const refused = Array.isArray(derived.rejected) ? derived.rejected.find((entry) => entry.id === id && entry.reason !== "not_registered") : undefined;
  return refused ? { ok: false, reason: refused.reason } : unknown;
}

// ---------------------------------------------------------------------------
// The unified outcome
// ---------------------------------------------------------------------------

/**
 * Whether the thing the capability does may have happened.
 *
 *   none        it did not, or it is a read
 *   possible    it may have — and nothing here can say it did not
 *   confirmed   a write that reported success
 */
export type UnifiedOutcomeSideEffect = "none" | "possible" | "confirmed";

export type UnifiedPendingReason =
  | "approval_required"
  | "approval_pending"
  | "clarification_required"
  | "in_progress"
  /**
   * An external system ACCEPTED the request, and nothing has confirmed the result
   * (UEE-4): an n8n trigger whose callback has not arrived. Not a failure, not
   * a success, and not uncertain — it is waiting for the answer that settles it.
   */
  | "awaiting_confirmation";
export type UnifiedUncertainReason = "outcome_unknown" | "timed_out_after_start";

export interface UnifiedOutcomeFailure {
  /**
   * What kind of failure, so a router can tell a refusal from a broken tool.
   *   refused      permission or approval said no; nothing ran
   *   not_run      it never reached the tool (unavailable, not asked for, bad input)
   *   tool_failed  the tool ran and reported failure
   *   timed_out    a READ that ran out of time (a write that does is `uncertain`)
   */
  kind: "refused" | "not_run" | "tool_failed" | "timed_out";
  /** A stable code and a fixed sentence (`classifyToolFailure`), never a provider's words. */
  code: string;
  message: string;
}

/** Ids and a duration. Never what a tool returned, said or failed with. */
export interface UnifiedOutcomeEvidence {
  toolId: string;
  executionId?: string;
  approvalId?: string;
  durationMs?: number;
}

interface UnifiedOutcomeBase {
  capabilityId: string;
  kind: ExecutionKind;
  evidence: UnifiedOutcomeEvidence;
  /**
   * The output is DATA, never instructions. True where the tool said so, and
   * always for a workflow's or the sandbox's output: it comes from outside.
   */
  untrusted: boolean;
}

/**
 * What happened, in four states that cannot be told as one another.
 *
 * `uncertain` is its own state, not a flavour of failure and not a quiet
 * success: it is "this may have happened and we do not know". The types make
 * that structural — it cannot be retryable, its side effect is always
 * `possible`, and it alone says to reconcile. Nothing converts it to
 * `succeeded` or `failed` without a reconciliation this contract does not do.
 */
export type UnifiedExecutionOutcome =
  | (UnifiedOutcomeBase & { status: "succeeded"; sideEffect: "none" | "confirmed"; retryable: false })
  | (UnifiedOutcomeBase & { status: "failed"; failure: UnifiedOutcomeFailure; sideEffect: "none" | "possible"; retryable: boolean })
  | (UnifiedOutcomeBase & { status: "pending"; reason: UnifiedPendingReason; sideEffect: "none" | "possible"; retryable: false })
  | (UnifiedOutcomeBase & { status: "uncertain"; reason: UnifiedUncertainReason; sideEffect: "possible"; retryable: false; resolution: "reconcile" });

export function isUncertainOutcome(outcome: UnifiedExecutionOutcome): outcome is Extract<UnifiedExecutionOutcome, { status: "uncertain" }> {
  return outcome.status === "uncertain";
}

/** True only for a failure that is a read, or was told it may be tried again. Never for uncertain. */
export function isSafeToRetryOutcome(outcome: UnifiedExecutionOutcome): boolean {
  return outcome.status === "failed" && outcome.retryable === true;
}

/**
 * Project one `ToolExecutionResult` into the unified contract.
 *
 * Pure, and NOT wired to anything: no surface calls it yet (the normalizer that
 * applies it to chat and task responses is a later stage). It reads the status,
 * whether the result says success, the two metadata flags below, and ids. It
 * does not read the result's data, and it does not repeat the tool's words.
 *
 * What makes an outcome UNCERTAIN, from what the executor and tools do today:
 *   - a write that TIMED OUT. The executor says a timeout "never proves an
 *     external write did not happen"; for a read there is no effect to doubt.
 *   - a result carrying `metadata.outcome === "unknown"`, which the browser write
 *     tools return when the journal marked the call UNKNOWN.
 *   - a write reported complete with no success in its result.
 * A write that returns an ordinary failure is a failure with `sideEffect:
 * "possible"` and is never retried, because nothing in a `ToolResult` can say
 * the effect did not happen. Other write tools signal an ambiguous outcome only
 * in a sentence (the n8n trigger's "may have started"); that is not read, and
 * closing it means those tools returning the metadata flag.
 */
export function outcomeFromToolExecution(
  execution: ToolExecutionResult,
  capability: CapabilityRef,
  options: OutcomeFromToolExecutionOptions = {}
): UnifiedExecutionOutcome {
  const readOnly = capability.risk === "READ_ONLY";

  // A workflow's own record, and only for a workflow. Anything but a string status is no confirmation.
  const workflowRun: string | undefined =
    capability.kind === "n8n_workflow" && isRecord(options) && isRecord(options.workflowRun) && typeof options.workflowRun.status === "string"
      ? options.workflowRun.status
      : undefined;

  // Plain identifiers only. A tool name is chosen by a MODEL, and an id that is not a plain token is not evidence.
  const executionId = safeId(execution.executionId);
  const approvalId = safeId(execution.approvalId);
  const evidence: UnifiedOutcomeEvidence = {
    toolId: safeId(execution.toolId) ?? UNIDENTIFIED,
    ...(executionId ? { executionId } : {}),
    ...(approvalId ? { approvalId } : {}),
    ...(typeof execution.durationMs === "number" ? { durationMs: execution.durationMs } : {}),
  };
  const base: UnifiedOutcomeBase = {
    capabilityId: safeId(capability.id) ?? UNIDENTIFIED,
    kind: capability.kind,
    evidence,
    untrusted: capability.kind !== "native" || execution.result?.metadata?.treatedAsUntrustedData === true,
  };

  const failed = (
    kind: UnifiedOutcomeFailure["kind"],
    sideEffect: "none" | "possible",
    retryable: boolean,
    fixed?: { code: string; message: string }
  ): UnifiedExecutionOutcome => {
    const safe = fixed ?? classifyToolFailure(execution.error ?? execution.result?.error, execution.toolId);
    return { ...base, status: "failed", failure: { kind, code: safe.code, message: safe.message }, sideEffect, retryable };
  };
  const uncertain = (reason: UnifiedUncertainReason): UnifiedExecutionOutcome => ({
    ...base,
    status: "uncertain",
    reason,
    sideEffect: "possible",
    retryable: false,
    resolution: "reconcile",
  });
  const pending = (reason: UnifiedPendingReason, sideEffect: "none" | "possible"): UnifiedExecutionOutcome => ({
    ...base,
    status: "pending",
    reason,
    sideEffect,
    retryable: false,
  });

  switch (execution.status) {
    case "completed":
      if (execution.result?.success === true) {
        // A workflow trigger that was accepted says only that the request left. What the run did is the
        // repository's record to say, applied by a signed callback — never this tool's own result.
        if (capability.kind === "n8n_workflow") {
          switch (workflowRun) {
            case "SUCCEEDED":
              return { ...base, status: "succeeded", sideEffect: readOnly ? "none" : "confirmed", retryable: false };
            case "FAILED":
              return failed("tool_failed", "possible", false, { code: "WORKFLOW_RUN_FAILED", message: "The workflow reported a failure." });
            case "TIMED_OUT":
              return uncertain("timed_out_after_start");
            default:
              // TRIGGERED, no record, or a status this does not know: accepted, and unconfirmed.
              return pending("awaiting_confirmation", "possible");
          }
        }
        return { ...base, status: "succeeded", sideEffect: readOnly ? "none" : "confirmed", retryable: false };
      }
      // Complete, with nothing that says it worked: a read is a failure; a write is not claimed either way.
      return readOnly ? failed("tool_failed", "none", false) : uncertain("outcome_unknown");

    case "approval_required":
    case "approval_pending":
      return pending(execution.status, "none");
    case "clarification_required":
      return pending("clarification_required", "none");
    case "pending":
    case "validating":
    case "executing":
      return pending("in_progress", readOnly ? "none" : "possible");

    case "permission_denied":
    case "approval_denied":
      return failed("refused", "none", false);
    case "not_requested":
    case "unavailable":
      return failed("not_run", "none", false);

    case "timed_out":
      return readOnly ? failed("timed_out", "none", true) : uncertain("timed_out_after_start");

    case "failed": {
      if (execution.result?.metadata?.outcome === "unknown") return uncertain("outcome_unknown");
      // The trigger failed, but the row that was claimed before the request left still says TRIGGERED (or that
      // it ran out of time): the request may have started. The row says it; a sentence is not read for it.
      if (capability.kind === "n8n_workflow" && (workflowRun === "TRIGGERED" || workflowRun === "TIMED_OUT")) return uncertain("outcome_unknown");
      // The executor refused before the tool ran (not found, invalid input, shutting down).
      if (!execution.result) return failed("not_run", "none", false);
      return readOnly ? failed("tool_failed", "none", true) : failed("tool_failed", "possible", false);
    }

    default: {
      // A status this contract does not know: a read is a failure that is not retried; a write is not claimed.
      const unrecognised: never = execution.status;
      void unrecognised;
      return readOnly ? failed("tool_failed", "none", false) : uncertain("outcome_unknown");
    }
  }
}

// ---------------------------------------------------------------------------
// UEE-4 — what an outcome is told about a capability, a workflow's run, and a
// sandbox's result. Pure: none of it is called by an execution path yet except
// the orchestrator's summary, which reads `outcomeFromToolExecution`.
// ---------------------------------------------------------------------------

/** The three things an outcome needs to know about the capability: its id, its kind and its risk. */
export type CapabilityRef = Pick<CapabilityDescriptor, "id" | "kind" | "risk">;

/**
 * What the repository records about ONE workflow run: its status as `N8nExecutionStatus` —
 * TRIGGERED (the request left, no answer yet), SUCCEEDED or FAILED (a signed, replay-guarded
 * callback applied the result), TIMED_OUT. Read by the CALLER from the run's own record and handed
 * in, so an outcome is decided by what JARVIS recorded, not by what a tool or a model said.
 * A status that is not one of those four counts as no confirmation at all.
 */
export interface WorkflowRunConfirmation {
  readonly status: string;
}

export interface OutcomeFromToolExecutionOptions {
  /** Honoured only for a workflow capability. */
  readonly workflowRun?: WorkflowRunConfirmation;
}

/**
 * A sandbox client result, as far as an outcome reads it. `N8nSandboxResult<N8nSandboxExecutionResult>`
 * is assignable to it; stdout, stderr, any command or environment and the error's message are not
 * part of it, and are never read.
 */
export type SandboxRunInput =
  | {
      readonly ok: true;
      readonly data: {
        readonly execId: string;
        readonly exitCode: number;
        readonly success: boolean;
        readonly timedOut: boolean;
        readonly killed: boolean;
        readonly executionTimeMs?: number;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly execId?: string;
        readonly retryable: boolean;
        readonly sideEffectPossible: boolean;
      };
    };

/** A plain token: letters, digits and . _ : - only. Anything else is not an identifier, and is not evidence. */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const safeId = (value: unknown): string | undefined => (typeof value === "string" && SAFE_ID.test(value) ? value : undefined);

/**
 * Which kind a registry tool is, from its id and its own risk: the sandbox by the same id rule the
 * derivation uses, the one workflow runner, everything else native. Pure; it is how the response layer
 * names a result's capability without a catalogue.
 */
export function capabilityRefForTool(tool: { id: string; risk: RiskLevel }): CapabilityRef {
  const id = String(tool.id);
  const kind: ExecutionKind = SANDBOX_TOOL_ID.test(id) ? "sandbox" : id === WORKFLOW_RUNNER_TOOL_ID ? "n8n_workflow" : "native";
  return { id, kind, risk: tool.risk };
}

/** One fixed code and sentence per family of sandbox error. Never the service's words. */
function sandboxFailureWording(code: unknown): { code: string; message: string } {
  switch (code) {
    case "AUTHENTICATION_FAILED":
    case "FORBIDDEN":
      return { code: "SANDBOX_REQUEST_REFUSED", message: "The sandbox service refused the request." };
    case "RATE_LIMITED":
    case "UNAVAILABLE":
      return { code: "SANDBOX_UNAVAILABLE", message: "The sandbox service is not available right now." };
    case "INVALID_REQUEST":
    case "NOT_FOUND":
    case "CONFLICT":
    case "GONE":
      return { code: "SANDBOX_REQUEST_REJECTED", message: "The sandbox could not accept that request." };
    default:
      return { code: "SANDBOX_REQUEST_FAILED", message: "The sandbox could not complete the request." };
  }
}

/**
 * Project a sandbox client result into the unified contract.
 *
 * The sandbox stays UNEXPOSED: this reads a result someone hands it and registers, calls and enables
 * nothing. What it does with one:
 *   - the output is always `untrusted` — it is whatever arbitrary code printed;
 *   - evidence is the execution id (when it is a plain token) and a duration: no stdout, no stderr, no
 *     command, no environment, and not the error's message;
 *   - a command that exited 0 without timing out or being killed is a success; one that ran and did not
 *     is a failure that MAY have had an effect, and is not retried;
 *   - a timeout or a kill, an error that says the request may have taken effect (the client's own
 *     `sideEffectPossible`, which is how an incomplete stream surfaces), and anything this cannot read
 *     are UNCERTAIN — never success, never an ordinary failure, never retryable. An execution outlives
 *     its stream, so its id is kept for the reconciliation that resolves it;
 *   - an error that could not have taken effect is a failure that did not run, retryable only as far as
 *     the client says repeating the same request is safe.
 */
export function outcomeFromSandboxRun(run: SandboxRunInput, capability: Pick<CapabilityRef, "id" | "risk">): UnifiedExecutionOutcome {
  const readOnly = isRecord(capability) && capability.risk === "READ_ONLY";
  const toolId = (isRecord(capability) ? safeId(capability.id) : undefined) ?? UNIDENTIFIED;

  const evidenceOf = (execId: unknown, durationMs?: unknown): UnifiedOutcomeEvidence => {
    const id = safeId(execId);
    return {
      toolId,
      ...(id ? { executionId: id } : {}),
      ...(typeof durationMs === "number" && Number.isFinite(durationMs) ? { durationMs } : {}),
    };
  };
  const baseOf = (evidence: UnifiedOutcomeEvidence): UnifiedOutcomeBase => ({ capabilityId: toolId, kind: "sandbox", evidence, untrusted: true });
  const uncertainOf = (evidence: UnifiedOutcomeEvidence, reason: UnifiedUncertainReason): UnifiedExecutionOutcome => ({
    ...baseOf(evidence),
    status: "uncertain",
    reason,
    sideEffect: "possible",
    retryable: false,
    resolution: "reconcile",
  });

  const source: unknown = run;
  if (isRecord(source) && source.ok === true && isRecord(source.data)) {
    const data = source.data;
    const evidence = evidenceOf(data.execId, data.executionTimeMs);
    if (data.timedOut === true) return uncertainOf(evidence, "timed_out_after_start");
    if (data.killed === true) return uncertainOf(evidence, "outcome_unknown");
    if (data.success === true && data.exitCode === 0) {
      return { ...baseOf(evidence), status: "succeeded", sideEffect: readOnly ? "none" : "confirmed", retryable: false };
    }
    if (typeof data.exitCode === "number") {
      return {
        ...baseOf(evidence),
        status: "failed",
        failure: { kind: "tool_failed", code: "SANDBOX_COMMAND_FAILED", message: "The command in the sandbox did not complete successfully." },
        sideEffect: readOnly ? "none" : "possible",
        retryable: false,
      };
    }
    return uncertainOf(evidence, "outcome_unknown");
  }

  if (isRecord(source) && source.ok === false && isRecord(source.error)) {
    const error = source.error;
    const evidence = evidenceOf(error.execId);
    if (error.sideEffectPossible === true) return uncertainOf(evidence, error.code === "TOOL_TIMEOUT" ? "timed_out_after_start" : "outcome_unknown");
    if (error.sideEffectPossible === false) {
      const wording = sandboxFailureWording(error.code);
      return {
        ...baseOf(evidence),
        status: "failed",
        failure: { kind: "not_run", code: wording.code, message: wording.message },
        sideEffect: "none",
        retryable: error.retryable === true,
      };
    }
  }

  // Not a result this can read, or an error that does not say whether it took effect: not known.
  return uncertainOf(evidenceOf(undefined), "outcome_unknown");
}
