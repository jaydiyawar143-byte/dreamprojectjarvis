// ---------------------------------------------------------------------------
// Phase 11.10 — MetaAnalyzeTool tests
//
// The tool is a PURE FORWARDER: it must never hold a provider, SDK, DB or env
// key. These tests pin the forwarding surface — it translates a sentence-side
// call into the AnalysisInput/caller the shared AnalysisGenerator service
// expects, and maps the outcome to the right verdict for the model.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import type { ToolContext } from "@jarvis/core";
import { MetaAnalyzeTool, type MetaAnalyzePort } from "../src/tools/meta-analysis-tool.js";
import type { AnalysisCaller, AnalysisInput, AnalysisOutcome } from "../src/analysis-generator.js";

const ctx = (userId = "user-1"): ToolContext =>
  ({ userId, traceId: "trace-1", role: "member" }) as unknown as ToolContext;

function outcomeOf(partial: Record<string, unknown>): AnalysisOutcome {
  return { status: "COMPLETED", accountId: "act_1", traceId: "t", ...partial } as unknown as AnalysisOutcome;
}

function portReturning(outcome: AnalysisOutcome) {
  const analyze = vi.fn(async (): Promise<AnalysisOutcome> => outcome);
  const port: MetaAnalyzePort = { analyze };
  return { port, analyze };
}

const PORT_FAILURES: Array<{ reason: string; status: "NO_ANALYSIS" }> = [
  { reason: "READ_FAILED", status: "NO_ANALYSIS" },
  { reason: "ACCOUNT_UNAUTHORIZED", status: "NO_ANALYSIS" },
  { reason: "DIAGNOSIS_UNAVAILABLE", status: "NO_ANALYSIS" },
  { reason: "PERSIST_FAILED", status: "NO_ANALYSIS" },
  { reason: "INVALID_INPUT", status: "NO_ANALYSIS" },
  { reason: "ALREADY_RUNNING", status: "NO_ANALYSIS" },
];

describe("MetaAnalyzeTool — forwarding surface", () => {
  it("declares the read-only contract the realm grants", () => {
    const tool = new MetaAnalyzeTool({ analyze: async () => outcomeOf({}) });
    expect(tool.id).toBe("meta.analyze");
    expect(tool.risk).toBe("READ_ONLY");
    expect(tool.requiresApproval).toBe(false);
    expect(tool.requiredPermissions).toEqual(["read"]);
    expect(tool.category).toBe("marketing");
  });

  it("forwards no accountId when none was given and none is configured", async () => {
    const { port, analyze } = portReturning(outcomeOf({}));
    await new MetaAnalyzeTool(port, undefined).execute({}, ctx());
    const [input] = analyze.mock.calls[0] as unknown as [AnalysisInput, AnalysisCaller];
    expect(input.accountId).toBeUndefined();
    expect(input.dryRun).toBeUndefined();
  });

  it("falls back to the configured default account when the sentence gives none", async () => {
    const { port, analyze } = portReturning(outcomeOf({}));
    await new MetaAnalyzeTool(port, "act_42").execute({}, ctx());
    const [input] = analyze.mock.calls[0] as unknown as [AnalysisInput, AnalysisCaller];
    expect(input.accountId).toBe("act_42");
  });

  it("forwards an explicit accountId and dryRun from the sentence", async () => {
    const { port, analyze } = portReturning(outcomeOf({ accountId: "act_7" }));
    await new MetaAnalyzeTool(port, "act_42").execute(
      { accountId: "act_7", dryRun: true },
      ctx()
    );
    const [input] = analyze.mock.calls[0] as unknown as [AnalysisInput, AnalysisCaller];
    expect(input.accountId).toBe("act_7");
    expect(input.dryRun).toBe(true);
  });

  it("does NOT accept arbitrary extra params into the input", async () => {
    const { port, analyze } = portReturning(outcomeOf({}));
    await new MetaAnalyzeTool(port, "act_42").execute(
      { accountId: "act_7", dryRun: true, secretKey: "EAA-leak" } as Record<string, unknown>,
      ctx()
    );
    const [input] = analyze.mock.calls[0] as unknown as [AnalysisInput, AnalysisCaller];
    expect(JSON.stringify(input)).not.toMatch(/EAA|secretKey/);
  });

  it("passes the caller identity straight through, with role member", async () => {
    const { port, analyze } = portReturning(outcomeOf({}));
    await new MetaAnalyzeTool(port, "act_42").execute({}, ctx("user-9"));
    const [, caller] = analyze.mock.calls[0] as unknown as [AnalysisInput, AnalysisCaller];
    expect(caller.userId).toBe("user-9");
    expect(caller.traceId).toBe("trace-1");
    expect(caller.role).toBe("member");
  });

  it("refuses to run without an authenticated user and never calls the port", async () => {
    const { port, analyze } = portReturning(outcomeOf({}));
    const result = await new MetaAnalyzeTool(port, "act_42").execute(
      {},
      { traceId: "trace-1" } as ToolContext
    );
    expect(result.success).toBe(false);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("turns an unexpected port throw into a failure with a bounded message", async () => {
    const port: MetaAnalyzePort = {
      analyze: async () => {
        throw new Error("SUPER_SECRET_INTERNAL_PG_URI");
      },
    };
    const result = await new MetaAnalyzeTool(port, "act_42").execute({}, ctx());
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/PG_URI|SECRET/);
  });
});

describe("MetaAnalyzeTool — verdict mapping", () => {
  it("returns success for COMPLETED and carries the outcome payload", async () => {
    const { port } = portReturning(
      outcomeOf({
        status: "COMPLETED",
        accountId: "act_1",
        recommendation: { status: "CREATED" },
        recommendationId: "rec_1",
        target: { id: "ad_x1" },
        scanSummary: { candidateCount: 1 },
      }) as AnalysisOutcome
    );
    const result = await new MetaAnalyzeTool(port, "act_1").execute({}, ctx());
    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data["status"]).toBe("COMPLETED");
    expect(data["recommendation"]).toBe("CREATED");
    expect(data["recommendationId"]).toBe("rec_1");
  });

  it("returns success for DRY_RUN_OK and never fabricates a recommendation id", async () => {
    const { port } = portReturning(
      outcomeOf({ status: "DRY_RUN_OK", accountId: "act_1", target: { id: "ad_x1" } as unknown as AnalysisOutcome["target"] })
    );
    const result = await new MetaAnalyzeTool(port, "act_1").execute({}, ctx());
    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data["status"]).toBe("DRY_RUN_OK");
    expect(data["recommendationId"]).toBeUndefined();
  });

  it("returns success for the legit negative answers NO_SAFE_TARGET and INSUFFICIENT_DATA", async () => {
    for (const reason of ["NO_SAFE_TARGET", "INSUFFICIENT_DATA"] as const) {
      const { port } = portReturning(
        outcomeOf({
          status: "NO_ANALYSIS",
          reason,
          message: "nothing actionable found",
          detail: "no candidate deviated from baseline",
        })
      );
      const result = await new MetaAnalyzeTool(port, "act_1").execute({}, ctx());
      expect(result.success).toBe(true);
      const data = (result as { data: Record<string, unknown> }).data;
      expect(data["reason"]).toBe(reason);
    }
  });

  it.each(PORT_FAILURES.map((f) => f.reason))(
    "fails the verdict for %s instead of reporting a negative answer",
    async (reason) => {
      const { port } = portReturning(
        outcomeOf({ status: "NO_ANALYSIS", reason, message: "run broken", detail: "something failed" })
      );
      const result = await new MetaAnalyzeTool(port, "act_1").execute({}, ctx());
      expect(result.success).toBe(false);
      const error = (result as { error?: string }).error ?? "";
      expect(error).toContain("run broken");
      expect(error).toContain("something failed");
    }
  );
});