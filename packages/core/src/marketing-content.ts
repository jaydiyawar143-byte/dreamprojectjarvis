// ---------------------------------------------------------------------------
// Phase 15 — content lifecycle and the calendar, as pure functions.
//
// The rules a content item lives by are decided here, once, so the service,
// the tools and the screen cannot each hold a slightly different idea of
// what "ready" means or what a published item may still do.
//
// THE THREE RULES THAT MATTER.
//
//   1. PUBLISHED IS NEVER SET BY A STATUS CHANGE. `canSetContentStatus` has no
//      branch that yields it. An item becomes published only when a publish
//      was read back from the provider, or the user says they posted it.
//
//   2. A PUBLISHED ITEM IS A RECORD. It cannot be edited, re-dated or moved to
//      another status: what went out is what it says went out.
//
//   3. EDITING THE COPY OF A READY ITEM MAKES IT A DRAFT AGAIN. "Ready" is a
//      statement about specific words. Change the words and the statement has
//      to be made again — which is also what stops an approval given for one
//      text from ever lining up with another.
// ---------------------------------------------------------------------------

import {
  CONTENT_PUBLISH_CLAIM_TTL_MS,
  CONTENT_STATUSES,
  type ContentCalendarDay,
  type ContentCalendarView,
  type ContentItemView,
  type ContentPublishState,
  type ContentStatus,
  type MarketingChannel,
  type SettableContentStatus,
} from "./types/marketing.js";

export type StatusDecision = { ok: true } | { ok: false; reason: string };

/**
 * May an item in `from` be moved to `to`?
 *
 * `hasCopy` is whether the item has any text. Ready with nothing to say is
 * refused: there would be nothing to publish.
 */
export function canSetContentStatus(
  from: ContentStatus,
  to: SettableContentStatus,
  hasCopy: boolean
): StatusDecision {
  if (from === "PUBLISHED") {
    return { ok: false, reason: "This item is already published, so its status can no longer change." };
  }
  if (from === to) return { ok: true };
  if (from === "ARCHIVED" && to === "READY") {
    return { ok: false, reason: "Restore the item to a draft first, then mark it ready." };
  }
  if (to === "READY" && !hasCopy) {
    return { ok: false, reason: "An item with no text cannot be marked ready." };
  }
  return { ok: true };
}

/** Whether an item's fields may still be changed. */
export function isEditableContent(status: ContentStatus): boolean {
  return status !== "PUBLISHED";
}

/** The fields that ARE the thing a publish would send. */
export const COPY_FIELDS = ["title", "channel", "format", "body", "link"] as const;

/**
 * The status an edit leaves an item in.
 *
 * `requested` is the status the edit asked for, if it asked for one. An edit
 * that changes the copy of a READY item and does not itself say READY returns
 * the item to DRAFT (rule 3).
 */
export function statusAfterEdit(
  current: ContentStatus,
  copyChanged: boolean,
  requested: SettableContentStatus | undefined
): ContentStatus {
  if (requested !== undefined) return requested;
  if (current === "READY" && copyChanged) return "DRAFT";
  return current;
}

/**
 * Whether a PUBLISHING claim is still held.
 *
 * A claim older than the TTL belongs to an execution that never reported
 * back — the process died, or the deadline passed. It is treated as
 * UNCONFIRMED, never as free: a request may have gone out.
 */
export function effectivePublishState(
  state: ContentPublishState,
  claimedAt: Date | null,
  now: Date = new Date()
): ContentPublishState {
  if (state !== "PUBLISHING") return state;
  if (claimedAt === null) return "UNCONFIRMED";
  return now.getTime() - claimedAt.getTime() > CONTENT_PUBLISH_CLAIM_TTL_MS ? "UNCONFIRMED" : "PUBLISHING";
}

/**
 * Why this item cannot be proposed for publishing — empty when it can.
 *
 * `publishableChannels` is the set of channels this deployment has a real
 * publisher for. A channel outside it is refused here, in words, rather than
 * being offered and failing later.
 */
export function publishBlockers(
  item: Pick<ContentItemView, "status" | "body" | "channel" | "publication">,
  publishState: ContentPublishState,
  publishableChannels: readonly MarketingChannel[]
): string[] {
  const blockers: string[] = [];

  if (item.status === "PUBLISHED" || item.publication !== null) {
    blockers.push("This item is already published.");
    return blockers;
  }
  if (item.status === "ARCHIVED") {
    blockers.push("This item is archived. Restore it to a draft first.");
    return blockers;
  }
  if (!publishableChannels.includes(item.channel)) {
    blockers.push(
      `Publishing to ${channelLabel(item.channel)} is not available here: JARVIS has no publishing connection for it. You can post it yourself and mark it as published.`
    );
  }
  if (item.status !== "READY") {
    blockers.push("Only an item marked ready can be published. Mark it ready first.");
  }
  if (item.body.trim().length === 0) {
    blockers.push("This item has no text to publish.");
  }
  if (publishState === "PUBLISHING") {
    blockers.push("A publish of this item is already running.");
  }
  return blockers;
}

const CHANNEL_LABELS: Readonly<Record<MarketingChannel, string>> = Object.freeze({
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
  LINKEDIN: "LinkedIn",
  X: "X",
  YOUTUBE: "YouTube",
  WHATSAPP: "WhatsApp",
  EMAIL: "Email",
  BLOG: "Blog",
  OTHER: "Other",
});

export function channelLabel(channel: MarketingChannel): string {
  return CHANNEL_LABELS[channel];
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

function byTimeThenTitle(a: ContentItemView, b: ContentItemView): number {
  // An item with no time sorts after the timed ones on its day.
  const left = a.scheduledTime ?? "99:99";
  const right = b.scheduledTime ?? "99:99";
  return left.localeCompare(right) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

/**
 * Items laid out by day.
 *
 * Only days that hold something are returned: a month is thirty mostly empty
 * days, and the grid is the screen's to draw. Items with no date are returned
 * separately rather than being placed on a day nobody chose.
 */
export function buildContentCalendar(
  items: readonly ContentItemView[],
  from: string,
  to: string,
  options: { total?: number; truncated?: boolean } = {}
): ContentCalendarView {
  const days = new Map<string, ContentItemView[]>();
  const unscheduled: ContentItemView[] = [];

  for (const item of items) {
    if (item.scheduledDate === null) {
      unscheduled.push(item);
      continue;
    }
    if (item.scheduledDate < from || item.scheduledDate > to) continue;
    const list = days.get(item.scheduledDate) ?? [];
    list.push(item);
    days.set(item.scheduledDate, list);
  }

  const ordered: ContentCalendarDay[] = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayItems]) => ({ date, items: [...dayItems].sort(byTimeThenTitle) }));

  unscheduled.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

  return {
    from,
    to,
    days: ordered,
    unscheduled,
    total: options.total ?? items.length,
    truncated: options.truncated ?? false,
  };
}

/** Zero for every status, so a count is never missing rather than zero. */
export function emptyStatusCounts(): Record<ContentStatus, number> {
  const counts = {} as Record<ContentStatus, number>;
  for (const status of CONTENT_STATUSES) counts[status] = 0;
  return counts;
}

export function countByStatus(items: readonly Pick<ContentItemView, "status">[]): Record<ContentStatus, number> {
  const counts = emptyStatusCounts();
  for (const item of items) counts[item.status] += 1;
  return counts;
}
