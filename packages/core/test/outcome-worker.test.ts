import { describe, it, expect, beforeEach, vi } from "vitest";
import { OutcomeWorker } from "../src/outcome-worker.js";
import {
  type OutcomeRecord,
  type OutcomeStorePort,
  type OutcomeRevision,
  type MeasurementState,
  type OutcomeEnum,
  type LearningHistoryRecord,
} from "../src/types/outcome.js";
import type { IToolExecutor, ToolResult } from "../src/types/recommendation.js";
import { calculateCanonicalKPIs } from "../src/kpi-engine.js";
import { captureBaselineSnapshot } from "../src/outcome-engine.js";
const now = new Date();
const msPerDay = 24 * 60 * 60 * 1000;

// Helper to get formatted relative dates
const relativeDateStr = (daysAgo: number) => {
  const d = new Date(now.getTime() - daysAgo * msPerDay);
  return d.toISOString().split("T")[0]!;
};

// Let executedAt be 4 days ago for pending tests
const EXECUTED_AT_LONG_AGO = new Date(now.getTime() - 4 * msPerDay).toISOString();
// Let executedAt be 9 days ago for ready/finalized tests
const EXECUTED_AT_READY = new Date(now.getTime() - 9 * msPerDay).toISOString();

const day1 = relativeDateStr(3);
const day2 = relativeDateStr(2);
const day3 = relativeDateStr(1);

const readyDay1 = relativeDateStr(8);
const readyDay2 = relativeDateStr(7);
const readyDay3 = relativeDateStr(6);

class MockExecutor implements IToolExecutor {
  public execute = vi.fn().mockImplementation(async (args: { params: Record<string, any> }): Promise<ToolResult> => {
    const insights: any[] = [];
    const start = new Date(args.params.startDate);
    const end = new Date(args.params.endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split("T")[0]!;
      insights.push({
        spend: "100",
        impressions: "10000",
        clicks: "500", // high CTR/CPC improvement
        reach: "8000",
        conversions: "20", // high conversions -> CPA improves
        roas: "4.5",
        dateStart: dateStr,
        dateStop: dateStr,
        campaignId: "cmp_123",
        adsetId: "cmp_123",
        adId: "cmp_123",
      });
    }

    return {
      status: "completed",
      result: {
        success: true,
        data: {
          insights,
        },
      },
      auditLogId: "audit-123",
    };
  });
}

class MockOutcomeRepo implements OutcomeStorePort {
  public outcomes: OutcomeRecord[] = [];
  public revisions: OutcomeRevision[] = [];

  public create = vi.fn().mockImplementation(async (record: OutcomeRecord) => {
    this.outcomes.push(record);
  });

  public get = vi.fn().mockImplementation(async (id: string, userId: string) => {
    return this.outcomes.find((o) => o.outcomeId === id && o.userId === userId) ?? null;
  });

  public getByRecommendation = vi.fn().mockImplementation(async (recId: string, userId: string) => {
    return this.outcomes.find((o) => o.recommendationId === recId && o.userId === userId) ?? null;
  });

  public updateMeasurementState = vi.fn().mockImplementation(
    async (
      id: string,
      userId: string,
      state: MeasurementState,
      patch?: Partial<OutcomeRecord>
    ) => {
      const idx = this.outcomes.findIndex((o) => o.outcomeId === id && o.userId === userId);
      if (idx === -1) return false;
      this.outcomes[idx] = {
        ...this.outcomes[idx]!,
        measurementState: state,
        ...patch,
      };
      return true;
    }
  );

  public finalize = vi.fn().mockImplementation(
    async (id: string, userId: string, outcome: OutcomeEnum, confidence: number, measuredAt: string) => {
      const idx = this.outcomes.findIndex((o) => o.outcomeId === id && o.userId === userId);
      if (idx === -1 || this.outcomes[idx]!.isFinal) return false;
      this.outcomes[idx] = {
        ...this.outcomes[idx]!,
        outcome,
        confidence,
        measuredAt,
        measurementState: "FINALIZED",
        isFinal: true,
      };
      return true;
    }
  );

  public listByAccount = vi.fn().mockImplementation(async (accId: string, userId: string) => {
    const items = this.outcomes.filter((o) => o.accountId === accId && o.userId === userId);
    return { items, total: items.length };
  });

  public createRevision = vi.fn().mockImplementation(async (revision: OutcomeRevision) => {
    this.revisions.push(revision);
  });

  public getRevisions = vi.fn().mockImplementation(async (id: string, userId: string) => {
    const items = this.revisions.filter((r) => r.outcomeId === id);
    return { items, total: items.length };
  });

  public getLearningHistory = vi.fn().mockImplementation(async (accId: string, userId: string) => {
    return this.outcomes
      .filter((o) => o.accountId === accId && o.userId === userId && o.measurementState === "FINALIZED")
      .map((o) => ({
        actionType: o.actionType,
        outcome: o.outcome!,
        confidence: o.confidence!,
        measuredAt: o.measuredAt!,
        primaryMetric: o.primaryMetric,
      }));
  });

  public findDueOutcomes = vi.fn().mockImplementation(async () => {
    return this.outcomes.filter((o) => !o.isFinal);
  });

  public claimOutcome = vi.fn().mockImplementation(async (id: string) => {
    const record = this.outcomes.find((o) => o.outcomeId === id);
    if (!record || record.measurementState === "COLLECTING") return false;
    record.measurementState = "COLLECTING";
    return true;
  });

  public releaseOutcome = vi.fn().mockImplementation(async (id: string, state: MeasurementState) => {
    const record = this.outcomes.find((o) => o.outcomeId === id);
    if (!record) return false;
    record.measurementState = state;
    return true;
  });

  public findRecentlyFinalized = vi.fn().mockImplementation(async () => {
    return this.outcomes.filter((o) => o.measurementState === "FINALIZED");
  });
}

function makeOutcomeRecord(overrides?: Partial<OutcomeRecord>): OutcomeRecord {
  const kpis = calculateCanonicalKPIs({
    spend: 200,
    impressions: 20000,
    clicks: 400,
    reach: 16000,
    conversions: 10,
    revenue: 500,
  });
  const baseline = captureBaselineSnapshot({
    accountId: "act_test",
    level: "CAMPAIGN",
    entityId: "cmp_123",
    currency: "USD",
    timezone: "UTC",
    window: { type: "last_7_days", startDate: "2026-08-08", endDate: "2026-08-14" },
    recordCount: 7,
    kpis,
    quality: "COMPLETE",
    fetchedAt: EXECUTED_AT_LONG_AGO,
    source: "meta-graph",
  }, { fetchedAt: EXECUTED_AT_LONG_AGO });

  return {
    outcomeId: "outcome_123",
    recommendationId: "rec_123",
    executionId: "exec_123",
    accountId: "act_test",
    entityType: "CAMPAIGN",
    entityId: "cmp_123",
    actionType: "PAUSE_CAMPAIGN",
    objective: "OUTCOME_SALES",
    primaryMetric: "CPA",
    baseline,
    measurement: null,
    comparison: null,
    outcome: null,
    confidence: null,
    dataQuality: null,
    attributionStatus: "ATTRIBUTION_PENDING",
    confounders: [],
    measurementWindow: {
      stabilizationMs: 24 * 60 * 60 * 1000,
      measurementMs: 7 * 24 * 60 * 60 * 1000,
      attributionWindowMs: 7 * 24 * 60 * 60 * 1000,
      minimumDataDays: 3,
      minimumSpend: 10,
      minimumConversions: 3,
      maxDataAgeMs: 48 * 60 * 60 * 1000,
    },
    measurementState: "SCHEDULED",
    isFinal: false,
    measuredAt: null,
    createdAt: EXECUTED_AT_LONG_AGO,
    userId: "user_test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 11.7B — OutcomeWorker Unit Tests", () => {
  let executor: MockExecutor;
  let repo: MockOutcomeRepo;
  let worker: OutcomeWorker;

  beforeEach(() => {
    executor = new MockExecutor();
    repo = new MockOutcomeRepo();
    worker = new OutcomeWorker(executor, repo);
  });

  // 1. Due measurement selection
  it("1 — due measurement selection (skips wait, processes ready)", async () => {
    const waiting = makeOutcomeRecord({
      outcomeId: "waiting_123",
      baseline: {
        ...makeOutcomeRecord().baseline,
        fetchedAt: new Date().toISOString(), // executing now -> WAITING_FOR_DATA
      },
      measurementState: "WAITING_FOR_DATA",
    });

    const ready = makeOutcomeRecord({
      outcomeId: "ready_123",
      baseline: {
        ...makeOutcomeRecord().baseline,
        fetchedAt: "2026-08-15T00:00:00.000Z", // stabilization window has passed -> READY
      },
      measurementState: "READY",
    });

    repo.outcomes = [waiting, ready];

    await worker.processDue();

    // waiting must still be WAITING_FOR_DATA
    const waitingRes = repo.outcomes.find((o) => o.outcomeId === "waiting_123");
    expect(waitingRes!.measurementState).toBe("WAITING_FOR_DATA");

    // ready must have been processed/finalized
    const readyRes = repo.outcomes.find((o) => o.outcomeId === "ready_123");
    expect(readyRes!.measurementState).toBe("FINALIZED");
  });

  // 2. Worker processing
  it("2 — worker processing matches canonical engine expectations", async () => {
    const ready = makeOutcomeRecord({
      measurementState: "READY",
    });
    repo.outcomes = [ready];

    const res = await worker.processDue();
    expect(res.processedCount).toBe(1);
    expect(res.finalizedCount).toBe(1);
    expect(res.failedCount).toBe(0);
    expect(res.errors).toHaveLength(0);
  });

  // 3. Concurrent workers (leasing)
  it("3 — concurrent workers are prevented from processing the same record", async () => {
    const ready = makeOutcomeRecord({ outcomeId: "ready_123", measurementState: "READY" });
    repo.outcomes = [ready];

    // Worker 1 claims it
    const claimed1 = await repo.claimOutcome("ready_123", new Date().toISOString());
    expect(claimed1).toBe(true);

    // Worker 2 attempts to claim it but fails
    const claimed2 = await repo.claimOutcome("ready_123", new Date().toISOString());
    expect(claimed2).toBe(false);
  });

  // 4. Idempotency
  it("4 — repeated worker execution is fully idempotent", async () => {
    const ready = makeOutcomeRecord({ measurementState: "READY" });
    repo.outcomes = [ready];

    // First run processes and finalizes
    const res1 = await worker.processDue();
    expect(res1.finalizedCount).toBe(1);

    // Second run sees it's already finalized and does nothing
    const res2 = await worker.processDue();
    expect(res2.processedCount).toBe(0);
    expect(res2.finalizedCount).toBe(0);
  });

  // 5. Successful finalization
  it("5 — successful finalization when sufficiency requirements are met", async () => {
    const ready = makeOutcomeRecord({
      baseline: {
        ...makeOutcomeRecord().baseline,
        fetchedAt: EXECUTED_AT_READY,
      },
      measurementState: "READY",
    });
    repo.outcomes = [ready];

    console.log("BEFORE WORKER RUN ready.baseline.fetchedAt:", ready.baseline.fetchedAt);
    console.log("EXECUTED_AT_READY CONST:", EXECUTED_AT_READY);
    await worker.processDue();
    const result = repo.outcomes[0]!;
    console.log("AFTER WORKER RUN result.baseline.fetchedAt:", result.baseline.fetchedAt);
    expect(result.measurementState).toBe("FINALIZED");
    expect(result.outcome).toBe("POSITIVE"); // CPC improvements from mock insights
    expect(result.isFinal).toBe(true);
  });

  // 6. Waiting for data
  it("6 — waiting for data if stabilization window is running", async () => {
    const recent = makeOutcomeRecord({
      baseline: {
        ...makeOutcomeRecord().baseline,
        fetchedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 mins ago
      },
      measurementState: "SCHEDULED",
    });
    repo.outcomes = [recent];

    await worker.processDue();
    expect(repo.outcomes[0]!.measurementState).toBe("WAITING_FOR_DATA");
  });

  // 7. Attribution pending
  it("7 — attribution pending lowers confidence score", async () => {
    const recent = makeOutcomeRecord({
      baseline: {
        ...makeOutcomeRecord().baseline,
        fetchedAt: EXECUTED_AT_LONG_AGO,
      },
      measurementState: "READY",
      measurementWindow: {
        ...makeOutcomeRecord().measurementWindow,
        stabilizationMs: 24 * 60 * 60 * 1000,
        measurementMs: 2 * 24 * 60 * 60 * 1000, // closed after 3 days
        attributionWindowMs: 7 * 24 * 60 * 60 * 1000, // pending until 8 days
        minimumDataDays: 1,
        minimumSpend: 1,
        minimumConversions: 1,
      },
    });
    repo.outcomes = [recent];

    await worker.processDue();
    const result = repo.outcomes[0]!;
    expect(result.measurementState).toBe("FINALIZED");
    expect(result.attributionStatus).toBe("ATTRIBUTION_PENDING");
    expect(result.confidence).toBeLessThan(1.0); // reduced confidence due to ATTRIBUTION_PENDING
  });

  // 8. Provider timeout
  it("8 — provider timeout resets state to READY for retry", async () => {
    executor.execute.mockResolvedValueOnce({
      status: "failed",
      error: "Gateway Timeout",
      auditLogId: "audit-fail",
    });

    const ready = makeOutcomeRecord({ measurementState: "READY" });
    repo.outcomes = [ready];

    const res = await worker.processDue();
    expect(res.processedCount).toBe(0);
    expect(res.failedCount).toBe(1);

    // Record returned to READY state
    expect(repo.outcomes[0]!.measurementState).toBe("READY");
  });

  // 9. Database failure
  it("9 — database failure returns failure result without silent success", async () => {
    repo.finalize.mockRejectedValueOnce(new Error("DB Connection Error"));

    const ready = makeOutcomeRecord({ measurementState: "READY" });
    repo.outcomes = [ready];

    const res = await worker.processDue();
    expect(res.errors).toContain("DB Connection Error");
    expect(res.failedCount).toBe(1);
  });

  // 10. Revision creation
  it("10 — revision creation on verdict change", async () => {
    // Record originally finalized as NEGATIVE
    const finalized = makeOutcomeRecord({
      outcomeId: "outcome_rev",
      baseline: {
        ...makeOutcomeRecord().baseline,
        fetchedAt: EXECUTED_AT_READY,
      },
      measurementState: "FINALIZED",
      outcome: "NEGATIVE" as OutcomeEnum,
      isFinal: true,
      measurementWindow: {
        ...makeOutcomeRecord().measurementWindow,
        measurementMs: 8 * 24 * 60 * 60 * 1000,
        minimumDataDays: 1,
        minimumSpend: 1,
        minimumConversions: 1,
      },
    });
    repo.outcomes = [finalized];

    const t1 = relativeDateStr(3);
    const t2 = relativeDateStr(2);
    const t3 = relativeDateStr(1);

    // Mock new insights showing positive conversions (CPC improvements)
    executor.execute.mockResolvedValueOnce({
      status: "completed",
      result: {
        success: true,
        data: {
          insights: [
            {
              spend: "100",
              impressions: "10000",
              clicks: "500", // high CTR/CPC improvement
              reach: "8000",
              conversions: "20",
              roas: "4.5",
              dateStart: t1,
              dateStop: t1,
              campaignId: "cmp_123",
              adsetId: "cmp_123",
              adId: "cmp_123",
            },
            {
              spend: "100",
              impressions: "10000",
              clicks: "500",
              reach: "8000",
              conversions: "20",
              roas: "4.5",
              dateStart: t2,
              dateStop: t2,
              campaignId: "cmp_123",
              adsetId: "cmp_123",
              adId: "cmp_123",
            },
            {
              spend: "100",
              impressions: "10000",
              clicks: "500",
              reach: "8000",
              conversions: "20",
              roas: "4.5",
              dateStart: t3,
              dateStop: t3,
              campaignId: "cmp_123",
              adsetId: "cmp_123",
              adId: "cmp_123",
            },
          ],
        },
      },
    });

    await worker.processDue();

    // Verdict remains unchanged in OutcomeRecord (immutable)
    expect(finalized.outcome).toBe("NEGATIVE");

    // Revision created showing the updated verdict
    expect(repo.revisions).toHaveLength(1);
    expect(repo.revisions[0]!.outcomeEnum).toBe("POSITIVE");
    expect(repo.revisions[0]!.revisionNumber).toBe(1);
  });

  // 11. Zero LLM / Zero Meta writes
  it("11 — does not use LLM or invoke Meta write operations", async () => {
    const ready = makeOutcomeRecord({ measurementState: "READY" });
    repo.outcomes = [ready];

    await worker.processDue();

    // Verify only meta.insights tool was executed
    expect(executor.execute).toHaveBeenCalled();
    const calls = executor.execute.mock.calls;
    for (const [args] of calls) {
      expect(args.toolId).toBe("meta.insights"); // read-only tool
    }
  });
});
