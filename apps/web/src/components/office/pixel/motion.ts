// ---------------------------------------------------------------------------
// VO-3.1 — walking: routes through the building, and where a figure is at a
// given instant.
//
// PURE: no React, no DOM, no clock. A route is a list of points (a figure's
// top-left); a plan is that route timed at a fixed walking speed from a start
// instant; a position is read off a plan for any time. The same inputs always
// give the same answer, which is what lets the tests drive "now" directly.
//
// ROUTING. Inside a room a figure walks to the room's walkway line (below the
// desk row), along it, and to its destination. Between rooms it goes along the
// walkway to the room's door, through the door to the hallway line, along the
// hallway to the other door, and in. The hallway's own places (the washroom
// door, the stroll points) are on the hallway line.
// ---------------------------------------------------------------------------

import { DOOR_WALK_X, HALL_Y, WALK_Y, roomAt, type Point } from "./floor-plan";

/** Pixels per second: a room crossed in about six seconds, never a dash. */
export const WALK_SPEED = 14;

export type Facing = "down" | "up" | "left" | "right";

export interface Segment {
  from: Point;
  to: Point;
  start: number;
  end: number;
  facing: Facing;
}

function same(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

function facingOf(from: Point, to: Point): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "down" : "up";
}

/** The waypoints from one place to another, through doors and the hallway. */
export function routeBetween(from: Point, to: Point): Point[] {
  const a = roomAt(from);
  const b = roomAt(to);
  const points: Point[] = [from];
  const push = (point: Point) => {
    if (!same(points[points.length - 1]!, point)) points.push(point);
  };

  if (a && b && a.id === b.id) {
    const walkway = a.y + WALK_Y;
    push({ x: from.x, y: walkway });
    push({ x: to.x, y: walkway });
    push(to);
    return points;
  }

  if (a) {
    const walkway = a.y + WALK_Y;
    const door = a.x + DOOR_WALK_X;
    push({ x: from.x, y: walkway });
    push({ x: door, y: walkway });
    push({ x: door, y: HALL_Y });
  } else {
    push({ x: from.x, y: HALL_Y });
  }

  if (b) {
    const walkway = b.y + WALK_Y;
    const door = b.x + DOOR_WALK_X;
    push({ x: door, y: HALL_Y });
    push({ x: door, y: walkway });
    push({ x: to.x, y: walkway });
  } else {
    push({ x: to.x, y: HALL_Y });
  }
  push(to);
  return points;
}

export function routeLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.abs(points[i]!.x - points[i - 1]!.x) + Math.abs(points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

/** Milliseconds to walk a route. */
export function routeDuration(points: readonly Point[], speed = WALK_SPEED): number {
  return Math.round((routeLength(points) / speed) * 1000);
}

/** A route timed from `startAt`. Each leg is axis-aligned, so length is |dx| + |dy|. */
export function planRoute(points: readonly Point[], startAt: number, speed = WALK_SPEED): Segment[] {
  const segments: Segment[] = [];
  let at = startAt;
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1]!;
    const to = points[i]!;
    const ms = ((Math.abs(to.x - from.x) + Math.abs(to.y - from.y)) / speed) * 1000;
    if (ms <= 0) continue;
    segments.push({ from, to, start: at, end: at + ms, facing: facingOf(from, to) });
    at += ms;
  }
  return segments;
}

export interface RoutePosition {
  point: Point;
  facing: Facing;
  /** True while a leg is being walked. */
  moving: boolean;
  /** True once the last leg has been walked. */
  arrived: boolean;
  /** When the current leg ends (or the route did), for scheduling the next look. */
  nextChangeAt: number | null;
}

/** Where a figure on `segments` is at time `t`. Before the start it is at the first point. */
export function positionOnRoute(segments: readonly Segment[], t: number, fallback: Point): RoutePosition {
  if (segments.length === 0) {
    return { point: fallback, facing: "down", moving: false, arrived: true, nextChangeAt: null };
  }
  const first = segments[0]!;
  if (t <= first.start) {
    return { point: first.from, facing: first.facing, moving: false, arrived: false, nextChangeAt: first.start };
  }
  for (const segment of segments) {
    if (t < segment.end) {
      const f = (t - segment.start) / (segment.end - segment.start);
      return {
        point: {
          x: segment.from.x + (segment.to.x - segment.from.x) * f,
          y: segment.from.y + (segment.to.y - segment.from.y) * f,
        },
        facing: segment.facing,
        moving: true,
        arrived: false,
        nextChangeAt: segment.end,
      };
    }
  }
  const last = segments[segments.length - 1]!;
  return { point: last.to, facing: last.facing, moving: false, arrived: true, nextChangeAt: null };
}
