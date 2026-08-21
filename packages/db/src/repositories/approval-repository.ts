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
