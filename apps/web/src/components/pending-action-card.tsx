"use client";

import { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Shield,
  Wrench,
  RefreshCw,
} from "lucide-react";
import {
  confirmPendingAction,
  rejectPendingActionApi,
} from "@/lib/api";

export interface PendingActionData {
  id: string;
  toolId: string;
  action: string;
  params: Record<string, unknown>;
  riskLevel: string;
  state: string;
  approvalId: string;
  expiresAt: string;
  summary?: string;
}

type UiState =
  | "idle"
  | "executing"
  | "completed"
  | "failed"
  | "approving"
  | "rejecting"
  | "approved"
  | "rejected"
  | "error";

interface Props {
  pendingAction: PendingActionData;
  conversationId: string;
  onConfirmed?: () => void;
  onRejected?: () => void;
}

function toolDisplayName(toolId: string): string {
  const map: Record<string, string> = {
    "meta.campaign.create": "Create Campaign",
    "meta.campaign.pause": "Pause Campaign",
    "meta.campaign.resume": "Resume Campaign",
    "meta.campaign.delete": "Delete Campaign",
    "meta.campaign.budget.update": "Update Campaign Budget",
    "meta.adset.pause": "Pause Ad Set",
    "meta.adset.resume": "Resume Ad Set",
    "meta.adset.budget.update": "Update Ad Set Budget",
    "meta.ad.pause": "Pause Ad",
    "meta.ad.resume": "Resume Ad",
  };
  return map[toolId] ?? toolId;
}

export function PendingActionCard({
  pendingAction,
  conversationId,
  onConfirmed,
  onRejected,
}: Props) {
  const [ui, setUi] = useState<UiState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const expired = new Date(pendingAction.expiresAt) <= new Date();
  const effectiveState: UiState =
    ui !== "idle" ? ui : expired ? "error" : ui;
  const busy =
    ui === "approving" ||
    ui === "rejecting" ||
    ui === "executing";

  async function handleConfirm() {
    setUi("approving");
    setMessage(null);

    try {
      const res = await confirmPendingAction(pendingAction.id, conversationId);

      if (res.success) {
        setUi("approved");
        if (res.data?.executionResult?.status === "completed") {
          setMessage("Confirmed and executed successfully!");
        } else {
          setMessage("Confirmed! Executing...");
        }
        onConfirmed?.();
        return;
      }

      const code = res.error?.code ?? "";
      if (code === "PENDING_ACTION_NOT_FOUND") {
        setUi("error");
        setMessage("This action has expired or was already processed.");
      } else {
        setUi("error");
        setMessage(res.error?.message || "Failed to confirm.");
      }
    } catch {
      setUi("error");
      setMessage("Network error. Please try again.");
    }
  }

  async function handleReject() {
    setUi("rejecting");
    setMessage(null);

    try {
      const res = await rejectPendingActionApi(pendingAction.id, conversationId);

      if (res.success) {
        setUi("rejected");
        setMessage("Rejected. This action will not be executed.");
        onRejected?.();
        return;
      }

      setUi("error");
      setMessage(res.error?.message || "Failed to reject.");
    } catch {
      setUi("error");
      setMessage("Network error. Please try again.");
    }
  }

  const decided =
    effectiveState === "approved" ||
    effectiveState === "rejected" ||
    (effectiveState === "error" && expired);

  const isHighRisk =
    pendingAction.riskLevel === "HIGH_IMPACT" ||
    pendingAction.riskLevel === "FINANCIAL";

  return (
    <div
      data-testid="pending-action-card"
      data-state={effectiveState}
      data-risk={pendingAction.riskLevel}
      className={`mt-2 rounded-lg border p-3 space-y-2 ${
        isHighRisk
          ? "border-red-700/40 bg-red-900/10"
          : "border-yellow-700/40 bg-yellow-900/10"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        {isHighRisk ? (
          <Shield size={14} className="text-red-400 shrink-0" />
        ) : (
          <Wrench size={14} className="text-yellow-400 shrink-0" />
        )}
        <span
          className={`text-xs font-medium ${
            isHighRisk ? "text-red-300" : "text-yellow-300"
          }`}
        >
          {toolDisplayName(pendingAction.toolId)}
        </span>
        {isHighRisk && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-800/60 text-red-200">
            High Risk
          </span>
        )}
        {pendingAction.expiresAt && (
          <span className="text-xs text-gray-500 ml-auto flex items-center gap-1">
            <Clock size={11} />
            {new Date(pendingAction.expiresAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>

      {/* Parameters */}
      <div className="space-y-1">
        {pendingAction.params.name != null && (
          <div className="text-sm text-gray-200">
            <span className="text-gray-400">Name: </span>
            {String(pendingAction.params.name as string)}
          </div>
        )}
        {pendingAction.params.objective != null && (
          <div className="text-sm text-gray-200">
            <span className="text-gray-400">Objective: </span>
            {String(pendingAction.params.objective as string).replace("OUTCOME_", "")}
          </div>
        )}
        {pendingAction.params.dailyBudget != null && (
          <div className="text-sm text-gray-200">
            <span className="text-gray-400">Budget: </span>
            ₹{String(pendingAction.params.dailyBudget)}/day
          </div>
        )}
        {pendingAction.params.status != null && (
          <div className="text-sm text-gray-200">
            <span className="text-gray-400">Status: </span>
            {String(pendingAction.params.status as string)}
          </div>
        )}
        {pendingAction.params.campaignId != null && (
          <div className="text-sm text-gray-200">
            <span className="text-gray-400">Campaign ID: </span>
            {String(pendingAction.params.campaignId as string)}
          </div>
        )}
      </div>

      {/* Status message */}
      {message && (
        <p
          data-testid="pending-action-message"
          role="status"
          className={`text-xs ${
            effectiveState === "error" || effectiveState === "rejected"
              ? "text-red-300"
              : effectiveState === "approved" || effectiveState === "completed"
                ? "text-green-300"
                : "text-gray-300"
          }`}
        >
          {message}
        </p>
      )}

      {/* Action buttons */}
      {!decided && (
        <div className="flex gap-2 pt-1">
          <button
            data-testid="confirm-button"
            disabled={busy}
            onClick={handleConfirm}
            className="flex items-center gap-1 rounded bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50 transition-colors"
          >
            <CheckCircle2 size={13} />
            {busy && ui === "approving" ? "Confirming..." : "Confirm"}
          </button>
          <button
            data-testid="reject-button"
            disabled={busy}
            onClick={handleReject}
            className="flex items-center gap-1 rounded bg-red-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            <XCircle size={13} />
            {busy && ui === "rejecting" ? "Rejecting..." : "Reject"}
          </button>
        </div>
      )}

      {/* Retry after failure */}
      {effectiveState === "error" && !expired && (
        <button
          onClick={() => {
            setUi("idle");
            setMessage(null);
          }}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-300"
        >
          <RefreshCw size={12} />
          Try again
        </button>
      )}
    </div>
  );
}
