// ---------------------------------------------------------------------------
// The Execute control, and the gate in front of it.
//
// Execute spends a durable approval. The server re-checks everything in one
// transaction — status, owner, tool, payload hash, expiry — so nothing here is
// the security boundary, and these tests do not pretend otherwise. What they
// protect is the layer above it: that the UI does not OFFER an action the
// server will refuse, does not send a second request the user did not intend,
// and does not describe the outcome more confidently than the server did.
//
// The last of those is the one with real consequences. "Google said it worked"
// and "we read it back and confirmed it" are different claims, and a UI that
// renders both as a green tick teaches the user to trust the weaker one.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ApprovalCard } from "../src/components/approval-card";
import { GoogleWriteExecute } from "../src/components/google-write-execute";
import type { ApprovalRecord, GoogleWriteExecuteResult } from "../src/lib/api";
import * as api from "../src/lib/api";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    executeGoogleWrite: vi.fn(),
    approveApproval: vi.fn(),
    rejectApproval: vi.fn(),
    listApprovals: vi.fn(),
  };
});

const mockedApi = vi.mocked(api);

/** A Google write approval. `drive.createFolder` — reversible, safe to model. */
function googleApproval(overrides?: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    approvalId: "appr_google_0001",
    toolId: "drive.createFolder",
    paramsHash: "hash-abc",
    status: "approved",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
    params: { action: "drive.createFolder", name: "Q4 Reports", consequence: "Creates a folder." },
    actionSummary: 'Create a Drive folder "Q4 Reports".',
    targetResource: "Q4 Reports",
    detailLines: [{ label: "name", value: "Q4 Reports" }],
    ...overrides,
  };
}

function result(overrides?: Partial<GoogleWriteExecuteResult>): GoogleWriteExecuteResult {
  return {
    success: true,
    source: "drive",
    action: "drive.createFolder",
    status: "COMPLETED",
    verification: "verified",
    data: { id: "folder-123", name: "Q4 Reports" },
    requestId: "req-1",
    auditRef: "audit-9f2",
    retrySafe: false,
    ...overrides,
  } as GoogleWriteExecuteResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.executeGoogleWrite.mockResolvedValue({
    success: true,
    data: result(),
    timestamp: new Date().toISOString(),
  } as never);
});

// ---------------------------------------------------------------------------

describe("Execute is offered for exactly one state", () => {
  it("appears on an APPROVED Google write approval", () => {
    render(<ApprovalCard approval={googleApproval()} />);

    expect(screen.getByTestId("write-execute")).toBeInTheDocument();
  });

  for (const status of ["pending", "rejected", "expired", "consumed"] as const) {
    it(`is absent for ${status}`, () => {
      render(<ApprovalCard approval={googleApproval({ status })} />);

      expect(screen.queryByTestId("write-execute")).toBeNull();
    });
  }

  it("is absent for an approval that is APPROVED but out of time", () => {
    // Expiry is a fact about the clock, not the row: both can be true at once,
    // and the server refuses on the clock.
    render(
      <ApprovalCard
        approval={googleApproval({ expiresAt: new Date(Date.now() - 1000).toISOString() })}
      />
    );

    expect(screen.queryByTestId("write-execute")).toBeNull();
    expect(screen.getByTestId("write-execute-unavailable")).toHaveAttribute("data-reason", "expired");
  });

  it("is absent on a non-Google approval, however it is approved", () => {
    render(<ApprovalCard approval={googleApproval({ toolId: "meta.campaign.create" })} />);

    expect(screen.queryByTestId("write-execute")).toBeNull();
  });

  it("explains why rather than showing a dead button", () => {
    render(<GoogleWriteExecute approvalId="a1" status="consumed" expiresAt={future()} />);

    const note = screen.getByTestId("write-execute-unavailable");
    expect(note.textContent).toMatch(/executed/i);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("executing goes through the existing route, once", () => {
  it("calls executeGoogleWrite with the approval id and nothing else", async () => {
    render(<ApprovalCard approval={googleApproval()} />);
    fireEvent.click(screen.getByTestId("write-execute"));

    await waitFor(() => expect(mockedApi.executeGoogleWrite).toHaveBeenCalledTimes(1));
    expect(mockedApi.executeGoogleWrite).toHaveBeenCalledWith("appr_google_0001");
  });

  it("does not fire twice on a double click", async () => {
    // Two clicks in one tick both read `phase === "idle"`, so the guard has to
    // be synchronous. The server would refuse the second, but a refused send is
    // still a send attempt the user has to reason about.
    let release: (v: unknown) => void = () => {};
    mockedApi.executeGoogleWrite.mockReturnValue(
      new Promise((r) => {
        release = r;
      }) as never
    );

    render(<ApprovalCard approval={googleApproval()} />);
    const button = screen.getByTestId("write-execute");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(mockedApi.executeGoogleWrite).toHaveBeenCalledTimes(1);
    release({ success: true, data: result(), timestamp: "" });
  });

  it("shows a loading state while the request is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    mockedApi.executeGoogleWrite.mockReturnValue(
      new Promise((r) => {
        release = r;
      }) as never
    );

    render(<ApprovalCard approval={googleApproval()} />);
    fireEvent.click(screen.getByTestId("write-execute"));

    const busy = await screen.findByTestId("write-executing");
    expect(busy).toHaveAttribute("aria-live", "polite");
    release({ success: true, data: result(), timestamp: "" });
  });

  it("refreshes the approval after an attempt, including a failed one", async () => {
    const onChanged = vi.fn();
    mockedApi.executeGoogleWrite.mockResolvedValue({
      success: false,
      data: result({ success: false, verification: "failed", status: "FAILED" }),
      timestamp: "",
    } as never);

    render(<ApprovalCard approval={googleApproval()} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("write-execute"));

    // The approval is CONSUMED whatever the provider did — a stale "Approved"
    // card would invite a second attempt.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe("the outcome is reported exactly as strongly as the server reported it", () => {
  it("says verified only when the server verified", async () => {
    render(<ApprovalCard approval={googleApproval()} />);
    fireEvent.click(screen.getByTestId("write-execute"));

    const label = await screen.findByTestId("write-verification-label");
    expect(label.textContent).toBe("Verified");
    expect(screen.getByTestId("write-execute-result")).toHaveAttribute("data-verification", "verified");
  });

  it("never presents provider_reported as verified", async () => {
    mockedApi.executeGoogleWrite.mockResolvedValue({
      success: true,
      data: result({ verification: "provider_reported" }),
      timestamp: "",
    } as never);

    render(<ApprovalCard approval={googleApproval()} />);
    fireEvent.click(screen.getByTestId("write-execute"));

    const label = await screen.findByTestId("write-verification-label");
    expect(label.textContent).toBe("Google reported success");
    expect(label.textContent).not.toMatch(/^verified$/i);
    expect(screen.getByTestId("write-execute-result").textContent).toMatch(
      /did not independently re-read/i
    );
  });

  it("renders verification_failed as applied-but-unconfirmed, and does not offer a retry", async () => {
    mockedApi.executeGoogleWrite.mockResolvedValue({
      success: true,
      data: result({ verification: "verification_failed", retrySafe: false }),
      timestamp: "",
    } as never);

    render(<ApprovalCard approval={googleApproval()} />);
    fireEvent.click(screen.getByTestId("write-execute"));

    const body = (await screen.findByTestId("write-execute-result")).textContent ?? "";
    // The write HAPPENED. Telling the user to repeat it would be the harm.
    expect(body).toMatch(/applied/i);
    expect(body).toMatch(/do not repeat/i);
    expect(screen.queryByTestId("write-execute-retry")).toBeNull();
  });

  it("renders verification_unavailable distinctly from provider_reported", async () => {
    mockedApi.executeGoogleWrite.mockResolvedValue({
      success: true,
      data: result({ verification: "verification_unavailable" }),
      timestamp: "",
    } as never);

    render(<ApprovalCard approval={googleApproval()} />);
    fireEvent.click(screen.getByTestId("write-execute"));

    const label = await screen.findByTestId("write-verification-label");
    expect(label.textContent).toBe("Done, not confirmed");
  });

  it("never offers a retry for an indeterminate outcome", async () => {
    mockedApi.executeGoogleWrite.mockResolvedValue({
      success: false,
      data: result({ success: false, verification: "indeterminate", retrySafe: false }),
      timestamp: "",
    } as never);

    render(<ApprovalCard approval={googleApproval()} />);
    fireEvent.click(screen.getByTestId("write-execute"));

    const body = (await screen.findByTestId("write-execute-result")).textContent ?? "";
    expect(body).toMatch(/outcome unknown/i);
    expect(screen.queryByTestId("write-execute-retry")).toBeNull();
  });

  it("renders needs-reauth with the remedy the server supplied", async () => {
    mockedApi.executeGoogleWrite.mockResolvedValue({
      success: false,
      data: result({
        success: false,
        status: "FAILED",
        verification: "failed",
        message: "Your Google authorization has expired.",
        requiredAction: "Reconnect your Google account, then plan the action again.",
      }),
      timestamp: "",
    } as never);

    render(<ApprovalCard approval={googleApproval()} />);
    fireEvent.click(screen.getByTestId("write-execute"));

    const body = (await screen.findByTestId("write-execute-result")).textContent ?? "";
    expect(body).toMatch(/authorization has expired/i);
    expect(body).toMatch(/reconnect your google account/i);
  });

  it("shows the audit reference so the outcome can be cited", async () => {
    render(<ApprovalCard approval={googleApproval()} />);
    fireEvent.click(screen.getByTestId("write-execute"));

    const ref = await screen.findByTestId("write-audit-ref");
    expect(ref.textContent).toContain("audit-9f2");
  });
});

describe("nothing sensitive reaches the page", () => {
  it("renders no token, secret or raw provider payload from the result", async () => {
    mockedApi.executeGoogleWrite.mockResolvedValue({
      success: true,
      data: {
        ...result(),
        // A server that regressed and leaked these must not have them rendered.
        data: {
          id: "folder-123",
          accessToken: "ya29.SECRETTOKEN",
          refreshToken: "1//REFRESHSECRET",
          client_secret: "GOCSPX-shhh",
        },
      },
      timestamp: "",
    } as never);

    render(<ApprovalCard approval={googleApproval()} />);
    fireEvent.click(screen.getByTestId("write-execute"));
    await screen.findByTestId("write-execute-result");

    const rendered = screen.getByTestId("write-execute-result").textContent ?? "";
    expect(rendered).not.toContain("ya29.SECRETTOKEN");
    expect(rendered).not.toContain("1//REFRESHSECRET");
    expect(rendered).not.toContain("GOCSPX-shhh");
    // The component reads named fields only; it never dumps `data`.
    expect(rendered).not.toContain("folder-123");
  });
});

function future(): string {
  return new Date(Date.now() + 60_000).toISOString();
}
