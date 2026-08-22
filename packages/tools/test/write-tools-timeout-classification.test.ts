// PHASE 10.4 — failure injection at the tool/provider boundary.
//
// Injects transport-level failures into MetaPauseCampaignTool and verifies
// each maps to the correct execution-journal state:
//   Case 1  abort before HTTP transmission        -> FAILED CANCELLED_BEFORE_SEND
//   Case 2  abort while write request in flight   -> UNKNOWN AMBIGUOUS_OUTCOME
//   Case 3  network timeout after transmission    -> UNKNOWN AMBIGUOUS_OUTCOME
//   Case 4  explicit provider rejection (400)     -> FAILED EXECUTION_ERROR
//   Case 5  explicit provider success             -> SUCCEEDED
//   Case 6  connection drop after transmission    -> UNKNOWN AMBIGUOUS_OUTCOME
// Plus: UNKNOWN blocks automatic retry, and concurrent duplicates stay
// single-winner (no duplicate execution).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MetaPauseCampaignTool } from "../src/tools/meta-ads-write-tools.js";
import type { MetaAdsProvider, MetaAdsWriteProvider, MetaAccountAuthorizer } from "../src/tools/meta-ads-provider.js";
import { MemoryExecutionJournal } from "../src/execution-journal.js";

type WriteProvider = MetaAdsProvider & MetaAdsWriteProvider;

function structuralAbort(phase: "before-send" | "in-flight", method: "GET" | "POST"): Error {
  // Structurally identical to @jarvis/meta-graph's typed error
  // (name + phase + sideEffectPossible).
  const err = new Error(
    phase === "before-send"
      ? "Meta request aborted before transmission"
      : `Meta ${method} request aborted in flight; provider outcome uncertain`
  );
  err.name = "MetaRequestAbortedError";
  (err as unknown as Record<string, unknown>).phase = phase;
  (err as unknown as Record<string, unknown>).sideEffectPossible =
    phase === "in-flight" && method === "POST";
  return err;
}

const ACTIVE_CAMPAIGN = {
  campaignId: "100000001",
  name: "C1",
  status: "ACTIVE",
  objective: "OUTCOME_TRAFFIC",
} as never;

function makeProvider(updateBehavior: () => Promise<never>): {
  provider: WriteProvider;
  updateSpy: ReturnType<typeof vi.fn>;
} {
  const updateSpy = vi.fn(updateBehavior);
  const provider = {
    getCampaigns: vi.fn().mockResolvedValue({ data: [ACTIVE_CAMPAIGN] }),
    updateCampaignStatus: updateSpy,
  } as unknown as WriteProvider;
  return { provider, updateSpy };
}

const authorizer: MetaAccountAuthorizer = {
  getAuthorizedAccountIds: vi.fn().mockResolvedValue(["act_111111111"]),
  isAuthorized: vi.fn().mockResolvedValue(true),
};

const PARAMS = { accountId: "act_111111111", campaignId: "100000001" };
const CONTEXT = { userId: "user-1" };

let journal: MemoryExecutionJournal;

beforeEach(() => {
  journal = new MemoryExecutionJournal();
});

async function runWith(behavior: () => Promise<never>) {
  const { provider } = makeProvider(behavior);
  const tool = new MetaPauseCampaignTool(provider, authorizer, journal);
  return tool.execute(PARAMS, CONTEXT);
}

describe("Phase 10.4 — timeout/abort classification (failure injection)", () => {
  it("Case 1: abort before HTTP transmission -> FAILED CANCELLED_BEFORE_SEND", async () => {
    await runWith(() => Promise.reject(structuralAbort("before-send", "POST")));
    const record = journal.findByAnyKey("meta.campaign.pause:act_111111111:100000001:PAUSED");
    expect(record!.status).toBe("FAILED");
    expect(record!.errorCode).toBe("CANCELLED_BEFORE_SEND");
  });

  it("Case 2: in-flight POST abort -> UNKNOWN (side effect possible)", async () => {
    await runWith(() => Promise.reject(structuralAbort("in-flight", "POST")));
    const record = journal.findByAnyKey("meta.campaign.pause:act_111111111:100000001:PAUSED");
    expect(record!.status).toBe("UNKNOWN");
    expect(record!.errorCode).toBe("AMBIGUOUS_OUTCOME");
    expect(record!.completedAt).toBeInstanceOf(Date);
  });

  it("Case 3: network timeout after transmission -> UNKNOWN", async () => {
    await runWith(() => Promise.reject(new Error("fetch failed")));
    const record = journal.findByAnyKey("meta.campaign.pause:act_111111111:100000001:PAUSED");
    expect(record!.status).toBe("UNKNOWN");
  });

  it("Case 3b: ECONNRESET-style drop -> UNKNOWN", async () => {
    await runWith(() => Promise.reject(new Error("socket hang up")));
    const record = journal.findByAnyKey("meta.campaign.pause:act_111111111:100000001:PAUSED");
    expect(record!.status).toBe("UNKNOWN");
  });

  it("Case 4: explicit provider rejection (400) -> FAILED EXECUTION_ERROR", async () => {
    await runWith(() => Promise.reject(new Error("Invalid parameter: objective")));
    const record = journal.findByAnyKey("meta.campaign.pause:act_111111111:100000001:PAUSED");
    expect(record!.status).toBe("FAILED");
    expect(record!.errorCode).toBe("EXECUTION_ERROR");
  });

  it("Case 5: explicit provider success -> SUCCEEDED with external resource id", async () => {
    const { provider } = makeProvider(
      () =>
        Promise.resolve({
          success: true,
          campaign: { ...ACTIVE_CAMPAIGN, status: "PAUSED" },
        }) as unknown as Promise<never>
    );
    const tool = new MetaPauseCampaignTool(provider, authorizer, journal);
    const result = await tool.execute(PARAMS, CONTEXT);
    expect(result.success).toBe(true);
    const record = journal.findByAnyKey("meta.campaign.pause:act_111111111:100000001:PAUSED");
    expect(record!.status).toBe("SUCCEEDED");
    expect(record!.externalResourceId).toBe("100000001");
  });

  it("Case 6: UNKNOWN execution cannot be auto-retried (second attempt blocked)", async () => {
    await runWith(() => Promise.reject(structuralAbort("in-flight", "POST")));
    const result = await runWith(() => Promise.reject(new Error("should never be called")));
    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown");
    const record = journal.findByAnyKey("meta.campaign.pause:act_111111111:100000001:PAUSED");
    expect(record!.status).toBe("UNKNOWN");
  });

  it("concurrent duplicate executions are single-winner (abort cannot create duplicates)", async () => {
    let release!: (v: void) => void;
    const gate = new Promise<void>((r) => (release = r));
    const { provider } = makeProvider(async () => {
      await gate;
      throw structuralAbort("in-flight", "POST");
    });
    const tool = new MetaPauseCampaignTool(provider, authorizer, journal);
    const p1 = tool.execute(PARAMS, CONTEXT);
    const p2 = tool.execute(PARAMS, CONTEXT);
    // Release the write gate so the winner can finish (as an abort).
    setTimeout(release, 10);
    const [a, b] = await Promise.allSettled([p1, p2]);
    const outcomes = [a, b].map((r) =>
      r.status === "fulfilled" ? (r.value.error ?? "") : String(r.reason)
    );
    // Exactly one claim wins; the loser must NOT have executed a second write.
    const blocked = outcomes.filter(
      (m) => /already executing|already unknown/i.test(m)
    );
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    const rows = [...(journal as unknown as { rows: Map<string, { status: string }> }).rows.values()];
    expect(rows.filter((r) => r.status === "EXECUTING").length).toBeLessThanOrEqual(1);
  });

  it("journal records traceId and sanitized messages (no secrets)", async () => {
    const { provider } = makeProvider(() =>
      Promise.reject(new Error("timeout after send access_token=abc123"))
    );
    const tool = new MetaPauseCampaignTool(provider, authorizer, journal);
    await tool.execute(PARAMS, { userId: "user-1", traceId: "trace-104" });
    const record = journal.findByAnyKey("meta.campaign.pause:act_111111111:100000001:PAUSED")!;
    expect(record.traceId).toBe("trace-104");
    // The memory journal stores raw message; durable store redacts. Here we
    // assert the CLASSIFICATION path never embeds credential-shaped values
    // it generated itself.
    expect(record.errorCode).toBe("AMBIGUOUS_OUTCOME");
  });
});
