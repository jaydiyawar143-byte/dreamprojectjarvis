// ---------------------------------------------------------------------------
// Phase 17, Stage 3A — the operator command's logic: the ONLY writer of
// tenants, memberships and connector owners.
//
// Operator-driven only (apps/api/scripts/tenant-admin). No route, tool or
// agent imports this module, and none may: a membership grants access to a
// tenant's resources, so it is created and changed by a person running a
// reviewed command, never by a request.
//
// WHAT IT GUARANTEES.
//
//   • ONE TRANSACTION PER CHANGE, WITH ITS AUDIT ROW. The change and the row
//     that records it commit together or not at all. If the row cannot be
//     written, the change is not made.
//   • A TENANT ALWAYS HAS AN OWNER. A tenant is created together with its
//     first owner, and no demotion or removal may leave it without one. The
//     check runs under a row lock on the tenant (`SELECT … FOR UPDATE`), so
//     every change to one tenant's memberships is serialized: two demotions
//     arriving together cannot both see "another owner remains".
//   • A DRY RUN BY DEFAULT. Without `execute`, the same checks run and nothing
//     is written; the result says what would change.
//   • IDS, NEVER TEXT. An audit row carries ids and role names only.
//   • ONLY KNOWN CONNECTIONS. A connector owner may be recorded only for a key
//     in `SHARED_CONNECTOR_KEYS` — a connection some route actually enforces.
// ---------------------------------------------------------------------------

import type { Prisma, PrismaClient } from "@prisma/client";
import { SHARED_CONNECTOR_KEYS, isTenantRole, type TenantRole } from "@jarvis/core";

type DbRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

const ROLE_TO_DB: Readonly<Record<TenantRole, DbRole>> = {
  owner: "OWNER",
  admin: "ADMIN",
  member: "MEMBER",
  viewer: "VIEWER",
};
const ROLE_FROM_DB: Readonly<Record<DbRole, TenantRole>> = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  VIEWER: "viewer",
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 120;
const TRANSACTION = { maxWait: 10_000, timeout: 10_000 } as const;

// ---------------------------------------------------------------------------
// Commands and results
// ---------------------------------------------------------------------------

export type TenantAdminCommand =
  | { verb: "create-tenant"; name: string; ownerUserId: string }
  | { verb: "add-member"; tenantId: string; userId: string; role: TenantRole }
  | { verb: "set-role"; tenantId: string; userId: string; role: TenantRole }
  | { verb: "remove-member"; tenantId: string; userId: string }
  | { verb: "assign-connector"; providerId: string; connector: string; tenantId: string }
  | { verb: "unassign-connector"; providerId: string; connector: string }
  | { verb: "list"; tenantId: string };

export type TenantAdminVerb = TenantAdminCommand["verb"];

export const TENANT_ADMIN_VERBS: readonly TenantAdminVerb[] = [
  "create-tenant",
  "add-member",
  "set-role",
  "remove-member",
  "assign-connector",
  "unassign-connector",
  "list",
];

export type TenantAdminRefusalCode =
  | "INVALID_INPUT"
  | "ACTOR_NOT_FOUND"
  | "TENANT_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "ALREADY_MEMBER"
  | "NOT_A_MEMBER"
  | "NO_CHANGE"
  | "LAST_OWNER"
  | "CONNECTOR_NOT_ASSIGNED"
  | "UNKNOWN_CONNECTOR";

/** Ids and role names only — what a result and an audit row may carry. */
export type TenantAdminDetail = Readonly<Record<string, string | readonly Readonly<Record<string, string>>[]>>;

export type TenantAdminResult =
  | { ok: true; verb: TenantAdminVerb; executed: boolean; detail: TenantAdminDetail }
  | { ok: false; verb: TenantAdminVerb; code: TenantAdminRefusalCode; message: string };

/** The audit row written in the same transaction as the change it records. */
export interface TenantAuditRow {
  /** The existing account the operator attributed the change to. */
  userId: string;
  action: string;
  metadata: Readonly<Record<string, string>>;
}

export interface TenantAdminOptions {
  /** The existing account the change is attributed to (`--as`). */
  actorUserId: string;
  /** False: a dry run — the same checks, nothing written. */
  execute: boolean;
  /**
   * How the audit row is written inside the transaction. Defaults to an
   * `AuditLog` insert; a test passes one that fails, to prove the change
   * rolls back with it.
   */
  writeAudit?: (tx: Prisma.TransactionClient, row: TenantAuditRow) => Promise<void>;
}

/** Fixed sentences: no refusal repeats a value it was given. */
const REFUSAL_MESSAGES: Readonly<Record<TenantAdminRefusalCode, string>> = {
  INVALID_INPUT: "The command's arguments are not valid.",
  ACTOR_NOT_FOUND: "The account named to attribute this change to does not exist.",
  TENANT_NOT_FOUND: "No tenant has that id.",
  USER_NOT_FOUND: "No account has that id.",
  ALREADY_MEMBER: "That account is already a member of this tenant.",
  NOT_A_MEMBER: "That account is not a member of this tenant.",
  NO_CHANGE: "Nothing would change.",
  LAST_OWNER: "This would leave the tenant without an owner; add another owner first.",
  CONNECTOR_NOT_ASSIGNED: "That connection has no owner to remove.",
  UNKNOWN_CONNECTOR: "That connection is not one whose owner can be recorded.",
};

class Refused extends Error {
  constructor(readonly code: TenantAdminRefusalCode) {
    super(REFUSAL_MESSAGES[code]);
    this.name = "TenantAdminRefused";
  }
}

// ---------------------------------------------------------------------------
// Validation — pure
// ---------------------------------------------------------------------------

const isId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);
const isKnownConnector = (providerId: string, connector: string) =>
  SHARED_CONNECTOR_KEYS.some((key) => key.providerId === providerId && key.connector === connector);

/** Whether a command is well-formed. Never echoes a value. */
export function validateTenantAdminCommand(
  command: TenantAdminCommand
): { ok: true } | { ok: false; code: "INVALID_INPUT" | "UNKNOWN_CONNECTOR" } {
  switch (command.verb) {
    case "create-tenant": {
      const name = typeof command.name === "string" ? command.name.trim() : "";
      return name.length > 0 && name.length <= NAME_MAX && isId(command.ownerUserId)
        ? { ok: true }
        : { ok: false, code: "INVALID_INPUT" };
    }
    case "add-member":
    case "set-role":
      return isId(command.tenantId) && isId(command.userId) && isTenantRole(command.role)
        ? { ok: true }
        : { ok: false, code: "INVALID_INPUT" };
    case "remove-member":
      return isId(command.tenantId) && isId(command.userId) ? { ok: true } : { ok: false, code: "INVALID_INPUT" };
    case "assign-connector":
      if (!isId(command.tenantId)) return { ok: false, code: "INVALID_INPUT" };
      return isKnownConnector(command.providerId, command.connector) ? { ok: true } : { ok: false, code: "UNKNOWN_CONNECTOR" };
    case "unassign-connector":
      return isKnownConnector(command.providerId, command.connector) ? { ok: true } : { ok: false, code: "UNKNOWN_CONNECTOR" };
    case "list":
      return isId(command.tenantId) ? { ok: true } : { ok: false, code: "INVALID_INPUT" };
    default:
      return { ok: false, code: "INVALID_INPUT" };
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

const defaultWriteAudit = async (tx: Prisma.TransactionClient, row: TenantAuditRow): Promise<void> => {
  await tx.auditLog.create({
    data: { userId: row.userId, action: row.action, result: "SUCCESS", metadata: { ...row.metadata } },
  });
};

/**
 * Runs one operator command. A refusal is a result; an unexpected database
 * failure throws (and, inside a transaction, has written nothing).
 */
export async function runTenantAdminCommand(
  prisma: PrismaClient,
  command: TenantAdminCommand,
  options: TenantAdminOptions
): Promise<TenantAdminResult> {
  const verb = command.verb;
  const refuse = (code: TenantAdminRefusalCode): TenantAdminResult => ({
    ok: false,
    verb,
    code,
    message: REFUSAL_MESSAGES[code],
  });

  const valid = validateTenantAdminCommand(command);
  if (!valid.ok) return refuse(valid.code);
  if (!isId(options.actorUserId)) return refuse("ACTOR_NOT_FOUND");

  const actor = await prisma.user.findUnique({ where: { id: options.actorUserId }, select: { id: true } });
  if (!actor) return refuse("ACTOR_NOT_FOUND");

  if (command.verb === "list") {
    const tenant = await prisma.tenant.findUnique({
      where: { id: command.tenantId },
      select: {
        id: true,
        memberships: { select: { userId: true, role: true }, orderBy: { userId: "asc" } },
        connectorOwners: { select: { providerId: true, connector: true }, orderBy: { providerId: "asc" } },
      },
    });
    if (!tenant) return refuse("TENANT_NOT_FOUND");
    return {
      ok: true,
      verb,
      executed: false,
      detail: {
        tenantId: tenant.id,
        members: tenant.memberships.map((m) => ({ userId: m.userId, role: ROLE_FROM_DB[m.role] })),
        connectors: tenant.connectorOwners.map((c) => ({ providerId: c.providerId, connector: c.connector })),
      },
    };
  }

  const writeAudit = options.writeAudit ?? defaultWriteAudit;
  const write = options.execute;

  try {
    const detail = write
      ? await prisma.$transaction((tx) => apply(tx, command, true, options.actorUserId, writeAudit), TRANSACTION)
      : await apply(prisma, command, false, options.actorUserId, writeAudit);
    return { ok: true, verb, executed: write, detail };
  } catch (error) {
    if (error instanceof Refused) return refuse(error.code);
    throw error;
  }
}

/**
 * One command's checks, and — when `write` — its change and audit row. Runs
 * inside the transaction when writing; outside it for a dry run, where no lock
 * is taken because nothing is written.
 */
async function apply(
  db: Prisma.TransactionClient,
  command: Exclude<TenantAdminCommand, { verb: "list" }>,
  write: boolean,
  actorUserId: string,
  writeAudit: NonNullable<TenantAdminOptions["writeAudit"]>
): Promise<TenantAdminDetail> {
  const audit = (action: string, metadata: Record<string, string>) =>
    writeAudit(db, { userId: actorUserId, action, metadata });

  switch (command.verb) {
    case "create-tenant": {
      await requireUser(db, command.ownerUserId);
      const planned = { userId: command.ownerUserId, role: "owner" };
      if (!write) return planned;
      // The tenant and its first owner are one write: a tenant never exists,
      // even for an instant, without an owner.
      const tenant = await db.tenant.create({
        data: {
          name: command.name.trim(),
          memberships: { create: { userId: command.ownerUserId, role: "OWNER" } },
        },
        select: { id: true },
      });
      const detail = { tenantId: tenant.id, ...planned };
      await audit("tenant.create", detail);
      return detail;
    }

    case "add-member": {
      await lockTenant(db, command.tenantId, write);
      await requireUser(db, command.userId);
      const existing = await findMembership(db, command.tenantId, command.userId);
      if (existing) throw new Refused("ALREADY_MEMBER");
      const detail = { tenantId: command.tenantId, userId: command.userId, role: command.role };
      if (!write) return detail;
      await db.tenantMembership.create({
        data: { tenantId: command.tenantId, userId: command.userId, role: ROLE_TO_DB[command.role] },
      });
      await audit("tenant.member.add", detail);
      return detail;
    }

    case "set-role": {
      await lockTenant(db, command.tenantId, write);
      const existing = await findMembership(db, command.tenantId, command.userId);
      if (!existing) throw new Refused("NOT_A_MEMBER");
      const target = ROLE_TO_DB[command.role];
      if (existing === target) throw new Refused("NO_CHANGE");
      if (existing === "OWNER") await requireAnotherOwner(db, command.tenantId);
      const detail = {
        tenantId: command.tenantId,
        userId: command.userId,
        role: command.role,
        previousRole: ROLE_FROM_DB[existing],
      };
      if (!write) return detail;
      await db.tenantMembership.update({
        where: { tenantId_userId: { tenantId: command.tenantId, userId: command.userId } },
        data: { role: target },
      });
      await audit("tenant.member.role", detail);
      return detail;
    }

    case "remove-member": {
      await lockTenant(db, command.tenantId, write);
      const existing = await findMembership(db, command.tenantId, command.userId);
      if (!existing) throw new Refused("NOT_A_MEMBER");
      if (existing === "OWNER") await requireAnotherOwner(db, command.tenantId);
      const detail = { tenantId: command.tenantId, userId: command.userId, previousRole: ROLE_FROM_DB[existing] };
      if (!write) return detail;
      await db.tenantMembership.delete({
        where: { tenantId_userId: { tenantId: command.tenantId, userId: command.userId } },
      });
      await audit("tenant.member.remove", detail);
      return detail;
    }

    case "assign-connector": {
      if (write) await lockConnector(db, command.providerId, command.connector);
      await lockTenant(db, command.tenantId, write);
      const key = { providerId: command.providerId, connector: command.connector };
      const current = await db.automationConnectorOwner.findUnique({
        where: { providerId_connector: key },
        select: { tenantId: true },
      });
      if (current?.tenantId === command.tenantId) throw new Refused("NO_CHANGE");
      const detail: Record<string, string> = {
        ...key,
        tenantId: command.tenantId,
        ...(current ? { previousTenantId: current.tenantId } : {}),
      };
      if (!write) return detail;
      await db.automationConnectorOwner.upsert({
        where: { providerId_connector: key },
        create: { ...key, tenantId: command.tenantId },
        update: { tenantId: command.tenantId },
      });
      await audit("tenant.connector.assign", detail);
      return detail;
    }

    case "unassign-connector": {
      if (write) await lockConnector(db, command.providerId, command.connector);
      const key = { providerId: command.providerId, connector: command.connector };
      const current = await db.automationConnectorOwner.findUnique({
        where: { providerId_connector: key },
        select: { tenantId: true },
      });
      if (!current) throw new Refused("CONNECTOR_NOT_ASSIGNED");
      const detail = { ...key, previousTenantId: current.tenantId };
      if (!write) return detail;
      await db.automationConnectorOwner.delete({ where: { providerId_connector: key } });
      await audit("tenant.connector.unassign", detail);
      return detail;
    }
  }
}

/**
 * The tenant must exist. When writing, its row is locked for the rest of the
 * transaction, which serializes every membership change to this tenant.
 */
async function lockTenant(db: Prisma.TransactionClient, tenantId: string, write: boolean): Promise<void> {
  const found = write
    ? await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`
    : await db.tenant.findMany({ where: { id: tenantId }, select: { id: true }, take: 1 });
  if (found.length === 0) throw new Refused("TENANT_NOT_FOUND");
}

/** Serializes changes to one connection's owner, whichever tenant they name. */
async function lockConnector(db: Prisma.TransactionClient, providerId: string, connector: string): Promise<void> {
  const lockKey = `tenant-admin:connector:${providerId}:${connector}`;
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}

async function requireUser(db: Prisma.TransactionClient, userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new Refused("USER_NOT_FOUND");
}

async function findMembership(db: Prisma.TransactionClient, tenantId: string, userId: string): Promise<DbRole | null> {
  const row = await db.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { role: true },
  });
  return row ? (row.role as DbRole) : null;
}

/** Read under the tenant lock when writing, so it is the count the change is made against. */
async function requireAnotherOwner(db: Prisma.TransactionClient, tenantId: string): Promise<void> {
  const owners = await db.tenantMembership.count({ where: { tenantId, role: "OWNER" } });
  if (owners <= 1) throw new Refused("LAST_OWNER");
}
