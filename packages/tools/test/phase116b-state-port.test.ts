/**
 * PHASE 11.6B REGRESSION — createExecutorBackedExternalStatePort level fallback
 *
 * Bug fixed in Phase 11.6B: when meta.campaigns was READABLE but did not
 * contain the entity id, findIn() returned null and the old `=== undefined`
 * guards skipped the ad-set/ad fallbacks entirely, so AD-level state
 * resolution ALWAYS failed (ENTITY_NOT_FOUND) in production once /campaigns
 * was fetchable. Each readable level is now searched in order; first hit wins.
 */
import { describe, expect, it } from "vitest";
import { createExecutorBackedExternalStatePort } from "../src/index.js";
import type { ToolExecutionRequest, ToolExecutionResult } from "@jarvis/core";

type Entry = { toolId: string; data: Record<string, unknown> | null };

function fakeExecutor(entries: Entry[]) {
  const execute = async (req: ToolExecutionRequest): Promise<ToolExecutionResult> => {
    const entry = entries.find((e) => e.toolId === req.toolId);
    if (!entry || entry.data === null) {
      return {
        executionId: "x",
        toolId: req.toolId,
        status: "failed",
        error: "tool unavailable",
        startedAt: new Date(),
      };
    }
    return {
      executionId: "x",
      toolId: req.toolId,
      status: "completed",
      result: { success: true, data: entry.data },
      startedAt: new Date(),
    };
  };
  return { execute } as const;
}

const CAMPAIGNS = { campaigns: [{ campaignId: "C1", status: "ACTIVE", objective: "OUTCOME_TRAFFIC" }] };
const ADSETS = { adSets: [{ adSetId: "S1", status: "PAUSED" }] };
const ADS = {
  ads: [
    { adId: "A1", status: "ACTIVE", dailyBudget: "5000" },
    { adId: "A2", status: "PAUSED" },
  ],
};

function makePort(entries: Entry[]) {
  return createExecutorBackedExternalStatePort({
    executor: fakeExecutor(entries),
    userId: "u1",
    role: "member",
  });
}

describe("createExecutorBackedExternalStatePort - level fallback (Phase 11.6B fix)", () => {
  it("resolves an AD even though campaigns AND adSets are readable but lack the id", async () => {
    const stateOf = makePort([
      { toolId: "meta.campaigns", data: CAMPAIGNS },
      { toolId: "meta.adsets", data: ADSETS },
      { toolId: "meta.ads", data: ADS },
    ]);
    const state = await stateOf("act_x", "A1");
    expect(state).not.toBeNull();
    expect(state?.status).toBe("ACTIVE");
    expect(state?.dailyBudget).not.toBeNull();
  });

  it("still resolves a CAMPAIGN directly at the first level", async () => {
    const stateOf = makePort([
      { toolId: "meta.campaigns", data: CAMPAIGNS },
      { toolId: "meta.adsets", data: ADSETS },
      { toolId: "meta.ads", data: ADS },
    ]);
    const state = await stateOf("act_x", "C1");
    expect(state?.status).toBe("ACTIVE");
    expect(state?.objective).toBe("OUTCOME_TRAFFIC");
  });

  it("returns null when every list is unreadable", async () => {
    const stateOf = makePort([
      { toolId: "meta.campaigns", data: null },
      { toolId: "meta.adsets", data: null },
      { toolId: "meta.ads", data: null },
    ]);
    expect(await stateOf("act_x", "A1")).toBeNull();
  });

  it("returns null when all lists are readable but the entity is absent", async () => {
    const stateOf = makePort([
      { toolId: "meta.campaigns", data: CAMPAIGNS },
      { toolId: "meta.adsets", data: ADSETS },
      { toolId: "meta.ads", data: ADS },
    ]);
    expect(await stateOf("act_x", "MISSING")).toBeNull();
  });
});
