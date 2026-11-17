// ---------------------------------------------------------------------------
// VO-3.1 — the living office.
//
// Two layers, kept apart on purpose:
//
//   * the REAL layer — an agent's lifecycle, derived only from a RUNNING task
//     assigned to it, the Approval table, and its own audit rows. Pinned here
//     against `office-lifecycle.ts`, so a state can never come from a guess;
//   * the AMBIENT layer — coffee, water, lunch, the sofa, a chat, a stretch, a
//     walk, the washroom. A pure function of time, pinned here for determinism
//     and for the rule that real work interrupts it and returns the figure to
//     its desk before anything may look like typing.
//
// The panel and the floor are rendered from the same model, so the tests also
// pin what a person reads: the current task, the tool names and their risk,
// and the honesty notes.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import type { OfficeTaskEvent } from "@jarvis/core/office-stream";
import * as api from "../src/lib/api";
import { buildOfficeModel, type OfficeModel } from "../src/components/office/office-model";
import {
  DESK_BOUND,
  EXECUTING,
  QUEUE_HORIZON_MS,
  deriveLifecycle,
  overlayAgentWork,
  parseAgentWork,
  upcomingTask,
} from "../src/components/office/office-lifecycle";
import {
  AMBIENT_LABEL,
  CHAT_WINDOW_MS,
  ambientSlotAt,
  chatInWindow,
  personalSlotAt,
  slotLengths,
} from "../src/components/office/pixel/ambient";
import {
  INITIAL_MOTION,
  advanceMotion,
  resolveMotion,
  type MotionContext,
} from "../src/components/office/pixel/agent-motion";
import { agentVisual, placeAgents } from "../src/components/office/pixel/floor-plan";
import { OfficeScene } from "../src/components/office/office-scene";
import { OfficeSelectionPanel } from "../src/components/office/office-selection-panel";

const NOW = Date.parse("2026-11-14T10:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT = (over: Partial<api.AgentSummary> = {}): api.AgentSummary => ({
  agentId: "knowledge-agent",
  domain: "knowledge",
  description: "Knowledge agent",
  allowedTools: ["knowledge.search"],
  tools: [{ id: "knowledge.search", risk: "READ_ONLY" }],
  toolCount: 1,
  writesRequireApproval: false,
  clientSelectable: true,
  registered: true,
  availability: "AVAILABLE",
  ...over,
});

const TASK = (over: Partial<api.TaskRecord> = {}): api.TaskRecord => ({
  id: "task-1",
  title: "Analyse the account",
  description: null,
  dueAt: null,
  priority: "NORMAL",
  completedAt: null,
  createdAt: at(-60_000),
  status: "PENDING",
  createdBy: "jarvis",
  ...over,
});

const ENTRY = (over: Partial<api.ActivityEntry> = {}): api.ActivityEntry => ({
  id: "audit-1",
  timestamp: at(-30_000),
  action: "tool.execute",
  result: "success",
  agentId: "knowledge-agent",
  toolId: "knowledge.search",
  ...over,
});

const TASK_VIEW = (over: Partial<api.OfficeTaskView> = {}): api.OfficeTaskView => ({
  taskId: "task-1",
  title: "Analyse the account",
  status: "RUNNING",
  executionId: "exec-1",
  toolId: "knowledge.search",
  toolRisk: "READ_ONLY",
  assignedAt: at(-60_000),
  startedAt: at(-5_000),
  scheduledAt: null,
  claimed: false,
  finishedAt: null,
  error: null,
  ...over,
});

const WORK = (over: Partial<api.OfficeAgentWork> = {}): api.OfficeAgentWork => ({
  agentId: "knowledge-agent",
  active: null,
  queuedCount: 0,
  lastCompleted: null,
  lastFailed: null,
  pendingApprovals: null,
  ...over,
});

const WORK_VIEW = (over: Partial<api.OfficeAgentWorkView> = {}): api.OfficeAgentWorkView => ({
  agents: [],
  approvalsRead: true,
  generatedAt: at(0),
  ...over,
});

function model(input: {
  agents?: api.AgentSummary[];
  tasks?: api.TaskRecord[];
  activity?: api.ActivityEntry[];
  agentWork?: api.OfficeAgentWorkView | null;
  now?: number;
}): OfficeModel {
  return buildOfficeModel({
    agents: input.agents ?? [],
    tasks: input.tasks ?? [],
    activity: input.activity ?? [],
    taskCounts: null,
    agentWork: input.agentWork ?? null,
    now: input.now ?? NOW,
  });
}

// ---------------------------------------------------------------------------
// 1. Lifecycle, from durable facts only
// ---------------------------------------------------------------------------

describe("VO-3.1 — an agent's lifecycle has one source per state", () => {
  it("validates the server's per-agent read field by field", () => {
    expect(parseAgentWork(null)).toBeNull();
    expect(parseAgentWork({ agents: [] })).toBeNull(); // no generatedAt
    expect(parseAgentWork({ agents: "nope", generatedAt: at(0) })).toBeNull();

    const parsed = parseAgentWork({
      generatedAt: at(0),
      approvalsRead: true,
      agents: [
        { agentId: "" },
        "not an agent",
        {
          agentId: "knowledge-agent",
          active: { taskId: "task-1", title: "x".repeat(400), status: "RUNNING" },
          queuedCount: -3,
          pendingApprovals: { count: 0, newestAt: at(-1_000), toolId: "t", expiresAt: at(60_000) },
        },
      ],
    });

    expect(parsed).not.toBeNull();
    expect(parsed!.agents).toHaveLength(1);
    const agent = parsed!.agents[0]!;
    expect(agent.agentId).toBe("knowledge-agent");
    // A long title is the user's own words: shortened, never dropped.
    expect(agent.active!.title).toHaveLength(300);
    // A negative count is not a count.
    expect(agent.queuedCount).toBe(0);
    // An approval with a count of zero is no approval.
    expect(agent.pendingApprovals).toBeNull();
  });

  const derive = (
    work: api.OfficeAgentWork | null,
    over: Partial<Parameters<typeof deriveLifecycle>[0]> = {}
  ) => deriveLifecycle({ work, approvalsRead: true, auditState: "idle", now: NOW, ...over });

  it("says researching, using a tool or working only from a RUNNING task", () => {
    expect(derive(WORK({ active: TASK_VIEW() })).lifecycle).toBe("researching");
    expect(derive(WORK({ active: TASK_VIEW() })).label).toBe("Researching — knowledge.search");

    expect(
      derive(WORK({ active: TASK_VIEW({ toolId: "meta.adsets", toolRisk: "WRITE" }) })).lifecycle
    ).toBe("using_tool");
    expect(
      derive(WORK({ active: TASK_VIEW({ toolId: "meta.adsets", toolRisk: "WRITE" }) })).label
    ).toBe("Using meta.adsets");

    // A run recorded before VO-3.1 names no tool: it is still work, not a guess.
    expect(derive(WORK({ active: TASK_VIEW({ toolId: null, toolRisk: null }) })).lifecycle).toBe(
      "working"
    );
    expect(derive(WORK({ active: TASK_VIEW({ status: "PENDING" }) })).lifecycle).toBe("queued");
  });

  it("waits for a real, unexpired approval — never a stale one", () => {
    const approval = {
      count: 2,
      newestAt: at(-1_000),
      toolId: "meta.adsets",
      expiresAt: at(60_000),
    };
    const waiting = derive(WORK({ pendingApprovals: approval }));
    expect(waiting.lifecycle).toBe("waiting_for_approval");
    expect(waiting.label).toBe("Waiting for 2 approvals");

    // Expired: the approval no longer holds the agent.
    expect(derive(WORK({ pendingApprovals: { ...approval, expiresAt: at(-1) } })).lifecycle).toBe(
      "idle"
    );

    // While approvals cannot be read, the audit heuristic stands in.
    expect(
      derive(WORK(), { approvalsRead: false, auditState: "waiting" }).lifecycle
    ).toBe("waiting_for_approval");
  });

  it("distinguishes a claimed task from one still waiting for its time", () => {
    const scheduled = TASK_VIEW({
      status: "PENDING",
      scheduledAt: at(QUEUE_HORIZON_MS - 1_000),
      claimed: false,
    });
    expect(derive(WORK({ active: scheduled })).lifecycle).toBe("queued");

    expect(derive(WORK({ active: { ...scheduled, claimed: true } })).lifecycle).toBe("assigned");

    // Beyond the horizon it is not queued yet — the panel says "next scheduled".
    const later = { ...scheduled, scheduledAt: at(QUEUE_HORIZON_MS + 60_000) };
    expect(derive(WORK({ active: later })).lifecycle).toBe("idle");
    expect(upcomingTask(WORK({ active: later }), NOW)?.taskId).toBe("task-1");
    expect(upcomingTask(WORK({ active: scheduled }), NOW)).toBeNull();
  });

  it("reports a completion or a failure only inside the recent window, newest first", () => {
    const completed = TASK_VIEW({ status: "COMPLETED", finishedAt: at(-60_000) });
    const failed = TASK_VIEW({ status: "FAILED", finishedAt: at(-30_000) });

    expect(derive(WORK({ lastCompleted: completed })).lifecycle).toBe("completed");
    expect(derive(WORK({ lastFailed: failed })).lifecycle).toBe("failed");
    // The newer outcome speaks.
    expect(derive(WORK({ lastCompleted: completed, lastFailed: failed })).lifecycle).toBe("failed");
    // Too old to claim.
    expect(
      derive(WORK({ lastFailed: { ...failed, finishedAt: at(-11 * 60_000) } })).lifecycle
    ).toBe("idle");
  });

  it("falls back to the audit rows for a conversational turn, and otherwise stays idle", () => {
    expect(derive(null, { auditState: "recent" }).lifecycle).toBe("completed");
    expect(derive(null, { auditState: "attention" }).lifecycle).toBe("failed");
    expect(derive(null).lifecycle).toBe("idle");
  });

  it("puts only real work at the desk, and only executing states on the keyboard", () => {
    expect([...DESK_BOUND].sort()).toEqual(
      ["assigned", "failed", "queued", "researching", "using_tool", "waiting_for_approval", "working"].sort()
    );
    expect([...EXECUTING].sort()).toEqual(["researching", "using_tool", "working"].sort());
    expect(DESK_BOUND.has("idle")).toBe(false);
    expect(EXECUTING.has("completed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Live task events, on top of the read
// ---------------------------------------------------------------------------

describe("VO-3.1 — a live task event moves the right agent, and only forward", () => {
  const context = {
    titles: new Map([["task-1", "Analyse the account"]]),
    toolRisk: new Map([["meta.adsets", "WRITE"]]),
  };
  const event = (over: Partial<OfficeTaskEvent> = {}): OfficeTaskEvent => ({
    kind: "task",
    id: "task:task-1:RUNNING:1",
    at: at(1_000),
    taskId: "task-1",
    status: "RUNNING",
    agentId: "knowledge-agent",
    ...over,
  });

  it("applies a RUNNING event newer than the read, and derives work from it", () => {
    const next = overlayAgentWork(
      WORK_VIEW(),
      new Map([["task-1", event({ toolId: "meta.adsets" })]]),
      context
    )!;
    const work = next.agents.find((agent) => agent.agentId === "knowledge-agent")!;
    expect(work.active?.taskId).toBe("task-1");
    expect(work.active?.title).toBe("Analyse the account");
    expect(work.active?.toolId).toBe("meta.adsets");
    expect(work.active?.toolRisk).toBe("WRITE");
    expect(deriveLifecycle({ work, approvalsRead: true, auditState: "idle", now: NOW }).lifecycle).toBe(
      "using_tool"
    );
  });

  it("ignores an event the read already covers", () => {
    const next = overlayAgentWork(
      WORK_VIEW({ generatedAt: at(5_000) }),
      new Map([["task-1", event({ at: at(1_000) })]]),
      context
    )!;
    expect(next.agents).toHaveLength(0);
  });

  it("clears the running task on a finish and records the outcome", () => {
    const read = WORK_VIEW({
      agents: [WORK({ active: TASK_VIEW() })],
      generatedAt: at(0),
    });
    const next = overlayAgentWork(
      read,
      new Map([["task-1", event({ id: "task:task-1:COMPLETED:2", status: "COMPLETED" })]]),
      context
    )!;
    const work = next.agents.find((agent) => agent.agentId === "knowledge-agent")!;
    expect(work.active).toBeNull();
    expect(work.lastCompleted?.taskId).toBe("task-1");
    expect(work.lastCompleted?.finishedAt).toBe(at(1_000));
    expect(deriveLifecycle({ work, approvalsRead: true, auditState: "idle", now: NOW }).lifecycle).toBe(
      "completed"
    );
  });

  it("takes a task off an agent it no longer belongs to", () => {
    const read = WORK_VIEW({
      agents: [WORK({ agentId: "knowledge-agent", active: TASK_VIEW() })],
      generatedAt: at(0),
    });
    const next = overlayAgentWork(
      read,
      new Map([["task-1", event({ agentId: "analytics-agent" })]]),
      context
    )!;
    expect(next.agents.find((agent) => agent.agentId === "knowledge-agent")!.active).toBeNull();
    expect(next.agents.find((agent) => agent.agentId === "analytics-agent")!.active?.taskId).toBe(
      "task-1"
    );
  });

  it("never gives a task to an agent the event does not name", () => {
    const next = overlayAgentWork(
      WORK_VIEW(),
      new Map([["task-1", event({ agentId: undefined })]]),
      context
    )!;
    expect(next.agents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The ambient layer is deterministic, and never puts an agent in two places
// ---------------------------------------------------------------------------

describe("VO-3.1 — ambient activity is a pure function of time", () => {
  it("gives the same instant the same activity, and each agent its own rhythm", () => {
    const first = ambientSlotAt("knowledge-agent", ["knowledge-agent", "analytics-agent"], NOW);
    expect(ambientSlotAt("knowledge-agent", ["knowledge-agent", "analytics-agent"], NOW)).toEqual(
      first
    );
    expect(slotLengths("knowledge-agent")).not.toEqual(slotLengths("analytics-agent"));

    // Every activity has words, and they are presented as decorative.
    for (const activity of Object.keys(AMBIENT_LABEL)) {
      expect(AMBIENT_LABEL[activity as keyof typeof AMBIENT_LABEL]).toBeTruthy();
    }
    expect(AMBIENT_LABEL.desk).toContain("workstation");
  });

  it("pairs a conversation with another idle agent, in the meeting room", () => {
    const ids = ["analytics-agent", "knowledge-agent", "marketing-agent"];
    let found = 0;

    for (let window = 0; window < 24 * 60 && found === 0; window += 1) {
      const t = window * CHAT_WINDOW_MS + 60_000;
      const chat = chatInWindow(ids, t);
      if (!chat) continue;
      const slot = ambientSlotAt(chat.pair[0], ids, t);
      expect(slot.activity).toBe("chat");
      expect(slot.partner).toBe(chat.pair[1]);
      expect(slot.place).toBe("chat-a");
      expect(ambientSlotAt(chat.pair[1], ids, t).place).toBe("chat-b");
      found += 1;
    }

    expect(found).toBe(1);
  });

  it("spends a personal break at the desk when it would overlap a conversation", () => {
    const ids = ["analytics-agent", "knowledge-agent", "marketing-agent"];
    let found = 0;

    for (let t = NOW; t < NOW + 24 * 60 * 60_000 && found === 0; t += 30_000) {
      const personal = personalSlotAt("knowledge-agent", t);
      if (!personal.place) continue;
      const actual = ambientSlotAt("knowledge-agent", ids, t);
      // VO-3.1.1 — a break also becomes desk time when its place is full or it
      // crosses an occupancy epoch; `office-ambient-occupancy-vo311` verifies
      // those. A break that says it yielded to a conversation must overlap one.
      if (actual.activity !== "desk" || actual.yielded !== "conversation") continue;
      const overlapping = [-1, 0, 1].flatMap((delta) => {
        const chat = chatInWindow(ids, t + delta * CHAT_WINDOW_MS);
        return chat &&
          chat.pair.includes("knowledge-agent") &&
          chat.start < personal.end &&
          personal.start < chat.end
          ? [chat]
          : [];
      });
      expect(overlapping.length).toBeGreaterThan(0);
      found += 1;
    }

    expect(found).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Real work interrupts the break, returns the figure, and only then types
// ---------------------------------------------------------------------------

describe("VO-3.1 — real work always wins over decoration", () => {
  const placed = placeAgents(model({ agents: [AGENT()] }));
  const seat = { x: placed[0]!.x, y: placed[0]!.y };
  const ctx: MotionContext = {
    agentId: "knowledge-agent",
    seat,
    agentIds: ["analytics-agent", "knowledge-agent", "marketing-agent"],
    ambientEnabled: true,
  };

  /**
   * The context of a scene that draws this agent alone. Since VO-3.1.1 where a
   * figure stands depends on who else is in the office (spots are shared out),
   * so a rendered one-agent scene must be predicted with a one-agent context.
   */
  const sceneCtx: MotionContext = { ...ctx, agentIds: ["knowledge-agent"] };

  /** A deterministic instant at which the agent is at a break place. */
  function awayAt(context: MotionContext = ctx): number {
    for (let t = NOW; t < NOW + 60 * 60_000; t += 5_000) {
      const motion = resolveMotion(INITIAL_MOTION, context, t);
      if (motion.phase === "away") return t;
    }
    throw new Error("no ambient break found in the first hour");
  }

  it("walks back from a break the moment work arrives, and sits on arrival", () => {
    const t = awayAt();
    const before = resolveMotion(INITIAL_MOTION, ctx, t);
    expect(before.phase).toBe("away");
    expect(before.point).not.toEqual(seat);

    const interrupted = advanceMotion(INITIAL_MOTION, ctx, true, t);
    expect(interrupted.deskBoundSince).toBe(t);

    const returning = resolveMotion(interrupted, ctx, t);
    expect(returning.phase).toBe("returning");
    expect(returning.ambient).toBeNull();
    expect(returning.point).not.toEqual(seat);

    // Find the arrival, then the figure is seated and nothing decorative remains.
    let arrival = t;
    while (arrival < t + 60_000 && resolveMotion(interrupted, ctx, arrival).phase !== "seated") {
      arrival += 100;
    }
    expect(resolveMotion(interrupted, ctx, arrival).phase).toBe("seated");
    expect(resolveMotion(interrupted, ctx, arrival).point).toEqual(seat);
  });

  it("does not jump back into a break that began while the agent worked", () => {
    const t = awayAt();
    const working = advanceMotion(INITIAL_MOTION, ctx, true, t);
    // Work ends later; the next break is the next slot that STARTS after it.
    const ended = t + 5 * 60_000;
    const free = advanceMotion(working, ctx, false, ended);
    expect(free.deskBoundSince).toBeNull();
    expect(free.resumeAt).toBeGreaterThanOrEqual(ended);

    const justAfter = resolveMotion(free, ctx, ended + 1_000);
    expect(justAfter.phase).toBe("seated");
    expect(justAfter.ambient).toBeNull();
  });

  it("treats a page load with work as seated, not as a return", () => {
    const t = awayAt();
    const firstSight = advanceMotion(null, ctx, true, t);
    expect(firstSight.deskBoundSince).toBe(t);
    expect(firstSight.returnFrom).toBeNull();
    expect(resolveMotion(firstSight, ctx, t).phase).toBe("seated");
  });

  it("keeps everyone at their desk under reduced motion", () => {
    const still: MotionContext = { ...ctx, ambientEnabled: false };
    const t = awayAt();
    expect(resolveMotion(INITIAL_MOTION, still, t).phase).toBe("seated");
  });

  it("types only while executing AND seated; a return shows a walk, never a keyboard", () => {
    expect(agentVisual({ lifecycle: "working" }).animation).toBe("typing");
    expect(agentVisual({ lifecycle: "researching" }).screenBusy).toBe(true);
    expect(agentVisual({ lifecycle: "using_tool" }).animation).toBe("typing");
    expect(agentVisual({ lifecycle: "idle" }).animation).toBe("idle");
    expect(agentVisual({ lifecycle: "waiting_for_approval" }).animation).toBe("still");
    expect(agentVisual({ lifecycle: "completed" }).completion).toBe(true);
    expect(agentVisual({ lifecycle: "failed" }).screen).toBe("danger");
  });

  it("renders a walking return for a working agent, then typing once it is seated", () => {
    const t = awayAt(sceneCtx);
    const idleModel = model({ agents: [AGENT()], now: t });
    const onSelect = vi.fn();

    const { rerender } = render(
      <OfficeScene model={idleModel} selectedActorId={null} onSelectActor={onSelect} clock={t} />
    );
    let actor = screen.getByTestId("office-actor");
    expect(actor.getAttribute("data-phase")).toBe("away");
    expect(actor.getAttribute("data-animation")).not.toBe("typing");

    // Work arrives at the same instant: the figure must walk back first.
    const workingModel = model({
      agents: [AGENT()],
      tasks: [TASK({ status: "RUNNING", startedAt: at(0), agentId: "knowledge-agent" })],
      agentWork: WORK_VIEW({ agents: [WORK({ active: TASK_VIEW() })], generatedAt: at(0) }),
      now: t,
    });
    rerender(
      <OfficeScene model={workingModel} selectedActorId={null} onSelectActor={onSelect} clock={t} />
    );
    actor = screen.getByTestId("office-actor");
    expect(actor.getAttribute("data-lifecycle")).toBe("researching");
    expect(actor.getAttribute("data-phase")).toBe("returning");
    expect(actor.getAttribute("data-animation")).toBe("walk");
    expect(screen.queryByTestId("office-screen-activity")).toBeNull();

    // Arrival: now the desk shows a running task, and only now does it type.
    const where = resolveMotion(INITIAL_MOTION, sceneCtx, t);
    expect(where.phase).toBe("away");

    const returningState = advanceMotion(INITIAL_MOTION, sceneCtx, true, t);
    let arrival = t;
    while (
      arrival < t + 60_000 &&
      resolveMotion(returningState, sceneCtx, arrival).phase !== "seated"
    ) {
      arrival += 100;
    }

    rerender(
      <OfficeScene
        model={workingModel}
        selectedActorId={null}
        onSelectActor={onSelect}
        clock={arrival}
      />
    );
    actor = screen.getByTestId("office-actor");
    expect(actor.getAttribute("data-phase")).toBe("seated");
    expect(actor.getAttribute("data-animation")).toBe("typing");
    expect(screen.getByTestId("office-screen-activity")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 5. The model attributes real work, and the panel shows it
// ---------------------------------------------------------------------------

describe("VO-3.1 — the model and the panel show real work, with its tools", () => {
  const workingModel = () =>
    model({
      agents: [
        AGENT({
          tools: [
            { id: "knowledge.search", risk: "READ_ONLY" },
            { id: "meta.adsets", risk: "WRITE" },
          ],
          toolCount: 2,
        }),
      ],
      tasks: [
        TASK({
          status: "RUNNING",
          startedAt: at(-5_000),
          agentId: "knowledge-agent",
          toolId: "meta.adsets",
          executionId: "exec-1",
        }),
      ],
      activity: [ENTRY({ executionId: "exec-1", toolId: "meta.adsets" })],
      agentWork: WORK_VIEW({
        agents: [
          WORK({
            active: TASK_VIEW({ toolId: "meta.adsets", toolRisk: "WRITE", executionId: "exec-1" }),
            queuedCount: 2,
          }),
        ],
        generatedAt: at(0),
      }),
    });

  it("derives the agent's work from its assigned RUNNING task, never from a task alone", () => {
    const built = workingModel();
    const agent = built.agents[0]!;
    expect(agent.lifecycle).toBe("using_tool");
    expect(agent.lifecycleLabel).toBe("Using meta.adsets");
    expect(agent.currentTask?.title).toBe("Analyse the account");
    expect(agent.queuedCount).toBe(2);
    expect(agent.decorative).toBe(false);

    // A RUNNING task that names no registered agent stays JARVIS work.
    const systemOnly = model({
      agents: [AGENT()],
      tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })],
      agentWork: WORK_VIEW(),
    });
    expect(systemOnly.agents[0]!.lifecycle).toBe("idle");
    expect(systemOnly.system.state).toBe("working");
  });

  it("attributes a task run's audit row through its execution id", () => {
    const built = workingModel();
    expect(built.agents[0]!.lastTool).toEqual({
      toolId: "meta.adsets",
      at: at(-30_000),
      result: "success",
    });
  });

  it("shows the current task, the tool names and their risk in the panel", () => {
    const agent = workingModel().agents[0]!;
    render(<OfficeSelectionPanel selection={agent} onClear={() => undefined} />);

    expect(screen.getByText("Using meta.adsets")).toBeTruthy();
    const current = screen.getByTestId("office-agent-current-task");
    expect(current.textContent).toContain("Analyse the account");
    expect(current.getAttribute("data-status")).toBe("RUNNING");
    expect(current.getAttribute("data-tool-id")).toBe("meta.adsets");

    const tools = screen.getAllByTestId("office-agent-tool");
    expect(tools.map((tool) => tool.dataset.toolId).sort()).toEqual([
      "knowledge.search",
      "meta.adsets",
    ]);
    const write = tools.find((tool) => tool.dataset.toolId === "meta.adsets")!;
    expect(write.dataset.risk).toBe("WRITE");
    expect(within(write).getByText("WRITE")).toBeTruthy();

    // Working: the note says where the state came from; no decorative note.
    expect(screen.getByTestId("office-agent-work-note").textContent).toContain(
      "task engine says RUNNING"
    );
    expect(screen.queryByTestId("office-agent-decorative")).toBeNull();
  });

  it("labels an idle agent's breaks as decorative, and names the waiting approval", () => {
    const idle = model({ agents: [AGENT()], agentWork: WORK_VIEW() }).agents[0]!;
    const { rerender } = render(<OfficeSelectionPanel selection={idle} onClear={() => undefined} />);
    expect(screen.getByTestId("office-agent-decorative").textContent).toContain("decorative");
    expect(screen.getByTestId("office-agent-current-task").textContent).toContain(
      "No task is assigned"
    );

    const waiting = model({
      agents: [AGENT()],
      agentWork: WORK_VIEW({
        agents: [
          WORK({
            pendingApprovals: {
              count: 1,
              newestAt: at(-1_000),
              toolId: "meta.adsets",
              expiresAt: at(60_000),
            },
          }),
        ],
      }),
    }).agents[0]!;
    rerender(<OfficeSelectionPanel selection={waiting} onClear={() => undefined} />);
    expect(screen.getByTestId("office-agent-approvals").textContent).toContain("meta.adsets");
    expect(screen.getByText("Waiting for approval")).toBeTruthy();
  });
});
