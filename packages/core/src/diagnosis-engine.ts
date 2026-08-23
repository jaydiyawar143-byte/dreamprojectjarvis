import type {
  AICompletionRequest,
  AICompletionResponse,
  IAIProvider,
} from "./types/ai-provider.js";
import type { EvidencePackage } from "./types/diagnosis.js";
import {
  DiagnosisResultSchema,
  EvidencePackageSchema,
  ModelBatchDiagnosisSchema,
  type ConfidenceLevel,
  type DiagnosisAuditRecord,
  type DiagnosisFailureReason,
  type DiagnosisOutcome,
  type ModelDiagnosis,
  type NoDiagnosisReason,
  MarketingHypothesisSchema,
  MarketingInferenceSchema,
  MarketingFactSchema,
} from "./types/diagnosis.js";
import { compressEvidencePackage } from "./evidence-builder.js";
import { buildDiagnosisMessages } from "./diagnosis-prompt.js";
import {
  applyConfidenceCaps,
  verifyDiagnosisAgainstEvidence,
} from "./diagnosis-verification.js";
import { computeParamsHash } from "./utils/params-hash.js";
import { redactSecrets } from "./utils/redact-secrets.js";

// ---------------------------------------------------------------------------
// Evidence-Based AI Diagnosis Engine — Phase 11.4
// ---------------------------------------------------------------------------
// Pipeline:
//   EvidencePackage → (compress) → prompt → IAIProvider (OpenAI OR Claude)
//     → JSON extraction → Zod .strict() validation
//     → deterministic evidence verification → confidence caps
//     → secret redaction → accepted diagnosis + audit record
//
// Safety properties:
//   - Provider-agnostic: works with any IAIProvider; no provider-specific logic.
//   - Read-only: the engine only calls complete() with NO tools, touches no
//     Meta resource, mutates nothing, executes nothing.
//   - Fail-closed: malformed output, schema violations, fabricated evidence,
//     timeouts, rate limits and outages all yield safe non-executing outcomes.
//   - Cost control: one compact batched call per chunk of entities
//     (default maxEntitiesPerCall = 5), never one call per metric/ad.
//   - Cache/dedup: key = account|user|entity|evidenceHash|provider|model, TTL-bounded.
// ---------------------------------------------------------------------------

export interface DiagnosisEngineOptions {
  /** Max entities per LLM call (batching). Default 5. */
  maxEntitiesPerCall?: number;
  /** Context budget in characters for serialized evidence. Default 24000. */
  maxEvidenceChars?: number;
  /** Cap on untrusted marketing text length per label in prompts. Default 200. */
  maxUntrustedTextChars?: number;
  /** Provider call timeout ms. Default 30000. */
  timeoutMs?: number;
  /** Enable diagnosis cache/dedup. Default true. */
  cacheEnabled?: boolean;
  /** Cache TTL ms. Default 6h. */
  cacheTtlMs?: number;
  /** Deterministic clock for tests. */
  now?: () => Date;
  /** Audit sink — receives one record per outcome. */
  auditSink?: (record: DiagnosisAuditRecord) => void;
}

interface CacheEntry {
  expiresAt: number;
  outcome: DiagnosisOutcome;
}

const DEFAULTS = {
  maxEntitiesPerCall: 5,
  maxEvidenceChars: 24000,
  maxUntrustedTextChars: 200,
  timeoutMs: 30000,
  cacheTtlMs: 6 * 60 * 60 * 1000,
} as const;

/**
 * Expected LLM call count for a diagnoseMany run over N entities:
 *   ceil(N / maxEntitiesPerCall)
 * e.g. 100 campaigns / 500 ad sets / 2,000 ads ⇒ ceil(2600/5) = 520 calls,
 * NOT 2,600. Anomalies for the same entity are always batched into the same
 * single call via their shared EvidencePackage.
 */
export function expectedLLMCallCount(entityCount: number, maxEntitiesPerCall = DEFAULTS.maxEntitiesPerCall): number {
  return Math.max(1, Math.ceil(entityCount / maxEntitiesPerCall));
}

function classifyProviderError(err: unknown): DiagnosisFailureReason {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/timeout|timed?\s*out|abort/i.test(msg)) return "PROVIDER_TIMEOUT";
  if (/429|rate\s*limit/i.test(msg)) return "PROVIDER_RATE_LIMITED";
  return "PROVIDER_UNAVAILABLE";
}

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("malformed_output:no_json_object");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    throw new Error(`malformed_output:invalid_json:${(err as Error).message}`);
  }
}

export class DiagnosisEngine {
  private readonly opts: Required<Pick<
    DiagnosisEngineOptions,
    "maxEntitiesPerCall" | "maxEvidenceChars" | "maxUntrustedTextChars" | "timeoutMs" | "cacheTtlMs"
  >> & { cacheEnabled: boolean; now: () => Date; auditSink?: (r: DiagnosisAuditRecord) => void };
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly provider: IAIProvider,
    options: DiagnosisEngineOptions = {}
  ) {
    this.opts = {
      maxEntitiesPerCall: options.maxEntitiesPerCall ?? DEFAULTS.maxEntitiesPerCall,
      maxEvidenceChars: options.maxEvidenceChars ?? DEFAULTS.maxEvidenceChars,
      maxUntrustedTextChars: options.maxUntrustedTextChars ?? DEFAULTS.maxUntrustedTextChars,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      cacheTtlMs: options.cacheTtlMs ?? DEFAULTS.cacheTtlMs,
      cacheEnabled: options.cacheEnabled ?? true,
      now: options.now ?? (() => new Date()),
      auditSink: options.auditSink,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  /** Diagnose a single entity's evidence package. */
  async diagnose(
    pkg: EvidencePackage,
    ctx: { userId?: string; traceId?: string } = {}
  ): Promise<DiagnosisOutcome> {
    const outcomes = await this.diagnoseMany([pkg], ctx);
    return outcomes[0]!;
  }

  /**
   * Batch diagnosis: chunks packages so each provider call carries up to
   * maxEntitiesPerCall compressed evidence payloads.
   */
  async diagnoseMany(
    packages: EvidencePackage[],
    ctx: { userId?: string; traceId?: string } = {}
  ): Promise<DiagnosisOutcome[]> {
    const results: DiagnosisOutcome[] = [];
    for (let i = 0; i < packages.length; i += this.opts.maxEntitiesPerCall) {
      const chunk = packages.slice(i, i + this.opts.maxEntitiesPerCall);
      const chunkResults = await this.diagnoseChunk(chunk, ctx);
      results.push(...chunkResults);
    }
    return results;
  }

  // -------------------------------------------------------------------------

  private cacheKey(pkg: EvidencePackage, userId?: string): string {
    return [
      pkg.accountId,
      userId ?? "-",
      pkg.entityLevel,
      pkg.entityId,
      pkg.evidenceHash,
      this.provider.id,
      this.provider.defaultModel,
    ].join("|");
  }

  private baseAudit(pkg: EvidencePackage, ctx: { userId?: string; traceId?: string }): DiagnosisAuditRecord {
    return {
      diagnosisId: null,
      accountId: typeof pkg?.accountId === "string" ? pkg.accountId : "unknown",
      entityId: typeof pkg?.entityId === "string" ? pkg.entityId : "unknown",
      entityLevel: typeof pkg?.entityLevel === "string" ? pkg.entityLevel : "UNKNOWN",
      anomalyIds: Array.isArray(pkg?.anomalies) ? pkg.anomalies.map((a) => a.anomalyId) : [],
      evidenceHash: typeof pkg?.evidenceHash === "string" ? pkg.evidenceHash : "unknown",
      providerId: this.provider.id,
      model: this.provider.defaultModel,
      latencyMs: 0,
      validationResult: "SKIPPED",
      fromCache: false,
      generatedAt: this.opts.now().toISOString(),
      traceId: ctx.traceId,
      requestedByUserId: ctx.userId,
    };
  }

  private finish(audit: DiagnosisAuditRecord): void {
    this.opts.auditSink?.(audit);
  }

  private makeNoDiagnosis(
    reason: NoDiagnosisReason,
    audit: DiagnosisAuditRecord,
    detail?: string
  ): DiagnosisOutcome {
    audit.validationResult = reason === "VALIDATION_FAILED" || reason === "MALFORMED_OUTPUT" ? "REJECTED" : "NO_DIAGNOSIS";
    if (detail) audit.validationReason = detail.slice(0, 500);
    this.finish(audit);
    return { status: "NO_DIAGNOSIS", reason, ...(detail ? { detail: detail.slice(0, 500) } : {}), audit };
  }

  private makeFailure(
    reason: DiagnosisFailureReason,
    audit: DiagnosisAuditRecord,
    detail?: string
  ): DiagnosisOutcome {
    audit.validationResult = "FAILED";
    audit.validationReason = (detail ?? reason).slice(0, 500);
    this.finish(audit);
    return { status: "FAILED", reason, ...(detail ? { detail: detail.slice(0, 500) } : {}), audit };
  }

  private async diagnoseChunk(
    chunk: EvidencePackage[],
    ctx: { userId?: string; traceId?: string }
  ): Promise<DiagnosisOutcome[]> {
    const byEntity = new Map<string, { pkg: EvidencePackage; index: number }>();
    chunk.forEach((pkg, index) => byEntity.set(`${pkg.entityLevel}:${pkg.entityId}`, { pkg, index }));

    // Per-package pre-flight + cache lookup.
    const outcomes: DiagnosisOutcome[] = new Array(chunk.length);
    const pending: { pkg: EvidencePackage; index: number }[] = [];

    for (const { pkg, index } of byEntity.values()) {
      const parsedPkg = EvidencePackageSchema.safeParse(pkg);
      if (!parsedPkg.success) {
        outcomes[index] = this.makeFailure("INVALID_EVIDENCE_PACKAGE", this.baseAudit(pkg, ctx));
        continue;
      }
      if (parsedPkg.data.anomalies.length === 0) {
        outcomes[index] = this.makeNoDiagnosis("NO_ANOMALIES", this.baseAudit(parsedPkg.data, ctx), "nothing to explain");
        continue;
      }

      if (this.opts.cacheEnabled) {
        const key = this.cacheKey(parsedPkg.data, ctx.userId);
        const hit = this.cache.get(key);
        if (hit && hit.expiresAt > this.opts.now().getTime()) {
          const audit = this.baseAudit(parsedPkg.data, ctx);
          audit.validationResult = "CACHE_HIT";
          audit.fromCache = true;
          audit.generatedAt = new Date(hit.expiresAt - this.opts.cacheTtlMs).toISOString();
          if (hit.outcome.status === "SUCCESS") audit.diagnosisId = hit.outcome.diagnosis.diagnosisId;
          this.finish(audit);
          outcomes[index] = hit.outcome;
          continue;
        }
        if (hit) this.cache.delete(key); // stale
      }
      pending.push({ pkg: parsedPkg.data, index });
    }

    if (pending.length === 0) return outcomes;

    const startedAt = Date.now();
    let response: AICompletionResponse;

    // --- Compress to context budget (verification uses ORIGINAL packages).
    const compressed = pending.map(({ pkg }) =>
      compressEvidencePackage(pkg, Math.floor(this.opts.maxEvidenceChars / pending.length))
    );

    const messages = buildDiagnosisMessages(compressed.map((c) => c.pkg), this.opts.maxUntrustedTextChars);

    // --- Provider call with hard timeout (fail-safe even if provider ignores abort).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request: AICompletionRequest = {
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
        temperature: 0.1,
        maxTokens: 4000,
        requestId: `diag_${compressed[0]?.pkg.evidenceHash.slice(0, 12) ?? "na"}`,
        traceId: ctx.traceId,
        signal: controller.signal,
        // NOTE: tools intentionally NEVER set — diagnosis cannot invoke tools.
      };
      response = await Promise.race([
        this.provider.complete(request),
        new Promise<never>((_, reject) => {
          raceTimer = setTimeout(() => reject(new Error("provider timeout exceeded")), this.opts.timeoutMs);
        }),
      ]);
    } catch (err) {
      for (const { pkg, index } of pending) {
        outcomes[index] = this.makeFailure(classifyProviderError(err), this.baseAudit(pkg, ctx), (err as Error).message);
      }
      return outcomes;
    } finally {
      clearTimeout(timer);
      if (raceTimer) clearTimeout(raceTimer);
    }

    const latencyMs = Date.now() - startedAt;

    if (response.finishReason === "content_filter") {
      for (const { pkg, index } of pending) {
        outcomes[index] = this.makeFailure("PROVIDER_UNSAFE_CONTENT", this.auditWith(pkg, ctx, latencyMs, response.usage));
      }
      return outcomes;
    }
    if (response.message.toolCalls && response.message.toolCalls.length > 0) {
      // A diagnosis response must never attempt tool invocation.
      for (const { pkg, index } of pending) {
        outcomes[index] = this.makeNoDiagnosis("MALFORMED_OUTPUT", this.auditWith(pkg, ctx, latencyMs, response.usage), "unexpected tool_calls");
      }
      return outcomes;
    }

    // --- Parse + strict schema validation.
    const content = response.message.content ?? "";
    let rawJson: unknown;
    try {
      rawJson = extractJson(content);
    } catch (err) {
      for (const { pkg, index } of pending) {
        outcomes[index] = this.makeNoDiagnosis("MALFORMED_OUTPUT", this.auditWith(pkg, ctx, latencyMs, response.usage), (err as Error).message);
      }
      return outcomes;
    }

    const batchParsed = ModelBatchDiagnosisSchema.safeParse(rawJson);
    if (!batchParsed.success) {
      const reason = `schema_validation_failed:${batchParsed.error.issues[0]?.message ?? "unknown"}`;
      for (const { pkg, index } of pending) {
        outcomes[index] = this.makeNoDiagnosis("VALIDATION_FAILED", this.auditWith(pkg, ctx, latencyMs, response.usage), reason);
      }
      return outcomes;
    }

    // --- Match diagnoses to requested entities; verify each against ITS package.
    const claimedByEntity = new Map<string, ModelDiagnosis>();
    for (const d of batchParsed.data.diagnoses) {
      claimedByEntity.set(`${d.entityLevel}:${d.entityId}`, d);
    }

    for (const { pkg, index } of pending) {
      const audit = this.auditWith(pkg, ctx, latencyMs, response.usage);
      const candidate = claimedByEntity.get(`${pkg.entityLevel}:${pkg.entityId}`);
      if (!candidate) {
        outcomes[index] = this.makeNoDiagnosis("MISSING_FROM_BATCH_RESPONSE", audit);
        continue;
      }

      const report = verifyDiagnosisAgainstEvidence(pkg, candidate);
      if (!report.accepted) {
        audit.validationResult = "REJECTED";
        audit.validationReason = report.reasons.slice(0, 5).join(";").slice(0, 500);
        this.finish(audit);
        outcomes[index] = {
          status: "NO_DIAGNOSIS",
          reason: "VALIDATION_FAILED",
          detail: report.reasons.join(";").slice(0, 500),
          audit,
        };
        continue;
      }

      const final = this.finalizeDiagnosis(pkg, candidate);
      audit.diagnosisId = final.diagnosisId;
      audit.validationResult = "ACCEPTED";
      this.finish(audit);

      const outcome: DiagnosisOutcome = { status: "SUCCESS", diagnosis: final, audit };
      if (this.opts.cacheEnabled) {
        const key = this.cacheKey(pkg, ctx.userId);
        this.cache.set(key, { expiresAt: this.opts.now().getTime() + this.opts.cacheTtlMs, outcome });
      }
      outcomes[index] = outcome;
    }

    return outcomes;
  }

  private auditWith(
    pkg: EvidencePackage,
    ctx: { userId?: string; traceId?: string },
    latencyMs: number,
    usage?: AICompletionResponse["usage"]
  ): DiagnosisAuditRecord {
    const audit = this.baseAudit(pkg, ctx);
    audit.latencyMs = latencyMs;
    if (usage) {
      audit.tokenUsage = usage;
    }
    return audit;
  }

  /**
   * Engine-owned enrichment: deterministic id, package-bound metadata,
   * confidence caps and secret redaction.
   */
  private finalizeDiagnosis(pkg: EvidencePackage, candidate: ModelDiagnosis) {
    const caps = applyConfidenceCaps(pkg, candidate);

    const facts = candidate.facts.map((f) =>
      MarketingFactSchema.parse({
        statement: redactSecrets(f.statement),
        evidenceRef: f.evidenceRef,
      })
    );
    const inferences = candidate.inferences.map((inf) =>
      MarketingInferenceSchema.parse({
        statement: redactSecrets(inf.statement),
        supportingEvidence: inf.supportingEvidence,
        confidence: inf.confidence,
      })
    );
    const hypotheses = candidate.hypotheses.map((h, i) =>
      MarketingHypothesisSchema.parse({
        statement: redactSecrets(h.statement),
        category: h.category,
        supportingEvidence: h.supportingEvidence,
        contradictingEvidence: h.contradictingEvidence,
        confidence: caps.hypotheses[i],
      })
    );

    const diagnosisId = `diag_${computeParamsHash({
      accountId: pkg.accountId,
      entityLevel: pkg.entityLevel,
      entityId: pkg.entityId,
      evidenceHash: pkg.evidenceHash,
      provider: this.provider.id,
      model: this.provider.defaultModel,
    }).slice(0, 16)}`;

    const result = DiagnosisResultSchema.parse({
      diagnosisId,
      accountId: pkg.accountId,
      entityLevel: pkg.entityLevel,
      entityId: pkg.entityId,
      anomalyIds: [...candidate.anomalyIds],
      category: candidate.category,
      summary: redactSecrets(candidate.summary).slice(0, 1000),
      facts,
      inferences,
      hypotheses,
      confidence: caps.overall satisfies ConfidenceLevel,
      dataQuality: pkg.dataQuality,
      evidenceHash: pkg.evidenceHash,
      generatedAt: this.opts.now().toISOString(),
    });
    return result;
  }
}
