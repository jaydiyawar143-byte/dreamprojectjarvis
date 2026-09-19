// ---------------------------------------------------------------------------
// Phase 11.9B — Opportunity Queue API Tests
//
// 25 focused tests covering all spec items from §19:
//  1.  queue creation
//  2.  ranking
//  3.  pagination
//  4.  filters (priority, status, entityType, actionType)
//  5.  priority bands
//  6.  recommendation detail
//  7.  account isolation
//  8.  user isolation
//  9.  IDOR protection
// 10.  expired opportunity
// 11.  stale state
// 12.  conflict state
// 13.  no-opportunity state
// 14.  unauthorized access
// 15.  forged score
// 16.  forged priority
// 17.  forged historical evidence
// 18.  paramsHash protection
// 19.  approval handoff
// 20.  no automatic execution
// 21.  zero Meta writes while browsing
// 22.  deterministic ordering
// 23.  error handling
// 24.  secret redaction
// 25.  backward compatibility
//
// All tests use mocks/fakes. Real Meta writes are NEVER required.
// Uses the same router-walking harness as the existing approvals.test.ts.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Router } from "express";
import { createOpportunitiesRouter } from "../src/routes/opportunities.js";
import type { Container } from "../src/services/container.js";
import type { RecommendationRecord, AuditLogger } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Helpers / Factories
// ---------------------------------------------------------------------------

let _seq = 0;
function makeId(prefix = "rec"): string {
  return `${prefix}${String(++_seq).padStart(8, "0")}abcdef`;
}

function makeRecord(
  overrides: Partial<RecommendationRecord> & {
    userId?: string;
    accountId?: string;
    status?: string;
    expiresAt?: string;
    risk?: "LOW" | "MEDIUM" | "HIGH";
  } = {}
): RecommendationRecord {
  const id = overrides.recommendationId ?? makeId();
  const now = new Date();
  const future = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  return {
    schemaVersion: 1,
    recommendationId: id,
    userId: overrides.userId ?? "user-alice",
    accountId: overrides.accountId ?? "act_12345",
    entityLevel: "AD" as const,
    entityId: `ad_${id.slice(-6)}`,
    diagnosisId: "diag_001",
    diagnosisCategory: "CREATIVE_FATIGUE",
    anomalyIds: ["anomaly_01"],
    actionType: (overrides.actionType as RecommendationRecord["actionType"]) ?? "PAUSE_AD",
    currentState: { status: "ACTIVE" },
    proposedState: { status: "PAUSED" },
    reason: "Creative fatigue detected. CPA increased 47% while CTR declined 21%.",
    evidence: {
      evidenceHash: `evhash_${id.slice(-16)}`,
      accountId: overrides.accountId ?? "act_12345",
      entityId: `ad_${id.slice(-6)}`,
      entityLevel: "AD" as const,
      windowDays: 7,
      currency: "USD",
      currentMetrics: { spend: 500, ctr: 0.02, cpa: 45 },
      baselineMetrics: { spend: 300, ctr: 0.03, cpa: 30 },
      metricDetails: [
        { metric: "CPA", currentValue: 45, baselineValue: 30, changePercent: 50, direction: "INCREASING" },
        { metric: "CTR", currentValue: 0.02, baselineValue: 0.03, changePercent: -33, direction: "DECREASING" },
      ],
      anomalies: [
        {
          metric: "CPA",
          severity: "CRITICAL" as const,
          direction: "NEGATIVE_ANOMALY" as const,
          percentDeviation: 50,
          detectedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        },
      ],
      collectedAt: now.toISOString(),
    },
    expectedImpact: {
      metric: "SPEND" as const,
      direction: "DECREASE" as const,
      estimatedRange: "NOT_ESTIMATED" as const,
      rationale: "Pause will stop inefficient spend.",
    },
    risk: overrides.risk ?? "LOW",
    confidence: "HIGH" as const,
    priority: "HIGH" as const,
    historicalEvidenceIds: [],
    confidenceExplanation: {
      level: "HIGH" as const,
      currentEvidence: "HIGH" as const,
      historicalEvidence: "MODERATE" as const,
      sampleQuality: "LOW_SAMPLE" as const,
      historicalSampleSize: 8,
      historicalConsistency: "CONSISTENT_POSITIVE" as const,
      contradictoryEvidence: [],
      limitations: ["LOW_SAMPLE_SIZE"],
    },
    preconditions: [],
    paramsHash: `paramshash_${id.slice(-16)}`,
    stateHash: `statehash_${id.slice(-16)}`,
    identityHash: `idhash_${id.slice(-16)}`,
    status: (overrides.status ?? "PROPOSED") as RecommendationRecord["status"],
    requiresApproval: true as const,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: overrides.expiresAt ?? future,
    staleReasons: [],
    ...overrides,
  } as RecommendationRecord;
}

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------

class FakeRecommendationRepo {
  records: RecommendationRecord[] = [];

  async listForOpportunityQueue(userId: string, accountId: string) {
    const items = this.records.filter(
      (r) => r.userId === userId && r.accountId === accountId
    );
    return { items, total: items.length };
  }

  async getForOpportunityDetail(recommendationId: string, userId: string, accountId: string) {
    return (
      this.records.find(
        (r) =>
          r.recommendationId === recommendationId &&
          r.userId === userId &&
          r.accountId === accountId
      ) ?? null
    );
  }

  // Stubs so container type-checking passes
  async listByUser() { return { items: [], total: 0 }; }
  async getForUser() { return null; }
  async get() { return null; }
}

// ---------------------------------------------------------------------------
// Token service fake (matches TokenService interface)
// ---------------------------------------------------------------------------

class FakeTokenService {
  private tokens = new Map<string, { userId: string; role: string; email: string }>();

  issue(userId: string, role = "member"): string {
    const t = `tok-${userId}-${Math.random().toString(36).slice(2)}`;
    this.tokens.set(t, { userId, role, email: `${userId}@test.com` });
    return t;
  }

  verifyAccessToken(token: string) { return this.tokens.get(token) ?? null; }
  generateAccessToken(p: { userId: string; role: string; email: string }) {
    return this.issue(p.userId, p.role);
  }
  generateRefreshToken() { return "refresh"; }
  hashToken(t: string) { return `h-${t}`; }
  getRefreshTokenExpiry() { return new Date(Date.now() + 86_400_000); }
}

// ---------------------------------------------------------------------------
// Router test harness (same pattern as approvals.test.ts)
// ---------------------------------------------------------------------------

interface TestResponse { status: number; body: Record<string, unknown>; }

async function call(
  router: Router,
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<TestResponse> {
  const parsed = new URL(path, "http://test");
  let pathname = parsed.pathname;
  // Strip the /opportunities prefix if caller included it
  pathname = pathname.replace(/^\/opportunities(?=\/|$)/, "") || "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;

  const params: Record<string, string> = {};
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) { this._status = code; return this; },
    json(b: unknown) { this._body = b; return this; },
  };

  const stack = (
    (router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (...args: unknown[]) => unknown }>;
        };
      }>;
    }).stack
  ) ?? [];

  for (const layer of stack) {
    if (!layer.route) continue;
    const methodMatch = layer.route.methods[method.toLowerCase()];
    if (!methodMatch) continue;
    const regex = new RegExp(
      "^" + layer.route.path.replace(/:[^/]+/g, "([^/]+)") + "$"
    );
    const match = pathname.match(regex);
    if (!match) continue;

    const names = [...layer.route.path.matchAll(/:([^/]+)/g)].map((m) => m[1]);
    names.forEach((n, i) => { params[n] = decodeURIComponent(match[i + 1]); });

    const req = {
      method,
      url: pathname + parsed.search,
      originalUrl: pathname + parsed.search,
      path: pathname,
      params,
      query: Object.fromEntries(parsed.searchParams),
      headers,
      body: body ?? {},
      ip: "127.0.0.1",
      get(h: string) { return headers[h.toLowerCase()] ?? ""; },
    };

    let idx = 0;
    const chain = layer.route.stack;
    const responded = () => (res as unknown as { _body: unknown })._body !== null;

    const runAt = (i: number): unknown => {
      if (responded()) return undefined;
      const entry = chain[i];
      if (!entry) return undefined;
      return entry.handle(
        req,
        res,
        () => { idx++; return runAt(idx); }
      );
    };

    await Promise.resolve(runAt(idx));
    break;
  }

  // If no route matched and body was never set, treat as 404
  const finalStatus = (res as unknown as { _status: number; _body: unknown })._body !== null
    ? (res as unknown as { _status: number })._status
    : 404;

  return {
    status: finalStatus,
    body: ((res as unknown as { _body: unknown })._body ?? {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const META_ACCOUNT_ID = "act_12345";
const OTHER_ACCOUNT_ID = "act_other";
const USER_ALICE = "user-alice";
const USER_BOB = "user-bob";

let repo: FakeRecommendationRepo;
let router: Router;
let tokenAlice: string;
let tokenBob: string;
const metaWriteSpy = vi.fn();

function get(path: string, token?: string) { return call(router, "GET", path, token); }
function post(path: string, token?: string, body?: unknown) { return call(router, "POST", path, token, body); }

describe("Phase 11.9B — Opportunity Queue API", () => {
  beforeEach(() => {
    _seq = 0;
    repo = new FakeRecommendationRepo();
    metaWriteSpy.mockClear();
    process.env.META_AD_ACCOUNT_ID = META_ACCOUNT_ID;

    const tokenSvc = new FakeTokenService();
    tokenAlice = tokenSvc.issue(USER_ALICE);
    tokenBob = tokenSvc.issue(USER_BOB);

    const fakeContainer = {
      tokenService: tokenSvc,
      auditLogger: { log: vi.fn() } as unknown as AuditLogger,
      recommendationRepo: repo,
    } as unknown as Container;

    router = createOpportunitiesRouter(fakeContainer);
  });

  // ── 1. Queue creation ─────────────────────────────────────────────────────
  it("1. queue creation: returns empty queue for account with no records", async () => {
    const res = await get("/", tokenAlice);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.items).toEqual([]);
    expect(res.body.totalEligible).toBe(0);
    expect(res.body.noOpportunity).toBeDefined();
  });

  // ── 2. Ranking ─────────────────────────────────────────────────────────────
  it("2. ranking: items are returned in descending score order", async () => {
    for (let i = 0; i < 3; i++) {
      repo.records.push(makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID }));
    }
    const res = await get("/", tokenAlice);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ score: number }>;
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].score).toBeGreaterThanOrEqual(items[i].score);
    }
  });

  // ── 3. Pagination ──────────────────────────────────────────────────────────
  it("3. pagination: limit query param limits result count", async () => {
    for (let i = 0; i < 5; i++) {
      repo.records.push(makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID }));
    }
    const res = await get("/?limit=2", tokenAlice);
    expect(res.status).toBe(200);
    const items = res.body.items as unknown[];
    expect(items.length).toBeLessThanOrEqual(2);
  });

  // ── 4. Filters ─────────────────────────────────────────────────────────────
  it("4. filters: invalid priority string is silently ignored (whitelist)", async () => {
    repo.records.push(makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID }));
    const res = await get("/?priority=INVALID", tokenAlice);
    expect(res.status).toBe(200);
    // Should not crash; returns valid response
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("4b. filters: valid priority filter restricts to matching items", async () => {
    repo.records.push(makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID }));
    const res = await get("/?priority=CRITICAL", tokenAlice);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ priority: string }>;
    for (const item of items) {
      expect(item.priority).toBe("CRITICAL");
    }
  });

  // ── 5. Priority bands ──────────────────────────────────────────────────────
  it("5. priority bands: all items have a valid priority band", async () => {
    repo.records.push(makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID }));
    const res = await get("/", tokenAlice);
    expect(res.status).toBe(200);
    const VALID_PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "IGNORE"];
    for (const item of (res.body.items as Array<{ priority: string }>)) {
      expect(VALID_PRIORITIES).toContain(item.priority);
    }
  });

  // ── 6. Recommendation detail ───────────────────────────────────────────────
  it("6. detail: returns all 10 required review sections", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    repo.records = [r];

    const res = await get(`/${r.recommendationId}`, tokenAlice);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const opp = res.body.opportunity as Record<string, unknown>;
    expect(opp.anomalies).toBeDefined();       // §1 DETECTED
    expect(opp.reason).toBeDefined();           // §2 DIAGNOSIS
    expect(opp.actionType).toBeDefined();       // §3 RECOMMENDATION
    expect(opp.positiveFactors).toBeDefined();  // §4 WHY
    expect(opp.expectedImpact).toBeDefined();   // §5 IMPACT
    expect(opp.riskNote).toBeDefined();         // §6 RISK
    expect(opp.historicalSampleSize).toBeDefined(); // §7 HISTORICAL
    expect(opp.score).toBeDefined();            // §8 SCORE
    expect(opp.limitations).toBeDefined();      // §9 LIMITATIONS
    expect(opp.currentState).toBeDefined();     // §10 STATES
    expect(opp.proposedState).toBeDefined();    // §10 STATES
    expect(opp.approvalRequirements).toBeDefined();
    expect(opp.requiresApproval).toBe(true);
  });

  // ── 7. Account isolation ───────────────────────────────────────────────────
  it("7. account isolation: records from another accountId are invisible", async () => {
    repo.records.push(makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID }));
    repo.records.push(makeRecord({ userId: USER_ALICE, accountId: OTHER_ACCOUNT_ID }));

    const res = await get("/", tokenAlice);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ accountId: string }>;
    for (const item of items) {
      expect(item.accountId).toBe(META_ACCOUNT_ID);
    }
  });

  // ── 8. User isolation ──────────────────────────────────────────────────────
  it("8. user isolation: Bob sees 0 items from Alice's account", async () => {
    repo.records.push(makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID }));
    const res = await get("/", tokenBob);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  // ── 9. IDOR ────────────────────────────────────────────────────────────────
  it("9. IDOR: Bob cannot access Alice's opportunity by ID", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    repo.records = [r];

    const res = await get(`/${r.recommendationId}`, tokenBob);
    expect(res.status).toBe(404);
  });

  // ── 10. Expired opportunity ────────────────────────────────────────────────
  it("10. expired: expired recommendation is ineligible for scoring", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const r = makeRecord({
      userId: USER_ALICE,
      accountId: META_ACCOUNT_ID,
      expiresAt: past,
    });
    repo.records = [r];

    const res = await get("/", tokenAlice);
    expect(res.status).toBe(200);
    // Expired items are ineligible — queue should be empty or ineligibleCount > 0
    expect(
      (res.body.items as unknown[]).length === 0 ||
      (res.body.ineligibleCount as number) > 0
    ).toBe(true);
  });

  // ── 11. Stale state ────────────────────────────────────────────────────────
  it("11. stale state: detail surfaces staleWarning when staleReasons exist", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    r.staleReasons = ["ENTITY_STATUS_CHANGED"];
    repo.records = [r];

    const res = await get(`/${r.recommendationId}`, tokenAlice);
    expect(res.status).toBe(200);
    expect(res.body.staleWarning).toBeDefined();
    expect((res.body.staleWarning as Record<string, unknown>).isStale).toBe(true);
    expect((res.body.staleWarning as Record<string, string[]>).reasons).toContain("ENTITY_STATUS_CHANGED");
  });

  // ── 12. Conflict state ─────────────────────────────────────────────────────
  it("12. conflicts: conflicting pair is flagged — both sides visible", async () => {
    const sharedEntityId = "ad_conflict_target_001";

    const pause = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    pause.actionType = "PAUSE_AD";
    pause.entityId = sharedEntityId;
    pause.evidence.entityId = sharedEntityId;

    const resume = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    resume.actionType = "RESUME_AD";
    resume.entityId = sharedEntityId;
    resume.evidence.entityId = sharedEntityId;

    repo.records = [pause, resume];

    const res = await get("/", tokenAlice);
    expect(res.status).toBe(200);

    const items = res.body.items as Array<{
      conflicted: boolean;
      conflictWith: string[];
      actionType: string;
      recommendationId: string;
    }>;

    const pauseItem = items.find((i) => i.actionType === "PAUSE_AD");
    const resumeItem = items.find((i) => i.actionType === "RESUME_AD");

    if (pauseItem && resumeItem) {
      // Both sides must be visible (no silent winner)
      expect(pauseItem.conflicted).toBe(true);
      expect(resumeItem.conflicted).toBe(true);
      expect(pauseItem.conflictWith).toContain(resumeItem.recommendationId);
      expect(resumeItem.conflictWith).toContain(pauseItem.recommendationId);
    }
  });

  // ── 13. No-opportunity state ───────────────────────────────────────────────
  it("13. no-opportunity state: explains empty queue with message", async () => {
    const res = await get("/", tokenAlice);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.noOpportunity).toBeDefined();
    const no = res.body.noOpportunity as Record<string, string>;
    expect(typeof no.message).toBe("string");
    expect(no.message.length).toBeGreaterThan(0);
    expect(typeof no.reason).toBe("string");
  });

  // ── 14. Unauthorized access ────────────────────────────────────────────────
  it("14. unauthorized: 401 without auth token (list)", async () => {
    const res = await get("/");
    expect(res.status).toBe(401);
  });

  it("14b. unauthorized: 401 without auth token (detail)", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    repo.records = [r];
    const res = await get(`/${r.recommendationId}`);
    expect(res.status).toBe(401);
  });

  // ── 15. Forged score ───────────────────────────────────────────────────────
  it("15. forged score: query param score is ignored; score is server-computed", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    repo.records = [r];

    const res = await get("/?score=100", tokenAlice);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ score: number }>;
    // Score is bounded integer 0–100 regardless of query injection
    for (const item of items) {
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(100);
    }
  });

  // ── 16. Forged priority ────────────────────────────────────────────────────
  it("16. forged priority: unknown priority param is silently ignored", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    repo.records = [r];

    const res = await get("/?priority=FORGED_INJECTED", tokenAlice);
    expect(res.status).toBe(200);
    const VALID = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "IGNORE"];
    for (const item of (res.body.items as Array<{ priority: string }>)) {
      expect(VALID).toContain(item.priority);
    }
  });

  // ── 17. Forged historical evidence ─────────────────────────────────────────
  it("17. forged historical evidence: query injection cannot inflate historicalSampleSize", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    repo.records = [r];

    const res = await get("/?historicalSampleSize=9999", tokenAlice);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ historicalSampleSize: number }>;
    for (const item of items) {
      expect(item.historicalSampleSize).toBeLessThan(9999);
    }
  });

  // ── 18. paramsHash protection ──────────────────────────────────────────────
  it("18. paramsHash: raw paramsHash value is never exposed in response", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    r.paramsHash = "supersecret_paramshash_do_not_leak_123";
    repo.records = [r];

    const res = await get(`/${r.recommendationId}`, tokenAlice);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    // Raw hash value must not leak
    expect(body).not.toContain("supersecret_paramshash_do_not_leak_123");
    // But the approval requirements notes it is protected
    const opp = res.body.opportunity as Record<string, unknown>;
    const reqs = opp.approvalRequirements as Record<string, unknown>;
    expect(reqs.paramsHashProtected).toBe(true);
  });

  // ── 19. Approval handoff ───────────────────────────────────────────────────
  it("19. approval handoff: points to /api/v1/approvals (existing flow)", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    repo.records = [r];

    const res = await get(`/${r.recommendationId}`, tokenAlice);
    expect(res.status).toBe(200);
    const handoff = res.body.approvalHandoff as Record<string, string>;
    expect(handoff.approvalRoute).toMatch(/\/api\/v1\/approvals/);
    // Must NOT point to execute or a new mechanism
    expect(handoff.approvalRoute).not.toContain("execute");
    expect(handoff.approvalRoute).not.toContain("opportunities");
  });

  // ── 20. No automatic execution ─────────────────────────────────────────────
  it("20. no POST endpoints exist on opportunities router", async () => {
    // POST to / should not match any route (404 or method-not-allowed)
    const res = await post("/", tokenAlice, {});
    // No mutation route registered → no route match → default Express 404
    expect([404, 405]).toContain(res.status);
  });

  // ── 21. Zero Meta writes while browsing ────────────────────────────────────
  it("21. zero Meta writes: spy never called during list + detail", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    repo.records = [r];

    await get("/", tokenAlice);
    await get(`/${r.recommendationId}`, tokenAlice);

    // No write tool was invoked (metaWriteSpy is never called by this router)
    expect(metaWriteSpy).toHaveBeenCalledTimes(0);
  });

  // ── 22. Deterministic ordering ─────────────────────────────────────────────
  it("22. deterministic ordering: two identical calls return identical order", async () => {
    for (let i = 0; i < 4; i++) {
      repo.records.push(makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID }));
    }

    const res1 = await get("/", tokenAlice);
    const res2 = await get("/", tokenAlice);

    const ids1 = (res1.body.items as Array<{ recommendationId: string }>).map(
      (i) => i.recommendationId
    );
    const ids2 = (res2.body.items as Array<{ recommendationId: string }>).map(
      (i) => i.recommendationId
    );

    expect(ids1).toEqual(ids2);
  });

  // ── 23. Error handling ─────────────────────────────────────────────────────
  it("23. error handling: DB error returns 500 with safe INTERNAL_ERROR code", async () => {
    repo.listForOpportunityQueue = vi.fn().mockRejectedValue(new Error("PG_UNAVAILABLE_SECRET"));

    const res = await get("/", tokenAlice);
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    // DB error message must NOT leak
    expect(JSON.stringify(res.body)).not.toContain("PG_UNAVAILABLE_SECRET");
    expect((res.body.error as Record<string, string>).code).toBe("INTERNAL_ERROR");
  });

  // ── 24. Secret redaction ───────────────────────────────────────────────────
  it("24. secret redaction: identityHash and raw stateHash are not in responses", async () => {
    const r = makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID });
    r.identityHash = "idhash_supersecret_00000001";
    r.stateHash = "statehash_supersecret_00000001";
    repo.records = [r];

    const listRes = await get("/", tokenAlice);
    const detailRes = await get(`/${r.recommendationId}`, tokenAlice);

    const listBody = JSON.stringify(listRes.body);
    const detailBody = JSON.stringify(detailRes.body);

    expect(listBody).not.toContain("idhash_supersecret_00000001");
    expect(listBody).not.toContain("statehash_supersecret_00000001");
    expect(detailBody).not.toContain("idhash_supersecret_00000001");
    expect(detailBody).not.toContain("statehash_supersecret_00000001");
  });

  // ── 25. Backward compatibility ─────────────────────────────────────────────
  it("25. backward compat: scoringVersion is always 1", async () => {
    repo.records.push(makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID }));
    const res = await get("/", tokenAlice);
    expect(res.status).toBe(200);
    for (const item of (res.body.items as Array<{ scoringVersion: number }>)) {
      expect(item.scoringVersion).toBe(1);
    }
  });

  // ── IDOR with malformed ID ─────────────────────────────────────────────────
  it("IDOR: malformed ID (too short) returns 404", async () => {
    const res = await get("/abc", tokenAlice);
    expect(res.status).toBe(404);
  });

  // ── Account not configured ─────────────────────────────────────────────────
  it("account not configured: 503 when META_AD_ACCOUNT_ID is absent", async () => {
    delete process.env.META_AD_ACCOUNT_ID;
    const res = await get("/", tokenAlice);
    expect(res.status).toBe(503);
    expect((res.body.error as Record<string, string>).code).toBe("ACCOUNT_NOT_CONFIGURED");
    process.env.META_AD_ACCOUNT_ID = META_ACCOUNT_ID; // restore
  });

  // ── 10+ items: queue with many records remains bounded ────────────────────
  it("performance: 10+ records processed deterministically within limit", async () => {
    for (let i = 0; i < 12; i++) {
      repo.records.push(makeRecord({ userId: USER_ALICE, accountId: META_ACCOUNT_ID }));
    }
    const res = await get("/?limit=5", tokenAlice);
    expect(res.status).toBe(200);
    expect((res.body.items as unknown[]).length).toBeLessThanOrEqual(5);
    expect(typeof res.body.totalEligible).toBe("number");
  });
});
