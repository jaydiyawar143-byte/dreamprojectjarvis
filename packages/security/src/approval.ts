interface Approval {
  id: string;
  userId: string;
  agentId: string;
  toolId: string;
  action: string;
  params: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  expiresAt: Date;
  resolvedAt?: Date;
  createdAt: Date;
}

export class ApprovalService {
  private pendingApprovals: Map<string, Approval> = new Map();

  async requestApproval(
    request: Omit<Approval, "id" | "status" | "createdAt">
  ): Promise<Approval> {
    const approval: Approval = {
      ...request,
      id: crypto.randomUUID(),
      status: "pending",
      createdAt: new Date(),
    };

    this.pendingApprovals.set(approval.id, approval);

    // In production: persist to DB, send notification
    console.log("[APPROVAL] New approval request:", approval.id);

    return approval;
  }

  async approve(approvalId: string): Promise<Approval | null> {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval || approval.status !== "pending") return null;

    approval.status = "approved";
    approval.resolvedAt = new Date();
    this.pendingApprovals.delete(approvalId);

    return approval;
  }

  async reject(approvalId: string): Promise<Approval | null> {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval || approval.status !== "pending") return null;

    approval.status = "rejected";
    approval.resolvedAt = new Date();
    this.pendingApprovals.delete(approvalId);

    return approval;
  }

  async getPending(): Promise<Approval[]> {
    return Array.from(this.pendingApprovals.values()).filter(
      (a) => a.status === "pending"
    );
  }
}

export const approvalService = new ApprovalService();
