// ---------------------------------------------------------------------------
// Phase 17 — Organization ownership and membership for tests, in memory.
//
// `memoryTenancy` stands in for the database behind `SharedConnectionAccess`
// (who owns each shared connection, and each account's role in each
// Organization). Tests hand it to the REAL access reader and the REAL policy
// table, so a harness that needs "this user may use Meta" gets it by being an
// owner of the Organization that owns Meta — never by a stub that says yes.
// ---------------------------------------------------------------------------

import {
  SHARED_CONNECTOR_KEYS,
  type AutomationConnectorOwnerReader,
  type ConnectorOwnerLookup,
  type TenantMembershipReader,
  type TenantRole,
} from "@jarvis/core";
import { SharedConnectionAccess } from "../../src/services/tenancy/shared-connection-access.js";
import type { TestBudgetPort } from "../../src/services/integrations/command-service.js";

const keyOf = (providerId: string, connector: string) => `${providerId}/${connector}`;

export interface MemoryTenancy extends AutomationConnectorOwnerReader, TenantMembershipReader {
  /** Records (or, with null, removes) who owns a connection. */
  setOwner(providerId: string, connector: string, tenantId: string | null): void;
  /** Records (or, with null, removes) an account's membership. */
  setRole(userId: string, tenantId: string, role: TenantRole | null): void;
  /** Every read throws while on: the database is unreachable. */
  setFailing(on: boolean): void;
  /** Reads made so far, by kind. */
  readonly reads: { owners: number; memberships: number };
}

export function memoryTenancy(init: {
  owners?: Record<string, string>;
  members?: ReadonlyArray<{ userId: string; tenantId: string; role: TenantRole }>;
} = {}): MemoryTenancy {
  const owners = new Map<string, string>(Object.entries(init.owners ?? {}));
  const members = new Map<string, TenantRole>();
  for (const m of init.members ?? []) members.set(`${m.tenantId}:${m.userId}`, m.role);
  let failing = false;
  const reads = { owners: 0, memberships: 0 };

  return {
    reads,
    async findConnectorOwner(providerId: string, connector: string): Promise<ConnectorOwnerLookup> {
      reads.owners += 1;
      if (failing) throw new Error("tenant store unreachable");
      const tenantId = owners.get(keyOf(providerId, connector));
      return tenantId ? { status: "assigned", tenantId } : { status: "unassigned" };
    },
    async findMembership(userId: string, tenantId: string): Promise<{ role: TenantRole } | null> {
      reads.memberships += 1;
      if (failing) throw new Error("tenant store unreachable");
      const role = members.get(`${tenantId}:${userId}`);
      return role ? { role } : null;
    },
    setOwner(providerId, connector, tenantId) {
      if (tenantId === null) owners.delete(keyOf(providerId, connector));
      else owners.set(keyOf(providerId, connector), tenantId);
    },
    setRole(userId, tenantId, role) {
      if (role === null) members.delete(`${tenantId}:${userId}`);
      else members.set(`${tenantId}:${userId}`, role);
    },
    setFailing(on) {
      failing = on;
    },
  };
}

/**
 * One Organization owning EVERY shared connection, with these members. What a
 * single-business deployment looks like once its operator has assigned
 * everything — the setting the older suites were written for.
 */
export function organizationOwningEverything(
  members: Record<string, TenantRole>,
  tenantId = "org-test"
): MemoryTenancy {
  return memoryTenancy({
    owners: Object.fromEntries(SHARED_CONNECTOR_KEYS.map((k) => [keyOf(k.providerId, k.connector), tenantId])),
    members: Object.entries(members).map(([userId, role]) => ({ userId, tenantId, role })),
  });
}

/** The real access reader over an in-memory tenancy. */
export function accessOver(tenancy: MemoryTenancy): SharedConnectionAccess {
  return new SharedConnectionAccess(tenancy);
}

/** A test budget that never runs out — for suites about something else. */
export const unlimitedTestBudget: TestBudgetPort = {
  reserveForUser: async () => ({ allowed: true }),
  reserveForOrganization: async () => ({ allowed: true }),
};
