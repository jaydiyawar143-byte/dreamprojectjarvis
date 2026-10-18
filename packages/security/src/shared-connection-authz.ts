// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening — authorization for SHARED connections.
//
// WHAT THIS IS. The one answer to: may this session use, test or look into a
// connection the DEPLOYMENT configured for everyone — the Meta credential, the
// server-managed integrations — on behalf of the Organization that owns it?
// Pure, like `automation-authz.ts` beside it: no I/O, no provider SDK, and it
// executes nothing. The caller resolves the owner and the membership through
// trusted means and gets a decision back.
//
// WHY IT EXISTS (review findings H2, M3, L11). A shared credential used to be
// usable by anybody signed in: the Meta tools held the deployment's token and
// the account-wide role passed their check, every account could run a
// connection test that spent the operator's keys, and every account was shown
// the operator's identifiers. The credential being present said nothing about
// WHO may use it. Now the connection belongs to an Organization (an operator
// records which, `AutomationConnectorOwner`) and only that Organization's
// members, by their membership role, may do anything with it.
//
// NOT A NEW MODEL. The four tenant roles, the membership the server read for
// THIS request (by both ids), the owner the operator recorded, a fixed
// decision order and a reviewed grant table — the shape of
// `automation-authz.ts`. What this file adds is the vocabulary of what can be
// done to a shared connection, because a Meta credential has no REST or MCP
// surface for that engine's grants to be about.
//
// THE DECISION ORDER (every step default-denies):
//
//   identity → operation → ownership → membership in that tenant
//            → membership role → grant
//
// The account-wide `auth.role` is never read: on an Organization's
// connection only the membership counts, so a platform owner or admin who is
// not a member holds nothing (Stage 3A decision 2).
//
// APPROVAL IS SOMEONE ELSE'S. `authorizeIndependentApproval` is the rule for
// a write: whoever approves it must hold `shared:approve` in the Organization
// the write acts for AND must not be the person who asked for it. The approval
// store applies the same rule again, in the conditional update that consumes
// the approval (`sharedWriteScope` is what it is given), so a check here that
// passed a moment ago cannot stand in for one that must hold as the write runs.
// ---------------------------------------------------------------------------

import type {
  AuthContext,
  SharedConnectionScope,
  SharedConnectorKey,
  TenantMembershipContext,
  TenantRole,
} from "@jarvis/core";
import { TENANT_ROLES } from "@jarvis/core";

/**
 * What can be done with a shared connection.
 *
 *   read         use it to read — Meta campaigns, insights, accounts
 *   write        ask for a change through it — every one approval-gated
 *   approve      approve SOMEONE ELSE's write through it
 *   status       see that it exists for your Organization and whether it works
 *   diagnostics  see the operator's identifiers, details, errors and usage
 *   test         run its connection test, which spends the shared credential
 */
export const SHARED_CONNECTION_OPERATIONS = [
  "read",
  "write",
  "approve",
  "status",
  "diagnostics",
  "test",
] as const;

export type SharedConnectionOperation = (typeof SHARED_CONNECTION_OPERATIONS)[number];

export type SharedConnectionPermission = `shared:${SharedConnectionOperation}`;

const OPERATION_SET: ReadonlySet<string> = new Set<string>(SHARED_CONNECTION_OPERATIONS);

// ---------------------------------------------------------------------------
// Membership role → grants. Explicit, reviewed, default-deny for anything
// unknown. Keyed by the TENANT membership role; the account-wide role is not
// an input to this table.
//
// POLICY (the Stage 3A direction, applied to shared connections — changing it
// is this table only, and there is no per-tenant override):
//   • read, status          — every recognized role.
//   • write                 — owner and admin only, as `rest:write` is.
//   • approve               — owner and admin only, and never one's own write.
//   • diagnostics, test     — owner and admin only: identifiers and the
//                             credential's quota are the operator side.
// ---------------------------------------------------------------------------

const EVERY_PERMISSION: readonly SharedConnectionPermission[] = SHARED_CONNECTION_OPERATIONS.map(
  (operation) => `shared:${operation}` as const
);

const ROLE_GRANTS: ReadonlyMap<string, readonly SharedConnectionPermission[]> = new Map<
  string,
  readonly SharedConnectionPermission[]
>([
  ["owner", EVERY_PERMISSION],
  ["admin", EVERY_PERMISSION],
  ["member", ["shared:read", "shared:status"]],
  ["viewer", ["shared:read", "shared:status"]],
]);

/**
 * The shared-connection capabilities a TENANT membership role holds. An
 * unrecognized role — a typo, an unmapped database value, a forged claim —
 * holds nothing.
 */
export function sharedConnectionGrantsFor(role: string): readonly SharedConnectionPermission[] {
  if (typeof role !== "string") return [];
  return ROLE_GRANTS.get(role) ?? [];
}

/**
 * The tenant roles that hold `permission`, in the table's order. This is what
 * the approval store is handed for the checks it makes in SQL, so the table
 * above stays the only place the policy is written.
 */
export function rolesHoldingSharedPermission(permission: SharedConnectionPermission): TenantRole[] {
  return TENANT_ROLES.filter((role) => sharedConnectionGrantsFor(role).includes(permission));
}

/**
 * Everything the approval store must re-check when it consumes the approval
 * for a write through `connector` on behalf of `tenantId`.
 */
export function sharedWriteScope(tenantId: string, connector: SharedConnectorKey): SharedConnectionScope {
  return {
    tenantId,
    providerId: connector.providerId,
    connector: connector.connector,
    requesterRoles: rolesHoldingSharedPermission("shared:write"),
    approverRoles: rolesHoldingSharedPermission("shared:approve"),
  };
}

// ---------------------------------------------------------------------------
// Inputs and the decision.
// ---------------------------------------------------------------------------

export interface SharedConnectionSubject {
  /** What the verified access token produced. Only `userId` is read. */
  auth: Pick<AuthContext, "userId"> | null | undefined;
  /** The caller's membership in the OWNING tenant, read for this request. */
  membership: TenantMembershipContext | null | undefined;
}

export interface SharedConnectionAuthzInput {
  subject: SharedConnectionSubject;
  /**
   * Typed as `string` on purpose: unknown input is the normal case at this
   * boundary, and the default-deny must be the runtime behavior.
   */
  operation: string;
  /**
   * The Organization that owns the connection, from the operator's record —
   * `null` when the connection has no owner (unassigned or invalid).
   */
  scope: { tenantId: string } | null | undefined;
}

export type SharedConnectionDenyCode =
  | "IDENTITY_REQUIRED"
  | "OPERATION_UNKNOWN"
  | "RESOURCE_OWNERSHIP_MISSING"
  | "TENANT_MEMBERSHIP_REQUIRED"
  | "SCOPE_TENANT_MISMATCH"
  | "ROLE_UNRECOGNIZED"
  | "PERMISSION_DENIED"
  | "SELF_APPROVAL_FORBIDDEN";

/**
 * Fixed sentences that echo no input — no operation string, no id. A caller
 * may answer several codes with one uniform refusal (it must, wherever the
 * difference would tell an outsider who owns what); these say only what was
 * refused, in words we chose.
 */
const DENY_MESSAGES: Readonly<Record<SharedConnectionDenyCode, string>> = {
  IDENTITY_REQUIRED: "A verified session identity is required.",
  OPERATION_UNKNOWN: "The requested operation on a shared connection is not recognized.",
  RESOURCE_OWNERSHIP_MISSING: "This connection has no recorded owning organization.",
  TENANT_MEMBERSHIP_REQUIRED: "The session is not a member of the organization that owns this connection.",
  SCOPE_TENANT_MISMATCH: "The session's membership is for a different organization than this connection's.",
  ROLE_UNRECOGNIZED: "The session's organization role is not recognized.",
  PERMISSION_DENIED: "The session's organization role does not allow this on this connection.",
  SELF_APPROVAL_FORBIDDEN: "A change must be approved by an owner or admin other than the person who asked for it.",
};

export type SharedConnectionAuthzDecision =
  | {
      allowed: true;
      operation: SharedConnectionOperation;
      permission: SharedConnectionPermission;
      tenantId: string;
      role: TenantRole;
    }
  | {
      allowed: false;
      code: SharedConnectionDenyCode;
      message: string;
    };

function deny(code: SharedConnectionDenyCode): SharedConnectionAuthzDecision {
  return { allowed: false, code, message: DENY_MESSAGES[code] };
}

/**
 * Authorize one operation on one shared connection for one trusted session.
 *
 * The ONLY way to `allowed: true` is to pass every step: a verified identity,
 * a declared operation, a recorded owning Organization, the caller's own
 * membership in exactly that Organization, a recognized membership role, and
 * that role's grant for the operation.
 */
export function authorizeSharedConnection(input: SharedConnectionAuthzInput): SharedConnectionAuthzDecision {
  // 1. Trusted identity.
  const auth = input?.subject?.auth;
  if (!auth || typeof auth.userId !== "string" || auth.userId.length === 0) {
    return deny("IDENTITY_REQUIRED");
  }

  // 2. Declared operation — "Write", "", "__proto__" all land here.
  if (typeof input.operation !== "string" || !OPERATION_SET.has(input.operation)) {
    return deny("OPERATION_UNKNOWN");
  }
  const operation = input.operation as SharedConnectionOperation;

  // 3. Ownership. A connection nobody owns is authorized for nobody.
  const scope = input.scope;
  if (!scope || typeof scope.tenantId !== "string" || scope.tenantId.length === 0) {
    return deny("RESOURCE_OWNERSHIP_MISSING");
  }

  // 4. Membership — the caller's own, in exactly that tenant.
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

  // 5. Membership role. `auth.role` is deliberately not consulted.
  const role = membership.role;
  if (typeof role !== "string" || !ROLE_GRANTS.has(role)) {
    return deny("ROLE_UNRECOGNIZED");
  }

  // 6. The grant.
  const permission = `shared:${operation}` as const;
  if (!sharedConnectionGrantsFor(role).includes(permission)) {
    return deny("PERMISSION_DENIED");
  }

  return { allowed: true, operation, permission, tenantId: scope.tenantId, role };
}

/**
 * Authorize one approval decision: `approver` may approve the write that
 * `requesterUserId` asked for, through a connection `scope` owns.
 *
 * Everything `authorizeSharedConnection` demands for `approve`, and one thing
 * more: the approver is not the requester. Being an owner does not let anyone
 * approve their own change — the point of a second person is that they are
 * second.
 */
export function authorizeIndependentApproval(input: {
  requesterUserId: string;
  approver: SharedConnectionSubject;
  scope: { tenantId: string } | null | undefined;
}): SharedConnectionAuthzDecision {
  const decision = authorizeSharedConnection({
    subject: input.approver,
    operation: "approve",
    scope: input.scope,
  });
  if (!decision.allowed) return decision;
  // An approval with no recorded requester is not one anybody may decide.
  if (typeof input.requesterUserId !== "string" || input.requesterUserId.length === 0) {
    return deny("PERMISSION_DENIED");
  }
  if (input.requesterUserId === input.approver.auth?.userId) {
    return deny("SELF_APPROVAL_FORBIDDEN");
  }
  return decision;
}
