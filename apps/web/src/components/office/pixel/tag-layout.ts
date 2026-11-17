// ---------------------------------------------------------------------------
// VO-3.1 — where each figure's name tag goes.
//
// A tag used to hang at one fixed offset under its figure, whatever was there.
// Desks are 19 units apart and a tag can be 27 wide, so neighbours' names ran
// into each other; the first desk's tag crossed the room's wall; a figure in
// the hallway dropped its tag onto the sign of the room below; a figure near
// the edge of a zoomed view had its tag cut off.
//
// This places every tag in one pass. For each figure it tries a few positions
// (under, a second row under, beside, above), slides the candidate sideways to
// stay inside the figure's own space, and keeps the cheapest:
//
//   * a tag never leaves the space its figure is in — the room's floor, the
//     hallway, or both while the figure is in a doorway;
//   * a tag never covers another tag, another figure, a room's sign or JARVIS;
//   * a tag avoids furniture where it can. Where it cannot, it is drawn on a
//     plate, so it stays readable;
//   * when the figure itself is fully in view, so is its tag.
//
// Seated and stationary figures are placed first and never look at walkers, so
// a tag at a desk does not hop when someone walks past. A walker's tag yields.
//
// PURE: no React, no DOM, no clock. Widths come from the character count and a
// fixed advance; the renderer draws the text at exactly that width
// (`textLength`), so the layout is true whatever font the browser picked.
// ---------------------------------------------------------------------------

import { HALLWAY, ROOMS, SCENE, SIGN_W, WALL_H, roomAt, type Point, type Rect } from "./floor-plan";
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
  spriteSize,
} from "./sprites";

export const TAG_FONT_SIZE = 3.2;
/** A monospace advance: the text is stretched or squeezed to exactly this. */
export const TAG_CHAR_W = TAG_FONT_SIZE * 0.6;
/** The plate behind a tag: its height, and its padding left and right. */
export const TAG_PLATE_H = 4;
export const TAG_PAD_X = 0.8;
/** From the plate's top to the text's baseline. */
export const TAG_BASELINE = 3.1;

export type TagSide = "below" | "below-2" | "right" | "left" | "above";

export interface TagFigure {
  id: string;
  /** The figure's top-left, in scene units. */
  point: Point;
  text: string;
  /** Sitting at a desk: the tag goes under the desk, not under the feet. */
  seated: boolean;
  /** Walking: its tag yields to everything else. */
  moving: boolean;
}

export interface TagPlacement {
  /** The text's centre x and baseline y, relative to the figure's top-left. */
  x: number;
  y: number;
  /** The text's drawn width. */
  width: number;
  /** The plate, relative to the figure's top-left. */
  plate: Rect;
  side: TagSide;
  /** False when even the best position touches something it should not. */
  clear: boolean;
  /** False only when the plate cannot fit inside the view at all (a view narrower than the tag). */
  inView: boolean;
}

/**
 * VO-3.1.1 — everything a figure draws around itself, relative to its
 * top-left: the selection ring, the state glyph over its head and a chat's
 * speech bubble. A figure is drawn only when all of this is on screen.
 */
export const FIGURE_EXTENT: Rect = (() => {
  // Positions as the renderer draws them (pixel-office-renderer.tsx).
  const ring = { x: -2.4, y: -3.4, r: CHARACTER_SIZE.width + 2.4, b: CHARACTER_SIZE.height + 2.4 };
  const glyphs = [GLYPH_ALERT, GLYPH_ASSIGNED, GLYPH_CHECK, GLYPH_QUEUED, GLYPH_RESEARCH, GLYPH_TOOL, GLYPH_WAIT, GLYPH_WORK].map(spriteSize);
  const glyph = {
    x: CHARACTER_SIZE.width - 2,
    y: -4,
    r: CHARACTER_SIZE.width - 2 + Math.max(...glyphs.map((size) => size.width)),
    b: -4 + Math.max(...glyphs.map((size) => size.height)),
  };
  const bubbleSize = spriteSize(SPEECH_BUBBLE);
  const bubble = { x: 1, y: -9, r: 1 + bubbleSize.width, b: -9 + bubbleSize.height };
  const x = Math.min(ring.x, glyph.x, bubble.x);
  const y = Math.min(ring.y, glyph.y, bubble.y);
  return { x, y, w: Math.max(ring.r, glyph.r, bubble.r) - x, h: Math.max(ring.b, glyph.b, bubble.b) - y };
})();

/** Whether a figure at `point`, with everything it draws, fits inside `view`. */
export function figureFitsView(point: Point, view: Rect): boolean {
  const box = { x: point.x + FIGURE_EXTENT.x, y: point.y + FIGURE_EXTENT.y, w: FIGURE_EXTENT.w, h: FIGURE_EXTENT.h };
  return box.x >= view.x - 1e-6 && box.y >= view.y - 1e-6 && box.x + box.w <= view.x + view.w + 1e-6 && box.y + box.h <= view.y + view.h + 1e-6;
}

export function tagTextWidth(text: string): number {
  return Math.max(1, [...text].length) * TAG_CHAR_W;
}

/** Areas smaller than this are rounding, not contact: scene units are whole pixels. */
const TOUCH = 1e-6;

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > TOUCH && h > TOUCH ? w * h : 0;
}

function outside(box: Rect, zone: Rect): number {
  const area = box.w * box.h - overlap(box, zone);
  return area > TOUCH ? area : 0;
}

/** What a tag must never cover, whoever it belongs to: every sign, and JARVIS with its own tag. */
const FIXED_HARD: readonly Rect[] = (() => {
  const signs = ROOMS.map((room) => ({ x: room.x + 1.5, y: room.y + 0.5, w: SIGN_W + 1, h: WALL_H - 2 }));
  const commandCenter = ROOMS[0]!;
  const core = commandCenter.core
    ? [{ x: commandCenter.x + commandCenter.core.x - 3, y: commandCenter.y + commandCenter.core.y - 5, w: 16, h: 21 }]
    : [];
  return [...signs, ...core];
})();

/** What a tag avoids when it can: furniture and desks. */
const FIXED_SOFT: readonly Rect[] = ROOMS.flatMap((room) => [
  ...room.fixtures.map((fixture) => {
    const size = spriteSize(fixture.sprite);
    return { x: room.x + fixture.x, y: room.y + fixture.y, w: size.width, h: size.height };
  }),
  ...room.desks.map((desk) => ({ x: room.x + desk.x, y: room.y + desk.y, w: 16, h: 8 })),
]);

function figureBox(point: Point): Rect {
  return { x: point.x - 0.5, y: point.y - 0.5, w: CHARACTER_SIZE.width + 1, h: CHARACTER_SIZE.height + 1 };
}

const HALL_ZONE: Rect = { x: SCENE.x + 1, y: HALLWAY.y + 0.5, w: SCENE.w - 2, h: HALLWAY.h - 1 };

function floorOf(room: (typeof ROOMS)[number]): Rect {
  return { x: room.x + 1.5, y: room.y + WALL_H + 0.5, w: room.w - 3, h: room.h - WALL_H - 2 };
}

/**
 * The space a figure is in, which its tag stays inside: its room's floor, the
 * hallway, or — while any part of the figure is in a doorway — the room's
 * floor and the hallway together.
 *
 * Decided from the figure's whole height, not its top-left corner: a figure
 * walking down into a bottom-row room has its feet through the door while its
 * head is still in the hallway.
 */
export function tagZone(point: Point): Rect {
  const head = point.y;
  const feet = point.y + CHARACTER_SIZE.height;
  const column = ROOMS.filter((room) => point.x + CHARACTER_SIZE.width > room.x && point.x < room.x + room.w);

  for (const room of column) {
    const floor = floorOf(room);
    if (room.row === "top") {
      const wall = room.y + room.h - 1;
      // Across the bottom wall: feet below it, head still above it.
      if (feet > wall && head < room.y + room.h) {
        return { x: floor.x, y: floor.y, w: floor.w, h: HALL_ZONE.y + HALL_ZONE.h - floor.y };
      }
    } else if (feet > room.y && head < floor.y) {
      // Across the top wall band: feet into the room, head still in the band or the hallway.
      return { x: floor.x, y: HALL_ZONE.y, w: floor.w, h: floor.y + floor.h - HALL_ZONE.y };
    }
  }

  const room = roomAt(point);
  return room ? floorOf(room) : HALL_ZONE;
}

function slideInto(box: Rect, zone: Rect): Rect {
  if (box.w >= zone.w) return { ...box, x: zone.x + (zone.w - box.w) / 2 };
  return { ...box, x: Math.min(zone.x + zone.w - box.w, Math.max(zone.x, box.x)) };
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

/** Candidate plates, in order of preference, in scene coordinates. */
function candidates(figure: TagFigure, plateW: number): Array<{ side: TagSide; box: Rect; slides: boolean }> {
  const { x, y } = figure.point;
  const centre = x + CHARACTER_SIZE.width / 2 - plateW / 2;
  // Under a desk when seated (the desk covers the legs), under the feet otherwise.
  const under = y + CHARACTER_SIZE.height + (figure.seated ? 1.1 : 0.5);
  const mid = y + CHARACTER_SIZE.height / 2 - TAG_PLATE_H / 2 + 1;
  return [
    { side: "below", box: { x: centre, y: under, w: plateW, h: TAG_PLATE_H }, slides: true },
    { side: "below-2", box: { x: centre, y: under + TAG_PLATE_H + 0.4, w: plateW, h: TAG_PLATE_H }, slides: true },
    { side: "right", box: { x: x + CHARACTER_SIZE.width + 1.5, y: mid, w: plateW, h: TAG_PLATE_H }, slides: false },
    { side: "left", box: { x: x - 1.5 - plateW, y: mid, w: plateW, h: TAG_PLATE_H }, slides: false },
    // Clear of the state glyph, which sits at the head's top right.
    { side: "above", box: { x: centre, y: y - TAG_PLATE_H - 4.6, w: plateW, h: TAG_PLATE_H }, slides: true },
  ];
}

export interface TagLayoutOptions {
  /** What is on screen. A figure fully inside it keeps its tag inside it too. */
  view?: Rect | null;
}

/**
 * Every figure's tag. Deterministic: the same figures in the same places always
 * get the same tags, in whatever order they are handed in.
 */
export function layoutTags(figures: readonly TagFigure[], options: TagLayoutOptions = {}): Map<string, TagPlacement> {
  const view = options.view ?? null;
  const result = new Map<string, TagPlacement>();
  const placedPlates: Rect[] = [];

  const rank = (figure: TagFigure) => (figure.moving ? 2 : figure.seated ? 0 : 1);
  const ordered = [...figures].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const still = ordered.filter((figure) => !figure.moving);

  for (const figure of ordered) {
    const width = tagTextWidth(figure.text);
    const plateW = width + TAG_PAD_X * 2;
    const own = figureBox(figure.point);
    const inView = view !== null && outside(own, view) === 0;
    const zone = inView ? intersect(tagZone(figure.point), { x: view!.x + 0.5, y: view!.y + 0.5, w: view!.w - 1, h: view!.h - 1 }) : tagZone(figure.point);
    // A seated tag does not move for a passer-by; a walker's avoids everyone.
    const others = (figure.moving ? ordered : still).filter((other) => other.id !== figure.id).map((other) => figureBox(other.point));

    // VO-3.1.1 — the edge of the view comes first. A figure that is on screen
    // keeps its WHOLE tag on screen: a position past the edge is chosen only
    // when no position inside it exists at all, and every candidate that may
    // slide is also tried slid into the view alone.
    const viewInner = inView ? { x: view!.x + 0.5, y: view!.y + 0.5, w: view!.w - 1, h: view!.h - 1 } : null;
    const boxes = candidates(figure, plateW).flatMap((candidate) => {
      const first = candidate.slides ? slideInto(candidate.box, zone) : candidate.box;
      return viewInner && candidate.slides
        ? [{ side: candidate.side, box: first }, { side: candidate.side, box: slideInto(candidate.box, viewInner) }]
        : [{ side: candidate.side, box: first }];
    });

    let best: { cost: number; hard: number; offView: number; side: TagSide; box: Rect } | null = null;
    boxes.forEach((candidate, index) => {
      const box = candidate.box;
      const offView = viewInner ? outside(box, viewInner) : 0;
      let hard = outside(box, zone);
      for (const rect of FIXED_HARD) hard += overlap(box, rect);
      for (const rect of others) hard += overlap(box, rect);
      for (const rect of placedPlates) hard += overlap(box, rect);
      // Sliding sideways may have pushed it onto its own figure.
      hard += overlap(box, own);
      let soft = 0;
      for (const rect of FIXED_SOFT) soft += overlap(box, rect);
      const cost = offView * 1e6 + hard * 1000 + soft + index * 0.01;
      if (!best || cost < best.cost) best = { cost, hard, offView, side: candidate.side, box };
    });

    const chosen = best!;
    placedPlates.push(chosen.box);
    const plate: Rect = { x: chosen.box.x - figure.point.x, y: chosen.box.y - figure.point.y, w: chosen.box.w, h: chosen.box.h };
    result.set(figure.id, {
      x: plate.x + plate.w / 2,
      y: plate.y + TAG_BASELINE,
      width,
      plate,
      side: chosen.side,
      clear: chosen.hard === 0 && chosen.offView === 0,
      inView: chosen.offView === 0,
    });
  }

  return result;
}
