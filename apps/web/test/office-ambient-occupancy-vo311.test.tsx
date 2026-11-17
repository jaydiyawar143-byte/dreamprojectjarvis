// ---------------------------------------------------------------------------
// VO-3.1.1 — ambient occupancy: no two agents on a break stand on each other.
//
// Before this, every agent who chose the coffee machine (or the sofa, or a
// stroll point) was drawn at the one point that place had, so their figures
// and names were stacked. Pinned here:
//
//   * the spots: every place has distinct spots, and no spot anywhere overlaps
//     another, a room sign, or leaves its room;
//   * the allocator: two or more agents at each place get distinct spots; a
//     full place sends the next agent to an alternative or to its desk; a spot
//     is free again once its holder's slot ends; ties are broken the same way
//     whatever order the requests arrive in;
//   * the real schedules: over hours of simulated time, with every agent this
//     product defines, no two figures on a break ever overlap, each stands on
//     one of its place's spots, and every break spent at the desk instead has
//     a reason that can be checked;
//   * real work still wins: an agent at a second spot walks back from THAT
//     spot the moment work arrives, and sits on arrival;
//   * decoration writes nothing: the engine reads and writes no data.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import { OfficeScene } from "../src/components/office/office-scene";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildOfficeModel } from "../src/components/office/office-model";
import {
  AMBIENT_PLACES,
  HALLWAY,
  ROOMS,
  SIGN_W,
  WALL_H,
  DOOR_X,
  DOOR_W,
  placeAgents,
  roomFor,
  type AmbientPlaceId,
  type Rect,
  type Point,
} from "../src/components/office/pixel/floor-plan";
import {
  CHAT_WINDOW_MS,
  OCCUPANCY_EPOCH_MS,
  allocateSpots,
  ambientSlotAt,
  chatInWindow,
  personalSlotAt,
  requestKey,
  spotPoint,
  type SpotRequest,
} from "../src/components/office/pixel/ambient";
import {
  INITIAL_MOTION,
  advanceMotion,
  resolveMotion,
  type MotionContext,
} from "../src/components/office/pixel/agent-motion";
import { CHARACTER_SIZE } from "../src/components/office/pixel/sprites";
import { layoutTags } from "../src/components/office/pixel/tag-layout";
import type { AgentSummary } from "../src/lib/api";

const NOW = Date.parse("2026-11-15T09:00:00.000Z");

/** `AGENT_IDS` in `packages/agents/src/agent-policy.ts`, with each agent's domain. */
const ALL_AGENTS = [
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

function summary(agentId: string, domain: string): AgentSummary {
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

function seatsFor(ids: readonly string[]): Map<string, Point> {
  const agents = ALL_AGENTS.filter(([id]) => ids.includes(id)).map(([id, domain]) => summary(id, domain));
  const model = buildOfficeModel({ agents, tasks: [], activity: [], now: NOW });
  return new Map(placeAgents(model).map((entry) => [entry.actor.id, { x: entry.x, y: entry.y }]));
}

const box = (p: Point): Rect => ({ x: p.x, y: p.y, w: CHARACTER_SIZE.width, h: CHARACTER_SIZE.height });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const samePoint = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
const inside = (a: Rect, zone: Rect) => a.x >= zone.x && a.y >= zone.y && a.x + a.w <= zone.x + zone.w && a.y + a.h <= zone.y + zone.h;

const ALL_SPOTS = Object.values(AMBIENT_PLACES).flatMap((place) => place.spots.map((spot, index) => ({ place: place.id, index, spot })));

/** The places a break of this kind may use, as the allocator's candidates. */
function family(place: AmbientPlaceId): AmbientPlaceId[] {
  if (place === "lunch-a" || place === "lunch-b") return ["lunch-a", "lunch-b"];
  if (place.startsWith("stroll-")) return ["stroll-west", "stroll-mid", "stroll-east"];
  return [place];
}

function request(agentId: string, start: number, end: number, ...candidates: AmbientPlaceId[]): SpotRequest {
  return { agentId, start, end, candidates };
}

// ---------------------------------------------------------------------------

describe("VO-3.1.1 — the spots", () => {
  it("gives every shared break place more than one spot", () => {
    for (const id of ["coffee", "water", "sofa", "stroll-west", "stroll-mid", "stroll-east"] as const) {
      expect(AMBIENT_PLACES[id].spots.length, id).toBeGreaterThanOrEqual(2);
    }
    // The lunch table seats one on each side; the two sides stand in for each other.
    expect(AMBIENT_PLACES["lunch-a"].spots).toHaveLength(1);
    expect(AMBIENT_PLACES["lunch-b"].spots).toHaveLength(1);
    // A place's first spot is still where `at` says.
    for (const place of Object.values(AMBIENT_PLACES)) expect(place.spots[0]).toEqual(place.at);
  });

  it("never lets two spots overlap, anywhere in the building", () => {
    for (let i = 0; i < ALL_SPOTS.length; i += 1) {
      for (let j = i + 1; j < ALL_SPOTS.length; j += 1) {
        const a = ALL_SPOTS[i]!;
        const b = ALL_SPOTS[j]!;
        expect(overlaps(box(a.spot), box(b.spot)), `${a.place}#${a.index} x ${b.place}#${b.index}`).toBe(false);
      }
    }
  });

  it("keeps every spot on its room's floor (or in the hallway), off the signs and out of the doorways", () => {
    for (const { place, index, spot } of ALL_SPOTS) {
      const label = `${place}#${index}`;
      const room = AMBIENT_PLACES[place].room;
      if (room) {
        const r = roomFor(room);
        expect(inside(box(spot), { x: r.x + 1, y: r.y + WALL_H, w: r.w - 2, h: r.h - WALL_H - 1 }), label).toBe(true);
      } else {
        expect(inside(box(spot), { x: 0, y: HALLWAY.y, w: HALLWAY.w, h: HALLWAY.h }), label).toBe(true);
        // A hallway spot never blocks a door a walker must pass through.
        for (const r of ROOMS) {
          const door = { x: r.x + DOOR_X, y: HALLWAY.y, w: DOOR_W, h: HALLWAY.h };
          if (place !== "washroom") expect(overlaps(box(spot), door), `${label} at ${r.id}'s door`).toBe(false);
        }
      }
      for (const r of ROOMS) {
        expect(overlaps(box(spot), { x: r.x + 2, y: r.y + 1, w: SIGN_W, h: WALL_H - 3 }), `${label} on ${r.id}'s sign`).toBe(false);
      }
    }
  });
});

describe("VO-3.1.1 — the allocator", () => {
  it("gives two agents at the same place, at the same time, two different spots — for every shared place", () => {
    for (const place of ["coffee", "water", "sofa", "stroll-west", "stroll-mid", "stroll-east"] as const) {
      const result = allocateSpots([request("a-agent", 0, 100, place), request("b-agent", 10, 110, place)]);
      const a = result.get(requestKey("a-agent", 0));
      const b = result.get(requestKey("b-agent", 10));
      expect(a, place).toEqual({ place, spot: 0 });
      expect(b, place).toEqual({ place, spot: 1 });
      expect(overlaps(box(spotPoint(a!)), box(spotPoint(b!))), place).toBe(false);
    }
    // The lunch table: one on each side.
    const lunch = allocateSpots([request("a-agent", 0, 100, "lunch-a", "lunch-b"), request("b-agent", 0, 100, "lunch-a", "lunch-b")]);
    expect(lunch.get(requestKey("a-agent", 0))).toEqual({ place: "lunch-a", spot: 0 });
    expect(lunch.get(requestKey("b-agent", 0))).toEqual({ place: "lunch-b", spot: 0 });
  });

  it("sends the agent who arrives at a full place to its desk, or to an alternative of the same kind", () => {
    // Coffee holds two; the third goes back to the desk.
    const coffee = allocateSpots([
      request("a-agent", 0, 100, "coffee"),
      request("b-agent", 5, 100, "coffee"),
      request("c-agent", 10, 100, "coffee"),
    ]);
    expect(coffee.get(requestKey("c-agent", 10))).toBeNull();

    // The washroom holds one.
    const washroom = allocateSpots([request("a-agent", 0, 100, "washroom"), request("b-agent", 1, 100, "washroom")]);
    expect(washroom.get(requestKey("a-agent", 0))).toEqual({ place: "washroom", spot: 0 });
    expect(washroom.get(requestKey("b-agent", 1))).toBeNull();

    // The lunch table holds two, one per side; a third goes to the desk.
    const lunch = allocateSpots([
      request("a-agent", 0, 100, "lunch-b", "lunch-a"),
      request("b-agent", 1, 100, "lunch-b", "lunch-a"),
      request("c-agent", 2, 100, "lunch-a", "lunch-b"),
    ]);
    expect(lunch.get(requestKey("a-agent", 0))).toEqual({ place: "lunch-b", spot: 0 });
    expect(lunch.get(requestKey("b-agent", 1))).toEqual({ place: "lunch-a", spot: 0 });
    expect(lunch.get(requestKey("c-agent", 2))).toBeNull();

    // Strolls: a full stroll point sends the walker on to the next one; six
    // spots in all, and a seventh walker stays at the desk.
    const order: AmbientPlaceId[] = ["stroll-mid", "stroll-east", "stroll-west"];
    const strolls = allocateSpots(Array.from({ length: 7 }, (_, i) => request(`agent-${i}`, i, 1000, ...order)));
    const given = Array.from({ length: 7 }, (_, i) => strolls.get(requestKey(`agent-${i}`, i)));
    expect(given.slice(0, 6)).toEqual([
      { place: "stroll-mid", spot: 0 },
      { place: "stroll-mid", spot: 1 },
      { place: "stroll-east", spot: 0 },
      { place: "stroll-east", spot: 1 },
      { place: "stroll-west", spot: 0 },
      { place: "stroll-west", spot: 1 },
    ]);
    expect(given[6]).toBeNull();
  });

  it("frees a spot when its holder's break ends, and hands it to the next arrival", () => {
    const result = allocateSpots([
      request("a-agent", 0, 100, "sofa"),
      request("b-agent", 50, 150, "sofa"),
      // Starts exactly as A leaves: A's seat is free again.
      request("c-agent", 100, 200, "sofa"),
      // Starts while B and C hold both: nothing for it.
      request("d-agent", 120, 160, "sofa"),
      // Starts after B has gone: B's spot.
      request("e-agent", 150, 260, "sofa"),
    ]);
    expect(result.get(requestKey("a-agent", 0))).toEqual({ place: "sofa", spot: 0 });
    expect(result.get(requestKey("b-agent", 50))).toEqual({ place: "sofa", spot: 1 });
    expect(result.get(requestKey("c-agent", 100))).toEqual({ place: "sofa", spot: 0 });
    expect(result.get(requestKey("d-agent", 120))).toBeNull();
    expect(result.get(requestKey("e-agent", 150))).toEqual({ place: "sofa", spot: 1 });
  });

  it("decides ties by arrival time, then the agent's id — the same answer whatever order requests come in", () => {
    const requests = [
      request("zeta-agent", 0, 100, "coffee"),
      request("alpha-agent", 0, 100, "coffee"),
      request("mid-agent", 0, 100, "coffee"),
    ];
    const forward = allocateSpots(requests);
    const backward = allocateSpots([...requests].reverse());
    expect([...backward.entries()].sort()).toEqual([...forward.entries()].sort());
    expect(forward.get(requestKey("alpha-agent", 0))).toEqual({ place: "coffee", spot: 0 });
    expect(forward.get(requestKey("mid-agent", 0))).toEqual({ place: "coffee", spot: 1 });
    expect(forward.get(requestKey("zeta-agent", 0))).toBeNull();
  });
});

describe("VO-3.1.1 — the real schedules", () => {
  const EVERYONE = ALL_AGENTS.map(([id]) => id);
  const SOME = ["analytics-agent", "automation-agent", "conversational-assistant", "knowledge-agent", "marketing-agent"];

  /**
   * Every sample of `hours` of simulated time for this set of agents: who is
   * away at a break place, where, and at which place.
   */
  function sample(ids: readonly string[], hours: number, stepMs: number) {
    const seats = seatsFor(ids);
    const frames: Array<{ t: number; away: Array<{ id: string; point: Point; place: AmbientPlaceId }> }> = [];
    for (let t = NOW; t < NOW + hours * 3_600_000; t += stepMs) {
      const away: Array<{ id: string; point: Point; place: AmbientPlaceId }> = [];
      for (const id of ids) {
        const ctx: MotionContext = { agentId: id, seat: seats.get(id)!, agentIds: ids, ambientEnabled: true };
        const m = resolveMotion(INITIAL_MOTION, ctx, t);
        if (m.phase === "away" && !m.hidden && m.place) away.push({ id, point: m.point, place: m.place });
      }
      frames.push({ t, away });
    }
    return frames;
  }

  for (const [name, ids] of [
    ["every agent this product defines", EVERYONE],
    ["a smaller office (the same spots handed out again)", SOME],
  ] as const) {
    it(`never draws two agents on a break on top of each other — ${name}`, () => {
      const frames = sample(ids, 6, 3_000);
      let shared = 0;
      let maxTogether = 0;
      for (const frame of frames) {
        maxTogether = Math.max(maxTogether, frame.away.length);
        for (const figure of frame.away) {
          // Each figure stands exactly on one of its place's spots.
          expect(AMBIENT_PLACES[figure.place].spots.some((spot) => samePoint(spot, figure.point)), `${figure.id} at ${figure.place}`).toBe(true);
        }
        for (let i = 0; i < frame.away.length; i += 1) {
          for (let j = i + 1; j < frame.away.length; j += 1) {
            const a = frame.away[i]!;
            const b = frame.away[j]!;
            expect(overlaps(box(a.point), box(b.point)), `${a.id} and ${b.id} at ${new Date(frame.t).toISOString()}`).toBe(false);
            if (family(a.place).includes(b.place)) shared += 1;
          }
        }
      }
      // The test means something only if agents really did share places.
      expect(maxTogether).toBeGreaterThanOrEqual(2);
      if (ids.length === EVERYONE.length) expect(shared).toBeGreaterThan(0);
    });
  }

  it("keeps an agent on the same spot for its whole break, whenever it is asked", () => {
    const ids = EVERYONE;
    let checked = 0;
    for (let t = NOW; t < NOW + 2 * 3_600_000 && checked < 40; t += 7_000) {
      for (const id of ids) {
        const slot = ambientSlotAt(id, ids, t);
        if (!slot.at || slot.activity === "chat") continue;
        // Asked late, then early, then in the middle: one answer.
        const late = ambientSlotAt(id, ids, slot.end - 1);
        const early = ambientSlotAt(id, ids, slot.start);
        const middle = ambientSlotAt(id, ids, Math.floor((slot.start + slot.end) / 2));
        for (const other of [late, early, middle]) {
          expect(other.start).toBe(slot.start);
          expect(other.at).toEqual(slot.at);
          expect(other.place).toBe(slot.place);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("spends a break at the desk only for a reason that can be checked", () => {
    const ids = EVERYONE;
    const seen = { conversation: 0, boundary: 0, full: 0 };
    const done = new Set<string>();

    for (let t = NOW; t < NOW + 12 * 3_600_000; t += 10_000) {
      for (const id of ids) {
        const personal = personalSlotAt(id, t);
        if (!personal.place) continue;
        const key = requestKey(id, personal.start);
        if (done.has(key)) continue;
        done.add(key);
        const actual = ambientSlotAt(id, ids, personal.start);
        if (actual.activity === "chat") continue;
        if (actual.activity !== "desk") {
          expect(actual.yielded).toBeNull();
          continue;
        }

        expect(actual.yielded, key).not.toBeNull();
        seen[actual.yielded!] += 1;

        if (actual.yielded === "conversation") {
          const overlap = [-1, 0, 1].some((delta) => {
            const chat = chatInWindow(ids, personal.start + delta * CHAT_WINDOW_MS);
            return !!chat && chat.pair.includes(id) && chat.start < personal.end && personal.start < chat.end;
          });
          expect(overlap, key).toBe(true);
        } else if (actual.yielded === "boundary") {
          const epoch = Math.floor(personal.start / OCCUPANCY_EPOCH_MS);
          expect(personal.end, key).toBeGreaterThan((epoch + 1) * OCCUPANCY_EPOCH_MS);
        } else {
          // Full: at the moment it would have started, every spot it could
          // use is held by another agent's break that is running then.
          const held = ids
            .filter((other) => other !== id)
            .map((other) => ambientSlotAt(other, ids, personal.start))
            .filter((slot) => slot.at !== null && slot.activity !== "chat");
          for (const place of family(personal.place)) {
            for (const spot of AMBIENT_PLACES[place].spots) {
              expect(held.some((slot) => samePoint(slot.at!, spot)), `${key}: ${place} spot free`).toBe(true);
            }
          }
        }
      }
    }
    // Over twelve hours each reason occurs; the checks above ran on every one.
    expect(seen.boundary).toBeGreaterThan(0);
    expect(seen.full).toBeGreaterThan(0);
    expect(seen.conversation).toBeGreaterThan(0);
  });
});

describe("VO-3.1.1 — the names of a crowded break room", () => {
  it("never draws a tag over another drawn tag or another figure, with every agent in the office, for hours", () => {
    const ids = ALL_AGENTS.map(([id]) => id);
    const seats = seatsFor(ids);
    let crowded = 0;
    let withheld = 0;
    let oldRuleOverlaps = 0;
    for (let t = NOW; t < NOW + 6 * 3_600_000; t += 3_000) {
      const figures = ids.map((id) => {
        const ctx: MotionContext = { agentId: id, seat: seats.get(id)!, agentIds: ids, ambientEnabled: true };
        const m = resolveMotion(INITIAL_MOTION, ctx, t);
        return { id, m, figure: { id, point: m.point, text: id.replace(/-(agent|assistant)$/, ""), seated: m.phase === "seated", moving: m.phase === "walking" || m.phase === "returning" } };
      });
      const shown = figures.filter((f) => !f.m.hidden);
      if (shown.filter((f) => f.m.phase === "away").length >= 3) crowded += 1;
      const tags = layoutTags(shown.map((f) => f.figure));
      // The renderer's rule: a tag is drawn when it is clear, or its figure is seated.
      const drawn = shown.filter((f) => {
        const tag = tags.get(f.id)!;
        const draw = tag.clear || f.m.phase === "seated";
        if (!draw) withheld += 1;
        return draw;
      });
      const plate = (f: (typeof shown)[number]) => {
        const tag = tags.get(f.id)!;
        return { x: f.m.point.x + tag.plate.x, y: f.m.point.y + tag.plate.y, w: tag.plate.w, h: tag.plate.h };
      };
      // The rule before VO-3.1.1 drew every tag of a figure standing still.
      const oldDrawn = shown.filter((f) => tags.get(f.id)!.clear || !f.figure.moving);
      for (const a of oldDrawn) {
        for (const b of oldDrawn) {
          if (a.id < b.id && !a.figure.moving && !b.figure.moving && overlaps(plate(a), plate(b))) oldRuleOverlaps += 1;
        }
      }
      for (const a of drawn) {
        // Only figures standing still are judged against each other: a walker
        // passing over a tag is a moment, not a place.
        if (a.figure.moving) continue;
        for (const b of shown) {
          if (a.id === b.id || b.figure.moving) continue;
          expect(overlaps(plate(a), box(b.m.point)), `${a.id}'s tag on ${b.id} at ${new Date(t).toISOString()}`).toBe(false);
          if (drawn.includes(b) && a.id < b.id) {
            expect(overlaps(plate(a), plate(b)), `${a.id} and ${b.id} tags at ${new Date(t).toISOString()}`).toBe(false);
          }
        }
      }
    }
    // The office really was crowded, and the old rule really did overlap there.
    expect(crowded).toBeGreaterThan(0);
    expect(withheld).toBeGreaterThan(0);
    expect(oldRuleOverlaps).toBeGreaterThan(0);
  });

  it("is what the renderer draws: a standing figure with no clean place for its name carries none", () => {
    const ids = ALL_AGENTS.map(([id]) => id);
    const agents = ALL_AGENTS.map(([id, domain]) => summary(id, domain));
    const officeModel = buildOfficeModel({ agents, tasks: [], activity: [], now: NOW });
    const seats = new Map(placeAgents(officeModel).map((entry) => [entry.actor.id, { x: entry.x, y: entry.y }]));

    // The first instant at which a figure on a break has no clean tag.
    let found: { t: number; id: string } | null = null;
    for (let t = NOW; t < NOW + 6 * 3_600_000 && !found; t += 3_000) {
      const figures = ids.map((id) => {
        const m = resolveMotion(INITIAL_MOTION, { agentId: id, seat: seats.get(id)!, agentIds: ids, ambientEnabled: true }, t);
        return { m, figure: { id, point: m.point, text: id, seated: m.phase === "seated", moving: m.phase === "walking" || m.phase === "returning" } };
      });
      const shown = figures.filter((f) => !f.m.hidden);
      // The scene's tags use each agent's own label; reproduce exactly.
      const labelled = shown.map((f) => ({ ...f.figure, text: officeModel.agents.find((a) => a.id === f.figure.id)!.label.replace(/\s+(Agent|Assistant)$/i, "") }));
      const tags = layoutTags(labelled);
      const unclear = shown.find((f) => f.m.phase === "away" && !tags.get(f.figure.id)!.clear);
      if (unclear) found = { t, id: unclear.figure.id };
    }
    expect(found, "a crowded instant").not.toBeNull();

    const view = render(
      <OfficeScene model={officeModel} selectedActorId={null} onSelectActor={() => {}} clock={found!.t} />
    );
    const actor = view.container.querySelector(`[data-testid="office-actor"][data-agent-id="${found!.id}"]`)!;
    expect(actor.getAttribute("data-phase")).toBe("away");
    expect(actor.querySelector('[data-testid="office-actor-tag"]')).toBeNull();
    // Its name is still there for anyone who points at it or uses a screen reader.
    expect(actor.getAttribute("aria-label")).toContain(officeModel.agents.find((a) => a.id === found!.id)!.label);
    // Every seated figure still has its tag.
    for (const seated of view.container.querySelectorAll('[data-testid="office-actor"][data-phase="seated"]')) {
      expect(seated.querySelector('[data-testid="office-actor-tag"]')).not.toBeNull();
    }
    view.unmount();
  });
});

describe("VO-3.1.1 — real work still interrupts a break, from the agent's own spot", () => {
  it("walks back from a SECOND spot the moment work arrives, and sits on arrival", () => {
    const ids = ALL_AGENTS.map(([id]) => id);
    const seats = seatsFor(ids);
    let found: { id: string; t: number; spot: Point } | null = null;

    outer: for (let t = NOW; t < NOW + 12 * 3_600_000; t += 5_000) {
      for (const id of ids) {
        const ctx: MotionContext = { agentId: id, seat: seats.get(id)!, agentIds: ids, ambientEnabled: true };
        const m = resolveMotion(INITIAL_MOTION, ctx, t);
        if (m.phase !== "away" || !m.place || m.hidden) continue;
        const index = AMBIENT_PLACES[m.place].spots.findIndex((spot) => samePoint(spot, m.point));
        if (index >= 1) {
          found = { id, t, spot: m.point };
          break outer;
        }
      }
    }
    expect(found, "an agent standing at a place's second spot").not.toBeNull();
    const { id, t, spot } = found!;
    const ctx: MotionContext = { agentId: id, seat: seats.get(id)!, agentIds: ids, ambientEnabled: true };

    const interrupted = advanceMotion(INITIAL_MOTION, ctx, true, t);
    const first = resolveMotion(interrupted, ctx, t);
    expect(first.phase).toBe("returning");
    expect(first.ambient).toBeNull();
    // It leaves from where it actually stood.
    expect(first.point).toEqual(spot);

    let arrival = t;
    while (arrival < t + 90_000 && resolveMotion(interrupted, ctx, arrival).phase !== "seated") arrival += 100;
    const seated = resolveMotion(interrupted, ctx, arrival);
    expect(seated.phase).toBe("seated");
    expect(seated.point).toEqual(seats.get(id));
    // And it stays at the desk while the work lasts, whatever the schedule says.
    expect(resolveMotion(interrupted, ctx, arrival + 10 * 60_000).phase).toBe("seated");
  });
});

describe("VO-3.1.1 — decoration writes nothing", () => {
  it("computes hours of occupancy without one network call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ids = ALL_AGENTS.map(([id]) => id);
    for (let t = NOW; t < NOW + 3_600_000; t += 15_000) for (const id of ids) ambientSlotAt(id, ids, t);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("imports nothing but the floor plan and the sprites", () => {
    for (const file of ["ambient.ts", "agent-motion.ts"]) {
      // Vitest runs each workspace from its own folder (apps/web).
      const source = readFileSync(resolve(process.cwd(), "src/components/office/pixel", file), "utf8");
      const imports = [...source.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((match) => match[1]);
      for (const path of imports) expect(["./floor-plan", "./sprites", "./ambient", "./motion"], `${file} imports ${path}`).toContain(path);
    }
  });
});
