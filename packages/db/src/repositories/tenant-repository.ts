// ---------------------------------------------------------------------------
// Phase 17, Stage 3A — tenant reads.
//
// READS ONLY. This repository answers the two questions an authorization
// boundary asks on every protected request — who owns this connection, and
// what is this account's role in that tenant — straight from the database, so
// a membership that was removed or re-roled a moment ago is already in force.
// There is no cache to go stale.
//
// Nothing here writes. Tenants, memberships and connector owners are written
// only by the operator command (`maintenance/tenant-admin.ts`), each change in
// one transaction with its audit row.
//
// BOTH IDS, ALWAYS. A membership is found by its unique key (tenant, user), so
// no caller can ask "some membership of this account" and be handed one for
// the wrong tenant.
//
// ONE EXCEPTION, AND IT DECIDES NOTHING. `listMemberships` reads by user alone,
// so the desktop service can show a person the Organizations they administer
// (Phase 19.6; docs/phases/phase-19.md, §18.9). It is not on the
// `TenantMembershipReader` port every other boundary reads, the desktop service
// is its only caller, and that service decides about any one Organization with
// `findMembership`. apps/api/test/tenant-admin-cli-p17.test.ts pins all of it.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";
import type {
  AutomationConnectorOwnerReader,
  ConnectorOwnerLookup,
  TenantMembershipReader,
  TenantRole,
} from "@jarvis/core";

const ROLE_FROM_DB: Readonly<Record<string, TenantRole>> = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  VIEWER: "viewer",
};

/** The `TenantRole` enum value a core role is stored as. */
export const TENANT_ROLE_TO_DB: Readonly<Record<TenantRole, "OWNER" | "ADMIN" | "MEMBER" | "VIEWER">> = {
  owner: "OWNER",
  admin: "ADMIN",
  member: "MEMBER",
  viewer: "VIEWER",
};

/** An id as this schema writes it. Anything else is not looked up at all. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** A provider or connector key, e.g. "n8n". */
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export class PrismaTenantRepository implements TenantMembershipReader, AutomationConnectorOwnerReader {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * This account's role in this tenant, or null when it is not a member. A
   * role the code does not know is reported as no membership: an unknown role
   * grants nothing, so it must not reach the engine as if it might.
   */
  async findMembership(userId: string, tenantId: string): Promise<{ role: TenantRole } | null> {
    if (!ID_PATTERN.test(userId) || !ID_PATTERN.test(tenantId)) return null;
    const row = await this.prisma.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { role: true },
    });
    if (!row) return null;
    const role = ROLE_FROM_DB[row.role];
    return role ? { role } : null;
  }

  /**
   * Phase 19.6 — every tenant this account is a member of, with its name and
   * role, read now. An unknown role is left out, as `findMembership` reports it
   * as none. For showing a person their Organizations and narrowing a list:
   * the one exception above, never a way to decide about a tenant.
   */
  async listMemberships(userId: string): Promise<Array<{ tenantId: string; tenantName: string; role: TenantRole }>> {
    if (!ID_PATTERN.test(userId)) return [];
    const rows = await this.prisma.tenantMembership.findMany({
      where: { userId },
      select: { tenantId: true, role: true, tenant: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    });
    return rows.flatMap((row) => {
      const role = ROLE_FROM_DB[row.role];
      return role ? [{ tenantId: row.tenantId, tenantName: row.tenant.name, role }] : [];
    });
  }

  /**
   * Who owns a deployment-wide connection: the owner record, then its tenant,
   * as two reads. A record whose tenant id is malformed or names no tenant is
   * `invalid` — refused like an unassigned connection, but named apart.
   *
   * Two reads rather than one through the relation, on purpose (review
   * finding L1): the relation is required, so a record whose tenant row is
   * missing makes Prisma throw instead of returning it — which the route would
   * report as the database being unreachable, not as an invalid owner. The
   * foreign key keeps such a record from being written; this keeps the answer
   * right if one ever exists anyway.
   */
  async findConnectorOwner(providerId: string, connector: string): Promise<ConnectorOwnerLookup> {
    if (!KEY_PATTERN.test(providerId) || !KEY_PATTERN.test(connector)) return { status: "unassigned" };
    const row = await this.prisma.automationConnectorOwner.findUnique({
      where: { providerId_connector: { providerId, connector } },
      select: { tenantId: true },
    });
    if (!row) return { status: "unassigned" };
    if (!ID_PATTERN.test(row.tenantId)) return { status: "invalid" };
    const tenant = await this.prisma.tenant.findUnique({ where: { id: row.tenantId }, select: { id: true } });
    return tenant ? { status: "assigned", tenantId: row.tenantId } : { status: "invalid" };
  }
}
