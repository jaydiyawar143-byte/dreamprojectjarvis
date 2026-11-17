"use client";

// ---------------------------------------------------------------------------
// VO-3.1 — the scene's clock and every figure's motion.
//
// ONE clock per scene. It does not tick on a fixed beat: it wakes at the next
// instant anything is scheduled to change (a slot boundary, a leg of a walk
// ending) and, only while a figure is actually walking, every WALK_TICK_MS so
// the CSS transition can carry it smoothly to where it will be by the next
// look. Nothing moves when nothing is due. The timer is cleared on unmount and
// whenever it is re-armed, so there is never more than one.
//
// A test passes `clock` and gets no timer at all: positions are then a pure
// function of that instant.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";

import type { OfficeAgentActor } from "../office-model";
import { DESK_BOUND } from "../office-lifecycle";
import { advanceMotion, resolveMotion, type AgentMotionState, type MotionResult } from "./agent-motion";
import type { PlacedAgent } from "./floor-plan";

/** While someone walks, the scene looks again this often. */
export const WALK_TICK_MS = 500;
/** The longest the clock sleeps when nothing is scheduled sooner. */
export const MAX_SLEEP_MS = 15_000;
/** After a completion the agent stays at its desk this long before any break. */
export const COMPLETION_HOLD_MS = 45_000;

export interface FigureMotion {
  /** Where the figure is now. */
  now: MotionResult;
  /** Where it will be one tick from now: the CSS transition's target while walking. */
  next: MotionResult;
  /** The transition length to `next`, 0 when it is not walking. */
  transitionMs: number;
}

/** Whether real work holds an agent at its desk at `now`. */
export function isDeskBound(actor: OfficeAgentActor, now: number): boolean {
  if (DESK_BOUND.has(actor.lifecycle)) return true;
  if (actor.lifecycle === "completed") {
    const finished = actor.currentTask?.finishedAt ?? actor.lastActivityAt;
    const at = finished ? Date.parse(finished) : NaN;
    return Number.isFinite(at) && now - at < COMPLETION_HOLD_MS;
  }
  return false;
}

/**
 * The scene's time. `fixed` (tests) pins it; otherwise it is the instant of the
 * last tick, advanced by `useSceneTimer`.
 */
export function useSceneTime(fixed?: number): [number, (at: number) => void] {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  return [fixed ?? now, setNow];
}

/**
 * Arms the ONE timer: at the next scheduled change, or one walking tick away
 * while someone walks. Re-armed after every tick (the effect depends on `now`)
 * and cleared on unmount, so there is never more than one.
 */
export function useSceneTimer(
  tick: (at: number) => void,
  options: {
    /** A fixed instant (tests): no timer, ever. */
    fixed?: number;
    /** Whether anything in the scene can move at all. */
    enabled: boolean;
    walking: boolean;
    nextChangeAt: number | null;
    now: number;
  }
): void {
  const { fixed, enabled, walking, nextChangeAt, now } = options;
  useEffect(() => {
    if (fixed !== undefined || !enabled) return;
    const untilNext = nextChangeAt !== null ? nextChangeAt - Date.now() : MAX_SLEEP_MS;
    const delay = walking ? WALK_TICK_MS : Math.min(MAX_SLEEP_MS, Math.max(WALK_TICK_MS, untilNext));
    const timer = setTimeout(() => tick(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [tick, fixed, enabled, walking, nextChangeAt, now]);
}

/**
 * Every figure's motion at `now`. Keeps each agent's small motion state in a
 * ref and advances it idempotently, so a re-render cannot move anyone twice.
 */
export function useFigureMotion(
  placed: readonly PlacedAgent[],
  now: number,
  options: { ambientEnabled: boolean; smooth: boolean }
): Map<string, FigureMotion> {
  const states = useRef(new Map<string, AgentMotionState>());

  return useMemo(() => {
    const ids = placed.map((entry) => entry.actor.id);
    const result = new Map<string, FigureMotion>();
    const seen = new Set<string>();

    for (const entry of placed) {
      const ctx = {
        agentId: entry.actor.id,
        seat: { x: entry.x, y: entry.y },
        agentIds: ids,
        ambientEnabled: options.ambientEnabled,
      };
      const state = advanceMotion(states.current.get(entry.actor.id) ?? null, ctx, isDeskBound(entry.actor, now), now);
      states.current.set(entry.actor.id, state);
      seen.add(entry.actor.id);

      const current = resolveMotion(state, ctx, now);
      const moving = current.phase === "walking" || current.phase === "returning";
      const next = moving && options.smooth ? resolveMotion(state, ctx, now + WALK_TICK_MS) : current;
      result.set(entry.actor.id, {
        now: current,
        next,
        transitionMs: moving && options.smooth ? WALK_TICK_MS : 0,
      });
    }

    // An agent that left the registry takes its state with it.
    for (const id of [...states.current.keys()]) if (!seen.has(id)) states.current.delete(id);
    return result;
  }, [placed, now, options.ambientEnabled, options.smooth]);
}

/** The soonest change across all figures, and whether anyone is walking. */
export function sceneSchedule(motions: ReadonlyMap<string, FigureMotion>): { walking: boolean; nextChangeAt: number | null } {
  let walking = false;
  let next: number | null = null;
  for (const motion of motions.values()) {
    if (motion.now.phase === "walking" || motion.now.phase === "returning") walking = true;
    const at = motion.now.nextChangeAt;
    if (at !== null && (next === null || at < next)) next = at;
  }
  return { walking, nextChangeAt: next };
}
