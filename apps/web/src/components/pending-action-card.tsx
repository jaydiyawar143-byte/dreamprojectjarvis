"use client";

import React, { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Shield,
  Wrench,
  RefreshCw,
  Loader2,
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
  executionResult?: {
    status: string;
    data?: Record<string, unknown>;
    error?: string;
  };
}

type UiState =
  | "idle"
  | "executing"
  | "completed"
  | "failed"
  | "rejected";

interface Props {
  pendingAction: PendingActionData;
  conversationId: string;
  onConfirmed?: () => void;
  onRejected?: () => void;
}

function toolDisplayName(toolId: string): string {
  const normalized = toolId.replace(/-/g, ".");
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
  return map[normalized] ?? toolId;
}

function paramValue(v: unknown): string {
  return String(v ?? "");
}

function renderProposalParams(p: Record<string, unknown>): React.ReactNode {
  return (
    <>
      {p.name != null && (
        <div className="text-sm text-gray-200">
          <span className="text-gray-400">Name: </span>
          {paramValue(p.name)}
        </div>
      )}
      {p.objective != null && (
        <div className="text-sm text-gray-200">
          <span className="text-gray-400">Objective: </span>
          {paramValue(p.objective).replace("OUTCOME_", "")}
        </div>
      )}
      {p.daily_budget != null && (
        <div className="text-sm text-gray-200">
          <span className="text-gray-400">Budget: </span>
          Rs {paramValue(p.daily_budget)}/day
        </div>
      )}
      {p.status != null && (
        <div className="text-sm text-gray-200">
          <span className="text-gray-400">Status: </span>
          {paramValue(p.status)}
        </div>
      )}
    </>
  );
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

  if (ui === "idle" && expired) {
    setUi("failed");
    setMessage("This approval has expired.");
  }

  async function handleConfirm() {
    setUi("executing");
    setMessage(null);

    try {
      const res = await confirmPendingAction(pendingAction.id, conversationId);

      if (res.success) {
        setUi("completed");
        if (res.data?.executionResult?.status === "completed") {
          setMessage("Executed successfully!");
        } else if (res.data?.executionResult?.status === "failed") {
          setUi("failed");
          setMessage(String(res.data.executionResult.error) || "Execution failed.");
        } else {
          setMessage("Confirmed and executed.");
        }
        onConfirmed?.();
        return;
      }

      const code = res.error?.code ?? "";
      if (code === "PENDING_ACTION_NOT_FOUND") {
        setUi("failed");
        setMessage("This action has expired or was already processed.");
      } else {
        setUi("failed");
        setMessage(res.error?.message || "Failed to confirm.");
      }
    } catch {
      setUi("failed");
      setMessage("Network error. Please try again.");
    }
  }

  async function handleReject() {
    setUi("executing");
    setMessage(null);

    try {
      const res = await rejectPendingActionApi(pendingAction.id, conversationId);

      if (res.success) {
        setUi("rejected");
        setMessage("Cancelled. This action will not be executed.");
        onRejected?.();
        return;
      }

      setUi("failed");
      setMessage(res.error?.message || "Failed to reject.");
    } catch {
      setUi("failed");
      setMessage("Network error. Please try again.");
    }
  }

  const isHighRisk =
    pendingAction.riskLevel === "HIGH_IMPACT" ||
    pendingAction.riskLevel === "FINANCIAL";

  const showButtons = ui === "idle" && !expired;
  const isExecuted = ui === "completed" && message?.includes("successfully");

  return (
    <div
      data-testid="pending-action-card"
      data-state={ui === "idle" ? (expired ? "expired" : "PENDING_APPROVAL") : ui === "completed" ? "EXECUTED" : ui === "rejected" ? "CANCELLED" : ui === "executing" ? "EXECUTING" : ui === "failed" ? "FAILED" : ui}
      data-risk={pendingAction.riskLevel}
      className={`mt-2 rounded-lg border p-3 space-y-2 ${
        isHighRisk
          ? "border-red-700/40 bg-red-900/10"
          : ui === "completed"
            ? "border-green-700/40 bg-green-900/10"
            : ui === "rejected"
              ? "border-gray-700/40 bg-gray-900/10"
              : "border-yellow-700/40 bg-yellow-900/10"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        {ui === "completed" ? (
          <CheckCircle2 size={14} className="text-green-400 shrink-0" />
        ) : ui === "rejected" ? (
          <XCircle size={14} className="text-gray-400 shrink-0" />
        ) : isHighRisk ? (
          <Shield size={14} className="text-red-400 shrink-0" />
        ) : (
          <Wrench size={14} className="text-yellow-400 shrink-0" />
        )}
        <span
          className={`text-xs font-medium ${
            ui === "completed"
              ? "text-green-300"
              : ui === "rejected"
                ? "text-gray-400"
                : isHighRisk
                  ? "text-red-300"
                  : "text-yellow-300"
          }`}
        >
          {toolDisplayName(pendingAction.toolId)}
        </span>
        {isHighRisk && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-800/60 text-red-200">
            High Risk
          </span>
        )}
        {ui === "idle" && pendingAction.expiresAt && (
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
            {paramValue(pendingAction.params.name)}
          </div>
        )}
        {pendingAction.params.objective != null && (
          <div className="text-sm text-gray-200">
            <span className="text-gray-400">Objective: </span>
            {paramValue(pendingAction.params.objective).replace("OUTCOME_", "")}
          </div>
        )}
        {typeof pendingAction.params.proposal === "object" && pendingAction.params.proposal != null && renderProposalParams(pendingAction.params.proposal as Record<string, unknown>)}
        {pendingAction.params.dailyBudget != null && (
          <div className="text-sm text-gray-200">
            <span className="text-gray-400">Budget: </span>
            Rs {paramValue(pendingAction.params.dailyBudget)}/day
          </div>
        )}
        {pendingAction.params.status != null && typeof pendingAction.params.status === "string" && (
          <div className="text-sm text-gray-200">
            <span className="text-gray-400">Status: </span>
            {paramValue(pendingAction.params.status)}
          </div>
        )}
        {pendingAction.params.campaignId != null && (
          <div className="text-sm text-gray-200">
            <span className="text-gray-400">Campaign ID: </span>
            {paramValue(pendingAction.params.campaignId)}
          </div>
        )}
      </div>

      {/* Status message */}
      {message && (
        <p
          data-testid="pending-action-message"
          role="status"
          className={`text-xs ${
            ui === "failed"
              ? "text-red-300"
              : ui === "rejected"
                ? "text-gray-400"
                : ui === "completed"
                  ? "text-green-300"
                  : "text-gray-300"
          }`}
        >
          {message}
        </p>
      )}

      {/* EXECUTING state */}
      {ui === "executing" && (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Loader2 size={13} className="animate-spin" />
          <span>Executing...</span>
        </div>
      )}

      {/* PENDING_APPROVAL state: Confirm + Reject buttons */}
      {showButtons && (
        <div className="flex gap-2 pt-1">
          <button
            data-testid="confirm-button"
            onClick={handleConfirm}
            className="flex items-center gap-1 rounded bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 transition-colors"
          >
            <CheckCircle2 size={13} />
            Confirm
          </button>
          <button
            data-testid="reject-button"
            onClick={handleReject}
            className="flex items-center gap-1 rounded bg-red-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors"
          >
            <XCircle size={13} />
            Reject
          </button>
        </div>
      )}

      {/* EXECUTED state */}
      {isExecuted && (
        <div className="flex items-center gap-2 text-xs text-green-400">
          <CheckCircle2 size={13} />
          <span>Executed</span>
        </div>
      )}

      {/* FAILED state: Retry */}
      {ui === "failed" && !expired && (
        <button
          data-testid="retry-button"
          onClick={() => {
            setUi("idle");
            setMessage(null);
          }}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-300"
        >
          <RefreshCw size={12} />
          Retry
        </button>
      )}

      {/* CANCELLED state */}
      {ui === "rejected" && (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <XCircle size={13} />
          <span>Cancelled</span>
        </div>
      )}
    </div>
  );
}
