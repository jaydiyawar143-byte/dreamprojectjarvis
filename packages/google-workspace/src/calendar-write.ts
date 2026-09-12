// ---------------------------------------------------------------------------
// Calendar writes — Phase 13. Create, update, delete an event.
//
// THESE ARE THE MOST OUTWARD-FACING WRITES IN THE PHASE, and the reason is not
// obvious: a calendar event with attendees SENDS EMAIL. Creating one invites
// people, updating one notifies them, and deleting one tells them it is
// cancelled. So a "calendar write" is really a messaging action wearing a
// different name, and it is treated with the same seriousness.
//
// `sendUpdates` IS ALWAYS SET EXPLICITLY, never left to Google's default. The
// default for create is to notify, and silently emailing a dozen people because
// a default changed is exactly the surprise this phase must not produce. The
// caller decides, the plan states it, and the user approves it.
//
// DELETE IS THE ONE IRREVERSIBLE ACTION HERE. A deleted event cannot be
// restored through this API, and its attendees are told it was cancelled. It
// carries the highest risk level in the phase.
// ---------------------------------------------------------------------------

import { callGoogleWrite, type GoogleWriteOutcome } from "./http-write.js";
import { buildUrl } from "./http.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars";

const MAX_SUMMARY_CHARS = 1_000;
const MAX_DESCRIPTION_CHARS = 8_000;
const MAX_ATTENDEES = 50;

/**
 * Who gets emailed.
 *
 * Always passed explicitly. `none` is the quiet option and is the right default
 * for an event with no attendees; `all` is required the moment anyone else is
 * involved, because creating an invitation nobody is told about is its own kind
 * of wrong.
 */
export type SendUpdates = "all" | "externalOnly" | "none";

export interface EventInput {
  summary: string;
  description?: string;
  location?: string;
  /** ISO 8601 with offset, or a bare date for an all-day event. */
  start: string;
  end: string;
  allDay?: boolean;
  attendees?: string[];
  calendarId?: string;
}

export interface CalendarWriteResult {
  id: string;
  summary: string;
  start: string;
  end: string;
  htmlLink: string | null;
  status: string;
  attendeeCount: number;
  /** Whether Google was asked to notify anyone. Echoed for verification. */
  notified: SendUpdates;
}

const ADDRESS = /^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+\.[^\s@<>,;:"\\]{2,}$/;

export function validateEvent(input: EventInput): { ok: true } | { ok: false; message: string } {
  if (!input.summary.trim()) return { ok: false, message: "An event title is required." };
  if (input.summary.length > MAX_SUMMARY_CHARS) {
    return { ok: false, message: "The event title is too long." };
  }
  if ((input.description ?? "").length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, message: "The event description is too long." };
  }

  const attendees = input.attendees ?? [];
  if (attendees.length > MAX_ATTENDEES) {
    return { ok: false, message: `At most ${MAX_ATTENDEES} attendees are allowed.` };
  }
  for (const address of attendees) {
    if (!ADDRESS.test(address.trim())) {
      return { ok: false, message: `"${address.slice(0, 80)}" is not a valid email address.` };
    }
  }

  // All-day events use bare dates; timed events need parseable instants. A
  // malformed time would otherwise become a real event at the wrong moment.
  if (input.allDay) {
    for (const [label, value] of [["start", input.start], ["end", input.end]] as const) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, message: `${label} must be YYYY-MM-DD for an all-day event.` };
      }
    }
  } else {
    for (const [label, value] of [["start", input.start], ["end", input.end]] as const) {
      if (Number.isNaN(Date.parse(value))) {
        return { ok: false, message: `${label} is not a valid date and time.` };
      }
    }
    if (Date.parse(input.end) <= Date.parse(input.start)) {
      return { ok: false, message: "The event must end after it starts." };
    }
  }

  return { ok: true };
}

/** Google's event time shape, chosen by whether this is all-day. */
function timeField(value: string, allDay: boolean): Record<string, string> {
  return allDay ? { date: value } : { dateTime: value };
}

function normalize(
  raw: Record<string, unknown>,
  notified: SendUpdates
): CalendarWriteResult {
  const start = raw.start as { date?: string; dateTime?: string } | undefined;
  const end = raw.end as { date?: string; dateTime?: string } | undefined;

  return {
    id: String(raw.id ?? ""),
    summary: String(raw.summary ?? ""),
    start: start?.dateTime ?? start?.date ?? "",
    end: end?.dateTime ?? end?.date ?? "",
    htmlLink: typeof raw.htmlLink === "string" ? raw.htmlLink : null,
    status: String(raw.status ?? "confirmed"),
    attendeeCount: Array.isArray(raw.attendees) ? raw.attendees.length : 0,
    notified,
  };
}

// ---------------------------------------------------------------------------

export interface CalendarWriteDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CalendarWriteService {
  constructor(private readonly deps: CalendarWriteDeps = {}) {}

  private common() {
    return {
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}),
    };
  }

  /**
   * Creates an event.
   *
   * `sendUpdates` is REQUIRED, not defaulted: whether a dozen people get an
   * email is the most consequential thing about this call, and it must be a
   * decision the plan stated and the user approved.
   */
  async createEvent(
    accessToken: string,
    input: EventInput,
    sendUpdates: SendUpdates,
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<CalendarWriteResult>> {
    const valid = validateEvent(input);
    if (!valid.ok) return { ok: false, status: "provider_error", message: valid.message };

    const calendarId = input.calendarId ?? "primary";
    const allDay = input.allDay ?? false;

    const outcome = await callGoogleWrite<Record<string, unknown>>({
      url: buildUrl(`${CALENDAR_API}/${encodeURIComponent(calendarId)}/events`, {
        sendUpdates,
      }),
      method: "POST",
      accessToken,
      body: {
        summary: input.summary.trim(),
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
        start: timeField(input.start, allDay),
        end: timeField(input.end, allDay),
        ...(input.attendees && input.attendees.length > 0
          ? { attendees: input.attendees.map((email) => ({ email: email.trim() })) }
          : {}),
      },
      ...this.common(),
      ...(signal ? { signal } : {}),
    });

    if (!outcome.ok) return outcome;
    return { ok: true, body: normalize(outcome.body, sendUpdates) };
  }

  /**
   * Updates an event by full replacement of the supplied fields.
   *
   * PATCH rather than PUT, so unlisted fields survive — but every field the
   * plan showed IS sent, so the approved description of the result is accurate.
   */
  async updateEvent(
    accessToken: string,
    eventId: string,
    input: EventInput,
    sendUpdates: SendUpdates,
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<CalendarWriteResult>> {
    if (!eventId.trim()) {
      return { ok: false, status: "provider_error", message: "An event id is required." };
    }

    const valid = validateEvent(input);
    if (!valid.ok) return { ok: false, status: "provider_error", message: valid.message };

    const calendarId = input.calendarId ?? "primary";
    const allDay = input.allDay ?? false;

    const outcome = await callGoogleWrite<Record<string, unknown>>({
      url: buildUrl(
        `${CALENDAR_API}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { sendUpdates }
      ),
      method: "PATCH",
      accessToken,
      body: {
        summary: input.summary.trim(),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        start: timeField(input.start, allDay),
        end: timeField(input.end, allDay),
        ...(input.attendees
          ? { attendees: input.attendees.map((email) => ({ email: email.trim() })) }
          : {}),
      },
      ...this.common(),
      ...(signal ? { signal } : {}),
    });

    if (!outcome.ok) return outcome;
    return { ok: true, body: normalize(outcome.body, sendUpdates) };
  }

  /**
   * Deletes an event. IRREVERSIBLE, and it emails the attendees.
   *
   * Google returns 204 with no body, so there is nothing to normalize from the
   * response — the result is confirmed by the absence of an error, and the
   * caller verifies by re-reading rather than by trusting this return.
   */
  async deleteEvent(
    accessToken: string,
    eventId: string,
    calendarId: string,
    sendUpdates: SendUpdates,
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<{ deleted: true; eventId: string; notified: SendUpdates }>> {
    if (!eventId.trim()) {
      return { ok: false, status: "provider_error", message: "An event id is required." };
    }

    const outcome = await callGoogleWrite<unknown>({
      url: buildUrl(
        `${CALENDAR_API}/${encodeURIComponent(calendarId || "primary")}/events/${encodeURIComponent(eventId)}`,
        { sendUpdates }
      ),
      method: "DELETE",
      accessToken,
      ...this.common(),
      ...(signal ? { signal } : {}),
    });

    if (!outcome.ok) {
      // A 404 on delete means it is already gone. That is the DESIRED end
      // state, and for a retried delete it is the first attempt having
      // succeeded — so it is reported as a duplicate rather than a failure.
      if (outcome.status === "provider_error" && /does not exist/i.test(outcome.message)) {
        return {
          ok: false,
          duplicate: true,
          status: "provider_error",
          message: "That event no longer exists — it may already have been deleted.",
        };
      }
      return outcome;
    }

    return { ok: true, body: { deleted: true, eventId, notified: sendUpdates } };
  }
}
