// ---------------------------------------------------------------------------
// PHASE 11.10 — On-demand analysis & recommendation generation
//
// The ONE shared production pipeline for turning live Meta advertising data
// into a durable PROPOSED recommendation:
//
//     meta.accounts      (authorization + account attributes)   ──┐
//     meta.campaigns/ad-sets/ads  (inventory)                    ├──► AnalysisGenerator.analyze()
//     meta.insights      (daily rows, one bounded read)          │
//          │                                                      │
//          ▼   per scanned entity (deterministically ordered)     ▼
//     normalizeInsightRows → aggregatePerformanceRecords →
//     comparePerformanceSummaries → detectAnomalies →
//     buildEvidencePackage → DiagnosisEngine.diagnose →
//     RecommendationEngine.generate  →  durable PROPOSED row
//
// The JARVIS tool (`meta.analyze`) and the HTTP route
// (`POST /api/v1/analysis`) BOTH forward into the SAME `AnalysisGenerator`
// instance, exactly like the integration command service, so the permission
// checks, account authorization, safety caps, in-flight guard and audit row
// exist once and are shared structurally rather than by convention.
//
// This service is the successor of the Phase 11.6B smoke script
// (`apps/api/scripts/phase116b/propose.ts`) — but where the script could only
// be driven from a terminal and wired OpenAI + Prisma directly, this service
// runs on every request path and takes ALL of its dependencies as ports.
// The one rule the script did not observe that this service does: **no Prisma,
// no provider SDK, no HTTP, no env reads in here.** Everything arrives through
// the injected executor (reads go through the SAME registered read tools, so
// account authorization applies), the AI provider, the store and the audit port.
//
// SAFETY LIMITS (always on, always equal to or below any downstream ceiling):
//   - maxInsightRows      — the insights read is one bounded call.
//   - maxEntitiesScanned  — no unlimited entity loops; the candidate scan is
//                           truncated at this cap in deterministic id order.
//   - In-flight guard     — one analysis per (userId, accountId); a concurrent
//                           request is refused (ALREADY_RUNNING), never started
//                           twice. Process-local, like the diagnosis cache.
//   - Account authorization — the account MUST appear in the meta.accounts
//                           read for the calling token, or the run fails closed
//                           before any other request.
//   - Determination       — target selection is deterministic (max deviation,
//                           then id), one recommendation per run, so a retried
//                           request produces the same durable record.
//
// FAIL-CLOSED: no safe target, unverifiable diagnosis, unavailable AI provider,
// failed read, or failed persistence => ZERO Meta writes, ZERO fabricated
// recommendations, ZERO secrets in results or audit rows.
// ---------------------------------------------------------------------------

import type {
  AuditLogger,
  IAIProvider,
  IToolExecutor,
  Role,
} from "@jarvis/core";
import {
  DiagnosisEngine,
  RecommendationEngine,
  aggregatePerformanceRecords,
  buildEvidencePackage,
  comparePerformanceSummaries,
  detectAnomalies,
  normalizeInsightRows,
  redactSecrets,
  type DiagnosisEngineOptions,
  type DiagnosisOutcome,
  type DiagnosisResult,
  type ExternalStatePort,
  type MarketingAnomaly,
  type NormalizedPerformanceRecord,
  type RecommendationEngineConfig,
  type RecommendationOutcome,
  type RecommendationStorePort,
} from "@jarvis/core";
import { createExecutorBackedExternalStatePort } from "./recommendation-bridge.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_INSIGHT_ROWS = 500;
export const DEFAULT_MAX_ENTITIES_SCANNED = 100;
export const DEFAULT_LOOKBACK_DAYS = 14;
export const DEFAULT_STALE_DATA_DELAY_DAYS = 3;
export const DEFAULT_MIN_BASELINE_DAYS = 7;
export const DEFAULT_DIAGNOSIS_ATTEMPTS = 2;

export interface AnalysisConfig {
  /** Account used when a caller does not name one (the server-configured one). */
  defaultAccountId?: string;
  /** Cap on the single insights read (rows). Default 500. */
  maxInsightRows?: number;
  /** Cap on how many active entities are scanned. Default 100. */
  maxEntitiesScanned?: number;
  /** How many days of daily rows to request. Default 14. */
  lookbackDays?: number;
  /** How stale a "current day" may be before the entity is ineligible. Default 3. */
  staleDataDelayDays?: number;
  /** Minimum baseline days required to scan an entity. Default 7. */
  minBaselineDays?: number;
  /** Diagnosis attempts before giving up on provider non-failures. Default 2. */
  diagnosisAttempts?: number;
  /** Forwarded to DiagnosisEngine (batching, context budget, cache, timeout). */
  diagnosis?: DiagnosisEngineOptions;
  /** Forwarded to RecommendationEngine (TTL, budget rate-limit, history port). */
  recommendation?: RecommendationEngineConfig;
  /** Disable the process-local in-flight guard (tests). Default true. */
  inFlightGuard?: boolean;
  /** Deterministic clock for tests. */
  nowFn?: () => Date;
}

interface ResolvedAnalysisConfig {
  defaultAccountId?: string;
  maxInsightRows: number;
  maxEntitiesScanned: number;
  lookbackDays: number;
  staleDataDelayDays: number;
  minBaselineDays: number;
  diagnosisAttempts: number;
  diagnosis?: DiagnosisEngineOptions;
  recommendation?: RecommendationEngineConfig;
  inFlightGuard?: boolean;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface AnalysisCaller {
  userId: string;
  role: Role;
  traceId?: string;
  ipAddress?: string;
  agentId?: string;
  conversationId?: string;
}

export interface AnalysisInput {
  /**
   * Account to analyse. If omitted, the configured default is used. When a
   * caller supplies one it is still verified against the token's own
   * meta.accounts read before anything else happens — a token can only ever
   * drive analysis for accounts it genuinely owns.
   */
  accountId?: string;
  /**
   * Dry-run: run the FULL read + diagnose pipeline and stop at the
   * RecommendationEngine boundary. No durable row, no cooldown/dedup query,
   * no recommendation created. The route and the tool both support it.
   */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Outcome taxonomy — deterministic, safe errors only
// ---------------------------------------------------------------------------

export interface AnalysisTargetInfo {
  id: string;
  name: string;
  entityLevel: "AD" | "AD_SET";
  campaignId?: string;
  adSetId?: string;
  criticalCount: number;
  warningCount: number;
  maxDeviation: number;
  currentDay: string;
  baselineDays: number;
}

export interface AnalysisScanSummary {
  level: "AD" | "AD_SET";
  inventory: { campaigns: number; adSets: number; ads: number };
  insightRowCount: number;
  candidateCount: number;
  scannedCount: number;
  eligibleCount: number;
  criticalCount: number;
  anomalyCount: number;
  topTarget?: AnalysisTargetInfo;
}

export type AnalysisNoAnalysisReason =
  | "NO_SAFE_TARGET"
  | "INSUFFICIENT_DATA"
  | "ACCOUNT_UNAUTHORIZED"
  | "READ_FAILED"
  | "DIAGNOSIS_UNAVAILABLE"
  | "PERSIST_FAILED"
  | "INVALID_INPUT"
  | "ALREADY_RUNNING";

export interface AnalysisExplanation {
  reason: string;
  message: string;
}

export type AnalysisOutcome =
  | {
      status: "COMPLETED";
      accountId: string;
      /** The RecommendationEngine's own verdict (CREATED / DUPLICATE / …). */
      recommendation: RecommendationOutcome;
      recommendationId?: string;
      target?: AnalysisTargetInfo;
      scanSummary: AnalysisScanSummary;
      diagnosis?: DiagnosisResult;
      explanation?: AnalysisExplanation;
      traceId?: string;
    }
  | {
      status: "DRY_RUN_OK";
      accountId: string;
      target: AnalysisTargetInfo;
      scanSummary: AnalysisScanSummary;
      diagnosis: DiagnosisResult;
      /** Always true here: the diagnosis reached the generate boundary. */
      wouldRunGenerate: true;
      traceId?: string;
    }
  | {
      status: "NO_ANALYSIS";
      reason: AnalysisNoAnalysisReason;
      detail: string;
      message: string;
      scanSummary?: AnalysisScanSummary;
      /** Present only after the account was resolved and authorised. */
      accountId?: string;
      traceId?: string;
    };

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AnalysisGeneratorDeps {
  /**
   * THE only way this service observes Meta: by executing the registered
   * READ_ONLY tools (meta.accounts / meta.campaigns / meta.adsets / meta.ads /
   * meta.insights) through the same ToolExecutor every other path uses. No
   * provider SDK, no direct HTTP.
   */
  executor: Pick<IToolExecutor, "execute">;
  /**
   * The provider chain for diagnosis — the container's FallbackAIProvider, so
   * the same cooldown/fallback/tolerant behavior the agents get applies here.
   */
  provider: IAIProvider;
  /**
   * Where PROPOSED recommendations are persisted (PrismaRecommendationRepository
   * in production — it already implements RecommendationStorePort).
   */
  store: RecommendationStorePort;
  /** Audit linkage for the whole run. Optional; failures never crash the pipeline. */
  audit?: AuditLogger;
  config?: AnalysisConfig;
  nowFn?: () => Date;
}

export class AnalysisGenerator {
  private readonly config: ResolvedAnalysisConfig;
  private readonly diagnosisEngine: DiagnosisEngine;
  private readonly inFlight = new Set<string>();
  private readonly nowFn: () => Date;

  constructor(private readonly deps: AnalysisGeneratorDeps) {
    const cfg = deps.config ?? {};
    this.config = {
      defaultAccountId: cfg.defaultAccountId,
      maxInsightRows: cfg.maxInsightRows ?? DEFAULT_MAX_INSIGHT_ROWS,
      maxEntitiesScanned: cfg.maxEntitiesScanned ?? DEFAULT_MAX_ENTITIES_SCANNED,
      lookbackDays: cfg.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
      staleDataDelayDays: cfg.staleDataDelayDays ?? DEFAULT_STALE_DATA_DELAY_DAYS,
      minBaselineDays: cfg.minBaselineDays ?? DEFAULT_MIN_BASELINE_DAYS,
      diagnosisAttempts: cfg.diagnosisAttempts ?? DEFAULT_DIAGNOSIS_ATTEMPTS,
      diagnosis: cfg.diagnosis,
      recommendation: cfg.recommendation,
      inFlightGuard: cfg.inFlightGuard,
    };
    this.nowFn = deps.nowFn ?? (() => new Date());
    this.diagnosisEngine = new DiagnosisEngine(deps.provider, {
      ...cfg.diagnosis,
      now: cfg.diagnosis?.now ?? this.nowFn,
    });
  }

  /** Test hook: clears the process-local in-flight guard. */
  resetInFlight(): void {
    this.inFlight.clear();
  }

  async analyze(input: AnalysisInput, caller: AnalysisCaller): Promise<AnalysisOutcome> {
    const traceId = caller.traceId;

    // --- Validation ----------------------------------------------------------
    if (!caller.userId) {
      return this.noAnalysis("INVALID_INPUT", "Missing caller userId", "Analysis requires an authenticated user.", undefined, traceId);
    }

    const accountId = input.accountId ?? this.config.defaultAccountId;
    if (!accountId) {
      return this.noAnalysis(
        "INVALID_INPUT",
        "No account is configured for analysis",
        "No Meta ad account is configured on this server, and no account id was supplied.",
        undefined,
        traceId
      );
    }

    // --- In-flight guard: never two concurrent generations for one account ---
    const guardKey = `${caller.userId}:${accountId}`;
    if (this.config.inFlightGuard !== false) {
      if (this.inFlight.has(guardKey)) {
        return this.noAnalysis(
          "ALREADY_RUNNING",
          `An analysis for account ${accountId} is already in progress for this user`,
          "Analysis is already running for this account. Wait for it to finish before requesting another.",
          undefined,
          traceId
        );
      }
      this.inFlight.add(guardKey);
    }

    let scannedCount = 0;
    let eligibleCount = 0;
    let criticalCount = 0;
    let anomalyCount = 0;
    const summary: AnalysisScanSummary = {
      level: "AD",
      inventory: { campaigns: 0, adSets: 0, ads: 0 },
      insightRowCount: 0,
      candidateCount: 0,
      scannedCount,
      eligibleCount,
      criticalCount,
      anomalyCount,
    };
    const syncSummary = (): void => {
      summary.scannedCount = scannedCount;
      summary.eligibleCount = eligibleCount;
      summary.criticalCount = criticalCount;
      summary.anomalyCount = anomalyCount;
    };

    try {
      // --- 1. Account authorization + attributes (READ, real) -----------------
      const accounts = await this.readList("meta.accounts", "accounts", {}, caller);
      if (!accounts.ok) {
        void this.audit(caller, accountId, "READ_FAILED", "failure", traceId);
        return this.noAnalysis(
          "READ_FAILED",
          accounts.error,
          "Could not verify the ad account against the Meta API.",
          undefined,
          traceId
        );
      }
      const mine = accounts.data.find(
        (a) => String(a["accountId"] ?? a["id"]) === accountId
      );
      if (!mine) {
        return this.noAnalysis(
          "ACCOUNT_UNAUTHORIZED",
          `Account ${accountId} is not listed for the configured token`,
          "The configured token cannot access this ad account. Analysis stops before any other request.",
          undefined,
          traceId
        );
      }
      const currency = String(mine["currency"] ?? "INR");
      const timezone = String(mine["timezoneName"] ?? mine["timezone_name"] ?? "America/Los_Angeles");
      const now = this.nowFn();

      // --- 2. Inventory (READ, bounded) ----------------------------------------
      const inventoryParams = { accountId, limit: this.config.maxEntitiesScanned };
      const campaignsRes = await this.readList("meta.campaigns", "campaigns", inventoryParams, caller);
      const adSetsRes = await this.readList("meta.adsets", "adSets", inventoryParams, caller);
      const adsRes = await this.readList("meta.ads", "ads", inventoryParams, caller);
      const failedRead = [campaignsRes, adSetsRes, adsRes].find((r) => !r.ok);
      if (failedRead && !failedRead.ok) {
        void this.audit(caller, accountId, "READ_FAILED", "failure", traceId);
        return this.noAnalysis(
          "READ_FAILED",
          failedRead.error,
          "Could not load the account's campaigns, ad sets or ads.",
          undefined,
          traceId
        );
      }
      const campaigns = campaignsRes.ok ? campaignsRes.data : [];
      const adSets = adSetsRes.ok ? adSetsRes.data : [];
      const ads = adsRes.ok ? adsRes.data : [];
      summary.inventory = { campaigns: campaigns.length, adSets: adSets.length, ads: ads.length };

      // --- 3. Daily insights (READ, one bounded call) --------------------------
      const start = this.dateInTimezone(now, timezone, -(this.config.lookbackDays));
      const end = this.dateInTimezone(now, timezone, 0);
      const insRes = await this.readList("meta.insights", "insights", {
        accountId,
        startDate: start,
        endDate: end,
        level: "ad",
        timeIncrement: 1,
        limit: this.config.maxInsightRows,
      }, caller);
      if (!insRes.ok) {
        void this.audit(caller, accountId, "READ_FAILED", "failure", traceId);
        return this.noAnalysis(
          "READ_FAILED",
          insRes.error,
          "Could not load daily ad performance from the Meta API.",
          undefined,
          traceId
        );
      }
      const insightRows = insRes.data;
      summary.insightRowCount = insightRows.length;
      if (insightRows.length === 0) {
        return this.noAnalysis(
          "INSUFFICIENT_DATA",
          `No daily rows returned for ${start}..${end}`,
          "The account returned no performance data in the analysis window, so nothing can be analysed.",
          summary,
          traceId,
          accountId
        );
      }
      syncSummary();

      // --- 4. Candidate selection (deterministic, capped) ----------------------
      let level: "AD" | "AD_SET" = "AD";
      let candidates = ads
        .filter((a) => String(a["status"]) === "ACTIVE")
        .map((a) => ({
          id: String(a["adId"]),
          name: String(a["name"] ?? "") || String(a["adId"]),
          campaignId: a["campaignId"] ? String(a["campaignId"]) : undefined,
          adSetId: a["adSetId"] ? String(a["adSetId"]) : undefined,
          objective: typeof a["objective"] === "string" ? (a["objective"] as string) : undefined,
        }))
        .sort((x, y) => x.id.localeCompare(y.id));

      if (candidates.length === 0) {
        level = "AD_SET";
        candidates = adSets
          .filter((a) => String(a["status"]) === "ACTIVE")
          .map((a) => ({
            id: String(a["adSetId"]),
            name: String(a["name"] ?? "") || String(a["adSetId"]),
            campaignId: a["campaignId"] ? String(a["campaignId"]) : undefined,
            adSetId: a["adSetId"] ? String(a["adSetId"]) : undefined,
            objective: typeof a["objective"] === "string" ? (a["objective"] as string) : undefined,
          }))
          .sort((x, y) => x.id.localeCompare(y.id));
      }
      // Hard cap — no unlimited entity loops. Deterministic id order keeps a
      // retried run scanning the same entities.
      candidates = candidates.slice(0, this.config.maxEntitiesScanned);
      summary.level = level;
      summary.candidateCount = candidates.length;

      // --- 5. Per-entity deterministic scan -------------------------------------
      const scored: Array<{
        target: AnalysisTargetInfo;
        baseline: NormalizedPerformanceRecord[];
        current: NormalizedPerformanceRecord[];
        comparison: ReturnType<typeof comparePerformanceSummaries>;
        anomalies: MarketingAnomaly[];
      }> = [];

      const staleBefore = this.dateInTimezone(now, timezone, -(this.config.staleDataDelayDays));
      for (const c of candidates) {
        scannedCount += 1;
        const rows = normalizeInsightRows(insightRows, {
          accountId,
          entityType: level,
          entityId: c.id,
          startDate: start,
          endDate: end,
          currency,
          timezone,
        })
          .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
          .sort((a, b) => a.date.localeCompare(b.date));

        if (rows.length < this.config.minBaselineDays + 1) continue; // baseline + current day
        const currentDay = rows[rows.length - 1];
        if (currentDay.spend <= 0) continue;
        if (currentDay.date < staleBefore) continue; // stale — not eligible

        const baseDays = rows.slice(Math.max(0, rows.length - 1 - this.config.lookbackDays), -1).slice(-this.config.lookbackDays);
        if (baseDays.length < this.config.minBaselineDays) continue;
        eligibleCount += 1;

        const currentSummary = aggregatePerformanceRecords([currentDay], {
          accountId,
          level,
          entityId: c.id,
          entityName: c.name,
          windowType: "custom",
          startDate: currentDay.date,
          endDate: currentDay.date,
          source: "meta-insights",
        });
        const baselineSummary = aggregatePerformanceRecords(baseDays, {
          accountId,
          level,
          entityId: c.id,
          entityName: c.name,
          windowType: "custom",
          startDate: baseDays[0].date,
          endDate: baseDays[baseDays.length - 1].date,
          source: "meta-insights",
        });
        const comparison = comparePerformanceSummaries(currentSummary, baselineSummary);
        const anomalies = detectAnomalies(baseDays, currentSummary);
        anomalyCount += anomalies.length;

        const criticals = anomalies.filter((a) => a.severity === "CRITICAL");
        if (criticals.length === 0) continue;

        criticalCount += 1;
        scored.push({
          target: {
            id: c.id,
            name: c.name,
            entityLevel: level,
            campaignId: c.campaignId,
            adSetId: c.adSetId,
            criticalCount: criticals.length,
            warningCount: anomalies.filter((a) => a.severity === "WARNING").length,
            maxDeviation: anomalies.reduce(
              (m, a) => Math.max(m, Math.abs(a.percentDeviation ?? 0)),
              0
            ),
            currentDay: currentDay.date,
            baselineDays: baseDays.length,
          },
          baseline: baseDays,
          current: [currentDay],
          comparison,
          anomalies,
        });
        syncSummary();
      }
      syncSummary();

      // --- 6. Deterministic target selection -------------------------------------
      if (scored.length === 0) {
        return this.noAnalysis(
          "NO_SAFE_TARGET",
          `Scanned ${scannedCount} entities; none exhibits a CRITICAL negative anomaly with an eligible baseline`,
          "No active ad entity currently exhibits a critical negative anomaly with enough history to act on.",
          summary,
          traceId,
          accountId
        );
      }
      scored.sort(
        (a, b) => b.target.maxDeviation - a.target.maxDeviation || a.target.id.localeCompare(b.target.id)
      );
      const chosen = scored[0];
      summary.topTarget = chosen.target;

      // --- 7. Evidence package ----------------------------------------------------
      const pkg = buildEvidencePackage({
        accountId,
        comparison: chosen.comparison,
        anomalies: chosen.anomalies,
        objective: this.objectiveFor(chosen.target, level, ads, adSets),
      });

      // --- 8. Diagnosis (real AI, one bounded call, limited retries) --------------
      let diagnosis: DiagnosisResult | null = null;
      let lastOutcome: DiagnosisOutcome | null = null;
      for (let attempt = 1; attempt <= this.config.diagnosisAttempts && !diagnosis; attempt++) {
        const out = await this.diagnosisEngine.diagnose(pkg, {
          userId: caller.userId,
          traceId,
        });
        if (out.status === "SUCCESS") {
          diagnosis = out.diagnosis;
          break;
        }
        lastOutcome = out;
        // Provider-level failures are NOT retried: the fallback chain already
        // ran; hammering it again just costs time.
        if (out.status === "FAILED") break;
      }
      if (!diagnosis) {
        const detail =
          lastOutcome && "reason" in lastOutcome
            ? `diagnosis ${lastOutcome.status}/${String(lastOutcome.reason)}: ${"detail" in lastOutcome && lastOutcome.detail ? lastOutcome.detail : ""}`
            : "no diagnosis produced";
        void this.audit(caller, accountId, "DIAGNOSIS_UNAVAILABLE", "failure", traceId);
        return this.noAnalysis(
          "DIAGNOSIS_UNAVAILABLE",
          detail,
          "The AI diagnosis could not be produced or verified, so no recommendation was created. Refusing to fabricate one.",
          summary,
          traceId,
          accountId
        );
      }

      if (input.dryRun) {
        await this.audit(caller, accountId, "DRY_RUN_OK", "success", traceId);
        return {
          status: "DRY_RUN_OK",
          accountId,
          target: chosen.target,
          scanSummary: summary,
          diagnosis,
          wouldRunGenerate: true,
          traceId,
        };
      }

      // --- 9. Durable recommendation ------------------------------------------------
      const externalState = createExecutorBackedExternalStatePort({
        executor: this.deps.executor,
        userId: caller.userId,
        role: caller.role,
      });
      const externalStatePort: ExternalStatePort = {
        loadState: (accountId_, _entityLevel, entityId) =>
          externalState(accountId_, entityId, {
            userId: caller.userId,
            role: caller.role,
          }),
      };
      const recommendationEngine = new RecommendationEngine(
        this.deps.store,
        externalStatePort,
        this.config.recommendation ?? {},
        this.nowFn
      );

      let recommendation: RecommendationOutcome;
      try {
        recommendation = await recommendationEngine.generate({
          userId: caller.userId,
          diagnosis,
          evidence: pkg,
          ...(traceId ? { traceId } : {}),
        });
      } catch {
        // Persistence failure fails the whole run closed. The detail is a
        // fixed, operator-oriented string — never the store's exception text.
        void this.audit(caller, accountId, "PERSIST_FAILED", "failure", traceId);
        return this.noAnalysis(
          "PERSIST_FAILED",
          "persistence failed",
          "The recommendation could not be persisted, so none was created.",
          summary,
          traceId,
          accountId
        );
      }

      await this.audit(
        caller,
        accountId,
        `recommendation.${recommendation.status}`,
        recommendation.status === "CREATED" ? "success" : "rejected",
        traceId
      );

      return {
        status: "COMPLETED",
        accountId,
        recommendation,
        recommendationId:
          recommendation.status === "CREATED" ? recommendation.recommendation.recommendationId : undefined,
        target: chosen.target,
        scanSummary: summary,
        diagnosis,
        explanation:
          recommendation.status === "NO_RECOMMENDATION"
            ? this.explainNoRecommendation(recommendation)
            : undefined,
        traceId,
      };
    } finally {
      if (this.config.inFlightGuard !== false) {
        this.inFlight.delete(guardKey);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Human-facing explanation for a no-action engine verdict. */
  private explainNoRecommendation(
    rec: Extract<RecommendationOutcome, { status: "NO_RECOMMENDATION" }>
  ): AnalysisExplanation {
    const messages: Record<string, string> = {
      CATEGORY_NOT_ACTIONABLE: "No safe action exists for this diagnosis category.",
      NO_SPEND_ACTION_TRACKING_ISSUE: "The diagnosis points to a tracking issue, not an actionable spend problem.",
      INVESTIGATION_REQUIRED: "The diagnosis requires investigation rather than a spend action.",
      STALE_EVIDENCE: "The evidence for this entity is stale; refresh before acting.",
      WARMUP_PERIOD: "This entity is still in warmup; acting now would be noise.",
      INSUFFICIENT_DATA_QUALITY: "Data quality for this entity is too low to act on.",
      LOW_CONFIDENCE: "Diagnosis confidence is too low to justify an action.",
      CONTRADICTORY_HISTORICAL_EVIDENCE: "Past outcomes for this entity contradict the current signal.",
      NO_NEGATIVE_ANOMALIES: "No significant negative anomalies back an action.",
      INSUFFICIENT_SEVERITY: "The anomalies found are not severe enough to justify an action.",
      ENTITY_NOT_FOUND: "The target entity is no longer resolvable on Meta.",
      ENTITY_DELETED: "The target entity was deleted or archived on Meta.",
      GUARDRAIL_EXCEEDED: "The action would exceed server-side budget guardrails.",
      INVALID_INPUT: "The diagnosis and evidence failed validation.",
      PRECONDITION_FAILED: "A precondition for the action is not met.",
    };
    return {
      reason: rec.reason,
      message: `${messages[rec.reason] ?? "No safe action exists."} ${rec.detail}`,
    };
  }

  private objectiveFor(
    target: AnalysisTargetInfo,
    level: "AD" | "AD_SET",
    ads: Array<Record<string, unknown>>,
    adSets: Array<Record<string, unknown>>
  ): string | undefined {
    if (level === "AD") {
      const hit = ads.find((a) => String(a["adId"]) === target.id);
      return typeof hit?.["objective"] === "string" ? (hit["objective"] as string) : undefined;
    }
    const hit = adSets.find((a) => String(a["adSetId"]) === target.id);
    return typeof hit?.["objective"] === "string" ? (hit["objective"] as string) : undefined;
  }

  private noAnalysis(
    reason: AnalysisNoAnalysisReason,
    detail: string,
    message: string,
    scanSummary: AnalysisScanSummary | undefined,
    traceId: string | undefined,
    accountId?: string
  ): AnalysisOutcome {
    const outcome: AnalysisOutcome = {
      status: "NO_ANALYSIS",
      reason,
      detail,
      message,
      ...(scanSummary ? { scanSummary } : {}),
      ...(accountId ? { accountId } : {}),
      ...(traceId ? { traceId } : {}),
    };
    return outcome;
  }

  private async readList(
    toolId: string,
    listKey: string,
    params: Record<string, unknown>,
    caller: AnalysisCaller
  ): Promise<{ ok: true; data: Array<Record<string, unknown>> } | { ok: false; error: string }> {
    try {
      const res = await this.deps.executor.execute({
        toolId,
        params,
        userId: caller.userId,
        role: caller.role,
        traceId: caller.traceId ?? crypto.randomUUID(),
      });
      if (res.status !== "completed" || !res.result?.success) {
        return { ok: false, error: res.error ?? `${toolId} failed` };
      }
      const payload = res.result.data as Record<string, unknown> | null;
      const list = payload?.[listKey];
      if (!Array.isArray(list)) return { ok: false, error: `${toolId} returned no ${listKey} list` };
      return { ok: true, data: list as Array<Record<string, unknown>> };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 160) : `${toolId} threw` };
    }
  }

  /** YYYY-MM-DD for the account's timezone, offset by N days from `now`. */
  private dateInTimezone(now: Date, timezone: string, offsetDays: number): string {
    const d = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(d);
  }

  private async audit(
    caller: AnalysisCaller,
    accountId: string,
    outcome: string,
    result: "success" | "failure" | "rejected" | "pending",
    traceId: string | undefined
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.log({
        userId: caller.userId,
        agentId: caller.agentId,
        toolId: "meta.analyze",
        action: "meta.analyze",
        parameters: JSON.parse(
          redactSecrets(JSON.stringify({ at: this.nowFn().toISOString(), accountId, outcome }))
        ) as Record<string, unknown>,
        result,
        traceId,
        ipAddress: caller.ipAddress,
      });
    } catch {
      // Audit must never crash the analysis that already happened.
    }
  }
}