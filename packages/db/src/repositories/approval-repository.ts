import type {
  Approval,
  ApprovalStatus,
  IApprovalRepository,
} from "@jarvis/core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

const STATUS_MAP: Record<ApprovalStatus, "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED"> = {
  pending: "PENDING",
  approved: "APPROVED",
  rejected: "REJECTED",
  expired: "EXPIRED",
};

const REVERSE_STATUS_MAP: Record<"PENDING" | "APPROVED" | "REJECTED" | "EXPIRED", ApprovalStatus> = {
  PENDING: "pending",
  APPROVED: "approved",
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
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
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
    status: REVERSE_STATUS_MAP[row.status],
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
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
      const row = await this.prisma.approval.update({
        where: { id },
        data: {
          status: STATUS_MAP[status],
          resolvedAt: resolvedAt ? new Date(resolvedAt) : new Date(),
        },
      });
      return toApproval(row);
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
}
