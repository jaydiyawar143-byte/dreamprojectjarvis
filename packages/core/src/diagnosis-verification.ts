import type { EvidencePackage } from "./types/diagnosis.js";
import type {
  ConfidenceLevel,
  MarketingFact,
  MarketingHypothesis,
  MarketingInference,
  ModelDiagnosis,
} from "./types/diagnosis.js";
import { minConfidence } from "./types/diagnosis.js";
import { evidenceRefExists } from "./evidence-builder.js";

// ---------------------------------------------------------------------------
// Deterministic Evidence Verification — Phase 11.4 §16
// ---------------------------------------------------------------------------
// Post-validation of model output against the EvidencePackage.
// The AI must never invent metrics, dates, spend, conversions, revenue,
// campaign state or account state. Every factual statement is checked:
//   - referenced evidence exists (anomaly id / metric field / meta field)
//   - numeric claims (% and currency) match authoritative values in tolerance
//   - direction words match the sign of verified change
//   - any date mentioned falls inside the package windows
//   - entityId / entityLevel / evidenceHash echo the package
//   - anomalyIds reference real anomalies
// Fail-closed: any violation rejects the whole diagnosis.
// ---------------------------------------------------------------------------

export const VERIFICATION_TOLERANCE = {
  /** percentage-point absolute tolerance for % claims */
  percentPointsAbsolute: 3,
  /** relative tolerance for large % claims */
  percentRelative: 0.2,
  /** relative tolerance for currency/count claims */
  valueRelative: 0.02,
  valueAbsolute: 0.05,
} as const;

export const MAX_STATEMENT_LENGTH = 300;

const METRIC_PATTERNS: ReadonlyArray<{ metric: string; regex: RegExp }> = [
  { metric: "cpa", regex: /\b(?:cpa|cost\s+per\s+(?:acquisition|result))\b/gi },
  { metric: "cpc", regex: /\b(?:cpc|cost\s+per\s+click)\b/gi },
  { metric: "cpm", regex: /\bcpm\b/gi },
  { metric: "ctr", regex: /\b(?:ctr|click[-\s]?through\s+rate)\b/gi },
  { metric: "cvr", regex: /\b(?:cvr|conversion\s+rate)\b/gi },
  { metric: "roas", regex: /\broas\b/gi },
  { metric: "spend", regex: /\bspend\b/gi },
  { metric: "impressions", regex: /\bimpressions\b/gi },
  { metric: "clicks", regex: /\bclicks\b/gi },
  { metric: "conversions", regex: /\bconversions\b/gi },
  { metric: "revenue", regex: /\brevenue\b/gi },
  { metric: "reach", regex: /\breach\b/gi },
  { metric: "frequency", regex: /\bfrequency\b/gi },
];

const INCREASE_WORDS = /\b(?:increas\w*|ros\w*|ris\w*|went\s+up|higher|elevated|spik\w*)\b/i;
const DECREASE_WORDS = /\b(?:decreas\w*|declin\w*|drop\w*|fell|fall\w*|lower|reduc\w*|down|shrink\w*|weak\w*)\b/i;
const STABLE_WORDS = /\b(?:stable|unchanged|flat|no\s+significant\s+change)\b/i;

/** Direction word immediately preceding a metric ("drop in CPA"). */
const INCREASE_BEFORE = /(?:\bincreas\w*|\bros\w*|\bris\w*|\bhigher)(?:\s+(?:in|of|for|on))?\s*$/i;
const DECREASE_BEFORE = /(?:\bdecreas\w*|\bdeclin\w*|\bdrop\w*|\bfell|\bfall\w*|\blower|\breduc\w*|\bdown|\bshrink\w*)(?:\s+(?:in|of|for|on))?\s*$/i;
const STABLE_BEFORE = /(?:\bstable|\bunchanged|\bflat)(?:\s+(?:in|of|for|on))?\s*$/i;

const PERCENT_CLAIM = /([+-]?\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi;
const CURRENCY_CLAIM = /(?:\$|usd\s{0,3})(\d[\d,]*(?:\.\d+)?)/gi;
const DATE_CLAIM = /\b(\d{4}-\d{2}-\d{2})\b/g;

function close(a: number, b: number, tolAbs: number, tolRel: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  return diff <= tolAbs || diff <= Math.abs(b) * tolRel;
}

function mag(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.abs(n) : null;
}

interface MetricMention {
  metric: string;
  index: number;
}

function findMetricMentions(sentence: string): MetricMention[] {
  const mentions: MetricMention[] = [];
  for (const { metric, regex } of METRIC_PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(sentence)) !== null) {
      mentions.push({ metric, index: m.index });
    }
  }
  return mentions.sort((a, b) => a.index - b.index);
}

/** Authoritative numbers for a metric within this package. */
export function authoritativeValues(
  pkg: EvidencePackage,
  metric: string
): { current: number | null; previous: number | null; changePercent: number | null; changeAbsolute: number | null } {
  const detail = pkg.metricDetails.find((d) => d.metric === metric);
  const anomaly = pkg.anomalies.find((a) => a.metric === metric);
  return {
    current: detail?.current ?? anomaly?.currentValue ?? null,
    previous: detail?.previous ?? anomaly?.baselineValue ?? null,
    changePercent:
      anomaly?.percentDeviation !== undefined && anomaly?.percentDeviation !== null
        ? anomaly.percentDeviation
        : (detail?.changePercent ?? null),
    changeAbsolute:
      anomaly?.absoluteDeviation !== undefined && anomaly?.absoluteDeviation !== null
        ? anomaly.absoluteDeviation
        : (detail?.changeAbsolute ?? null),
  };
}

/**
 * All candidate numeric values a claim about `metric` may legitimately match.
 */
function candidatesFor(pkg: EvidencePackage, metric: string, kind: "percent" | "currency"): number[] {
  const auth = authoritativeValues(pkg, metric);
  const base =
    kind === "percent"
      ? [auth.current, auth.previous, mag(auth.changePercent), auth.changePercent]
      : [auth.current, auth.previous, mag(auth.changeAbsolute), auth.changeAbsolute];
  const fromAnomalies = pkg.anomalies
    .filter((a) => a.metric === metric)
    .flatMap((a) =>
      kind === "percent"
        ? [mag(a.percentDeviation), a.percentDeviation]
        : [mag(a.absoluteDeviation), a.absoluteDeviation]
    );
  return [...base, ...fromAnomalies].filter((n): n is number => n !== null);
}

function claimMatchesAnyMetric(pkg: EvidencePackage, value: number, kind: "percent" | "currency"): boolean {
  for (const d of pkg.metricDetails) {
    const tolAbs = kind === "percent" ? VERIFICATION_TOLERANCE.percentPointsAbsolute : VERIFICATION_TOLERANCE.valueAbsolute;
    const tolRel = kind === "percent" ? VERIFICATION_TOLERANCE.percentRelative : VERIFICATION_TOLERANCE.valueRelative;
    if (candidatesFor(pkg, d.metric, kind).some((c) => close(value, c, tolAbs, tolRel))) return true;
  }
  return false;
}

function dateInWindows(pkg: EvidencePackage, isoDate: string): boolean {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  const checkWindow = (w?: { startDate: string; endDate: string }): boolean => {
    if (!w) return false;
    const start = Date.parse(`${w.startDate}T00:00:00Z`);
    const end = Date.parse(`${w.endDate}T23:59:59Z`);
    return !Number.isNaN(start) && !Number.isNaN(end) && t >= start && t <= end;
  };
  return checkWindow(pkg.performanceWindow) || checkWindow(pkg.comparisonWindow);
}

/**
 * Verify one factual/interpretive statement string.
 * Returns null when supported, or a rejection reason.
 */
export function verifyStatementNumbers(
  pkg: EvidencePackage,
  statement: string
): string | null {
  if (statement.length > MAX_STATEMENT_LENGTH * 2) return "statement_exceeds_length_limit";

  // 1. Any ISO date mentioned must fall inside known windows.
  for (const m of statement.matchAll(DATE_CLAIM)) {
    if (!dateInWindows(pkg, m[1]!)) {
      return `fabricated_date:${m[1]}`;
    }
  }

  const sentences = statement.split(/[.!?;\n]+/).filter((s) => s.trim().length > 0);

  for (const sentence of sentences) {
    const mentions = findMetricMentions(sentence);
    const percentClaims = [...sentence.matchAll(PERCENT_CLAIM)].map((m) => ({
      raw: m[1]!,
      value: parseFloat(m[1]!.replace(/,/g, "")),
      index: m.index ?? 0,
    }));
    const currencyClaims = [...sentence.matchAll(CURRENCY_CLAIM)].map((m) => ({
      raw: m[1]!,
      value: parseFloat(m[1]!.replace(/,/g, "")),
      index: m.index ?? 0,
    }));

    // Pair each claim with the closest preceding metric mention.
    const pairClaim = <T extends { index: number }>(claim: T): MetricMention | null => {
      let best: MetricMention | null = null;
      for (const men of mentions) {
        if (men.index < claim.index && (best === null || men.index > best.index)) {
          best = men;
        }
      }
      return best ?? mentions[0] ?? null;
    };

    for (const [kind, claims] of [
      ["percent", percentClaims],
      ["currency", currencyClaims],
    ] as const) {
      for (const claim of claims) {
        const target = pairClaim(claim);
        if (!target) {
          // Unbound numeric claim ("budget was raised to $10,000"): must not
          // match ANY metric in the evidence — otherwise reject.
          if (!claimMatchesAnyMetric(pkg, claim.value, kind)) {
            return `unsupported_${kind}_claim:${claim.raw}`;
          }
          continue;
        }
        const tolAbs = kind === "percent" ? VERIFICATION_TOLERANCE.percentPointsAbsolute : VERIFICATION_TOLERANCE.valueAbsolute;
        const tolRel = kind === "percent" ? VERIFICATION_TOLERANCE.percentRelative : VERIFICATION_TOLERANCE.valueRelative;
        const ok = candidatesFor(pkg, target.metric, kind).some((c) => close(claim.value, c, tolAbs, tolRel));
        if (!ok) {
          return `unsupported_${kind}_claim:${target.metric}:${kind === "currency" ? "$" : ""}${claim.raw}`;
        }
      }
    }

    // Direction-word consistency per mentioned metric, tightly attributed:
    // the direction word must sit between this mention and the next one, or
    // immediately before it ("a drop in CPA").
    for (let i = 0; i < mentions.length; i++) {
      const men = mentions[i]!;
      const nextBoundary = i + 1 < mentions.length ? mentions[i + 1]!.index : men.index + 45;
      const tail = sentence.slice(men.index, nextBoundary);
      const head = sentence.slice(Math.max(0, men.index - 18), men.index);

      const auth = authoritativeValues(pkg, men.metric);
      const signedChange = auth.changePercent ?? auth.changeAbsolute ?? null;

      const saysIncrease = INCREASE_WORDS.test(tail) || INCREASE_BEFORE.test(head);
      const saysDecrease = DECREASE_WORDS.test(tail) || DECREASE_BEFORE.test(head);
      const saysStable = STABLE_WORDS.test(tail) || STABLE_BEFORE.test(head);

      if (saysIncrease && saysDecrease) continue; // ambiguous phrasing — skip

      if ((saysIncrease || saysDecrease) && signedChange === null) {
        return `direction_unverifiable:${men.metric}`;
      }
      if (saysIncrease && signedChange !== null && signedChange <= 0) {
        return `direction_mismatch:${men.metric}:claimed_increase_actual_${signedChange}`;
      }
      if (saysDecrease && signedChange !== null && signedChange >= 0) {
        return `direction_mismatch:${men.metric}:claimed_decrease_actual_${signedChange}`;
      }
      if (saysStable && signedChange !== null && Math.abs(signedChange) >= 10) {
        return `stability_mismatch:${men.metric}:change_${signedChange}`;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Whole-diagnosis verification
// ---------------------------------------------------------------------------

export interface DiagnosisVerificationReport {
  accepted: boolean;
  reasons: string[];
}

export function verifyDiagnosisAgainstEvidence(
  pkg: EvidencePackage,
  candidate: ModelDiagnosis
): DiagnosisVerificationReport {
  const reasons: string[] = [];

  // Identity binding.
  if (candidate.entityId !== pkg.entityId) reasons.push("entityId_mismatch");
  if (candidate.entityLevel !== pkg.entityLevel) reasons.push("entityLevel_mismatch");
  if (candidate.evidenceHash !== pkg.evidenceHash) reasons.push("evidenceHash_mismatch");

  // Anomaly references must exist.
  const knownAnomalyIds = new Set(pkg.anomalies.map((a) => a.anomalyId));
  for (const id of candidate.anomalyIds) {
    if (!knownAnomalyIds.has(id)) reasons.push(`unknown_anomaly_ref:${id}`);
  }

  // NO_CLEAR_DIAGNOSIS consistency.
  if (
    (candidate.category === "NO_CLEAR_DIAGNOSIS" || candidate.category === "INSUFFICIENT_DATA") &&
    candidate.hypotheses.length > 0
  ) {
    reasons.push("no_clear_diagnosis_with_hypotheses");
  }

  // Facts.
  candidate.facts.forEach((f, i) => verifyFact(pkg, f, i, reasons));

  // Inferences.
  candidate.inferences.forEach((inf, i) =>
    verifyInference(pkg, inf, i, reasons)
  );

  // Hypotheses.
  candidate.hypotheses.forEach((h, i) => verifyHypothesis(pkg, h, i, reasons));

  return { accepted: reasons.length === 0, reasons };
}

function verifyFact(
  pkg: EvidencePackage,
  fact: MarketingFact,
  index: number,
  reasons: string[]
): void {
  if (!evidenceRefExists(pkg, fact.evidenceRef)) {
    reasons.push(`fact[${index}]_missing_evidence:${fact.evidenceRef}`);
    return;
  }
  const numReason = verifyStatementNumbers(pkg, fact.statement);
  if (numReason) {
    reasons.push(`fact[${index}]_${numReason}`);
  }
}

function collectRefProblems(
  pkg: EvidencePackage,
  refs: string[],
  label: string,
  index: number,
  reasons: string[]
): void {
  for (const ref of refs) {
    if (!evidenceRefExists(pkg, ref)) {
      reasons.push(`${label}[${index}]_missing_evidence:${ref}`);
    }
  }
}

function verifyStatementContent(
  pkg: EvidencePackage,
  statement: string,
  label: string,
  index: number,
  reasons: string[]
): void {
  const numReason = verifyStatementNumbers(pkg, statement);
  if (numReason) reasons.push(`${label}[${index}]_${numReason}`);
}

function verifyInference(
  pkg: EvidencePackage,
  inference: MarketingInference,
  index: number,
  reasons: string[]
): void {
  collectRefProblems(pkg, inference.supportingEvidence, "inference_support", index, reasons);
  verifyStatementContent(pkg, inference.statement, "inference", index, reasons);
}

function verifyHypothesis(
  pkg: EvidencePackage,
  hypothesis: MarketingHypothesis,
  index: number,
  reasons: string[]
): void {
  if (hypothesis.supportingEvidence.length === 0) {
    reasons.push(`hypothesis[${index}]_no_supporting_evidence`);
  }
  collectRefProblems(pkg, hypothesis.supportingEvidence, "hypothesis_support", index, reasons);
  collectRefProblems(pkg, hypothesis.contradictingEvidence, "hypothesis_contra", index, reasons);
  verifyStatementContent(pkg, hypothesis.statement, "hypothesis", index, reasons);
}

// ---------------------------------------------------------------------------
// Deterministic confidence caps — the model proposes, the system disposes.
// ---------------------------------------------------------------------------

const LOW_CONFIDENCE_LIFECYCLE_STATES = new Set([
  "NEW", "LEARNING", "LEARNING_LIMITED", "WARMUP", "DRAFT",
]);

export function computeConfidenceCap(pkg: EvidencePackage): ConfidenceLevel {
  let cap: ConfidenceLevel = "HIGH";
  if (pkg.dataQuality === "PARTIAL") cap = minConfidence(cap, "MEDIUM");
  if (pkg.dataQuality === "INSUFFICIENT_DATA" || pkg.dataQuality === "UNAVAILABLE") {
    cap = minConfidence(cap, "LOW");
  }
  if (pkg.freshness !== "FRESH") cap = minConfidence(cap, "LOW");
  const lifecycle = (pkg.campaignLifecycleState ?? "").toUpperCase();
  if (LOW_CONFIDENCE_LIFECYCLE_STATES.has(lifecycle)) cap = minConfidence(cap, "MEDIUM");
  return cap;
}

/** Apply caps to a validated candidate; returns final confidence values. */
export function applyConfidenceCaps(
  pkg: EvidencePackage,
  candidate: ModelDiagnosis
): { overall: ConfidenceLevel; hypotheses: ConfidenceLevel[] } {
  const cap = computeConfidenceCap(pkg);
  const hypotheses = candidate.hypotheses.map((h) => {
    const contra = h.contradictingEvidence.length;
    const support = h.supportingEvidence.length;
    let level = h.confidence;
    if (contra > 0 && contra >= support) level = minConfidence(level, "LOW");
    else if (contra > 0) level = minConfidence(level, "MEDIUM");
    return minConfidence(level, cap);
  });
  return { overall: minConfidence(candidate.confidence, cap), hypotheses };
}
