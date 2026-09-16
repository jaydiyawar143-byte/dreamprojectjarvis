import { randomUUID } from "node:crypto";
import type { IToolExecutor } from "./types/execution.js";
import {
  aggregatePerformanceRecords,
  formatDateInTimezone,
} from "./performance-aggregator.js";
import { normalizeInsightRows } from "./insight-rows.js";
import {
  measureOutcome,
  checkMeasurementState,
} from "./outcome-engine.js";
import {
  type OutcomeRecord,
  type OutcomeStorePort,
  type OutcomeRevision,
  type BaselineKPIValues,
} from "./types/outcome.js";

// ---------------------------------------------------------------------------
// Phase 11.7B — Outcome Measurement Worker
// ---------------------------------------------------------------------------
// Scans, locks, groups, and batch-processes pending measurements.
// Guarantees:
//   - Idempotent execution (lease-based state locking).
//   - Bounded processing with zero N+1 Meta requests (batch by account).
//   - Zero LLM/AI calls.
//   - Graceful retry of rate limits/timeouts (safe rollbacks to READY).
//   - Revision creation for late-arriving conversions (preserving history).
// ---------------------------------------------------------------------------

export interface OutcomeWorkerConfig {
  /** How long a lease lasts in COLLECTING state (default 5 minutes). */
  leaseDurationMs?: number;
  /** Max records to process in a single sweep. */
  maxBatchSize?: number;
}

export interface OutcomeWorkerResult {
  processedCount: number;
  finalizedCount: number;
  revisionCount: number;
  failedCount: number;
  errors: string[];
}

export class OutcomeWorker {
  private leaseDurationMs: number;
  private maxBatchSize: number;

  constructor(
    private executor: IToolExecutor,
    private outcomeRepo: OutcomeStorePort,
    config?: OutcomeWorkerConfig
  ) {
    this.leaseDurationMs = config?.leaseDurationMs ?? 5 * 60 * 1000;
    this.maxBatchSize = config?.maxBatchSize ?? 100;
  }

  /**
   * Run a single sweep over all due measurements.
   */
  async processDue(): Promise<OutcomeWorkerResult> {
    const result: OutcomeWorkerResult = {
      processedCount: 0,
      finalizedCount: 0,
      revisionCount: 0,
      failedCount: 0,
      errors: [],
    };

    const expiredTime = new Date(Date.now() - this.leaseDurationMs).toISOString();

    try {
      // 1. Retrieve records due for processing (non-finalized, expired leases)
      const dueRecords = await this.outcomeRepo.findDueOutcomes(
        this.maxBatchSize,
        expiredTime
      );

      if (dueRecords.length > 0) {
        // 2. Filter records where the stabilization window has actually elapsed
        const eligibleRecords: OutcomeRecord[] = [];
        for (const record of dueRecords) {
          // Calculate the measurement window dates from executedAt and config
          // Let's find the executedAt timestamp. It's stored in record.baseline.fetchedAt
          // (the exact time the baseline was captured, which is when recommendation execution finished)
          const executedAtIso = record.baseline.fetchedAt;
          const state = checkMeasurementState(executedAtIso, record.measurementWindow);

          if (state === "READY") {
            eligibleRecords.push(record);
          } else {
            // If it is WAITING_FOR_DATA or WAITING_FOR_ATTRIBUTION, update the state in DB
            // so we don't keep polling it as READY/due
            if (record.measurementState !== state) {
              await this.outcomeRepo.updateMeasurementState(
                record.outcomeId,
                record.userId,
                state
              );
            }
          }
        }

        if (eligibleRecords.length > 0) {
          // 3. Atomically claim records by transitioning them to COLLECTING
          const claimedRecords: OutcomeRecord[] = [];
          for (const record of eligibleRecords) {
            const success = await this.outcomeRepo.claimOutcome(
              record.outcomeId,
              expiredTime
            );
            if (success) {
              claimedRecords.push(record);
            }
          }

          if (claimedRecords.length > 0) {

      // 4. Group claimed records by accountId to batch Meta API requests (avoid N+1)
      const recordsByAccount = new Map<string, OutcomeRecord[]>();
      for (const record of claimedRecords) {
        const list = recordsByAccount.get(record.accountId) ?? [];
        list.push(record);
        recordsByAccount.set(record.accountId, list);
      }

      // 5. Process each account group
      for (const [accountId, records] of recordsByAccount.entries()) {
        const userId = records[0]!.userId;

        try {
          // Find the minimum start date and maximum end date of all measurement windows in this group
          let minStart = new Date();
          let maxEnd = new Date(0);

          for (const record of records) {
            const executedAt = new Date(record.baseline.fetchedAt);
            const start = new Date(executedAt.getTime() + record.measurementWindow.stabilizationMs);
            const end = new Date(start.getTime() + record.measurementWindow.measurementMs);

            if (start < minStart) minStart = start;
            if (end > maxEnd) maxEnd = end;
          }

          // Format date strings in timezone of the baseline (all same account share same timezone/currency)
          const timezone = records[0]!.baseline.timezone;
          const currency = records[0]!.baseline.currency;
          const startDateStr = formatDateInTimezone(minStart, timezone);
          const endDateStr = formatDateInTimezone(maxEnd, timezone);

          // Fetch insights for the whole account at ad level (high granularity)
          const insRes = await this.executor.execute({
            toolId: "meta.insights",
            params: {
              accountId,
              startDate: startDateStr,
              endDate: endDateStr,
              level: "ad",
              timeIncrement: 1,
              limit: 500,
            },
            userId,
            role: "member",
            traceId: randomUUID(),
          });

          if (insRes.status !== "completed" || !insRes.result?.success) {
            const errMsg = insRes.error || "Failed to fetch daily insights";
            throw new Error(`Meta insights error for account ${accountId}: ${errMsg}`);
          }

          const rawRows = (insRes.result.data as { insights?: Array<Record<string, unknown>> }).insights ?? [];

          // Process each record using the loaded batch insights
          for (const record of records) {
            result.processedCount++;
            try {
              // Calculate record's specific measurement start/end dates
              const executedAt = new Date(record.baseline.fetchedAt);
              const startMs = executedAt.getTime() + record.measurementWindow.stabilizationMs;
              const endMs = startMs + record.measurementWindow.measurementMs;
              const recStartStr = formatDateInTimezone(new Date(startMs), timezone);
              const recEndStr = formatDateInTimezone(new Date(endMs), timezone);

              // Filter insights for this record's entity and specific measurement window dates
              const entityId = record.entityId;
              const entityType = record.entityType;

              // R-32 — the filter/map rule now lives in one place.
              const filteredRows = normalizeInsightRows(rawRows, {
                accountId: record.accountId,
                entityType,
                entityId,
                startDate: recStartStr,
                endDate: recEndStr,
                currency,
                timezone,
              });

              const daysWithData = new Set(filteredRows.map((r) => r.date)).size;
              const mostRecentDataPointAt = filteredRows[filteredRows.length - 1]?.date
                ? new Date(filteredRows[filteredRows.length - 1]!.date).toISOString()
                : null;

              // Aggregate to build the PerformanceSummary
              const summary = aggregatePerformanceRecords(filteredRows, {
                accountId: record.accountId,
                level: entityType,
                entityId,
                windowType: "custom",
                startDate: recStartStr,
                endDate: recEndStr,
                source: "meta-insights",
                allowEmpty: true,
              });

              // Extract current KPIs
              const currentKPIs: BaselineKPIValues = {
                spend: summary.kpis.spend,
                impressions: summary.kpis.impressions,
                clicks: summary.kpis.clicks,
                reach: summary.kpis.reach,
                conversions: summary.kpis.conversions,
                revenue: summary.kpis.revenue,
                ctr: summary.kpis.ctr,
                cpc: summary.kpis.cpc,
                cpm: summary.kpis.cpm,
                cpa: summary.kpis.cpa,
                roas: summary.kpis.roas,
                cvr: summary.kpis.cvr,
                frequency: summary.kpis.frequency,
              };

              // Run the deterministic outcome engine measurement pipeline
              const measurementResult = measureOutcome({
                outcomeId: record.outcomeId,
                // R-32 — a re-measure must not strip the category the record
                // was created with.
                diagnosisCategory: record.diagnosisCategory,
                recommendationId: record.recommendationId,
                executionId: record.executionId,
                accountId: record.accountId,
                entityType: record.entityType,
                entityId: record.entityId,
                actionType: record.actionType,
                objective: record.objective,
                primaryMetric: record.primaryMetric,
                baseline: record.baseline,
                executedAtIso: record.baseline.fetchedAt,
                currentRawInputs: currentKPIs,
                dataQuality: summary.quality === "COMPLETE" ? "COMPLETE" : "PARTIAL",
                daysWithData,
                mostRecentDataPointAt,
                referenceNow: new Date(),
                userId: record.userId,
              });

              const outcomeRecord = measurementResult.outcomeRecord;
              const sufficiency = measurementResult.sufficiency;

              // Determine if window is fully elapsed (no more data can accumulate)
              const elapsedMs = Date.now() - executedAt.getTime();
              const maxWindowMs = record.measurementWindow.stabilizationMs + record.measurementWindow.measurementMs;
              const isWindowClosed = elapsedMs >= maxWindowMs;

              if (sufficiency.sufficient || isWindowClosed) {
                // Sufficient data exists OR window is fully closed → finalize!
                const finalized = await this.outcomeRepo.finalize(
                  record.outcomeId,
                  userId,
                  outcomeRecord.outcome!,
                  outcomeRecord.confidence!,
                  new Date().toISOString()
                );

                if (finalized) {
                  // Save full measurement & comparison back to the record
                  await this.outcomeRepo.updateMeasurementState(
                    record.outcomeId,
                    userId,
                    "FINALIZED",
                    {
                      measurement: currentKPIs,
                      comparison: outcomeRecord.comparison,
                      dataQuality: outcomeRecord.dataQuality,
                      attributionStatus: outcomeRecord.attributionStatus,
                      confounders: outcomeRecord.confounders,
                    }
                  );
                  result.finalizedCount++;
                }
              } else {
                // Insufficient data & window still running → release to READY for retry later
                await this.outcomeRepo.releaseOutcome(record.outcomeId, "READY");
              }
            } catch (err) {
              result.failedCount++;
              result.errors.push(err instanceof Error ? err.message : String(err));
              await this.outcomeRepo.releaseOutcome(record.outcomeId, "READY");
            }
          }
        } catch (err) {
          // If the whole batch/account fetch fails (timeout, rate limit, DB failure), release all group records back to READY
          result.errors.push(err instanceof Error ? err.message : String(err));
          for (const record of records) {
            result.failedCount++;
            await this.outcomeRepo.releaseOutcome(record.outcomeId, "READY");
          }
        }
        }
      }
    }
  }

  // 6. Check recently finalized outcomes to evaluate late-arriving conversions (attributions)
      const finalizedToCheck = await this.outcomeRepo.findRecentlyFinalized(this.maxBatchSize);
      for (const record of finalizedToCheck) {
        try {
          const executedAt = new Date(record.baseline.fetchedAt);
          const startMs = executedAt.getTime() + record.measurementWindow.stabilizationMs;
          const endMs = startMs + record.measurementWindow.measurementMs;
          const recStartStr = formatDateInTimezone(new Date(startMs), record.baseline.timezone);
          const recEndStr = formatDateInTimezone(new Date(endMs), record.baseline.timezone);

          // Get latest insights again for this record's measurement window
          const insRes = await this.executor.execute({
            toolId: "meta.insights",
            params: {
              accountId: record.accountId,
              startDate: recStartStr,
              endDate: recEndStr,
              level: "ad",
              timeIncrement: 1,
              limit: 500,
            },
            userId: record.userId,
            role: "member",
            traceId: randomUUID(),
          });

          if (insRes.status === "completed" && insRes.result?.success) {
            const rawRows = (insRes.result.data as { insights?: Array<Record<string, unknown>> }).insights ?? [];
            const filteredRows = rawRows
              .filter((r) => {
                if (record.entityType === "CAMPAIGN") return String(r.campaignId ?? "") === record.entityId;
                if (record.entityType === "AD_SET") return String(r.adsetId ?? "") === record.entityId;
                if (record.entityType === "AD") return String(r.adId ?? "") === record.entityId;
                return true;
              })
              .map((r) => ({
                accountId: record.accountId,
                date: String(r.dateStart || r.dateStop || ""),
                spend: parseFloat(String(r.spend ?? "0")) || 0,
                impressions: parseInt(String(r.impressions ?? "0"), 10) || 0,
                clicks: parseInt(String(r.clicks ?? "0"), 10) || 0,
                reach: parseInt(String(r.reach ?? "0"), 10) || 0,
                conversions: parseFloat(String(r.conversions ?? "0")) || 0,
                revenue: (parseFloat(String(r.roas ?? "0")) || 0) * (parseFloat(String(r.spend ?? "0")) || 0),
                currency: record.baseline.currency,
                timezone: record.baseline.timezone,
              }));

            const daysWithData = new Set(filteredRows.map((r) => r.date)).size;
            const mostRecentDataPointAt = filteredRows[filteredRows.length - 1]?.date
              ? new Date(filteredRows[filteredRows.length - 1]!.date).toISOString()
              : null;

            const summary = aggregatePerformanceRecords(filteredRows, {
              accountId: record.accountId,
              level: record.entityType,
              entityId: record.entityId,
              windowType: "custom",
              startDate: recStartStr,
              endDate: recEndStr,
              source: "meta-insights",
              allowEmpty: true,
            });

            const currentKPIs: BaselineKPIValues = {
              spend: summary.kpis.spend,
              impressions: summary.kpis.impressions,
              clicks: summary.kpis.clicks,
              reach: summary.kpis.reach,
              conversions: summary.kpis.conversions,
              revenue: summary.kpis.revenue,
              ctr: summary.kpis.ctr,
              cpc: summary.kpis.cpc,
              cpm: summary.kpis.cpm,
              cpa: summary.kpis.cpa,
              roas: summary.kpis.roas,
              cvr: summary.kpis.cvr,
              frequency: summary.kpis.frequency,
            };

            const measurementResult = measureOutcome({
              outcomeId: record.outcomeId,
              // R-32 — same on the revision path.
              diagnosisCategory: record.diagnosisCategory,
              recommendationId: record.recommendationId,
              executionId: record.executionId,
              accountId: record.accountId,
              entityType: record.entityType,
              entityId: record.entityId,
              actionType: record.actionType,
              objective: record.objective,
              primaryMetric: record.primaryMetric,
              baseline: record.baseline,
              executedAtIso: record.baseline.fetchedAt,
              currentRawInputs: currentKPIs,
              dataQuality: summary.quality === "COMPLETE" ? "COMPLETE" : "PARTIAL",
              daysWithData,
              mostRecentDataPointAt,
              referenceNow: new Date(),
              userId: record.userId,
            });

            const outcomeRecord = measurementResult.outcomeRecord;

            // If the verdict changes, create a new revision/version
            if (outcomeRecord.outcome && outcomeRecord.outcome !== record.outcome) {
              const revisionsRes = await this.outcomeRepo.getRevisions(record.outcomeId, record.userId, { limit: 1 });
              const nextRevNum = revisionsRes.total + 1;

              const revision: OutcomeRevision = {
                id: randomUUID(),
                outcomeId: record.outcomeId,
                revisionNumber: nextRevNum,
                outcomeEnum: outcomeRecord.outcome,
                confidence: outcomeRecord.confidence!,
                dataQuality: outcomeRecord.dataQuality!,
                attributionStatus: outcomeRecord.attributionStatus,
                confounders: outcomeRecord.confounders,
                measurementKpis: currentKPIs,
                comparison: outcomeRecord.comparison!,
                measuredAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
              };

              await this.outcomeRepo.createRevision(revision);
              result.revisionCount++;
            }
          }
        } catch (err) {
          result.errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }

    return result;
  }
}
