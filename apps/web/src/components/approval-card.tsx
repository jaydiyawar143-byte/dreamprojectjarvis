"use client";

// ---------------------------------------------------------------------------
// PHASE 10.7 — Approval card.
//
// Renders one server-generated approval with every required UX state:
// loading, success, conflict/already-consumed, expired, rejected, error.
// Parameters are DISPLAY-ONLY: approved parameters can never be edited here —
// changing a proposal means rejecting this approval and creating a new one
// (new paramsHash). The component never sees or transmits any secret.
//
// UI V2 — restyled onto the glass design language and given a RISK badge. The
// badge reports `approval.risk`, which the API reads from the same tool registry
// that gates execution, so it cannot drift from the risk actually being taken.
// An approval whose tool reports no risk shows no badge rather than a guess.
//
// This is the ONLY approval control in the app. The command centre renders this
// same component rather than a copy, which is what keeps "voice can never
// approve" true: there is one decision path, and it is this one.
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

/**
 * Risk, in words a person can act on.
 *
 * The registry's own vocabulary (EXTERNAL_SIDE_EFFECT) describes the mechanism;
 * these describe the consequence, which is what the reader is deciding about.
 */
const RISK_LABEL: Record<string, string> = {
  READ_ONLY: "Read only",
  LOW_IMPACT: "Low impact",
  EXTERNAL_SIDE_EFFECT: "External effect",
  HIGH_IMPACT: "High impact",
  FINANCIAL: "Spends money",
};

const RISK_TONE: Record<string, string> = {
  READ_ONLY: "border-sys-line bg-white/[0.03] text-sys-dim",
  LOW_IMPACT: "border-sky-400/40 bg-sky-400/10 text-sky-300",
  EXTERNAL_SIDE_EFFECT: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  HIGH_IMPACT: "border-orange-400/45 bg-orange-400/10 text-orange-300",
  FINANCIAL: "border-red-400/45 bg-red-400/10 text-red-300",
};

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
      className="glass-panel glass-edge space-y-3 rounded-xl p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[0.62rem] text-sys-dim">{approval.toolId}</span>

        <div className="flex items-center gap-2">
          {approval.risk && (
            <span
              data-testid="approval-risk-badge"
              title="Declared by the tool that would execute this action."
              className={`rounded border px-2 py-0.5 font-mono text-[0.5rem] uppercase tracking-hud ${RISK_TONE[approval.risk] ?? "border-sys-line bg-white/[0.03] text-sys-dim"}`}
            >
              {RISK_LABEL[approval.risk] ?? approval.risk}
            </span>
          )}

          <span
            data-testid="approval-status-badge"
            className={`rounded border px-2 py-0.5 font-mono text-[0.5rem] uppercase tracking-hud ${
              effectiveStatus === "idle"
                ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                : effectiveStatus === "approved"
                  ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                  : effectiveStatus === "rejected"
                    ? "border-red-400/40 bg-red-400/10 text-red-300"
                    : effectiveStatus === "expired"
                      ? "border-sys-line bg-white/[0.03] text-sys-dim"
                      : "border-sky-400/40 bg-sky-400/10 text-sky-300"
            }`}
          >
            {/* "idle" is an internal UI state, not something to show a person:
                what it MEANS here is that the decision is still open. */}
            {effectiveStatus === "idle" ? "Awaiting decision" : effectiveStatus}
          </span>
        </div>
      </div>

      <p data-testid="approval-summary" className="text-sm text-white/90">
        {approval.actionSummary}
      </p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-sys-dim">
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
        <summary className="cursor-pointer text-sys-dim/70">
          Parameters ({Object.keys(approval.params).length})
        </summary>
        <pre
          data-testid="approval-params"
          className="mt-1 overflow-x-auto rounded bg-black/50 p-2 text-sys-text/80"
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
        // Reject FIRST in the DOM and on screen. Approve is the irreversible
        // one, and putting it under the reading hand's default landing spot is
        // how an accidental confirmation happens.
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            data-testid="reject-button"
            disabled={busy}
            onClick={() => decide("reject")}
            className="sys-focus rounded-md border border-sys-line bg-white/[0.03] px-3.5 py-1.5 font-mono text-[0.6rem] uppercase tracking-hud text-sys-text/85 transition-colors enabled:hover:border-red-400/40 enabled:hover:text-red-300 disabled:opacity-45"
          >
            {busy && ui === "rejecting" ? "Rejecting…" : "Reject"}
          </button>
          <button
            data-testid="approve-button"
            disabled={busy}
            onClick={() => decide("approve")}
            className="sys-focus rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3.5 py-1.5 font-mono text-[0.6rem] uppercase tracking-hud text-emerald-300 transition-colors enabled:hover:border-emerald-400/70 enabled:hover:bg-emerald-400/20 disabled:opacity-45"
          >
            {busy && ui === "approving" ? "Approving…" : "Approve"}
          </button>
        </div>
      )}
    </div>
  );
}
