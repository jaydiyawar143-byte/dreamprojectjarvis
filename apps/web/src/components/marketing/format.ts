// ---------------------------------------------------------------------------
// Phase 15 — how the Marketing page words what the API returns.
//
// Pure functions and lookup tables, no state. The one that matters is
// `publicationOf`: an item is shown as published ONLY when the API says how
// that is known, and the two ways it can be known are never worded alike.
// ---------------------------------------------------------------------------

import type { CampaignStatus, ContentItemView, ContentStatus, ReportSourceStatus, SeoCheckSeverity } from "@jarvis/core/marketing";
import type { Tone } from "@/components/ui/primitives";

export const CONTENT_STATUS_LABEL: Record<ContentStatus, string> = {
  IDEA: "Idea",
  DRAFT: "Draft",
  READY: "Ready",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const CONTENT_STATUS_TONE: Record<ContentStatus, Tone> = {
  IDEA: "neutral",
  DRAFT: "neutral",
  READY: "info",
  PUBLISHED: "ok",
  ARCHIVED: "neutral",
};

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  PLANNING: "Planning",
  ACTIVE: "Active",
  PAUSED: "Paused",
  COMPLETED: "Completed",
  ARCHIVED: "Archived",
};

export const CAMPAIGN_STATUS_TONE: Record<CampaignStatus, Tone> = {
  PLANNING: "neutral",
  ACTIVE: "ok",
  PAUSED: "warn",
  COMPLETED: "info",
  ARCHIVED: "neutral",
};

/** Included is the only status that means figures are in the report. */
export const SOURCE_TONE: Record<ReportSourceStatus, Tone> = {
  INCLUDED: "ok",
  EMPTY: "neutral",
  NOT_CONFIGURED: "neutral",
  NOT_CONNECTED: "warn",
  SCOPE_NOT_GRANTED: "warn",
  NOT_INCLUDED: "neutral",
  FAILED: "danger",
};

export const SEVERITY_LABEL: Record<SeoCheckSeverity, string> = {
  pass: "OK",
  info: "Note",
  warning: "Worth fixing",
  critical: "Fix this",
};

export const SEVERITY_TONE: Record<SeoCheckSeverity, Tone> = {
  pass: "ok",
  info: "neutral",
  warning: "warn",
  critical: "danger",
};

export interface PublicationState {
  label: string;
  tone: Tone;
  /** One sentence saying how this is known, or that it is not. */
  detail: string;
}

/**
 * Whether an item is published, and how that is known.
 *
 * Null means it is not published and nothing is in doubt. There are exactly
 * two ways to be published and they are never merged: JARVIS posted it and
 * read it back, or the user said they posted it. A third state is neither —
 * a publish was sent and nobody knows what became of it.
 */
export function publicationOf(item: ContentItemView): PublicationState | null {
  if (item.publication?.mode === "VERIFIED") {
    return {
      label: "Published · verified",
      tone: "ok",
      detail: `Published by JARVIS to ${item.publication.targetName ?? "the Page"} and read back from it.`,
    };
  }
  if (item.publication?.mode === "REPORTED_BY_USER") {
    return {
      label: "Published · reported by you",
      tone: "info",
      detail: "You said you posted this yourself. JARVIS did not publish it and has not checked that it is live.",
    };
  }
  if (item.publishUnconfirmed) {
    return {
      label: "Publish not confirmed",
      tone: "warn",
      detail: "A publish was sent and its outcome is not known. This item is NOT marked as published. Check the Page before trying again.",
    };
  }
  return null;
}

// --- dates -------------------------------------------------------------------
//
// Calendar dates are plain YYYY-MM-DD strings end to end. They are never turned
// into a local Date and back, because that is how a post planned for the 5th
// ends up on the 4th for someone west of Greenwich.

const DAY_MS = 86_400_000;

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Mon 12 Oct 2026" — read from the date's own fields, in no timezone. */
export function formatDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return `${WEEKDAYS[parsed.getUTCDay()]} ${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
}

/** An instant, as a local date and time. */
export function formatInstant(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

/** The reply a failed request carries, or a fallback that claims nothing. */
export function failureOf(response: { error?: { message?: string } }, fallback: string): string {
  return response.error?.message ?? fallback;
}

export const INPUT_CLASS = "sys-focus w-full rounded border border-sys-control bg-sys-edge/40 px-3 py-1.5 text-sm text-sys-text";
export const SELECT_CLASS = "sys-focus rounded border border-sys-control bg-sys-edge/40 px-2 py-1.5 text-sm text-sys-text";
export const LABEL_CLASS = "block space-y-1 text-xs text-sys-dim";
