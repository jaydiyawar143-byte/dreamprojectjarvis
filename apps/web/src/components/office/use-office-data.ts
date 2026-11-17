"use client";

// ---------------------------------------------------------------------------
// VO-2.2 — the Virtual Office's data, in one place.
//
// Moved here unchanged from the old `/office` page so that the dashboard
// widget and its expanded view share ONE set of reads and ONE live
// subscription: the widget calls this hook once and hands the result to the
// dialog it opens. Opening the office therefore starts no second socket and no
// second round of requests.
//
// Three reads, all already authenticated and already used elsewhere:
//
//   GET /agents    which agents this deployment actually registered
//   GET /tasks     the task engine's work list and its per-state totals
//   GET /activity  the newest audit rows, already redacted at write time
//
// plus the office stream (`useOfficeStream`), which carries live audit and task
// events and renews its own session (VO-2.1). `buildOfficeModel` is still the
// one derivation; nothing here invents a state.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";

import { getOfficeAgentWork, listActivity, listAgents, listWorkTasks } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useOfficeStream, type OfficeStreamStatus } from "@/lib/use-office-stream";

import {
  applyTaskOverlay,
  buildOfficeModel,
  mergeOfficeActivity,
  overlayTaskCounts,
  parseTaskStatusCounts,
  type OfficeModel,
} from "./office-model";
import { overlayAgentWork, parseAgentWork } from "./office-lifecycle";

/**
 * VO-3.1 — audit actions after which who-is-waiting may have changed: a tool
 * call that stopped for approval, and a decision on one. The per-agent read is
 * re-read after them (debounced), because only the Approval table says who is
 * still waiting.
 */
function touchesApprovals(action: string, result: string): boolean {
  return (action === "tool.execute" && result === "pending") || action.startsWith("approval.");
}

/** How many audit rows the office reads. The model's event list keeps 40. */
export const OFFICE_ACTIVITY_LIMIT = 40;

export interface OfficeData {
  model: OfficeModel;
  streamStatus: OfficeStreamStatus;
  /** True until each of the three reads has answered at least once. */
  firstLoad: boolean;
  /** The first read error, if any. */
  error: string | null;
  /**
   * VO-3.1 — whether the per-agent task read is available. False on an API
   * without it, or while it fails: agents then show only what the audit rows
   * prove, and never claim to have no work.
   */
  agentWorkAvailable: boolean;
  /** Re-read the three sources. */
  reloadAll: () => void;
  /** Re-read everything AND bring back a live feed that gave up (VO-2.1). */
  refresh: () => void;
}

export function useOfficeData(): OfficeData {
  // Recomputed on this clock so the "just finished" / "waiting" windows expire
  // without a reload. It is presentation time, not a new fact.
  const [clock, setClock] = useState(() => Date.now());

  const agents = useResource(listAgents, [], {
    fallbackError: "Could not load the agent registry.",
  });
  const tasks = useResource(listWorkTasks, [], {
    fallbackError: "Could not load the task queue.",
  });
  const activity = useResource(() => listActivity({ limit: OFFICE_ACTIVITY_LIMIT }), [], {
    fallbackError: "Could not load recent activity.",
  });
  // VO-3.1 — what each agent is doing. NOT one of the reads the office needs
  // to open: an API without this route (or a failed read) leaves agents
  // speaking from the audit rows alone, exactly as in VO-1.
  const agentWork = useResource(getOfficeAgentWork, [], {
    fallbackError: "Could not load what each agent is doing.",
  });

  const reloadAgents = agents.reload;
  const reloadTasks = tasks.reload;
  const reloadActivity = activity.reload;
  const reloadAgentWork = agentWork.reload;

  const reloadAll = useCallback(() => {
    void reloadAgents();
    void reloadTasks();
    void reloadActivity();
    void reloadAgentWork();
  }, [reloadAgents, reloadTasks, reloadActivity, reloadAgentWork]);

  const stream = useOfficeStream({ onReconnect: reloadAll });
  const reconnect = stream.reconnect;

  const refresh = useCallback(() => {
    reloadAll();
    reconnect();
  }, [reloadAll, reconnect]);

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
      void reloadTasks();
      // VO-3.1 — the same quiet moment brings the per-agent read up to date:
      // titles, the claim, the queue count and the tool's risk live there.
      void reloadAgentWork();
    }, 600);
    return () => clearTimeout(timer);
  }, [stream.taskRevision, reloadTasks, reloadAgentWork]);

  // VO-3.1 — an approval was asked for or decided: re-read who is waiting.
  // Keyed on the newest such event's id, so a burst is one request.
  const newestApprovalEvent = useMemo(() => {
    const found = stream.events.find(
      (event) => event.kind === "activity" && touchesApprovals(event.action, event.result)
    );
    return found?.id ?? null;
  }, [stream.events]);

  useEffect(() => {
    if (!newestApprovalEvent) return;
    const timer = setTimeout(() => void reloadAgentWork(), 600);
    return () => clearTimeout(timer);
  }, [newestApprovalEvent, reloadAgentWork]);

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

  // VO-3.1 — the per-agent read, validated, with live task events applied on
  // top (newest per task, never older than the read).
  const liveAgentWork = useMemo(() => {
    const parsed = parseAgentWork(agentWork.data);
    if (!parsed) return null;
    const titles = new Map(overlaidTasks.map((task) => [task.id, task.title]));
    const toolRisk = new Map<string, string>();
    for (const agent of agents.data?.agents ?? []) {
      for (const tool of agent.tools ?? []) if (tool.risk) toolRisk.set(tool.id, tool.risk);
    }
    return overlayAgentWork(parsed, stream.taskUpdates, { titles, toolRisk });
  }, [agentWork.data, overlaidTasks, agents.data, stream.taskUpdates]);

  const model = useMemo(
    () =>
      buildOfficeModel({
        agents: agents.data?.agents ?? [],
        tasks: overlaidTasks,
        taskCounts,
        activity: mergedActivity,
        agentWork: liveAgentWork,
        now: clock,
      }),
    [agents.data, overlaidTasks, taskCounts, mergedActivity, liveAgentWork, clock]
  );

  const firstLoad =
    (agents.loading && !agents.loaded) ||
    (tasks.loading && !tasks.loaded) ||
    (activity.loading && !activity.loaded);

  const error = agents.error ?? tasks.error ?? activity.error;

  // VO-3.1 — "live" only when the per-agent read answered with something it
  // could parse; otherwise agents speak from audit rows only, and the panel
  // says so rather than implying nobody has work.
  const agentWorkAvailable = liveAgentWork !== null;

  return {
    model,
    streamStatus: stream.status,
    firstLoad,
    error,
    agentWorkAvailable,
    reloadAll,
    refresh,
  };
}
