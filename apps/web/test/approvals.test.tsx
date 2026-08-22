// PHASE 10.7 — Approval UI state coverage (spec items 31–35):
// pending render, approve success, conflict, expired, reject.
// lib/api is mocked — no network, no tokens, no secrets in the bundle.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ApprovalCard } from "../src/components/approval-card";
import ApprovalsPage from "../src/app/approvals/page";
import type { ApprovalRecord } from "../src/lib/api";
import * as api from "../src/lib/api";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>(
    "../src/lib/api"
  );
  return {
    ...actual,
    listApprovals: vi.fn(),
    getApproval: vi.fn(),
    approveApproval: vi.fn(),
    rejectApproval: vi.fn(),
  };
});

const mockedApi = vi.mocked(api);

function makeApproval(overrides?: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    approvalId: "appr00000001abcdef",
    toolId: "meta.campaign.create",
    paramsHash: "hash123",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
    params: { accountId: "act_111111111", name: "Summer Launch", dailyBudget: 25 },
    actionSummary:
      'Create Meta campaign "Summer Launch" with objective OUTCOME_TRAFFIC and daily budget $25.00.',
    accountRedacted: "act_111••••1111",
    budget: "daily budget $25.00",
    targetResource: "Summer Launch",
    detailLines: [{ label: "objective", value: "OUTCOME_TRAFFIC" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ApprovalCard states (31–35)", () => {
  it("31. renders a PENDING approval with full context and both actions", async () => {
    render(<ApprovalCard approval={makeApproval()} />);
    expect(screen.getByTestId("approval-summary").textContent).toContain(
      "Create Meta campaign"
    );
    expect(screen.getByTestId("approval-account").textContent).toBe(
      "act_111••••1111"
    );
    expect(screen.getByTestId("approval-budget").textContent).toContain("$25.00");
    expect(screen.getByTestId("approve-button")).toBeInTheDocument();
    expect(screen.getByTestId("reject-button")).toBeInTheDocument();
    // Parameters are display-only JSON; no editing affordance exists.
    expect(screen.queryByLabelText(/edit/i)).toBeNull();
    expect(screen.getByTestId("approval-params").textContent).toContain(
      "Summer Launch"
    );
  });

  it("32. approve success → success message, buttons removed", async () => {
    mockedApi.approveApproval.mockResolvedValue({
      success: true,
      data: { approvalId: "appr00000001abcdef", status: "approved" },
      timestamp: new Date().toISOString(),
    });
    render(<ApprovalCard approval={makeApproval()} />);
    fireEvent.click(screen.getByTestId("approve-button"));
    await waitFor(() =>
      expect(screen.getByTestId("approval-message").textContent).toMatch(
        /Approved/
      )
    );
    expect(screen.queryByTestId("approve-button")).toBeNull();
    expect(screen.getByTestId("approval-card").dataset.state).toBe("approved");
    expect(mockedApi.approveApproval).toHaveBeenCalledWith("appr00000001abcdef");
  });

  it("33. conflict/already-consumed handled with deterministic message", async () => {
    mockedApi.approveApproval.mockResolvedValue({
      success: false,
      error: { code: "APPROVAL_ALREADY_CONSUMED", message: "consumed" },
      timestamp: new Date().toISOString(),
    });
    render(<ApprovalCard approval={makeApproval()} />);
    fireEvent.click(screen.getByTestId("approve-button"));
    await waitFor(() =>
      expect(screen.getByTestId("approval-message").textContent).toMatch(
        /Already handled/
      )
    );
    expect(screen.getByTestId("approval-card").dataset.state).toBe("conflict");
    expect(screen.queryByTestId("approve-button")).toBeNull();
  });

  it("34. expired approval shows expired state and offers no actions", async () => {
    render(
      <ApprovalCard
        approval={makeApproval({ status: "expired", expiresAt: new Date(Date.now() - 1000).toISOString() })}
      />
    );
    expect(screen.getByTestId("approval-card").dataset.state).toBe("expired");
    expect(screen.queryByTestId("approve-button")).toBeNull();
    expect(screen.queryByTestId("reject-button")).toBeNull();
  });

  it("35. reject flow succeeds and reports rejection", async () => {
    mockedApi.rejectApproval.mockResolvedValue({
      success: true,
      data: { approvalId: "appr00000001abcdef", status: "rejected" },
      timestamp: new Date().toISOString(),
    });
    render(<ApprovalCard approval={makeApproval()} />);
    fireEvent.click(screen.getByTestId("reject-button"));
    await waitFor(() =>
      expect(screen.getByTestId("approval-message").textContent).toMatch(
        /Rejected/
      )
    );
    expect(screen.getByTestId("approval-card").dataset.state).toBe("rejected");
    expect(mockedApi.rejectApproval).toHaveBeenCalledTimes(1);
  });
});

describe("ApprovalsPage list behaviour", () => {
  it("renders loading, then cards from listApprovals", async () => {
    mockedApi.listApprovals.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                success: true,
                data: [makeApproval()],
                pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
                timestamp: new Date().toISOString(),
              }),
            10
          )
        )
    );
    render(<ApprovalsPage />);
    expect(screen.getByTestId("approvals-loading")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByTestId("approval-card").length).toBe(1)
    );
    // Default filter is pending → API called with pending status.
    expect(mockedApi.listApprovals).toHaveBeenCalledWith("pending", 1);
  });

  it("shows an error banner when listing fails", async () => {
    mockedApi.listApprovals.mockResolvedValue({
      success: false,
      error: { code: "AUTHENTICATION_REQUIRED", message: "auth required" },
      timestamp: new Date().toISOString(),
    });
    render(<ApprovalsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("approvals-error").textContent).toBeTruthy()
    );
  });

  it("shows the empty state when no approvals match the filter", async () => {
    mockedApi.listApprovals.mockResolvedValue({
      success: true,
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
      timestamp: new Date().toISOString(),
    });
    render(<ApprovalsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("approvals-empty")).toBeInTheDocument()
    );
  });
});
