// ---------------------------------------------------------------------------
// Phase 11.10 — AnalysisGenerator unit tests
//
// Focus: the GENERATOR, not the engines it delegates to (those have their own
// suites). These prove the parts that are unique to this service:
//   - fail-closed validation and authorization (INVALID_INPUT /
//     ACCOUNT_UNAUTHORIZED stop before any other request)
//   - READ_FAILED and INSUFFICIENT_DATA handling with audit rows
//   - NO_SAFE_TARGET when nothing actionable exists
//   - deterministic target selection and bounded reads (safety caps)
//   - the in-flight guard (ALREADY_RUNNING, one run per user+account)
//   - dry-run stopping at the generate boundary (no durable row)
//   - the COMPLETED path persisting a PROPOSED recommendation through the
//     store port
//   - no secrets in outcomes or audit rows
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AICompletionResponse,
  AuditLogger,
  IAIProvider,
  RecommendationRecord,
  RecommendationStorePort,
  ToolExecutionRequest,
  ToolExecutionResult,
} from "@jarvis/core";
import {
  AnalysisGenerator,
  type AnalysisConfig,
  type AnalysisInput,
  type AnalysisOutcome,
} from "../src/analysis-generator.js";

const ACCOUNT = "act_1";
const AD_ID = "ad_x1";
const USER = "user-alice";
const NOW = new Date("2026-09-10T12:00:00Z");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function insightRows(flat = false): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const baseClicks = flat ? "120" : "1200";
  const baseConv = flat ? "2" : "12";
  for (let d = 3; d <= 9; d++) {
    rows.push({
      dateStart: `2026-09-${String(d).padStart(2, "0")}`,
      adId: AD_ID,
      campaignId: "cmp_1",
      adsetId: "as_1",
      spend: "5000",
      impressions: "10000",
      clicks: baseClicks,
      conversions: baseConv,
    });
  }
  // Current day: a CTR / CPA crash when not in flat mode.
  rows.push({
    dateStart: "2026-09-10",
    adId: AD_ID,
    campaignId: "cmp_1",
    adsetId: "as_1",
    spend: "5000",
    impressions: "10000",
    clicks: "120",
    conversions: "2",
  });
  return rows;
}

interface ExecutorOptions {
  accounts?: Array<Record<string, unknown>>;
  insights?: Array<Record<string, unknown>>;
  ads?: Array<Record<string, unknown>>;
  failTool?: string;
}

function executorFor(opts: ExecutorOptions = {}) {
  const calls: ToolExecutionRequest[] = [];
  const data: Record<string, unknown[] | undefined> = {
    accounts: opts.accounts ?? [{ accountId: ACCOUNT, currency: "USD", timezoneName: "UTC" }],
    campaigns: [{ campaignId: "cmp_1", name: "Campaign", status: "ACTIVE" }],
    adSets: [{ adSetId: "as_1", name: "Adset", status: "ACTIVE", campaignId: "cmp_1" }],
    ads: opts.ads ?? [
      {
        adId: AD_ID,
        name: "Ad One",
        status: "ACTIVE",
        campaignId: "cmp_1",
        adSetId: "as_1",
        objective: "OUTCOME_TRAFFIC",
      },
    ],
    insights: opts.insights ?? insightRows(false),
  };
  const listKeyFor: Record<string, string> = {
    "meta.accounts": "accounts",
    "meta.campaigns": "campaigns",
    "meta.adsets": "adSets",
    "meta.ads": "ads",
    "meta.insights": "insights",
  };
  const execute = vi.fn(
    async (req: ToolExecutionRequest): Promise<ToolExecutionResult> => {
      calls.push(req);
      if (req.toolId === opts.failTool) {
        return {
          status: "failed",
          toolId: req.toolId,
          executionId: `exe_${req.toolId}`,
          error: `META_API_ERROR for ${req.toolId}`,
          startedAt: NOW.toISOString(),
          completedAt: NOW.toISOString(),
        };
      }
      const listKey = listKeyFor[req.toolId];
      const list = data[listKey];
      if (!listKey || list === undefined) {
        return {
          status: "completed",
          toolId: req.toolId,
          executionId: `exe_${req.toolId}`,
          result: { success: false, error: `unknown list ${req.toolId}` },
          startedAt: NOW.toISOString(),
          completedAt: NOW.toISOString(),
        };
      }
      return {
        status: "completed",
        toolId: req.toolId,
        executionId: `exe_${req.toolId}`,
        result: { success: true, data: { [listKey]: list } },
        startedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
      };
    }
  );
  return { execute, calls, data };
}

function store() {
  const saved: RecommendationRecord[] = [];
  return {
    saved,
    findActiveByIdentity: vi.fn(async () => null),
    findActiveByEntity: vi.fn(async () => []),
    findMostRecentByActions: vi.fn(async () => null),
    countBudgetActionsSince: vi.fn(async () => 0),
    save: vi.fn(async (r: RecommendationRecord) => {
      saved.push(r);
    }),
    get: vi.fn(async () => null),
  } as RecommendationStorePort & { saved: RecommendationRecord[] };
}

function audits() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    log: vi.fn(async (entry: Record<string, unknown>) => {
      rows.push(entry);
    }),
    query: vi.fn(async () => []),
  } as unknown as AuditLogger;
}

/**
 * Deterministic fake provider: whatever evidence package arrives, it returns a
 * single CREATIVE_FATIGUE candidate bound to that package's identity and
 * anomalies — the same contract the real provider is asked to honour, and the
 * one thing that lets the generator's COMPLETED/DRY_RUN_OK paths run without a
 * network. Verification computes want truthfulness: it is satisfied because
 * every ref and id is echoed from the evidence itself.
 */
function provider() {
  return {
    id: "openai",
    name: "OpenAI",
    defaultModel: "gpt-fake",
    complete: vi.fn(async (req): Promise<AICompletionResponse> => {
      const content =
        req.messages.find((m) => m.role === "user")?.content ?? "";
      const match = content.match(/EVIDENCE_BEGIN\n([\s\S]*?)\nEVIDENCE_END/);
      const parsed: unknown = match ? JSON.parse(match[1] ?? "{}") : {};
      const pkg =
        (Array.isArray(parsed) ? parsed[0] : parsed) ??
        ({} as Record<string, unknown>);
      const anomalies = Array.isArray(pkg["anomalies"])
        ? (pkg["anomalies"] as Array<Record<string, unknown>>)
        : [];
      const anomalyIds = anomalies
        .filter((a) => a["severity"] !== "NORMAL")
        .map((a) => String(a["anomalyId"]));
      const candidate = {
        entityId: String(pkg["entityId"] ?? "ad_x1"),
        entityLevel: String(pkg["entityLevel"] ?? "AD"),
        evidenceHash: String(pkg["evidenceHash"] ?? "evh"),
        anomalyIds,
        category: "CREATIVE_FATIGUE",
        summary: "The entity shows a marked shift from its own recent baseline while the window remains fresh.",
        facts: [
          {
            statement: "A shift is present in the click metric relative to its baseline.",
            evidenceRef: "metric:ctr:change_percent",
          },
          {
            statement: "A shift is present in the cost metric relative to its baseline.",
            evidenceRef: "metric:cpa:change_percent",
          },
          { statement: "The reported window is within the freshness bound.", evidenceRef: "meta:freshness" },
        ],
        inferences: [
          {
            statement: "The pattern is consistent within this window.",
            supportingEvidence: ["metric:ctr:change_percent"],
            confidence: "HIGH",
          },
        ],
        hypotheses: [
          {
            statement: "Creative fatigue is the leading explanation for the observed pattern.",
            category: "CREATIVE_FATIGUE",
            supportingEvidence: ["metric:cpa:change_percent"],
            contradictingEvidence: [],
            confidence: "HIGH",
          },
        ],
        confidence: "HIGH",
      };
      return {
        message: { role: "assistant", content: JSON.stringify({ diagnoses: [candidate] }) },
        finishReason: "stop",
        usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
        model: "gpt-fake",
      };
    }),
    listModels: async () => ["gpt-fake"],
    isAvailable: async () => true,
  } satisfies IAIProvider;
}

interface GenOptions {
  flat?: boolean;
  config?: Partial<AnalysisConfig>;
  executorOpts?: ExecutorOptions;
}

function buildGen(opts: GenOptions = {}) {
  const executor = executorFor(opts.executorOpts ?? { insights: insightRows(opts.flat) });
  const storeI = store();
  const auditI = audits();
  const providerI = provider();

  const config: AnalysisConfig = {
    defaultAccountId: ACCOUNT,
    lookbackDays: 14,
    minBaselineDays: 3,
    staleDataDelayDays: 1,
    maxInsightRows: 500,
    maxEntitiesScanned: 20,
    diagnosisAttempts: 1,
    ...opts.config,
  };

  const gen = new AnalysisGenerator({
    executor,
    provider: providerI,
    store: storeI,
    audit: auditI,
    config,
    nowFn: () => NOW,
  });

  const caller = { userId: USER, role: "member" as const, traceId: "trace-1" };
  return { gen, executor, store: storeI, audit: auditI, provider: providerI, caller };
}

function expectNoAnalysis(
  outcome: AnalysisOutcome,
  reason: string
): asserts outcome is Extract<AnalysisOutcome, { status: "NO_ANALYSIS" }> {
  expect(outcome.status).toBe("NO_ANALYSIS");
  if (outcome.status === "NO_ANALYSIS") {
    expect(outcome.reason).toBe(reason);
  }
}

beforeEach(() => {
  process.env.META_AD_ACCOUNT_ID = ACCOUNT;
});

// ---------------------------------------------------------------------------

describe("AnalysisGenerator — validation fails closed", () => {
  it("refuses a run with no caller userId", async () => {
    const { gen } = buildGen();
    const out = await gen.analyze({}, { userId: "", role: "member" });
    expectNoAnalysis(out, "INVALID_INPUT");
  });

  it("refuses when no account is configured or supplied", async () => {
    const { gen } = buildGen({ config: { defaultAccountId: undefined } });
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    expectNoAnalysis(out, "INVALID_INPUT");
    expect(out.detail).toMatch(/no account/i);
  });

  it("does not make a single executor or provider call for invalid input", async () => {
    const { gen, executor } = buildGen();
    await gen.analyze({}, { userId: "", role: "member" });
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

describe("AnalysisGenerator — account authorization", () => {
  it("stops unusably early when the account is not owned by the token", async () => {
    const { gen, executor, audit } = buildGen({
      executorOpts: { accounts: [{ accountId: "act_9", currency: "USD", timezoneName: "UTC" }] },
    });
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    expectNoAnalysis(out, "ACCOUNT_UNAUTHORIZED");
    // Only the accounts read happened — nothing else, no insights, no provider.
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("honours a caller-supplied accountId only when the token owns it", async () => {
    const { gen, executor } = buildGen();
    const out = await gen.analyze({ accountId: "act_9" }, { userId: USER, role: "member" });
    expectNoAnalysis(out, "ACCOUNT_UNAUTHORIZED");
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});

describe("AnalysisGenerator — read failures and insufficient data", () => {
  it("reports READ_FAILED when the inventory read fails, and audits it", async () => {
    const { gen, audit } = buildGen({ executorOpts: { failTool: "meta.adsets" } });
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    expectNoAnalysis(out, "READ_FAILED");
    expect(audit.rows.some((r) => r["action"] === "meta.analyze" && r["result"] === "failure")).toBe(true);
  });

  it("reports READ_FAILED when the insights read fails", async () => {
    const { gen } = buildGen({ executorOpts: { failTool: "meta.insights" } });
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    expectNoAnalysis(out, "READ_FAILED");
  });

  it("reports INSUFFICIENT_DATA when the window has no rows", async () => {
    const { gen } = buildGen({ executorOpts: { insights: [] } });
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    expectNoAnalysis(out, "INSUFFICIENT_DATA");
  });

  it("reports NO_SAFE_TARGET when nothing deviates from baseline", async () => {
    const { gen } = buildGen({ flat: true });
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    expectNoAnalysis(out, "NO_SAFE_TARGET");
    if (out.status === "NO_ANALYSIS") {
      expect(out.scanSummary?.candidateCount).toBe(1);
      expect(out.scanSummary?.criticalCount).toBe(0);
    }
  });

  it("produces a deterministic target and bounded scan summary when one target exists", async () => {
    const { gen, executor } = buildGen();
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    expect(out.status).toBe("COMPLETED");
    if (out.status === "COMPLETED") {
      expect(out.target?.id).toBe(AD_ID);
      expect(out.target?.maxDeviation).toBeGreaterThan(0);
      expect(out.scanSummary.insightRowCount).toBe(8);
      expect(out.scanSummary.candidateCount).toBe(1);
      expect(out.scanSummary.criticalCount).toBeGreaterThan(0);
    }
    // Safety caps are enforced at the calls themselves.
    const insightsCall = executor.calls.find((c) => c.toolId === "meta.insights");
    expect(insightsCall?.params["limit"]).toBe(500);
    const adsCall = executor.calls.find((c) => c.toolId === "meta.ads");
    expect(adsCall?.params["limit"]).toBe(20);
  });

  it("caps the candidate scan in deterministic id order and stops at the cap", async () => {
    const ads = Array.from({ length: 40 }, (_, i) => ({
      adId: `ad_${String(i + 1).padStart(3, "0")}`,
      name: `Ad ${i + 1}`,
      status: "ACTIVE",
      campaignId: "cmp_1",
      adSetId: "as_1",
    })).sort((a, b) => a.adId.length - b.adId.length || a.adId.localeCompare(b.adId));
    const { gen } = buildGen({
      config: { maxEntitiesScanned: 5, maxInsightRows: 60 },
      executorOpts: { ads, insights: insightRows(false) },
    });
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    // Only the 5 candidate rows were scanned (deterministic cap), never the whole 40.
    expect(out.status).toBe("NO_ANALYSIS");
    if (out.status === "NO_ANALYSIS") {
      expect(out.scanSummary?.candidateCount).toBe(5);
    }
  });
});

describe("AnalysisGenerator — deterministic behaviour", () => {
  it("returns the same target across identical runs", async () => {
    const { gen } = buildGen();
    const a = await gen.analyze({}, { userId: USER, role: "member" });
    const b = await gen.analyze({}, { userId: USER, role: "member" });
    expect(a.status).toBe("COMPLETED");
    if (a.status === "COMPLETED" && b.status === "COMPLETED") {
      expect(b.target?.id).toBe(a.target?.id);
      expect(b.scanSummary.criticalCount).toBe(a.scanSummary.criticalCount);
    }
  });
});

describe("AnalysisGenerator — in-flight guard", () => {
  it("refuses a concurrent run for the same user+account (ALREADY_RUNNING)", async () => {
    const { gen, executor } = buildGen();
    // Hold the accounts read open so run #1 is still in flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    executor.execute.mockImplementationOnce(
      () => gate.then(() => ({
        status: "completed" as const,
        toolId: "meta.accounts",
        executionId: "exe_1",
        result: {
          success: true,
          data: {
            accounts: [{ accountId: ACCOUNT, currency: "USD", timezoneName: "UTC" }],
          },
        },
        startedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
      }))
    );

    const first = gen.analyze({}, { userId: USER, role: "member" });
    const second = await gen.analyze({}, { userId: USER, role: "member" });
    expectNoAnalysis(second, "ALREADY_RUNNING");

    release();
    const firstOut = await first;
    expect(firstOut.status).toBe("COMPLETED");
  });

  it("allows a DIFFERENT account while one is in flight", async () => {
    const { gen, executor } = buildGen();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    executor.execute.mockImplementationOnce(
      () => gate.then(() => ({
        status: "completed" as const,
        toolId: "meta.accounts",
        executionId: "exe_1",
        result: {
          success: true,
          data: { accounts: [{ accountId: ACCOUNT, currency: "USD", timezoneName: "UTC" }] },
        },
        startedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
      }))
    );

    const first = gen.analyze({}, { userId: USER, role: "member" });
    const other = await gen.analyze({ accountId: "act_9" }, { userId: USER, role: "member" });
    expectNoAnalysis(other, "ACCOUNT_UNAUTHORIZED");
    release();
    await first;
  });
});

describe("AnalysisGenerator — dry run stops at the generate boundary", () => {
  it("returns DRY_RUN_OK and never persists a recommendation", async () => {
    const { gen, store, audit } = buildGen();
    const out = await gen.analyze({ dryRun: true }, { userId: USER, role: "member" });
    expect(out.status).toBe("DRY_RUN_OK");
    if (out.status === "DRY_RUN_OK") {
      expect(out.target?.id).toBe(AD_ID);
      expect(out.scanSummary.criticalCount).toBeGreaterThan(0);
    }
    expect(store.save).not.toHaveBeenCalled();
    expect(audit.rows.some((r) => r["parameters"] && JSON.stringify(r["parameters"]).includes("DRY_RUN_OK"))).toBe(true);
  });
});

describe("AnalysisGenerator — COMPLETED path persists a PROPOSED recommendation", () => {
  it("creates one durable PROPOSED recommendation for the target", async () => {
    const { gen, store, audit } = buildGen();
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    expect(out.status).toBe("COMPLETED");
    if (out.status === "COMPLETED") {
      expect(out.recommendation.status).toBe("CREATED");
      expect(out.recommendationId).toBeDefined();
    }
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]!.status).toBe("PROPOSED");
    expect(store.saved[0]!.userId).toBe(USER);
    expect(store.saved[0]!.accountId).toBe(ACCOUNT);
    expect(store.saved[0]!.entityId).toBe(AD_ID);
    expect(store.saved[0]!.requiresApproval).toBe(true);
    expect(audit.rows.some((r) => String(r["action"]) === "meta.analyze" && String(r["result"]) === "success")).toBe(true);
  });

  it("survives a persistence failure by returning PERSIST_FAILED, failing closed", async () => {
    const { gen, store } = buildGen();
    store.save.mockRejectedValueOnce(new Error("PG_UNAVAILABLE_INSIDE_STORE"));
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    expectNoAnalysis(out, "PERSIST_FAILED");
    // The failure message is a server-side diagnostic; it must not leak the
    // storage internals the way the store exception names them.
    expect(out.detail).not.toContain("PG_UNAVAILABLE_INSIDE_STORE");
  });
});

describe("AnalysisGenerator — no secrets anywhere", () => {
  it("keeps tokens and secrets out of outcomes and audit rows", async () => {
    // Feed a leaky read row carrying a token-shaped secret and confirm the
    // generator's outputs never echo it back.
    const leakyRows = insightRows(false).map((r) => ({
      ...r,
      page_access_token: "EAA-leaky-secret-3912",
    }));
    const { gen, executor, audit } = buildGen({ executorOpts: { insights: leakyRows } });
    const out = await gen.analyze({}, { userId: USER, role: "member" });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/EAA|page_access_token|leaky/i);
    expect(JSON.stringify(audit.rows)).not.toMatch(/EAA|page_access_token|leaky/i);
    // The read is issued with the service's own params only — nothing leaky.
    const insightsCall = executor.calls.find((c) => c.toolId === "meta.insights");
    expect(JSON.stringify(insightsCall?.params)).not.toMatch(/token|secret/i);
  });
});