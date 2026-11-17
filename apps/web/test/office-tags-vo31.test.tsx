// ---------------------------------------------------------------------------
// VO-3.1 audit — name tags, the room close-up, and what the zoom controls
// cover.
//
// Each of these was seen in the running app before it was fixed:
//
//   * neighbours' tags ran into each other (desks are 19 apart, a tag up to 27
//     wide), and the first desk's tag crossed the room's wall;
//   * a figure in the hallway dropped its tag on the sign of the room below;
//   * a figure in a doorway had its tag outside the building;
//   * a room close-up cut the hallway — and anyone in it — in half;
//   * JARVIS's tag and queue markers were drawn below its room's wall;
//   * "no agent stationed here" was written across the meeting table;
//   * the zoom controls lay over the floor's corner, on top of figures.
//
// jsdom has no layout, so these pin the GEOMETRY the renderer is handed; the
// browser audit (docs/VIRTUAL_OFFICE.md) measures the painted result.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import { buildOfficeModel } from "../src/components/office/office-model";
import { OfficeScene } from "../src/components/office/office-scene";
import {
  HALLWAY,
  HALL_Y,
  DOOR_WALK_X,
  ROOMS,
  SCENE,
  SIGN_W,
  WALL_H,
  placeAgents,
  roomFor,
  roomViewport,
  type Rect,
} from "../src/components/office/pixel/floor-plan";
import {
  FIGURE_EXTENT,
  TAG_BASELINE,
  figureFitsView,
  layoutTags,
  tagZone,
  type TagFigure,
  type TagPlacement,
} from "../src/components/office/pixel/tag-layout";
import { viewportAround, visibleArea } from "../src/components/office/pixel/use-office-viewport";
import {
  CHARACTER_SIZE,
  GLYPH_ALERT,
  GLYPH_ASSIGNED,
  GLYPH_CHECK,
  GLYPH_QUEUED,
  GLYPH_RESEARCH,
  GLYPH_TOOL,
  GLYPH_WAIT,
  GLYPH_WORK,
  SPEECH_BUBBLE,
  coreSprite,
  spriteSize,
} from "../src/components/office/pixel/sprites";
import { MAX_QUEUE_MARKERS, type Point } from "../src/components/office/pixel/floor-plan";
import type { AgentSummary } from "../src/lib/api";

const NOW = Date.parse("2026-11-14T09:00:00.000Z");

function agent(agentId: string, domain: string): AgentSummary {
  return {
    agentId,
    domain,
    description: agentId,
    allowedTools: [],
    toolCount: 0,
    writesRequireApproval: false,
    clientSelectable: true,
    registered: true,
    availability: "AVAILABLE",
  };
}

const TEAM: AgentSummary[] = [
  agent("conversational-assistant", "general"),
  agent("location-agent", "location"),
  agent("desktop-agent", "desktop"),
  agent("automation-agent", "automation"),
  agent("marketing-agent", "marketing"),
  agent("meta-ads-agent", "meta-ads"),
  agent("knowledge-agent", "knowledge"),
  agent("analytics-agent", "analytics"),
];

function model(agents: AgentSummary[] = TEAM) {
  return buildOfficeModel({ agents, tasks: [], activity: [], now: NOW });
}

/** A tag's plate in scene coordinates. */
function plateOf(figure: TagFigure, tag: TagPlacement): Rect {
  return { x: figure.point.x + tag.plate.x, y: figure.point.y + tag.plate.y, w: tag.plate.w, h: tag.plate.h };
}

function hits(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
}

function inside(a: Rect, zone: Rect): boolean {
  return a.x >= zone.x - 0.01 && a.y >= zone.y - 0.01 && a.x + a.w <= zone.x + zone.w + 0.01 && a.y + a.h <= zone.y + zone.h + 0.01;
}

function seatedFigures(): TagFigure[] {
  return placeAgents(model()).map((entry) => ({
    id: entry.actor.id,
    point: { x: entry.x, y: entry.y },
    text: entry.actor.label.replace(/\s+(Agent|Assistant)$/i, ""),
    seated: entry.desk !== null,
    moving: false,
  }));
}

const SIGNS: Rect[] = ROOMS.map((room) => ({ x: room.x + 2, y: room.y + 1, w: SIGN_W, h: WALL_H - 3 }));

describe("VO-3.1 audit — name tags", () => {
  it("keeps every seated tag apart from its neighbours and inside its own room", () => {
    const figures = seatedFigures();
    const tags = layoutTags(figures);
    const plates = figures.map((figure) => ({ figure, plate: plateOf(figure, tags.get(figure.id)!) }));

    for (const { figure, plate } of plates) {
      expect(tags.get(figure.id)!.clear, `${figure.id} is clear`).toBe(true);
      expect(inside(plate, tagZone(figure.point)), `${figure.id} stays in its room`).toBe(true);
      for (const other of plates) {
        if (other.figure.id === figure.id) continue;
        expect(hits(plate, other.plate), `${figure.id} x ${other.figure.id}`).toBe(false);
        const body = { x: other.figure.point.x, y: other.figure.point.y, w: 10, h: 14 };
        expect(hits(plate, body), `${figure.id} tag on ${other.figure.id}`).toBe(false);
      }
    }
  });

  it("is the old position whenever that position is free", () => {
    const [only] = seatedFigures().filter((figure) => figure.id === "knowledge-agent");
    const tag = layoutTags([only!]).get(only!.id)!;
    expect(tag.side).toBe("below");
    // Centred under the figure, the baseline where it always was.
    expect(tag.x).toBeCloseTo(5, 5);
    expect(tag.y).toBeCloseTo(14 + 1.1 + TAG_BASELINE, 5);
  });

  it("keeps a hallway walker's tag in the hallway, off the signs below", () => {
    for (let x = 6; x < SCENE.w - 14; x += 7) {
      const walker: TagFigure = { id: "w", point: { x, y: HALL_Y }, text: "Conversational", seated: false, moving: true };
      const tag = layoutTags([walker]).get("w")!;
      const plate = plateOf(walker, tag);
      const hall = { x: 0, y: HALLWAY.y, w: SCENE.w, h: HALLWAY.h };
      expect(inside(plate, hall), `x=${x} inside the hallway`).toBe(true);
      for (const sign of SIGNS) expect(hits(plate, sign), `x=${x} off the signs`).toBe(false);
    }
  });

  it("keeps a tag inside the building while its figure walks through a door", () => {
    const hub = roomFor("marketing-hub");
    for (let y = hub.y + 36; y <= HALL_Y; y += 2) {
      const walker: TagFigure = { id: "w", point: { x: hub.x + DOOR_WALK_X, y }, text: "Meta Ads", seated: false, moving: true };
      const plate = plateOf(walker, layoutTags([walker]).get("w")!);
      expect(inside(plate, SCENE), `y=${y}`).toBe(true);
      expect(plate.y + plate.h, `y=${y} above the hallway's far wall`).toBeLessThanOrEqual(HALLWAY.y + HALLWAY.h);
      expect(plate.x + plate.w, `y=${y} inside the room's right wall`).toBeLessThanOrEqual(hub.x + hub.w);
    }
  });

  it("keeps the tag of a figure that is in view inside the view", () => {
    const figure: TagFigure = { id: "a", point: { x: 100, y: 46 }, text: "Automation", seated: false, moving: false };
    // The view ends just under the figure's feet: the old tag was cut off.
    const view: Rect = { x: 60, y: 0, w: 120, h: 61 };
    const plate = plateOf(figure, layoutTags([figure], { view }).get("a")!);
    expect(inside(plate, view)).toBe(true);
  });

  it("does not move a seated tag when someone walks past it", () => {
    const figures = seatedFigures();
    const before = layoutTags(figures);
    const seat = figures.find((figure) => figure.id === "marketing-agent")!;
    const passer: TagFigure = { id: "zz-passer", point: { x: seat.point.x + 2, y: seat.point.y + 15 }, text: "Desktop", seated: false, moving: true };
    const after = layoutTags([...figures, passer]);
    for (const figure of figures) expect(after.get(figure.id)).toEqual(before.get(figure.id));
    // The walker's own tag is the one that yields.
    const walkerPlate = plateOf(passer, after.get(passer.id)!);
    for (const figure of figures) expect(hits(walkerPlate, plateOf(figure, after.get(figure.id)!))).toBe(false);
  });

  it("gives the same answer whatever order the figures arrive in", () => {
    const figures = seatedFigures();
    expect(layoutTags([...figures].reverse())).toEqual(layoutTags(figures));
  });
});

describe("VO-3.1 audit — the painted floor", () => {
  function renderFloor(props: Partial<React.ComponentProps<typeof OfficeScene>> = {}) {
    return render(
      <OfficeScene model={model()} selectedActorId={null} onSelectActor={() => {}} ambient={false} clock={NOW} {...props} />
    );
  }

  it("draws each tag on a plate, at the width the layout measured", () => {
    renderFloor();
    const actors = screen.getAllByTestId("office-actor");
    expect(actors).toHaveLength(TEAM.length);
    for (const actor of actors) {
      const text = actor.querySelector("text.px-name")!;
      const plate = actor.querySelector('[data-testid="office-actor-tag-plate"]')!;
      expect(plate).not.toBeNull();
      const width = Number(text.getAttribute("textLength"));
      expect(width).toBeGreaterThan(0);
      expect(Number(plate.getAttribute("width"))).toBeGreaterThan(width);
      // The text sits inside its plate.
      expect(Number(text.getAttribute("y"))).toBeGreaterThan(Number(plate.getAttribute("y")));
      expect(Number(text.getAttribute("y"))).toBeLessThan(Number(plate.getAttribute("y")) + Number(plate.getAttribute("height")));
    }
  });

  it("keeps JARVIS's tag and queue markers inside the Command Center", () => {
    const busy = buildOfficeModel({
      agents: TEAM,
      tasks: Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`,
        title: `t${i}`,
        description: null,
        dueAt: null,
        priority: "NORMAL",
        completedAt: null,
        createdAt: new Date(NOW - 60_000).toISOString(),
        status: "PENDING",
        createdBy: "jarvis",
      })),
      activity: [],
      now: NOW,
    });
    render(<OfficeScene model={busy} selectedActorId={null} onSelectActor={() => {}} ambient={false} clock={NOW} />);
    const room = ROOMS[0]!;
    const core = screen.getByTestId("office-system-actor");
    const [, ty] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(core.getAttribute("transform")!)!.slice(1).map(Number);
    const floorBottom = room.y + room.h - 1;

    const tag = core.querySelector("text")!;
    expect(ty! + Number(tag.getAttribute("y"))).toBeLessThanOrEqual(floorBottom);
    const markers = within(core).getAllByTestId("office-queue-marker");
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(ty! + Number(marker.getAttribute("y")) + Number(marker.getAttribute("height"))).toBeLessThanOrEqual(floorBottom);
    }
  });

  it("writes the empty-room note clear of the room's furniture", () => {
    render(
      <OfficeScene model={model([])} selectedActorId={null} onSelectActor={() => {}} ambient={false} clock={NOW} />
    );
    const notes = screen.getAllByTestId("office-empty-desk");
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      const y = Number(note.getAttribute("y"));
      const x = Number(note.getAttribute("x"));
      const room = ROOMS.find((candidate) => x > candidate.x && x < candidate.x + candidate.w && y > candidate.y && y < candidate.y + candidate.h)!;
      const band: Rect = { x: room.x + 12, y: y - 3.5, w: room.w - 24, h: 4.5 };
      for (const fixture of room.fixtures) {
        const size = spriteSize(fixture.sprite);
        const box: Rect = { x: room.x + fixture.x, y: room.y + fixture.y, w: size.width, h: size.height };
        expect(hits(band, box), `${room.id} note on furniture`).toBe(false);
      }
    }
  });

  it("does not lay the zoom controls over the floor", () => {
    renderFloor({ interactive: true, className: "absolute inset-0" });
    const controls = screen.getByTestId("office-viewport-controls");
    const floor = screen.getByTestId("office-floor-plan");
    // The controls are a strip of their own, beside the floor's box — not a
    // layer positioned on top of it.
    expect(controls.className).not.toMatch(/\babsolute\b/);
    expect(floor.parentElement!.contains(controls)).toBe(false);
  });
});

describe("VO-3.1 audit — a room close up", () => {
  it("shows the whole hallway beside the room, so nobody in it is cut in half", () => {
    for (const room of ROOMS) {
      const view = viewportAround(roomViewport(room.id));
      // The room itself.
      expect(view.y).toBeLessThanOrEqual(room.y);
      expect(view.y + view.h).toBeGreaterThanOrEqual(room.y + room.h);
      expect(view.x).toBeLessThanOrEqual(room.x);
      expect(view.x + view.w).toBeGreaterThanOrEqual(room.x + room.w);
      // And the full height of the hallway its door opens onto.
      expect(view.y).toBeLessThanOrEqual(HALLWAY.y);
      expect(view.y + view.h).toBeGreaterThanOrEqual(HALLWAY.y + HALLWAY.h);
      expect(view.x + view.w).toBeLessThanOrEqual(SCENE.w + 1e-9);
      expect(view.y + view.h).toBeLessThanOrEqual(SCENE.h + 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// VO-3.1.1 — nothing is cut at the edge of a close-up
//
// A close-up letterboxes its viewBox into the floor's box, so neighbouring
// rooms show at the sides. Their figures used to be drawn cut in half by the
// edge, and a figure in view could have its name cut off. Now a figure is drawn
// only when all of it fits the visible area, and a drawn figure's tag always
// fits too.
// ---------------------------------------------------------------------------

/** The two boxes the browser audit measured: the desktop floor and the phone floor. */
const BOXES = [
  { name: "desktop", width: 1018, height: 476 },
  { name: "phone", width: 320, height: 222 },
] as const;

function withSvgSize<T>(width: number, height: number, run: () => T): T {
  const original = Element.prototype.getBoundingClientRect;
  const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.tagName.toLowerCase() !== "svg") return original.call(this);
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  });
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

const fits = (a: Rect, zone: Rect) =>
  a.x >= zone.x - 1e-6 && a.y >= zone.y - 1e-6 && a.x + a.w <= zone.x + zone.w + 1e-6 && a.y + a.h <= zone.y + zone.h + 1e-6;

describe("VO-3.1.1 — the visible area and a figure's extent", () => {
  it("grows the viewBox along the axis the box has room to spare, centred", () => {
    const box: Rect = { x: 100, y: 50, w: 100, h: 50 };
    expect(visibleArea(box, { width: 400, height: 100 })).toEqual({ x: 50, y: 50, w: 200, h: 50 });
    expect(visibleArea(box, { width: 200, height: 200 })).toEqual({ x: 100, y: 25, w: 100, h: 100 });
    expect(visibleArea(box, null)).toEqual(box);
  });

  it("counts everything a figure draws: its selection ring, its state glyph and a speech bubble", () => {
    const glyphs = [GLYPH_ALERT, GLYPH_ASSIGNED, GLYPH_CHECK, GLYPH_QUEUED, GLYPH_RESEARCH, GLYPH_TOOL, GLYPH_WAIT, GLYPH_WORK].map(spriteSize);
    const bubble = spriteSize(SPEECH_BUBBLE);
    const parts: Rect[] = [
      { x: -2.4, y: -3.4, w: CHARACTER_SIZE.width + 4.8, h: CHARACTER_SIZE.height + 5.8 },
      ...glyphs.map((size) => ({ x: CHARACTER_SIZE.width - 2, y: -4, w: size.width, h: size.height })),
      { x: 1, y: -9, w: bubble.width, h: bubble.height },
    ];
    for (const part of parts) expect(fits(part, FIGURE_EXTENT)).toBe(true);
  });
});

describe("VO-3.1.1 — a close-up never cuts a figure or its name", () => {
  for (const size of BOXES) {
    it(`draws a figure whole or not at all, and its whole tag, in all six rooms (${size.name} floor)`, () => {
      const team = model();
      const placed = placeAgents(team);
      let hidden = 0;
      let drawn = 0;

      for (const room of ROOMS) {
        const visible = visibleArea(viewportAround(roomViewport(room.id)), size);
        const view = withSvgSize(size.width, size.height, () =>
          render(
            <OfficeScene
              model={team}
              selectedActorId={null}
              onSelectActor={() => {}}
              focusDepartment={room.id}
              interactive
              ambient={false}
              clock={NOW}
              className="absolute inset-0"
            />
          )
        );

        for (const entry of placed) {
          const point: Point = { x: entry.x, y: entry.y };
          const actor = view.container.querySelector(`[data-testid="office-actor"][data-agent-id="${entry.actor.id}"]`)!;
          const shouldShow = figureFitsView(point, visible);
          const label = `${room.id}: ${entry.actor.id}`;
          if (!shouldShow) {
            hidden += 1;
            expect(actor.getAttribute("data-offview"), label).toBe("true");
            expect(actor.getAttribute("display"), label).toBe("none");
            expect(actor.querySelector('[data-testid="office-actor-tag"]'), label).toBeNull();
            continue;
          }
          drawn += 1;
          expect(actor.getAttribute("data-offview"), label).toBeNull();
          const plate = actor.querySelector('[data-testid="office-actor-tag-plate"]');
          expect(plate, `${label} has its tag`).not.toBeNull();
          const rect: Rect = {
            x: point.x + Number(plate!.getAttribute("x")),
            y: point.y + Number(plate!.getAttribute("y")),
            w: Number(plate!.getAttribute("width")),
            h: Number(plate!.getAttribute("height")),
          };
          expect(fits(rect, visible), `${label}: tag inside the view`).toBe(true);
        }

        // JARVIS too: whole, or not drawn.
        const core = view.container.querySelector('[data-testid="office-system-actor"]')!;
        const cc = ROOMS[0]!;
        const coreSize = spriteSize(coreSprite(0, "#000000"));
        const extent: Rect = {
          x: cc.x + cc.core!.x - 3.5,
          y: cc.y + cc.core!.y - 5,
          w: coreSize.width + 1 + MAX_QUEUE_MARKERS * 3 + 3.5,
          h: coreSize.height + 9,
        };
        expect(core.getAttribute("data-offview"), `${room.id}: JARVIS`).toBe(fits(extent, visible) ? null : "true");
        if (room.id === "command-center") expect(core.getAttribute("data-offview")).toBeNull();

        view.unmount();
      }

      // Both rules were exercised: neighbours really are at the edges.
      expect(hidden).toBeGreaterThan(0);
      expect(drawn).toBeGreaterThan(0);
    });
  }

  it("keeps the whole tag of every walker it draws, along the hallway and through every door", () => {
    // Walking points: the hallway line, and each door's route between the
    // hallway and its room's walkway.
    const points: Point[] = [];
    for (let x = 0; x <= SCENE.w - 10; x += 2) points.push({ x, y: HALL_Y });
    for (const room of ROOMS) {
      const doorX = room.x + DOOR_WALK_X;
      const walkway = room.y + 36;
      const [from, to] = room.row === "top" ? [walkway, HALL_Y] : [HALL_Y, walkway];
      for (let y = from; y <= to; y += 2) points.push({ x: doorX, y });
      for (let x = room.x + 2; x <= room.x + DOOR_WALK_X; x += 3) points.push({ x, y: walkway });
    }

    let checked = 0;
    for (const size of BOXES) {
      for (const room of ROOMS) {
        const visible = visibleArea(viewportAround(roomViewport(room.id)), size);
        for (const point of points) {
          if (!figureFitsView(point, visible)) continue;
          const walker: TagFigure = { id: "w", point, text: "Conversational", seated: false, moving: true };
          const tag = layoutTags([walker], { view: visible }).get("w")!;
          const where = `${size.name} ${room.id} at ${point.x},${point.y}`;
          expect(tag.inView, where).toBe(true);
          expect(fits(plateOf(walker, tag), visible), where).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("puts the tag where the view is when only a sliver of the figure's room is on screen", () => {
    // The Marketing Hub's right end at the left edge of the view: about 20
    // units of its floor are visible, and "Conversational" is 28 wide. The tag
    // must not straddle the edge of the screen to stay on the room's floor.
    const hub = roomFor("marketing-hub");
    const view: Rect = { x: hub.x + hub.w - 21, y: 0, w: 53, h: 120 };
    const figure: TagFigure = { id: "c", point: { x: hub.x + hub.w - 18, y: 40 }, text: "Conversational", seated: false, moving: false };
    expect(figureFitsView(figure.point, view)).toBe(true);
    const tag = layoutTags([figure], { view }).get("c")!;
    expect(tag.inView).toBe(true);
    expect(fits(plateOf(figure, tag), view)).toBe(true);
  });

  it("introduces no hiding elsewhere: the whole office and the widget draw everyone", () => {
    for (const size of BOXES) {
      const view = withSvgSize(size.width, size.height, () =>
        render(
          <OfficeScene
            model={model()}
            selectedActorId={null}
            onSelectActor={() => {}}
            interactive
            ambient={false}
            clock={NOW}
            className="absolute inset-0"
          />
        )
      );
      for (const actor of view.container.querySelectorAll('[data-testid="office-actor"]')) {
        expect(actor.getAttribute("data-offview")).toBeNull();
        expect(actor.querySelector('[data-testid="office-actor-tag"]')).not.toBeNull();
      }
      view.unmount();
    }
    const widget = render(
      <OfficeScene model={model()} selectedActorId={null} onSelectActor={() => {}} compact ambient={false} clock={NOW} />
    );
    expect(widget.container.querySelectorAll('[data-offview="true"]')).toHaveLength(0);
    widget.unmount();
  });
});
