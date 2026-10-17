// ---------------------------------------------------------------------------
// Phase 17, Stage 3A — tenants. CONTRACT ONLY.
//
// A tenant is a business — an Organization in the product — and the ownership
// boundary for tenant-owned resources. The design, and why each choice was
// made, is docs/tenant-model-design.md.
//
// THE TENANT COMES FROM THE RESOURCE, NEVER FROM THE REQUEST. A server reads
// which tenant owns the resource (`AutomationConnectorOwnerReader`), then the
// caller's membership in THAT tenant, by both ids (`TenantMembershipReader`).
// No header, query, body, tool parameter or socket payload names a tenant.
//
// THE MEMBERSHIP ROLE IS NOT THE ACCOUNT ROLE. `Role` (in `common.ts`) is the
// account-wide role and keeps every job it has. A tenant role has the same
// four names but is a different fact: what this account may do in this one
// tenant. They are kept apart by shape — a membership is an object carrying
// its tenant and its user, never a bare role string that could be swapped for
// the account's.
// ---------------------------------------------------------------------------

/** A role inside one tenant. Stored as the `TenantRole` enum. */
export const TENANT_ROLES = ["owner", "admin", "member", "viewer"] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" && (TENANT_ROLES as readonly string[]).includes(value);
}

/**
 * The caller's membership in ONE tenant, as the server read it from the
 * database for this request. `userId` and `tenantId` say whose membership and
 * in which tenant, so a membership read for one cannot be passed off as the
 * other's.
 */
export interface TenantMembershipContext {
  tenantId: string;
  userId: string;
  role: TenantRole;
}

/**
 * Reads one membership by BOTH ids. There is deliberately no read by user
 * alone: a lookup that could return "some membership of this user" is one
 * argument away from the wrong tenant.
 */
export interface TenantMembershipReader {
  findMembership(userId: string, tenantId: string): Promise<{ role: TenantRole } | null>;
}

/**
 * Who owns a connection the deployment configures for everyone.
 *
 *   assigned    an operator recorded this tenant as the owner.
 *   unassigned  nobody owns it — every request for it is refused.
 *   invalid     a record exists but its tenant cannot be resolved — refused
 *               like `unassigned`; reported separately so an operator can tell
 *               the two apart in the audit log.
 */
export type ConnectorOwnerLookup =
  | { status: "assigned"; tenantId: string }
  | { status: "unassigned" }
  | { status: "invalid" };

export interface AutomationConnectorOwnerReader {
  findConnectorOwner(providerId: string, connector: string): Promise<ConnectorOwnerLookup>;
}

/**
 * The deployment-wide connections whose owner can be recorded, and the only
 * keys the operator command accepts. A connection is listed here only once a
 * route enforces its ownership — an owner nothing reads would be a record that
 * looks like a control and is not one.
 */
export const SHARED_CONNECTOR_KEYS: readonly { providerId: string; connector: string }[] = [
  { providerId: "n8n", connector: "mcp" },
];
