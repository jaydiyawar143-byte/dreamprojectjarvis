"use client";

// ---------------------------------------------------------------------------
// Phase 11.9B — Opportunity Queue Page
//
// Shows the ranked list of opportunities for human review.
// No writes. No execution. No automatic approval.
// "Review Recommendation" navigates to the detail page → then to the
// existing approval flow.
//
// Language guardrails:
//   "Recommended because…" not "JARVIS guarantees…"
//   "Historical evidence suggests…" not "Will improve performance by…"
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  listOpportunities,
  type OpportunityQueueItem,
  type OpportunityPriority,
  type NoOpportunityExplanation,
} from "@/lib/api";
import { OpportunityCard } from "@/components/opportunity-card";

// ---------------------------------------------------------------------------
// Filter config
// ---------------------------------------------------------------------------

const PRIORITY_FILTERS: Array<{ key: OpportunityPriority | "ALL"; label: string }> = [
  { key: "ALL",      label: "All" },
  { key: "CRITICAL", label: "🔴 Critical" },
  { key: "HIGH",     label: "🟠 High" },
  { key: "MEDIUM",   label: "🟡 Medium" },
  { key: "LOW",      label: "🔵 Low" },
];

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function OpportunitiesPage() {
  const [priorityFilter, setPriorityFilter] = useState<OpportunityPriority | "ALL">("ALL");
  const [items, setItems] = useState<OpportunityQueueItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursors, setCursors] = useState<string[]>([]); // stack for back-navigation
  const [totalEligible, setTotalEligible] = useState(0);
  const [ineligibleCount, setIneligibleCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noOpportunity, setNoOpportunity] = useState<NoOpportunityExplanation | null>(null);

  const load = useCallback(
    async (priority: OpportunityPriority | "ALL", cursor?: string) => {
      setLoading(true);
      setError(null);
      setNoOpportunity(null);

      const res = await listOpportunities({
        priority: priority !== "ALL" ? priority : undefined,
        limit: 20,
        cursor,
      });

      if (res.success) {
        setItems(res.items ?? []);
        setNextCursor(res.nextCursor ?? null);
        setTotalEligible(res.totalEligible ?? 0);
        setIneligibleCount(res.ineligibleCount ?? 0);
        if (res.items?.length === 0) {
          setNoOpportunity(res.noOpportunity ?? null);
        }
      } else {
        setError(res.error?.message ?? "Failed to load opportunities");
      }

      setLoading(false);
    },
    []
  );

  useEffect(() => {
    void load(priorityFilter);
    setCursors([]);
    setNextCursor(null);
  }, [priorityFilter, load]);

  function handlePriorityChange(p: OpportunityPriority | "ALL") {
    setPriorityFilter(p);
  }

  function handleNext() {
    if (!nextCursor) return;
    setCursors((prev) => [...prev, nextCursor]);
    void load(priorityFilter, nextCursor);
  }

  function handlePrev() {
    const prevCursors = cursors.slice(0, -1);
    const cursor = prevCursors[prevCursors.length - 1];
    setCursors(prevCursors);
    void load(priorityFilter, cursor);
  }

  const currentPage = cursors.length + 1;

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      {/* Page header */}
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-white tracking-tight">
          Opportunity Queue
        </h1>
        <p className="text-sm text-gray-400 max-w-xl">
          Ranked opportunities for human review. JARVIS has detected performance
          anomalies and generated recommendations — but{" "}
          <strong className="text-gray-300">you decide</strong> whether any action
          should proceed. Reviewing an opportunity does not approve it.
        </p>
      </div>

      {/* Stats bar */}
      {!loading && !error && (
        <div
          data-testid="queue-stats"
          className="flex flex-wrap gap-4 rounded-xl bg-white/5 border border-white/10 px-5 py-3"
        >
          <div>
            <span className="text-xs text-gray-400">Actionable</span>
            <p className="text-lg font-bold text-white">{totalEligible}</p>
          </div>
          <div className="border-l border-white/10 pl-4">
            <span className="text-xs text-gray-400">Ineligible / skipped</span>
            <p className="text-lg font-bold text-gray-400">{ineligibleCount}</p>
          </div>
          <div className="border-l border-white/10 pl-4">
            <span className="text-xs text-gray-400">Shown</span>
            <p className="text-lg font-bold text-white">{items.length}</p>
          </div>
        </div>
      )}

      {/* Priority filter tabs */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Priority filter">
        {PRIORITY_FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            data-testid={`priority-filter-${f.key}`}
            aria-selected={priorityFilter === f.key}
            onClick={() => handlePriorityChange(f.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              priorityFilter === f.key
                ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20"
                : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white border border-white/10"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {loading && (
        <div
          data-testid="opportunities-loading"
          className="flex items-center gap-3 py-8 text-gray-400"
        >
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
          <span className="text-sm">Loading opportunities…</span>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div
          data-testid="opportunities-error"
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-4"
        >
          <p className="text-sm font-semibold text-red-400">Error</p>
          <p className="text-sm text-red-300 mt-1">{error}</p>
        </div>
      )}

      {/* No-opportunity state */}
      {!loading && !error && items.length === 0 && (
        <div
          data-testid="no-opportunities"
          className="rounded-xl border border-white/10 bg-white/5 px-6 py-8 text-center"
        >
          <p className="text-lg font-semibold text-gray-300 mb-2">
            No actionable opportunities found
          </p>
          {noOpportunity ? (
            <p className="text-sm text-gray-400 max-w-md mx-auto">
              {noOpportunity.message}
            </p>
          ) : (
            <p className="text-sm text-gray-400">
              No opportunities match the current filters. Try clearing the priority
              filter to see all opportunities.
            </p>
          )}
          {ineligibleCount > 0 && (
            <p className="text-xs text-gray-500 mt-3">
              {ineligibleCount} recommendation(s) were skipped (expired, stale, or
              already executed).
            </p>
          )}
        </div>
      )}

      {/* Opportunity list */}
      {!loading && !error && items.length > 0 && (
        <div className="space-y-4">
          {items.map((item, i) => (
            <OpportunityCard
              key={item.recommendationId}
              item={item}
              data-testid={`opportunity-card-${i}`}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && !error && (currentPage > 1 || nextCursor) && (
        <div
          data-testid="pagination"
          className="flex items-center justify-between pt-2"
        >
          <button
            data-testid="prev-page"
            disabled={currentPage <= 1}
            onClick={handlePrev}
            className="rounded-lg bg-white/5 border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ← Previous
          </button>
          <span
            data-testid="page-indicator"
            className="text-sm text-gray-500"
          >
            Page {currentPage}
          </span>
          <button
            data-testid="next-page"
            disabled={!nextCursor}
            onClick={handleNext}
            className="rounded-lg bg-white/5 border border-white/10 px-4 py-2 text-sm text-gray-300 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next →
          </button>
        </div>
      )}

      {/* Disclosure footer */}
      <div className="rounded-xl border border-white/5 bg-white/3 px-5 py-4 text-xs text-gray-500">
        <p className="font-semibold text-gray-400 mb-1">About these recommendations</p>
        <p>
          Opportunity scores express <em>relative priority</em> for human review — they
          are NOT success probabilities. Historical evidence is supporting context only;
          it does not guarantee future performance. All recommendations require your
          explicit approval before any action is taken on your Meta Ads account.
        </p>
        <p className="mt-2">
          <Link href="/approvals" className="text-indigo-400 hover:text-indigo-300 underline">
            View existing approval requests →
          </Link>
        </p>
      </div>
    </main>
  );
}
