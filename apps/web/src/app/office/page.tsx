"use client";

// ---------------------------------------------------------------------------
// VO-1 — the Virtual Office tab.
//
// Three reads, all already authenticated and already used elsewhere:
//
//   GET /agents    which agents this deployment actually registered
//   GET /tasks     the task engine's PENDING / RUNNING / COMPLETED work
//   GET /activity  the newest audit rows, already redacted at write time
//
// The page does not fetch during render, derive state inline, or hold a second
// copy of any of them: `buildOfficeModel` is the one derivation, and the scene
// only paints what it returns.
//
// WHAT THIS PAGE DOES NOT DO. It does not run anything, approve anything, or
// write anything. It has no confirm control, because the office is a window,
// not an authority.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";

import {
  listActivity,
  listAgents,
  listWorkTasks,
} from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useOfficeStream } from "@/lib/use-office-stream";

import { PageContainer, PageHeader, PanelGrid } from "@/components/dashboard/page-container";
import { Panel, StatPanel } from "@/components/dashboard/panel";
import { ErrorState, LoadingState } from "@/components/dashboard/states";
import { Button } from "@/components/ui/primitives";

import {
  applyTaskOverlay,
  buildOfficeModel,
  findOfficeActor,
  mergeOfficeActivity,
  overlayTaskCounts,
  parseTaskStatusCounts,
} from "@/components/office/office-model";
import { OfficeScene } from "@/components/office/office-scene";
import { OfficeSelectionPanel } from "@/components/office/office-selection-panel";
import { OfficeLegend } from "@/components/office/office-legend";
import { OfficeRoster } from "@/components/office/office-roster";
import { OfficeEventList } from "@/components/office/office-event-list";
import { OfficeStreamStatus } from "@/components/office/office-stream-status";

export default function OfficePage() {
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);
  // Recomputed on this clock so the "just finished" / "waiting" windows expire
  // without a reload. It is presentation time, not a new fact.
  const [clock, setClock] = useState(() => Date.now());

  const agents = useResource(listAgents, [], {
    fallbackError: "Could not load the agent registry.",
  });
  const tasks = useResource(listWorkTasks, [], {
    fallbackError: "Could not load the task queue.",
  });
  const activity = useResource(() => listActivity({ limit: 40 }), [], {
    fallbackError: "Could not load recent activity.",
  });

  function reloadAll(): void {
    void agents.reload();
    void tasks.reload();
    void activity.reload();
  }

  const stream = useOfficeStream({ onReconnect: reloadAll });

  // VO-2.1 — Refresh re-reads everything AND brings back a live feed that gave
  // up, so "offline" is never a state only a page reload can leave.
  function refresh(): void {
    reloadAll();
    stream.reconnect();
  }

  useEffect(() => {
    const ticker = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(ticker);
  }, []);

  // A task event tells us the status changed, but not the title — that lives
  // only in the durable read. Reload after a quiet moment rather than once per
  // event, so a burst of lifecycle changes is one request.
  useEffect(() => {
    if (stream.taskRevision === 0) return;
    const timer = setTimeout(() => {
      void tasks.reload();
    }, 600);
    return () => clearTimeout(timer);
  }, [stream.taskRevision, tasks.reload]);

  const mergedActivity = useMemo(
    () => mergeOfficeActivity(activity.data?.entries ?? [], stream.events),
    [activity.data, stream.events]
  );

  const overlaidTasks = useMemo(
    () => applyTaskOverlay(tasks.data?.tasks ?? [], stream.taskUpdates),
    [tasks.data, stream.taskUpdates]
  );

  // VO-2.1 — the counts are the server's totals, not the length of a capped
  // list. Live moves of listed tasks adjust them until the next read.
  const taskCounts = useMemo(() => {
    const totals = parseTaskStatusCounts(tasks.data?.statusCounts);
    return totals ? overlayTaskCounts(totals, tasks.data?.tasks ?? [], overlaidTasks) : null;
  }, [tasks.data, overlaidTasks]);

  const model = useMemo(
    () =>
      buildOfficeModel({
        agents: agents.data?.agents ?? [],
        tasks: overlaidTasks,
        taskCounts,
        activity: mergedActivity,
        now: clock,
      }),
    [agents.data, overlaidTasks, taskCounts, mergedActivity, clock]
  );

  const selection = findOfficeActor(model, selectedActorId);

  const firstLoad =
    (agents.loading && !agents.loaded) ||
    (tasks.loading && !tasks.loaded) ||
    (activity.loading && !activity.loaded);

  const error = agents.error ?? tasks.error ?? activity.error;

  return (
    <PageContainer>
      <PageHeader
        title="Virtual Office"
        description="A 2D floor plan of the agents registered on this deployment, the task engine's real queue, and the newest audit records. Live events arrive while this tab is open; Refresh re-reads everything. Movement is decorative; the activity table is the record."
        actions={
          <Button variant="secondary" size="sm" onClick={refresh}>
            Refresh
          </Button>
        }
      />

      {firstLoad && <LoadingState label="Reading the registry, task queue and recent activity…" />}

      {error && (
        <ErrorState
          title="Could not open the office"
          message={error}
          onRetry={reloadAll}
        />
      )}

      {!firstLoad && !error && (
        <div data-testid="office-page" className="space-y-4">
          <div className="max-w-xl">
            <OfficeStreamStatus status={stream.status} />
          </div>

          <PanelGrid columns={3}>
            <StatPanel
              label="Agents on the floor"
              value={model.counts.availableAgents}
              hint={
                model.counts.unavailableAgents === 0
                  ? "Every declared agent is registered"
                  : `${model.counts.unavailableAgents} declared but not registered`
              }
            />
            <StatPanel
              label="Running tasks"
              value={model.counts.running}
              hint={
                model.counts.tasksAreTotals
                  ? "Every RUNNING task in the task engine"
                  : "RUNNING among the newest tasks read; this API sent no totals"
              }
              tone={model.counts.running > 0 ? "success" : "default"}
            />
            <StatPanel
              label="Queued tasks"
              value={model.counts.pending}
              hint={
                model.counts.tasksAreTotals
                  ? "Every PENDING task in the task engine"
                  : "PENDING among the newest tasks read; this API sent no totals"
              }
              tone={model.counts.pending > 0 ? "warning" : "default"}
            />
          </PanelGrid>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="min-w-0 space-y-4">
              <Panel
                title="Floor plan"
                description="Six departments. Only agents registered in this process are drawn."
              >
                <OfficeScene
                  model={model}
                  selectedActorId={selectedActorId}
                  onSelectActor={setSelectedActorId}
                />
              </Panel>

              <OfficeLegend />
            </div>

            <div className="min-w-0">
              <OfficeSelectionPanel
                selection={selection}
                onClear={() => setSelectedActorId(null)}
              />
            </div>
          </div>

          <OfficeRoster
            agents={model.agents}
            unavailable={model.unavailableAgents}
          />

          <OfficeEventList events={model.events} />
        </div>
      )}
    </PageContainer>
  );
}
