import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OutcomeWorker,
  ShutdownLifecycle,
  calculateCanonicalKPIs,
  captureBaselineSnapshot,
} from "@jarvis/core";
import type {
  IToolExecutor,
  OutcomeRecord,
  OutcomeStorePort,
  ToolExecutionResult,
} from "@jarvis/core";
import { startOutcomeWorkerSweep } from "../src/services/outcome-worker-scheduler.js";

const EMPTY_RESULT = {
  processedCount: 0,
  finalizedCount: 0,
  revisionCount: 0,
  failedCount: 0,
  errors: [],
};

const msPerDay = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Scheduler behaviour (fake worker, fake timers → deterministic)
// ---------------------------------------------------------------------------

describe("outcome worker scheduler", () => {
  it("runs an immediate sweep at start and then on each interval", async () => {
    vi.useFakeTimers();
    const lifecycle = new ShutdownLifecycle();
    const processDue = vi.fn().mockResolvedValue(EMPTY_RESULT);

    const scheduler = startOutcomeWorkerSweep({
      worker: { processDue },
      lifecycle,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(processDue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(processDue).toHaveBeenCalledTimes(2);

    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(processDue).toHaveBeenCalledTimes(2);
  });

  it("never runs a second sweep while one is in flight", async () => {
    vi.useFakeTimers();
    const lifecycle = new ShutdownLifecycle();
    let release: (() => void) | null = null;
    let calls = 0;
    const processDue = vi.fn().mockImplementation(() => {
      calls += 1;
      // Only the FIRST sweep stays pending; later (post-completion) sweeps
      // resolve immediately so stop() has nothing left to wait for.
      if (calls === 1) {
        return new Promise<typeof EMPTY_RESULT>((resolve) => {
          release = () => resolve(EMPTY_RESULT);
        });
      }
      return Promise.resolve(EMPTY_RESULT);
    });

    const scheduler = startOutcomeWorkerSweep({
      worker: { processDue },
      lifecycle,
      intervalMs: 60_000,
    });

    // The first sweep starts synchronously (claims the slot and tracks the
    // in-flight execution before its first await).
    expect(processDue).toHaveBeenCalledTimes(1);
    expect(lifecycle.getActiveExecutionCount()).toBe(1);

    // A caller asking for another sweep while one is pending JOINS it.
    const first = scheduler.sweep();
    expect(scheduler.sweep()).toBe(first);
    expect(processDue).toHaveBeenCalledTimes(1);

    // Interval ticks firing while it is pending join too — never a second run.
    vi.advanceTimersByTime(180_000);
    expect(processDue).toHaveBeenCalledTimes(1);

    // Resolve the in-flight sweep; the NEXT tick starts a fresh one.
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.getActiveExecutionCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(processDue).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  it("moves the in-flight count with each sweep", async () => {
    vi.useFakeTimers();
    const lifecycle = new ShutdownLifecycle();
    let release: (() => void) | null = null;
    const processDue = vi.fn().mockImplementation(
      () =>
        new Promise<typeof EMPTY_RESULT>((resolve) => {
          release = () => resolve(EMPTY_RESULT);
        })
    );

    const scheduler = startOutcomeWorkerSweep({
      worker: { processDue },
      lifecycle,
      intervalMs: 10_000,
    });

    expect(lifecycle.getActiveExecutionCount()).toBe(1);

    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.getActiveExecutionCount()).toBe(0);

    await scheduler.stop();
  });

  it("stops scheduling once a drain begins and still waits on the in-flight sweep", async () => {
    vi.useFakeTimers();
    const lifecycle = new ShutdownLifecycle();
    const processDue = vi.fn().mockResolvedValue(EMPTY_RESULT);

    const scheduler = startOutcomeWorkerSweep({
      worker: { processDue },
      lifecycle,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(processDue).toHaveBeenCalledTimes(1);

    lifecycle.beginDraining("SIGTERM");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(processDue).toHaveBeenCalledTimes(1);

    // stop() after the timer is already stopped settles cleanly.
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it("does not schedule at all when intervalMs is 0", async () => {
    vi.useFakeTimers();
    const lifecycle = new ShutdownLifecycle();
    const processDue = vi.fn().mockResolvedValue(EMPTY_RESULT);

    const scheduler = startOutcomeWorkerSweep({
      worker: { processDue },
      lifecycle,
      intervalMs: 0,
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(processDue).not.toHaveBeenCalled();
    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Real OutcomeWorker through the scheduler → a due record reaches FINALIZED.
// Guards the API's contract with the core worker: what the scheduler hands it
// is a completed meta.insights result, and the lease path runs to completion.
// ---------------------------------------------------------------------------

const NOW = new Date();
const EXECUTED_AT_READY = new Date(NOW.getTime() - 9 * msPerDay).toISOString();
const relativeDateStr = (daysAgo: number): string =>
  new Date(NOW.getTime() - daysAgo * msPerDay).toISOString().split("T")[0]!;

function makeReadyOutcomeRecord(): OutcomeRecord {
  const kpis = calculateCanonicalKPIs({
    spend: 200,
    impressions: 20000,
    clicks: 400,
    reach: 16000,
    conversions: 10,
    revenue: 500,
  });
  const baseline = captureBaselineSnapshot(
    {
      accountId: "act_test",
      level: "CAMPAIGN",
      entityId: "cmp_123",
      currency: "USD",
      timezone: "UTC",
      window: {
        type: "last_7_days",
        startDate: relativeDateStr(16),
        endDate: relativeDateStr(9),
      },
      recordCount: 7,
      kpis,
      quality: "COMPLETE",
      fetchedAt: EXECUTED_AT_READY,
      source: "meta-graph",
    },
    { fetchedAt: EXECUTED_AT_READY }
  );

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
    measuredAt: null,
    createdAt: EXECUTED_AT_READY,
    userId: "user_test",
  };
}

function makeInsightsExecutor(): IToolExecutor {
  return {
    async execute(request): Promise<ToolExecutionResult> {
      const insights: Array<Record<string, unknown>> = [];
      const start = new Date(String(request.params.startDate));
      const end = new Date(String(request.params.endDate));
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0]!;
        insights.push({
          spend: "100",
          impressions: "10000",
          clicks: "500",
          reach: "8000",
          conversions: "20",
          roas: "4.5",
          dateStart: dateStr,
          dateStop: dateStr,
          campaignId: "cmp_123",
          adsetId: "cmp_123",
          adId: "cmp_123",
        });
      }
      const now = new Date();
      return {
        executionId: `exec-${request.traceId}`,
        toolId: request.toolId,
        status: "completed",
        startedAt: now,
        completedAt: now,
        result: { success: true, data: { insights } },
      };
    },
  };
}

class InMemoryOutcomeRepo implements OutcomeStorePort {
  public outcomes: OutcomeRecord[] = [];

  async create(record: OutcomeRecord): Promise<void> {
    this.outcomes.push(record);
  }

  async get(outcomeId: string, userId: string): Promise<OutcomeRecord | null> {
    return (
      this.outcomes.find((o) => o.outcomeId === outcomeId && o.userId === userId) ??
      null
    );
  }

  async getByRecommendation(
    recommendationId: string,
    userId: string
  ): Promise<OutcomeRecord | null> {
    return (
      this.outcomes.find(
        (o) => o.recommendationId === recommendationId && o.userId === userId
      ) ?? null
    );
  }

  async updateMeasurementState(
    outcomeId: string,
    userId: string,
    state: OutcomeRecord["measurementState"],
    patch?: Partial<OutcomeRecord>
  ): Promise<boolean> {
    const index = this.outcomes.findIndex(
      (o) => o.outcomeId === outcomeId && o.userId === userId
    );
    if (index === -1) return false;
    this.outcomes[index] = {
      ...this.outcomes[index]!,
      measurementState: state,
      ...(patch ?? {}),
    };
    return true;
  }

  async finalize(
    outcomeId: string,
    userId: string,
    outcome: OutcomeRecord["outcome"],
    confidence: number,
    measuredAt: string
  ): Promise<boolean> {
    const index = this.outcomes.findIndex(
      (o) => o.outcomeId === outcomeId && o.userId === userId
    );
    if (index === -1 || this.outcomes[index]!.measurementState === "FINALIZED") {
      return false;
    }
    this.outcomes[index] = {
      ...this.outcomes[index]!,
      outcome,
      confidence,
      measuredAt,
    };
    return true;
  }

  async listByAccount(
    accountId: string,
    userId: string
  ): Promise<{ items: OutcomeRecord[]; total: number }> {
    const items = this.outcomes.filter(
      (o) => o.accountId === accountId && o.userId === userId
    );
    return { items, total: items.length };
  }

  async createRevision(): Promise<void> {}

  async getRevisions(): Promise<{ items: never[]; total: number }> {
    return { items: [], total: 0 };
  }

  async getLearningHistory(): Promise<never[]> {
    return [];
  }

  async findFinalizedOutcomes(userId: string): Promise<OutcomeRecord[]> {
    return this.outcomes.filter(
      (o) => o.userId === userId && o.measurementState === "FINALIZED"
    );
  }

  async findDueOutcomes(): Promise<OutcomeRecord[]> {
    return this.outcomes.filter((o) => o.measurementState !== "FINALIZED");
  }

  async claimOutcome(outcomeId: string): Promise<boolean> {
    const record = this.outcomes.find((o) => o.outcomeId === outcomeId);
    if (
      !record ||
      record.measurementState === "COLLECTING" ||
      record.measurementState === "FINALIZED"
    ) {
      return false;
    }
    record.measurementState = "COLLECTING";
    return true;
  }

  async releaseOutcome(
    outcomeId: string,
    state: OutcomeRecord["measurementState"]
  ): Promise<boolean> {
    const record = this.outcomes.find((o) => o.outcomeId === outcomeId);
    if (!record) return false;
    record.measurementState = state;
    return true;
  }

  async findRecentlyFinalized(): Promise<OutcomeRecord[]> {
    return this.outcomes.filter((o) => o.measurementState === "FINALIZED");
  }
}

describe("real OutcomeWorker through the scheduler", () => {
  it("drives a due record to FINALIZED on the sweep", async () => {
    const lifecycle = new ShutdownLifecycle();
    const repo = new InMemoryOutcomeRepo();
    repo.outcomes.push(makeReadyOutcomeRecord());
    const worker = new OutcomeWorker(makeInsightsExecutor(), repo);

    const scheduler = startOutcomeWorkerSweep({
      worker,
      lifecycle,
      intervalMs: 5,
      log: () => {},
    });

    try {
      await vi.waitFor(
        () => {
          expect(repo.outcomes[0]!.measurementState).toBe("FINALIZED");
          expect(repo.outcomes[0]!.outcome).not.toBeNull();
        },
        { timeout: 5_000, interval: 25 }
      );
    } finally {
      await scheduler.stop();
    }
  });
});