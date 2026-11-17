// ---------------------------------------------------------------------------
// The execution router — UEE-3: a deterministic policy that picks which ONE
// capability, if any, may be handed to the existing execution path.
//
//   a model's proposal (names)  +  the UEE-2 catalogue for this user
//                          ──►  routed (one capability)  |  refused (a reason)
//
// THE MODEL PROPOSES; THIS DECIDES. A proposal is a list of capability NAMES
// and nothing else. The router reads no claim a model makes about a kind, a
// scope, a permission or an approval: what a name means comes from the
// catalogue, which is derived from the registry and the agent policies, and
// who may use it comes from the caller's permissions and the compiled-in agent
// table. The order the model names things in decides nothing either.
//
// WHAT IT DOES NOT DECIDE. Approval, permission and Organization access stay
// where they are: `ToolExecutor`, the permission checker, the access gate and
// the approval store. A routed decision says "this is the capability, run it
// through the executor"; it carries the capability's approval requirement only
// as a description, marked `decidedBy: "tool_executor"`, so nothing downstream
// can read "not_required" as permission to skip the executor. The router also
// narrows only: it refuses what the executor would refuse, early, and can never
// allow what the executor would refuse.
//
// PRECEDENCE, when more than one named capability is eligible:
//   0  a native capability from the tool registry
//   1  an n8n workflow (the caller's own, active, allow-listed — the catalogue
//      holds no other)
//   2  an MCP tool. It is NOT a native tool: it routes only where an existing
//      authorized path exists (an agent whose allowlist names it, in a
//      conversation) and never for unattended work, and it ranks last.
//   -  the sandbox: never. Refused as `sandbox_not_exposed` by its id alone,
//      before anything is looked up, whatever the catalogue says.
// Two eligible capabilities of the SAME precedence are refused as `ambiguous`:
// the router does not choose between them by the order they were named in.
//
// PURE. Synchronous, no clock, no randomness, no I/O, no registry, no executor,
// no repository, no model. Same inputs, same decision, in any order. Nothing it
// is given is changed, and everything it returns is frozen.
// ---------------------------------------------------------------------------

import {
  isExecutionKind,
  type CapabilityDescriptor,
  type CapabilityOrigin,
  type CapabilityRejectionReason,
  type CapabilityScope,
  type CapabilityUnavailableReason,
  type ExecutionKind,
  type ToolPermission,
} from "@jarvis/core";
import { getAgentPolicy, schedulableToolIds } from "./agent-policy.js";

/** Where the turn is happening. A task runs unattended and has no agent asked. */
export type RoutingSurface = "conversation" | "task";

/** The most names a proposal may carry. */
export const MAX_ROUTE_CANDIDATES = 8;

/**
 * The part of a UEE-2 catalogue the router reads. `CapabilityCatalogue` is
 * assignable to it; nothing else about the registry is needed or reachable.
 */
export interface RoutingCatalogue {
  /** Whom it was built for. The router refuses it for anyone else. */
  readonly forUser: string;
  readonly available: readonly CapabilityDescriptor[];
  readonly unavailable: ReadonlyArray<{
    readonly id: string;
    readonly kind: ExecutionKind;
    readonly origin: CapabilityOrigin;
    readonly reason: CapabilityUnavailableReason;
    readonly scope: CapabilityScope;
  }>;
  readonly rejected: ReadonlyArray<{ readonly id: string; readonly reason: CapabilityRejectionReason; readonly source: string }>;
  readonly sandbox?: { readonly status: "unavailable"; readonly reason: "sandbox_not_exposed" };
}

export interface ExecutionRouteRequest {
  /** The authenticated caller. The catalogue must have been built for them. */
  userId: string;
  surface: RoutingSurface;
  /** The agent that would carry it out. Required in a conversation; ignored for a task. */
  agentId?: string;
  /**
   * What the caller's ROLE holds, as the permission system answered. The router
   * only compares against it: it grants nothing and adds nothing to it.
   */
  grantedPermissions: readonly ToolPermission[];
  /** "voice" when the turn was spoken; anything else is text. */
  inputMode?: string;
  /** The model's proposal: capability names. Nothing else of a proposal is read. */
  candidates: readonly string[];
}

export type RoutingRefusalReason =
  | "invalid_request"
  | "too_many_candidates"
  | "catalogue_user_mismatch"
  | "unknown_capability"
  | CapabilityUnavailableReason
  | "invalid_metadata"
  | "duplicate_id"
  | "foreign_workflow"
  | "agent_not_permitted"
  | "not_schedulable"
  | "unresolved_scope"
  | "voice_not_allowed"
  | "missing_permission"
  | "agent_permission_floor"
  | "ambiguous"
  | "no_eligible_candidate";

/** What was decided about one named capability. */
export interface RoutingVerdict {
  readonly capabilityId: string;
  readonly eligible: boolean;
  /** Present when it was refused. */
  readonly reason?: RoutingRefusalReason;
  /** Present when it was eligible. Lower wins. */
  readonly precedence?: number;
}

export type ExecutionRouteDecision =
  | {
      readonly outcome: "routed";
      readonly capabilityId: string;
      readonly kind: ExecutionKind;
      readonly origin: CapabilityOrigin;
      /** The registry tool `ToolExecutor` runs for it (the runner, for a workflow). */
      readonly toolId: string;
      readonly scope: CapabilityScope;
      readonly precedence: number;
      /**
       * A description, never a decision. The executor decides approval; this
       * says what the capability's own metadata states, so a reader cannot
       * mistake "not_required" for a licence to skip the executor.
       */
      readonly approval: { readonly decidedBy: "tool_executor"; readonly described: "required" | "not_required" };
      readonly considered: readonly RoutingVerdict[];
    }
  | { readonly outcome: "refused"; readonly reason: RoutingRefusalReason; readonly considered: readonly RoutingVerdict[] };

// ---------------------------------------------------------------------------
// Fixed facts
// ---------------------------------------------------------------------------

/** The sandbox, by id alone: the same rule the UEE-1 derivation uses, so the two cannot disagree. */
const SANDBOX_TOOL_ID = /^(?:n8n[.:_-])?sandbox[.:_-]/i;

const PERMISSIONS: readonly string[] = ["read", "write", "execute", "admin"];
const UNAVAILABLE_REASONS: readonly string[] = ["disabled", "not_granted", "sandbox_not_exposed", "workflow_inactive", "workflow_runner_unavailable"];
const REJECTION_REASONS: readonly string[] = ["invalid_metadata", "duplicate_id", "foreign_workflow", "workflow_runner_unavailable"];

const PRECEDENCE_NATIVE = 0;
const PRECEDENCE_WORKFLOW = 1;
const PRECEDENCE_MCP = 2;

// ---------------------------------------------------------------------------
// Reading what is handed in
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** A descriptor, or null. A malformed entry is not a capability. */
function readDescriptor(raw: unknown): CapabilityDescriptor | null {
  if (!isRecord(raw)) return null;
  const { id, kind, origin, toolId, scope, agents, requiredPermissions, spokenTurn, approval, availability } = raw;
  if (!isText(id) || !isText(toolId) || !isExecutionKind(kind)) return null;
  // Only the combinations the derivation can produce.
  const combination = `${kind}/${String(origin)}`;
  if (!["native/tool_registry", "native/mcp", "n8n_workflow/n8n_allowlist", "sandbox/sandbox"].includes(combination)) return null;
  if (!isRecord(scope) || !["user", "organization", "unresolved"].includes(String(scope.kind))) return null;
  if (!Array.isArray(agents) || !Array.isArray(requiredPermissions)) return null;
  if (spokenTurn !== "may_start" && spokenTurn !== "refused") return null;
  if (approval !== "required" && approval !== "not_required") return null;
  if (!isRecord(availability) || availability.status !== "available") return null;
  return raw as unknown as CapabilityDescriptor;
}

function precedenceOf(descriptor: CapabilityDescriptor): number {
  if (descriptor.kind === "n8n_workflow") return PRECEDENCE_WORKFLOW;
  return descriptor.origin === "mcp" ? PRECEDENCE_MCP : PRECEDENCE_NATIVE;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function refusal(reason: RoutingRefusalReason, considered: readonly RoutingVerdict[] = []): ExecutionRouteDecision {
  return Object.freeze({ outcome: "refused" as const, reason, considered: Object.freeze([...considered]) });
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * Decide which one capability, if any, a proposal routes to.
 *
 * Total: any input produces a decision, nothing is thrown, nothing is called.
 */
export function routeExecution(request: ExecutionRouteRequest, catalogue: RoutingCatalogue): ExecutionRouteDecision {
  // ---- the request ----------------------------------------------------------
  if (!isRecord(request)) return refusal("invalid_request");
  const { userId, surface, agentId, grantedPermissions, candidates } = request as unknown as Record<string, unknown>;
  if (!isText(userId) || (surface !== "conversation" && surface !== "task")) return refusal("invalid_request");
  if (!Array.isArray(grantedPermissions) || !Array.isArray(candidates) || candidates.length === 0) return refusal("invalid_request");
  if (!candidates.every(isText)) return refusal("invalid_request");
  if (surface === "conversation" && !isText(agentId)) return refusal("invalid_request");

  const names = [...new Set(candidates as string[])];
  if (names.length > MAX_ROUTE_CANDIDATES) return refusal("too_many_candidates");

  // ---- the catalogue --------------------------------------------------------
  if (!isRecord(catalogue) || !Array.isArray(catalogue.available) || !Array.isArray(catalogue.unavailable) || !Array.isArray(catalogue.rejected)) {
    return refusal("invalid_request");
  }
  // One account's capabilities are never routed for another.
  if (catalogue.forUser !== userId) return refusal("catalogue_user_mismatch");

  const granted = new Set((grantedPermissions as unknown[]).filter((permission): permission is string => typeof permission === "string" && PERMISSIONS.includes(permission)));
  const spoken = (request as unknown as Record<string, unknown>).inputMode === "voice";

  // Indexed by id in Maps, never in objects: an id such as "constructor" finds nothing.
  const available = new Map<string, CapabilityDescriptor[]>();
  for (const entry of catalogue.available) {
    const descriptor = readDescriptor(entry);
    if (descriptor) available.set(descriptor.id, [...(available.get(descriptor.id) ?? []), descriptor]);
  }
  const unavailable = new Map<string, { kind: unknown; reason: unknown }>();
  for (const entry of catalogue.unavailable) {
    if (isRecord(entry) && isText(entry.id)) unavailable.set(entry.id, { kind: entry.kind, reason: entry.reason });
  }
  const rejected = new Map<string, unknown>();
  for (const entry of catalogue.rejected) {
    if (isRecord(entry) && isText(entry.id) && entry.reason !== "not_registered") rejected.set(entry.id, entry.reason);
  }

  const agentPolicy = surface === "conversation" ? getAgentPolicy(agentId as string) : undefined;
  const schedulable = surface === "task" ? schedulableToolIds() : undefined;

  const no = (capabilityId: string, reason: RoutingRefusalReason): RoutingVerdict => Object.freeze({ capabilityId, eligible: false, reason });

  // ---- each name, judged on its own ----------------------------------------
  const judge = (id: string): { verdict: RoutingVerdict; descriptor?: CapabilityDescriptor } => {
    // The sandbox first, by id, before anything is looked up.
    if (SANDBOX_TOOL_ID.test(id)) return { verdict: no(id, "sandbox_not_exposed") };

    // Anything the catalogue says is not usable stays refused, whatever else it also says.
    const notUsable = unavailable.get(id);
    if (notUsable) {
      if (notUsable.kind === "sandbox") return { verdict: no(id, "sandbox_not_exposed") };
      return { verdict: no(id, UNAVAILABLE_REASONS.includes(String(notUsable.reason)) ? (notUsable.reason as RoutingRefusalReason) : "unknown_capability") };
    }
    const rejectedFor = rejected.get(id);
    if (rejectedFor !== undefined) {
      return { verdict: no(id, REJECTION_REASONS.includes(String(rejectedFor)) ? (rejectedFor as RoutingRefusalReason) : "unknown_capability") };
    }

    const found = available.get(id);
    if (!found) return { verdict: no(id, "unknown_capability") };
    // The same id twice is a catalogue that cannot be trusted to mean one thing.
    if (found.length > 1) return { verdict: no(id, "ambiguous") };
    const descriptor = found[0]!;

    if (descriptor.kind === "sandbox" || SANDBOX_TOOL_ID.test(descriptor.toolId)) return { verdict: no(id, "sandbox_not_exposed") };
    if (descriptor.scope.kind === "unresolved") return { verdict: no(id, "unresolved_scope") };
    if (spoken && descriptor.spokenTurn === "refused") return { verdict: no(id, "voice_not_allowed") };

    if (surface === "conversation") {
      // Only an agent whose allowlist names it, and only an agent the server knows.
      if (!descriptor.agents.includes(agentId as string) || !agentPolicy) return { verdict: no(id, "agent_not_permitted") };
    } else if (!schedulable!.has(descriptor.toolId)) {
      // A task runs unattended: only what the task table allows (never MCP, never what speech may not start).
      return { verdict: no(id, "not_schedulable") };
    }

    if (!descriptor.requiredPermissions.every((permission) => granted.has(permission))) return { verdict: no(id, "missing_permission") };
    if (agentPolicy && !agentPolicy.requiredPermissions.every((permission) => granted.has(permission))) return { verdict: no(id, "agent_permission_floor") };

    return { verdict: Object.freeze({ capabilityId: id, eligible: true, precedence: precedenceOf(descriptor) }), descriptor };
  };

  const judged = names.map(judge);
  // Sorted by id, so the order a model named things in cannot show in the decision.
  const considered = judged.map((entry) => entry.verdict).sort((a, b) => compareText(a.capabilityId, b.capabilityId));
  const eligible = judged.filter((entry) => entry.verdict.eligible);

  if (eligible.length === 0) {
    return refusal(considered.length === 1 ? (considered[0]!.reason as RoutingRefusalReason) : "no_eligible_candidate", considered);
  }

  const best = Math.min(...eligible.map((entry) => entry.verdict.precedence as number));
  const top = eligible.filter((entry) => entry.verdict.precedence === best);
  if (top.length > 1) return refusal("ambiguous", considered);

  const chosen = top[0]!.descriptor!;
  return Object.freeze({
    outcome: "routed" as const,
    capabilityId: chosen.id,
    kind: chosen.kind,
    origin: chosen.origin,
    toolId: chosen.toolId,
    scope: chosen.scope,
    precedence: best,
    approval: Object.freeze({ decidedBy: "tool_executor" as const, described: chosen.approval }),
    considered: Object.freeze([...considered]),
  });
}
