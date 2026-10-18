// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening (review finding H2) — what the screens say
// about a change to an Organization's shared connection.
//
//   • The approval card offers Approve only where the server says this reader
//     may approve (`canApprove`); its requester sees who it waits for and can
//     withdraw it. A refusal the server still gives is explained, not hidden.
//   • The Approvals page lists the changes waiting for this reader's decision
//     (`scope=review`) — and says so when that list cannot be read.
//   • The chat card says the change waits for another owner or admin, and a
//     Confirm the server refuses for that reason leaves it waiting.
//
// None of this is the boundary — the approval store refuses a self-approval
// whatever a client sends (packages/db shared-connection approvals tests).
// lib/api is mocked: no network.
// ---------------------------------------------------------------------------

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    listApprovals: vi.fn(),
    approveApproval: vi.fn(),
    rejectApproval: vi.fn(),
    confirmPendingAction: vi.fn(),
    rejectPendingActionApi: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import type { ApprovalRecord } from "../src/lib/api";
import { ApprovalCard } from "../src/components/approval-card";
import ApprovalsPage from "../src/app/approvals/page";
import { PendingActionCard, type PendingActionData } from "../src/components/pending-action-card";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();
const page = (data: ApprovalRecord[]) => ({
  success: true,
  data,
  pagination: { page: 1, limit: 20, total: data.length, totalPages: 1 },
  timestamp: ts(),
});

function approval(over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalId: "appr-org-0001",
    toolId: "meta.campaign.pause",
    paramsHash: "hash-1",
    status: "pending",
    createdAt: ts(),
    expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    params: { campaignId: "c-1" },
    actionSummary: "Pause Meta campaign c-1.",
    detailLines: [],
    needsIndependentApproval: true,
    canApprove: false,
    decidedByAnother: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the approval card — Approve only where the server allows it", () => {
  it("shows its requester who it waits for, with Withdraw and no Approve", async () => {
    mocked.rejectApproval.mockResolvedValue({ success: true, data: { approvalId: "appr-org-0001", status: "rejected" }, timestamp: ts() });
    render(<ApprovalCard approval={approval()} />);

    expect(screen.queryByTestId("approve-button")).toBeNull();
    expect(screen.getByTestId("approval-waiting-for-another").textContent).toMatch(/another owner or admin/);
    const withdraw = screen.getByTestId("reject-button");
    expect(withdraw.textContent).toBe("Withdraw");

    fireEvent.click(withdraw);
    await waitFor(() => expect(screen.getByTestId("approval-card").dataset.state).toBe("rejected"));
    expect(mocked.rejectApproval).toHaveBeenCalledWith("appr-org-0001");
    expect(mocked.approveApproval).not.toHaveBeenCalled();
  });

  it("offers an approver Approve, names who asked, and says the requester runs it", async () => {
    mocked.approveApproval.mockResolvedValue({ success: true, data: { approvalId: "appr-org-0001", status: "approved" }, timestamp: ts() });
    render(<ApprovalCard approval={approval({ canApprove: true, requestedBy: "Riya" })} />);

    expect(screen.getByTestId("approval-requested-by").textContent).toBe("Riya");
    expect(screen.queryByTestId("approval-waiting-for-another")).toBeNull();
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() =>
      expect(screen.getByTestId("approval-message").textContent).toMatch(/person who asked for it may now run/)
    );
    expect(mocked.approveApproval).toHaveBeenCalledWith("appr-org-0001");
  });

  it("explains the server's refusal of a self-approval rather than a generic failure", async () => {
    // A card rendered from stale data still offers Approve; the server refuses.
    mocked.approveApproval.mockResolvedValue({
      success: false,
      error: { code: "APPROVAL_SELF_APPROVAL_FORBIDDEN", message: "refused" },
      timestamp: ts(),
    });
    render(<ApprovalCard approval={approval({ canApprove: true })} />);
    fireEvent.click(screen.getByTestId("approve-button"));

    await waitFor(() =>
      expect(screen.getByTestId("approval-message").textContent).toMatch(/approved by another owner or admin of your organization/)
    );
    expect(screen.getByTestId("approval-card").dataset.state).toBe("error");
  });

  it("says an approved change was approved by someone else, and offers no decision", () => {
    render(<ApprovalCard approval={approval({ status: "approved", decidedByAnother: true })} />);
    expect(screen.getByTestId("approval-approved-by-another")).toBeTruthy();
    expect(screen.queryByTestId("approve-button")).toBeNull();
    expect(screen.queryByTestId("reject-button")).toBeNull();
  });

  it("keeps Approve for an ordinary approval, which its own requester decides", () => {
    render(<ApprovalCard approval={approval({ toolId: "whatsapp.send", needsIndependentApproval: false, canApprove: true })} />);
    expect(screen.getByTestId("approve-button")).toBeTruthy();
    expect(screen.getByTestId("reject-button").textContent).toBe("Reject");
  });
});

describe("the Approvals page — what waits for this reader", () => {
  it("lists the changes waiting for this reader's decision above their own", async () => {
    mocked.listApprovals.mockImplementation(async (_status, _page, _limit, scope) =>
      scope === "review"
        ? page([approval({ approvalId: "appr-review-01", canApprove: true, requestedBy: "Riya" })])
        : page([approval({ approvalId: "appr-mine-0001", toolId: "meta.ad.pause" })])
    );
    render(<ApprovalsPage />);

    const review = await screen.findByTestId("approvals-review");
    expect(review.textContent).toMatch(/Waiting for your decision/);
    expect(review.textContent).toMatch(/Riya/);
    expect(mocked.listApprovals).toHaveBeenCalledWith(undefined, 1, 20, "review");
    await waitFor(() => expect(screen.getAllByTestId("approval-card")).toHaveLength(2));
  });

  it("shows no such section to an account that is nobody's approver", async () => {
    mocked.listApprovals.mockResolvedValue(page([]));
    render(<ApprovalsPage />);
    await screen.findByTestId("approvals-empty");
    expect(screen.queryByTestId("approvals-review")).toBeNull();
  });

  it("says so when that list cannot be read, instead of showing nothing waiting", async () => {
    mocked.listApprovals.mockImplementation(async (_status, _page, _limit, scope) =>
      scope === "review"
        ? { success: false, error: { code: "APPROVAL_INVALID_QUERY", message: "Invalid list query parameters" }, timestamp: ts() }
        : page([])
    );
    render(<ApprovalsPage />);
    expect((await screen.findByTestId("approvals-review-error")).textContent).toMatch(/Invalid list query/);
  });
});

describe("the chat card — a change that waits for another owner or admin", () => {
  const pending = (over: Partial<PendingActionData> = {}): PendingActionData => ({
    id: "pa-17",
    toolId: "meta.campaign.pause",
    action: "meta.campaign.pause",
    params: { campaignId: "c-1" },
    riskLevel: "EXTERNAL_SIDE_EFFECT",
    state: "WAITING_CONFIRMATION",
    approvalId: "pa-17",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    needsIndependentApproval: true,
    ...over,
  });

  it("says who it waits for before anything is pressed", () => {
    render(<PendingActionCard pendingAction={pending()} conversationId="conv-1" />);
    expect(screen.getByTestId("pending-action-needs-approver").textContent).toMatch(/another owner or admin/);
    expect(screen.getByTestId("confirm-button")).toBeTruthy();
  });

  it("stays waiting — not failed — when Confirm comes before the approval", async () => {
    mocked.confirmPendingAction.mockResolvedValue({
      success: false,
      error: {
        code: "PENDING_ACTION_NEEDS_INDEPENDENT_APPROVAL",
        message: "This change needs approval from another owner or admin of your organization, so it was not run.",
      },
      timestamp: ts(),
    });
    render(<PendingActionCard pendingAction={pending()} conversationId="conv-1" />);
    fireEvent.click(screen.getByTestId("confirm-button"));

    await waitFor(() => expect(screen.getByTestId("pending-action-message").textContent).toMatch(/so it was not run/));
    expect(screen.getByTestId("pending-action-card").getAttribute("data-state")).toBe("PENDING_APPROVAL");
    expect(screen.getByTestId("confirm-button")).toBeTruthy();
    expect(screen.queryByTestId("retry-button")).toBeNull();
  });

  it("says nothing of the kind for an ordinary change", () => {
    render(<PendingActionCard pendingAction={pending({ toolId: "whatsapp.send", needsIndependentApproval: undefined })} conversationId="conv-1" />);
    expect(screen.queryByTestId("pending-action-needs-approver")).toBeNull();
  });
});
