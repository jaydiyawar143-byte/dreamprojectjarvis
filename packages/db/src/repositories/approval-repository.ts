import type {
  Approval,
  ApprovalParamsSealer,
  ApprovalStatus,
  IApprovalRepository,
  ApprovalConsumptionInput,
  ApprovalConsumptionResult,
  TenantRole,
} from "@jarvis/core";
import {
  DEFAULT_LEASE_MS,
  computeParamsHash,
  computerControlApprovalRecord,
  sealsApprovalParams,
  sharedConnectionOfTool,
} from "@jarvis/core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { PrismaTenantRepository, TENANT_ROLE_TO_DB } from "./tenant-repository.js";

type DbTenantRole = (typeof TENANT_ROLE_TO_DB)[TenantRole];

/** Core roles as stored. An unknown value maps to nothing, so it matches no row. */
function dbRoles(roles: readonly TenantRole[] | undefined): DbTenantRole[] {
  return (roles ?? []).flatMap((role) =>
    Object.prototype.hasOwnProperty.call(TENANT_ROLE_TO_DB, role) ? [TENANT_ROLE_TO_DB[role]] : []
  );
}

/**
 * Phase 17 — an approval for a write through a shared connection could not be
 * given its owning Organization: nobody owns the connection, the owner record
 * is invalid, or it could not be read. Nothing is created. A request nobody
 * could ever be allowed to approve is not put in front of anybody.
 */
export class SharedConnectionOwnerUnavailableError extends Error {
  constructor() {
    super("This connection has no owning organization, so no approval can be created for it.");
    this.name = "SharedConnectionOwnerUnavailableError";
  }
}

/**
 * Phase 19.5 — a browser or desktop approval could not be created, because
 * nothing can seal its exact parameters (no `JARVIS_ENCRYPTION_KEY`, or the
 * sealer failed). They are never stored in the clear instead, so nothing is
 * created.
 */
export class ApprovalParamsSealingUnavailableError extends Error {
  constructor() {
    super("This action's details cannot be held securely for approval, so no approval was created.");
    this.name = "ApprovalParamsSealingUnavailableError";
  }
}

/** What each read takes of the sealed parameters: the sealed text alone. */
const WITH_SEALED = { sealedParams: { select: { sealed: true } } } as const;

/** States in which an approval can never run again, so its sealed parameters go. */
const SPENT: ReadonlySet<ApprovalStatus> = new Set(["consumed", "rejected", "expired"]);

/** One approval as an Organization's approver sees it. */
export interface ApprovalForDecision {
  approval: Approval;
  /** The requester's display name — a colleague in the same Organization. */
  requesterName: string;
  /** Whether the reader asked for it, or may decide it for someone else. */
  readerIs: "requester" | "approver";
}

const STATUS_MAP: Record<
  ApprovalStatus,
  "PENDING" | "APPROVED" | "CONSUMED" | "REJECTED" | "EXPIRED"
> = {
  pending: "PENDING",
  approved: "APPROVED",
  consumed: "CONSUMED",
  rejected: "REJECTED",
  expired: "EXPIRED",
};

const REVERSE_STATUS_MAP: Record<
  "PENDING" | "APPROVED" | "CONSUMED" | "REJECTED" | "EXPIRED",
  ApprovalStatus
> = {
  PENDING: "pending",
  APPROVED: "approved",
  CONSUMED: "consumed",
  REJECTED: "rejected",
  EXPIRED: "expired",
};

function toApproval(row: {
  id: string;
  userId: string;
  agentId: string | null;
  conversationId: string | null;
  toolId: string;
  action: string;
  params: unknown;
  paramsHash: string | null;
  riskLevel: string | null;
  status: "PENDING" | "APPROVED" | "CONSUMED" | "REJECTED" | "EXPIRED";
  expiresAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  tenantId?: string | null;
  decidedById?: string | null;
}): Approval {
  return {
    id: row.id,
    userId: row.userId,
    agentId: row.agentId ?? undefined,
    conversationId: row.conversationId ?? undefined,
    toolId: row.toolId,
    action: row.action,
    params: row.params as Record<string, unknown>,
    paramsHash: row.paramsHash ?? undefined,
    riskLevel: row.riskLevel ?? undefined,
    status: REVERSE_STATUS_MAP[row.status],
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(row.tenantId ? { tenantId: row.tenantId } : {}),
    ...(row.decidedById ? { decidedById: row.decidedById } : {}),
  };
}

/** Internal sentinel: consumption denied with a precise, secret-free reason. */
class ConsumptionDenied extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

export class PrismaApprovalRepository implements IApprovalRepository {
  private readonly tenants: PrismaTenantRepository;
  /**
   * Phase 19.5 (S3) — seals a browser or desktop approval's exact parameters.
   * Absent: such an approval is never created, and one already stored is
   * read as its value-free record, which never runs.
   */
  private readonly sealer?: ApprovalParamsSealer;

  constructor(private prisma: PrismaClient, options: { sealer?: ApprovalParamsSealer } = {}) {
    this.tenants = new PrismaTenantRepository(prisma);
    this.sealer = options.sealer;
  }

  /**
   * An approval as every caller sees it. A browser or desktop approval's row
   * holds its value-free record; while its sealed parameters exist and
   * unseal to exactly what it was bound to (`paramsHash`), they are handed
   * back in its place, so confirming, re-checking and running it work as for
   * any approval. Otherwise — rejected, consumed, expired, no key, another
   * key, tampered — the record is what is read, and its hash never matches.
   */
  private present(row: Parameters<typeof toApproval>[0] & { sealedParams?: { sealed: string } | null }): Approval {
    const approval = toApproval(row);
    if (!sealsApprovalParams(approval.toolId)) return approval;
    const exact = this.unseal(row.sealedParams?.sealed, approval.paramsHash);
    return exact ? { ...approval, params: exact } : approval;
  }

  private unseal(sealed: string | undefined, paramsHash: string | undefined): Record<string, unknown> | null {
    if (!sealed || !paramsHash || !this.sealer) return null;
    try {
      const value: unknown = JSON.parse(this.sealer.unseal(sealed));
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const params = value as Record<string, unknown>;
      return computeParamsHash(params) === paramsHash ? params : null;
    } catch {
      return null;
    }
  }

  /**
   * Deletes an approval's sealed parameters once it can never run. Best
   * effort: one left behind is unreadable without the key and goes with the
   * next purge (`purgeExpiredSealedParams`).
   */
  private async forgetSealedParams(id: string): Promise<void> {
    await this.prisma.approvalSealedParams.deleteMany({ where: { approvalId: id } }).catch(() => undefined);
  }

  /**
   * Phase 19.5 — deletes the sealed parameters of every approval that can no
   * longer run: past its expiry, or consumed, rejected or expired. Returns
   * how many went. Safe to run on every instance at once.
   */
  async purgeExpiredSealedParams(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.approvalSealedParams.deleteMany({
      where: {
        OR: [{ expiresAt: { lte: now } }, { approval: { status: { in: ["CONSUMED", "REJECTED", "EXPIRED"] } } }],
      },
    });
    return result.count;
  }

  /**
   * Phase 17 — an approval for a WRITE through a shared connection
   * (`SHARED_CONNECTION_TOOLS`) belongs, from the moment it exists, to the
   * Organization that owns the connection: read here, from the owner record —
   * never from the caller, whatever `data` carries. Every creation path (the
   * executor's, a chat's pending action, a correction) arrives here, so none
   * can create one that skips it. With no owner on record nothing is created.
   */
  async create(
    data: Omit<Approval, "id" | "status" | "createdAt">
  ): Promise<Approval> {
    let tenantId: string | null = null;
    const shared = sharedConnectionOfTool(data.toolId);
    if (shared?.access === "write") {
      const owner = await this.tenants
        .findConnectorOwner(shared.connector.providerId, shared.connector.connector)
        .catch(() => null);
      if (!owner || owner.status !== "assigned") throw new SharedConnectionOwnerUnavailableError();
      tenantId = owner.tenantId;
    }

    // Phase 19.5 (S3) — a browser or desktop approval keeps its value-free
    // record; its exact parameters are sealed beside it, in the same write.
    // Nothing can seal them: nothing is created.
    let params: unknown = data.params;
    let sealed: string | null = null;
    if (sealsApprovalParams(data.toolId)) {
      const record = computerControlApprovalRecord(data.toolId, data.params);
      if (!record || !this.sealer) throw new ApprovalParamsSealingUnavailableError();
      try {
        sealed = this.sealer.seal(JSON.stringify(data.params));
      } catch {
        throw new ApprovalParamsSealingUnavailableError();
      }
      params = record;
    }

    const row = await this.prisma.approval.create({
      data: {
        userId: data.userId,
        agentId: data.agentId ?? null,
        conversationId: data.conversationId ?? null,
        toolId: data.toolId,
        action: data.action,
        params: params as Prisma.InputJsonValue,
        paramsHash: data.paramsHash ?? null,
        riskLevel: data.riskLevel ?? null,
        status: "PENDING",
        expiresAt: new Date(data.expiresAt),
        tenantId,
        ...(sealed !== null ? { sealedParams: { create: { sealed, expiresAt: new Date(data.expiresAt) } } } : {}),
      },
      include: WITH_SEALED,
    });

    // What earlier approvals left behind goes as new ones arrive.
    if (sealed !== null) await this.purgeExpiredSealedParams().catch(() => 0);
    return this.present(row);
  }

  async findById(id: string): Promise<Approval | null> {
    const row = await this.prisma.approval.findUnique({ where: { id }, include: WITH_SEALED });
    return row ? this.present(row) : null;
  }

  async updateStatus(
    id: string,
    status: ApprovalStatus,
    resolvedAt?: string
  ): Promise<Approval | null> {
    try {
      // CONSUMED is terminal (Phase 10.3): no path may resurrect an approval.
      // The conditional update only applies when the row is not CONSUMED.
      const result = await this.prisma.approval.updateMany({
        where: { id, status: { not: "CONSUMED" } },
        data: {
          status: STATUS_MAP[status],
          resolvedAt: resolvedAt ? new Date(resolvedAt) : new Date(),
        },
      });
      if (result.count === 0) return null;
      const updated = await this.findById(id);
      // Phase 19.5 — an approval that can never run keeps no sealed parameters.
      if (updated && SPENT.has(status) && sealsApprovalParams(updated.toolId)) {
        await this.forgetSealedParams(id);
        return await this.findById(id);
      }
      return updated;
    } catch {
      return null;
    }
  }

  async findPending(): Promise<Approval[]> {
    const rows = await this.prisma.approval.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      include: WITH_SEALED,
    });
    return rows.map((row) => this.present(row));
  }

  async findExistingForTool(
    toolId: string,
    userId: string
  ): Promise<Approval | null> {
    const row = await this.prisma.approval.findFirst({
      where: { toolId, userId },
      orderBy: { createdAt: "desc" },
      include: WITH_SEALED,
    });
    return row ? this.present(row) : null;
  }

  // -------------------------------------------------------------------------
  // PHASE 10.7 — production approval workflow primitives.
  // -------------------------------------------------------------------------

  /**
   * Paginated, user-scoped approval listing. A user can only ever see their
   * own approvals; `status` is an optional filter. Expired-but-unresolved
   * rows are reported as "expired" (computed at read time — expiry is a
   * fact about the clock, not a stored transition).
   */
  async listByUser(
    userId: string,
    options?: {
      status?: ApprovalStatus;
      page?: number;
      limit?: number;
    }
  ): Promise<{ items: Approval[]; total: number }> {
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
    const page = Math.max(options?.page ?? 1, 1);
    const now = new Date();

    const where: Record<string, unknown> = { userId };
    if (options?.status) {
      if (
        options.status === "expired"
      ) {
        where.status = { in: ["PENDING", "APPROVED"] };
        where.expiresAt = { lte: now };
      } else if (options.status === "pending" || options.status === "approved") {
        where.status = STATUS_MAP[options.status];
        where.expiresAt = { gt: now };
      } else {
        where.status = STATUS_MAP[options.status];
      }
    }

    const [rows, total] = await Promise.all([
      this.prisma.approval.findMany({
        where: where as never,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: WITH_SEALED,
      }),
      this.prisma.approval.count({ where: where as never }),
    ]);

    return {
      items: rows.map((row) => this.withEffectiveStatus(this.present(row), now)),
      total,
    };
  }

  /** Effective status: lazily reports expired PENDING/APPROVED as expired. */
  private withEffectiveStatus(approval: Approval, now: Date): Approval {
    if (
      (approval.status === "pending" || approval.status === "approved") &&
      new Date(approval.expiresAt).getTime() <= now.getTime()
    ) {
      return { ...approval, status: "expired" };
    }
    return approval;
  }

  async findByIdForUser(id: string, userId: string): Promise<Approval | null> {
    const row = await this.prisma.approval.findFirst({ where: { id, userId }, include: WITH_SEALED });
    return row ? this.withEffectiveStatus(this.present(row), new Date()) : null;
  }

  /**
   * Strict single-winner approval decision. Conditional UPDATE ... WHERE
   * status='PENDING' AND expiresAt > now AND userId matches: exactly one
   * concurrent caller transitions the row; every loser observes the new
   * state and is classified deterministically.
   *
   * `fromPendingOnly` (pending actions — the chat's Confirm / Cancel / Modify):
   * a reject, too, applies only while the approval is still PENDING. A
   * confirmed pending action is approved and run in the same request, so a
   * cancel arriving after the approval could never veto it — only contradict
   * it. Without the option a reject may still veto an approved approval that
   * has not been consumed (the Approvals page's documented behaviour).
   */
  async decideApproval(
    id: string,
    deciderId: string,
    decision: "approve" | "reject",
    options?: {
      now?: Date;
      fromPendingOnly?: boolean;
      /**
       * Phase 17 — the tenant roles that may approve an Organization's
       * approval for someone else (`rolesHoldingSharedPermission("shared:approve")`
       * in `@jarvis/security`). Absent or empty: nobody but the requester may
       * decide, and the requester may only withdraw.
       */
      approverRoles?: readonly TenantRole[];
    }
  ): Promise<
    | { outcome: "approved" | "rejected" }
    | { outcome: "not_found" }
    | { outcome: "forbidden" }
    | { outcome: "self_approval_forbidden" }
    | { outcome: "already_consumed" }
    | { outcome: "already_rejected"; idempotent: boolean }
    | { outcome: "expired" }
    | { outcome: "conflict"; currentState: string }
  > {
    const now = options?.now ?? new Date();

    const row = await this.prisma.approval.findUnique({ where: { id } });
    if (!row) return { outcome: "not_found" };

    // Phase 17 — who may decide. An ordinary approval: its requester, as
    // before. One that belongs to an Organization (`tenantId`): its requester
    // may only WITHDRAW it; approving it — or rejecting it for someone else —
    // is for one of that Organization's owners or admins who is not the
    // requester. That authority is checked here before anything about the
    // approval's state is told, and again, under a lock, in the transaction
    // that writes the decision.
    const shared = row.tenantId !== null;
    const byRequester = row.userId === deciderId;
    if (!byRequester && !shared) return { outcome: "forbidden" };
    if (shared && byRequester && decision === "approve") return { outcome: "self_approval_forbidden" };
    const asApprover = shared && !byRequester;
    const approverRoles: string[] = dbRoles(options?.approverRoles);
    if (asApprover) {
      if (approverRoles.length === 0) return { outcome: "forbidden" };
      const membership = await this.prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: row.tenantId!, userId: deciderId } },
        select: { role: true },
      });
      if (!membership || !approverRoles.includes(membership.role)) return { outcome: "forbidden" };
    }

    if (row.status === "CONSUMED") return { outcome: "already_consumed" };
    if (row.status === "REJECTED") {
      return decision === "reject"
        ? { outcome: "already_rejected", idempotent: true }
        : { outcome: "already_rejected", idempotent: false };
    }

    const expired =
      row.status === "EXPIRED" || row.expiresAt.getTime() <= now.getTime();
    if (decision === "approve") {
      if (row.status === "APPROVED") {
        return expired
          ? { outcome: "expired" }
          : { outcome: "conflict", currentState: "APPROVED" };
      }
      // PHASE 10.7 fix: an expired PENDING approval must classify as
      // deterministically EXPIRED (→ HTTP 410). Without this early return it
      // falls through to the conditional UPDATE (whose expiresAt > now guard
      // can never match), reaches the loser-classification path and is
      // misreported as CONFLICT/PENDING (→ 409) even though nobody raced.
      if (expired) return { outcome: "expired" };
    } else if (expired && row.status !== "APPROVED") {
      // Rejecting an already-expired pending approval is a no-op fact.
      return { outcome: "expired" };
    } else if (options?.fromPendingOnly && row.status === "APPROVED") {
      // Already confirmed: a pending action is no longer waiting to be cancelled.
      return { outcome: "conflict", currentState: "APPROVED" };
    }

    const target = decision === "approve" ? "APPROVED" : "REJECTED";
    const guardStates: ("PENDING" | "APPROVED")[] =
      decision === "approve" || options?.fromPendingOnly
        ? ["PENDING"]
        : ["PENDING", "APPROVED"]; // reject may still veto a not-yet-consumed approval

    // Plain columns only: the whole condition is one UPDATE, so of two
    // decisions arriving together exactly one changes the row.
    const where: Prisma.ApprovalWhereInput = {
      id,
      userId: row.userId,
      tenantId: row.tenantId,
      status: { in: guardStates },
      ...(decision === "approve" ? { expiresAt: { gt: now } } : {}),
    };
    const data: Prisma.ApprovalUpdateManyMutationInput = {
      status: target,
      resolvedAt: now,
      ...(asApprover ? { decidedById: deciderId } : {}),
    };

    let changed: number | "forbidden";
    if (asApprover) {
      // The approver's authority must still hold AS the decision is written:
      // the approval row is locked, the membership row read under a share
      // lock (an operator removing it waits for this to finish, or has
      // finished first and the row is gone), and only then is the row updated.
      changed = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Approval" WHERE "id" = ${id} FOR UPDATE`;
        const role = await this.roleIn(tx, row.tenantId!, deciderId);
        if (role === null || !approverRoles.includes(role)) return "forbidden" as const;
        return (await tx.approval.updateMany({ where, data })).count;
      });
    } else {
      changed = (await this.prisma.approval.updateMany({ where, data })).count;
    }

    if (changed === "forbidden") return { outcome: "forbidden" };
    if (changed === 1) {
      // Phase 19.5 — a rejected approval never runs: its sealed parameters go.
      // An approved one keeps them until its requester runs it.
      if (decision === "reject" && sealsApprovalParams(row.toolId)) await this.forgetSealedParams(id);
      return { outcome: decision === "approve" ? "approved" : "rejected" };
    }

    // Lost the race — re-read and classify the current durable state.
    const after = await this.prisma.approval.findUnique({ where: { id } });
    if (!after) return { outcome: "not_found" };
    if (after.status === "CONSUMED") return { outcome: "already_consumed" };
    if (after.status === "REJECTED") {
      return { outcome: "already_rejected", idempotent: false };
    }
    return {
      outcome: "conflict",
      currentState: after.status,
    };
  }

  /**
   * PHASE 10.3 — atomic one-time consumption paired with the execution claim.
   *
   * Single interactive transaction:
   *   1. UPDATE approval -> CONSUMED WHERE id/user/tool/paramsHash all match
   *      AND status='APPROVED' AND expiresAt > now. 0 rows => DENY (rollback).
   *   2. UPDATE execution -> EXECUTING (+lease) WHERE still claimable.
   *      0 rows => DENY (rollback; approval NOT burned).
   *
   * PostgreSQL row locks serialize concurrent consumers: exactly ONE caller
   * commits; every loser rolls back with zero side effects. A crash before
   * commit leaves the approval APPROVED (retry safe); a crash after commit
   * leaves it CONSUMED forever (never resurrected).
   *
   * Phase 17 — a write through a shared connection (`input.tenantScope`).
   * Before step 1, in the same transaction, the approval row is locked and
   * every condition of the scope is read under a share lock: the approval
   * belongs to that Organization, someone other than the requester decided
   * it, the Organization still owns the connection, the requester still holds
   * a role that may make the change and the approver one that may approve it.
   * An operator removing a membership or moving the connection waits for this
   * transaction, or finished first and the check fails: the write runs on the
   * state that holds as it is authorized, never on a remembered one. Without a
   * scope, an approval that belongs to an Organization is never consumed.
   */
  async consumeForExecution(
    input: ApprovalConsumptionInput,
    options?: { ownerId?: string; leaseMs?: number }
  ): Promise<ApprovalConsumptionResult> {
    const now = new Date();
    const scope = input.tenantScope;
    try {
      await this.prisma.$transaction(async (tx) => {
        if (scope) await this.assertSharedScope(tx, input, scope);

        const consumed = await tx.approval.updateMany({
          where: {
            id: input.approvalId,
            userId: input.userId,
            toolId: input.toolId,
            paramsHash: input.paramsHash, // NULL (legacy) never matches: fail closed
            status: "APPROVED",
            expiresAt: { gt: now },
            // An Organization's approval only WITH its scope, decided by
            // someone else; an ordinary one only without.
            tenantId: scope ? scope.tenantId : null,
            ...(scope ? { decidedById: { not: null }, NOT: [{ decidedById: input.userId }] } : {}),
          },
          data: { status: "CONSUMED", resolvedAt: now },
        });
        if (consumed.count !== 1) {
          throw new ConsumptionDenied(await this.denialReason(tx, input, now));
        }

        const claimed = await tx.toolExecution.updateMany({
          where: {
            executionId: input.executionId,
            status: { in: ["PENDING", "APPROVED", "FAILED"] },
          },
          data: {
            status: "EXECUTING",
            ownerId: options?.ownerId ?? `approval-${crypto.randomUUID()}`,
            leaseUntil: new Date(now.getTime() + (options?.leaseMs ?? DEFAULT_LEASE_MS)),
            heartbeatAt: now,
            startedAt: now,
            approvalId: input.approvalId,
          },
        });
        if (claimed.count !== 1) {
          throw new ConsumptionDenied("execution is not in a claimable state");
        }

        // Phase 19.5 — the parameters run from the caller's copy now; the
        // sealed one goes in the same transaction that spends the approval.
        if (sealsApprovalParams(input.toolId)) {
          await tx.approvalSealedParams.deleteMany({ where: { approvalId: input.approvalId } });
        }
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof ConsumptionDenied) {
        return { ok: false, reason: err.reason };
      }
      // Connection failure / transaction aborted: fail closed.
      return { ok: false, reason: "approval consumption unavailable" };
    }
  }

  /** Diagnostic-only reason lookup AFTER a failed consume (read-only). */
  private async denialReason(
    tx: Prisma.TransactionClient,
    input: ApprovalConsumptionInput,
    now: Date
  ): Promise<string> {
    const row = await tx.approval.findUnique({ where: { id: input.approvalId } });
    if (!row) return "approval not found";
    if (row.userId !== input.userId) return "approval belongs to a different user";
    if (row.toolId !== input.toolId) return "approval was issued for a different tool";
    if ((row.tenantId ?? null) !== (input.tenantScope?.tenantId ?? null)) {
      return row.tenantId
        ? "approval belongs to an organization and cannot be used without its checks"
        : "approval does not belong to this organization";
    }
    if (row.tenantId && (!row.decidedById || row.decidedById === input.userId)) {
      return "approval was not given by an independent approver";
    }
    if (!row.paramsHash || row.paramsHash !== input.paramsHash) {
      return "params hash mismatch (or legacy approval without hash)";
    }
    if (row.status === "CONSUMED") return "approval already consumed";
    if (row.status === "REJECTED") return "approval was rejected";
    if (row.status === "EXPIRED" || row.expiresAt <= now) return "approval has expired";
    return `approval is ${row.status.toLowerCase()}`;
  }

  /**
   * Phase 17 — every condition of a shared-connection write's scope, read
   * inside the consuming transaction: the approval row under FOR UPDATE, the
   * owner record and both memberships under FOR SHARE. Throws the reason —
   * secret-free, and about the requester's own approval — on the first one
   * that does not hold; the transaction then rolls back with nothing consumed.
   */
  private async assertSharedScope(
    tx: Prisma.TransactionClient,
    input: ApprovalConsumptionInput,
    scope: NonNullable<ApprovalConsumptionInput["tenantScope"]>
  ): Promise<void> {
    const requesterRoles: string[] = dbRoles(scope.requesterRoles);
    const approverRoles: string[] = dbRoles(scope.approverRoles);

    const rows = await tx.$queryRaw<Array<{ tenantId: string | null; decidedById: string | null }>>`
      SELECT "tenantId", "decidedById" FROM "Approval" WHERE "id" = ${input.approvalId} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new ConsumptionDenied("approval not found");
    if (row.tenantId !== scope.tenantId) {
      throw new ConsumptionDenied("approval does not belong to this organization");
    }
    if (!row.decidedById || row.decidedById === input.userId) {
      throw new ConsumptionDenied("approval was not given by an independent approver");
    }

    const owner = await tx.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS "one" FROM "AutomationConnectorOwner"
      WHERE "provider_id" = ${scope.providerId} AND "connector" = ${scope.connector} AND "tenant_id" = ${scope.tenantId}
      FOR SHARE`;
    if (owner.length === 0) {
      throw new ConsumptionDenied("the organization no longer owns this connection");
    }

    const requester = await this.roleIn(tx, scope.tenantId, input.userId);
    if (requester === null || !requesterRoles.includes(requester)) {
      throw new ConsumptionDenied("the requester's organization role no longer allows this change");
    }
    const approver = await this.roleIn(tx, scope.tenantId, row.decidedById);
    if (approver === null || !approverRoles.includes(approver)) {
      throw new ConsumptionDenied("the approver's organization role no longer allows approving this change");
    }
  }

  /** One membership's stored role, read under a share lock. Null: not a member. */
  private async roleIn(tx: Prisma.TransactionClient, tenantId: string, userId: string): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ role: string }>>`
      SELECT "role"::text AS "role" FROM "TenantMembership"
      WHERE "tenant_id" = ${tenantId} AND "user_id" = ${userId}
      FOR SHARE`;
    return rows[0]?.role ?? null;
  }

  // -------------------------------------------------------------------------
  // PHASE 11.9 — Conversation-scoped pending action lookups
  // -------------------------------------------------------------------------

  /**
   * The action waiting in a conversation: still PENDING — or, Phase 17, an
   * Organization's write that another owner or admin has APPROVED and that is
   * now waiting for its requester to run it. An ordinary approved approval is
   * never waiting: the requester's own confirm runs it at once.
   */
  async findPendingByConversationId(
    conversationId: string,
    userId: string
  ): Promise<Approval | null> {
    const now = new Date();
    const row = await this.prisma.approval.findFirst({
      where: {
        conversationId,
        userId,
        expiresAt: { gt: now },
        OR: [
          { status: "PENDING" },
          {
            status: "APPROVED",
            tenantId: { not: null },
            decidedById: { not: null },
            NOT: [{ decidedById: userId }],
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      include: WITH_SEALED,
    });
    return row ? this.present(row) : null;
  }

  // -------------------------------------------------------------------------
  // Phase 17 — what an Organization's approvers may see and decide
  // -------------------------------------------------------------------------

  /**
   * Approvals waiting for THIS account's decision: other members' writes,
   * pending and unexpired, in Organizations where this account holds one of
   * `approverRoles`. Never its own — those wait for someone else.
   */
  async listAwaitingDecision(
    userId: string,
    approverRoles: readonly TenantRole[],
    options?: { page?: number; limit?: number }
  ): Promise<{ items: ApprovalForDecision[]; total: number }> {
    const roles = dbRoles(approverRoles);
    if (roles.length === 0) return { items: [], total: 0 };
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
    const page = Math.max(options?.page ?? 1, 1);
    const now = new Date();

    const where: Prisma.ApprovalWhereInput = {
      tenantId: { not: null },
      userId: { not: userId },
      status: "PENDING",
      expiresAt: { gt: now },
      tenant: { memberships: { some: { userId, role: { in: roles } } } },
    };
    const [rows, total] = await Promise.all([
      this.prisma.approval.findMany({
        where,
        include: { user: { select: { name: true } }, ...WITH_SEALED },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.approval.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        approval: this.withEffectiveStatus(this.present(row), now),
        requesterName: row.user.name,
        readerIs: "approver" as const,
      })),
      total,
    };
  }

  /**
   * One approval, for an account that may see it: its requester, or — for an
   * Organization's approval — one of that Organization's approvers. Anyone
   * else gets null, exactly as for an approval that does not exist.
   */
  async findByIdForDecider(
    id: string,
    userId: string,
    approverRoles: readonly TenantRole[]
  ): Promise<ApprovalForDecision | null> {
    const row = await this.prisma.approval.findUnique({
      where: { id },
      include: { user: { select: { name: true } }, ...WITH_SEALED },
    });
    if (!row) return null;
    const approval = this.withEffectiveStatus(this.present(row), new Date());
    if (row.userId === userId) return { approval, requesterName: row.user.name, readerIs: "requester" };
    if (!row.tenantId) return null;
    const roles: string[] = dbRoles(approverRoles);
    if (roles.length === 0) return null;
    const membership = await this.prisma.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId: row.tenantId, userId } },
      select: { role: true },
    });
    if (!membership || !roles.includes(membership.role)) return null;
    return { approval, requesterName: row.user.name, readerIs: "approver" };
  }

  async updateParams(
    id: string,
    params: Record<string, unknown>,
    paramsHash: string
  ): Promise<Approval | null> {
    try {
      // Phase 19.5 — new parameters for a browser or desktop approval are
      // sealed like the first ones, in one transaction with the record.
      const current = await this.prisma.approval.findUnique({ where: { id }, select: { toolId: true, expiresAt: true } });
      if (current && sealsApprovalParams(current.toolId)) {
        const record = computerControlApprovalRecord(current.toolId, params);
        if (!record || !this.sealer) return null;
        const sealed = this.sealer.seal(JSON.stringify(params));
        const changed = await this.prisma.$transaction(async (tx) => {
          const result = await tx.approval.updateMany({
            where: { id, status: "PENDING" },
            data: { params: record as Prisma.InputJsonValue, paramsHash },
          });
          if (result.count === 0) return 0;
          await tx.approvalSealedParams.upsert({
            where: { approvalId: id },
            create: { approvalId: id, sealed, expiresAt: current.expiresAt },
            update: { sealed },
          });
          return result.count;
        });
        return changed === 0 ? null : await this.findById(id);
      }

      const result = await this.prisma.approval.updateMany({
        where: { id, status: "PENDING" },
        data: {
          params: params as unknown as Prisma.InputJsonValue,
          paramsHash,
        },
      });
      if (result.count === 0) return null;
      return await this.findById(id);
    } catch {
      return null;
    }
  }
}
