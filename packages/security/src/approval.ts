import type {
  Approval,
  ApprovalStatus,
  IApprovalRepository,
  IApprovalManager,
} from "@jarvis/core";
import { computeParamsHash } from "@jarvis/core";

export class ApprovalService implements IApprovalManager {
  constructor(private repository: IApprovalRepository) {}

  async requestApproval(
    request: Omit<Approval, "id" | "status" | "createdAt">
  ): Promise<Approval> {
    // Bind the approval to the exact approved parameters. The canonical
    // representation is hashed and never logged; only the digest is stored.
    const withHash = {
      ...request,
      paramsHash: computeParamsHash(request.params),
    };
    const approval = await this.repository.create(withHash);
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

  /**
   * Phase 11.6A — every candidate approval for (toolId, userId), newest
   * first. Backed by the repository's user-scoped listing; enables the
   * executor to pick the approval that actually binds to the current
   * params instead of a single latest-row lookup.
   */
  async findApprovalsForTool(
    toolId: string,
    userId: string
  ): Promise<Approval[]> {
    if (!this.repository.listByUser) {
      // Repository without listing support: degrade to the single latest
      // candidate so callers keep their previous semantics.
      const existing = await this.findExistingForTool(toolId, userId);
      return existing ? [existing] : [];
    }
    const { items } = await this.repository.listByUser(userId, { limit: 100 });
    return items.filter((a) => a.toolId === toolId);
  }
}
