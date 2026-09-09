// ---------------------------------------------------------------------------
// Google Maps monthly usage guard.
//
// A JARVIS-side ceiling on billable Google Maps requests. It is explicitly NOT
// a replacement for Google's own controls — a Cloud budget alert and a per-API
// quota cap still belong in the console, and this guard says so wherever it
// reports. What it adds is a limit enforced BEFORE a request leaves this
// process, so a runaway loop is stopped by our code in seconds rather than by a
// bill at the end of the month.
//
// FIVE DECISIONS WORTH KNOWING ABOUT:
//
// 1. ONLY GOOGLE CALLS ARE COUNTED. The OpenStreetMap fallback costs nothing
//    and is not metered. The limit is a *Google* limit.
//
// 2. AT 100% GOOGLE IS BLOCKED, AND WE DO NOT SILENTLY FALL BACK TO OSM.
//    Substituting a different provider without saying so would leave the user
//    believing they were still getting Google data. The block returns a plain
//    message instead. (An operator who would rather degrade than stop can set a
//    higher limit; that is a deliberate, visible choice.)
//
// 3. THE CHECK IS CACHED, AND THE CACHE ONLY EVER OVER-COUNTS. The global total
//    is read from Postgres at most once every REFRESH_MS, and every increment
//    in between is added locally on top. So the number the guard compares
//    against is never LOWER than what the database knows — a guard that drifts
//    low is a guard that does not guard.
//
// 4. A DATABASE FAILURE FAILS OPEN, LOUDLY. If the counter cannot be read, we
//    have not established that the limit is reached, and blocking every map
//    request because a counter table is unreachable is the worse failure. It is
//    logged at `warn` with a distinct event name every time, so it cannot pass
//    unnoticed — that is the difference between failing open and *silently*
//    bypassing the limit, which this must never do.
//
// 5. THE BROWSER MAP IS NOT COUNTABLE HERE. Maps JavaScript API loads are
//    billed by Google but happen in the user's browser and never reach this
//    process. This guard covers server-side Places, Geocoding and Routes calls
//    only, and the admin view states that plainly rather than implying the
//    number is the whole bill.
// ---------------------------------------------------------------------------

import type { MapsService } from "@jarvis/db";
import { currentPeriod, type PrismaMapsUsageRepository } from "@jarvis/db";

/** The escalating warning bands, in ascending order. */
export const USAGE_THRESHOLDS = [
  { at: 0.7, level: "WARNING" as const },
  { at: 0.85, level: "WARNING" as const },
  { at: 0.9, level: "STRONG_WARNING" as const },
  { at: 0.95, level: "CRITICAL" as const },
  { at: 1.0, level: "BLOCKED" as const },
];

export type UsageLevel = "OK" | "WARNING" | "STRONG_WARNING" | "CRITICAL" | "BLOCKED";

/** The message returned to a caller once the ceiling is reached. */
export const LIMIT_REACHED_MESSAGE = "Google Maps monthly usage limit reached.";

export const DEFAULT_MONTHLY_LIMIT = 70_000;

/** How long a database read of the global total is trusted. */
const REFRESH_MS = 30_000;

export interface UsageStatus {
  period: string;
  used: number;
  limit: number;
  /** 0-100, rounded to one decimal. Can exceed 100 if a limit is lowered. */
  percentUsed: number;
  level: UsageLevel;
  blocked: boolean;
  /** Plain English, suitable for an admin panel. */
  message: string;
}

/**
 * Reads `GOOGLE_MAPS_MONTHLY_LIMIT`.
 *
 * A missing, unparseable or negative value falls back to the documented
 * default rather than to "unlimited" — a typo in an environment variable must
 * not be the thing that removes the cost ceiling.
 *
 * `0` is honoured as a real value meaning "block everything", which is a
 * legitimate way to switch Google off without removing the keys.
 */
export function resolveMonthlyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GOOGLE_MAPS_MONTHLY_LIMIT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MONTHLY_LIMIT;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MONTHLY_LIMIT;
  return Math.floor(parsed);
}

/** Classifies a fraction of the budget into a band. */
export function levelFor(used: number, limit: number): UsageLevel {
  // A limit of zero means "blocked", not "divide by zero".
  if (limit <= 0) return "BLOCKED";
  const ratio = used / limit;

  let level: UsageLevel = "OK";
  for (const threshold of USAGE_THRESHOLDS) {
    if (ratio >= threshold.at) level = threshold.level;
  }
  return level;
}

function describe(level: UsageLevel, used: number, limit: number, percent: number): string {
  switch (level) {
    case "BLOCKED":
      return `${LIMIT_REACHED_MESSAGE} ${used.toLocaleString()} of ${limit.toLocaleString()} requests used this month.`;
    case "CRITICAL":
      return `Critical: ${percent}% of the monthly Google Maps budget used. Requests will be blocked at 100%.`;
    case "STRONG_WARNING":
      return `${percent}% of the monthly Google Maps budget used. Review usage before it reaches the limit.`;
    case "WARNING":
      return `${percent}% of the monthly Google Maps budget used.`;
    default:
      return `${percent}% of the monthly Google Maps budget used.`;
  }
}

export function statusFrom(used: number, limit: number, period: string): UsageStatus {
  const percent = limit > 0 ? Math.round((used / limit) * 1000) / 10 : 100;
  const level = levelFor(used, limit);
  return {
    period,
    used,
    limit,
    percentUsed: percent,
    level,
    blocked: level === "BLOCKED",
    message: describe(level, used, limit, percent),
  };
}

// ---------------------------------------------------------------------------

export interface UsageGuardLogger {
  warn(event: string, detail: Record<string, unknown>): void;
}

const consoleLogger: UsageGuardLogger = {
  warn(event, detail) {
    // Structured, and carrying NO coordinates, no query text and no key —
    // only counts. See the audit rules in the report.
    console.log(JSON.stringify({ level: "warn", event, ...detail }));
  },
};

export class MapsUsageGuard {
  private cachedTotal = 0;
  private cachedPeriod = "";
  private cachedAt = 0;
  /** Increments recorded since the last database read. */
  private localDelta = 0;

  constructor(
    private readonly repo: PrismaMapsUsageRepository,
    private readonly limit: number = resolveMonthlyLimit(),
    private readonly logger: UsageGuardLogger = consoleLogger,
    private readonly refreshMs: number = REFRESH_MS
  ) {}

  getLimit(): number {
    return this.limit;
  }

  /**
   * The global total for this month, over-counting rather than under.
   *
   * On a refresh the local delta is dropped, because the database read now
   * includes those writes.
   */
  private async total(period: string, now: number): Promise<number> {
    const stale = now - this.cachedAt >= this.refreshMs;
    if (this.cachedPeriod === period && !stale) {
      return this.cachedTotal + this.localDelta;
    }

    try {
      const fresh = await this.repo.totalFor(period);
      this.cachedTotal = fresh;
      this.cachedPeriod = period;
      this.cachedAt = now;
      this.localDelta = 0;
      return fresh;
    } catch (err) {
      this.logger.warn("maps_usage_read_failed", {
        reason: err instanceof Error ? err.message : "unknown",
        // Says explicitly what the consequence is, so this line is actionable
        // rather than merely noisy.
        consequence: "usage guard cannot verify the limit; requests are ALLOWED",
      });
      // Fail open — but never silently. Returning the last known figure keeps
      // a previously-established block in force across a transient blip.
      return this.cachedPeriod === period ? this.cachedTotal + this.localDelta : 0;
    }
  }

  /** Where the month stands, without recording anything. */
  async status(now: Date = new Date()): Promise<UsageStatus> {
    const period = currentPeriod(now);
    return statusFrom(await this.total(period, now.getTime()), this.limit, period);
  }

  /**
   * The gate every Google call passes through.
   *
   * Returns `allowed: false` once the ceiling is reached; the caller must then
   * return `status.message` rather than calling Google, and must NOT fall back
   * to another provider without saying so.
   *
   * Nothing is recorded here — `record()` is called after a call is actually
   * made, so a blocked request does not inflate the counter that blocked it.
   */
  async check(now: Date = new Date()): Promise<{ allowed: boolean; status: UsageStatus }> {
    const status = await this.status(now);
    if (status.blocked) {
      this.logger.warn("maps_usage_limit_blocked", {
        period: status.period,
        used: status.used,
        limit: status.limit,
      });
    }
    return { allowed: !status.blocked, status };
  }

  /**
   * Records one billable call.
   *
   * Deliberately does NOT throw: a counter write that fails must not turn a
   * successful map lookup into an error for the user. It is logged instead, and
   * the local delta still advances so the in-process figure does not drift low.
   */
  async record(userId: string, service: MapsService, now: Date = new Date()): Promise<void> {
    const period = currentPeriod(now);
    this.localDelta += 1;

    try {
      await this.repo.increment(period, userId, service);
    } catch (err) {
      this.logger.warn("maps_usage_write_failed", {
        period,
        service,
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  /** Test seam: forget the cached total. */
  resetCache(): void {
    this.cachedTotal = 0;
    this.cachedPeriod = "";
    this.cachedAt = 0;
    this.localDelta = 0;
  }
}

// ---------------------------------------------------------------------------
// Process-wide instance
//
// The geo providers and the admin route are constructed in different places and
// must see the same guard. Installed once at container build; absent in unit
// tests, where the providers treat "no guard" as "not metered" so a test never
// needs a database.
// ---------------------------------------------------------------------------

let installed: MapsUsageGuard | null = null;

export function setMapsUsageGuard(guard: MapsUsageGuard | null): void {
  installed = guard;
}

export function getMapsUsageGuard(): MapsUsageGuard | null {
  return installed;
}
