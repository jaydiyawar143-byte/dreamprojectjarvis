// PHASE 10.2 — Concurrency, crash recovery and DB-failure safety at the TOOL
// level. Proves that no combination of concurrent callers, worker crashes or
// journal outages can cause a duplicate external side effect or an unsafe
// automatic re-execution.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MetaPauseCampaignTool,
  clearExecutionStore,
} from "../src/tools/meta-ads-write-tools.js";
import type { MetaAdsProvider, MetaAdsWriteProvider, MetaAccountAuthorizer } from "../src/tools/meta-ads-provider.js";
import { createMockMetaProvider, createFailingMetaProvider } from "../src/tools/meta-ads-mock.js";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import type {
  AuditLogger,
  ExecutionJournalPort,
  ToolExecutionRecord,
} from "@jarvis/core";

type WriteProvider = MetaAdsProvider & MetaAdsWriteProvider;

const PARAMS = { accountId: "act_111111111", campaignId: "100000001" };
const CTX = { userId: "user-1" };
const TEN_MIN = 10 * 60_000;

function createAuthorizer(): MetaAccountAuthorizer {
  return {
    getAuthorizedAccountIds: vi.fn().mockResolvedValue(["act_111111111"]),
    isAuthorized: vi.fn().mockResolvedValue(true),
  };
}

function makeCountingProvider(): { provider: WriteProvider; writes(): number } {
  const base = createMockMetaProvider();
  let count = 0;
  const original = base.updateCampaignStatus.bind(base);
  const provider = Object.create(base) as WriteProvider;
  provider.updateCampaignStatus = async (
    accountId: string,
    campaignId: string,
    status: "ACTIVE" | "PAUSED"
  ) => {
    count++;
    return original(accountId, campaignId, status);
  };
  return { provider, writes: () => count };
}

function makeFlakyJournal(
  base: MemoryExecutionJournal,
  failOn: "markSucceeded" | "markFailed"
): ExecutionJournalPort {
  return {
    begin: (i) => base.begin(i),
    claimForExecution: (id, o) => base.claimForExecution(id, o),
    heartbeat: (id, o, l) => base.heartbeat(id, o, l),
    findStaleExecutions: (o) => base.findStaleExecutions(o),
    recoverStaleExecutions: (o) => base.recoverStaleExecutions(o),
    markSucceeded: failOn === "markSucceeded"
      ? async () => { throw new Error("journal connection lost"); }
      : (id, r) => base.markSucceeded(id, r),
    markFailed: failOn === "markFailed"
      ? async () => { throw new Error("journal connection lost"); }
      : (id, e) => base.markFailed(id, e),
    markUnknown: (id, e) => base.markUnknown(id, e),
    getById: (id) => base.getById(id),
    findByIdempotentKey: (u, t, k) => base.findByIdempotentKey(u, t, k),
  };
}

function makeBrokenBeginJournal(): ExecutionJournalPort {
  return {
    begin: async () => { throw new Error("ECONNREFUSED: journal down"); },
    claimForExecution: async () => null,
    heartbeat: async () => null,
    findStaleExecutions: async () => [],
    recoverStaleExecutions: async () => ({ recovered: [] }),
    markSucceeded: async () => null,
    markFailed: async () => null,
    markUnknown: async () => null,
    getById: async () => null,
    findByIdempotentKey: async () => null,
  };
}

beforeEach(() => { clearExecutionStore(); });

describe("PHASE 10.2 — concurrent execution single-winner (tool level)", () => {
  it("x2 concurrent identical requests -> exactly ONE provider write", async () => {
    const { provider, writes } = makeCountingProvider();
    const authorizer = createAuthorizer();
    const journal = new MemoryExecutionJournal();
    const t1 = new MetaPauseCampaignTool(provider, authorizer, journal);
    const t2 = new MetaPauseCampaignTool(provider, authorizer, journal);

    const [r1, r2] = await Promise.all([
      t1.execute(PARAMS, CTX),
      t2.execute(PARAMS, CTX),
    ]);

    expect(writes()).toBe(1); // external side effect happened exactly once
    const successes = [r1, r2].filter((r) => r.success);
    expect(successes).toHaveLength(1);
    // The loser must NOT report success as if it had written anything.
    const loser = [r1, r2].find((r) => !r.success)!;
    expect(loser.error).toContain("already");
  });

  it("x5 concurrent identical requests -> exactly ONE provider write", async () => {
    const { provider, writes } = makeCountingProvider();
    const authorizer = createAuthorizer();
    const journal = new MemoryExecutionJournal();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        new MetaPauseCampaignTool(provider, authorizer, journal).execute(PARAMS, CTX)
      )
    );

    expect(writes()).toBe(1);
    expect(results.filter((r) => r.success)).toHaveLength(1);
  });

  it("x10 concurrent identical requests -> one record, one winner, nine safe losers", async () => {
    const { provider, writes } = makeCountingProvider();
    const authorizer = createAuthorizer();
    const journal = new MemoryExecutionJournal();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        new MetaPauseCampaignTool(provider, authorizer, journal).execute(PARAMS, CTX)
      )
    );

    expect(writes()).toBe(1);
    expect(results.filter((r) => r.success)).toHaveLength(1);

    // Exactly one durable record exists for the idempotency key.
    const rec = await journal.findByIdempotentKey(
      "user-1",
      "meta.campaign.pause",
      "meta.campaign.pause:act_111111111:100000001:PAUSED"
    );
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("SUCCEEDED");
  });
});

describe("PHASE 10.2 — crash mid-execution & stale recovery (tool level)", () => {
  it("crashed worker lease expires -> recovery to UNKNOWN -> retry blocked, provider untouched", async () => {
    const { provider, writes } = makeCountingProvider();
    const authorizer = createAuthorizer();
    const journal = new MemoryExecutionJournal();
    const tool = new MetaPauseCampaignTool(provider, authorizer, journal);

    // Simulate a worker that claimed ownership and then crashed:
    const rec = await journal.begin({
      userId: "user-1",
      toolId: "meta.campaign.pause",
      idempotencyKey: "meta.campaign.pause:act_111111111:100000001:PAUSED",
      paramsHash: "hash",
      traceId: "trace-crash-tool",
    });
    await journal.claimForExecution(rec.executionId, { ownerId: "crashed-worker", leaseMs: 60_000 });

    // While the lease is valid, a new request is blocked — no takeover.
    const duringLease = await tool.execute(PARAMS, CTX);
    expect(duringLease.success).toBe(false);
    expect(duringLease.error).toContain("already executing");
    expect(writes()).toBe(0);

    // Lease expires; recovery pass classifies the orphaned execution.
    const future = new Date(Date.now() + TEN_MIN);
    const { recovered } = await journal.recoverStaleExecutions({ now: future });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe("UNKNOWN"); // never FAILED automatically

    // After recovery the outcome is uncertain: retry stays blocked.
    const afterRecovery = await tool.execute(PARAMS, CTX);
    expect(afterRecovery.success).toBe(false);
    expect(afterRecovery.error).toContain("already unknown");
    expect(writes()).toBe(0); // NO duplicate external side effect
  });

  it("recovered record preserves full audit context", async () => {
    const { provider } = makeCountingProvider();
    const journal = new MemoryExecutionJournal();
    const tool = new MetaPauseCampaignTool(provider, createAuthorizer(), journal);

    const rec = await journal.begin({
      userId: "user-audit",
      toolId: "meta.campaign.pause",
      idempotencyKey: "audit-key-1",
      paramsHash: "hash",
      traceId: "trace-audit-42",
    });
    await journal.claimForExecution(rec.executionId, { ownerId: "w", leaseMs: 60_000 });

    const { recovered } = await journal.recoverStaleExecutions({
      now: new Date(Date.now() + TEN_MIN),
    });
    const audit: ToolExecutionRecord = recovered[0]!;
    expect(audit.executionId).toBe(rec.executionId);
    expect(audit.userId).toBe("user-audit");
    expect(audit.toolId).toBe("meta.campaign.pause");
    expect(audit.traceId).toBe("trace-audit-42");
    expect(audit.status).toBe("UNKNOWN");
    expect(audit.startedAt).not.toBeNull();
    expect(audit.completedAt).not.toBeNull();
    expect(audit.errorCode).toBe("STALE_EXECUTION_RECOVERED");
  });
});

describe("PHASE 10.2 — DB failure safety (tool level)", () => {
  it("journal down BEFORE claim: fail closed, no ownership, no provider call", async () => {
    const { provider, writes } = makeCountingProvider();
    const tool = new MetaPauseCampaignTool(provider, createAuthorizer(), makeBrokenBeginJournal());

    const result = await tool.execute(PARAMS, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain("journal unavailable");
    expect(writes()).toBe(0);
  });

  it("journal fails AFTER definitive provider failure: clean failure returned, record stays EXECUTING, later recovery -> UNKNOWN", async () => {
    // Reads succeed; only the external WRITE fails definitively (after claim).
    const failing = createMockMetaProvider({ throwOnCall: "updateCampaignStatus" });
    const base = new MemoryExecutionJournal();
    const flaky = makeFlakyJournal(base, "markFailed");
    const tool = new MetaPauseCampaignTool(failing, createAuthorizer(), flaky);

    // Must not throw even though markFailed rejects after the claim.
    const result = await tool.execute(PARAMS, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Meta API error");

    // The FAILED transition was lost: record remains EXECUTING (lease held).
    const rec = await base.findByIdempotentKey(
      "user-1",
      "meta.campaign.pause",
      "meta.campaign.pause:act_111111111:100000001:PAUSED"
    );
    expect(rec!.status).toBe("EXECUTING");

    // Recovery classifies it honestly as UNKNOWN — never silently FAILED.
    const { recovered } = await base.recoverStaleExecutions({
      now: new Date(Date.now() + TEN_MIN),
    });
    expect(recovered[0]!.status).toBe("UNKNOWN");

    // And UNKNOWN never auto-retries through the tool.
    const healthy = makeCountingProvider();
    const retryTool = new MetaPauseCampaignTool(healthy.provider, createAuthorizer(), base);
    const retry = await retryTool.execute(PARAMS, CTX);
    expect(retry.success).toBe(false);
    expect(healthy.writes()).toBe(0);
  });

  it("provider SUCCEEDED but journal write lost: user still gets success, record recovers to UNKNOWN, no duplicate side effect", async () => {
    const { provider, writes } = makeCountingProvider();
    const base = new MemoryExecutionJournal();
    const flaky = makeFlakyJournal(base, "markSucceeded");
    const tool = new MetaPauseCampaignTool(provider, createAuthorizer(), flaky);

    // The external write succeeded; only the journal completion failed.
    const result = await tool.execute(PARAMS, CTX);
    expect(result.success).toBe(true);
    expect(writes()).toBe(1);

    // Record stuck in EXECUTING (completion lost), then recovered.
    const rec = await base.findByIdempotentKey(
      "user-1",
      "meta.campaign.pause",
      "meta.campaign.pause:act_111111111:100000001:PAUSED"
    );
    expect(rec!.status).toBe("EXECUTING");
    const { recovered } = await base.recoverStaleExecutions({
      now: new Date(Date.now() + TEN_MIN),
    });
    expect(recovered[0]!.status).toBe("UNKNOWN");

    // A repeat request must NOT trigger a second external write.
    const healthyTool = new MetaPauseCampaignTool(provider, createAuthorizer(), base);
    const repeat = await healthyTool.execute(PARAMS, CTX);
    expect(repeat.success).toBe(false);
    expect(repeat.error).toContain("already unknown");
    expect(writes()).toBe(1);
  });

  it("KNOWN FAILURE still allows explicit retry (FAILED -> EXECUTING)", async () => {
    const base = new MemoryExecutionJournal();
    const failing = createFailingMetaProvider("Meta API error: definitive rejection") as unknown as WriteProvider;
    const first = new MetaPauseCampaignTool(failing, createAuthorizer(), base);
    const r1 = await first.execute(PARAMS, CTX);
    expect(r1.success).toBe(false);

    // Definitive failure recorded -> operator retries with a healthy provider.
    const { provider, writes } = makeCountingProvider();
    const second = new MetaPauseCampaignTool(provider, createAuthorizer(), base);
    const r2 = await second.execute(PARAMS, CTX);
    expect(r2.success).toBe(true);
    expect(writes()).toBe(1);
  });

  it("SUCCEEDED execution can never be claimed again (journal-level guard)", async () => {
    const { provider } = makeCountingProvider();
    const journal = new MemoryExecutionJournal();
    const tool = new MetaPauseCampaignTool(provider, createAuthorizer(), journal);
    const ok = await tool.execute(PARAMS, CTX);
    expect(ok.success).toBe(true);

    const rec = (await journal.findByIdempotentKey(
      "user-1",
      "meta.campaign.pause",
      "meta.campaign.pause:act_111111111:100000001:PAUSED"
    ))!;
    expect(await journal.claimForExecution(rec.executionId)).toBeNull();
  });
});
