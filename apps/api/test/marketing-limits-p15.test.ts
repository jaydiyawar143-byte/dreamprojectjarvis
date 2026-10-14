// Phase 15 — the marketing limits, without a database.
//
// Two things are pinned here that the PostgreSQL tests cannot pin on their own:
//
//   1. `AtomicRateLimiter` itself: which row it asks the store to count and
//      write, and that it FAILS CLOSED — a store that cannot be reached is a
//      refusal, never a pass.
//   2. THE ORDER inside `MarketingService`: the slot is taken, and a report's
//      cap is answered, BEFORE anything outside JARVIS is called. A refused
//      request reaches no page, no ad account and no publisher.
//
// That the reservation is atomic under real concurrency is a property of
// PostgreSQL and is proven there: `marketing-p15-pg.integration` (the store)
// and `marketing-e2e-pg.integration` (sixty requests at once, over HTTP).
import { describe, it, expect } from "vitest";
import { MARKETING_LIMITS, type ContentItemView, type IToolExecutor, type PublishTarget, type ToolExecutionRequest } from "@jarvis/core";
import type { ContentPublisher, MarketingCallContext } from "@jarvis/tools";
import { AtomicRateLimiter, RATE_LIMIT_NAMESPACES, type SlotReservationPort } from "../src/services/rate-limiter.js";
import {
  MarketingService,
  PUBLISH_CHECK_RATE_LIMIT,
  REPORT_RATE_LIMIT,
  RESEARCH_RATE_LIMIT,
  type MarketingServiceDeps,
} from "../src/services/marketing/marketing-service.js";

const USER = "user-limits";
const ctx: MarketingCallContext = { actor: "user", traceId: "trace-limits" };

// ---------------------------------------------------------------------------
// 1. The limiter
// ---------------------------------------------------------------------------

describe("AtomicRateLimiter", () => {
  /** A store that counts exactly as the real one does — one caller at a time, by construction of JS. */
  function memoryStore() {
    const rows: Array<{ userId: string; action: string; at: number }> = [];
    const asked: Array<Parameters<SlotReservationPort["reserveSlot"]>[0]> = [];
    const store: SlotReservationPort = {
      async reserveSlot(input) {
        asked.push(input);
        const now = (input.now ?? new Date()).getTime();
        const count = rows.filter((row) => row.userId === input.userId && row.action === input.action && row.at >= now - input.windowMs).length;
        if (count >= input.limit) return { reserved: false, count };
        rows.push({ userId: input.userId, action: input.action, at: now });
        return { reserved: true, count: count + 1 };
      },
    };
    return { store, rows, asked };
  }

  it("asks the store for exactly the action `namespace.bucket`, with the limit, the window and the trace", async () => {
    const { store, asked } = memoryStore();
    const limiter = new AtomicRateLimiter(store, RATE_LIMIT_NAMESPACES.marketing);

    const decision = await limiter.reserve(USER, "limit.research", 20, 600_000, { traceId: "trace-1" });

    expect(decision).toEqual({ allowed: true, currentCount: 1, limit: 20, windowMs: 600_000 });
    expect(asked).toEqual([{ userId: USER, action: "marketing.limit.research", limit: 20, windowMs: 600_000, traceId: "trace-1" }]);
  });

  it("grants the limit and then refuses, saying it is the limit", async () => {
    const { store, rows } = memoryStore();
    const limiter = new AtomicRateLimiter(store, "marketing");

    for (let i = 0; i < 3; i += 1) expect((await limiter.reserve(USER, "limit.report", 3, 60_000)).allowed).toBe(true);
    const refused = await limiter.reserve(USER, "limit.report", 3, 60_000);

    expect(refused).toEqual({ allowed: false, currentCount: 3, limit: 3, windowMs: 60_000, reason: "LIMIT" });
    // A refusal wrote nothing.
    expect(rows).toHaveLength(3);
  });

  it("FAILS CLOSED when the store cannot be reached: not allowed, and said to be unavailable rather than too many", async () => {
    const limiter = new AtomicRateLimiter({ reserveSlot: async () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432")) }, "marketing");

    const decision = await limiter.reserve(USER, "limit.research", 20, 600_000);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("UNAVAILABLE");
    // Nothing of the store's error is carried out.
    expect(JSON.stringify(decision)).not.toContain("ECONNREFUSED");
  });

  it("keeps users and buckets apart", async () => {
    const { store } = memoryStore();
    const limiter = new AtomicRateLimiter(store, "marketing");
    await limiter.reserve(USER, "limit.report", 1, 60_000);

    expect((await limiter.reserve(USER, "limit.report", 1, 60_000)).allowed).toBe(false);
    expect((await limiter.reserve("someone-else", "limit.report", 1, 60_000)).allowed).toBe(true);
    expect((await limiter.reserve(USER, "limit.research", 1, 60_000)).allowed).toBe(true);
  });

  it("the three marketing windows are distinct buckets under one namespace", () => {
    const buckets = [RESEARCH_RATE_LIMIT.bucket, REPORT_RATE_LIMIT.bucket, PUBLISH_CHECK_RATE_LIMIT.bucket];
    expect(new Set(buckets).size).toBe(3);
    // None is the beginning of another, or of an outcome row the service writes.
    for (const bucket of buckets) {
      for (const other of ["research.fetch", "research.throttled", "report.generated", "report.throttled", "publish", "publish.resolve", "publish.check_throttled", ...buckets.filter((b) => b !== bucket)]) {
        expect(other.startsWith(bucket), `${other} / ${bucket}`).toBe(false);
      }
    }
    for (const policy of [RESEARCH_RATE_LIMIT, REPORT_RATE_LIMIT, PUBLISH_CHECK_RATE_LIMIT]) {
      expect(policy.limit).toBeGreaterThan(0);
      expect(policy.windowMs).toBe(10 * 60 * 1000);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The order inside the service
// ---------------------------------------------------------------------------

const PAGE: PublishTarget = { id: "1234567890", name: "Shop Page", channel: "FACEBOOK", provider: "probe" };

const READY_ITEM: ContentItemView = {
  id: "item_1",
  campaignId: null,
  projectId: null,
  title: "Teaser",
  channel: "FACEBOOK",
  format: "POST",
  body: "Something is coming.",
  link: null,
  notes: null,
  status: "READY",
  scheduledDate: null,
  scheduledTime: null,
  publication: null,
  publishAttempt: null,
  publishUnconfirmed: false,
  createdBy: "user",
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
};

function world(limiter: MarketingServiceDeps["limiter"] | "absent", options: { savedReports?: number } = {}) {
  /** Everything that reached outside JARVIS, in order. */
  const outside: string[] = [];
  const reservations: Array<{ bucket: string; limit: number; windowMs: number; traceId: string | undefined }> = [];
  const audits: Array<{ action: string; result: string }> = [];
  const saved: string[] = [];

  const store = {
    countReports: async () => options.savedReports ?? 0,
    listContent: async () => ({ items: [], total: 0 }),
    createReport: async () => {
      saved.push("report");
      return { id: "rep_1", sourcesIncluded: 0, sourcesTotal: 2 };
    },
    createResearch: async () => {
      saved.push("research");
      return { id: "res_1" };
    },
    findContent: async () => READY_ITEM,
    publishStateOf: async () => ({ state: "NONE" as const, claimedAt: null }),
  };

  const executor: Pick<IToolExecutor, "execute"> = {
    async execute(request: ToolExecutionRequest) {
      outside.push(`ad-account:${request.toolId}`);
      return { executionId: "e", toolId: request.toolId, status: "completed", result: { success: true, data: { insights: [], campaigns: [], accounts: [] } }, startedAt: new Date() };
    },
  };

  const publisher: ContentPublisher = {
    channel: "FACEBOOK",
    provider: "probe",
    async listTargets() {
      outside.push("publisher:listTargets");
      return [PAGE];
    },
    async publish() {
      outside.push("publisher:publish");
      return { externalId: "1234567890_1" };
    },
    async read() {
      outside.push("publisher:read");
      return null;
    },
    async findByMessage() {
      outside.push("publisher:findByMessage");
      return null;
    },
  };

  const wrapped: MarketingServiceDeps["limiter"] =
    limiter === "absent" || limiter === undefined
      ? undefined
      : {
          async reserve(userId, bucket, limit, windowMs, reserveOptions) {
            // Recorded BEFORE the answer, so the order against `outside` is visible.
            outside.push(`slot:${bucket}`);
            reservations.push({ bucket, limit, windowMs, traceId: reserveOptions?.traceId });
            return limiter.reserve(userId, bucket, limit, windowMs, reserveOptions);
          },
        };

  const service = new MarketingService({
    store: store as never,
    projects: { findOwned: async () => null },
    conversations: { findByIdAndUserId: async () => null },
    executor: () => executor,
    metaAccount: () => "act_000000000000015",
    googleAds: async () => ({ status: "NOT_CONFIGURED", detail: "Google Ads is not set up on this server." }),
    pages: {
      async fetch(url) {
        outside.push(`page:${String(url)}`);
        return { requestedUrl: String(url), finalUrl: String(url), httpStatus: 200, contentType: "text/html", html: "<title>Probe</title><h1>Probe</h1>", bytes: 34, truncated: false, redirects: 0, fetchedAt: new Date().toISOString() };
      },
    },
    publishers: [publisher],
    audit: { log: async (entry) => void audits.push({ action: entry.action, result: entry.result }) },
    ...(wrapped ? { limiter: wrapped } : {}),
  });
  return { service, outside, reservations, audits, saved };
}

const allow = { reserve: async () => ({ allowed: true }) };
const tooMany = { reserve: async () => ({ allowed: false, reason: "LIMIT" as const }) };
const unreachable = { reserve: async () => ({ allowed: false, reason: "UNAVAILABLE" as const }) };

describe("a page read takes its slot before the page is fetched", () => {
  it("allowed: the slot comes first, then the page", async () => {
    const w = world(allow);

    const result = await w.service.seoAudit(USER, { url: "https://example.com/" }, ctx);

    expect(result.ok).toBe(true);
    expect(w.outside).toEqual(["slot:limit.research", "page:https://example.com/"]);
    expect(w.reservations).toEqual([{ bucket: RESEARCH_RATE_LIMIT.bucket, limit: RESEARCH_RATE_LIMIT.limit, windowMs: RESEARCH_RATE_LIMIT.windowMs, traceId: "trace-limits" }]);
  });

  it("refused: no page is fetched, nothing is saved, and the refusal is audited", async () => {
    const w = world(tooMany);

    const result = await w.service.seoAudit(USER, { url: "https://example.com/" }, ctx);

    expect(result).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(w.outside).toEqual(["slot:limit.research"]);
    expect(w.saved).toEqual([]);
    expect(w.audits).toEqual([{ action: "marketing.research.throttled", result: "rejected" }]);
  });

  it("the limit cannot be checked: nothing is fetched, and it is said to be that — not 'too many'", async () => {
    const w = world(unreachable);

    const result = await w.service.seoAudit(USER, { url: "https://example.com/" }, ctx);

    expect(result).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(result.ok ? "" : result.message).toMatch(/could not be checked/);
    expect(w.outside).toEqual(["slot:limit.research"]);
  });

  it("a comparison takes one slot per page, each before its own fetch", async () => {
    const w = world(allow);

    await w.service.competitorAnalyze(USER, { competitorUrl: "https://rival.example/", ownUrl: "https://example.com/" }, ctx).catch(() => undefined);

    expect(w.outside.slice(0, 4)).toEqual(["slot:limit.research", "page:https://rival.example/", "slot:limit.research", "page:https://example.com/"]);
  });
});

describe("a report answers its cap and takes its slot before the ad account is read", () => {
  it("allowed: the slot comes first, then every read of the ad account", async () => {
    const w = world(allow);

    const result = await w.service.generateReport(USER, {}, ctx);

    expect(result.ok).toBe(true);
    expect(w.outside[0]).toBe("slot:limit.report");
    expect(w.outside.slice(1).length).toBeGreaterThan(0);
    for (const call of w.outside.slice(1)) expect(call).toMatch(/^ad-account:meta\./);
    expect(w.reservations).toEqual([{ bucket: REPORT_RATE_LIMIT.bucket, limit: REPORT_RATE_LIMIT.limit, windowMs: REPORT_RATE_LIMIT.windowMs, traceId: "trace-limits" }]);
  });

  it("refused: the ad account is not read once, and no report is saved", async () => {
    const w = world(tooMany);

    const result = await w.service.generateReport(USER, {}, ctx);

    expect(result).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(w.outside).toEqual(["slot:limit.report"]);
    expect(w.saved).toEqual([]);
    expect(w.audits).toEqual([{ action: "marketing.report.throttled", result: "rejected" }]);
  });

  it("at the cap: refused before the slot is asked for and before anything is read", async () => {
    const w = world(allow, { savedReports: MARKETING_LIMITS.reportsPerUser });

    const result = await w.service.generateReport(USER, {}, ctx);

    expect(result).toMatchObject({ ok: false, code: "LIMIT" });
    expect(w.outside).toEqual([]);
    expect(w.saved).toEqual([]);
  });

  it("input that cannot be used is refused before either: a bad request uses no slot", async () => {
    const w = world(allow);

    const result = await w.service.generateReport(USER, { from: "2026-01-01", to: "2026-12-31" }, ctx);

    expect(result).toMatchObject({ ok: false, code: "INVALID" });
    expect(w.outside).toEqual([]);
  });
});

describe("a publish check takes its slot before the provider is asked which Pages it may post to", () => {
  it("allowed: the slot comes first, then the provider", async () => {
    const w = world(allow);

    const result = await w.service.preparePublish(USER, "item_1", undefined, ctx);

    expect(result.ok && result.value.ready).toBe(true);
    expect(w.outside).toEqual(["slot:limit.publish_check", "publisher:listTargets"]);
  });

  it("refused: the provider is not asked, and no parameters to approve are produced", async () => {
    const w = world(tooMany);

    const result = await w.service.preparePublish(USER, "item_1", undefined, ctx);

    expect(result).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(w.outside).toEqual(["slot:limit.publish_check"]);
    expect(w.audits).toEqual([{ action: "marketing.publish.check_throttled", result: "rejected" }]);
  });

  it("the limit cannot be checked: the provider is not asked", async () => {
    const w = world(unreachable);

    const result = await w.service.preparePublish(USER, "item_1", undefined, ctx);

    expect(result).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(w.outside).toEqual(["slot:limit.publish_check"]);
  });
});
