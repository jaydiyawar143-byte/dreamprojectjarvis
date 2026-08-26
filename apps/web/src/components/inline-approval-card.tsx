"use client";

import { useState } from "react";
import { CheckCircle2, XCircle, Clock, Shield } from "lucide-react";
import { approveApproval, rejectApproval } from "@/lib/api";

interface Props {
  approvalId: string;
  summary: string;
  expiresAt?: string;
  detailLines?: Array<{ label: string; value: string }>;
  onDecision?: () => void;
}

type UiState = "idle" | "approving" | "rejecting" | "approved" | "rejected" | "error";

export function InlineApprovalCard({
  approvalId,
  summary,
  expiresAt,
  detailLines,
  onDecision,
}: Props) {
  const [ui, setUi] = useState<UiState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const expired = expiresAt ? new Date(expiresAt) <= new Date() : false;
  const effectiveState: UiState = expired && ui === "idle" ? "error" : ui;
  const busy = ui === "approving" || ui === "rejecting";

  async function decide(kind: "approve" | "reject") {
    setUi(kind === "approve" ? "approving" : "rejecting");
    setMessage(null);
    const res =
      kind === "approve"
        ? await approveApproval(approvalId)
        : await rejectApproval(approvalId);

    if (res.success) {
      setUi(kind === "approve" ? "approved" : "rejected");
      setMessage(
        kind === "approve"
          ? "Approved. JARVIS will execute this action."
          : "Rejected. This proposal will not execute."
      );
      onDecision?.();
      return;
    }

    setUi("error");
    const code = res.error?.code ?? "";
    if (code === "APPROVAL_EXPIRED") {
      setMessage("This approval has expired.");
    } else if (code === "APPROVAL_ALREADY_CONSUMED") {
      setMessage("Already handled by another action.");
    } else {
      setMessage("Something went wrong. Please try again.");
    }
  }

  const decided =
    effectiveState === "approved" ||
    effectiveState === "rejected" ||
    (effectiveState === "error" && expired);

  return (
    <div className="mt-2 rounded-lg border border-yellow-700/40 bg-yellow-900/10 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Shield size={14} className="text-yellow-400 shrink-0" />
        <span className="text-xs font-medium text-yellow-300">Approval Required</span>
        {expiresAt && (
          <span className="text-xs text-gray-500 ml-auto flex items-center gap-1">
            <Clock size={11} />
            {new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>

      <p className="text-sm text-gray-200">{summary}</p>

      {detailLines && detailLines.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
          {detailLines.map((dl) => (
            <span key={dl.label}>
              <dt className="text-gray-500 inline">{dl.label}: </dt>
              <dd className="text-gray-300 inline">{dl.value}</dd>
            </span>
          ))}
        </dl>
      )}

      {message && (
        <p className={`text-xs ${effectiveState === "error" ? "text-red-300" : "text-green-300"}`}>
          {message}
        </p>
      )}

      {!decided && (
        <div className="flex gap-2 pt-1">
          <button
            disabled={busy}
            onClick={() => decide("approve")}
            className="flex items-center gap-1 rounded bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50 transition-colors"
          >
            <CheckCircle2 size={13} />
            {busy && ui === "approving" ? "Approving..." : "Approve"}
          </button>
          <button
            disabled={busy}
            onClick={() => decide("reject")}
            className="flex items-center gap-1 rounded bg-red-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            <XCircle size={13} />
            {busy && ui === "rejecting" ? "Rejecting..." : "Reject"}
          </button>
        </div>
      )}
    </div>
  );
}
