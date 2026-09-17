// ---------------------------------------------------------------------------
// meta.analyze — On-demand ad-account analysis (Phase 11.10)
// ---------------------------------------------------------------------------
// A pure forwarding READ of the account's live state + diagnosis + PROPOSED
// recommendation. The tool holds NO provider, NO SDK, NO DB and NO env: it
// forwards an AnalysisInput into the SAME AnalysisGenerator instance the
// HTTP route uses. All authorization, safety caps, in-flight guarding and
// persistence happen inside the generator, which executes the existing
// READ_ONLY Meta tools (meta.accounts / meta.campaigns / meta.adsets /
// meta.ads / meta.insights) through the shared ToolExecutor — so the same
// account authorization applies to the tool path and the route path.
//
// Verdict semantics (safe for the model to interpret):
//   - COMPLETED / DRY_RUN_OK ........ success — result carries the outcome.
//   - NO_SAFE_TARGET / INSUFFICIENT_DATA  success — a legit negative answer
//     (nothing actionable); the model should report why, not invent a fix.
//   - READ_FAILED / ACCOUNT_UNAUTHORIZED / DIAGNOSIS_UNAVAILABLE /
//     PERSIST_FAILED / INVALID_INPUT / ALREADY_RUNNING  failure — the run
//     could not even produce a verdict.
// ---------------------------------------------------------------------------

import { BaseTool } from "../base-tool.js";
import type { ToolContext, ToolResult } from "@jarvis/core";
import type {
  AnalysisCaller,
  AnalysisInput,
  AnalysisOutcome,
} from "../analysis-generator.js";

/** The ONE surface the tool may touch — the shared AnalysisGenerator. */
export interface MetaAnalyzePort {
  analyze(input: AnalysisInput, caller: AnalysisCaller): Promise<AnalysisOutcome>;
}

/** Failures the model should treat as a broken run, never as a negative answer. */
const FAILED_REASONS: ReadonlySet<string> = new Set([
  "READ_FAILED",
  "ACCOUNT_UNAUTHORIZED",
  "DIAGNOSIS_UNAVAILABLE",
  "PERSIST_FAILED",
  "INVALID_INPUT",
  "ALREADY_RUNNING",
]);

export class MetaAnalyzeTool extends BaseTool {
  constructor(
    private readonly port: MetaAnalyzePort,
    private readonly defaultAccountId?: string
  ) {
    super(
      "meta.analyze",
      "Analyze ad account",
      "Runs a full on-demand analysis of a Meta ad account: reads daily performance, detects critical negative anomalies, produces an AI diagnosis, and returns a bounded PROPOSED recommendation when one is safe to make. Use it when asked to analyze performance, find what is underperforming, or propose the next ad-account action. The account id comes ONLY from the system context — never invent one.",
      "marketing",
      [
        {
          name: "accountId",
          type: "string",
          description:
            "Meta ad account ID. Use ONLY the account id supplied in your system context; never invent one and never copy an example id from documentation.",
          required: false,
        },
        {
          name: "dryRun",
          type: "boolean",
          description:
            "Run the full read + diagnosis but create no recommendation. Default false.",
          required: false,
        },
      ],
      false,
      ["read"],
      "READ_ONLY",
      "1.0.0",
      true
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!context.userId) {
      return this.failure("Analysis requires an authenticated user.");
    }

    const accountId =
      typeof params["accountId"] === "string" && params["accountId"].length > 0
        ? (params["accountId"] as string)
        : this.defaultAccountId;

    const input: AnalysisInput = {
      ...(accountId ? { accountId } : {}),
      ...(params["dryRun"] === true ? { dryRun: true } : {}),
    };

    const caller: AnalysisCaller = {
      userId: context.userId,
      // ToolContext carries no role; generation is scoped to the userId alone
      // and the generator's executor calls are still the user's own. The HTTP
      // path supplies the true role from the request.
      role: "member",
      traceId: context.traceId,
      agentId: context.agentId,
      conversationId: context.conversationId,
    };

    let outcome: AnalysisOutcome;
    try {
      outcome = await this.port.analyze(input, caller);
    } catch {
      // Unknown throw from the shared service: report a fixed message and no
      // internals. The run failed; inventing a verdict would be worse.
      return this.failure("meta.analyze failed unexpectedly; no recommendation was produced.");
    }

    const payload = {
      status: outcome.status,
      accountId: "accountId" in outcome ? outcome.accountId : undefined,
      traceId: outcome.traceId,
      ...("reason" in outcome ? { reason: outcome.reason, message: outcome.message, detail: outcome.detail } : {}),
      ...("recommendation" in outcome
        ? {
            recommendation: outcome.recommendation.status,
            recommendationId: outcome.recommendationId,
          }
        : {}),
      ...("target" in outcome ? { target: outcome.target } : {}),
      ...("scanSummary" in outcome ? { scanSummary: outcome.scanSummary } : {}),
      ...("explanation" in outcome && outcome.explanation
        ? { explanation: outcome.explanation }
        : {}),
    };

    if (outcome.status === "NO_ANALYSIS" && FAILED_REASONS.has(outcome.reason)) {
      return this.failure(`${outcome.message} ${outcome.detail}`);
    }

    return this.success(payload, {
      toolId: this.id,
      risk: this.risk,
      userId: context.userId,
    });
  }
}