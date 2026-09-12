// ---------------------------------------------------------------------------
// GoogleCalendarService — read-only.
//
// Two actions: list upcoming events, get one event. No create, no update, no
// delete, no RSVP — an RSVP is a write that emails other people.
//
// TIME IS THE HARD PART, AND IT IS HANDLED EXPLICITLY.
//
//   - `singleEvents=true` expands recurring series into individual instances.
//     Without it a weekly stand-up appears once, with a recurrence rule the
//     caller would have to interpret, and "meri next meetings" would be wrong
//     for anyone with a repeating calendar — which is everyone.
//   - All-day events arrive as `date` (no time) rather than `dateTime`. They
//     are flagged, because rendering one at midnight local time silently moves
//     it a day for anyone west of UTC.
//   - `timeMin` is always sent. Without it Google returns events from the
//     beginning of the calendar, so "upcoming" would start years ago.
// ---------------------------------------------------------------------------

import type { CalendarEvent, CalendarListResult } from "@jarvis/core";
import { buildUrl, callGoogle, type GoogleCallOutcome } from "./http.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars";

const MAX_RESULTS = 25;

/** How far ahead "upcoming" looks when the caller does not say. */
const DEFAULT_WINDOW_DAYS = 7;

interface RawEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface RawEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: RawEventTime;
  end?: RawEventTime;
  status?: string;
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{ email?: string; responseStatus?: string; optional?: boolean }>;
  htmlLink?: string;
}

/**
 * Normalizes a Google event time.
 *
 * Returns the ISO string and whether it was all-day. An all-day `date` is
 * returned as given rather than converted: converting it to an instant requires
 * choosing a timezone, and choosing wrongly shifts the event by a day.
 */
function normalizeTime(time: RawEventTime | undefined): { iso: string; allDay: boolean } {
  if (!time) return { iso: new Date(0).toISOString(), allDay: false };
  if (time.dateTime) return { iso: time.dateTime, allDay: false };
  if (time.date) return { iso: time.date, allDay: true };
  return { iso: new Date(0).toISOString(), allDay: false };
}

function toEvent(raw: RawEvent, calendarId: string): CalendarEvent {
  const start = normalizeTime(raw.start);
  const end = normalizeTime(raw.end);

  return {
    id: raw.id ?? "",
    summary: raw.summary ?? "(no title)",
    description: raw.description ? raw.description.slice(0, 4000) : null,
    location: raw.location ?? null,
    start: start.iso,
    end: end.iso,
    allDay: start.allDay,
    status: raw.status ?? "confirmed",
    organizer: raw.organizer?.displayName || raw.organizer?.email || null,
    attendees: (raw.attendees ?? []).map((a) => ({
      email: a.email ?? "",
      responseStatus: a.responseStatus ?? "needsAction",
      optional: a.optional ?? false,
    })),
    htmlLink: raw.htmlLink ?? null,
    calendarId,
  };
}

// ---------------------------------------------------------------------------

export interface CalendarServiceDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export class GoogleCalendarService {
  constructor(private readonly deps: CalendarServiceDeps = {}) {}

  private get now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private call<T>(url: string, accessToken: string, signal?: AbortSignal) {
    return callGoogle<T>({
      url,
      accessToken,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * "meri next meetings batao" / "kal ka calendar dikhao".
   *
   * @param windowDays how far ahead to look. The caller supplies 1 for "kal".
   * @param fromIso    explicit window start, for "tomorrow" rather than "now".
   */
  async listUpcomingEvents(
    accessToken: string,
    options: {
      calendarId?: string;
      limit?: number;
      windowDays?: number;
      fromIso?: string;
      pageToken?: string;
    } = {},
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<CalendarListResult>> {
    const calendarId = options.calendarId ?? "primary";
    const from = options.fromIso ? new Date(options.fromIso) : this.now;

    if (Number.isNaN(from.getTime())) {
      return { ok: false, status: "provider_error", message: "The start time is not a valid date." };
    }

    const windowDays = Math.min(Math.max(options.windowDays ?? DEFAULT_WINDOW_DAYS, 1), 90);
    const to = new Date(from.getTime() + windowDays * 24 * 60 * 60 * 1000);

    const outcome = await this.call<{ items?: RawEvent[]; nextPageToken?: string }>(
      buildUrl(`${CALENDAR_API}/${encodeURIComponent(calendarId)}/events`, {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        maxResults: Math.min(Math.max(options.limit ?? 10, 1), MAX_RESULTS),
        // Expand recurrences, and order by start — which is only meaningful
        // once they ARE expanded.
        singleEvents: "true",
        orderBy: "startTime",
        pageToken: options.pageToken,
      }),
      accessToken,
      signal
    );

    if (!outcome.ok) return outcome;

    const events = (outcome.body.items ?? [])
      .map((e) => toEvent(e, calendarId))
      // A cancelled instance of a recurring series still comes back; showing it
      // as an upcoming meeting would be wrong.
      .filter((e) => e.status !== "cancelled");

    return {
      ok: true,
      body: {
        events,
        from: from.toISOString(),
        to: to.toISOString(),
        nextPageToken: outcome.body.nextPageToken ?? null,
      },
    };
  }

  async getEvent(
    accessToken: string,
    eventId: string,
    calendarId = "primary",
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<CalendarEvent>> {
    const outcome = await this.call<RawEvent>(
      buildUrl(
        `${CALENDAR_API}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        {}
      ),
      accessToken,
      signal
    );
    if (!outcome.ok) return outcome;
    return { ok: true, body: toEvent(outcome.body, calendarId) };
  }
}
