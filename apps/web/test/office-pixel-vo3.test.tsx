// ---------------------------------------------------------------------------
// VO-2.2 Stage 2 — the pixel-art office.
//
// What is pinned here:
//
//   * sprites are data, their paths deterministic, and every one of the
//     eleven published agents has a figure of its own; an unknown agent gets a
//     stable one from its id;
//   * the floor is six rooms in department order, each a labelled, signed room
//     with its own fixtures, drawn even when nobody is stationed there;
//   * every registered agent is drawn in its department's room, at a desk or
//     standing, and JARVIS stands in the Command Center;
//   * the only states an agent can show are the model's four — and none of
//     them is a "working" animation; JARVIS animates only from real task rows;
//   * selection works by click and keyboard, is marked on the figure, and the
//     room's sign inspects the room;
//   * live changes to the model change the floor;
//   * the viewport pans, zooms, clamps and resets, a drag is not a click, and
//     the wheel listener is removed on unmount;
//   * reduced motion is reported and its listener removed;
//   * the expanded view puts the pixel floor first and inspects a room; the
//     widget opens the office looking at a room.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, within, fireEvent, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, listAgents: vi.fn(), listWorkTasks: vi.fn(), listActivity: vi.fn() };
});

vi.mock("../src/lib/use-office-stream", () => ({
  useOfficeStream: () => ({
    status: "live",
    events: [],
    taskUpdates: new Map(),
    taskRevision: 0,
    reconnect: vi.fn(),
  }),
}));

import * as api from "../src/lib/api";
import {
  buildOfficeModel,
  OFFICE_DEPARTMENTS,
  type OfficeModel,
} from "../src/components/office/office-model";
import {
  characterSprite,
  deskSprite,
  hashedLook,
  lookForAgent,
  spritePaths,
  spriteSize,
  CHARACTER_SIZE,
  DESK_SEAT_X,
  DESK_SEAT_Y,
  SERVER_RACK,
  type PixelSprite,
} from "../src/components/office/pixel/sprites";
import {
  ROOMS,
  SCENE,
  agentVisual,
  placeAgents,
  roomActivity,
  roomViewport,
  systemVisual,
} from "../src/components/office/pixel/floor-plan";
import {
  MAX_SCALE,
  MIN_SCALE,
  clampViewport,
  useOfficeViewport,
  viewportAround,
  zoomViewport,
} from "../src/components/office/pixel/use-office-viewport";
import { usePrefersReducedMotion } from "../src/components/office/pixel/use-reduced-motion";
import { OFFICE_RENDERERS } from "../src/components/office/office-renderer";
import { tagFor } from "../src/components/office/pixel/pixel-office-renderer";
import { OfficeScene } from "../src/components/office/office-scene";
import { OfficeView } from "../src/components/office/office-expanded";
import { OfficeWidget } from "../src/components/office/office-widget";
import { useOfficeData } from "../src/components/office/use-office-data";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();
const ok = <T,>(data: T) => ({ success: true as const, data, timestamp: ts() });
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** `AGENT_IDS` in `packages/agents/src/agent-policy.ts`, with each agent's domain. */
const KNOWN_AGENTS = [
  ["conversational-assistant", "general"],
  ["location-agent", "location"],
  ["meta-ads-agent", "meta-ads"],
  ["google-ads-agent", "google-ads"],
  ["marketing-agent", "marketing"],
  ["knowledge-agent", "knowledge"],
  ["analytics-agent", "analytics"],
  ["automation-agent", "automation"],
  ["browser-agent", "browser"],
  ["desktop-agent", "desktop"],
  ["communication-agent", "communication"],
] as const;

const AGENT = (over: Partial<api.AgentSummary> = {}): api.AgentSummary => ({
  agentId: "knowledge-agent",
  domain: "knowledge",
  description: "Knowledge agent",
  allowedTools: ["knowledge.search"],
  toolCount: 1,
  writesRequireApproval: false,
  clientSelectable: true,
  registered: true,
  availability: "AVAILABLE",
  ...over,
});

const ENTRY = (over: Partial<api.ActivityEntry> = {}): api.ActivityEntry => ({
  id: `audit-${Math.random().toString(36).slice(2)}`,
  timestamp: at(-30_000),
  action: "tool.execute",
  result: "success",
  agentId: "knowledge-agent",
  toolId: "knowledge.search",
  ...over,
});

const TASK = (over: Partial<api.TaskRecord> = {}): api.TaskRecord => ({
  id: `task-${Math.random().toString(36).slice(2)}`,
  title: "Nightly report",
  description: null,
  dueAt: null,
  priority: "NORMAL",
  completedAt: null,
  createdAt: at(-60_000),
  status: "PENDING",
  createdBy: "jarvis",
  ...over,
});

function model(input: {
  agents?: api.AgentSummary[];
  tasks?: api.TaskRecord[];
  activity?: api.ActivityEntry[];
  counts?: api.TaskStatusCounts | null;
}): OfficeModel {
  return buildOfficeModel({
    agents: input.agents ?? [],
    tasks: input.tasks ?? [],
    activity: input.activity ?? [],
    taskCounts: input.counts ?? null,
    now: Date.now(),
  });
}

const allAgents = () => KNOWN_AGENTS.map(([agentId, domain]) => AGENT({ agentId, domain }));

function renderScene(m: OfficeModel, extra: Partial<React.ComponentProps<typeof OfficeScene>> = {}) {
  const onSelectActor = vi.fn();
  // Structural tests pin what is drawn, not what the decorative motion engine
  // happens to be doing at the wall clock's instant: ambient breaks are off
  // unless a test asks for them (the VO-3.1 motion tests do).
  const utils = render(
    <OfficeScene model={m} selectedActorId={null} onSelectActor={onSelectActor} ambient={false} {...extra} />
  );
  return { ...utils, onSelectActor };
}

const actors = () => screen.getAllByTestId("office-actor");
const actorFor = (id: string) => actors().find((element) => element.dataset.agentId === id)!;
const roomOf = (element: HTMLElement) => element.closest('[data-testid="office-department"]') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("sprites", () => {
  it("turns a pixel matrix into one path per colour, deterministically", () => {
    const sprite: PixelSprite = { rows: ["ab.", "aa.", "..b"], palette: { a: "#111111", b: "#222222" } };
    const paths = spritePaths(sprite);
    expect(paths).toEqual([
      { fill: "#111111", d: "M0 0h1v1h-1zM0 1h2v1h-2z" },
      { fill: "#222222", d: "M1 0h1v1h-1zM2 2h1v1h-1z" },
    ]);
    // Memoised: the same sprite object gives the same array.
    expect(spritePaths(sprite)).toBe(paths);
    expect(spriteSize(sprite)).toEqual({ width: 3, height: 3 });
  });

  it("paints an unknown palette key loudly rather than dropping it", () => {
    const paths = spritePaths({ rows: ["x"], palette: {} });
    expect(paths[0]!.fill).toBe("#ff00ff");
  });

  it("gives each of the eleven published agents a figure of its own", () => {
    const figures = KNOWN_AGENTS.map(([id]) => JSON.stringify(lookForAgent(id)));
    expect(new Set(figures).size).toBe(KNOWN_AGENTS.length);
    // Hand-picked, not hashed: every published id is a key of the table.
    for (const [id] of KNOWN_AGENTS) {
      expect(JSON.stringify(lookForAgent(id)), id).not.toBe(JSON.stringify(hashedLook(id)));
    }
  });

  it("gives an unknown agent a stable figure from its id, and a character of the standard size", () => {
    const first = hashedLook("future-agent");
    expect(hashedLook("future-agent")).toEqual(first);
    expect(lookForAgent("future-agent")).toEqual(first);
    expect(hashedLook("other-agent")).not.toEqual(first);

    for (const pose of ["stand", "breathe", "type"] as const) {
      const sprite = characterSprite(first, "#3ee0f2", pose);
      expect(spriteSize(sprite)).toEqual(CHARACTER_SIZE);
      for (const row of sprite.rows) expect(row).toHaveLength(CHARACTER_SIZE.width);
    }
    // Memoised by parts.
    expect(characterSprite(first, "#3ee0f2", "stand")).toBe(characterSprite(first, "#3ee0f2", "stand"));
  });

  it("every fixture is a rectangle of pixels", () => {
    for (const sprite of [SERVER_RACK, deskSprite("#000000"), ...ROOMS.flatMap((room) => room.fixtures.map((f) => f.sprite))]) {
      const width = sprite.rows[0]!.length;
      for (const row of sprite.rows) expect(row).toHaveLength(width);
      // Every key the rows use is in the palette: no magenta on the floor.
      for (const path of spritePaths(sprite)) expect(path.fill).not.toBe("#ff00ff");
    }
  });
});

// ---------------------------------------------------------------------------

describe("the floor plan", () => {
  it("is six rooms, in department order, inside the scene, overlapping nowhere", () => {
    expect(ROOMS.map((room) => room.id)).toEqual(OFFICE_DEPARTMENTS.map((department) => department.id));
    expect(ROOMS.map((room) => room.label)).toEqual(OFFICE_DEPARTMENTS.map((department) => department.label));
    for (const room of ROOMS) {
      expect(room.x).toBeGreaterThanOrEqual(SCENE.x);
      expect(room.y).toBeGreaterThanOrEqual(SCENE.y);
      expect(room.x + room.w).toBeLessThanOrEqual(SCENE.x + SCENE.w);
      expect(room.y + room.h).toBeLessThanOrEqual(SCENE.y + SCENE.h);
      expect(room.fixtures.length).toBeGreaterThan(0);
    }
    for (let i = 0; i < ROOMS.length; i += 1) {
      for (let j = i + 1; j < ROOMS.length; j += 1) {
        const a = ROOMS[i]!;
        const b = ROOMS[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
    // Only the Command Center has the core.
    expect(ROOMS.filter((room) => room.core).map((room) => room.id)).toEqual(["command-center"]);
  });

  it("places every registered agent in its department's room, nobody dropped, nobody on top of anyone", () => {
    const placed = placeAgents(model({ agents: allAgents() }));
    expect(placed.map((entry) => entry.actor.id).sort()).toEqual(KNOWN_AGENTS.map(([id]) => id).sort());

    for (const entry of placed) {
      const room = ROOMS.find((candidate) => candidate.id === entry.actor.department)!;
      expect(entry.x).toBeGreaterThanOrEqual(room.x);
      expect(entry.y).toBeGreaterThanOrEqual(room.y);
      expect(entry.x + CHARACTER_SIZE.width).toBeLessThanOrEqual(room.x + room.w);
      expect(entry.y + CHARACTER_SIZE.height).toBeLessThanOrEqual(room.y + room.h);
    }
    const spots = new Set(placed.map((entry) => `${entry.x},${entry.y}`));
    expect(spots.size).toBe(placed.length);
  });

  it("keeps a first-row name tag clear of the figure seated in the row behind", () => {
    // A figure is 14 tall and its tag's baseline is 4.2 below it.
    const TAG_BOTTOM = CHARACTER_SIZE.height + 4.5;
    for (const room of ROOMS) {
      for (const front of room.desks) {
        for (const back of room.desks) {
          if (back.y <= front.y || Math.abs(back.x - front.x) >= CHARACTER_SIZE.width) continue;
          const frontTagBottom = front.y + DESK_SEAT_Y + TAG_BOTTOM;
          const backHeadTop = back.y + DESK_SEAT_Y;
          expect(backHeadTop, `${room.id}`).toBeGreaterThan(frontTagBottom);
        }
      }
    }
  });

  it("never draws a desk's monitor across the figure seated at it", () => {
    const desk = deskSprite("#000000");
    const monitorColumns = new Set<number>();
    desk.rows.slice(0, 5).forEach((row) => {
      [...row].forEach((pixel, x) => {
        if (pixel !== ".") monitorColumns.add(x);
      });
    });
    for (let x = DESK_SEAT_X; x < DESK_SEAT_X + CHARACTER_SIZE.width; x += 1) {
      expect(monitorColumns.has(x), `column ${x}`).toBe(false);
    }
  });

  it("tags a figure with its name less its role suffix", () => {
    expect(tagFor({ label: "Meta Ads Agent" })).toBe("Meta Ads");
    expect(tagFor({ label: "Conversational Assistant" })).toBe("Conversational");
    expect(tagFor({ label: "A Very Long Future Agent Name" })).toBe("A Very Long F…");
  });

  it("extends the corridor past the scene, so letterboxing shows building, not black bars", () => {
    renderScene(model({}));
    const corridor = screen.getByTestId("office-corridor");
    expect(Number(corridor.getAttribute("x"))).toBeLessThan(SCENE.x);
    expect(Number(corridor.getAttribute("y"))).toBeLessThan(SCENE.y);
    expect(Number(corridor.getAttribute("x")) + Number(corridor.getAttribute("width"))).toBeGreaterThan(SCENE.x + SCENE.w);
    expect(Number(corridor.getAttribute("y")) + Number(corridor.getAttribute("height"))).toBeGreaterThan(SCENE.y + SCENE.h);
  });

  it("seats a room busier than its plan without dropping anyone", () => {
    const crowd = Array.from({ length: 9 }, (_, i) => AGENT({ agentId: `k${i}-agent`, domain: "knowledge" }));
    const placed = placeAgents(model({ agents: crowd }));
    expect(placed).toHaveLength(9);
    const room = ROOMS.find((candidate) => candidate.id === "research-lab")!;
    for (const entry of placed) {
      expect(entry.x + CHARACTER_SIZE.width).toBeLessThanOrEqual(room.x + room.w);
    }
  });

  it("maps the model's four agent states, and no state to a working animation", () => {
    const now = Date.now();
    const states = {
      idle: model({ agents: [AGENT()] }),
      recent: model({ agents: [AGENT()], activity: [ENTRY({ result: "success" })] }),
      waiting: model({ agents: [AGENT()], activity: [ENTRY({ result: "pending", timestamp: new Date(now - 10_000).toISOString() })] }),
      attention: model({ agents: [AGENT()], activity: [ENTRY({ result: "failure" })] }),
    };
    expect(agentVisual(states.idle.agents[0]!)).toEqual({ animation: "idle", glyph: "none", screen: "dim", screenBusy: false, completion: false });
    expect(agentVisual(states.recent.agents[0]!)).toEqual({ animation: "still", glyph: "check", screen: "ok", screenBusy: false, completion: true });
    expect(agentVisual(states.waiting.agents[0]!)).toEqual({ animation: "still", glyph: "wait", screen: "warn", screenBusy: false, completion: false });
    expect(agentVisual(states.attention.agents[0]!)).toEqual({ animation: "still", glyph: "alert", screen: "danger", screenBusy: false, completion: false });
    for (const m of Object.values(states)) {
      expect(agentVisual(m.agents[0]!).animation).not.toMatch(/work|typ/);
    }
  });

  it("animates JARVIS only from real task rows, and caps the queue markers", () => {
    expect(systemVisual(model({}).system)).toEqual({ animation: "idle", queueMarkers: 0 });
    expect(systemVisual(model({ tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })] }).system).animation).toBe("working");
    const queued = systemVisual(model({ tasks: [], counts: { PENDING: 12, RUNNING: 0, COMPLETED: 0, FAILED: 0, UNRESOLVED: 0 } }).system);
    expect(queued).toEqual({ animation: "queued", queueMarkers: 5 });
  });

  it("reports a room as live only when something in it is not idle", () => {
    const quiet = model({ agents: [AGENT()] });
    expect(roomActivity(quiet.departments.find((d) => d.id === "research-lab")!, quiet.system)).toEqual({ active: 0, live: false });
    const busy = model({ agents: [AGENT()], activity: [ENTRY()] });
    expect(roomActivity(busy.departments.find((d) => d.id === "research-lab")!, busy.system)).toEqual({ active: 1, live: true });
    const running = model({ tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })] });
    expect(roomActivity(running.departments[0]!, running.system).live).toBe(true);
    expect(roomActivity(running.departments[1]!, running.system).live).toBe(false);
  });

  it("frames a room inside the scene", () => {
    const view = roomViewport("break-zone");
    expect(view.x + view.w).toBeLessThanOrEqual(SCENE.w);
    expect(view.y + view.h).toBeLessThanOrEqual(SCENE.h);
  });
});

// ---------------------------------------------------------------------------

describe("the pixel renderer", () => {
  it("is the renderer the scene draws with, beside the VO-1 text fallback", () => {
    expect(Object.keys(OFFICE_RENDERERS).sort()).toEqual(["dom", "pixel"]);
    renderScene(model({}));
    const floor = screen.getByTestId("office-floor-plan");
    expect(floor.tagName.toLowerCase()).toBe("svg");
    expect(floor.getAttribute("viewBox")).toBe(`${SCENE.x} ${SCENE.y} ${SCENE.w} ${SCENE.h}`);
    expect(floor.getAttribute("shape-rendering")).toBe("crispEdges");
  });

  it("draws six signed rooms with fixtures, even with nobody registered", () => {
    renderScene(model({}));
    const rooms = screen.getAllByTestId("office-department");
    expect(rooms.map((room) => room.dataset.departmentId)).toEqual(OFFICE_DEPARTMENTS.map((d) => d.id));
    for (const room of rooms) {
      const sign = within(room).getByTestId("office-department-sign");
      expect(sign.textContent).toContain(room.getAttribute("aria-label")!.toUpperCase());
      expect(within(room).getByTestId("office-department-light")).toBeInTheDocument();
      // Fixtures: at least one painted path besides the walls and floor.
      expect(room.querySelectorAll("path").length).toBeGreaterThan(0);
    }
    // The four unstaffed rooms that have workstations say so; the Command
    // Center has JARVIS, and the Break Zone has no desks to sit at.
    expect(screen.getAllByTestId("office-empty-desk")).toHaveLength(4);
    expect(within(rooms[0]!).getByTestId("office-system-actor")).toBeInTheDocument();
  });

  it("draws every agent as a figure in its department's room, with its own sprite", () => {
    renderScene(model({ agents: allAgents() }));
    expect(actors()).toHaveLength(KNOWN_AGENTS.length);
    const byRoom: Record<string, string[]> = {};
    for (const actor of actors()) {
      const room = roomOf(actor).dataset.departmentId!;
      (byRoom[room] ??= []).push(actor.dataset.agentId!);
      // A figure is painted pixels: paths in two frames, plus a name tag.
      expect(actor.querySelectorAll(".px-frame").length).toBe(2);
      expect(actor.querySelectorAll("path").length).toBeGreaterThan(4);
    }
    expect(byRoom["research-lab"]!.sort()).toEqual(["analytics-agent", "knowledge-agent"]);
    expect(byRoom["development-lab"]!.sort()).toEqual(["automation-agent", "browser-agent", "desktop-agent"]);
    expect(byRoom["marketing-hub"]!.sort()).toEqual(["google-ads-agent", "marketing-agent", "meta-ads-agent"]);
    expect(byRoom["conference-room"]).toEqual(["communication-agent"]);
    expect(byRoom["command-center"]!.sort()).toEqual(["conversational-assistant", "location-agent"]);
    expect(byRoom["break-zone"]).toBeUndefined();

    // Distinct figures: no two agents paint the same set of paths.
    const figures = actors().map((actor) =>
      Array.from(actor.querySelectorAll(".px-f0 path")).map((p) => `${p.getAttribute("fill")}${p.getAttribute("d")}`).join("|")
    );
    expect(new Set(figures).size).toBe(figures.length);
  });

  it("shows each state as the floor may: idle breathes, finished checks, waiting waits, failed alerts", () => {
    const now = Date.now();
    renderScene(
      model({
        agents: [
          AGENT({ agentId: "a-idle-agent", domain: "knowledge" }),
          AGENT({ agentId: "b-done-agent", domain: "knowledge" }),
          AGENT({ agentId: "c-wait-agent", domain: "analytics" }),
          AGENT({ agentId: "d-fail-agent", domain: "analytics" }),
        ],
        activity: [
          ENTRY({ agentId: "b-done-agent", result: "success" }),
          ENTRY({ agentId: "c-wait-agent", result: "pending", timestamp: new Date(now - 10_000).toISOString() }),
          ENTRY({ agentId: "d-fail-agent", result: "failure" }),
        ],
      })
    );

    const idle = actorFor("a-idle-agent");
    expect(idle.dataset.state).toBe("idle");
    expect(idle.dataset.decorative).toBe("true");
    expect(idle.classList.contains("px-anim-idle")).toBe(true);
    expect(within(idle).getByTestId("office-idle-pulse")).toBeInTheDocument();
    expect(within(idle).getByTestId("office-actor-state").textContent).toBe("Idle");

    const done = actorFor("b-done-agent");
    expect(done.dataset.state).toBe("recent");
    expect(done.dataset.glyph).toBe("check");
    expect(done.classList.contains("px-anim-still")).toBe(true);
    expect(within(done).queryByTestId("office-idle-pulse")).toBeNull();

    expect(actorFor("c-wait-agent").dataset.glyph).toBe("wait");
    expect(actorFor("d-fail-agent").dataset.glyph).toBe("alert");

    // The glyphs are drawn above the desks, in the room.
    const glyphs = screen.getAllByTestId("office-actor-glyph").map((g) => g.dataset.glyph).sort();
    expect(glyphs).toEqual(["alert", "check", "wait"]);
    expect(screen.getAllByTestId("office-actor-glyph")[0]!.closest("[data-testid='office-department']")).not.toBeNull();

    // No agent ever gets a working class.
    for (const actor of actors()) {
      expect(actor.className.baseVal ?? actor.getAttribute("class")).not.toMatch(/work|typ/);
      expect(actor.dataset.state).not.toBe("working");
    }
  });

  it("shows JARVIS working only from a RUNNING task, and queued from PENDING ones", () => {
    const { rerender } = renderScene(model({}));
    expect(screen.getByTestId("office-system-actor").dataset.state).toBe("idle");
    expect(screen.queryAllByTestId("office-queue-marker")).toHaveLength(0);

    rerender(
      <OfficeScene
        model={model({ tasks: [TASK({ status: "RUNNING", startedAt: at(-5_000) })], counts: { PENDING: 2, RUNNING: 1, COMPLETED: 0, FAILED: 0, UNRESOLVED: 0 } })}
        selectedActorId={null}
        onSelectActor={() => undefined}
        ambient={false}
      />
    );
    const core = screen.getByTestId("office-system-actor");
    expect(core.dataset.state).toBe("working");
    expect(core.classList.contains("px-core-working")).toBe(true);
    expect(core.querySelectorAll(".px-frame").length).toBe(3);
    expect(screen.getAllByTestId("office-queue-marker")).toHaveLength(2);
    expect(screen.getAllByTestId("office-department")[0]!.dataset.live).toBe("true");
  });

  it("updates the floor when the model changes", () => {
    const { rerender } = renderScene(model({ agents: [AGENT()] }));
    expect(actorFor("knowledge-agent").dataset.state).toBe("idle");

    rerender(
      <OfficeScene
        model={model({ agents: [AGENT()], activity: [ENTRY({ result: "failure" })] })}
        selectedActorId={null}
        onSelectActor={() => undefined}
        ambient={false}
      />
    );
    expect(actorFor("knowledge-agent").dataset.state).toBe("attention");
    expect(actorFor("knowledge-agent").dataset.glyph).toBe("alert");
    expect(roomOf(actorFor("knowledge-agent")).dataset.live).toBe("true");
  });

  it("selects a figure by click and by keyboard, and marks the selection", () => {
    const { onSelectActor, rerender } = renderScene(model({ agents: [AGENT()] }));
    const actor = actorFor("knowledge-agent");
    expect(actor.getAttribute("role")).toBe("button");
    expect(actor.getAttribute("aria-pressed")).toBe("false");
    expect(actor.getAttribute("aria-label")).toBe("Knowledge Agent, Idle");

    fireEvent.click(actor);
    expect(onSelectActor).toHaveBeenCalledWith("knowledge-agent");
    fireEvent.keyDown(actor, { key: "Enter" });
    fireEvent.keyDown(actor, { key: " " });
    expect(onSelectActor).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByTestId("office-system-actor"));
    expect(onSelectActor).toHaveBeenLastCalledWith("jarvis");

    rerender(<OfficeScene model={model({ agents: [AGENT()] })} selectedActorId="knowledge-agent" onSelectActor={onSelectActor} ambient={false} />);
    expect(actorFor("knowledge-agent").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("office-actor-selection")).toBeInTheDocument();
  });

  it("inspects a room from its sign only when asked to, and dims the others when one is in focus", () => {
    const onSelectDepartment = vi.fn();
    const { rerender } = renderScene(model({}), { onSelectDepartment });
    const sign = within(screen.getAllByTestId("office-department")[2]!).getByTestId("office-department-sign");
    expect(sign.getAttribute("role")).toBe("button");
    expect(sign.getAttribute("aria-label")).toBe("Inspect Marketing Hub");
    fireEvent.click(sign);
    expect(onSelectDepartment).toHaveBeenCalledWith("marketing-hub");
    fireEvent.keyDown(sign, { key: "Enter" });
    expect(onSelectDepartment).toHaveBeenCalledTimes(2);

    rerender(<OfficeScene model={model({})} selectedActorId={null} onSelectActor={() => undefined} ambient={false} focusDepartment="marketing-hub" />);
    const rooms = screen.getAllByTestId("office-department");
    expect(rooms[2]!.dataset.focused).toBe("true");
    expect(rooms.filter((room) => room.dataset.dimmed === "true")).toHaveLength(5);
    expect(screen.getByTestId("office-floor-plan").dataset.focusedDepartment).toBe("marketing-hub");

    // Without a handler the sign is not a control.
    rerender(<OfficeScene model={model({})} selectedActorId={null} onSelectActor={() => undefined} ambient={false} />);
    expect(screen.getAllByTestId("office-department-sign")[0]!.getAttribute("role")).toBeNull();
  });

  it("fills its box when asked to, and is never both relative and absolute", () => {
    // Regression: `relative absolute inset-0` let `relative` win (it is later in
    // Tailwind's stylesheet), so the floor sized itself by its 2:1 ratio and
    // spilled out of the widget's cell — clipped, and read by Auto optimize as
    // a scrollbar.
    const { rerender } = renderScene(model({}), { className: "absolute inset-0" });
    const scene = screen.getByTestId("office-scene");
    expect(scene.className.split(/\s+/)).toEqual(["absolute", "inset-0"]);
    rerender(<OfficeScene model={model({})} selectedActorId={null} onSelectActor={() => undefined} ambient={false} />);
    expect(screen.getByTestId("office-scene").className).toBe("relative");
  });

  it("drops the name tags in the compact preview and keeps the signs", () => {
    renderScene(model({ agents: [AGENT()] }), { compact: true });
    expect(document.querySelector(".px-name")).toBeNull();
    expect(screen.getAllByTestId("office-department-sign")).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------

describe("the viewport", () => {
  it("clamps to the scene and to the zoom limits", () => {
    expect(clampViewport({ x: -50, y: -50, w: SCENE.w * 2, h: SCENE.h * 2 })).toEqual(SCENE);
    const tight = clampViewport({ x: 1000, y: 1000, w: 1, h: 1 });
    expect(SCENE.w / tight.w).toBeCloseTo(MAX_SCALE);
    expect(tight.x + tight.w).toBeLessThanOrEqual(SCENE.w);
    expect(tight.y + tight.h).toBeLessThanOrEqual(SCENE.h);
  });

  it("zooms about a point and frames a room", () => {
    const zoomed = zoomViewport(SCENE, 2, { x: 0, y: 0 });
    expect(zoomed).toEqual({ x: 0, y: 0, w: SCENE.w / 2, h: SCENE.h / 2 });
    expect(zoomViewport(SCENE, 0.5)).toEqual(SCENE);
    const framed = viewportAround(roomViewport("break-zone"));
    expect(SCENE.w / framed.w).toBeGreaterThan(MIN_SCALE);
    expect(framed.x + framed.w).toBeLessThanOrEqual(SCENE.w);
  });

  it("pans by drag, zooms by keys and wheel, resets, and tells a drag from a click", () => {
    const { rerender, onSelectActor } = renderScene(model({ agents: [AGENT()] }), { interactive: true });
    const floor = screen.getByTestId("office-floor-plan");
    const viewBox = () => floor.getAttribute("viewBox")!.split(" ").map(Number);

    expect(screen.getByTestId("office-viewport-scale").textContent).toBe("1.0×");
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(viewBox()[2]).toBeCloseTo(SCENE.w / 1.25);
    expect(screen.getByTestId("office-viewport-scale").textContent).toBe("1.3×");

    fireEvent.keyDown(floor, { key: "+" });
    fireEvent.keyDown(floor, { key: "ArrowRight" });
    const before = viewBox();
    expect(before[0]).toBeGreaterThan(0);

    // A drag of more than the threshold pans, and the click that ends it is not a select.
    fireEvent.pointerDown(floor, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(floor, { pointerId: 1, clientX: 60, clientY: 90 });
    fireEvent.pointerUp(floor, { pointerId: 1 });
    expect(viewBox()[0]).not.toBe(before[0]);
    fireEvent.click(actorFor("knowledge-agent"));
    expect(onSelectActor).not.toHaveBeenCalled();
    // The next click, with no drag before it, selects.
    fireEvent.click(actorFor("knowledge-agent"));
    expect(onSelectActor).toHaveBeenCalledWith("knowledge-agent");

    // A tap that does not travel is not a drag.
    fireEvent.pointerDown(floor, { pointerId: 2, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(floor, { pointerId: 2, clientX: 11, clientY: 11 });
    fireEvent.pointerUp(floor, { pointerId: 2 });
    fireEvent.click(actorFor("knowledge-agent"));
    expect(onSelectActor).toHaveBeenCalledTimes(2);

    // ctrl + wheel zooms; a plain wheel is left to the page.
    const w = viewBox()[2]!;
    fireEvent.wheel(floor, { deltaY: 100 });
    expect(viewBox()[2]).toBe(w);
    fireEvent.wheel(floor, { deltaY: 100, ctrlKey: true });
    expect(viewBox()[2]).toBeGreaterThan(w);

    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(viewBox()).toEqual([SCENE.x, SCENE.y, SCENE.w, SCENE.h]);

    fireEvent.keyDown(floor, { key: "-" });
    expect(viewBox()).toEqual([SCENE.x, SCENE.y, SCENE.w, SCENE.h]);

    // A focused room frames itself; clearing it shows the whole office.
    rerender(<OfficeScene model={model({ agents: [AGENT()] })} selectedActorId={null} onSelectActor={onSelectActor} interactive ambient={false} focusDepartment="research-lab" />);
    expect(viewBox()[2]).toBeLessThan(SCENE.w);
    rerender(<OfficeScene model={model({ agents: [AGENT()] })} selectedActorId={null} onSelectActor={onSelectActor} interactive ambient={false} />);
    expect(viewBox()).toEqual([SCENE.x, SCENE.y, SCENE.w, SCENE.h]);
  });

  it("captures the pointer only once a press has become a drag", () => {
    // Regression: capturing on pointerdown made Chrome deliver every click to
    // the SVG, so no figure or sign on the expanded floor could be clicked.
    const proto = SVGSVGElement.prototype as unknown as {
      setPointerCapture?: (id: number) => void;
      hasPointerCapture?: (id: number) => boolean;
      releasePointerCapture?: (id: number) => void;
    };
    const saved = { set: proto.setPointerCapture, has: proto.hasPointerCapture, release: proto.releasePointerCapture };
    const captured = new Set<number>();
    const set = vi.fn((id: number) => void captured.add(id));
    const release = vi.fn((id: number) => void captured.delete(id));
    proto.setPointerCapture = set;
    proto.hasPointerCapture = (id: number) => captured.has(id);
    proto.releasePointerCapture = release;
    try {
      renderScene(model({}), { interactive: true });
      const floor = screen.getByTestId("office-floor-plan");

      // A press and release without travel: never captured, so the click is
      // the figure's or the sign's.
      fireEvent.pointerDown(floor, { pointerId: 7, button: 0, clientX: 50, clientY: 50 });
      fireEvent.pointerMove(floor, { pointerId: 7, clientX: 51, clientY: 50 });
      fireEvent.pointerUp(floor, { pointerId: 7 });
      expect(set).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();

      // A drag: captured once, at the threshold, and released at the end.
      fireEvent.pointerDown(floor, { pointerId: 8, button: 0, clientX: 50, clientY: 50 });
      expect(set).not.toHaveBeenCalled();
      fireEvent.pointerMove(floor, { pointerId: 8, clientX: 70, clientY: 50 });
      fireEvent.pointerMove(floor, { pointerId: 8, clientX: 90, clientY: 50 });
      expect(set).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith(8);
      fireEvent.pointerUp(floor, { pointerId: 8 });
      expect(release).toHaveBeenCalledWith(8);
    } finally {
      proto.setPointerCapture = saved.set;
      proto.hasPointerCapture = saved.has;
      proto.releasePointerCapture = saved.release;
    }
  });

  it("does not let a finished drag swallow a later keyboard selection", async () => {
    const { onSelectActor } = renderScene(model({ agents: [AGENT()] }), { interactive: true });
    const floor = screen.getByTestId("office-floor-plan");
    fireEvent.pointerDown(floor, { pointerId: 3, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(floor, { pointerId: 3, clientX: 40, clientY: 100 });
    fireEvent.pointerUp(floor, { pointerId: 3 });
    // The drag's own click landed on the SVG, so nothing consumed the flag.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    fireEvent.keyDown(actorFor("knowledge-agent"), { key: "Enter" });
    expect(onSelectActor).toHaveBeenCalledWith("knowledge-agent");
  });

  it("removes its wheel listener on unmount", () => {
    const added = vi.spyOn(SVGSVGElement.prototype, "addEventListener");
    const removed = vi.spyOn(SVGSVGElement.prototype, "removeEventListener");
    try {
      const { unmount } = renderScene(model({}), { interactive: true });
      const wheelAdds = added.mock.calls.filter((call) => call[0] === "wheel");
      expect(wheelAdds).toHaveLength(1);
      unmount();
      const wheelRemoves = removed.mock.calls.filter((call) => call[0] === "wheel");
      expect(wheelRemoves).toHaveLength(1);
      expect(wheelRemoves[0]![1]).toBe(wheelAdds[0]![1]);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });

  it("is static in the preview: no controls, no wheel listener, no focusable floor", () => {
    const added = vi.spyOn(SVGSVGElement.prototype, "addEventListener");
    try {
      renderScene(model({}));
      expect(screen.queryByTestId("office-viewport-controls")).toBeNull();
      expect(added.mock.calls.filter((call) => call[0] === "wheel")).toHaveLength(0);
      expect(screen.getByTestId("office-floor-plan").getAttribute("tabindex")).toBeNull();
    } finally {
      added.mockRestore();
    }
  });

  it("exposes the hook's shape", () => {
    let latest: ReturnType<typeof useOfficeViewport> | null = null;
    function Probe() {
      latest = useOfficeViewport(true);
      return null;
    }
    render(<Probe />);
    expect(latest!.viewBox).toEqual(SCENE);
    expect(latest!.canZoomIn).toBe(true);
    expect(latest!.canZoomOut).toBe(false);
    act(() => latest!.zoomIn());
    expect(latest!.canZoomOut).toBe(true);
    act(() => latest!.reset());
    expect(latest!.scale).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("reduced motion", () => {
  const original = window.matchMedia;
  afterEach(() => {
    Object.defineProperty(window, "matchMedia", { value: original, configurable: true, writable: true });
  });

  function stubMatchMedia(matches: boolean) {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const list = {
      matches,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn((_: string, fn: (event: MediaQueryListEvent) => void) => listeners.add(fn)),
      removeEventListener: vi.fn((_: string, fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn)),
    };
    Object.defineProperty(window, "matchMedia", { value: vi.fn(() => list), configurable: true, writable: true });
    return { list, fire: (next: boolean) => listeners.forEach((fn) => fn({ matches: next } as MediaQueryListEvent)) };
  }

  it("reports the preference on the scene, follows a change, and removes its listener", () => {
    const { list, fire } = stubMatchMedia(true);
    const { unmount } = renderScene(model({ agents: [AGENT()] }));
    expect(screen.getByTestId("office-floor-plan").dataset.motion).toBe("reduced");
    expect(list.addEventListener).toHaveBeenCalledTimes(1);

    act(() => fire(false));
    expect(screen.getByTestId("office-floor-plan").dataset.motion).toBe("full");

    unmount();
    expect(list.removeEventListener).toHaveBeenCalledTimes(1);
    expect(list.removeEventListener.mock.calls[0]![1]).toBe(list.addEventListener.mock.calls[0]![1]);
  });

  it("is false where matchMedia does not exist", () => {
    Object.defineProperty(window, "matchMedia", { value: undefined, configurable: true, writable: true });
    let seen: boolean | null = null;
    function Probe() {
      seen = usePrefersReducedMotion();
      return null;
    }
    render(<Probe />);
    expect(seen).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("the expanded view and the widget", () => {
  function resolveOffice() {
    mocked.listAgents.mockResolvedValue(ok({ agents: allAgents(), total: 11, registeredCount: 11 }));
    mocked.listWorkTasks.mockResolvedValue(
      ok({ tasks: [], count: 0, statusCounts: { PENDING: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, UNRESOLVED: 0 } })
    );
    mocked.listActivity.mockResolvedValue(ok({ entries: [ENTRY({ agentId: "browser-agent" })], count: 1, limit: 40 }));
  }

  function View(props: { initialDepartment?: "development-lab" }) {
    const data = useOfficeData();
    const [selected, setSelected] = React.useState<string | null>(null);
    return <OfficeView data={data} selectedActorId={selected} onSelectActor={setSelected} initialDepartment={props.initialDepartment ?? null} />;
  }

  beforeEach(() => resolveOffice());

  it("puts the pixel floor first, with pan and zoom, and inspects a room beside it", async () => {
    render(<View />);
    const view = await screen.findByTestId("office-view");
    const stage = within(view).getByTestId("office-stage");
    expect(within(stage).getByTestId("office-floor-plan")).toBeInTheDocument();
    expect(within(stage).getByTestId("office-viewport-controls")).toBeInTheDocument();
    // The floor comes before the totals and the tables.
    expect(stage.compareDocumentPosition(within(view).getAllByTestId("stat-panel")[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(view).getByTestId("office-event-list")).toBeInTheDocument();
    expect(within(view).getByTestId("office-legend")).toBeInTheDocument();

    // Inspect a room from its sign.
    fireEvent.click(within(stage).getByRole("button", { name: "Inspect Development Lab" }));
    const panel = await screen.findByTestId("office-department-panel");
    expect(panel.dataset.departmentId).toBe("development-lab");
    expect(within(panel).getAllByTestId("office-department-member").map((m) => m.dataset.agentId).sort()).toEqual([
      "automation-agent",
      "browser-agent",
      "desktop-agent",
    ]);
    expect(within(panel).getByTestId("office-department-events").textContent).toContain("Browser Agent");
    expect(within(stage).getByTestId("office-floor-plan").dataset.focusedDepartment).toBe("development-lab");
    const chip = within(view).getAllByTestId("office-department-chip").find((c) => c.dataset.departmentId === "development-lab")!;
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    // A member selects the agent, which takes the side panel; clearing returns to the room.
    fireEvent.click(within(panel).getAllByTestId("office-department-member")[0]!);
    expect(screen.getByRole("heading", { name: "Automation Agent" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("office-department-panel")).toBeInTheDocument();

    // Whole office.
    fireEvent.click(screen.getByTestId("office-show-all"));
    expect(screen.queryByTestId("office-department-panel")).toBeNull();
    expect(within(stage).getByTestId("office-floor-plan").dataset.focusedDepartment).toBeUndefined();
  });

  it("shows a room inspected while an agent is selected, and keeps the selection", async () => {
    render(<View />);
    const view = await screen.findByTestId("office-view");
    const stage = within(view).getByTestId("office-stage");

    // Select an agent on the floor: its panel shows.
    fireEvent.click(within(stage).getAllByTestId("office-actor").find((a) => a.dataset.agentId === "knowledge-agent")!);
    expect(screen.getByRole("heading", { name: "Knowledge Agent" })).toBeInTheDocument();

    // Inspect another room: the room's panel shows, and the agent stays selected.
    fireEvent.click(within(stage).getByRole("button", { name: "Inspect Marketing Hub" }));
    expect(screen.getByTestId("office-department-panel").dataset.departmentId).toBe("marketing-hub");
    expect(screen.queryByRole("heading", { name: "Knowledge Agent" })).toBeNull();
    const knowledge = within(stage).getAllByTestId("office-actor").find((a) => a.dataset.agentId === "knowledge-agent")!;
    expect(knowledge.getAttribute("aria-pressed")).toBe("true");

    // Choosing an agent again shows the agent.
    fireEvent.click(knowledge);
    expect(screen.getByRole("heading", { name: "Knowledge Agent" })).toBeInTheDocument();
    expect(screen.queryByTestId("office-department-panel")).toBeNull();

    // Clearing it, with a room still in focus, returns to that room.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("office-department-panel").dataset.departmentId).toBe("marketing-hub");
  });

  it("opens looking at the room it was asked to", async () => {
    render(<View initialDepartment="development-lab" />);
    await screen.findByTestId("office-view");
    expect(screen.getByTestId("office-department-panel").dataset.departmentId).toBe("development-lab");
  });

  it("the widget shows the compact floor and opens the office looking at a clicked room", async () => {
    render(<OfficeWidget customizing={false} layoutLoaded />);
    await screen.findByTestId("office-widget-counts");
    const widget = screen.getByTestId("office-widget");
    expect(within(widget).getByTestId("office-floor-plan")).toBeInTheDocument();
    expect(within(widget).getAllByTestId("office-actor")).toHaveLength(11);
    expect(within(widget).queryByTestId("office-viewport-controls")).toBeNull();
    expect(widget.querySelector(".px-name")).toBeNull();

    fireEvent.click(within(widget).getByRole("button", { name: "Inspect Research Lab" }));
    const dialog = await screen.findByTestId("office-dialog");
    expect(within(dialog).getByTestId("office-department-panel").dataset.departmentId).toBe("research-lab");
    // Not a figure click: nothing is selected.
    expect(within(dialog).getAllByTestId("office-actor").every((a) => a.getAttribute("aria-pressed") === "false")).toBe(true);

    fireEvent.click(screen.getByTestId("office-dialog-close"));
    // The room was a way of looking; a plain expand opens the whole office.
    fireEvent.click(screen.getByTestId("office-widget-expand"));
    expect(within(await screen.findByTestId("office-dialog")).queryByTestId("office-department-panel")).toBeNull();
  });
});
