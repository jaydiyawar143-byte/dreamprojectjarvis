// ---------------------------------------------------------------------------
// VO-2.2 Stage 2 / VO-3.1 — the building, and the one place a state becomes a
// look.
//
// The office is a fixed building: six rooms in two rows of three, opening
// onto ONE hallway between the rows. Every room has a door on the hallway side
// (the bottom wall for the top row, the top wall for the bottom row, always at
// the room's right end), a signed plaque, one row of desks along the back, and
// its own furniture. The Break Zone holds the shared facilities — coffee,
// water, a lunch table and a sofa — and the washroom door is at the hallway's
// far end. Nothing here is a claim about data: a room exists whether or not
// anyone sits in it.
//
// Two small functions read a state, `agentVisual` and `systemVisual`, and they
// map exactly the lifecycle `office-lifecycle.ts` derives from durable rows.
// Typing is mapped ONLY from the three states a RUNNING task produces.
//
// PURE: no React, no DOM, no clock.
// ---------------------------------------------------------------------------

import {
  OFFICE_DEPARTMENTS,
  type DepartmentId,
  type OfficeAgentActor,
  type OfficeModel,
  type OfficeSystemActor,
} from "../office-model";
import type { OfficeAgentLifecycle } from "../office-lifecycle";
import {
  BOOKSHELF,
  CHAIR,
  CHART_SCREEN,
  COFFEE_MACHINE,
  CONFERENCE_TABLE,
  DESK_SEAT_X,
  DESK_SEAT_Y,
  LUNCH_TABLE,
  PLANT,
  RUG,
  SERVER_RACK,
  SOFA,
  VENDING,
  WATER_COOLER,
  WHITEBOARD,
  type PixelSprite,
} from "./sprites";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export const ROOM_W = 84;
export const ROOM_H = 62;
/** The wall band at the top of a room, where its sign hangs. */
export const WALL_H = 10;

const MARGIN = 4;
const GAP = 6;
const COLUMN_X = [MARGIN, MARGIN + ROOM_W + GAP, MARGIN + 2 * (ROOM_W + GAP)] as const;
const TOP_Y = MARGIN;
/** The hallway between the rows: tall enough for a figure to walk along it. */
export const HALLWAY: Rect = { x: 0, y: TOP_Y + ROOM_H, w: COLUMN_X[2] + ROOM_W + MARGIN, h: 18 };
const BOTTOM_Y = HALLWAY.y + HALLWAY.h;

/** The whole scene, in pixel units. The SVG viewBox is exactly this. */
export const SCENE: Rect = { x: 0, y: 0, w: HALLWAY.w, h: BOTTOM_Y + ROOM_H + MARGIN };

/** The line a walking figure's top-left follows along the hallway. */
export const HALL_Y = HALLWAY.y + 2;

/** Door openings, room-relative: 12 wide, at the right end of the hallway wall. */
export const DOOR_X = ROOM_W - 15;
export const DOOR_W = 12;
/** The x a figure walks through a door at (its left edge). */
export const DOOR_WALK_X = DOOR_X + 1;
/** The in-room walkway line, below the desk row. */
export const WALK_Y = 36;
/** The plaque spans the wall band left of the door. */
export const SIGN_W = DOOR_X - 4;

/** The washroom door at the hallway's far end, and where a figure stands to use it. */
export const WC_DOOR_AT: Point = { x: HALLWAY.w - 13, y: HALLWAY.y + 2 };
export const WC_SPOT: Point = { x: WC_DOOR_AT.x, y: HALL_Y };

export interface RoomTheme {
  /** The room's accent: sign text, door light, outfits, the chart bars. */
  accent: string;
  /** The two floor tile colours. */
  floor: string;
  floorAlt: string;
  wall: string;
}

export interface Fixture {
  sprite: PixelSprite;
  /** Relative to the room's origin. */
  x: number;
  y: number;
  /** A fixture drawn OVER seated figures (a table edge, a sofa back). */
  front?: boolean;
}

export type RoomRow = "top" | "bottom";

export interface Room extends Rect {
  id: DepartmentId;
  label: string;
  row: RoomRow;
  theme: RoomTheme;
  /** Workstations, relative to the room. One row along the back wall. */
  desks: Point[];
  /** Where agents stand when every desk is taken, or when a room has none. */
  standing: Point[];
  fixtures: Fixture[];
  /** Where the JARVIS core stands. Only the Command Center has one. */
  core?: Point;
}

const THEMES: Record<DepartmentId, RoomTheme> = {
  "command-center": { accent: "#3ee0f2", floor: "#0e1b2a", floorAlt: "#102032", wall: "#1a3346" },
  "development-lab": { accent: "#48e3ad", floor: "#0e1f1a", floorAlt: "#10251f", wall: "#1a3a30" },
  "marketing-hub": { accent: "#e879f9", floor: "#1b1024", floorAlt: "#21142c", wall: "#3a1f4a" },
  "research-lab": { accent: "#818cf8", floor: "#121530", floorAlt: "#161a38", wall: "#232a5c" },
  "conference-room": { accent: "#f5b74a", floor: "#1e1a10", floorAlt: "#242012", wall: "#3d3418" },
  "break-zone": { accent: "#8fa3b5", floor: "#141a22", floorAlt: "#181f28", wall: "#2a3441" },
};

/** Three desks along the back wall; a 4th agent and beyond stand. */
export const DESK_ROW_Y = 22;
const DESK_ROW: Point[] = [
  { x: 3, y: DESK_ROW_Y },
  { x: 22, y: DESK_ROW_Y },
  { x: 41, y: DESK_ROW_Y },
];
const STANDING: Point[] = [
  { x: 8, y: 40 },
  { x: 48, y: 40 },
  { x: 26, y: 40 },
];

function room(
  id: DepartmentId,
  column: 0 | 1 | 2,
  row: RoomRow,
  parts: Pick<Room, "desks" | "standing" | "fixtures"> & { core?: Point }
): Room {
  const label = OFFICE_DEPARTMENTS.find((department) => department.id === id)?.label ?? id;
  return {
    id,
    label,
    row,
    x: COLUMN_X[column],
    y: row === "top" ? TOP_Y : BOTTOM_Y,
    w: ROOM_W,
    h: ROOM_H,
    theme: THEMES[id],
    ...parts,
  };
}

/**
 * The building. Room order is the department order. Furniture keeps clear of
 * the door strip (x >= DOOR_X) on the side a figure walks through it.
 */
export const ROOMS: readonly Room[] = [
  room("command-center", 0, "top", {
    desks: DESK_ROW,
    standing: [
      { x: 6, y: 40 },
      { x: 52, y: 40 },
    ],
    core: { x: 32, y: 44 },
    fixtures: [
      { sprite: SERVER_RACK, x: 58, y: 12 },
      { sprite: PLANT, x: 4, y: 51 },
      { sprite: PLANT, x: 58, y: 51 },
    ],
  }),
  room("development-lab", 1, "top", {
    desks: DESK_ROW,
    standing: STANDING,
    fixtures: [
      { sprite: SERVER_RACK, x: 58, y: 12 },
      { sprite: WHITEBOARD, x: 4, y: 47 },
      { sprite: SERVER_RACK, x: 58, y: 44 },
      { sprite: PLANT, x: 24, y: 51 },
    ],
  }),
  room("marketing-hub", 2, "top", {
    desks: DESK_ROW,
    standing: STANDING,
    fixtures: [
      { sprite: CHART_SCREEN, x: 53, y: 11 },
      { sprite: RUG, x: 4, y: 48 },
      { sprite: PLANT, x: 58, y: 51 },
      { sprite: PLANT, x: 24, y: 51 },
    ],
  }),
  room("research-lab", 0, "bottom", {
    desks: DESK_ROW,
    standing: STANDING,
    fixtures: [
      { sprite: BOOKSHELF, x: 54, y: 11 },
      { sprite: BOOKSHELF, x: 4, y: 46 },
      { sprite: PLANT, x: 74, y: 51 },
    ],
  }),
  room("conference-room", 1, "bottom", {
    desks: DESK_ROW,
    standing: STANDING,
    fixtures: [
      { sprite: WHITEBOARD, x: 54, y: 11 },
      { sprite: CONFERENCE_TABLE, x: 28, y: 46, front: true },
      { sprite: CHAIR, x: 20, y: 50 },
      { sprite: CHAIR, x: 54, y: 50 },
      { sprite: PLANT, x: 74, y: 51 },
    ],
  }),
  room("break-zone", 2, "bottom", {
    desks: [],
    standing: [
      { x: 8, y: 40 },
      { x: 48, y: 40 },
    ],
    fixtures: [
      { sprite: COFFEE_MACHINE, x: 4, y: 12 },
      { sprite: WATER_COOLER, x: 26, y: 12 },
      { sprite: VENDING, x: 46, y: 12 },
      { sprite: LUNCH_TABLE, x: 24, y: 46, front: true },
      { sprite: SOFA, x: 54, y: 52, front: true },
      { sprite: PLANT, x: 4, y: 51 },
    ],
  }),
];

export function roomFor(id: DepartmentId): Room {
  return ROOMS.find((candidate) => candidate.id === id) ?? ROOMS[0]!;
}

/** The room whose bounds contain a point (a figure's top-left), if any. */
export function roomAt(point: Point): Room | null {
  return (
    ROOMS.find(
      (candidate) =>
        point.x >= candidate.x &&
        point.x < candidate.x + candidate.w &&
        point.y >= candidate.y - 2 &&
        point.y < candidate.y + candidate.h
    ) ?? null
  );
}

/**
 * What a close-up of a room shows, in scene coordinates: the room with a little
 * air around it AND the full height of the hallway its door opens onto, kept
 * inside the scene.
 *
 * The hallway is part of the view on purpose. A box drawn tightly round the
 * room ended halfway down the hallway, so anyone walking past — or through the
 * room's own door — was cut in half at the edge of the picture.
 */
export function roomViewport(id: DepartmentId, padding = 6): Rect {
  const target = roomFor(id);
  const top = target.row === "top" ? target.y - padding : HALLWAY.y - 1;
  const bottom = target.row === "top" ? HALLWAY.y + HALLWAY.h + 1 : target.y + target.h + padding;
  const w = Math.min(SCENE.w, target.w + padding * 2);
  const h = Math.min(SCENE.h, bottom - top);
  return {
    x: Math.min(SCENE.x + SCENE.w - w, Math.max(SCENE.x, target.x - padding)),
    y: Math.min(SCENE.y + SCENE.h - h, Math.max(SCENE.y, top)),
    w,
    h,
  };
}

// ---------------------------------------------------------------------------
// Ambient places — decorative destinations, never a claim
// ---------------------------------------------------------------------------

export type AmbientPlaceId =
  | "coffee"
  | "water"
  | "lunch-a"
  | "lunch-b"
  | "sofa"
  | "chat-a"
  | "chat-b"
  | "washroom"
  | "stroll-west"
  | "stroll-mid"
  | "stroll-east";

export interface AmbientPlace {
  id: AmbientPlaceId;
  /** A figure's top-left at the place's first spot. Same as `spots[0]`. */
  at: Point;
  /**
   * VO-3.1.1 — every distinct standing spot at the place, each a figure's
   * top-left. Two figures are never given the same spot at once
   * (`allocateSpots` in `ambient.ts`), and no two spots anywhere overlap, so
   * agents on a break never stand on each other.
   */
  spots: readonly Point[];
  /** Spoken in the panel and on the hotspot. */
  label: string;
  /** The room it is in, or null for the hallway. */
  room: DepartmentId | null;
}

function inRoom(id: DepartmentId, x: number, y: number): Point {
  const r = roomFor(id);
  return { x: r.x + x, y: r.y + y };
}

function place(id: AmbientPlaceId, label: string, room: DepartmentId | null, spots: readonly Point[]): AmbientPlace {
  return { id, at: spots[0]!, spots, label, room };
}

/**
 * The break places and their spots. In the Break Zone (room-relative): the
 * coffee machine and the water cooler each have a spot at the counter and one
 * in line behind it; the lunch table a seat on each side; the sofa a seat and
 * a spot beside it. Each hallway stroll point has two spots, clear of every
 * door. `ambient-occupancy` tests pin that no two spots overlap.
 */
export const AMBIENT_PLACES: Readonly<Record<AmbientPlaceId, AmbientPlace>> = {
  coffee: place("coffee", "Coffee machine", "break-zone", [inRoom("break-zone", 12, 14), inRoom("break-zone", 12, 28)]),
  water: place("water", "Water cooler", "break-zone", [inRoom("break-zone", 33, 14), inRoom("break-zone", 34, 28)]),
  "lunch-a": place("lunch-a", "Lunch table", "break-zone", [inRoom("break-zone", 13, 42)]),
  "lunch-b": place("lunch-b", "Lunch table", "break-zone", [inRoom("break-zone", 44, 42)]),
  sofa: place("sofa", "Sofa", "break-zone", [inRoom("break-zone", 56, 42), inRoom("break-zone", 70, 44)]),
  "chat-a": place("chat-a", "Meeting table", "conference-room", [inRoom("conference-room", 16, 40)]),
  "chat-b": place("chat-b", "Meeting table", "conference-room", [inRoom("conference-room", 56, 40)]),
  washroom: place("washroom", "Washroom", null, [WC_SPOT]),
  "stroll-west": place("stroll-west", "Hallway", null, [{ x: 40, y: HALL_Y }, { x: 54, y: HALL_Y }]),
  "stroll-mid": place("stroll-mid", "Hallway", null, [{ x: 128, y: HALL_Y }, { x: 142, y: HALL_Y }]),
  "stroll-east": place("stroll-east", "Hallway", null, [{ x: 214, y: HALL_Y }, { x: 228, y: HALL_Y }]),
};

/** The clickable areas for the break facilities and the meeting table. */
export interface LocationHotspot {
  id: "coffee-area" | "lunch-area" | "lounge" | "meeting-area" | "washroom";
  label: string;
  rect: Rect;
  room: DepartmentId;
  places: AmbientPlaceId[];
}

export const LOCATION_HOTSPOTS: readonly LocationHotspot[] = [
  // VO-3.1.1 — tall and wide enough for every spot of the places they name.
  { id: "coffee-area", label: "Coffee and water", rect: { ...inRoom("break-zone", 2, 11), w: 44, h: 31 }, room: "break-zone", places: ["coffee", "water"] },
  { id: "lunch-area", label: "Lunch table", rect: { ...inRoom("break-zone", 12, 42), w: 44, h: 16 }, room: "break-zone", places: ["lunch-a", "lunch-b"] },
  { id: "lounge", label: "Lounge sofa", rect: { ...inRoom("break-zone", 56, 40), w: 26, h: 20 }, room: "break-zone", places: ["sofa"] },
  { id: "meeting-area", label: "Meeting table", rect: { ...inRoom("conference-room", 14, 38), w: 54, h: 22 }, room: "conference-room", places: ["chat-a", "chat-b"] },
  { id: "washroom", label: "Washroom", rect: { x: WC_DOOR_AT.x - 2, y: WC_DOOR_AT.y - 1, w: 14, h: 16 }, room: "break-zone", places: ["washroom"] },
];

// ---------------------------------------------------------------------------
// Placing actors at their workstations
// ---------------------------------------------------------------------------

export interface PlacedAgent {
  actor: OfficeAgentActor;
  /** Scene coordinates of the figure's top-left (10×14) at its workstation. */
  x: number;
  y: number;
  /** The desk this agent sits at, in scene coordinates, or null when standing. */
  desk: Point | null;
}

/**
 * Where everyone works.
 *
 * Deterministic: agents are already sorted by id in the model, so the same
 * registry always produces the same seating. Desks first, then the standing
 * spots, then — for a room busier than its plan — a line along the walkway at
 * a fixed stride. Nobody is dropped: a registered agent is always drawn.
 */
export function placeAgents(model: OfficeModel): PlacedAgent[] {
  const placed: PlacedAgent[] = [];

  for (const department of model.departments) {
    const home = roomFor(department.id);
    department.actors.forEach((actor, index) => {
      if (index < home.desks.length) {
        const desk = home.desks[index]!;
        placed.push({
          actor,
          x: home.x + desk.x + DESK_SEAT_X,
          y: home.y + desk.y + DESK_SEAT_Y,
          desk: { x: home.x + desk.x, y: home.y + desk.y },
        });
        return;
      }

      const standingIndex = index - home.desks.length;
      if (standingIndex < home.standing.length) {
        const spot = home.standing[standingIndex]!;
        placed.push({ actor, x: home.x + spot.x, y: home.y + spot.y, desk: null });
        return;
      }

      const overflow = standingIndex - home.standing.length;
      placed.push({
        actor,
        x: home.x + 4 + ((overflow * 12) % (DOOR_X - 14)),
        y: home.y + WALK_Y,
        desk: null,
      });
    });
  }

  return placed;
}

// ---------------------------------------------------------------------------
// State → look. The only two functions in the engine that read a state.
// ---------------------------------------------------------------------------

export type AgentAnimation = "idle" | "still" | "typing";
export type AgentGlyph =
  | "none"
  | "check"
  | "wait"
  | "alert"
  | "queued"
  | "assigned"
  | "research"
  | "tool"
  | "work";
export type ScreenTone = "dim" | "ok" | "warn" | "danger" | "cyan";

export interface AgentVisual {
  /**
   * `idle` breathes slowly (decorative, as the legend says); `still` holds a
   * frame; `typing` is ONLY for a RUNNING task assigned to the agent.
   */
  animation: AgentAnimation;
  glyph: AgentGlyph;
  screen: ScreenTone;
  /** The monitor shows scrolling output: a running task, nothing else. */
  screenBusy: boolean;
  /**
   * True for a completion: the figure plays a one-shot pop, keyed by the
   * completion time so a NEW completion replays it and a re-render does not.
   */
  completion: boolean;
}

const LIFECYCLE_VISUALS: Record<OfficeAgentLifecycle, AgentVisual> = {
  idle: { animation: "idle", glyph: "none", screen: "dim", screenBusy: false, completion: false },
  queued: { animation: "still", glyph: "queued", screen: "cyan", screenBusy: false, completion: false },
  assigned: { animation: "still", glyph: "assigned", screen: "cyan", screenBusy: false, completion: false },
  working: { animation: "typing", glyph: "work", screen: "ok", screenBusy: true, completion: false },
  researching: { animation: "typing", glyph: "research", screen: "ok", screenBusy: true, completion: false },
  using_tool: { animation: "typing", glyph: "tool", screen: "ok", screenBusy: true, completion: false },
  waiting_for_approval: { animation: "still", glyph: "wait", screen: "warn", screenBusy: false, completion: false },
  completed: { animation: "still", glyph: "check", screen: "ok", screenBusy: false, completion: true },
  failed: { animation: "still", glyph: "alert", screen: "danger", screenBusy: false, completion: false },
};

export function agentVisual(actor: Pick<OfficeAgentActor, "lifecycle">): AgentVisual {
  return LIFECYCLE_VISUALS[actor.lifecycle] ?? LIFECYCLE_VISUALS.idle;
}

export type CoreAnimation = "idle" | "queued" | "working";

export interface SystemVisual {
  animation: CoreAnimation;
  /** How many queue markers to draw: the pending count, capped so it stays a glyph. */
  queueMarkers: number;
}

export const MAX_QUEUE_MARKERS = 5;

export function systemVisual(system: OfficeSystemActor): SystemVisual {
  return {
    animation: system.state,
    queueMarkers: Math.min(MAX_QUEUE_MARKERS, Math.max(0, system.pending)),
  };
}

export interface RoomActivity {
  /** Agents in the room with a real state other than idle. */
  active: number;
  /** True when anything in the room is not idle — JARVIS included for its room. */
  live: boolean;
}

export function roomActivity(
  department: OfficeModel["departments"][number],
  system: OfficeSystemActor
): RoomActivity {
  const active = department.actors.filter((actor) => actor.lifecycle !== "idle").length;
  const systemLive = department.id === "command-center" && system.state !== "idle";
  return { active, live: active > 0 || systemLive };
}
