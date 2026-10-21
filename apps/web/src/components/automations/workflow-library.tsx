"use client";

// ---------------------------------------------------------------------------
// Phase 18.2 — the n8n workflow library, on the Automations page.
//
// A client of `/api/v1/n8n/library` and nothing more. Every request is the
// session's: no Organization, instance or cursor is ever sent, and the server
// refuses one that tries.
//
// WHAT IS SHOWN IS WHAT THE SERVER SAID.
//   • The state badge is the server's state. "Complete" appears only when the
//     server reports the last scan completed — never because a run ended or a
//     list looks full.
//   • A partial scan says the list may be incomplete; a failed run shows its
//     fixed reason; a stopped chain shows why it stopped.
//
// NO CONTROL THAT CANNOT DO ANYTHING. Sync and Continue appear only when the
// server says this reader may start one (`canSync`, from the Organization
// role), and are disabled while something runs. The server checks again on
// every start; hiding a button is never the check.
//
// NOTHING HERE ACTS ON A WORKFLOW. There is no activate, edit or run control:
// a library entry is an observation, and triggering stays the approval-gated
// assistant action.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getWorkflowLibraryStatus,
  listWorkflowLibrary,
  startWorkflowLibrarySync,
  type LibraryChainStatus,
  type LibraryContinuation,
  type LibraryPresenceFilter,
  type LibraryRun,
  type LibraryState,
  type LibraryStatus,
  type LibraryWorkflow,
} from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, DataTable, StatusDot, Tabs, type Tone } from "@/components/ui/primitives";
import { WorkflowInspectionPanel } from "./workflow-inspection";

export const LIBRARY_PAGE_SIZE = 25;
/** How often the status is read again while a sync runs. */
export const LIBRARY_POLL_MS = 4_000;

const STATE_LABEL: Record<LibraryState, { label: string; tone: Tone }> = {
  never_synced: { label: "Never synchronized", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  partial: { label: "Partial", tone: "warn" },
  complete: { label: "Complete", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
};

const CHAIN_LABEL: Record<LibraryChainStatus, { label: string; tone: Tone }> = {
  RUNNING: { label: "Running", tone: "info" },
  COMPLETE: { label: "Completed", tone: "ok" },
  STOPPED: { label: "Stopped", tone: "warn" },
  INTERRUPTED: { label: "Interrupted", tone: "warn" },
};

const RUN_TONE: Record<LibraryRun["status"], Tone> = {
  RUNNING: "info",
  PARTIAL: "warn",
  COMPLETE: "ok",
  FAILED: "danger",
};

const PRESENCE_TABS: Array<{ value: LibraryPresenceFilter; label: string }> = [
  { value: "current", label: "Current" },
  { value: "present", label: "Present" },
  { value: "missing", label: "Missing" },
  { value: "removed", label: "Removed" },
  { value: "all", label: "All" },
];

type ActiveFilter = "any" | "active" | "inactive";
const ACTIVE_TABS: Array<{ value: ActiveFilter; label: string }> = [
  { value: "any", label: "Any" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

/** Refusals that mean "not for you", not "broken". */
const UNAUTHORIZED_CODES = new Set(["NOT_AVAILABLE", "PERMISSION_DENIED"]);

const INPUT_CLASS = "sys-focus w-full rounded border border-sys-control bg-sys-edge/40 px-3 py-1.5 text-sm text-sys-text";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

/** A key for ONE click: a retry of that click reuses it; a new click gets a new one. */
function newIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function presenceTone(presence: LibraryWorkflow["presence"]): Tone {
  return presence === "present" ? "ok" : presence === "missing" ? "warn" : "neutral";
}

type SyncMode = "run" | "continue";

export function WorkflowLibrarySection() {
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [presence, setPresence] = useState<LibraryPresenceFilter>("current");
  const [active, setActive] = useState<ActiveFilter>("any");
  // Phase 18.3B — the entry whose sanitized structure is open, if any.
  const [inspecting, setInspecting] = useState<string | null>(null);

  const status = useResource(getWorkflowLibraryStatus, [], { fallbackError: "Could not load the workflow library's status." });
  const authorized = status.loaded && !status.error;
  const configured = status.data?.configured === true;

  const list = useResource(
    () =>
      listWorkflowLibrary({
        page,
        limit: LIBRARY_PAGE_SIZE,
        ...(search ? { search } : {}),
        presence,
        ...(active === "any" ? {} : { active: active === "active" }),
      }),
    [page, search, presence, active, authorized, configured],
    // Asked only once the server has said this reader may read a configured library.
    { enabled: authorized && configured, fallbackError: "Could not load the workflow library." }
  );

  // While a sync runs, read the status again; when it stops, read the list again.
  const state = status.data?.state;
  const previousState = useRef<LibraryState | undefined>(undefined);
  const reloadStatus = status.reload;
  const reloadList = list.reload;
  useEffect(() => {
    if (previousState.current === "running" && state !== undefined && state !== "running") void reloadList();
    previousState.current = state;
    if (state !== "running") return;
    const timer = setInterval(() => void reloadStatus(), LIBRARY_POLL_MS);
    return () => clearInterval(timer);
  }, [state, reloadStatus, reloadList]);

  // ---- starting a sync ------------------------------------------------------
  const [pending, setPending] = useState<SyncMode | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const [retry, setRetry] = useState<{ mode: SyncMode; key: string } | null>(null);

  const start = useCallback(
    async (mode: SyncMode, key: string) => {
      if (pending) return;
      setPending(mode);
      setNotice(null);
      const res = await startWorkflowLibrarySync({
        ...(mode === "continue" ? { continueUntilComplete: true } : {}),
        idempotencyKey: key,
      });
      setPending(null);
      if (res.success && res.data) {
        setRetry(null);
        const started = res.data;
        setNotice({
          tone: "info",
          text:
            started.mode === "run"
              ? started.resumed
                ? "A synchronization run started, continuing the unfinished scan."
                : "A synchronization run started."
              : started.state !== "running"
                ? `That synchronization already ended: ${started.state.toLowerCase()}.`
                : started.existing
                  ? "A continue-until-complete synchronization is already running."
                  : "Continuing until the scan completes, within its limits.",
        });
      } else {
        const code = res.error?.code ?? "";
        // The request may not have arrived: the same click may be tried again,
        // with the same key, and can never start a second chain.
        setRetry(code === "NETWORK_ERROR" ? { mode, key } : null);
        setNotice({ tone: "danger", text: res.error?.message ?? "The synchronization could not be started." });
      }
      await reloadStatus();
    },
    [pending, reloadStatus]
  );

  // ---- states ---------------------------------------------------------------
  if (status.loading && !status.loaded) {
    return (
      <Panel title="Workflow library" className="mt-4">
        <LoadingState label="Loading the workflow library…" />
      </Panel>
    );
  }

  if (status.error) {
    const code = status.errorCode ?? "";
    if (code === "NOT_FOUND") return null; // a server without the library router
    return (
      <Panel title="Workflow library" className="mt-4">
        {UNAUTHORIZED_CODES.has(code) ? (
          <EmptyState title="Not available to your account" message={status.error} />
        ) : (
          <ErrorState title="Could not load the workflow library" message={status.error} onRetry={() => void status.reload()} />
        )}
      </Panel>
    );
  }

  const view = status.data;
  if (!view) return null;

  if (!view.configured) {
    return (
      <Panel title="Workflow library" className="mt-4">
        <EmptyState
          title="n8n is not configured"
          message="This server has no n8n connection, so there is no workflow library to synchronize."
        />
      </Panel>
    );
  }

  const running = view.state === "running";
  const badge = STATE_LABEL[view.state];
  const rows = list.data?.items ?? [];
  const totalPages = list.data?.totalPages ?? 1;

  return (
    <div className="mt-4 space-y-4" data-testid="workflow-library">
      <Panel
        title="Workflow library"
        description="Workflows observed on your organization's n8n instance. An entry here is not permission to run it."
        action={
          <Badge tone={badge.tone} title="The server's synchronization state">
            {badge.label}
          </Badge>
        }
      >
        <SyncSummary view={view} />

        {view.canSync && (
          <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="library-sync-controls">
            <Button
              variant="secondary"
              size="sm"
              disabled={running || pending !== null}
              onClick={() => void start("run", newIdempotencyKey())}
            >
              {pending === "run" ? "Starting…" : "Sync"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={running || pending !== null}
              onClick={() => void start("continue", newIdempotencyKey())}
            >
              {pending === "continue" ? "Starting…" : "Continue until complete"}
            </Button>
            {retry && (
              <Button variant="ghost" size="sm" disabled={pending !== null} onClick={() => void start(retry.mode, retry.key)}>
                Try again
              </Button>
            )}
            {running && <span className="text-xs text-sys-dim">A synchronization is running.</span>}
          </div>
        )}
        {notice && (
          <p role="status" data-testid="library-sync-notice" className="mt-3 text-sm text-sys-text" data-tone={notice.tone}>
            {notice.text}
          </p>
        )}
      </Panel>

      {view.continuation && <ContinuationPanel chain={view.continuation} />}

      <Panel title="Workflows" description="Listing metadata only — no node parameters or credentials are stored.">
        <form
          className="mb-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setSearch(searchDraft.trim());
          }}
        >
          <label className="block min-w-[12rem] flex-1 space-y-1 text-xs text-sys-dim" htmlFor="library-search">
            <span>Search names, tags and node types</span>
            <input
              id="library-search"
              value={searchDraft}
              maxLength={100}
              onChange={(event) => setSearchDraft(event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
        <div className="mb-3 flex flex-wrap gap-3">
          <Tabs
            label="Presence"
            options={PRESENCE_TABS}
            value={presence}
            onChange={(next) => {
              setPage(1);
              setPresence(next);
            }}
          />
          <Tabs
            label="Active in n8n"
            options={ACTIVE_TABS}
            value={active}
            onChange={(next) => {
              setPage(1);
              setActive(next);
            }}
          />
        </div>

        {list.loading && !list.loaded ? (
          <LoadingState label="Loading workflows…" />
        ) : list.error ? (
          <ErrorState title="Could not load workflows" message={list.error} onRetry={() => void list.reload()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={view.state === "never_synced" ? "Not synchronized yet" : "No workflows match"}
            message={
              view.state === "never_synced"
                ? view.canSync
                  ? "Start a sync to read the workflow list from n8n."
                  : "An owner or admin of your organization can start a sync."
                : "Try another search or filter."
            }
          />
        ) : (
          <>
            <DataTable<LibraryWorkflow>
              caption="Workflows in the n8n workflow library"
              rows={rows}
              rowKey={(row) => row.externalId}
              columns={[
                {
                  key: "name",
                  header: "Workflow",
                  render: (row) => (
                    <div>
                      <p className="text-sm text-white">{row.name}</p>
                      <p className="mt-0.5 font-mono text-xs text-sys-dim">{row.externalId}</p>
                    </div>
                  ),
                },
                {
                  key: "active",
                  header: "In n8n",
                  render: (row) => <StatusDot tone={row.active ? "ok" : "neutral"} label={row.active ? "Active" : "Inactive"} />,
                },
                {
                  key: "presence",
                  header: "Seen",
                  render: (row) => <Badge tone={presenceTone(row.presence)}>{row.presence}</Badge>,
                },
                {
                  key: "tags",
                  header: "Tags",
                  render: (row) => <span className="text-sys-dim">{row.tags && row.tags.length > 0 ? row.tags.join(", ") : "—"}</span>,
                },
                { key: "nodes", header: "Nodes", numeric: true, render: (row) => row.nodeCount ?? "—" },
                { key: "lastSeen", header: "Last seen", render: (row) => when(row.lastSeenAt) },
                {
                  key: "inspect",
                  header: "Structure",
                  render: (row) => (
                    <Button size="sm" variant="ghost" aria-label={`Inspect ${row.name}`} onClick={() => setInspecting(row.externalId)}>
                      Inspect
                    </Button>
                  ),
                },
              ]}
            />
            <nav aria-label="Workflow library pages" className="mt-3 flex items-center justify-between gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Previous
              </Button>
              <span className="font-mono text-xs text-sys-dim" data-testid="library-page">
                Page {list.data?.page ?? page} of {totalPages} · {list.data?.total ?? 0} workflows
              </span>
              <Button size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </nav>
          </>
        )}
      </Panel>

      {inspecting && <WorkflowInspectionPanel key={inspecting} entryId={inspecting} onClose={() => setInspecting(null)} />}

      <Panel title="Recent synchronization runs" description="Newest first. Reasons are fixed sentences; no provider text is shown.">
        {view.runs.length === 0 ? (
          <EmptyState title="No runs yet" message="Runs appear here once a synchronization starts." />
        ) : (
          <DataTable<LibraryRun>
            caption="Recent workflow library synchronization runs, newest first"
            rows={view.runs}
            rowKey={(row) => row.runId}
            columns={[
              { key: "started", header: "Started", render: (row) => when(row.startedAt) },
              {
                key: "status",
                header: "Status",
                render: (row) => <Badge tone={RUN_TONE[row.status]}>{row.status.toLowerCase()}</Badge>,
              },
              { key: "pages", header: "Pages", numeric: true, render: (row) => row.pagesFetched },
              { key: "records", header: "Seen", numeric: true, render: (row) => row.recordsObserved },
              { key: "changes", header: "New / changed", numeric: true, render: (row) => `${row.created} / ${row.updated}` },
              {
                key: "reason",
                header: "Reason",
                render: (row) => <span className="text-sys-dim">{row.failure?.message ?? (row.resumed ? "Resumed the open scan" : "—")}</span>,
              },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}

function SyncSummary({ view }: { view: LibraryStatus }) {
  const latestFailure = view.state === "failed" ? view.runs.find((run) => run.failure)?.failure : undefined;
  return (
    <div className="space-y-2 text-sm text-sys-text" data-testid="library-summary">
      <p>
        <span className="tabular-nums">{view.catalog.present}</span> present ·{" "}
        <span className="tabular-nums">{view.catalog.missing}</span> missing from the last scan ·{" "}
        <span className="tabular-nums">{view.catalog.removed}</span> removed
      </p>
      <p className="text-sys-dim">
        {view.lastCompleteScan
          ? `Last complete scan: ${when(view.lastCompleteScan.completedAt)}, ${view.lastCompleteScan.records} workflows.`
          : "No scan has completed yet."}
      </p>
      {view.currentScan && (
        <p data-testid="library-progress" className={view.state === "partial" ? "text-amber-300" : "text-sys-dim"}>
          {view.state === "partial"
            ? `The current scan stopped before the end — ${view.currentScan.pagesFetched} pages, ${view.currentScan.recordsObserved} workflows read so far. The list may be incomplete; continue to finish it.`
            : `Current scan: ${view.currentScan.pagesFetched} pages, ${view.currentScan.recordsObserved} workflows read so far.`}
        </p>
      )}
      {latestFailure && (
        <p data-testid="library-failure" className="text-sys-danger">
          The last run failed: {latestFailure.message}
        </p>
      )}
    </div>
  );
}

function ContinuationPanel({ chain }: { chain: LibraryContinuation }) {
  const badge = CHAIN_LABEL[chain.status];
  return (
    <Panel
      title="Continue until complete"
      description={`Started ${when(chain.startedAt)}${chain.finishedAt ? ` · ended ${when(chain.finishedAt)}` : ""}`}
      action={<Badge tone={badge.tone}>{badge.label}</Badge>}
      data-testid="library-continuation"
    >
      <p className="text-sm text-sys-text">
        Runs {chain.runs} of {chain.limits.maxRuns} · pages {chain.pages} of {chain.limits.maxPages} · {chain.recordsObserved} workflows read
      </p>
      {chain.stop && <p className="mt-2 text-sm text-sys-dim">{chain.stop.message}</p>}
      {chain.runFailure && <p className="mt-1 text-sm text-sys-danger">{chain.runFailure.message}</p>}
    </Panel>
  );
}
