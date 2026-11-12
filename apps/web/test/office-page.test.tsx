// ---------------------------------------------------------------------------
// VO-1 — the Virtual Office tab.
//
// The office is a WINDOW, so these tests pin what it shows and what it refuses
// to show:
//
//   * registered agents are drawn, unregistered ones are not employees;
//   * a task run with no agent is JARVIS system work;
//   * an audit row with no agent attribution is never given to an agent;
//   * there is no working agent, no paused state and no percentage progress;
//   * the same facts are available as text (scene summary + event table).
//
// Nothing here exercises execution, approvals or writes: the office has no
// such control.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";
import React from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/office",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    listAgents: vi.fn(),
    listWorkTasks: vi.fn(),
    listActivity: vi.fn(),
  };
});

// The page only reads the stream's state. The hook itself is covered in
// office-stream.test.tsx; keeping it out of here means these tests never open a
// socket and stay deterministic.
const officeStream = vi.hoisted(() => ({
  value: {
    status: "live" as const,
    events: [] as unknown[],
    taskUpdates: new Map<string, unknown>(),
    taskRevision: 0,
    reconnect: (() => undefined) as () => void,
  },
}));

vi.mock("../src/lib/use-office-stream", () => ({
  useOfficeStream: () => officeStream.value,
}));

// The layout is covered separately, below. These stand-ins let the page render
// on its own without a real session or a socket connection.
vi.mock("../src/components/require-auth", () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="require-auth">{children}</div>
  ),
}));

vi.mock("../src/components/dashboard/dashboard-shell", () => ({
  DashboardShell: ({
    children,
    fullscreen,
  }: {
    children: React.ReactNode;
    fullscreen?: boolean;
  }) => (
    <div data-testid="dashboard-shell" data-fullscreen={String(Boolean(fullscreen))}>
      {children}
    </div>
  ),
}));

import * as api from "../src/lib/api";
import OfficePage from "../src/app/office/page";
import OfficeLayout from "../src/app/office/layout";
import { NAV_ITEMS } from "../src/components/dashboard/nav";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();
const ok = <T,>(data: T) => ({ success: true as const, data, timestamp: ts() });
const refused = (code: string, message: string) => ({
  success: false as const,
  error: { code, message },
  timestamp: ts(),
});

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/**
 * Pins `Date`, and only `Date`, to the fixtures' instant for the current test.
 *
 * The page reads the real clock to decide whether an agent "just finished" (a
 * ten-minute window), while the fixtures are fixed relative to `NOW`. A test
 * that asserts that state must therefore run at `NOW`, or it passes only on the
 * day the fixtures were written. Timers stay real, so React and Testing
 * Library's waits are unaffected, and the real clock is restored however the
 * test ends.
 */
function freezeDateAtFixtureTime(): void {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

const AGENT = (over: Partial<api.AgentSummary> = {}): api.AgentSummary => ({
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
  scheduledAt: null,
  startedAt: null,
  error: null,
  ...over,
});

const ENTRY = (over: Partial<api.ActivityEntry> = {}): api.ActivityEntry => ({
  id: "audit-1",
  timestamp: at(-30_000),
  action: "tool.execute",
  result: "success",
  toolId: "meta.adsets",
  agentId: "knowledge-agent",
  ...over,
});

const agentsResponse = (agents: api.AgentSummary[]) => ({
  agents,
  total: agents.length,
  registeredCount: agents.filter((agent) => agent.registered).length,
});

/** VO-2.1 — what the API's `statusCounts` would say about exactly these rows. */
const countsOf = (tasks: api.TaskRecord[]): api.TaskStatusCounts => {
  const counts: api.TaskStatusCounts = { PENDING: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, UNRESOLVED: 0 };
  for (const task of tasks) {
    if (task.status && task.status in counts) counts[task.status as keyof api.TaskStatusCounts] += 1;
  }
  return counts;
};

const resolveAll = ({
  agents = agentsResponse([]),
  tasks = [],
  entries = [],
  statusCounts = countsOf(tasks),
}: {
  agents?: ReturnType<typeof agentsResponse>;
  tasks?: api.TaskRecord[];
  entries?: api.ActivityEntry[];
  /**
   * VO-2.1 — the server's totals. By default they match the listed rows, as
   * they do whenever the list is under its cap; `null` is an API older than
   * VO-2.1, which sends none.
   */
  statusCounts?: api.TaskStatusCounts | null;
} = {}) => {
  mocked.listAgents.mockResolvedValue(ok(agents));
  mocked.listWorkTasks.mockResolvedValue(
    ok({ tasks, count: tasks.length, ...(statusCounts ? { statusCounts } : {}) })
  );
  mocked.listActivity.mockResolvedValue(ok({ entries, count: entries.length, limit: 40 }));
};

beforeEach(() => {
  vi.clearAllMocks();
  officeStream.value = {
    status: "live",
    events: [],
    taskUpdates: new Map(),
    taskRevision: 0,
    reconnect: vi.fn(),
  };
});

// ---------------------------------------------------------------------------

describe("Virtual Office — route and navigation", () => {
  it("sits beside Agents in the dashboard nav", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    const agentsIndex = hrefs.indexOf("/agents");
    const officeIndex = hrefs.indexOf("/office");

    expect(officeIndex).toBeGreaterThanOrEqual(0);
    expect(officeIndex).toBe(agentsIndex + 1);
    expect(NAV_ITEMS[officeIndex]).toMatchObject({
      href: "/office",
      label: "Virtual Office",
      available: true,
    });
  });

  it("keeps the authenticated shell, and does not take the fullscreen command surface", () => {
    render(
      <OfficeLayout>
        <p>office</p>
      </OfficeLayout>
    );

    const shell = screen.getByTestId("dashboard-shell");
    expect(screen.getByTestId("require-auth")).toBeTruthy();
    expect(within(shell).getByText("office")).toBeTruthy();
    // Only /dashboard is fullscreen; the office is a document that scrolls.
    expect(shell.getAttribute("data-fullscreen")).toBe("false");
  });
});

describe("Virtual Office — loading, empty and error", () => {
  it("shows a loading state until the three reads have answered", () => {
    mocked.listAgents.mockReturnValue(new Promise(() => {}));
    mocked.listWorkTasks.mockReturnValue(new Promise(() => {}));
    mocked.listActivity.mockReturnValue(new Promise(() => {}));

    render(<OfficePage />);

    expect(screen.getByTestId("loading-state")).toBeTruthy();
    expect(screen.queryByTestId("office-page")).toBeNull();
  });

  it("renders an honest empty office when nothing is registered and nothing has happened", async () => {
    resolveAll();

    render(<OfficePage />);

    expect(await screen.findByTestId("office-page")).toBeTruthy();
    expect(screen.getByTestId("office-floor-plan")).toBeTruthy();

    expect(screen.getByText("No agents registered")).toBeTruthy();
    expect(screen.getByText("No activity recorded yet")).toBeTruthy();
    // The floor still shows all six rooms, including the unstaffed ones.
    expect(screen.getAllByTestId("office-department")).toHaveLength(6);
    expect(screen.getAllByTestId("office-empty-desk").length).toBeGreaterThan(0);
    // JARVIS exists because the task engine exists.
    expect(screen.getByTestId("office-system-actor")).toBeTruthy();
  });

  it("shows the API's own error message and offers a retry", async () => {
    mocked.listAgents.mockResolvedValue(
      refused("INTERNAL", "The agent registry could not be read.")
    );
    mocked.listWorkTasks.mockResolvedValue(ok({ tasks: [], count: 0 }));
    mocked.listActivity.mockResolvedValue(ok({ entries: [], count: 0, limit: 40 }));

    render(<OfficePage />);

    expect(await screen.findByTestId("error-state")).toBeTruthy();
    expect(screen.getByText("The agent registry could not be read.")).toBeTruthy();
    expect(screen.getByTestId("error-retry")).toBeTruthy();
    expect(screen.queryByTestId("office-page")).toBeNull();
  });
});

describe("Virtual Office — what is on the floor", () => {
  it("draws only registered agents, and lists an unregistered one outside the floor", async () => {
    resolveAll({
      agents: agentsResponse([
        AGENT({ agentId: "knowledge-agent", domain: "knowledge" }),
        AGENT({
          agentId: "google-ads-agent",
          domain: "google-ads",
          registered: false,
          availability: "UNAVAILABLE",
        }),
      ]),
    });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    const actors = screen.getAllByTestId("office-actor");
    expect(actors).toHaveLength(1);
    expect(actors[0].getAttribute("data-agent-id")).toBe("knowledge-agent");
    expect(within(actors[0]).getByText("Knowledge Agent")).toBeTruthy();

    // The unregistered policy is visible, but as "not on this deployment".
    const unavailable = screen.getByTestId("office-unavailable-agent");
    expect(unavailable.getAttribute("data-agent-id")).toBe("google-ads-agent");
    expect(within(unavailable).getByText("Not registered")).toBeTruthy();

    // And it is not in the roster of agents on this floor.
    const roster = screen.getByTestId("office-roster");
    const rosterAgents = within(roster).getAllByTestId("office-roster-agent");
    expect(rosterAgents).toHaveLength(1);
    expect(rosterAgents[0].getAttribute("data-agent-id")).toBe("knowledge-agent");
  });

  it("shows an agent's real last action, never a fabricated working state", async () => {
    freezeDateAtFixtureTime();
    resolveAll({
      agents: agentsResponse([AGENT()]),
      entries: [ENTRY({ timestamp: at(-30_000), result: "success" })],
    });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    const actor = screen.getByTestId("office-actor");
    expect(actor.getAttribute("data-state")).toBe("recent");
    expect(within(actor).getByTestId("office-actor-state").textContent).toBe("Just finished");
    expect(actor.getAttribute("data-decorative")).toBe("false");
    // No agent is ever "working": that word belongs to the JARVIS system actor.
    expect(actor.getAttribute("data-state")).not.toBe("working");
  });
});

describe("Virtual Office — system work and attribution", () => {
  it("shows JARVIS working only from a real RUNNING task", async () => {
    resolveAll({ tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })] });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    const system = screen.getByTestId("office-system-actor");
    expect(system.getAttribute("data-state")).toBe("working");
    expect(within(system).getByTestId("office-system-actor-state").textContent).toContain(
      "Working on 1 task"
    );

    const taskRow = screen
      .getAllByTestId("data-row")
      .find((row) => within(row).queryByText("Running: Analyse the account"));
    expect(taskRow).toBeTruthy();
    expect(within(taskRow!).getByTestId("office-event-attribution").getAttribute("data-attributed")).toBe(
      "false"
    );
    expect(within(taskRow!).getByText("JARVIS")).toBeTruthy();
  });

  it("does not attribute a task run to an agent", async () => {
    resolveAll({
      agents: agentsResponse([AGENT()]),
      tasks: [TASK({ status: "PENDING", createdAt: at(-10_000) })],
    });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    const taskRow = screen
      .getAllByTestId("data-row")
      .find((row) => within(row).queryByText("Queued: Analyse the account"));
    expect(taskRow).toBeTruthy();
    expect(within(taskRow!).queryByText("Knowledge Agent")).toBeNull();
    expect(within(taskRow!).getByText("JARVIS")).toBeTruthy();
  });

  it("shows an audit row with no agentId as system work, not as an agent's action", async () => {
    resolveAll({
      agents: agentsResponse([AGENT()]),
      entries: [ENTRY({ agentId: undefined, action: "approval.approve", toolId: undefined })],
    });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    const row = screen
      .getAllByTestId("data-row")
      .find((candidate) => within(candidate).queryByText("Approved an action"));
    expect(row).toBeTruthy();

    const attribution = within(row!).getByTestId("office-event-attribution");
    expect(attribution.getAttribute("data-attributed")).toBe("false");
    expect(within(attribution).getByText("JARVIS")).toBeTruthy();
    expect(within(row!).queryByText("Knowledge Agent")).toBeNull();
  });
});

describe("Virtual Office — honesty in the rendering", () => {
  it("renders no percentage progress and no paused state", async () => {
    resolveAll({
      agents: agentsResponse([AGENT()]),
      tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })],
      entries: [ENTRY({ result: "pending" })],
    });

    const { container } = render(<OfficePage />);
    const page = await screen.findByTestId("office-page");

    expect(container.querySelector('[data-state="paused"]')).toBeNull();
    expect(container.querySelector('[data-state="working"][data-agent-id]')).toBeNull();
    expect(screen.queryByTestId("office-progress")).toBeNull();

    // No percentage appears in the content. The legend explains that the task
    // engine has no progress measure, so it does not use a % figure either.
    expect(/\d+\s*%/.test(page.textContent ?? "")).toBe(false);
  });

  it("states, in the page, that idle movement is decorative and agent work is not claimed", async () => {
    resolveAll({ agents: agentsResponse([AGENT()]) });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    expect(screen.getByTestId("office-legend-decorative").textContent).toContain("decorative");
    expect(screen.getByTestId("office-legend-limits").textContent).toContain(
      "no percentage progress"
    );

    const idleActor = screen.getByTestId("office-actor");
    expect(idleActor.getAttribute("data-state")).toBe("idle");
    expect(idleActor.getAttribute("data-decorative")).toBe("true");
    expect(screen.getByTestId("office-idle-pulse")).toBeTruthy();
  });
});

describe("Virtual Office — selection", () => {
  it("shows a selected agent's last recorded action, and never a start it cannot know", async () => {
    resolveAll({
      agents: agentsResponse([AGENT()]),
      entries: [ENTRY({ timestamp: at(-30_000) })],
    });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    fireEvent.click(screen.getByTestId("office-actor"));

    const last = await screen.findByTestId("office-last-activity");
    expect(last.textContent).toContain("Ran meta.adsets");
    expect(screen.getByText(/does not show the\s+agent as working/)).toBeTruthy();
  });

  it("says why system work is not attributed to an agent", async () => {
    resolveAll({ tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })] });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    fireEvent.click(screen.getByTestId("office-system-actor"));

    const note = await screen.findByTestId("office-system-note");
    expect(note.textContent).toContain("records no agent");
    expect(note.textContent).toContain("No percentage progress");
  });
});

describe("Virtual Office — the accessible text version", () => {
  it("announces a summary and exposes the same activity as a captioned table", async () => {
    freezeDateAtFixtureTime();
    resolveAll({
      agents: agentsResponse([AGENT()]),
      entries: [ENTRY({ timestamp: at(-30_000) })],
    });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    const scene = screen.getByTestId("office-scene");
    expect(scene.getAttribute("role")).toBe("group");
    expect(scene.getAttribute("aria-label")).toBe("Virtual office floor plan");

    const summary = screen.getByTestId("office-scene-summary").textContent ?? "";
    expect(summary).toContain("1 registered agent is on the floor");
    expect(summary).toContain("Slow idle movement is decorative");

    // The actors are real controls, not decorative divs.
    const actor = screen.getByRole("button", { name: "Knowledge Agent, Just finished" });
    expect(actor).toBeTruthy();

    // The event table is the accessible source of truth.
    const table = screen.getByRole("table", {
      name: /Recent real activity from the task engine and the audit log, newest first/,
    });
    expect(within(table).getByText("Ran meta.adsets")).toBeTruthy();
  });
});

describe("Virtual Office — live updates", () => {
  it("says live only while the stream is connected", async () => {
    resolveAll();

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    const status = screen.getByTestId("office-stream-status");
    expect(status.getAttribute("data-status")).toBe("live");
    expect(status.textContent).toContain("New agent, task and audit activity");
  });

  it("does not present a disconnected floor as current", async () => {
    officeStream.value = { ...officeStream.value, status: "offline" };
    resolveAll();

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    const status = screen.getByTestId("office-stream-status");
    expect(status.getAttribute("data-status")).toBe("offline");
    expect(status.textContent).toContain("not current");
    // Refresh stays available as the fallback.
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("re-reads everything and reconnects the feed when Refresh is pressed (VO-2.1)", async () => {
    officeStream.value = { ...officeStream.value, status: "offline" };
    resolveAll();

    render(<OfficePage />);
    await screen.findByTestId("office-page");
    const readsBefore = mocked.listWorkTasks.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(officeStream.value.reconnect).toHaveBeenCalledTimes(1);
    expect(mocked.listWorkTasks.mock.calls.length).toBe(readsBefore + 1);
    expect(screen.getByTestId("office-stream-status").textContent).toContain(
      "reconnects the feed"
    );
  });

  it("adds a live audit row to the event table without a reload", async () => {
    officeStream.value = {
      ...officeStream.value,
      events: [
        {
          kind: "activity",
          id: "live-audit-1",
          at: new Date().toISOString(),
          action: "tool.execute",
          result: "success",
          toolId: "meta.newtool",
          agentId: "knowledge-agent",
        },
      ],
    };
    resolveAll({ agents: agentsResponse([AGENT()]), entries: [] });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    expect(await screen.findByText("Ran meta.newtool")).toBeTruthy();
    // Still one office, one activity table.
    expect(screen.getByTestId("office-page")).toBeTruthy();
  });

  it("applies a live RUNNING transition to the JARVIS system actor", async () => {
    officeStream.value = {
      ...officeStream.value,
      taskUpdates: new Map([
        [
          "task-1",
          {
            kind: "task",
            id: "task:task-1:RUNNING:live",
            at: at(0),
            taskId: "task-1",
            status: "RUNNING",
          },
        ],
      ]),
    };
    resolveAll({ tasks: [TASK({ status: "PENDING", createdAt: at(-60_000) })] });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    const system = screen.getByTestId("office-system-actor");
    expect(system.getAttribute("data-state")).toBe("working");
    expect(within(system).getByTestId("office-system-actor-state").textContent).toContain(
      "Working on 1 task"
    );
    expect(screen.getByText("Running: Analyse the account")).toBeTruthy();
  });

  it("never invents a row for a task the read did not include", async () => {
    officeStream.value = {
      ...officeStream.value,
      taskUpdates: new Map([
        [
          "task-unknown",
          {
            kind: "task",
            id: "task:task-unknown:RUNNING:live",
            at: new Date().toISOString(),
            taskId: "task-unknown",
            status: "RUNNING",
          },
        ],
      ]),
    };
    resolveAll({ tasks: [] });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    const system = screen.getByTestId("office-system-actor");
    // The event carries no title, so the office waits for the read instead of
    // rendering an unnamed task or claiming work it cannot name.
    expect(system.getAttribute("data-state")).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// VO-2.1 (M2) — the counts are the task engine's totals
// ---------------------------------------------------------------------------

describe("Virtual Office — task totals (VO-2.1)", () => {
  const statValue = (label: string): string | null => {
    const panel = screen
      .getAllByTestId("stat-panel")
      .find((candidate) => candidate.textContent?.includes(label));
    return panel ? within(panel).getByTestId("stat-value").textContent : null;
  };

  const ZERO: api.TaskStatusCounts = { PENDING: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, UNRESOLVED: 0 };

  it("shows the task engine's totals, not the length of a capped list", async () => {
    resolveAll({
      tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })],
      statusCounts: { ...ZERO, PENDING: 9, RUNNING: 64, COMPLETED: 210 },
    });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    expect(statValue("Running tasks")).toBe("64");
    expect(statValue("Queued tasks")).toBe("9");
    expect(screen.getByText("Every RUNNING task in the task engine")).toBeTruthy();
    expect(screen.getByText("Every PENDING task in the task engine")).toBeTruthy();

    const system = screen.getByTestId("office-system-actor");
    expect(within(system).getByTestId("office-system-actor-state").textContent).toContain(
      "Working on 64 tasks"
    );
  });

  it("says work is queued when every queued task is past the list's cap", async () => {
    resolveAll({ tasks: [], statusCounts: { ...ZERO, PENDING: 3 } });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    expect(statValue("Queued tasks")).toBe("3");
    expect(screen.getByTestId("office-system-actor").getAttribute("data-state")).toBe("queued");
  });

  it("says when the counts are only the listed rows", async () => {
    resolveAll({ tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })], statusCounts: null });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    expect(statValue("Running tasks")).toBe("1");
    expect(
      screen.getByText("RUNNING among the newest tasks read; this API sent no totals")
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("office-system-actor"));
    expect(screen.getByTestId("office-system-counts-note").textContent).toContain(
      "this API sent no totals"
    );
  });

  it("does not show the counts note when the totals arrived", async () => {
    resolveAll({ tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })] });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    fireEvent.click(screen.getByTestId("office-system-actor"));
    expect(screen.queryByTestId("office-system-counts-note")).toBeNull();
  });

  it("refuses malformed totals rather than showing them", async () => {
    resolveAll({
      tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })],
      statusCounts: { ...ZERO, PENDING: -4, RUNNING: 999 },
    });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    expect(statValue("Running tasks")).toBe("1");
    expect(
      screen.getByText("RUNNING among the newest tasks read; this API sent no totals")
    ).toBeTruthy();
  });

  it("moves a live transition between the totals at once", async () => {
    officeStream.value = {
      ...officeStream.value,
      taskUpdates: new Map([
        [
          "task-1",
          {
            kind: "task",
            id: "task:task-1:RUNNING:live",
            at: at(0),
            taskId: "task-1",
            status: "RUNNING",
          },
        ],
      ]),
    };
    resolveAll({
      tasks: [TASK({ status: "PENDING", createdAt: at(-60_000) })],
      statusCounts: { ...ZERO, PENDING: 20, RUNNING: 5 },
    });

    render(<OfficePage />);
    await screen.findByTestId("office-page");

    expect(statValue("Running tasks")).toBe("6");
    expect(statValue("Queued tasks")).toBe("19");
  });
});
