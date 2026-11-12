// ---------------------------------------------------------------------------
// VO-1 — the model's honesty rules, pinned.
//
// These are the assertions a later visual change must not break:
//
//   * only registered agents are actors;
//   * a task run with no agent is JARVIS system work;
//   * an audit row with no agent (or one this deployment did not register) is
//     not attributed to anybody;
//   * an agent is never "working", "paused" or "72% done".
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import {
  applyTaskOverlay,
  buildOfficeModel,
  departmentForDomain,
  findOfficeActor,
  mergeOfficeActivity,
  OFFICE_DEPARTMENTS,
  overlayTaskCounts,
  parseTaskStatusCounts,
  RECENT_WINDOW_MS,
  WAITING_WINDOW_MS,
} from "../src/components/office/office-model";
import type { ActivityEntry, AgentSummary, TaskRecord, TaskStatusCounts } from "../src/lib/api";
import type { OfficeStreamEvent } from "@jarvis/core/office-stream";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  agentId: "knowledge-agent",
  domain: "knowledge",
  description: "Knowledge agent",
  allowedTools: [],
  toolCount: 0,
  writesRequireApproval: false,
  clientSelectable: true,
  registered: true,
  availability: "AVAILABLE",
  ...over,
});

const task = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "task-1",
  title: "Analyse the account",
  description: null,
  dueAt: null,
  priority: "NORMAL",
  completedAt: null,
  createdAt: at(-60_000),
  status: "PENDING",
  createdBy: "jarvis",
  scheduledAt: null,
  startedAt: null,
  error: null,
  ...over,
});

const activity = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: "audit-1",
  timestamp: at(-1_000),
  action: "tool.execute",
  result: "success",
  toolId: "meta.adsets",
  agentId: "knowledge-agent",
  ...over,
});

const build = (input: {
  agents?: AgentSummary[];
  tasks?: TaskRecord[];
  activity?: ActivityEntry[];
}) =>
  buildOfficeModel({
    agents: input.agents ?? [],
    tasks: input.tasks ?? [],
    activity: input.activity ?? [],
    now: NOW,
  });

describe("VO-1 office model — who is on the floor", () => {
  it("draws registered agents and puts unregistered ones outside the floor", () => {
    const model = build({
      agents: [
        agent({ agentId: "knowledge-agent", domain: "knowledge" }),
        agent({
          agentId: "google-ads-agent",
          domain: "google-ads",
          registered: false,
          availability: "UNAVAILABLE",
        }),
      ],
    });

    expect(model.agents.map((actor) => actor.id)).toEqual(["knowledge-agent"]);
    expect(model.unavailableAgents.map((entry) => entry.agentId)).toEqual([
      "google-ads-agent",
    ]);
    expect(model.counts).toMatchObject({ availableAgents: 1, unavailableAgents: 1 });

    const floorIds = model.departments.flatMap((department) =>
      department.actors.map((actor) => actor.id)
    );
    expect(floorIds).toEqual(["knowledge-agent"]);
    expect(floorIds).not.toContain("google-ads-agent");
  });

  it("places each published domain in a department", () => {
    expect(departmentForDomain("general")).toBe("command-center");
    expect(departmentForDomain("location")).toBe("command-center");
    expect(departmentForDomain("meta-ads")).toBe("marketing-hub");
    expect(departmentForDomain("google-ads")).toBe("marketing-hub");
    expect(departmentForDomain("marketing")).toBe("marketing-hub");
    expect(departmentForDomain("knowledge")).toBe("research-lab");
    expect(departmentForDomain("analytics")).toBe("research-lab");
    expect(departmentForDomain("automation")).toBe("development-lab");
    expect(departmentForDomain("browser")).toBe("development-lab");
    expect(departmentForDomain("desktop")).toBe("development-lab");
    expect(departmentForDomain("communication")).toBe("conference-room");
  });

  it("keeps the six departments, including an unstaffed break zone", () => {
    expect(OFFICE_DEPARTMENTS.map((department) => department.id)).toEqual([
      "command-center",
      "development-lab",
      "marketing-hub",
      "research-lab",
      "conference-room",
      "break-zone",
    ]);

    const model = build({ agents: [agent()] });
    const breakZone = model.departments.find((department) => department.id === "break-zone");
    expect(breakZone?.actors).toEqual([]);
  });
});

describe("VO-1 office model — what an agent's state may claim", () => {
  it("is idle and decorative when it has no activity", () => {
    const model = build({ agents: [agent()] });
    expect(model.agents[0]).toMatchObject({
      state: "idle",
      stateLabel: "Idle",
      decorative: true,
      lastActivityAt: null,
      lastSummary: null,
    });
  });

  it("is 'just finished' for a recent success, and stops being decorative", () => {
    const model = build({
      agents: [agent()],
      activity: [activity({ timestamp: at(-30_000), result: "success" })],
    });

    expect(model.agents[0]).toMatchObject({
      state: "recent",
      stateLabel: "Just finished",
      decorative: false,
      lastSummary: "Ran meta.adsets",
    });
  });

  it("is 'needs attention' for a recent failure or refusal", () => {
    for (const result of ["failure", "rejected"] as const) {
      const model = build({
        agents: [agent()],
        activity: [activity({ timestamp: at(-30_000), result })],
      });
      expect(model.agents[0].state).toBe("attention");
      expect(model.agents[0].decorative).toBe(false);
    }
  });

  it("is waiting only inside the short pending window, then falls back to idle", () => {
    const fresh = build({
      agents: [agent()],
      activity: [activity({ timestamp: at(-WAITING_WINDOW_MS + 1_000), result: "pending" })],
    });
    expect(fresh.agents[0].state).toBe("waiting");

    // Older than the window but still inside the "recent" window: the office
    // must not keep claiming a person is being waited on when it cannot check
    // the Approval table.
    const stale = build({
      agents: [agent()],
      activity: [activity({ timestamp: at(-RECENT_WINDOW_MS + 1_000), result: "pending" })],
    });
    expect(stale.agents[0].state).toBe("idle");
  });

  it("is idle once the activity is outside the recent window", () => {
    const model = build({
      agents: [agent()],
      activity: [activity({ timestamp: at(-RECENT_WINDOW_MS - 1_000) })],
    });
    expect(model.agents[0].state).toBe("idle");
    expect(model.agents[0].lastActivityAt).not.toBeNull();
  });

  it("never produces a working, paused or percentage state for an agent", () => {
    const model = build({
      agents: [agent()],
      activity: [activity()],
    });

    const allowed = new Set(["idle", "recent", "attention", "waiting"]);
    for (const actor of model.agents) {
      expect(allowed.has(actor.state)).toBe(true);
    }
    expect(JSON.stringify(model.agents)).not.toMatch(/paused|percent|progress/i);
  });
});

describe("VO-1 office model — the JARVIS system actor", () => {
  it("is working only when a task is really RUNNING", () => {
    const working = build({ tasks: [task({ status: "RUNNING", startedAt: at(-5_000) })] });
    expect(working.system).toMatchObject({ state: "working", running: 1 });
    expect(working.system.stateLabel).toContain("1 task");

    const queued = build({ tasks: [task({ status: "PENDING" })] });
    expect(queued.system).toMatchObject({ state: "queued", pending: 1 });

    const idle = build({ tasks: [task({ status: "COMPLETED", completedAt: at(-1_000) })] });
    expect(idle.system).toMatchObject({ state: "idle", pending: 0, running: 0, completed: 1 });
  });

  it("shows a task run as system work with no agent attribution", () => {
    const model = build({ tasks: [task({ status: "RUNNING", startedAt: at(-5_000) })] });
    const row = model.events.find((event) => event.source === "task");

    expect(row).toMatchObject({
      actorId: "jarvis",
      actorLabel: "JARVIS",
      actorKind: "system",
      attributed: false,
      result: "running",
    });
  });
});

describe("VO-1 office model — attribution", () => {
  it("attributes an audit row to a registered agent", () => {
    const model = build({
      agents: [agent()],
      activity: [activity({ agentId: "knowledge-agent" })],
    });
    const row = model.events.find((event) => event.source === "audit");

    expect(row).toMatchObject({
      actorId: "knowledge-agent",
      actorKind: "agent",
      attributed: true,
    });
  });

  it("shows an audit row with no agentId as JARVIS system work", () => {
    const model = build({
      agents: [agent()],
      activity: [activity({ agentId: undefined, toolId: "meta.adsets" })],
    });
    const row = model.events.find((event) => event.source === "audit");

    expect(row).toMatchObject({
      actorId: "jarvis",
      actorLabel: "JARVIS",
      actorKind: "system",
      attributed: false,
      summary: "Ran meta.adsets",
    });
  });

  it("does not attribute a row to an agent this deployment did not register", () => {
    const model = build({
      agents: [],
      activity: [activity({ agentId: "google-ads-agent" })],
    });
    const row = model.events.find((event) => event.source === "audit");

    expect(row).toMatchObject({ actorId: "jarvis", attributed: false });
  });

  it("never carries tool parameters, message text or a percentage into a row", () => {
    const model = build({
      agents: [agent()],
      activity: [
        activity({
          // A malicious or accidental payload on the wire must not be copied
          // into the office's summary.
          ...({ parameters: { secret: "should-not-appear" } } as object),
        }),
      ],
    });

    const serialized = JSON.stringify(model.events);
    expect(serialized).not.toContain("should-not-appear");
    expect(serialized).not.toContain("%");
  });
});

describe("VO-1 office model — ordering and selection", () => {
  it("orders combined rows newest first", () => {
    const model = build({
      agents: [agent()],
      tasks: [task({ status: "PENDING", createdAt: at(-10_000) })],
      activity: [
        activity({ id: "old", timestamp: at(-120_000) }),
        activity({ id: "new", timestamp: at(-1_000) }),
      ],
    });

    const times = model.events.map((event) => Date.parse(event.at));
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });

  it("finds an agent or the system actor by id, and nothing else", () => {
    const model = build({ agents: [agent()] });

    expect(findOfficeActor(model, "knowledge-agent")?.kind).toBe("agent");
    expect(findOfficeActor(model, "jarvis")?.kind).toBe("system");
    expect(findOfficeActor(model, "not-an-agent")).toBeNull();
    expect(findOfficeActor(model, null)).toBeNull();
  });
});

describe("VO-2 office model — live events", () => {
  const liveActivity = (over: Partial<Extract<OfficeStreamEvent, { kind: "activity" }>> = {}) =>
    ({
      kind: "activity",
      id: "live-1",
      at: at(-500),
      action: "tool.execute",
      result: "success",
      toolId: "meta.newtool",
      agentId: "knowledge-agent",
      ...over,
    }) as OfficeStreamEvent;

  it("merges a live audit row into the read without duplicating it", () => {
    const base = [activity({ id: "audit-1" })];
    const merged = mergeOfficeActivity(base, [liveActivity(), liveActivity()]);

    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.id).sort()).toEqual(["audit-1", "live-1"]);
    // Newest first.
    expect(merged[0].id).toBe("live-1");
  });

  it("lets the live copy replace a row the read already contained", () => {
    const base = [activity({ id: "audit-1", result: "pending" })];
    const merged = mergeOfficeActivity(base, [
      liveActivity({ id: "audit-1", result: "success", at: at(-100) }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].result).toBe("success");
    expect(merged[0].timestamp).toBe(at(-100));
  });

  it("does not copy an unknown field from a live event into a row", () => {
    const merged = mergeOfficeActivity([], [
      liveActivity({ parameters: { token: "secret" } } as unknown as Partial<
        Extract<OfficeStreamEvent, { kind: "activity" }>
      >),
    ]);

    expect(JSON.stringify(merged)).not.toContain("secret");
    expect(JSON.stringify(merged)).not.toContain("parameters");
  });

  it("applies a newer RUNNING transition and gives the row a start time", () => {
    const overlaid = applyTaskOverlay(
      [task({ status: "PENDING", createdAt: at(-60_000) })],
      new Map([
        [
          "task-1",
          {
            kind: "task",
            id: "task:task-1:RUNNING:live",
            at: at(-5_000),
            taskId: "task-1",
            status: "RUNNING",
          },
        ],
      ])
    );

    expect(overlaid[0].status).toBe("RUNNING");
    expect(overlaid[0].startedAt).toBe(at(-5_000));
  });

  it("refuses an overlay older than the row's last transition", () => {
    const completed = task({ status: "COMPLETED", completedAt: at(-1_000) });

    const overlaid = applyTaskOverlay(
      [completed],
      new Map([
        [
          "task-1",
          {
            kind: "task",
            id: "task:task-1:RUNNING:stale",
            at: at(-30_000),
            taskId: "task-1",
            status: "RUNNING",
          },
        ],
      ])
    );

    expect(overlaid[0].status).toBe("COMPLETED");
    expect(overlaid[0]).toBe(completed);
  });

  it("never adds a task the read did not include", () => {
    const overlaid = applyTaskOverlay(
      [],
      new Map([
        [
          "task-unknown",
          {
            kind: "task",
            id: "task:task-unknown:RUNNING:live",
            at: at(-5_000),
            taskId: "task-unknown",
            status: "RUNNING",
          },
        ],
      ])
    );

    expect(overlaid).toHaveLength(0);
  });

  it("turns a live RUNNING event into JARVIS working, never an agent", () => {
    const overlaid = applyTaskOverlay(
      [task({ status: "PENDING" })],
      new Map([
        [
          "task-1",
          {
            kind: "task",
            id: "task:task-1:RUNNING:live",
            at: at(-5_000),
            taskId: "task-1",
            status: "RUNNING",
          },
        ],
      ])
    );

    const model = buildOfficeModel({
      agents: [agent()],
      tasks: overlaid,
      activity: [],
      now: NOW,
    });

    expect(model.system.state).toBe("working");
    expect(model.system.attribution).toBe("system");
    expect(model.agents[0].state).not.toBe("working");
    expect(model.events.some((event) => event.summary === "Running: Analyse the account")).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// VO-2.1 (M2) — the counts are the task engine's totals
// ---------------------------------------------------------------------------

const totals = (over: Partial<TaskStatusCounts> = {}): TaskStatusCounts => ({
  PENDING: 0,
  RUNNING: 0,
  COMPLETED: 0,
  FAILED: 0,
  UNRESOLVED: 0,
  ...over,
});

describe("VO-2.1 office model — task totals", () => {
  it("counts the system actor from the server's totals, not the listed rows", () => {
    const model = buildOfficeModel({
      agents: [],
      // One listed RUNNING row; the server counted 75.
      tasks: [task({ status: "RUNNING", startedAt: at(-5_000) })],
      taskCounts: totals({ RUNNING: 75, PENDING: 12, COMPLETED: 300 }),
      activity: [],
      now: NOW,
    });

    expect(model.counts.running).toBe(75);
    expect(model.counts.pending).toBe(12);
    expect(model.counts.completed).toBe(300);
    expect(model.counts.tasksAreTotals).toBe(true);
    expect(model.system.state).toBe("working");
    expect(model.system.stateLabel).toBe("Working on 75 tasks");
    expect(model.system.countsAreTotals).toBe(true);
  });

  it("says work is queued from the totals even when no listed row is pending", () => {
    const model = buildOfficeModel({
      agents: [],
      tasks: [task({ status: "COMPLETED", completedAt: at(-1_000) })],
      taskCounts: totals({ PENDING: 3 }),
      activity: [],
      now: NOW,
    });

    expect(model.system.state).toBe("queued");
    expect(model.system.stateLabel).toBe("3 tasks queued");
  });

  it("falls back to the listed rows, and says so, when the API sent no totals", () => {
    const model = build({ tasks: [task({ status: "RUNNING", startedAt: at(-5_000) })] });

    expect(model.counts.running).toBe(1);
    expect(model.counts.tasksAreTotals).toBe(false);
    expect(model.system.countsAreTotals).toBe(false);
  });

  it("accepts only a complete set of non-negative whole totals", () => {
    expect(parseTaskStatusCounts(totals({ RUNNING: 4 }))).toEqual(totals({ RUNNING: 4 }));

    // All or nothing: a missing, negative, fractional or non-number state
    // refuses the whole value rather than guessing one state.
    const { FAILED: _omitted, ...missing } = totals();
    expect(parseTaskStatusCounts(missing)).toBeNull();
    expect(parseTaskStatusCounts(totals({ RUNNING: -1 }))).toBeNull();
    expect(parseTaskStatusCounts(totals({ RUNNING: 1.5 }))).toBeNull();
    expect(parseTaskStatusCounts({ ...totals(), RUNNING: "4" })).toBeNull();
    expect(parseTaskStatusCounts(totals({ RUNNING: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parseTaskStatusCounts(null)).toBeNull();
    expect(parseTaskStatusCounts([1, 2, 3, 4, 5])).toBeNull();
  });

  it("drops an unknown key and returns a fresh object", () => {
    const wire = { ...totals({ PENDING: 2 }), ARCHIVED: 9 };
    const parsed = parseTaskStatusCounts(wire);

    expect(parsed).toEqual(totals({ PENDING: 2 }));
    expect(parsed).not.toBe(wire);
    expect(Object.keys(parsed!)).not.toContain("ARCHIVED");
  });

  it("moves one total to another for a live transition of a listed task", () => {
    const before = [task({ id: "t-1", status: "PENDING" }), task({ id: "t-2", status: "PENDING" })];
    const after = applyTaskOverlay(
      before,
      new Map([
        [
          "t-1",
          {
            kind: "task" as const,
            id: "task:t-1:RUNNING:live",
            at: at(0),
            taskId: "t-1",
            status: "RUNNING" as const,
          },
        ],
      ])
    );

    expect(overlayTaskCounts(totals({ PENDING: 40, RUNNING: 7 }), before, after)).toEqual(
      totals({ PENDING: 39, RUNNING: 8 })
    );
  });

  it("leaves the totals alone when the overlay changed no listed state", () => {
    const before = [task({ id: "t-1", status: "RUNNING", startedAt: at(-1_000) })];

    expect(overlayTaskCounts(totals({ RUNNING: 5 }), before, before)).toEqual(
      totals({ RUNNING: 5 })
    );
  });

  it("never takes a total below zero", () => {
    const before = [task({ id: "t-1", status: "PENDING" })];
    const after = [task({ id: "t-1", status: "RUNNING" })];

    // Totals read a moment before the list, so they do not yet hold this row.
    expect(overlayTaskCounts(totals(), before, after)).toEqual(totals({ RUNNING: 1 }));
  });
});
