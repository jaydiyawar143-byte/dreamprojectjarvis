import type {
  Approval,
  ApprovalStatus,
  IApprovalRepository,
  IApprovalManager,
} from "@jarvis/core";

export class ApprovalService implements IApprovalManager {
  constructor(private repository: IApprovalRepository) {}

  async requestApproval(
    request: Omit<Approval, "id" | "status" | "createdAt">
  ): Promise<Approval> {
    const approval = await this.repository.create(request);
    console.log("[APPROVAL] New approval request:", approval.id);
    return approval;
  }

  async approve(approvalId: string): Promise<Approval | null> {
    const existing = await this.repository.findById(approvalId);
    if (!existing || existing.status !== "pending") return null;

    const updated = await this.repository.updateStatus(
      approvalId,
      "approved" as ApprovalStatus
    );

    console.log("[APPROVAL] Approved:", approvalId);
    return updated;
  }

  async reject(approvalId: string): Promise<Approval | null> {
    const existing = await this.repository.findById(approvalId);
    if (!existing || existing.status !== "pending") return null;

    const updated = await this.repository.updateStatus(
      approvalId,
      "rejected" as ApprovalStatus
    );

    console.log("[APPROVAL] Rejected:", approvalId);
    return updated;
  }

  async getPending(): Promise<Approval[]> {
    return this.repository.findPending();
  }

  async findExistingForTool(
    toolId: string,
    userId: string
  ): Promise<Approval | null> {
    return this.repository.findExistingForTool(toolId, userId);
  }
}
