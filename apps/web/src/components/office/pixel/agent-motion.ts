// ---------------------------------------------------------------------------
// VO-3.1 — where each figure is, given the real state and the time.
//
// PURE. The state kept per agent is three numbers and a point, advanced by
// `advanceMotion` and read by `resolveMotion`; both are deterministic, so the
// tests drive them with plain timestamps.
//
// THE RULE THAT MATTERS. A real state always wins over decoration:
//
//   * An agent whose lifecycle puts it at its desk (`deskBound`: queued,
//     assigned, executing, waiting, failed, or a fresh completion) stops its
//     ambient activity THE MOMENT the state is seen, and walks back from
//     wherever it actually is — coffee, the hallway, mid-conversation — by
//     the shortest route through the doors. While it walks it is
//     "returning to desk"; it sits when it arrives.
//   * Typing is decided by the renderer from the lifecycle AND this module's
//     `seated`: a RUNNING task shows as work only once the figure is at the
//     desk. Nothing here can make a figure look busy.
//   * When the real work ends, the figure finishes walking to its desk if it
//     was still on the way, then stays seated until the NEXT ambient slot
//     begins — no jump back into a break that "started" while it worked.
//   * The first time an agent is seen with real work (a page load), it is
//     simply at its desk: a page load is not a return.
// ---------------------------------------------------------------------------

import { ambientSlotAt, placePoint, type AmbientActivity } from "./ambient";
import { planRoute, positionOnRoute, routeBetween, routeDuration, type Facing } from "./motion";
import type { AmbientPlaceId, Point } from "./floor-plan";

export interface AgentMotionState {
  /** When the current real-work period began, or null when the agent is free. */
  deskBoundSince: number | null;
  /** Where the walk back to the desk started, and when. */
  returnFrom: Point | null;
  returnStart: number;
  /** Ambient activity resumes with the first slot that starts at or after this. */
  resumeAt: number;
}

export const INITIAL_MOTION: AgentMotionState = {
  deskBoundSince: null,
  returnFrom: null,
  returnStart: 0,
  resumeAt: 0,
};

export interface MotionContext {
  agentId: string;
  /** The agent's workstation: where it sits. */
  seat: Point;
  /** Every agent in the office, for conversation pairs. */
  agentIds: readonly string[];
  /** Under reduced motion nobody wanders: figures stay at their desks. */
  ambientEnabled: boolean;
}

export type MotionPhase =
  /** At the workstation. */
  | "seated"
  /** Walking out to, or back from, a decorative activity. */
  | "walking"
  /** At a decorative activity's place. */
  | "away"
  /** Walking back to the desk because real work arrived. */
  | "returning";

export interface MotionResult {
  point: Point;
  facing: Facing;
  phase: MotionPhase;
  /** The decorative activity, when there is one (null while working or seated for work). */
  ambient: AmbientActivity | null;
  /** Where the decorative activity happens, while walking to it or there. */
  place: AmbientPlaceId | null;
  /** The conversation partner, for a chat. */
  partner: string | null;
  /** Behind the washroom door. */
  hidden: boolean;
  /** When this result next changes, for the scene's clock. Null: not until a state changes. */
  nextChangeAt: number | null;
}

/** The smallest stay that makes a trip worth walking. Shorter slots are spent at the desk. */
export const MIN_STAY_MS = 8_000;
/** How long `stretch` lasts inside its slot. */
export const STRETCH_MS = 9_000;

function seated(ctx: MotionContext, nextChangeAt: number | null, ambient: AmbientActivity | null = null): MotionResult {
  return { point: ctx.seat, facing: "down", phase: "seated", ambient, place: null, partner: null, hidden: false, nextChangeAt };
}

/** The decorative position at `t`, ignoring real work. */
export function ambientPosition(ctx: MotionContext, t: number, notBefore: number): MotionResult {
  if (!ctx.ambientEnabled) return seated(ctx, null);

  const slot = ambientSlotAt(ctx.agentId, ctx.agentIds, t);
  if (slot.start < notBefore) return seated(ctx, slot.end);

  if (slot.activity === "desk") return seated(ctx, slot.end);

  if (slot.activity === "stretch") {
    const from = slot.start + 5_000;
    const to = from + STRETCH_MS;
    if (t >= from && t < to) {
      return { point: ctx.seat, facing: "down", phase: "seated", ambient: "stretch", place: null, partner: null, hidden: false, nextChangeAt: to };
    }
    return seated(ctx, t < from ? from : slot.end);
  }

  // VO-3.1.1 — the spot the allocation gave this agent, never a shared point.
  const place = slot.at ?? (slot.place ? placePoint(slot.place) : null);
  if (!place) return seated(ctx, slot.end);

  const outbound = routeBetween(ctx.seat, place);
  const walk = routeDuration(outbound);
  if (slot.end - slot.start < 2 * walk + MIN_STAY_MS) return seated(ctx, slot.end);

  const arrive = slot.start + walk;
  const leave = slot.end - walk;

  if (t < arrive) {
    const position = positionOnRoute(planRoute(outbound, slot.start), t, ctx.seat);
    return { point: position.point, facing: position.facing, phase: "walking", ambient: slot.activity, place: slot.place, partner: slot.partner, hidden: false, nextChangeAt: position.nextChangeAt ?? arrive };
  }
  if (t < leave) {
    return {
      point: place,
      facing: "down",
      phase: "away",
      ambient: slot.activity,
      place: slot.place,
      partner: slot.partner,
      hidden: slot.activity === "washroom",
      nextChangeAt: leave,
    };
  }
  const back = [...outbound].reverse();
  const position = positionOnRoute(planRoute(back, leave), t, place);
  return { point: position.point, facing: position.facing, phase: "walking", ambient: slot.activity, place: slot.place, partner: slot.partner, hidden: false, nextChangeAt: position.nextChangeAt ?? slot.end };
}

function returnRoute(state: AgentMotionState, ctx: MotionContext): { segments: ReturnType<typeof planRoute>; arrival: number } | null {
  if (!state.returnFrom) return null;
  const points = routeBetween(state.returnFrom, ctx.seat);
  const segments = planRoute(points, state.returnStart);
  return { segments, arrival: state.returnStart + routeDuration(points) };
}

/** Where the figure is at `t`, given its state. */
export function resolveMotion(state: AgentMotionState, ctx: MotionContext, t: number): MotionResult {
  const back = returnRoute(state, ctx);
  if (state.deskBoundSince !== null || (back && t < back.arrival)) {
    if (back && t < back.arrival) {
      const position = positionOnRoute(back.segments, t, ctx.seat);
      return {
        point: position.point,
        facing: position.facing,
        phase: "returning",
        ambient: null,
        place: null,
        partner: null,
        hidden: false,
        nextChangeAt: position.nextChangeAt ?? back.arrival,
      };
    }
    return seated(ctx, null);
  }
  if (t < state.resumeAt) return seated(ctx, state.resumeAt);
  return ambientPosition(ctx, t, state.resumeAt);
}

/**
 * Moves an agent's state on, given whether real work holds it at its desk now.
 *
 * Idempotent: called twice with the same inputs it returns the same state, so
 * a re-render (or React's double render) cannot move anyone twice.
 */
export function advanceMotion(
  state: AgentMotionState | null,
  ctx: MotionContext,
  deskBound: boolean,
  now: number
): AgentMotionState {
  if (state === null) {
    // First sight. Real work: simply at the desk. Free: the ambient schedule.
    return deskBound
      ? { deskBoundSince: now, returnFrom: null, returnStart: now, resumeAt: 0 }
      : { ...INITIAL_MOTION };
  }

  if (deskBound && state.deskBoundSince === null) {
    // INTERRUPTION. Walk back from wherever the figure is at this instant.
    const where = resolveMotion(state, ctx, now);
    const atDesk = where.phase === "seated";
    return {
      deskBoundSince: now,
      returnFrom: atDesk ? null : where.point,
      returnStart: now,
      resumeAt: state.resumeAt,
    };
  }

  if (!deskBound && state.deskBoundSince !== null) {
    // The work is over. Finish any walk back, then wait for the next slot.
    const back = returnRoute(state, ctx);
    const settled = Math.max(now, back ? back.arrival : now);
    const slot = ambientSlotAt(ctx.agentId, ctx.agentIds, settled);
    return {
      deskBoundSince: null,
      returnFrom: state.returnFrom,
      returnStart: state.returnStart,
      resumeAt: slot.end,
    };
  }

  return state;
}
