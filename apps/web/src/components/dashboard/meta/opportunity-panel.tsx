"use client";

// ---------------------------------------------------------------------------
// Sprint 4.6 — Opportunities, anomalies and diagnosis.
//
// Reads the Phase 11.9 opportunity queue, which already carries the scoring,
// the priority, the anomalies and the historical evidence. None of that is
// recomputed here; the panel only decides what a person needs to see first.
//
// READ-ONLY BY CONSTRUCTION. There is no approve, execute or dismiss control
// anywhere in this component. Acting on an opportunity means following the link
// into the existing review flow, which is where the approval boundary lives.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import type { OpportunityQueueItem, OpportunityPriority } from "@/lib/api";
import { Panel } from "../panel";
import { EmptyState, ErrorState, LoadingState } from "../states";
import { cn } from "@/lib/utils";

const PRIORITY_CHIP: Record<string, string> = {
  CRITICAL: "border-sys-danger/50 bg-sys-danger/10 text-sys-danger",
  HIGH: "border-amber-400/50 bg-amber-400/10 text-amber-300",
  MEDIUM: "border-sys-cyan/40 bg-sys-cyan/[0.08] text-sys-cyan",
  LOW: "border-sys-line bg-white/[0.03] text-sys-dim",
  IGNORE: "border-sys-line bg-white/[0.02] text-sys-dim/70",
};

function chipFor(priority?: OpportunityPriority | string | null): string {
  return PRIORITY_CHIP[String(priority ?? "LOW")] ?? PRIORITY_CHIP.LOW!;
}

/** Reads whichever human-facing summary the queue item happens to carry. */
function summaryOf(item: Record<string, unknown>): string | null {
  for (const key of ["title", "summary", "actionSummary", "rationale", "reason"]) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

export function OpportunityPanel({
  items,
  loading,
  error,
  onRetry,
}: {
  items: OpportunityQueueItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Panel
      title="Opportunities"
      description="What JARVIS thinks is worth looking at, ranked. Reviewing one opens the existing approval flow."
      action={
        items.length > 0 ? (
          <Link
            href="/opportunities"
            data-testid="all-opportunities"
            className="sys-focus inline-flex items-center gap-1 rounded border border-sys-line px-2 py-1 font-mono text-[0.55rem] uppercase tracking-hud text-sys-dim transition-colors hover:border-sys-cyan/40 hover:text-sys-text"
          >
            All <ArrowUpRight size={11} aria-hidden="true" />
          </Link>
        ) : undefined
      }
    >
      {loading ? (
        <LoadingState label="Loading opportunities" lines={3} />
      ) : error ? (
        <ErrorState title="Could not load opportunities" message={error} onRetry={onRetry} />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing flagged"
          message="JARVIS has not found anything in this account worth proposing a change for."
        />
      ) : (
        <ul className="divide-y divide-sys-line/60">
          {items.map((raw) => {
            const item = raw as unknown as Record<string, unknown>;
            const id = String(item.id ?? item.recommendationId ?? "");
            const priority = item.priority as OpportunityPriority | undefined;
            const summary = summaryOf(item);
            const entity =
              (typeof item.entityName === "string" && item.entityName) ||
              (typeof item.entityId === "string" && item.entityId) ||
              null;
            const anomalies = Array.isArray(item.anomalies) ? item.anomalies : [];

            return (
              <li key={id} data-testid="opportunity-row" className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-3">
                  <span
                    data-testid="opportunity-priority"
                    className={cn(
                      "mt-0.5 shrink-0 rounded border px-1.5 py-px font-mono text-[0.5rem] uppercase tracking-hud",
                      chipFor(priority)
                    )}
                  >
                    {String(priority ?? "LOW")}
                  </span>

                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm text-sys-text/90">
                      {summary ?? "Proposed change"}
                    </p>
                    {entity && <p className="truncate text-xs text-sys-dim">{entity}</p>}

                    {anomalies.length > 0 && (
                      <p
                        data-testid="opportunity-anomalies"
                        className="flex items-center gap-1.5 text-xs text-amber-300/90"
                      >
                        <AlertTriangle size={11} aria-hidden="true" />
                        {anomalies.length} anomal{anomalies.length === 1 ? "y" : "ies"} detected
                      </p>
                    )}
                  </div>

                  {id && (
                    <Link
                      href={`/opportunities/${id}`}
                      data-testid={`review-${id}`}
                      className="sys-focus shrink-0 rounded border border-sys-line px-2 py-1 font-mono text-[0.55rem] uppercase tracking-hud text-sys-dim transition-colors hover:border-sys-cyan/45 hover:text-sys-text"
                    >
                      Review
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
