"use client";

// ---------------------------------------------------------------------------
// Calendar — upcoming events, and one event's detail.
//
// READ-ONLY. No create, no edit, no delete, and no RSVP — an RSVP is a write
// that emails other people.
//
// TIME IS RENDERED IN THE VIEWER'S OWN ZONE, via `toLocaleTimeString`, because
// the server cannot know it. All-day events are labelled "All day" rather than
// shown at a time: they arrive as a bare date, and rendering one at midnight
// silently moves it a day for anyone west of UTC.
//
// Events are grouped by day with "Today" / "Tomorrow" labels, because that is
// how people read a calendar — "kal ka calendar dikhao" is a question about a
// day, not about a timestamp range.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { Clock, ExternalLink, MapPin, Users } from "lucide-react";
import {
  getCalendarEvent,
  listUpcomingCalendarEvents,
  type CalendarEvent,
  type CalendarListResult,
  type GoogleTaskStatus,
} from "@/lib/api";
import { Panel } from "@/components/dashboard/panel";
import { Badge } from "@/components/ui/primitives";
import {
  PanelEmpty,
  PanelLoading,
  PanelProblem,
  clockTime,
  dayLabel,
} from "./workspace-states";

type Problem = { status: Exclude<GoogleTaskStatus, "ok">; message: string; requiredAction?: string };

const WINDOWS = [
  { label: "Today", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
] as const;

export function CalendarPanel({ onConnect }: { onConnect: () => void }) {
  const [list, setList] = useState<CalendarListResult | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState<number>(7);
  const [detail, setDetail] = useState<CalendarEvent | null>(null);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    setProblem(null);
    setDetail(null);

    const result = await listUpcomingCalendarEvents(15, days);
    setLoading(false);

    if (result.success && result.data) {
      setList(result.data);
      return;
    }
    setList(null);
    setProblem({
      status: result.status === "ok" ? "provider_error" : result.status,
      message: result.message ?? "The calendar could not be read.",
      ...(result.requiredAction ? { requiredAction: result.requiredAction } : {}),
    });
  }, []);

  useEffect(() => {
    void load(windowDays);
  }, [load, windowDays]);

  const openDetail = useCallback(async (event: CalendarEvent) => {
    const result = await getCalendarEvent(event.id, event.calendarId);
    if (result.success && result.data) {
      setDetail(result.data);
      return;
    }
    setProblem({
      status: result.status === "ok" ? "provider_error" : result.status,
      message: result.message ?? "That event could not be read.",
      ...(result.requiredAction ? { requiredAction: result.requiredAction } : {}),
    });
  }, []);

  // Grouped by day, preserving the server's start-time ordering within each.
  const grouped = (list?.events ?? []).reduce<Array<[string, CalendarEvent[]]>>((acc, event) => {
    const label = dayLabel(event.start);
    const last = acc[acc.length - 1];
    if (last && last[0] === label) last[1].push(event);
    else acc.push([label, [event]]);
    return acc;
  }, []);

  return (
    <Panel
      data-testid="calendar-panel"
      // Fills its grid cell and lets the body shrink, so the list inside is
      // what scrolls rather than the page.
      className="min-h-0 flex-1"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      title="Calendar"
      description="Upcoming events"
      action={
        list && list.events.length > 0 ? (
          <span className="font-mono text-xs text-sys-dim">{list.events.length}</span>
        ) : null
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              data-testid={`calendar-window-${w.days}`}
              onClick={() => setWindowDays(w.days)}
              aria-pressed={windowDays === w.days}
              className={`sys-focus rounded border px-2 py-1 font-mono text-xs uppercase tracking-hud transition-colors ${
                windowDays === w.days
                  ? "border-sys-cyan/40 bg-sys-cyan/10 text-sys-cyan"
                  : "border-sys-line text-sys-dim hover:text-white"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        {loading && <PanelLoading label="Reading calendar" />}

        {!loading && problem && (
          <PanelProblem {...problem} onConnect={onConnect} onRetry={() => void load(windowDays)} />
        )}

        {!loading && !problem && list && list.events.length === 0 && (
          <PanelEmpty
            message={
              windowDays === 1
                ? "Nothing scheduled today."
                : `Nothing scheduled in the next ${windowDays} days.`
            }
          />
        )}

        {!loading && !problem && grouped.length > 0 && (
          <div
            data-testid="calendar-list"
            className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
          >
            {grouped.map(([label, events]) => (
              <section key={label} className="space-y-1">
                <h3 className="font-mono text-xs uppercase tracking-hud text-sys-dim">{label}</h3>
                <ul className="space-y-1">
                  {events.map((event) => (
                    <li
                      key={event.id}
                      data-testid={`calendar-event-${event.id}`}
                      className="rounded border border-sys-line/60 bg-white/[0.02] p-2"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="shrink-0 font-mono text-xs text-sys-cyan-soft [font-variant-numeric:tabular-nums]">
                          {clockTime(event.start, event.allDay)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void openDetail(event)}
                          className="sys-focus min-w-0 flex-1 truncate text-left text-xs font-medium text-white hover:text-sys-cyan-soft"
                        >
                          {event.summary}
                        </button>
                        {event.htmlLink && (
                          <a
                            href={event.htmlLink}
                            target="_blank"
                            rel="noreferrer noopener"
                            aria-label={`Open ${event.summary} in Google Calendar`}
                            className="sys-focus shrink-0 rounded p-0.5 text-sys-dim hover:text-sys-cyan"
                          >
                            <ExternalLink size={11} aria-hidden />
                          </a>
                        )}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-sys-dim">
                        {!event.allDay && (
                          <>
                            <Clock size={9} aria-hidden />
                            <span>
                              {clockTime(event.start)} – {clockTime(event.end)}
                            </span>
                          </>
                        )}
                        {event.location && (
                          <>
                            <MapPin size={9} aria-hidden />
                            <span className="truncate">{event.location}</span>
                          </>
                        )}
                        {event.attendees.length > 0 && (
                          <>
                            <Users size={9} aria-hidden />
                            <span>{event.attendees.length}</span>
                          </>
                        )}
                      </div>

                      {detail?.id === event.id && (
                        <div
                          data-testid={`calendar-detail-${event.id}`}
                          className="mt-2 space-y-1 border-t border-sys-line/70 pt-2 text-xs"
                        >
                          {detail.organizer && (
                            <p className="text-sys-dim">
                              Organizer:{" "}
                              <span className="text-sys-text/85">{detail.organizer}</span>
                            </p>
                          )}
                          {detail.description && (
                            <p className="whitespace-pre-wrap break-words leading-relaxed text-sys-text/85">
                              {detail.description}
                            </p>
                          )}
                          {detail.attendees.length > 0 && (
                            <ul className="space-y-0.5">
                              {detail.attendees.slice(0, 12).map((a) => (
                                <li key={a.email} className="flex items-center gap-1.5">
                                  <Badge
                                    tone={
                                      a.responseStatus === "accepted"
                                        ? "ok"
                                        : a.responseStatus === "declined"
                                          ? "danger"
                                          : "neutral"
                                    }
                                  >
                                    {a.responseStatus}
                                  </Badge>
                                  <span className="truncate text-sys-dim">{a.email}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
