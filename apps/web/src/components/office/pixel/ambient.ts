// ---------------------------------------------------------------------------
// VO-3.1 — the Ambient Activity Engine.
//
// What an idle agent does to look alive: coffee, water, a stroll, lunch, the
// sofa, a stretch, the washroom, a conversation with another idle agent.
//
// IT IS DECORATION, AND SAYS SO. Nothing here reads a task, an audit row or an
// approval, and nothing here writes anything: there is no fake task, no fake
// event, no record of any kind. The panel labels every ambient activity as
// decorative. An agent with real work (see `DESK_BOUND`) never gets one — the
// renderer asks this engine only about agents whose lifecycle is idle.
//
// IT IS A PURE FUNCTION OF TIME. Each agent has a fixed cycle of slots whose
// lengths come from a hash of its id (so intervals vary, and differ between
// agents); what each slot holds is drawn from the agent's own weighted
// preferences, re-drawn every cycle (so the pattern does not simply repeat).
// Conversations are global pair events: in each window a hash picks a pair
// and a time. There is no timer and no random number: the same agent at the
// same instant always does the same thing, which is what makes it testable.
// ---------------------------------------------------------------------------

import { AMBIENT_PLACES, type AmbientPlaceId, type Point } from "./floor-plan";
import { hashId } from "./sprites";

export type AmbientActivity =
  | "desk"
  | "coffee"
  | "water"
  | "lunch"
  | "sofa"
  | "chat"
  | "stretch"
  | "washroom"
  | "stroll";

/** How each activity reads in the panel. Always presented as decorative. */
export const AMBIENT_LABEL: Readonly<Record<AmbientActivity, string>> = {
  desk: "At the workstation",
  coffee: "Getting coffee",
  water: "Taking a water break",
  lunch: "At the lunch table",
  sofa: "Taking a short break",
  chat: "Chatting",
  stretch: "Stretching",
  washroom: "In the washroom",
  stroll: "Walking around the office",
};

/**
 * Why a break the agent wanted is spent at its desk instead (VO-3.1.1):
 *   conversation  it would overlap one of the agent's conversations;
 *   boundary      it would cross an occupancy epoch (see `OCCUPANCY_EPOCH_MS`);
 *   full          every spot it could use was taken when it would have started.
 */
export type AmbientYield = "conversation" | "boundary" | "full";

export interface AmbientSlot {
  activity: AmbientActivity;
  start: number;
  end: number;
  /** Where it happens; null means at the agent's own workstation. */
  place: AmbientPlaceId | null;
  /** For a conversation, the other agent. */
  partner: string | null;
  /**
   * VO-3.1.1 — the exact spot the figure stands at (its top-left), allocated so
   * no two agents share it at once. Null at the workstation, and on
   * `personalSlotAt`, which states only what the agent would like to do.
   */
  at: Point | null;
  /** Set when the break became time at the desk, and why. */
  yielded: AmbientYield | null;
}

/** Slots per cycle, and their length bounds. */
export const SLOTS_PER_CYCLE = 6;
export const MIN_SLOT_MS = 50_000;
export const MAX_SLOT_MS = 140_000;

/** Conversation windows: one possible pair per window. */
export const CHAT_WINDOW_MS = 4 * 60_000;
export const CHAT_OFFSET_MS = 40_000;
export const CHAT_LENGTH_MS = 110_000;

function mix(...parts: Array<string | number>): number {
  return hashId(parts.join("\u0000"));
}

/** The agent's slot lengths: fixed per agent, different between agents. */
export function slotLengths(agentId: string): number[] {
  return Array.from({ length: SLOTS_PER_CYCLE }, (_, i) => {
    const h = mix("len", agentId, i);
    return MIN_SLOT_MS + (h % (MAX_SLOT_MS - MIN_SLOT_MS + 1));
  });
}

const BASE_WEIGHTS: Readonly<Record<Exclude<AmbientActivity, "chat">, number>> = {
  desk: 46,
  coffee: 12,
  water: 8,
  stroll: 9,
  stretch: 8,
  sofa: 5,
  washroom: 4,
  lunch: 3,
};

const FAVOURITES: ReadonlyArray<Exclude<AmbientActivity, "chat" | "desk">> = ["coffee", "water", "stroll", "sofa", "stretch"];

/** Each agent has a favourite break, from its id: its weight is tripled. */
export function favouriteOf(agentId: string): Exclude<AmbientActivity, "chat" | "desk"> {
  return FAVOURITES[mix("fav", agentId) % FAVOURITES.length]!;
}

function weightsFor(agentId: string, at: number): Array<[Exclude<AmbientActivity, "chat">, number]> {
  const favourite = favouriteOf(agentId);
  const hour = new Date(at).getHours();
  const lunchtime = hour >= 12 && hour < 14;
  return (Object.entries(BASE_WEIGHTS) as Array<[Exclude<AmbientActivity, "chat">, number]>).map(([activity, weight]) => {
    if (activity === favourite) return [activity, weight * 3];
    if (activity === "lunch" && lunchtime) return [activity, weight * 6];
    return [activity, weight];
  });
}

function pick(agentId: string, cycle: number, index: number, at: number): Exclude<AmbientActivity, "chat"> {
  const weights = weightsFor(agentId, at);
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let roll = mix("pick", agentId, cycle, index) % total;
  for (const [activity, weight] of weights) {
    if (roll < weight) return activity;
    roll -= weight;
  }
  return "desk";
}

/**
 * Every place an activity may use, in order of preference. The first is the
 * place the agent wants; the rest are where it goes when every spot there is
 * taken. Only places that are the same kind of break are alternatives: the two
 * sides of the lunch table, and the three stroll points. Coffee, water, the
 * sofa and the washroom have none — when they are full, the break is spent at
 * the desk.
 */
function candidatesFor(activity: AmbientActivity, agentId: string, cycle: number, index: number): AmbientPlaceId[] {
  switch (activity) {
    case "coffee":
      return ["coffee"];
    case "water":
      return ["water"];
    case "lunch":
      return mix("seat", agentId) % 2 === 0 ? ["lunch-a", "lunch-b"] : ["lunch-b", "lunch-a"];
    case "sofa":
      return ["sofa"];
    case "washroom":
      return ["washroom"];
    case "stroll": {
      const options: AmbientPlaceId[] = ["stroll-west", "stroll-mid", "stroll-east"];
      const first = mix("stroll", agentId, cycle, index) % options.length;
      return [...options.slice(first), ...options.slice(0, first)];
    }
    default:
      return [];
  }
}

interface PersonalDetail {
  slot: AmbientSlot;
  candidates: AmbientPlaceId[];
}

function personalDetail(agentId: string, t: number): PersonalDetail {
  const lengths = slotLengths(agentId);
  const cycleLength = lengths.reduce((sum, length) => sum + length, 0);
  const offset = mix("offset", agentId) % cycleLength;
  const shifted = t + offset;
  const cycle = Math.floor(shifted / cycleLength);
  let within = shifted - cycle * cycleLength;
  let index = 0;
  while (index < lengths.length - 1 && within >= lengths[index]!) {
    within -= lengths[index]!;
    index += 1;
  }
  const start = t - within;
  const end = start + lengths[index]!;
  const activity = pick(agentId, cycle, index, start);
  const candidates = candidatesFor(activity, agentId, cycle, index);
  return {
    slot: { activity, start, end, place: candidates[0] ?? null, partner: null, at: null, yielded: null },
    candidates,
  };
}

/**
 * The agent's own slot at `t`, before conversations and other agents are
 * considered: what it would like to do. `place` is the place it wants; `at` is
 * null, because a spot is only ever given by `ambientSlotAt`.
 */
export function personalSlotAt(agentId: string, t: number): AmbientSlot {
  return personalDetail(agentId, t).slot;
}

export interface ChatEvent {
  /** Sorted, so the lower id always takes `chat-a`. */
  pair: [string, string];
  start: number;
  end: number;
}

/**
 * The conversation in the window containing `t`, if there is one: a pair of
 * the given agents, chosen by a hash of the window. Half of the windows have
 * none, so the office is not one long meeting.
 */
export function chatInWindow(agentIds: readonly string[], t: number): ChatEvent | null {
  if (agentIds.length < 2) return null;
  const ids = [...agentIds].sort();
  const window = Math.floor(t / CHAT_WINDOW_MS);
  const h = mix("chat", window, ids.join(","));
  if (h % 2 === 0) return null;
  const i = (h >>> 1) % ids.length;
  let j = (h >>> 9) % ids.length;
  if (j === i) j = (i + 1) % ids.length;
  const pair = [ids[i]!, ids[j]!].sort() as [string, string];
  const start = window * CHAT_WINDOW_MS + CHAT_OFFSET_MS;
  return { pair, start, end: start + CHAT_LENGTH_MS };
}

function chatFor(agentId: string, agentIds: readonly string[], t: number): ChatEvent | null {
  // The window containing t, and the one before (a chat can run past its window's start of the next).
  for (const at of [t, t - CHAT_WINDOW_MS]) {
    const chat = chatInWindow(agentIds, at);
    if (chat && chat.pair.includes(agentId) && t >= chat.start && t < chat.end) return chat;
  }
  return null;
}

function overlapsChat(agentId: string, agentIds: readonly string[], start: number, end: number): boolean {
  for (let at = start - CHAT_WINDOW_MS; at < end + CHAT_WINDOW_MS; at += CHAT_WINDOW_MS) {
    const chat = chatInWindow(agentIds, at);
    if (chat && chat.pair.includes(agentId) && chat.start < end && start < chat.end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// VO-3.1.1 — occupancy: who stands where
// ---------------------------------------------------------------------------

/**
 * Spots are given out per epoch of this length. Every break that STARTS in an
 * epoch and ENDS in it is allocated together, in arrival order; a break that
 * would cross into the next epoch is spent at the desk instead. That boundary
 * is what keeps the allocation a pure, bounded function of time: without it,
 * who stands where now would depend on every break before it, back to the
 * start of time. About one break in twenty is lost to it.
 */
export const OCCUPANCY_EPOCH_MS = 30 * 60_000;

export interface SpotRequest {
  agentId: string;
  /** The whole slot: walking out, the stay, and walking back. */
  start: number;
  end: number;
  /** The places it may use, in order of preference. */
  candidates: readonly AmbientPlaceId[];
}

export interface SpotAssignment {
  place: AmbientPlaceId;
  /** Index into the place's `spots`. */
  spot: number;
}

export function requestKey(agentId: string, start: number): string {
  return `${agentId}@${start}`;
}

export function spotPoint(assignment: SpotAssignment): Point {
  return AMBIENT_PLACES[assignment.place].spots[assignment.spot]!;
}

/**
 * Gives each request a spot no other request holds at the same time, or null.
 *
 * Greedy in arrival order — earlier start first, then the agent id — so the
 * same requests always produce the same answer, whatever order they arrive
 * in. A spot is held for the request's whole slot, walking included, and is
 * free again for any request that starts at or after that slot's end. Each
 * request tries its places in order and each place's spots in order; when all
 * are held it gets null, and the break is spent at the desk.
 *
 * PURE: no clock, no I/O, nothing written.
 */
export function allocateSpots(requests: readonly SpotRequest[]): Map<string, SpotAssignment | null> {
  const ordered = [...requests].sort(
    (a, b) => a.start - b.start || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)
  );
  const heldUntil = new Map<string, number>();
  const result = new Map<string, SpotAssignment | null>();

  for (const request of ordered) {
    let chosen: SpotAssignment | null = null;
    for (const place of request.candidates) {
      const spots = AMBIENT_PLACES[place].spots.length;
      for (let spot = 0; spot < spots && !chosen; spot += 1) {
        const key = `${place}#${spot}`;
        if ((heldUntil.get(key) ?? Number.NEGATIVE_INFINITY) <= request.start) {
          chosen = { place, spot };
          heldUntil.set(key, request.end);
        }
      }
      if (chosen) break;
    }
    result.set(requestKey(request.agentId, request.start), chosen);
  }
  return result;
}

/** Every agent's breaks that start and end inside the epoch, conversations excluded. */
export function epochRequests(agentIds: readonly string[], epoch: number): SpotRequest[] {
  const from = epoch * OCCUPANCY_EPOCH_MS;
  const to = from + OCCUPANCY_EPOCH_MS;
  const requests: SpotRequest[] = [];
  for (const agentId of agentIds) {
    let t = from;
    const first = personalDetail(agentId, t).slot;
    // A break that began in the previous epoch belongs to no epoch.
    if (first.start < from) t = first.end;
    while (t < to) {
      const { slot, candidates } = personalDetail(agentId, t);
      if (slot.end > to) break;
      if (candidates.length > 0 && !overlapsChat(agentId, agentIds, slot.start, slot.end)) {
        requests.push({ agentId, start: slot.start, end: slot.end, candidates });
      }
      t = slot.end;
    }
  }
  return requests;
}

const EPOCH_CACHE = new Map<string, Map<string, SpotAssignment | null>>();
const EPOCH_CACHE_SIZE = 12;

/** The epoch's allocation. Memoised: the answer is a pure function of its key. */
function epochAllocation(agentIds: readonly string[], epoch: number): Map<string, SpotAssignment | null> {
  const ids = [...new Set(agentIds)].sort();
  const key = `${epoch}|${ids.join(",")}`;
  const cached = EPOCH_CACHE.get(key);
  if (cached) return cached;
  const allocation = allocateSpots(epochRequests(ids, epoch));
  EPOCH_CACHE.set(key, allocation);
  if (EPOCH_CACHE.size > EPOCH_CACHE_SIZE) {
    const oldest = EPOCH_CACHE.keys().next().value;
    if (oldest !== undefined) EPOCH_CACHE.delete(oldest);
  }
  return allocation;
}

/**
 * What the agent is doing at `t`, and exactly where.
 *
 * `agentIds` are the agents that share the office. A conversation takes its
 * pair to the meeting table. A personal break is spent at the desk instead
 * when it would overlap one of the agent's conversations, when it would cross
 * an occupancy epoch, or when every spot it could use is held by an agent who
 * got there first — so no two agents are ever given the same spot at once, and
 * no agent is in two places. All of it is a pure function of time and the set
 * of agents: the same instant always gives the same answer.
 */
export function ambientSlotAt(agentId: string, agentIds: readonly string[], t: number): AmbientSlot {
  const ids = agentIds.includes(agentId) ? agentIds : [...agentIds, agentId];
  const chat = chatFor(agentId, ids, t);
  if (chat) {
    const partner = chat.pair[0] === agentId ? chat.pair[1] : chat.pair[0];
    const place: AmbientPlaceId = chat.pair[0] === agentId ? "chat-a" : "chat-b";
    return { activity: "chat", start: chat.start, end: chat.end, place, partner, at: placePoint(place), yielded: null };
  }
  const { slot } = personalDetail(agentId, t);
  if (!slot.place) return slot;

  const atDesk = (yielded: AmbientYield): AmbientSlot => ({ ...slot, activity: "desk", place: null, at: null, yielded });
  if (overlapsChat(agentId, ids, slot.start, slot.end)) return atDesk("conversation");

  const epoch = Math.floor(slot.start / OCCUPANCY_EPOCH_MS);
  if (slot.end > (epoch + 1) * OCCUPANCY_EPOCH_MS) return atDesk("boundary");

  const assignment = epochAllocation(ids, epoch).get(requestKey(agentId, slot.start)) ?? null;
  if (!assignment) return atDesk("full");
  return { ...slot, place: assignment.place, at: spotPoint(assignment) };
}

/** Where a place's first spot is, as a figure's top-left. */
export function placePoint(place: AmbientPlaceId): Point {
  return AMBIENT_PLACES[place].at;
}
