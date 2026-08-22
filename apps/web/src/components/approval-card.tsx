"use client";

// ---------------------------------------------------------------------------
// PHASE 10.7 — Approval card.
//
// Renders one server-generated approval with every required UX state:
// loading, success, conflict/already-consumed, expired, rejected, error.
// Parameters are DISPLAY-ONLY: approved parameters can never be edited here —
// changing a proposal means rejecting this approval and creating a new one
// (new paramsHash). The component never sees or transmits any secret.
// ---------------------------------------------------------------------------

import { useState } from "react";
import {
  approveApproval,
  rejectApproval,
  type ApprovalRecord,
} from "@/lib/api";

export type ApprovalUiState =
  | "idle"
  | "approving"
  | "rejecting"
  | "approved"
  | "rejected"
  | "conflict"
  | "expired"
  | "error";

const STATE_MESSAGES: Record<string, string> = {
  conflict: "Already handled: this approval was consumed by another action.",
  APPROVAL_ALREADY_CONSUMED:
    "Already handled: this approval was consumed by another action.",
  APPROVAL_CONFLICT:
    "Conflict: the approval changed while you were deciding.",
  APPROVAL_EXPIRED: "This approval has expired and can no longer be used.",
};

export function approvalUiError(code?: string): string {
  if (code && STATE_MESSAGES[code]) return STATE_MESSAGES[code];
  return "Something went wrong. Please try again.";
}

export function ApprovalCard({
  approval,
  onChanged,
}: {
  approval: ApprovalRecord;
  onChanged?: () => void;
}) {
  const [ui, setUi] = useState<ApprovalUiState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const effectiveStatus: ApprovalUiState =
    ui !== "idle"
      ? ui
      : approval.status === "expired" || new Date(approval.expiresAt) <= new Date()
        ? "expired"
        : approval.status === "consumed"
          ? "conflict"
          : approval.status === "rejected"
            ? "rejected"
            : approval.status === "approved"
              ? "approved"
              : "idle";

  async function decide(kind: "approve" | "reject") {
    setUi(kind === "approve" ? "approving" : "rejecting");
    setMessage(null);
    const res =
      kind === "approve"
        ? await approveApproval(approval.approvalId)
        : await rejectApproval(approval.approvalId);

    if (res.success) {
      setUi(kind === "approve" ? "approved" : "rejected");
      setMessage(
        kind === "approve"
          ? "Approved. JARVIS may execute this exact action once."
          : "Rejected. This proposal will not execute."
      );
      onChanged?.();
      return;
    }

    const code = res.error?.code ?? "";
    if (
      code === "APPROVAL_ALREADY_CONSUMED" ||
      code === "APPROVAL_CONFLICT"
    ) {
      setUi("conflict");
    } else if (code === "APPROVAL_EXPIRED") {
      setUi("expired");
    } else {
      setUi("error");
    }
    setMessage(approvalUiError(code));
  }

  const busy = ui === "approving" || ui === "rejecting";
  const decided =
    effectiveStatus === "approved" ||
    effectiveStatus === "rejected" ||
    effectiveStatus === "conflict" ||
    effectiveStatus === "expired";

  return (
    <div
      data-testid="approval-card"
      data-state={effectiveStatus}
      className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-gray-400">{approval.toolId}</span>
        <span
          data-testid="approval-status-badge"
          className={`text-xs px-2 py-0.5 rounded-full ${
            effectiveStatus === "idle"
              ? "bg-yellow-900/60 text-yellow-200"
              : effectiveStatus === "approved"
                ? "bg-green-900/60 text-green-200"
                : effectiveStatus === "rejected"
                  ? "bg-red-900/60 text-red-200"
                  : effectiveStatus === "expired"
                    ? "bg-gray-800 text-gray-400"
                    : "bg-blue-900/60 text-blue-200"
          }`}
        >
          {effectiveStatus}
        </span>
      </div>

      <p data-testid="approval-summary" className="text-sm text-gray-100">
        {approval.actionSummary}
      </p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
        {approval.accountRedacted && (
          <>
            <dt>Account</dt>
            <dd data-testid="approval-account">{approval.accountRedacted}</dd>
          </>
        )}
        {approval.budget && (
          <>
            <dt>Budget</dt>
            <dd data-testid="approval-budget">{approval.budget}</dd>
          </>
        )}
        <dt>Expires</dt>
        <dd data-testid="approval-expiry">
          {new Date(approval.expiresAt).toLocaleString()}
        </dd>
      </dl>

      {/* Display-only parameters: editing is forbidden by design. */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500">
          Parameters ({Object.keys(approval.params).length})
        </summary>
        <pre
          data-testid="approval-params"
          className="mt-1 overflow-x-auto rounded bg-black/50 p-2 text-gray-300"
        >
          {JSON.stringify(approval.params, null, 2)}
        </pre>
      </details>

      {message && (
        <p
          data-testid="approval-message"
          role="status"
          className={`text-xs ${ui === "error" || effectiveStatus === "conflict" ? "text-red-300" : "text-green-300"}`}
        >
          {message}
        </p>
      )}

      {!decided && (
        <div className="flex gap-2">
          <button
            data-testid="approve-button"
            disabled={busy}
            onClick={() => decide("approve")}
            className="rounded bg-green-700 px-3 py-1 text-sm font-medium hover:bg-green-600 disabled:opacity-50"
          >
            {busy && ui === "approving" ? "Approving…" : "Approve"}
          </button>
          <button
            data-testid="reject-button"
            disabled={busy}
            onClick={() => decide("reject")}
            className="rounded bg-red-800 px-3 py-1 text-sm font-medium hover:bg-red-700 disabled:opacity-50"
          >
            {busy && ui === "rejecting" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      )}
    </div>
  );
}
