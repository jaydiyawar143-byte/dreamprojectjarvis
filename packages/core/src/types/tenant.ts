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

/** The key one deployment-wide connection's owner is recorded under. */
export interface SharedConnectorKey {
  providerId: string;
  connector: string;
}

/**
 * Phase 17 multi-business hardening — the integrations whose connection the
 * DEPLOYMENT configures for everyone, by integration id, and the key each one's
 * owning Organization is recorded under.
 *
 * `meta` is the deployment's Meta Marketing API credential (META_ACCESS_TOKEN
 * with META_AD_ACCOUNT_ID). A user's own stored Meta credentials are not this
 * connection: they are that user's. The others are the server-managed
 * integrations of the Integration Control Center. Google is absent because it
 * is always one user's own consent, never a deployment's.
 *
 * An unassigned connection belongs to nobody: its tools, its connection test
 * and its diagnostics are refused to everyone — account-wide owners and admins
 * included — until an operator assigns it.
 */
export const SHARED_INTEGRATION_CONNECTORS = {
  meta: { providerId: "meta", connector: "ads" },
  n8n: { providerId: "n8n", connector: "rest" },
  whatsapp: { providerId: "whatsapp", connector: "cloud-api" },
  "google-maps": { providerId: "google-maps", connector: "server-key" },
  mcp: { providerId: "mcp", connector: "servers" },
  omniroute: { providerId: "omniroute", connector: "gateway" },
} as const satisfies Record<string, SharedConnectorKey>;

export type SharedIntegrationId = keyof typeof SHARED_INTEGRATION_CONNECTORS;

/** The connector key of a shared integration, or null for a per-user one. */
export function sharedConnectorFor(integrationId: string): SharedConnectorKey | null {
  return Object.prototype.hasOwnProperty.call(SHARED_INTEGRATION_CONNECTORS, integrationId)
    ? SHARED_INTEGRATION_CONNECTORS[integrationId as SharedIntegrationId]
    : null;
}

/**
 * The deployment-wide connections whose owner can be recorded, and the only
 * keys the operator command accepts. A connection is listed here only once a
 * route enforces its ownership — an owner nothing reads would be a record that
 * looks like a control and is not one.
 */
export const SHARED_CONNECTOR_KEYS: readonly SharedConnectorKey[] = [
  { providerId: "n8n", connector: "mcp" },
  ...Object.values(SHARED_INTEGRATION_CONNECTORS),
];

/**
 * The tools that act THROUGH a shared connection, and what each does with it.
 *
 * Every Meta Ads tool runs on the deployment's one Meta credential, so every
 * one is here: the reads, the composite analysis (whose reads are the same
 * tools), and every write. A tool listed here runs only for a member of the
 * Organization that owns the connection, holding the permission its access
 * needs (`packages/security`, shared-connection-authz) — and an approval for a
 * `write` belongs to that Organization from the moment it is created, and must
 * be given by one of its owners or admins who is not the requester.
 */
export const SHARED_CONNECTION_TOOLS: Readonly<
  Record<string, { integration: SharedIntegrationId; access: "read" | "write" }>
> = {
  "meta.accounts": { integration: "meta", access: "read" },
  "meta.campaigns": { integration: "meta", access: "read" },
  "meta.adsets": { integration: "meta", access: "read" },
  "meta.ads": { integration: "meta", access: "read" },
  "meta.insights": { integration: "meta", access: "read" },
  "meta.analyze": { integration: "meta", access: "read" },
  "meta.campaign.pause": { integration: "meta", access: "write" },
  "meta.campaign.resume": { integration: "meta", access: "write" },
  "meta.adset.pause": { integration: "meta", access: "write" },
  "meta.adset.resume": { integration: "meta", access: "write" },
  "meta.ad.pause": { integration: "meta", access: "write" },
  "meta.ad.resume": { integration: "meta", access: "write" },
  "meta.campaign.budget.update": { integration: "meta", access: "write" },
  "meta.adset.budget.update": { integration: "meta", access: "write" },
  "meta.campaign.create": { integration: "meta", access: "write" },
};

/** What a tool does with its shared connection, or null when it uses none. */
export function sharedConnectionOfTool(
  toolId: string
): { integration: SharedIntegrationId; connector: SharedConnectorKey; access: "read" | "write" } | null {
  if (typeof toolId !== "string" || !Object.prototype.hasOwnProperty.call(SHARED_CONNECTION_TOOLS, toolId)) {
    return null;
  }
  const entry = SHARED_CONNECTION_TOOLS[toolId]!;
  return { integration: entry.integration, connector: SHARED_INTEGRATION_CONNECTORS[entry.integration], access: entry.access };
}

/**
 * Who may take part in one shared-connection write, resolved by the server
 * when the write runs and checked by the approval store IN the conditional
 * update that consumes the approval: the approval must belong to `tenantId`,
 * the Organization must still own the connection, the requester must still
 * hold one of `requesterRoles`, and the approver — who must not be the
 * requester — must still hold one of `approverRoles`. All of it, or nothing
 * runs.
 */
export interface SharedConnectionScope {
  tenantId: string;
  providerId: string;
  connector: string;
  requesterRoles: readonly TenantRole[];
  approverRoles: readonly TenantRole[];
}
