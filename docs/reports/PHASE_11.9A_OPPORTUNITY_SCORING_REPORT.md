# PHASE 11.9A - CONTROLLED OPTIMIZATION OPPORTUNITY SCORING REPORT

## Objective
Deterministic scoring + ranking of ALREADY-VALID Phase 11.5 recommendations by relative business importance and execution suitability for human review. No creation, no modification, no execution; no LLM; no provider calls; score is NOT a probability.

## Implementation Surface
- NEW `packages/core/src/opportunity-scoring.ts`
  - Contract: `OpportunityScoreSchema` (strict) with `recommendationId, accountId, entityId, actionType, score(0–100 int), priority(CRITICAL|HIGH|MEDIUM|LOW|IGNORE), severity, confidence, expectedImpact(HIGH|MODERATE|LOW|NEGLIGIBLE|IMPACT_UNKNOWN), risk, urgency(IMMEDIATE|HIGH|NORMAL|LOW), historicalEvidenceStrength(NONE|WEAK|MODERATE|STRONG), reversibility, rationale{positiveFactors,negativeFactors,riskNote,historicalNote,limitations}, conflicted, conflictWith[], scoringVersion=1, calculatedAt`.
  - Eligibility: `evaluateEligibility()` → only PROPOSED/APPROVED; reasons INVALID_RECORD (schema re-parse), UNAUTHORIZED (owner≠requester), EXPIRED (status or expiresAt), STALE/REJECTED/ALREADY_EXECUTED/ALREADY_EXECUTING/FAILED→STALE, MISSING_EVIDENCE (hash absent OR anomaly binding lost).
  - Components: severity (any CRITICAL→1.0; warnings 0.4 each; label mirrors Phase 11.3 vocabulary), impact (spend buckets 1000/500/100/>0 → 1.0/.8/.6/.4 + adverse CPA/CPC/CPM-up / ROAS/revenue/conversions/CTR/CVR-down change bump ≤+0.5; nothing measurable→0.3 neutral + IMPACT_UNKNOWN), urgency (age <24h/<72h/<7d/older ×1.0/.75/.5/.3 blended 60% with velocity |percentDeviation| ≥50/≥25/≥10/else ×1.0/.8/.6/.4 at 40%; safe default 0.3), confidence (consumed from record: HIGH/MEDIUM/LOW → 1.0/.6/.3 — never recalculated), historical (consumed from 11.8B assessment: STRONG 1.0 / MODERATE .65 / WEAK .25 / NONE .4 neutral; MIXED caps .3; CONSISTENT_NEGATIVE caps .2), reversibility (fixed table: PAUSE_AD/RESUME_AD HIGHLY_REVERSIBLE 1.0; *_AD_SET MODERATELY_REVERSIBLE .7; budget/campaign HIGHER_IMPACT .4).
  - Formula: weighted sum with configurable `OpportunityWeights` (defaults severity .25 / impact .20 / urgency .15 / confidence .15 / historical .10 / reversibility .05 = 1.0), ×100 rounded, MINUS risk penalty (HIGH −12 / MEDIUM −6 / LOW 0), clamped [0..100]. Bands: ≥80 CRITICAL, ≥60 HIGH, ≥40 MEDIUM, ≥20 LOW, else IGNORE.
  - Conflicts: per-entity grouping via existing `actionsConflict()`; both sides flagged CONFLICTED + `conflictWith[]`; never silently resolved.
  - Ranking: `rankOpportunities({accountId, records, context})` — account isolation filter, dedup by recommendationId, deterministic comparator (score DESC → severity DESC → urgency DESC → confidence DESC → createdAt newer-first → id lexicographic ASC).
  - Explainability: deterministic string templates only (no AI text); historical note built from sampleQuality + sampleSize + contradictory count; limitations always include SCORE_IS_RELATIVE_OPPORTUNITY_PRIORITY_NOT_SUCCESS_PROBABILITY.
- `packages/core/src/index.ts`: exports `./opportunity-scoring.js`.

## A. Score calculation: PASS
Hand-verified default fixture: .25·1 + .20·1 + .15·1 + .15·.6 + .10·.4 + .05·.7 = .765 → 76.5 → round − LOW-risk penalty 0 = **77 → HIGH** (test 01 exact).

## B. Priority bands: PASS
Exact inclusive boundaries asserted: 80/79, 60/59, 40/39, 20/19 (test 02); every emitted item satisfies `priority === bandOf(score)` across a 30-record mixed corpus (test 25).

## C. Severity contribution: PASS
CRITICAL > WARNING-only > none ordering; labels mirror Phase 11.3 severities directly (no second system). Single CRITICAL ⇒ maximum component (severe deterioration is already severe).

## D. Impact contribution: PASS
Spend buckets exact under single-weight config (≥1000→100, >0 small→40); adverse-metric bump verified without spend signal (+50% CPA → 50); tiny-but-present signals keep LOW/NEGLIGIBLE labels.

## E. Urgency contribution: PASS
Fresh (<24h) + |Δ|≥50% → IMMEDIATE (component 1.0 → 100); 10-day-old mild drift → LOW (0.34 → 34, exact formula match).

## F. Confidence contribution: PASS
Consumed as-is from the record (11.8B final combined level): HIGH/MEDIUM/LOW → 100/60/30 under single-weight config. Never recalculated in this layer.

## G. Historical contribution: PASS
STRONG consistent-positive → 100; MIXED hard cap ≤30; CONSISTENT_NEGATIVE hard cap ≤20; NO history → neutral 40 (never punitive). All values sourced from the stored `confidenceExplanation` — no second historical evaluation.

## H. Risk penalty: PASS
HIGH risk −12 points exactly (severity-isolated 100→88); penalty can never push below the 0 floor (verified on worst-case inputs).

## I. Reversibility: PASS
All 8 action types classified by the fixed table; PAUSE_AD isolated → 100; campaign/budget actions → HIGHER_IMPACT (.4).

## J. Custom weights: PASS
Configurable `OpportunityWeights` honored (confidence-only 60; confidence+urgency blend clamps correctly at ceiling 100).

## K. Explainability: PASS
positiveFactors/negativeFactors/riskNote/historicalNote/limitations all populated from deterministic templates; byte-identical across repeated runs; legacy records without 11.8B explanation get explicit NO_PHASE_118B_CONFIDENCE_ASSESSMENT_ON_RECORD limitation and "No relevant historical evidence." note.

## L. IMPACT_UNKNOWN handling: PASS
Records with no usable exposure signals still rank (neutral 0.3 component), labeled IMPACT_UNKNOWN with dedicated limitation + negative factor. Numbers never fabricated.

## M. Determinism: PASS
Same input → deep-equal contract output (tests 23, 30); full ranking identical across runs over a shuffled-risk 12-record corpus (test 17).

## N. Tie-breaking: PASS
Comparator unit-tested: score DESC → severity DESC → urgency DESC → confidence DESC → createdAt newer-first → recommendationId lexicographic ASC; sortedness re-asserted pairwise on ranked output (test 26).

## O. Conflict detection: PASS
PAUSE_AD_SET vs INCREASE_BUDGET on same entity → both CONFLICTED with populated conflictWith; independent entities/actions unflagged; flags set BEFORE ranking so reviewers see conflicts in context. No silent resolution anywhere.

## P. Duplicate identity: PASS
Repeated recommendationId collapses to one scored item (first occurrence wins).

## Q. Eligibility gates: PASS
EXPIRED (status AND time-based), STALE, REJECTED, ALREADY_EXECUTED, ALREADY_EXECUTING, FAILED→STALE, INVALID_RECORD (schema re-parse of tampered object), MISSING_EVIDENCE (lost anomaly binding) — all return precise NOT_ELIGIBLE reasons.

## R. Account isolation: PASS
Foreign-account rows are filtered before any scoring and cannot influence ranking or eligibility lists (test 19).

## S. User isolation / IDOR: PASS
Foreign-owned row inside the account → ineligible UNAUTHORIZED (test 20); ranking an account the user owns nothing of yields empty items/ineligible (test 21); direct evaluateEligibility UNAUTHORIZED check (test 14).

## T. Tests exact count
`packages/core/test/opportunity-scoring.test.ts`: **33 passed** (32 spec scenarios + boundary/comparator coverage). Core package total: **382 passed (13 files)** — was 349/12 before this phase.

## U. Full regression exact count
core 382 · security 27 · tools 573 · meta-graph 103 · agents 66 · memory 76 · api 65 passed | 8 skipped (PG-gated, pre-existing) · web 32 · ai-openai 3 → **1327 executed, 0 failed**, plus typecheck and structural checks below.

## V. TypeScript exact count
`turbo run typecheck`: **23/23 packages successful** after removing two dead declarations (`EXECUTABLE_STATUSES`, unused `ScoreComponents` interface).

## W. Migration status
**PENDING (environment)** — `pnpm db:migrate` → P1001 Can't reach database server at localhost:5432 (PostgreSQL down locally, same as Phases 11.7A/11.8A/11.8B). Prisma schema validate: PASS; `db:generate`: PASS (Prisma Client v5.22.0). NOTE: Phase 11.9A adds NO migration by design — scores are recomputed deterministically, never persisted (spec §23).

## X. Circular dependencies
madge: core/src ✔ No circular dependency found! · db/src + apps/api/src ✔ No circular dependency found!

## Y. Secret scan
CLEAN on all files changed in this phase (opportunity-scoring.ts, opportunity-scoring.test.ts, index.ts). Repo-wide sweep flags only `packages/memory/src/memory-extraction-service.ts:45-46`, which contains that service's OWN secret-detection regex literals — pre-existing false positive, untouched this session.

## Z. LLM calls: 0
Pure synchronous functions over server-validated records. No provider imports, no async network surface in the module.

## AA. Meta API calls: 0
Ranking accepts plain arrays; no client/port objects exist in any signature.

## AB. Real Meta writes: 0
The layer cannot execute anything — it emits read-only scored views.

## AC. Remaining blockers
- PostgreSQL unavailable locally → db:migrate remains PENDING (no new migration required for this phase).
- None otherwise.

## Not Implemented (per spec)
- No persistence/score table (§23): recomputed deterministically; versioned via `scoringVersion`.
- No auto-resolution of conflicts (§13): flag-only by design.
- No probability semantics: score documented as relative opportunity priority in-contract and in every rationale.limitations entry.

VERDICT: PHASE 11.9A PASS
