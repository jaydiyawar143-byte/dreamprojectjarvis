// ---------------------------------------------------------------------------
// Phase 17, Stage 1 — the Permission and Risk Engine for automation operations.
//
// WHAT THIS IS. The one place where a question about an automation operation is
// answered: MAY this session, on this surface, perform this operation on this
// resource — and at what risk? It is pure: no I/O, no connector, no provider
// SDK, and it executes nothing. The caller gets a decision and remains
// responsible for acting on it.
//
// WHY IT EXISTS. Phase 16 built capability-based ROUTING (`resolveAutomationRoute`
// in @jarvis/core): it picks the surface that can do the job. Capability is not
// authorization — a route that only asks "which connector supports this?" is a
// route that never asks WHO. This engine is the authorization layer that sits
// in front of that routing decision, and it is deliberately the only one, so
// REST and MCP cannot be gated by two subtly different rules.
//
// THE DECISION ORDER (cheap identity checks first, routing last; the tenant
// steps are Stage 3A's, described below):
//
//   identity → operation → risk → ownership → membership → owner/agent
//            → membership role → per-surface capability
//
// Every step DEFAULT-DENIES. An unverified identity, an unrecognized role, an
// operation that is not in the declared set, or an operation with no risk
// classification all end in a refusal with a fixed code and a fixed sentence.
// There is no fall-through that answers "yes" because nothing above objected.
//
// TRUSTED INPUTS ONLY. `subject.auth` is the `AuthContext` a verified session
// token produced (`requireAuth`); `subject.membership` is what the server read
// from the database for this request; `subject.agentId` is the session's
// agent, set server-side from the conversation row (`SessionContext`). None
// comes from a request body, a tool parameter or a provider payload. The scope
// (`tenantId`, `ownerUserId`, `agentId`) is resolved the same way — from a
// stored ownership record, where the owner is part of the query filter, never a
// post-hoc check. This engine performs no lookup itself: it compares things the
// caller already resolved through trusted means.
//
// SCOPE IS HARD, ROLE IS NOT AN OVERRIDE. Role says WHAT a principal may do;
// scope says WHOSE resource it may be done to. Both must pass. An `owner`
// membership (which holds every capability) still receives
// `SCOPE_TENANT_MISMATCH` for another tenant's resource and
// `SCOPE_OWNER_MISMATCH` for another principal's — matching the repository
// rule that the owner filter is written in the query, never applied afterwards.
//
// REST AND MCP ARE DISTINCT GRANTS. `rest:read` is not `mcp:read`. A fallback
// from one surface to the other is permitted ONLY to a surface that
// independently holds its own grant for this operation — the preferred surface
// being denied never weakens the check on the next one, and when no candidate
// surface holds a grant the answer is a refusal, not the other surface. And
// because risk is classified from the OPERATION (never from the surface, never
// from a provider's self-description), a fallback cannot drop the approval
// requirement: `manage` and `execute` demand approval on REST exactly as on
// MCP — the same table ToolExecutor's gate reads (`RISK_REQUIRES_APPROVAL`).
//
// WHAT THIS MODULE IS NOT. It reaches no provider and invokes nothing; the
// n8n MCP read routes consult it (Stage 2), and execution stays out of scope
// until the approval architecture (Phase 16 Stage 3 spec) is implemented.
//
// STAGE 3A — TENANTS (Organizations in the product). A resource now belongs
// to a TENANT, and the role that counts is the caller's MEMBERSHIP role in
// that tenant, never the account-wide `auth.role`:
//
//   • `scope.tenantId` is required — a resource with no recorded owning
//     tenant is refused (`RESOURCE_OWNERSHIP_MISSING`), never assumed to be
//     the caller's.
//   • `subject.membership` is the caller's membership IN THAT TENANT, read by
//     the server from the database for this request. Absent, or belonging to
//     another account: `TENANT_MEMBERSHIP_REQUIRED`. For another tenant:
//     `SCOPE_TENANT_MISMATCH`.
//   • Grants come from the membership role alone (`grantsForTenantRole`).
//     An account-wide owner or admin who is not a member of the tenant holds
//     nothing on its resources; this module does not read `auth.role` at all.
//   • `scope.ownerUserId`, when a resource also belongs to one user inside the
//     tenant, is checked BESIDE the tenant, never instead of it.
//
// The decision order becomes:
//
//   identity → operation → risk → ownership → membership in that tenant
//            → owner (if any) → agent (if any) → membership role → per-surface capability
// ---------------------------------------------------------------------------

import type {
  AuthContext,
  AutomationConnectorId,
  AutomationConnectorStatus,
  AutomationOperation,
  RiskLevel,
  TenantMembershipContext,
} from "@jarvis/core";
import { AUTOMATION_OPERATIONS, resolveAutomationRoute } from "@jarvis/core";
import { RISK_REQUIRES_APPROVAL } from "./tool-approval.js";

// ---------------------------------------------------------------------------
// Capability vocabulary — per-surface, deliberately separate from the
// presentation vocabulary in core's `capability-catalog.ts` (that one is what a
// person reads; this one is what a session is GRANTED).
// ---------------------------------------------------------------------------

/** The surface a permission is granted on. REST and MCP are distinct. */
export type AutomationSurface = AutomationConnectorId;

/**
 * One capability on one surface. The four values are the complete vocabulary;
 * anything else is simply not a grant this engine knows, and an unknown grant
 * is worth nothing (default-deny applies to grants too).
 */
export type AutomationPermission =
  | "rest:read"
  | "rest:write"
  | "mcp:read"
  | "mcp:write";

/** The complete grant vocabulary, for docs and any future UI. */
export const AUTOMATION_PERMISSIONS: readonly AutomationPermission[] = [
  "rest:read",
  "rest:write",
  "mcp:read",
  "mcp:write",
];

// ---------------------------------------------------------------------------
// Risk classification — explicit, exhaustive over the declared operations,
// and a property of the OPERATION, never of the surface that runs it.
// ---------------------------------------------------------------------------

/**
 * `list` / `describe` / `monitor` read; `manage` changes workflow state;
 * `execute` runs a workflow. The table is `Record<AutomationOperation, …>`, so
 * adding an operation without classifying it is a compile error — and the
 * runtime guard below still refuses anything the declared set does not
 * contain, so an unknown string can never inherit a classification.
 */
const OPERATION_RISK: Readonly<Record<AutomationOperation, RiskLevel>> = {
  list: "READ_ONLY",
  describe: "READ_ONLY",
  monitor: "READ_ONLY",
  manage: "HIGH_IMPACT",
  execute: "EXTERNAL_SIDE_EFFECT",
};

const OPERATION_SET: ReadonlySet<string> = new Set<string>(AUTOMATION_OPERATIONS);

/**
 * The risk of an automation operation, or `null` when the operation is not
 * declared or its classification is missing. `null` means default-deny at the
 * call site — never a guessed or permissive fallback.
 */
export function classifyAutomationRisk(operation: string): RiskLevel | null {
  if (typeof operation !== "string" || !OPERATION_SET.has(operation)) return null;
  const risk = OPERATION_RISK[operation as AutomationOperation];
  // Guarded as a value check as well: the membership test above keeps
  // inherited object keys ("toString", "__proto__") out, and this keeps a
  // future table hole from passing as a classification.
  return risk === "READ_ONLY" ||
    risk === "LOW_IMPACT" ||
    risk === "EXTERNAL_SIDE_EFFECT" ||
    risk === "HIGH_IMPACT" ||
    risk === "FINANCIAL"
    ? risk
    : null;
}

/**
 * Which capability a risk demands. Everything that is not plainly read-only
 * demands the surface's WRITE grant — a conservative direction: a
 * misclassified risk asks for more privilege, never less.
 */
export function capabilityKindForRisk(risk: RiskLevel): "read" | "write" {
  return risk === "READ_ONLY" ? "read" : "write";
}

// ---------------------------------------------------------------------------
// Membership role → grants. Explicit, reviewed, and default-deny for anything
// unknown. Keyed by the TENANT membership role (Stage 3A); the account-wide
// role is not an input to this table.
//
// POLICY (Stage 3A, approved — docs/tenant-model-design.md §4.4; changing it
// is this table only, and there is no per-tenant override):
//   • `rest:read`   — every recognized role.
//   • `rest:write`  — owner/admin only (`manage` changes external state).
//   • `mcp:read`    — owner, admin and member. A viewer holds none.
//   • `mcp:write`   — owner/admin only, and still approval-gated: no write
//                     path exists for any role in this phase.
// A member's read grant implies nothing else — there is no stored
// per-account grant, so this table is every grant there is.
// ---------------------------------------------------------------------------

const ROLE_GRANTS: ReadonlyMap<string, readonly AutomationPermission[]> = new Map<
  string,
  readonly AutomationPermission[]
>([
  ["owner", ["rest:read", "rest:write", "mcp:read", "mcp:write"]],
  ["admin", ["rest:read", "rest:write", "mcp:read", "mcp:write"]],
  ["member", ["rest:read", "mcp:read"]],
  ["viewer", ["rest:read"]],
]);

/**
 * The capabilities a TENANT membership role holds for automation operations.
 * An unrecognized role — a typo, an upper-case database value that was not
 * mapped, a forged claim — holds nothing.
 */
export function grantsForTenantRole(role: string): readonly AutomationPermission[] {
  if (typeof role !== "string") return [];
  return ROLE_GRANTS.get(role) ?? [];
}

// ---------------------------------------------------------------------------
// Inputs and the decision.
// ---------------------------------------------------------------------------

/**
 * The trusted caller. `auth` is what the verified access token produced — only
 * its `userId` is read; its account-wide `role` is not an input. `membership`
 * is the caller's membership in the resource's tenant, read by the server from
 * the database for THIS request (`findMembership(userId, tenantId)`).
 * `agentId` is the session's agent, set server-side. Whatever was not resolved
 * through trusted means must be `null`/`undefined` — guessing is worse than
 * admitting absence, because the engine denies absence.
 */
export interface AutomationCallSubject {
  auth: AuthContext | null | undefined;
  membership: TenantMembershipContext | null | undefined;
  agentId?: string | undefined;
}

/**
 * The target resource's ownership, resolved server-side BEFORE this call:
 * `tenantId` is the tenant that owns it (for a deployment-wide connection,
 * `findConnectorOwner`); `ownerUserId` is present when the resource also
 * belongs to one user inside that tenant, and is checked beside the tenant;
 * `agentId` is present only for a resource that belongs to a specific agent.
 */
export interface AutomationResourceScope {
  tenantId: string;
  ownerUserId?: string | undefined;
  agentId?: string | undefined;
}

export interface AutomationAuthzInput {
  subject: AutomationCallSubject;
  /**
   * Deliberately typed as `string`, not `AutomationOperation`: unknown input is
   * the normal case at this boundary, and the default-deny must be the runtime
   * behavior, not a cast the caller performs.
   */
  operation: string;
  scope: AutomationResourceScope;
  /** What each surface actually offers right now (availability + operations). */
  connectors: readonly AutomationConnectorStatus[];
}

export type AutomationAuthzDenyCode =
  | "IDENTITY_REQUIRED"
  | "ROLE_UNRECOGNIZED"
  | "OPERATION_UNKNOWN"
  | "RISK_UNCLASSIFIED"
  | "RESOURCE_OWNERSHIP_MISSING"
  | "TENANT_MEMBERSHIP_REQUIRED"
  | "SCOPE_TENANT_MISMATCH"
  | "SCOPE_OWNER_MISMATCH"
  | "AGENT_CONTEXT_REQUIRED"
  | "AGENT_SCOPE_MISMATCH"
  | "NO_SUPPORTED_SURFACE"
  | "SURFACE_PERMISSION_DENIED";

/**
 * Fixed sentences. None of them echoes an input — not the operation string
 * (an attacker-supplied value must not be reflected), not a user id, not a
 * tenant id, not an agent id. The caller maps a code to an HTTP status (and
 * may answer several codes with one uniform refusal); this module says only
 * what was refused and why, in words we chose. A tenant is an "organization"
 * in every sentence, because that is the product's word for it.
 */
const DENY_MESSAGES: Readonly<Record<AutomationAuthzDenyCode, string>> = {
  IDENTITY_REQUIRED: "A verified session identity is required for this operation.",
  ROLE_UNRECOGNIZED: "The session's organization role is not recognized for automation operations.",
  OPERATION_UNKNOWN: "The requested automation operation is not recognized.",
  RISK_UNCLASSIFIED: "The requested automation operation has no risk classification.",
  RESOURCE_OWNERSHIP_MISSING: "This resource has no recorded owning organization.",
  TENANT_MEMBERSHIP_REQUIRED: "The session is not a member of the organization that owns this resource.",
  SCOPE_TENANT_MISMATCH: "The session's membership is for a different organization than this resource's.",
  SCOPE_OWNER_MISMATCH: "This resource belongs to another principal.",
  AGENT_CONTEXT_REQUIRED:
    "This resource is agent-scoped and the session carries no agent context.",
  AGENT_SCOPE_MISMATCH:
    "The session's agent context does not match this resource's agent.",
  NO_SUPPORTED_SURFACE: "No available connector supports this operation.",
  SURFACE_PERMISSION_DENIED:
    "The session holds no capability for this operation on any available surface.",
};

export type AutomationAuthzDecision =
  | {
      allowed: true;
      operation: AutomationOperation;
      /** From the operation, never from the surface or the provider. */
      risk: RiskLevel;
      /** Whether an approval must bind before this may execute (spec §3). */
      requiresApproval: boolean;
      /** The surface the engine selected through the grant-checked fallback. */
      surface: AutomationSurface;
      /** The exact capability that was required on that surface and held. */
      capability: AutomationPermission;
    }
  | {
      allowed: false;
      code: AutomationAuthzDenyCode;
      message: string;
    };

function deny(code: AutomationAuthzDenyCode): AutomationAuthzDecision {
  return { allowed: false, code, message: DENY_MESSAGES[code] };
}

/**
 * Authorize one automation operation for one trusted session against one
 * resolved resource scope.
 *
 * The ONLY way to `allowed: true` is to pass every step: a recognized
 * identity, a declared operation, a risk classification, a recorded owning
 * tenant, the caller's own membership in exactly that tenant, an owner match
 * where the resource also belongs to one user (and agent match, where it is
 * agent-scoped), a recognized membership role, and a surface that both
 * supports the operation AND is granted its capability — where every fallback
 * candidate is checked with the same rule as the first.
 */
export function authorizeAutomationOperation(
  input: AutomationAuthzInput
): AutomationAuthzDecision {
  // 1. Trusted identity. Absent or malformed: refuse, before looking at
  // anything else.
  const auth = input.subject?.auth;
  if (!auth || typeof auth.userId !== "string" || auth.userId.length === 0) {
    return deny("IDENTITY_REQUIRED");
  }

  // 2. Declared operation. Not in the set (or not even a string): refuse. This
  // is where "execuite", "", "constructor" and "__proto__" all land.
  if (typeof input.operation !== "string" || !OPERATION_SET.has(input.operation)) {
    return deny("OPERATION_UNKNOWN");
  }

  // 3. Classification. A declared operation with no risk refuses rather than
  // assuming a class — unclassified means unapproved, not unregulated.
  const risk = classifyAutomationRisk(input.operation);
  if (risk === null) {
    return deny("RISK_UNCLASSIFIED");
  }
  const operation = input.operation as AutomationOperation;

  // 4. Ownership — which tenant this resource belongs to. Hard: no role, grant
  // or fallback overrides it, and a resource with no recorded owner is not one
  // this engine will authorize for anybody.
  const scope = input.scope;
  if (!scope || typeof scope.tenantId !== "string" || scope.tenantId.length === 0) {
    return deny("RESOURCE_OWNERSHIP_MISSING");
  }

  // 5. Membership — the caller's own, in exactly that tenant. A membership the
  // server read for another account is not this caller's; one for another
  // tenant does not reach this resource.
  const membership = input.subject.membership;
  if (
    !membership ||
    typeof membership.userId !== "string" ||
    membership.userId !== auth.userId ||
    typeof membership.tenantId !== "string"
  ) {
    return deny("TENANT_MEMBERSHIP_REQUIRED");
  }
  if (membership.tenantId !== scope.tenantId) {
    return deny("SCOPE_TENANT_MISMATCH");
  }

  // 6. Owner and agent — checked BESIDE the tenant, for a resource that also
  // belongs to one user or one agent inside it.
  if (scope.ownerUserId !== undefined && scope.ownerUserId !== null) {
    if (typeof scope.ownerUserId !== "string" || scope.ownerUserId !== auth.userId) {
      return deny("SCOPE_OWNER_MISMATCH");
    }
  }
  if (scope.agentId !== undefined && scope.agentId !== null) {
    if (
      typeof input.subject.agentId !== "string" ||
      input.subject.agentId.length === 0
    ) {
      return deny("AGENT_CONTEXT_REQUIRED");
    }
    if (input.subject.agentId !== scope.agentId) {
      return deny("AGENT_SCOPE_MISMATCH");
    }
  }

  // 7. Membership role. Unrecognized: nothing. Recognized: its explicit grants.
  // (Every recognized role holds at least one grant, so "no grants" and
  // "unknown role" are the same answer: refuse.) `auth.role` is deliberately
  // not consulted: on a tenant's resource, only the membership counts.
  const role = membership.role;
  if (typeof role !== "string" || !ROLE_GRANTS.has(role)) {
    return deny("ROLE_UNRECOGNIZED");
  }
  const grants = grantsForTenantRole(role);

  // 8. Per-surface capability, with fallback that cannot bypass. The registry
  // decides which surface PREFERED the operation; if that surface lacks the
  // grant it is removed and the registry re-consulted — the next candidate is
  // checked with the identical rule. There is no branch that hands the
  // operation to a surface nobody granted.
  const kind = capabilityKindForRisk(risk);
  const remaining = [...input.connectors];
  let grantDenied = false;

  for (;;) {
    const route = resolveAutomationRoute(operation, remaining);
    if (!route.ok) {
      return deny(grantDenied ? "SURFACE_PERMISSION_DENIED" : "NO_SUPPORTED_SURFACE");
    }
    const capability = `${route.connector}:${kind}` as AutomationPermission;
    if (grants.includes(capability)) {
      return {
        allowed: true,
        operation,
        risk,
        // Derived from the operation's risk, so surviving a fallback from one
        // surface to the other cannot shed the approval requirement.
        requiresApproval: RISK_REQUIRES_APPROVAL[risk],
        surface: route.connector,
        capability,
      };
    }
    grantDenied = true;
    const index = remaining.findIndex((c) => c.connector === route.connector);
    if (index === -1) {
      // Unreachable while `resolveAutomationRoute` only returns connectors it
      // was given; the guard keeps the loop finite if that ever changes.
      return deny("SURFACE_PERMISSION_DENIED");
    }
    remaining.splice(index, 1);
  }
}
