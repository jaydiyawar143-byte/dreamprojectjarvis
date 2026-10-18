// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening (review finding L11) — a marketing report
// and the deployment's Meta Ads.
//
// The reads a report makes go through the executor, whose access gate refuses
// them for anyone outside the Organization that owns the Meta connection (H2).
// What this file pins is what the report SAYS: for that caller it reads
// nothing and says Meta Ads is not set up — exactly what a deployment without
// it says — instead of "the ad account could not be read", which would tell an
// outsider the operator has one. A check that cannot be made reads nothing and
// says so.
//
// Pure doubles: no database, no provider.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { IToolExecutor, ToolExecutionRequest } from "@jarvis/core";
import type { MarketingCallContext } from "@jarvis/tools";
import { MarketingService, type MarketingServiceDeps } from "../src/services/marketing/marketing-service.js";

const ctx: MarketingCallContext = { actor: "user", traceId: "trace-p17" };
const ACCOUNT = "act_000000000000017";

interface Source {
  provider: string;
  status: string;
  detail: string;
}

function world(metaAccount: MarketingServiceDeps["metaAccount"]) {
  const reads: ToolExecutionRequest[] = [];
  const asked: string[] = [];
  const sources: Source[][] = [];

  const executor: Pick<IToolExecutor, "execute"> = {
    async execute(request: ToolExecutionRequest) {
      reads.push(request);
      return {
        executionId: "e",
        toolId: request.toolId,
        status: "completed",
        result: { success: true, data: { accountId: ACCOUNT, insights: [], campaigns: [], accounts: [] } },
        startedAt: new Date(),
      };
    },
  };

  const service = new MarketingService({
    store: {
      countReports: async () => 0,
      listContent: async () => ({ items: [], total: 0 }),
      createReport: async (_userId: string, input: { document: { dataSources: Source[] } }) => {
        sources.push(input.document.dataSources);
        return { id: "rep_1", sourcesIncluded: 0, sourcesTotal: input.document.dataSources.length };
      },
    } as never,
    projects: { findOwned: async () => null },
    conversations: { findByIdAndUserId: async () => null },
    executor: () => executor,
    metaAccount: async (userId) => {
      asked.push(userId);
      return metaAccount(userId);
    },
    googleAds: async () => ({ status: "NOT_CONFIGURED", detail: "Google Ads is not set up on this server." }),
    pages: null,
    publishers: [],
    audit: { log: async () => {} },
    limiter: { reserve: async () => ({ allowed: true }) },
  });
  const metaSource = () => sources.at(-1)?.find((source) => source.provider === "meta-ads");
  return { service, reads, asked, metaSource };
}

describe("a marketing report reads the deployment's Meta Ads only for its Organization", () => {
  it("asks for the ad account as THIS caller", async () => {
    const w = world(() => ACCOUNT);
    await w.service.generateReport("member-1", {}, ctx);
    expect(w.asked).toEqual(["member-1"]);
    // And every read runs as that caller, through the executor and its gate.
    expect(w.reads.length).toBeGreaterThan(0);
    for (const read of w.reads) expect(read.userId).toBe("member-1");
  });

  it("reads nothing for an outsider, and says what a deployment without Meta says", async () => {
    const outsider = world((userId) => (userId === "member-1" ? ACCOUNT : null));
    const result = await outsider.service.generateReport("outsider-1", {}, ctx);
    expect(result.ok).toBe(true);
    expect(outsider.reads).toEqual([]);

    const withoutMeta = world(() => null);
    await withoutMeta.service.generateReport("outsider-1", {}, ctx);

    expect(outsider.metaSource()).toEqual(withoutMeta.metaSource());
    expect(outsider.metaSource()).toMatchObject({ status: "NOT_CONFIGURED", detail: "Meta Ads is not set up on this server." });
  });

  it("reads nothing when the Organization cannot be checked, and says it could not", async () => {
    const w = world(() => {
      throw new Error("organization access could not be verified");
    });
    const result = await w.service.generateReport("member-1", {}, ctx);
    expect(result.ok).toBe(true);
    expect(w.reads).toEqual([]);
    expect(w.metaSource()).toMatchObject({ status: "FAILED" });
    expect(w.metaSource()!.detail).toMatch(/could not be checked/);
  });
});
