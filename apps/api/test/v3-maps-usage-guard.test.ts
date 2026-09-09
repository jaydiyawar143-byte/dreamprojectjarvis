// ---------------------------------------------------------------------------
// Google Maps monthly usage guard.
//
// The guard has one job — stop Google requests at the ceiling — and three ways
// it could fail without anybody noticing:
//
//   1. UNDER-COUNTING. A counter that drifts low is a guard that does not
//      guard, and it drifts worst under exactly the concurrent load that a
//      runaway loop produces. Pinned by the cache tests below.
//
//   2. COUNTING THE WRONG THINGS. A cache hit costs Google nothing; a blocked
//      call costs nothing either. Charging budget for either one blocks users
//      early for no reason.
//
//   3. SILENTLY BYPASSING. The brief forbids it explicitly. A database failure
//      fails OPEN — that is the right call, since blocking every map request
//      because a counter table is unreachable is the worse outcome — but it
//      must be loud, and that is asserted here.
//
// No test in this file makes a network call.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_MONTHLY_LIMIT,
  LIMIT_REACHED_MESSAGE,
  MapsUsageGuard,
  levelFor,
  resolveMonthlyLimit,
  statusFrom,
  type UsageGuardLogger,
} from "../src/services/maps-usage-guard.js";
import { currentPeriod } from "@jarvis/db";

/** An in-memory stand-in for the Postgres counter. */
function fakeRepo(initial = 0) {
  const state = { total: initial, writes: [] as Array<{ userId: string; service: string }> };
  const repo = {
    async totalFor() {
      return state.total;
    },
    async increment(_period: string, userId: string, service: string) {
      state.total += 1;
      state.writes.push({ userId, service });
      return state.total;
    },
  };
  return { repo: repo as never, state };
}

function fakeLogger(): UsageGuardLogger & { events: Array<{ event: string; detail: unknown }> } {
  const events: Array<{ event: string; detail: unknown }> = [];
  return {
    events,
    warn(event, detail) {
      events.push({ event, detail });
    },
  };
}

// ---------------------------------------------------------------------------

describe("limit configuration", () => {
  it("defaults to 70,000 when unset", () => {
    expect(resolveMonthlyLimit({})).toBe(DEFAULT_MONTHLY_LIMIT);
    expect(DEFAULT_MONTHLY_LIMIT).toBe(70_000);
  });

  it("reads GOOGLE_MAPS_MONTHLY_LIMIT", () => {
    expect(resolveMonthlyLimit({ GOOGLE_MAPS_MONTHLY_LIMIT: "1234" })).toBe(1234);
  });

  it("falls back to the default on a typo rather than to unlimited", () => {
    // A fat-fingered variable must never be the thing that removes the ceiling.
    expect(resolveMonthlyLimit({ GOOGLE_MAPS_MONTHLY_LIMIT: "seventy thousand" })).toBe(
      DEFAULT_MONTHLY_LIMIT
    );
    expect(resolveMonthlyLimit({ GOOGLE_MAPS_MONTHLY_LIMIT: "-5" })).toBe(DEFAULT_MONTHLY_LIMIT);
    expect(resolveMonthlyLimit({ GOOGLE_MAPS_MONTHLY_LIMIT: "   " })).toBe(DEFAULT_MONTHLY_LIMIT);
  });

  it("honours zero as 'block everything'", () => {
    // A legitimate way to switch Google off without removing the keys.
    expect(resolveMonthlyLimit({ GOOGLE_MAPS_MONTHLY_LIMIT: "0" })).toBe(0);
    expect(levelFor(0, 0)).toBe("BLOCKED");
  });
});

// ---------------------------------------------------------------------------

describe("thresholds", () => {
  const limit = 70_000;

  it("is OK below 70%", () => {
    expect(levelFor(0, limit)).toBe("OK");
    expect(levelFor(48_999, limit)).toBe("OK");
  });

  it("warns at exactly 70%", () => {
    expect(levelFor(49_000, limit)).toBe("WARNING");
  });

  it("stays a warning at 85%", () => {
    expect(levelFor(59_500, limit)).toBe("WARNING");
  });

  it("escalates at 90%", () => {
    expect(levelFor(63_000, limit)).toBe("STRONG_WARNING");
  });

  it("is critical at 95%", () => {
    expect(levelFor(66_500, limit)).toBe("CRITICAL");
  });

  it("blocks at exactly 100%", () => {
    // The boundary is the whole feature: 69,999 must pass and 70,000 must not.
    expect(levelFor(69_999, limit)).toBe("CRITICAL");
    expect(levelFor(70_000, limit)).toBe("BLOCKED");
    expect(levelFor(70_001, limit)).toBe("BLOCKED");
  });

  it("reports the exact message the brief specifies once blocked", () => {
    const status = statusFrom(70_000, limit, "2026-09");
    expect(status.blocked).toBe(true);
    expect(status.message).toContain(LIMIT_REACHED_MESSAGE);
  });

  it("reports a percentage above 100 honestly when a limit is lowered", () => {
    // Never clamped in the data. The bar clamps; the number does not.
    const status = statusFrom(100_000, limit, "2026-09");
    expect(status.percentUsed).toBeGreaterThan(100);
    expect(status.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("hard block", () => {
  let logger: ReturnType<typeof fakeLogger>;

  beforeEach(() => {
    logger = fakeLogger();
  });

  it("allows a request below the limit", async () => {
    const { repo } = fakeRepo(10);
    const guard = new MapsUsageGuard(repo, 100, logger);

    const { allowed } = await guard.check();
    expect(allowed).toBe(true);
  });

  it("BLOCKS once the limit is reached", async () => {
    const { repo } = fakeRepo(100);
    const guard = new MapsUsageGuard(repo, 100, logger);

    const { allowed, status } = await guard.check();
    expect(allowed).toBe(false);
    expect(status.message).toContain(LIMIT_REACHED_MESSAGE);
  });

  it("logs every block, so a ceiling can never be hit silently", async () => {
    const { repo } = fakeRepo(100);
    const guard = new MapsUsageGuard(repo, 100, logger);

    await guard.check();
    expect(logger.events.map((e) => e.event)).toContain("maps_usage_limit_blocked");
  });

  it("does not record a blocked request", async () => {
    // A blocked call reaches no Google API, so it must not consume the budget
    // that blocked it — otherwise a blocked deployment inflates its own number.
    const { repo, state } = fakeRepo(100);
    const guard = new MapsUsageGuard(repo, 100, logger);

    await guard.check();
    expect(state.writes).toHaveLength(0);
  });

  it("blocks at the simulated 70,000 the brief asks to be verified", async () => {
    const { repo } = fakeRepo(70_000);
    const guard = new MapsUsageGuard(repo, 70_000, logger);

    const { allowed, status } = await guard.check();
    expect(allowed).toBe(false);
    expect(status.used).toBe(70_000);
    expect(status.percentUsed).toBe(100);
  });
});

// ---------------------------------------------------------------------------

describe("counting", () => {
  it("records a call against the authenticated user and the service", async () => {
    const { repo, state } = fakeRepo(0);
    const guard = new MapsUsageGuard(repo, 100, fakeLogger());

    await guard.record("user-a", "routes");
    expect(state.writes).toEqual([{ userId: "user-a", service: "routes" }]);
  });

  it("keeps each user's consumption separate", async () => {
    const { repo, state } = fakeRepo(0);
    const guard = new MapsUsageGuard(repo, 100, fakeLogger());

    await guard.record("user-a", "places");
    await guard.record("user-b", "geocoding");

    // Per-user attribution is what makes the admin breakdown meaningful; a
    // single shared bucket would make one runaway user invisible.
    expect(state.writes).toEqual([
      { userId: "user-a", service: "places" },
      { userId: "user-b", service: "geocoding" },
    ]);
  });

  it("never throws when the counter write fails", async () => {
    // A failed counter write must not turn a successful map lookup into an
    // error for the user.
    const logger = fakeLogger();
    const guard = new MapsUsageGuard(
      { async totalFor() { return 0; }, async increment() { throw new Error("db down"); } } as never,
      100,
      logger
    );

    await expect(guard.record("user-a", "places")).resolves.toBeUndefined();
    expect(logger.events.map((e) => e.event)).toContain("maps_usage_write_failed");
  });
});

// ---------------------------------------------------------------------------

describe("cached total only ever over-counts", () => {
  it("adds local increments on top of the cached database figure", async () => {
    const { repo } = fakeRepo(10);
    // A long refresh window, so nothing is re-read mid-test.
    const guard = new MapsUsageGuard(repo, 100, fakeLogger(), 60_000);

    await guard.status(); // primes the cache at 10
    for (let i = 0; i < 5; i++) await guard.record("user-a", "places");

    // 15, not 10. A guard that reported the stale 10 would let five extra
    // calls through for every refresh window.
    expect((await guard.status()).used).toBe(15);
  });

  it("reaches the block through local increments alone", async () => {
    const { repo } = fakeRepo(98);
    const guard = new MapsUsageGuard(repo, 100, fakeLogger(), 60_000);

    expect((await guard.check()).allowed).toBe(true);
    await guard.record("user-a", "places");
    await guard.record("user-a", "places");

    // Blocked without any database re-read.
    expect((await guard.check()).allowed).toBe(false);
  });

  it("drops the local delta once the database is re-read", async () => {
    const { repo } = fakeRepo(10);
    const guard = new MapsUsageGuard(repo, 1000, fakeLogger(), 0);

    await guard.status();
    await guard.record("user-a", "places"); // repo total is now 11
    // With a zero refresh window the next read comes from the repo, which
    // already includes that write — it must not be double-counted.
    expect((await guard.status()).used).toBe(11);
  });
});

// ---------------------------------------------------------------------------

describe("database failure fails open, but never silently", () => {
  it("allows requests when the total cannot be read", async () => {
    const logger = fakeLogger();
    const guard = new MapsUsageGuard(
      { async totalFor() { throw new Error("db down"); }, async increment() { return 1; } } as never,
      100,
      logger
    );

    // We have not established that the limit is reached, so we have not
    // reached it. Blocking every map request over an unreachable counter table
    // is the worse failure.
    expect((await guard.check()).allowed).toBe(true);
  });

  it("logs the failure AND its consequence every time", async () => {
    const logger = fakeLogger();
    const guard = new MapsUsageGuard(
      { async totalFor() { throw new Error("db down"); }, async increment() { return 1; } } as never,
      100,
      logger
    );

    await guard.check();

    const event = logger.events.find((e) => e.event === "maps_usage_read_failed");
    expect(event).toBeDefined();
    // "Failing open" and "silently bypassing the limit" differ by exactly this
    // line being present and actionable.
    expect(JSON.stringify(event?.detail)).toMatch(/ALLOWED/);
  });

  it("keeps an established block in force across a transient failure", async () => {
    let fail = false;
    const guard = new MapsUsageGuard(
      {
        async totalFor() {
          if (fail) throw new Error("db down");
          return 100;
        },
        async increment() { return 1; },
      } as never,
      100,
      fakeLogger(),
      0
    );

    expect((await guard.check()).allowed).toBe(false);
    fail = true;
    // The last known figure still says blocked; a blip must not lift a ceiling.
    expect((await guard.check()).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("monthly reset", () => {
  it("derives the period from the UTC calendar month", () => {
    expect(currentPeriod(new Date("2026-09-09T12:00:00Z"))).toBe("2026-09");
    expect(currentPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
    expect(currentPeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });

  it("rolls over at the month boundary in UTC", () => {
    // The reset is implicit: a new month writes to new rows. There is no
    // scheduled job that can fail to run and carry a full counter forward.
    expect(currentPeriod(new Date("2026-09-30T23:59:59Z"))).toBe("2026-09");
    expect(currentPeriod(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10");
  });

  it("starts a new month at zero even with the old month at the limit", async () => {
    const totals: Record<string, number> = { "2026-09": 70_000, "2026-10": 0 };
    const guard = new MapsUsageGuard(
      {
        async totalFor(period: string) {
          return totals[period] ?? 0;
        },
        async increment() { return 1; },
      } as never,
      70_000,
      fakeLogger(),
      0
    );

    expect((await guard.check(new Date("2026-09-30T23:59:00Z"))).allowed).toBe(false);
    expect((await guard.check(new Date("2026-10-01T00:01:00Z"))).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("no secret ever reaches a status payload", () => {
  it("carries counts only", async () => {
    const { repo } = fakeRepo(50);
    const guard = new MapsUsageGuard(repo, 100, fakeLogger());

    const serialised = JSON.stringify(await guard.status());
    for (const forbidden of ["AIza", "key", "Key", "token", "secret"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("logs no key and no coordinates when it blocks", async () => {
    const logger = fakeLogger();
    const guard = new MapsUsageGuard(fakeRepo(100).repo, 100, logger);

    await guard.check();
    const serialised = JSON.stringify(logger.events);
    expect(serialised).not.toMatch(/AIza/);
    expect(serialised).not.toMatch(/latitude|longitude/);
  });
});
