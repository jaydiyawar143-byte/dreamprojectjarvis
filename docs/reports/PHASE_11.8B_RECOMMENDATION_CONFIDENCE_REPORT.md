# PHASE 11.8B — RECOMMENDATION CONFIDENCE REPORT

Generated: 2026-08-24
Status: COMPLETE — VERDICT: PHASE 11.8B PASS

## Objective

Phase 11.8A `HistoricalEvidence` integrated into the existing Phase 11.5
Recommendation Engine (NO parallel engine). Current Evidence + Current
Diagnosis + Historical Evidence now combine into a deterministic confidence
(LOW/MEDIUM/HIGH) and priority (LOW/MEDIUM/HIGH). Historical outcomes are
supporting evidence only — never causal proof, never a guarantee.

## Implementation Surface

- `packages/core/src/recommendation-confidence.ts` (NEW)
  - `classifySampleSize()` — configurable thresholds: 0 → NO_HISTORY,
    <3 → VERY_LOW_SAMPLE, <10 → LOW_SAMPLE, ≥10 → STRONGER_HISTORY
  - `assessHistoricalConsistency()` — CONSISTENT_POSITIVE (posRate ≥ 0.7),
    CONSISTENT_NEGATIVE (negRate ≥ 0.7), MIXED (both decisive & balanced;
    middle zone conservatively MIXED so contradictions are never hidden), NONE
  - `assessHistoricalStrength()` — NONE/WEAK/MODERATE/STRONG; contradictory or
    very-low-sample history caps at WEAK; MIXED_QUALITY data caps STRONG→MODERATE
  - `computeCurrentEvidenceStrength()` — HIGH = diagnosis HIGH + COMPLETE data +
    ≥1 CRITICAL anomaly; LOW = diagnosis LOW / INSUFFICIENT_DATA / thin signal
  - `computeConfidenceAssessment()` — documented combination table:
    - history NONE ⇒ level = current level (insufficient history does not
      penalize a valid recommendation excessively)
    - WEAK/MODERATE positive history never changes the pre-history level
    - MEDIUM + STRONG consistent-positive ⇒ HIGH (the ONLY boost path)
    - LOW current stays LOW regardless of history (never auto-HIGH)
    - MIXED or CONSISTENT_NEGATIVE ⇒ one-step downgrade
  - `computePriority()` — additive score ≠ confidence:
    base(conf 2/3/4) + critical(+2) + warnings≥2(+1) + blast radius
    (CAMPAIGN +1 / AD −1) + risk HIGH(−2) + history(strong-pos +1 /
    mixed-or-neg −1); clamped [0..8]; ≥5 HIGH, 3–4 MEDIUM, ≤2 LOW
  - `computeHistoricalEvidenceHash()` — tamper-evident audit hash
- `packages/core/src/historical-outcome-engine.ts`
  - Added `HistoricalEvaluationContext` + `evaluateHistoricalEvidenceForContext()`;
    the Phase 11.8A function delegates to it — ONE matching/recency/quality
    implementation reused by both entry points (no logic duplication)
- `packages/core/src/recommendation-engine.ts`
  - Optional `historyPort` in engine config (`HistoricalOutcomePort`, bounded
    `limit`, default cap 10,000 outcomes, single query per generate — no N+1)
  - History loaded ONLY from the server-validated port AFTER all Phase 11.5
    gates; client input can never inject historical claims
  - Defense-in-depth isolation filter (accountId AND userId AND non-blank
    outcomeId); rejected foreign rows counted in audit detail
  - No-action gate: weak current evidence + contradictory/mixed history ⇒
    NO_RECOMMENDATION(`CONTRADICTORY_HISTORICAL_EVIDENCE`)
  - Record enrichment: `confidence`, `priority`, `historicalEvidenceIds[]`,
    `confidenceExplanation` (structured ConfidenceAssessment — no free-form AI text)
  - Audit enrichment: `traceId`, `confidenceBeforeHistory`,
    `confidenceAfterHistory`, `priority`, `historicalEvidenceCount`,
    `historicalEvidenceHash`
  - Backward compat: WITHOUT a history port the stored confidence keeps exact
    Phase 11.5 semantics (`diagnosis.confidence`); with a port it is the
    combined final level
- `packages/core/src/types/recommendation.ts`
  - Refined `ConfidenceAssessmentSchema`: level/currentEvidence/historicalEvidence
    (NONE|WEAK|MODERATE|STRONG)/sampleQuality/historicalSampleSize/
    historicalConsistency (NONE|CONSISTENT_POSITIVE|CONSISTENT_NEGATIVE|MIXED)/
    contradictoryEvidence(outcomeIds)/limitations
- DB (previously scaffolded, now verified): `PerformanceRecommendation` gains
  `priority` (default MEDIUM), `historical_evidence_ids` JSONB default [],
  `confidence_explanation` JSONB nullable; repository round-trip implemented

## A. Historical integration: PASS
Reuses the Phase 11.5 engine and the Phase 11.8A evaluator (single code path).
Optional enhancement only — no hard dependency.

## B. Confidence model: PASS
Deterministic, enum-only output (LOW/MEDIUM/HIGH). No numeric probabilities
exposed anywhere in the contract. Combination table unit-tested.

## C. Sample handling: PASS
0/1–2/3–9/10+ classification with configurable thresholds
(`veryLowMax`, `lowMax`). Sample size alone NEVER claims significance
(`NO_STATISTICAL_SIGNIFICANCE_CLAIMED` limitation always present when history
contributes).

## D. Historical consistency: PASS
8P/1N/1INC of 10 → CONSISTENT_POSITIVE; 5P/5N → MIXED (downgrades confidence);
contradictions always surfaced via `contradictoryEvidence[]`.

## E. Recency: PASS
Reuses 11.8A formula `weight = similarity × 0.5^(days/halfLife)` with a 0.1
floor — old contradictory evidence is decayed but never fully erased.
Formula documented and exposed in evidence weighting metadata.

## F. Relevance weighting: PASS
Same action (+0.30 exact / +0.10 family), same diagnosis (+0.30), same
objective (+0.15), same entity type (+0.15), same primary metric (+0.10);
exact matches strictly dominate partial ones (tested).

## G. Data quality: PASS
INSUFFICIENT_DATA/UNAVAILABLE excluded entirely; PARTIAL ×0.5 weight;
unreliable confounders excluded; ATTRIBUTION_PENDING excluded; MIXED_QUALITY
caps historical strength at MODERATE.

## H. Confidence explanation: PASS
Structured `ConfidenceAssessment` on every created record
(level, currentEvidence, historicalEvidence, sampleQuality,
historicalSampleSize, historicalConsistency, contradictoryEvidence[],
limitations[]) — schema-validated, no free-form AI reasoning.

## I. Priority model: PASS
Documented additive scoring (see above); verified spec examples:
HIGH confidence + low impact ⇒ MEDIUM; MEDIUM confidence + severe CPA
deterioration (+ strong supporting history) ⇒ HIGH. Priority demonstrably
diverges from confidence.

## J. No-action path: PASS
Current-evidence insufficiency refused by existing gates;
TRACKING_ISSUE ⇒ NO_SPEND_ACTION_TRACKING_ISSUE even with strong positive
history; contradictory history + weak current ⇒ dedicated
CONTRADICTORY_HISTORICAL_EVIDENCE refusal (defense-in-depth over 11.5 gates).

## K. Evidence traceability: PASS
Every historical contribution references server outcomeIds via
`historicalEvidenceIds[]`; every contradictory id ⊆ that list; audit carries
`historicalEvidenceCount` + `historicalEvidenceHash`. No untraceable
"Historical data suggests…" statements — descriptions are count-based only
("N of M similar historical recommendations had … measured outcomes").

## L. No causal claims: PASS
Test asserts produced explanation text contains none of: "will improve",
"will decrease", "proves", "guarantees", "%".

## M. Determinism: PASS
Pure functions; fixed clock; identical inputs produce byte-identical
confidence, priority, ids, explanation, paramsHash/stateHash/identityHash and
historical evidence hash (tested across two independent runs).

## N. Account isolation: PASS
Port is scoped by userId+accountId AND the engine re-filters rows itself;
leaky-port adversarial tests prove foreign-account/foreign-user rows are
ignored (sampleQuality stays NO_HISTORY, zero ids, audit detail notes rejection).

## O. Backward compatibility: PASS
Engine without history port reproduces Phase 11.5 semantics exactly (same
confidence, same identityHash); empty-history port yields identical identity
hash too. New record fields are additive with defaults; existing API routes
and repositories unchanged in behavior.

## P. Security/adversarial tests: PASS
Rejected/ignored: blank outcomeIds, foreign-account outcomes, borrowed-scope
fabricated positive history, client-smuggled `historicalEvidence` object
(strict schema INVALID_INPUT), fabricated counts/rates (recomputed from raw
rows only), numeric AI confidence (INVALID_INPUT), modified verdicts
(tamper-evident hash changes; confidence follows server data only).

## Q. Tests exact count
Phase 11.8B suite (`recommendation-confidence.test.ts`): **48 tests** —
27 focused scenarios (spec §18 items 1–27) + 6 confidence-model units +
7 priority units + 7 adversarial + 1 performance (10k outcomes × 1000 contexts).
All mocked; no live historical data required.
Core package total after phase: **349 passed (12 files)**.

## R. Full regression exact count
Executed test totals (all PASS):
- core: 349 (12 files)
- security: 27 (2 files)
- tools: 573 (20 files)
- meta-graph: 103 (5 files)
- agents: 66 (3 files)
- memory: 76 (3 files)
- api: 65 passed | 8 skipped (3 passed | 1 skipped files)
- web: 32 (3 files)
- ai-openai: 3 (1 file)
- db: integration suites defined (phase115/117a/117b/118a PG tests) but REQUIRE
  live PostgreSQL — not executable in this environment (see U/T)
TOTAL EXECUTED: **1,294 passed**

## S. TypeScript exact count
`pnpm typecheck`: **23 successful, 23 total (exit 0)**

## T. Migration status
- Migration `20260824030000_phase118b_priority_confidence` present: adds
  `priority` VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
  `historical_evidence_ids` JSONB NOT NULL DEFAULT '[]',
  `confidence_explanation` JSONB (nullable) — fully ADDITIVE (IF NOT EXISTS)
- `prisma validate`: PASS (schema valid)
- `pnpm db:generate`: PASS (Prisma Client v5.22.0)
- `pnpm db:migrate`: PENDING — P1001 Can't reach database server at
  localhost:5432 (PostgreSQL not running). Apply when DB is available.

## U. Shadow replay
Schema parses and validates cleanly against the full migration chain
(prisma validate PASS; db:generate PASS). Live shadow-DB replay blocked by the
same DB availability issue as T; DDL is additive-with-defaults so existing
rows remain intact by construction.

## V. Circular dependencies
madge --circular across packages/core/src + packages/db/src + apps/api/src:
**No circular dependency found! (167 files processed)**

## W. Secret scan
CLEAN — 0 matches (API-key, Meta token, private-key, AIza, password patterns)
across recommendation-confidence.ts, historical-outcome-engine.ts,
recommendation-engine.ts, types/recommendation.ts, migration SQL,
recommendation-repository.ts, recommendations route.

## X. Data integrity
15 migrations in chronological order (init → … → phase118b); ALL previously
committed migrations unmodified (git diff on migrations tree: empty). New
columns carry defaults → zero impact on existing recommendation/outcome rows.

## Y. LLM calls: 0
Confidence/priority/history paths are pure deterministic functions; no AI
provider exists in the engine; "zero LLM" proven structurally (test 25).

## Z. Meta API calls: 0
Only the read-only ExternalStatePort is consulted (1 load per generate,
asserted). No graph calls for history.

## AA. Real Meta writes: 0
All outputs are PROPOSED + requiresApproval=true proposals. Execution remains
fully gated behind the Phase 11.6A bridge and human approval.

## AB. Remaining blockers
1. PostgreSQL not running locally → run `pnpm db:migrate` (and optionally the
   4 PG integration suites incl. shadow replay) once the database is reachable.
   The migration is validated, additive, and idempotent-safe.
2. Optional follow-up (non-blocking): wire the engine's `historyPort` in the
   API proposal script(s) using PrismaOutcomeRepository.findFinalizedOutcomes —
   engine-side support is complete; no route changes required this phase.

## Not Implemented (per spec)
Autonomous optimization, automatic approval, real Meta writes, reinforcement
learning, model training, prompt modification, automatic strategy changes,
new Meta tools, automatic recommendation execution — NONE implemented.

## VERDICT: PHASE 11.8B PASS
