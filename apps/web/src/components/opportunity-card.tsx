"use client";

// ---------------------------------------------------------------------------
// Phase 11.9B — Opportunity Card component
//
// Renders one item in the opportunity queue list. Language is carefully
// chosen to distinguish facts from inferences and never claim guarantees:
//   "Recommended because…"    (not "JARVIS guarantees…")
//   "Historical evidence suggests…"
//   "Expected impact (not a guarantee)…"
//   "Confidence: HIGH/MEDIUM/LOW"
// ---------------------------------------------------------------------------

import type { OpportunityQueueItem } from "@/lib/api";
import Link from "next/link";

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: "bg-red-500/20 text-red-300 border-red-500/40",
  HIGH:     "bg-orange-500/20 text-orange-300 border-orange-500/40",
  MEDIUM:   "bg-yellow-500/20 text-yellow-300 border-yellow-500/40",
  LOW:      "bg-blue-500/20 text-blue-300 border-blue-500/40",
  IGNORE:   "bg-gray-600/20 text-gray-400 border-gray-600/40",
};

const STATUS_COLORS: Record<string, string> = {
  NEW:              "bg-emerald-500/20 text-emerald-300",
  REVIEWED:         "bg-sky-500/20 text-sky-300",
  APPROVAL_PENDING: "bg-purple-500/20 text-purple-300",
  APPROVED:         "bg-green-500/20 text-green-300",
  REJECTED:         "bg-red-500/20 text-red-400",
  EXPIRED:          "bg-gray-600/20 text-gray-400",
  EXECUTED:         "bg-teal-500/20 text-teal-300",
  FAILED:           "bg-red-700/20 text-red-500",
};

const RISK_COLORS: Record<string, string> = {
  LOW:    "text-green-400",
  MEDIUM: "text-yellow-400",
  HIGH:   "text-red-400",
};

const CONFIDENCE_COLORS: Record<string, string> = {
  HIGH:   "text-green-400",
  MEDIUM: "text-yellow-400",
  LOW:    "text-red-400",
};

function formatActionType(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatEntityType(level: string): string {
  return level.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isExpiredOrTerminal(status: string): boolean {
  return ["EXPIRED", "EXECUTED", "FAILED", "REJECTED"].includes(status);
}

interface OpportunityCardProps {
  item: OpportunityQueueItem;
  "data-testid"?: string;
}

export function OpportunityCard({ item, "data-testid": testId }: OpportunityCardProps) {
  const actionable = !isExpiredOrTerminal(item.displayStatus);

  return (
    <div
      data-testid={testId ?? `opportunity-card-${item.recommendationId}`}
      className={`rounded-xl border p-5 transition-all ${
        actionable
          ? "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/8"
          : "border-white/5 bg-white/3 opacity-70"
      }`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Priority badge */}
          <span
            data-testid={`priority-badge-${item.recommendationId}`}
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
              PRIORITY_COLORS[item.priority] ?? PRIORITY_COLORS.IGNORE
            }`}
          >
            {item.priority}
          </span>
          {/* Status badge */}
          <span
            data-testid={`status-badge-${item.recommendationId}`}
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              STATUS_COLORS[item.displayStatus] ?? "bg-gray-700 text-gray-400"
            }`}
          >
            {item.displayStatus.replace(/_/g, " ")}
          </span>
          {/* Conflict warning */}
          {item.conflicted && (
            <span
              data-testid={`conflict-badge-${item.recommendationId}`}
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 text-xs font-semibold"
            >
              ⚠ CONFLICTED
            </span>
          )}
        </div>
        {/* Score */}
        <div className="flex-shrink-0 text-right">
          <span className="text-2xl font-bold text-white">{item.score}</span>
          <span className="text-xs text-gray-400">/100</span>
        </div>
      </div>

      {/* Action title */}
      <div className="mt-3">
        <h3 className="font-semibold text-white text-base">
          {formatActionType(item.actionType)}
        </h3>
        <p className="text-xs text-gray-400 mt-0.5">
          {formatEntityType(item.entityType)}{" "}
          <span className="font-mono text-gray-500">
            {item.entityId.slice(0, 20)}
            {item.entityId.length > 20 ? "…" : ""}
          </span>
        </p>
      </div>

      {/* Why now? */}
      <div className="mt-3 rounded-lg bg-white/5 px-4 py-3">
        <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider mb-1">
          Why now?
        </p>
        <p className="text-sm text-gray-200 leading-relaxed">
          {item.explanation}
        </p>
      </div>

      {/* Conflict details */}
      {item.conflicted && item.conflictWith.length > 0 && (
        <div
          data-testid={`conflict-detail-${item.recommendationId}`}
          className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <p className="text-xs font-semibold text-amber-400 mb-1">⚠ Conflict</p>
          <p className="text-xs text-amber-300">
            This recommendation conflicts with:{" "}
            {item.conflictWith.map((id) => (
              <span key={id} className="font-mono">{id.slice(0, 16)}…</span>
            ))}
          </p>
          <p className="text-xs text-amber-200 mt-1">
            Review both sides before deciding.
          </p>
        </div>
      )}

      {/* Metrics row */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg bg-white/5 p-2 text-center">
          <p className="text-xs text-gray-400">Risk</p>
          <p className={`text-sm font-semibold ${RISK_COLORS[item.risk] ?? "text-white"}`}>
            {item.risk}
          </p>
        </div>
        <div className="rounded-lg bg-white/5 p-2 text-center">
          <p className="text-xs text-gray-400">Confidence</p>
          <p className={`text-sm font-semibold ${CONFIDENCE_COLORS[item.confidence] ?? "text-white"}`}>
            {item.confidence}
          </p>
        </div>
        <div className="rounded-lg bg-white/5 p-2 text-center">
          <p className="text-xs text-gray-400">Expected Impact</p>
          <p className="text-sm font-semibold text-white">
            {item.expectedImpact === "IMPACT_UNKNOWN"
              ? "Unknown"
              : item.expectedImpact}
          </p>
        </div>
        <div className="rounded-lg bg-white/5 p-2 text-center">
          <p className="text-xs text-gray-400">Historical Evidence</p>
          <p className="text-sm font-semibold text-white">
            {item.historicalSampleSize > 0
              ? `${item.historicalSampleSize} case${item.historicalSampleSize === 1 ? "" : "s"}`
              : "None"}
          </p>
        </div>
      </div>

      {/* Footer: expiry + review link */}
      <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-gray-500">
          {item.displayStatus === "EXPIRED"
            ? `Expired ${new Date(item.expiresAt).toLocaleDateString()}`
            : `Expires ${new Date(item.expiresAt).toLocaleDateString()}`}
        </p>
        <Link
          href={`/opportunities/${item.recommendationId}`}
          data-testid={`view-detail-${item.recommendationId}`}
          className={`rounded-lg px-4 py-2 text-xs font-semibold transition-colors ${
            actionable
              ? "bg-indigo-600 text-white hover:bg-indigo-500"
              : "bg-gray-700 text-gray-400 cursor-not-allowed pointer-events-none"
          }`}
        >
          {actionable ? "Review Recommendation →" : "View Details"}
        </Link>
      </div>
    </div>
  );
}
