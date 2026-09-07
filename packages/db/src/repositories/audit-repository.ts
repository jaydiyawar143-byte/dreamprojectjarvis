import type {
  AuditEntry,
  AuditQueryFilters,
  IAuditRepository,
} from "@jarvis/core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

/**
 * Sprint 9.5 — hard ceiling on one audit query.
 *
 * Set far above the loosest rate limit (120/min) so a bounded page can never
 * cause a limiter to allow a request it should have refused.
 */
export const AUDIT_QUERY_MAX_ROWS = 1000;

const RESULT_MAP: Record<AuditEntry["result"], "SUCCESS" | "FAILURE" | "REJECTED" | "PENDING"> = {
  success: "SUCCESS",
  failure: "FAILURE",
  rejected: "REJECTED",
  pending: "PENDING",
};

const REVERSE_RESULT_MAP: Record<"SUCCESS" | "FAILURE" | "REJECTED" | "PENDING", AuditEntry["result"]> = {
  SUCCESS: "success",
  FAILURE: "failure",
  REJECTED: "rejected",
  PENDING: "pending",
};

function toAuditEntry(row: {
  id: string;
  userId: string;
  agentId: string | null;
  toolId: string | null;
  action: string;
  parameters: unknown;
  result: "SUCCESS" | "FAILURE" | "REJECTED" | "PENDING";
  traceId: string | null;
  ipAddress: string | null;
  metadata: unknown;
  createdAt: Date;
}): AuditEntry {
  return {
    id: row.id,
    timestamp: row.createdAt,
    userId: row.userId,
    agentId: row.agentId ?? undefined,
    toolId: row.toolId ?? undefined,
    action: row.action,
    parameters: (row.parameters as Record<string, unknown>) ?? {},
    result: REVERSE_RESULT_MAP[row.result],
    traceId: row.traceId ?? undefined,
    ipAddress: row.ipAddress ?? undefined,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

export class PrismaAuditRepository implements IAuditRepository {
  constructor(private prisma: PrismaClient) {}

  async create(
    entry: Omit<AuditEntry, "id" | "timestamp">
  ): Promise<AuditEntry> {
    const row = await this.prisma.auditLog.create({
      data: {
        userId: entry.userId,
        agentId: entry.agentId ?? null,
        toolId: entry.toolId ?? null,
        action: entry.action,
        parameters: entry.parameters as unknown as Prisma.InputJsonValue ?? undefined,
        result: RESULT_MAP[entry.result],
        traceId: entry.traceId ?? null,
        ipAddress: entry.ipAddress ?? null,
        metadata: entry.metadata as unknown as Prisma.InputJsonValue ?? undefined,
      },
    });

    return toAuditEntry(row);
  }

  async query(filters: AuditQueryFilters): Promise<AuditEntry[]> {
    const where: Record<string, unknown> = {};

    if (filters.userId) where.userId = filters.userId;
    if (filters.agentId) where.agentId = filters.agentId;
    if (filters.toolId) where.toolId = filters.toolId;
    if (filters.startDate || filters.endDate) {
      where.createdAt = {
        ...(filters.startDate && { gte: filters.startDate }),
        ...(filters.endDate && { lte: filters.endDate }),
      };
    }

    // Sprint 9.5 — bounded. This query backs the rate limiter, which counts a
    // user's rows inside a window; unbounded, a user with heavy audit volume
    // materialised their whole history into memory on every request they made,
    // so the limiter degraded exactly for the accounts it most needed to bound.
    //
    // The cap sits far above every real limit (the loosest is 120/min), so a
    // truncated page can only ever UNDER-count, which fails toward refusing a
    // request rather than allowing one past the limit.
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(filters.limit ?? AUDIT_QUERY_MAX_ROWS, AUDIT_QUERY_MAX_ROWS),
    });

    return rows.map(toAuditEntry);
  }
}
