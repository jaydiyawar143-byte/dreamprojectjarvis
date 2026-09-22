// ---------------------------------------------------------------------------
// Schedule-phrase parsing — Scheduler V1.
//
// Turns "tomorrow at 10 AM" into an instant, or refuses.
//
// A CLOSED grammar, not a date parser. There is no date library in this
// repository and this is not the place to become one: it recognises a handful
// of explicit forms and returns null for everything else, and "everything
// else" includes every vague phrase — "later", "soon", "sometime", "in a
// while". A vague phrase is not a time, and guessing one would schedule real
// work at an hour the user never chose.
//
// TIMEZONE IS A PARAMETER, NOT THE PROCESS'S.
//
// An earlier version resolved "10:45 PM" with `Date.prototype.setHours`, which
// reads whatever zone the process happens to have. That is not a contract, it
// is an inherited accident: a container with no TZ runs UTC, so the same
// sentence produced an instant five and a half hours away from what was meant,
// and nothing in the code said so. It was found only because a real scheduled
// task sat there not firing.
//
// So the zone is now an explicit argument, defaulting to one named constant.
// The same message with the same `now` resolves to the SAME instant whether
// this runs on UTC, IST, or a laptop in another country — which is also what
// makes it testable, since a CI box on UTC can assert the IST answer.
//
// There is still no per-user timezone (verified: `UserSetting` is generic
// key/value and nothing writes one). This does not add one — it makes the
// single deployment-wide zone stated instead of ambient, and leaves the
// parameter in place for the day a per-user zone exists.
//
// The REST API sidesteps the question entirely by requiring an ISO-8601
// timestamp with an explicit offset.
// ---------------------------------------------------------------------------

/**
 * The zone a spoken wall-clock time is interpreted in.
 *
 * ONE named constant, deliberately not read from the environment: `TZ` is what
 * caused the bug this replaced, so it cannot also be the fix. Changing the
 * deployment's zone is a code change with a test, not an env var nobody sees.
 */
export const SCHEDULE_ZONE = "Asia/Kolkata";

/** What a schedule phrase resolved to, and the text it was read from. */
export interface SchedulePhrase {
  /** The absolute instant. Bare clock times are read in the scheduling zone. */
  at: Date;
  /** The matched phrase, so a caller can echo what it understood. */
  matched: string;
}

// ---------------------------------------------------------------------------
// Zone arithmetic, built on Intl — no dependency, no date library.
// ---------------------------------------------------------------------------

/** A calendar date, with no zone and no time attached. */
interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let dtf = formatters.get(zone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      // `h23` rather than `hour12: false`, which can render midnight as "24".
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, dtf);
  }
  return dtf;
}

/** The wall-clock fields an instant shows in `zone`. */
function fieldsIn(zone: string, instant: number): Required<CalendarDate> & {
  hour: number;
  minute: number;
  second: number;
} {
  const parts = formatterFor(zone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** How far `zone` is ahead of UTC at a given instant, in milliseconds. */
function offsetAt(zone: string, instant: number): number {
  const f = fieldsIn(zone, instant);
  const asIfUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  // Seconds resolution is enough: no IANA zone has a sub-second offset.
  return asIfUtc - Math.floor(instant / 1000) * 1000;
}

/** The calendar date an instant falls on, in `zone`. */
function calendarDateIn(zone: string, instant: number): CalendarDate {
  const f = fieldsIn(zone, instant);
  return { year: f.year, month: f.month, day: f.day };
}

/** Calendar arithmetic. `Date.UTC` normalises month and year rollover. */
function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * The instant at which `zone` reads the given wall clock.
 *
 * Solved by iteration rather than by a table: guess that the wall clock is
 * UTC, measure how far the zone actually sits from UTC at that guess, and
 * correct. The second pass matters only at a DST boundary, where the offset
 * at the guess differs from the offset at the answer — India has no DST, but
 * a zone parameter that is wrong twice a year elsewhere is not a contract.
 */
function wallClockToInstant(
  zone: string,
  date: CalendarDate,
  hour: number,
  minute: number
): number {
  const asIfUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0, 0);
  const firstGuess = asIfUtc - offsetAt(zone, asIfUtc);
  const corrected = asIfUtc - offsetAt(zone, firstGuess);
  return corrected;
}

/**
 * Vague time words.
 *
 * Present so they are refused LOUDLY rather than ignored: a caller can tell
 * "there was no time here" from "there was a time-ish word I would not guess
 * at", and ask for a specific one.
 */
const VAGUE = /\b(later|soon|sometime|afterwards|in a (?:bit|while)|baad mein|thodi der)\b/i;

/** "at 10", "at 10:30 am", "10 am", "5pm", "17:30". */
const CLOCK =
  /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|baje)?\b/i;

const TOMORROW = /\b(tomorrow|kal)\b/i;
const TODAY = /\b(today|aaj)\b/i;

/** "in 30 minutes", "in 2 hours". The only relative form V1 accepts. */
const RELATIVE = /\bin\s+(\d{1,3})\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\b/i;

/**
 * Whether a message contains a vague time word and no usable time.
 *
 * The caller uses this to ask for a specific time instead of scheduling.
 */
export function mentionsVagueTime(message: string): boolean {
  return VAGUE.test(message) && parseSchedulePhrase(message) === null;
}

/** A clock time stated unambiguously: "1:50 PM", "5 baje", "17:30". */
const STATED_CLOCK = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|baje)\b/i;

/** An hour:minute form, which is never anything but a time. */
const STATED_HHMM = /\b\d{1,2}:\d{2}\b/;

/** A named day beside any clock-shaped token: "tomorrow at 10". */
const STATED_DAY = /\b(?:today|tomorrow|aaj|kal)\b/i;
const ANY_CLOCKISH = /\b(?:at\s+)?\d{1,2}(?::\d{2})?\b/;

/**
 * Whether the message STATES a time, whether or not one could be resolved.
 *
 * This is the counterpart to `mentionsVagueTime`, and it exists to close a
 * specific hole: `parseSchedulePhrase` returns null both when there is no time
 * at all AND when there IS one that cannot be used — a named day that has
 * already passed, an hour out of range. Those two are not the same thing, and
 * treating them the same made "check my system status today at 1:50 PM", asked
 * at 2 PM, fall through to IMMEDIATE EXECUTION: the time was thrown away and
 * the imperative ran now.
 *
 * Deliberately NARROWER than `CLOCK` above. A bare number is not a time —
 * "check the top 5 campaigns" must not be read as 5 o'clock — so this needs a
 * meridiem, a `baje`, an `hh:mm`, or a named day sitting beside a clock.
 */
export function mentionsExplicitTime(message: string): boolean {
  if (STATED_CLOCK.test(message)) return true;
  if (STATED_HHMM.test(message)) return true;
  return STATED_DAY.test(message) && ANY_CLOCKISH.test(message);
}

/**
 * Read an explicit future instant out of a message, or return null.
 *
 * Accepts, and nothing else:
 *   "in 30 minutes" / "in 2 hours"
 *   "tomorrow at 10", "tomorrow at 10 am", "kal 5 baje"
 *   "today at 6 pm", "at 6 pm", "6pm"
 *
 * A bare clock time that has already passed today rolls to TOMORROW, which is
 * what "at 6 pm" said at 8 pm means to a person. An explicit "today at 6 pm"
 * that has passed does NOT roll — it is refused, because the user named the
 * day and it is gone.
 */
export function parseSchedulePhrase(
  message: string,
  now: Date = new Date(),
  zone: string = SCHEDULE_ZONE
): SchedulePhrase | null {
  const relative = RELATIVE.exec(message);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const ms = unit.startsWith("h") ? amount * 3_600_000 : amount * 60_000;
    // Pure arithmetic on an instant — already zone-independent.
    return { at: new Date(now.getTime() + ms), matched: relative[0] };
  }

  const clock = CLOCK.exec(message);
  if (!clock) return null;

  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock[3]?.toLowerCase();

  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem?.startsWith("p") && hour < 12) hour += 12;
  if (meridiem?.startsWith("a") && hour === 12) hour = 0;
  // "5 baje" with no am/pm: a bare hour below 8 is far more likely to mean the
  // evening in ordinary use. Anything ambiguous enough to matter should be
  // said with am/pm, and the caller echoes the resolved time either way.
  if (!meridiem && hour < 8) hour += 12;

  const wantsTomorrow = TOMORROW.test(message);
  const wantsToday = TODAY.test(message);

  // "Today" means today IN THE SCHEDULING ZONE, not in whatever zone this
  // process happens to run in. At 23:00 IST those are different dates.
  const today = calendarDateIn(zone, now.getTime());
  const day = wantsTomorrow ? addDays(today, 1) : today;

  let at = new Date(wallClockToInstant(zone, day, hour, minute));

  if (at.getTime() <= now.getTime()) {
    // An explicitly named day that has passed is an error, not a roll-over.
    if (wantsToday || wantsTomorrow) return null;
    at = new Date(wallClockToInstant(zone, addDays(day, 1), hour, minute));
  }

  return { at, matched: clock[0].trim() };
}
