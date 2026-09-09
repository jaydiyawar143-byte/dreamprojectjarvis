"use client";

// ---------------------------------------------------------------------------
// UI V2 — Activity Center.
//
// The audit trail has been written since Phase 10 and read by nobody. This is
// the first surface on it.
//
// Scope is not a filter here: the server derives `userId` from the token and
// ignores any the client sends, so this page shows the operator's own actions
// and cannot be made to show anyone else's.
//
// Tool PARAMETERS are deliberately absent — the API does not return them. A
// timeline answers "what happened", and arguments are both the highest-variance
// field and the one most likely to carry something sensitive.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";

import { listActivity, type ActivityEntry, type ActivityResult } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { PageContainer, PageHeader } from "@/components/dashboard/page-container";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, DataTable, Tabs, type Tone } from "@/components/ui/primitives";

type ResultFilter = "all" | ActivityResult;

const RESULT_TONE: Record<ActivityResult, Tone> = {
  success: "ok",
  failure: "danger",
  rejected: "warn",
  pending: "info",
};

/** `tool.execute` reads better as "Tool execute" in a timeline column. */
function humanAction(action: string): string {
  const spaced = action.replace(/[._]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function ActivityPage() {
  const [result, setResult] = useState<ResultFilter>("all");

  const load = useCallback(
    () => listActivity({ limit: 100, ...(result === "all" ? {} : { result }) }),
    [result]
  );

  const activity = useResource(load, [result], {
    fallbackError: "Could not load your activity.",
  });

  const entries = activity.data?.entries ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Activity"
        description="Your own audit trail — every tool execution, approval decision and integration callback recorded against your account."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void activity.reload()}>
            Refresh
          </Button>
        }
      />

      <Tabs
        label="Filter activity by result"
        className="mb-4"
        value={result}
        onChange={setResult}
        options={[
          { value: "all", label: "All" },
          { value: "success", label: "Success" },
          { value: "failure", label: "Failure" },
          { value: "rejected", label: "Rejected" },
          { value: "pending", label: "Pending" },
        ]}
      />

      {activity.loading && !activity.loaded && <LoadingState label="Reading the audit trail…" />}

      {activity.error && (
        <ErrorState
          title="Could not load activity"
          message={activity.error}
          onRetry={() => void activity.reload()}
        />
      )}

      {activity.loaded && !activity.error && entries.length === 0 && (
        <EmptyState
          title="No activity yet"
          message={
            result === "all"
              ? "Nothing has been recorded against your account. Actions appear here as soon as you use the assistant."
              : `No ${result} entries in the most recent activity.`
          }
        />
      )}

      {activity.loaded && !activity.error && entries.length > 0 && (
        <Panel
          title="Recent activity"
          description={`${entries.length} ${entries.length === 1 ? "entry" : "entries"}, newest first`}
        >
          <DataTable<ActivityEntry>
            caption="Your recent activity, newest first"
            rows={entries}
            rowKey={(row) => row.id}
            columns={[
              {
                key: "when",
                header: "When",
                render: (row) => (
                  <span title={new Date(row.timestamp).toLocaleString()}>
                    {relativeTime(row.timestamp)}
                  </span>
                ),
              },
              {
                key: "action",
                header: "Action",
                render: (row) => (
                  <span className="text-white">{humanAction(row.action)}</span>
                ),
              },
              {
                key: "target",
                header: "Target",
                render: (row) => (
                  <span className="font-mono text-xs text-sys-dim">
                    {row.toolId ?? row.agentId ?? "—"}
                  </span>
                ),
              },
              {
                key: "result",
                header: "Result",
                render: (row) => <Badge tone={RESULT_TONE[row.result]}>{row.result}</Badge>,
              },
              {
                key: "duration",
                header: "Duration",
                numeric: true,
                render: (row) => (row.durationMs !== undefined ? `${row.durationMs} ms` : "—"),
              },
              {
                key: "trace",
                header: "Trace",
                render: (row) => (
                  <span
                    className="font-mono text-xs text-sys-dim"
                    title={row.traceId ?? undefined}
                  >
                    {row.traceId ? `${row.traceId.slice(0, 8)}…` : "—"}
                  </span>
                ),
              },
            ]}
          />
        </Panel>
      )}
    </PageContainer>
  );
}
