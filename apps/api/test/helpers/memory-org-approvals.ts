// ---------------------------------------------------------------------------
// An approval store in memory, with the Phase 17 Organization rules the real
// one (`PrismaApprovalRepository`) enforces in PostgreSQL:
//
//   create   an approval for a write through a shared connection
//            (`SHARED_CONNECTION_TOOLS`) belongs to the Organization that owns
//            the connection, read from the owner record — never from the
//            caller. With no owner on record, nothing is created.
//   decide   an Organization's approval is decided by one of its owners or
//            admins who is NOT the requester (`self_approval_forbidden`).
//   consume  only with the matching `tenantScope`, while the Organization
//            still owns the connection, the requester still holds a requester
//            role, and the approver an approver role — and only once.
//
// The PostgreSQL suites pin the real store; this lets the API tests run the
// whole proposal pipeline without a database.
// ---------------------------------------------------------------------------

import {
  sharedConnectionOfTool,
  type Approval,
  type ApprovalConsumptionInput,
  type ApprovalConsumptionResult,
  type ApprovalStatus,
  type IApprovalRepository,
} from "@jarvis/core";
import type { MemoryTenancy } from "./shared-access.js";

export class MemoryOrgApprovals implements IApprovalRepository {
  readonly rows = new Map<string, Approval>();
  private seq = 0;
  now: () => number = () => Date.now();

  constructor(private readonly tenancy: MemoryTenancy) {}

  private effective(row: Approval): Approval {
    const live = row.status === "pending" || row.status === "approved";
    return live && new Date(row.expiresAt).getTime() <= this.now() ? { ...row, status: "expired" } : { ...row };
  }

  async create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval> {
    let tenantId: string | undefined;
    const shared = sharedConnectionOfTool(data.toolId);
    if (shared?.access === "write") {
      const owner = await this.tenancy.findConnectorOwner(shared.connector.providerId, shared.connector.connector);
      if (owner.status !== "assigned") throw new Error("the connection has no owner on record");
      tenantId = owner.tenantId;
    }
    const id = `apr_${String(++this.seq).padStart(4, "0")}`;
    const row: Approval = {
      ...data,
      id,
      status: "pending",
      createdAt: new Date(this.now() + this.seq).toISOString(),
      ...(tenantId ? { tenantId } : {}),
    };
    this.rows.set(id, row);
    return { ...row };
  }

  async findById(id: string): Promise<Approval | null> {
    const row = this.rows.get(id);
    return row ? this.effective(row) : null;
  }

  async findByIdForUser(id: string, userId: string): Promise<Approval | null> {
    const row = this.rows.get(id);
    return row && row.userId === userId ? this.effective(row) : null;
  }

  async updateStatus(id: string, status: ApprovalStatus): Promise<Approval | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    row.status = status;
    return { ...row };
  }

  async findPending(): Promise<Approval[]> {
    return [...this.rows.values()].map((r) => this.effective(r)).filter((r) => r.status === "pending");
  }

  private newestFirst(userId: string): Approval[] {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .map((row) => this.effective(row))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findExistingForTool(toolId: string, userId: string): Promise<Approval | null> {
    return this.newestFirst(userId).find((row) => row.toolId === toolId) ?? null;
  }

  async listByUser(userId: string, options?: { status?: ApprovalStatus; limit?: number }): Promise<{ items: Approval[]; total: number }> {
    const all = this.newestFirst(userId).filter((row) => !options?.status || row.status === options.status);
    return { items: all.slice(0, options?.limit ?? 20), total: all.length };
  }

  /** The decision a person makes on the Approvals page — with the Organization rule. */
  async decide(id: string, deciderId: string, decision: "approved" | "rejected"): Promise<"ok" | "self_approval_forbidden" | "not_an_approver" | "not_waiting"> {
    const row = this.rows.get(id);
    if (!row || this.effective(row).status !== "pending") return "not_waiting";
    if (row.tenantId) {
      if (decision === "approved" && deciderId === row.userId) return "self_approval_forbidden";
      const membership = await this.tenancy.findMembership(deciderId, row.tenantId);
      if (deciderId !== row.userId && (!membership || !["owner", "admin"].includes(membership.role))) return "not_an_approver";
      if (deciderId !== row.userId) row.decidedById = deciderId;
    }
    row.status = decision;
    row.resolvedAt = new Date(this.now()).toISOString();
    return "ok";
  }

  async consumeForExecution(input: ApprovalConsumptionInput): Promise<ApprovalConsumptionResult> {
    // Everything the checks need is read FIRST; the checks and the write then
    // run with no await between them — as atomic as the real store's one
    // conditional UPDATE, so of two consumptions exactly one wins.
    const scope = input.tenantScope;
    const pre = this.rows.get(input.approvalId);
    const owner = scope ? await this.tenancy.findConnectorOwner(scope.providerId, scope.connector) : null;
    const requester = scope ? await this.tenancy.findMembership(input.userId, scope.tenantId) : null;
    const approver = scope && pre?.decidedById ? await this.tenancy.findMembership(pre.decidedById, scope.tenantId) : null;
    const row = this.rows.get(input.approvalId);
    if (!row) return { ok: false, reason: "approval not found" };
    if (row.userId !== input.userId) return { ok: false, reason: "approval belongs to a different user" };
    if (row.toolId !== input.toolId) return { ok: false, reason: "approval was issued for a different tool" };
    if (!row.paramsHash || row.paramsHash !== input.paramsHash) return { ok: false, reason: "params hash mismatch" };
    if (row.status === "consumed") return { ok: false, reason: "approval already consumed" };
    if (row.status !== "approved") return { ok: false, reason: `approval is ${row.status}` };
    if (new Date(row.expiresAt).getTime() <= this.now()) return { ok: false, reason: "approval has expired" };
    if ((row.tenantId ?? null) !== (input.tenantScope?.tenantId ?? null)) return { ok: false, reason: "approval belongs to another organization" };
    if (row.tenantId && scope) {
      if (!row.decidedById || row.decidedById === input.userId) return { ok: false, reason: "approval was not decided by an independent approver" };
      if (!owner || owner.status !== "assigned" || owner.tenantId !== scope.tenantId) return { ok: false, reason: "the organization no longer owns the connection" };
      if (!requester || !scope.requesterRoles.includes(requester.role)) return { ok: false, reason: "the requester's role changed" };
      if (!approver || !scope.approverRoles.includes(approver.role)) return { ok: false, reason: "the approver's role changed" };
    }
    row.status = "consumed";
    return { ok: true };
  }

  status(id: string): ApprovalStatus | undefined {
    return this.rows.get(id)?.status;
  }
}
