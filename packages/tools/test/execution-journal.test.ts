import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MetaPauseCampaignTool,
  MetaCreateCampaignTool,
  buildIdempotencyKey,
  clearExecutionStore,
} from "../src/tools/meta-ads-write-tools.js";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import type {
  ExecutionJournalPort,
  ToolExecutionRecord,
  BeginExecutionInput,
  ExecutionErrorInfo,
} from "@jarvis/core";
import { computeParamsHash } from "@jarvis/core";
import { createMockMetaProvider } from "../src/tools/meta-ads-mock.js";
import type { MetaAccountAuthorizer } from "../src/tools/meta-ads-provider.js";

type WriteProvider = ConstructorParameters<typeof MetaPauseCampaignTool>[0];
type CampaignProvider = ConstructorParameters<typeof MetaCreateCampaignTool>[0];

function createAuthorizer(accounts: string[] = ["act_111111111"]): MetaAccountAuthorizer {
  return {
    getAuthorizedAccountIds: vi.fn().mockResolvedValue(accounts),
    isAuthorized: vi.fn().mockImplementation(
      async (_userId: string, accountId: string) => accounts.includes(accountId)
    ),
  };
}

function validProposal() {
  return {
    name: "Q1 Brand Awareness",
    objective: "OUTCOME_AWARENESS",
    adSets: [{ name: "AdSet 1", optimizationGoal: "REACH" }],
  };
}

const ctx = (userId = "user-1", traceId?: string) =>
  ({ userId, ...(traceId ? { traceId } : {}) }) as Parameters<
    MetaPauseCampaignTool["execute"]
  >[1];

beforeEach(() => {
  clearExecutionStore();
});

// ===========================================================================
// Journal integration through write tools (mocked providers only)
// ===========================================================================

describe("Phase 10.1 — tools use the execution journal", () => {
  it("records PENDING -> EXECUTING -> SUCCEEDED with externalResourceId on campaign create", async () => {
    const journal = new MemoryExecutionJournal();
    const tool = new MetaCreateCampaignTool(
      createMockMetaProvider() as CampaignProvider,
      createAuthorizer(),
      undefined,
      journal
    );
    const params = { accountId: "act_111111111", proposal: validProposal() };
    const result = await tool.execute(params, ctx("user-1"));
    expect(result.success).toBe(true);

    const key = buildIdempotencyKey(
      "meta.campaign.create",
      "act_111111111",
      "proposal:Q1 Brand Awareness",
      "OUTCOME_AWARENESS"
    );
    const rec: ToolExecutionRecord | null = await journal.findByIdempotentKey(
      "user-1",
      "meta.campaign.create",
      key
    );
    expect(rec!.status).toBe("SUCCEEDED");
    expect(rec!.externalResourceId).toBe("100000010");
    expect(rec!.startedAt).toBeInstanceOf(Date);
    expect(rec!.completedAt).toBeInstanceOf(Date);
  });

  it("persists paramsHash and provider on journal records", async () => {
    const journal = new MemoryExecutionJournal();
    const tool = new MetaCreateCampaignTool(
      createMockMetaProvider() as CampaignProvider,
      createAuthorizer(),
      undefined,
      journal
    );
    const params = { accountId: "act_111111111", proposal: validProposal() };
    await tool.execute(params, ctx());

    const key = buildIdempotencyKey(
      "meta.campaign.create",
      "act_111111111",
      "proposal:Q1 Brand Awareness",
      "OUTCOME_AWARENESS"
    );
    const rec = (await journal.findByIdempotentKey(
      "user-1",
      "meta.campaign.create",
      key
    ))!;
    expect(rec.paramsHash).toBe(computeParamsHash(params));
    expect(rec.provider).toBe("meta-ads");
  });

  it("propagates traceId from the tool context into the journal", async () => {
    const journal = new MemoryExecutionJournal();
    const beginInputs: BeginExecutionInput[] = [];
    const spy = {
      begin: async (input: BeginExecutionInput) => {
        beginInputs.push(input);
        return journal.begin(input);
      },
      claimForExecution: (id: string) => journal.claimForExecution(id),
      markSucceeded: (id: string, r?: string) => journal.markSucceeded(id, r),
      markFailed: (id: string, e?: ExecutionErrorInfo) => journal.markFailed(id, e),
      markUnknown: (id: string, e?: ExecutionErrorInfo) => journal.markUnknown(id, e),
      getById: (id: string) => journal.getById(id),
      findByIdempotentKey: (u: string, t: string, k: string) =>
        journal.findByIdempotentKey(u, t, k),
    };
    const tool = new MetaPauseCampaignTool(
      createMockMetaProvider() as WriteProvider,
      createAuthorizer(),
      spy as ExecutionJournalPort
    );
    await tool.execute(
      { accountId: "act_111111111", campaignId: "100000001" },
      ctx("user-1", "trace-abc-123")
    );
    expect(beginInputs.length).toBeGreaterThan(0);
    expect(beginInputs[0]!.traceId).toBe("trace-abc-123");
  });

  it("marks UNKNOWN when a timeout fires after transmission and never auto-retries", async () => {
    const journal = new MemoryExecutionJournal();
    const provider = createMockMetaProvider() as CampaignProvider & WriteProvider;
    const createSpy = vi
      .fn()
      .mockRejectedValue(new Error("Request timed out after 30000ms"));
    provider.createCampaign = createSpy as unknown as typeof provider.createCampaign;

    const tool = new MetaCreateCampaignTool(
      provider,
      createAuthorizer(),
      undefined,
      journal
    );
    const params = { accountId: "act_111111111", proposal: validProposal() };

    const first = await tool.execute(params, ctx("user-1"));
    expect(first.success).toBe(false);

    const key = buildIdempotencyKey(
      "meta.campaign.create",
      "act_111111111",
      "proposal:Q1 Brand Awareness",
      "OUTCOME_AWARENESS"
    );
    const rec = (await journal.findByIdempotentKey(
      "user-1",
      "meta.campaign.create",
      key
    ))!;
    expect(rec.status).toBe("UNKNOWN");

    // Retry attempt MUST be blocked without touching the provider again.
    const second = await tool.execute(params, ctx("user-1"));
    expect(second.success).toBe(false);
    expect(second.error).toContain("unknown");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("marks FAILED for definitive provider rejections and allows retry afterwards", async () => {
    const journal = new MemoryExecutionJournal();
    const provider = createMockMetaProvider();
    let calls = 0;
    const original = provider.createCampaign.bind(provider);
    (provider as CampaignProvider).createCampaign = vi
      .fn()
      .mockImplementation(async (...args: unknown[]) => {
        calls++;
        if (calls === 1) throw new Error("Validation failed: invalid objective");
        return original(...(args as Parameters<typeof original>));
      });

    const tool = new MetaCreateCampaignTool(
      provider as CampaignProvider,
      createAuthorizer(),
      undefined,
      journal
    );
    const params = { accountId: "act_111111111", proposal: validProposal() };

    const first = await tool.execute(params, ctx("user-1"));
    expect(first.success).toBe(false);

    const key = buildIdempotencyKey(
      "meta.campaign.create",
      "act_111111111",
      "proposal:Q1 Brand Awareness",
      "OUTCOME_AWARENESS"
    );
    expect(
      (await journal.findByIdempotentKey("user-1", "meta.campaign.create", key))!
        .status
    ).toBe("FAILED");

    // Definitive failure — retry is allowed.
    (provider as CampaignProvider).createCampaign =
      original as typeof provider.createCampaign;
    const second = await new MetaCreateCampaignTool(
      provider as CampaignProvider,
      createAuthorizer(),
      undefined,
      journal
    ).execute(params, ctx("user-1"));
    expect(second.success).toBe(true);
  });

  it("second concurrent claim loser is told the execution is already running", async () => {
    const journal = new MemoryExecutionJournal();
    const tool = new MetaPauseCampaignTool(
      createMockMetaProvider() as WriteProvider,
      createAuthorizer(),
      journal
    );
    const params = { accountId: "act_111111111", campaignId: "100000001" };

    const key = buildIdempotencyKey(
      "meta.campaign.pause",
      "act_111111111",
      "100000001",
      "PAUSED"
    );

    // Simulate another worker that already owns the execution.
    const other = await journal.begin({
      userId: "user-1",
      toolId: "meta.campaign.pause",
      idempotencyKey: key,
    });
    await journal.claimForExecution(other.executionId);

    const result = await tool.execute(params, ctx("user-1"));
    expect(result.success).toBe(false);
    expect(result.error).toContain("executing");
  });
});
