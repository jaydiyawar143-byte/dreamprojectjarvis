"use client";

// ---------------------------------------------------------------------------
// PHASE 10.7 — Approvals page: pending list, status filters, pagination.
// Data comes exclusively from the authenticated approval API; no secrets are
// ever present in these payloads or stored client-side.
//
// Phase 17 — "Waiting for your decision": other members' changes to an
// Organization's shared connection, for an owner or admin of that
// Organization to approve. The server decides who sees them (`scope=review`);
// an account that is nobody's approver gets an empty list and sees no section.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import {
  listApprovals,
  type ApprovalRecord,
  type ApprovalStatusValue,
} from "@/lib/api";
import { ApprovalCard } from "@/components/approval-card";

const FILTERS: Array<{ key: ApprovalStatusValue | "all"; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "consumed", label: "Consumed" },
  { key: "rejected", label: "Rejected" },
  { key: "expired", label: "Expired" },
  { key: "all", label: "All" },
];

export default function ApprovalsPage() {
  const [filter, setFilter] = useState<ApprovalStatusValue | "all">("pending");
  const [items, setItems] = useState<ApprovalRecord[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (status: ApprovalStatusValue | "all", p: number) => {
      setLoading(true);
      setError(null);
      const res = await listApprovals(
        status === "all" ? undefined : status,
        p
      );
      if (res.success && res.data) {
        setItems(res.data);
        setTotalPages(res.pagination?.totalPages ?? 1);
      } else {
        setError(res.error?.message ?? "Failed to load approvals");
      }
      setLoading(false);
    },
    []
  );

  useEffect(() => {
    void load(filter, page);
  }, [filter, page, load]);

  const [review, setReview] = useState<ApprovalRecord[]>([]);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const loadReview = useCallback(async () => {
    const res = await listApprovals(undefined, 1, 20, "review");
    if (res.success && res.data) {
      setReview(res.data);
      setReviewError(null);
    } else {
      // Said, not hidden: an approver who is not told the list failed would
      // read it as nothing waiting for them.
      setReview([]);
      setReviewError(res.error?.message ?? "Failed to load the approvals waiting for you");
    }
  }, []);

  useEffect(() => {
    void loadReview();
  }, [loadReview]);

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">Approvals</h1>
      <p className="text-sm text-gray-400">
        Review what JARVIS wants to do before it acts. Approving authorizes the
        exact parameters shown — exactly once. To change anything, reject and
        start a new proposal.
      </p>

      {(review.length > 0 || reviewError) && (
        <section data-testid="approvals-review" className="space-y-3">
          <h2 className="text-sm font-semibold">Waiting for your decision</h2>
          <p className="text-xs text-gray-400">
            Changes other members of your organization asked for. Once you
            approve one, the person who asked can run it once.
          </p>
          {reviewError && (
            <p data-testid="approvals-review-error" role="alert" className="text-sm text-red-400">
              {reviewError}
            </p>
          )}
          {review.map((a) => (
            <ApprovalCard
              key={a.approvalId}
              approval={a}
              onChanged={() => void loadReview()}
            />
          ))}
        </section>
      )}

      {(review.length > 0 || reviewError) && (
        <h2 className="text-sm font-semibold">Your requests</h2>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            data-testid={`filter-${f.key}`}
            onClick={() => {
              setFilter(f.key);
              setPage(1);
            }}
            className={`rounded px-2 py-1 text-xs ${
              filter === f.key
                ? "bg-blue-700 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && (
        <p data-testid="approvals-loading" className="text-sm text-gray-500">
          Loading approvals…
        </p>
      )}
      {error && (
        <p data-testid="approvals-error" role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {!loading && !error && items.length === 0 && (
        <p data-testid="approvals-empty" className="text-sm text-gray-500">
          No approvals in this view.
        </p>
      )}

      <div className="space-y-3">
        {items.map((a) => (
          <ApprovalCard
            key={a.approvalId}
            approval={a}
            onChanged={() => void load(filter, page)}
          />
        ))}
      </div>

      {(totalPages > 1 || page > 1) && (
        <div className="flex items-center justify-between pt-2">
          <button
            data-testid="prev-page"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(p - 1, 1))}
            className="rounded bg-gray-800 px-3 py-1 text-xs disabled:opacity-40"
          >
            Previous
          </button>
          <span data-testid="page-indicator" className="text-xs text-gray-500">
            Page {page} of {totalPages}
          </span>
          <button
            data-testid="next-page"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded bg-gray-800 px-3 py-1 text-xs disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </main>
  );
}
