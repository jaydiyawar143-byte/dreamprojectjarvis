import type {
  Approval,
  ApprovalStatus,
  IApprovalRepository,
  ApprovalConsumptionInput,
  ApprovalConsumptionResult,
} from "@jarvis/core";
import { DEFAULT_LEASE_MS } from "@jarvis/core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

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
  toolId: string;
  action: string;
  params: unknown;
  paramsHash: string | null;
  status: "PENDING" | "APPROVED" | "CONSUMED" | "REJECTED" | "EXPIRED";
  expiresAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
}): Approval {
  return {
    id: row.id,
    userId: row.userId,
    agentId: row.agentId ?? undefined,
    toolId: row.toolId,
    action: row.action,
    params: row.params as Record<string, unknown>,
    paramsHash: row.paramsHash ?? undefined,
    status: REVERSE_STATUS_MAP[row.status],
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Internal sentinel: consumption denied with a precise, secret-free reason. */
class ConsumptionDenied extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

export class PrismaApprovalRepository implements IApprovalRepository {
  constructor(private prisma: PrismaClient) {}

  async create(
    data: Omit<Approval, "id" | "status" | "createdAt">
  ): Promise<Approval> {
    const row = await this.prisma.approval.create({
      data: {
        userId: data.userId,
        agentId: data.agentId ?? null,
        toolId: data.toolId,
        action: data.action,
        params: data.params as unknown as Prisma.InputJsonValue,
        paramsHash: data.paramsHash ?? null,
        status: "PENDING",
        expiresAt: new Date(data.expiresAt),
      },
    });

    return toApproval(row);
  }

  async findById(id: string): Promise<Approval | null> {
    const row = await this.prisma.approval.findUnique({ where: { id } });
    return row ? toApproval(row) : null;
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
      return await this.findById(id);
    } catch {
      return null;
    }
  }

  async findPending(): Promise<Approval[]> {
    const rows = await this.prisma.approval.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toApproval);
  }

  async findExistingForTool(
    toolId: string,
    userId: string
  ): Promise<Approval | null> {
    const row = await this.prisma.approval.findFirst({
      where: { toolId, userId },
      orderBy: { createdAt: "desc" },
    });
    return row ? toApproval(row) : null;
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
      }),
      this.prisma.approval.count({ where: where as never }),
    ]);

    return {
      items: rows.map((row) => this.withEffectiveStatus(toApproval(row), now)),
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
    const row = await this.prisma.approval.findFirst({ where: { id, userId } });
    return row ? this.withEffectiveStatus(toApproval(row), new Date()) : null;
  }

  /**
   * Strict single-winner approval decision. Conditional UPDATE ... WHERE
   * status='PENDING' AND expiresAt > now AND userId matches: exactly one
   * concurrent caller transitions the row; every loser observes the new
   * state and is classified deterministically.
   */
  async decideApproval(
    id: string,
    userId: string,
    decision: "approve" | "reject",
    options?: { now?: Date }
  ): Promise<
    | { outcome: "approved" | "rejected" }
    | { outcome: "not_found" }
    | { outcome: "forbidden" }
    | { outcome: "already_consumed" }
    | { outcome: "already_rejected"; idempotent: boolean }
    | { outcome: "expired" }
    | { outcome: "conflict"; currentState: string }
  > {
    const now = options?.now ?? new Date();

    const row = await this.prisma.approval.findUnique({ where: { id } });
    if (!row) return { outcome: "not_found" };
    if (row.userId !== userId) return { outcome: "forbidden" };

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
    }

    const target = decision === "approve" ? "APPROVED" : "REJECTED";
    const guardStates: ("PENDING" | "APPROVED")[] =
      decision === "approve"
        ? ["PENDING"]
        : ["PENDING", "APPROVED"]; // reject may still veto a not-yet-consumed approval

    const result = await this.prisma.approval.updateMany({
      where: {
        id,
        userId,
        status: { in: guardStates },
        ...(decision === "approve" ? { expiresAt: { gt: now } } : {}),
      },
      data: { status: target, resolvedAt: now },
    });

    if (result.count === 1) {
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
   */
  async consumeForExecution(
    input: ApprovalConsumptionInput,
    options?: { ownerId?: string; leaseMs?: number }
  ): Promise<ApprovalConsumptionResult> {
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const consumed = await tx.approval.updateMany({
          where: {
            id: input.approvalId,
            userId: input.userId,
            toolId: input.toolId,
            paramsHash: input.paramsHash, // NULL (legacy) never matches: fail closed
            status: "APPROVED",
            expiresAt: { gt: now },
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
    if (!row.paramsHash || row.paramsHash !== input.paramsHash) {
      return "params hash mismatch (or legacy approval without hash)";
    }
    if (row.status === "CONSUMED") return "approval already consumed";
    if (row.status === "REJECTED") return "approval was rejected";
    if (row.status === "EXPIRED" || row.expiresAt <= now) return "approval has expired";
    return `approval is ${row.status.toLowerCase()}`;
  }
}
