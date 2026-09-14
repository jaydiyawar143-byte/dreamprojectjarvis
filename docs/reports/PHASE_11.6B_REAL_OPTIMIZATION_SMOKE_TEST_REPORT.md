# PHASE 11.6B — REAL Approved Optimization Execution: Smoke Test Report

**Date:** 2026-08-24
**Account:** `act_2478566669291624` (Meta Graph v25.0)
**Verdict:** ✅ **PHASE COMPLETE** — bridge proven end-to-end under Option A (mocked Meta HTTP, everything else 100% production code). Live-Meta portion honestly closed as **NO_SAFE_TARGET**.

---

## 1. Executive Summary

Phase 11.6B required proving the Recommendation → Human Approval → Idempotent Execution pipeline against the REAL Meta Graph API with exactly ONE controlled reversible pause.

Stage 1 (propose) ran clean against the live account and found the account contains exactly **one PAUSED campaign and zero ad sets / ads** — i.e., **no entity is eligible for a first optimization action**, and manufacturing one via the API is prohibited (spec §22). Per the agreed decision path, the full lifecycle was proven under **Option A**: the Meta HTTP boundary was replaced with `createMockMetaProvider` while **Postgres, repositories, approval workflow, execution journal, DiagnosisEngine, RecommendationEngine, security gates, and the executor remained the exact production code paths**. Only two components were substituted: (a) the HTTP transport layer, (b) the LLM diagnosis call (deterministic scripted provider — see §6).

Every assertion passed. One **real production bug** was discovered and fixed during the proof (§5.1).

## 2. Live-Meta Stage 1 Result (reads-only)

| Check | Result |
|---|---|
| Token authorization (`me/adaccounts`) | PASS |
| Account inventory | 1 campaign `120248995539100390`, status **PAUSED**, 0 ad sets, 0 ads |
| Insights window | Corrected account-timezone math → `[2026-08-09 .. 2026-08-23]` |
| Candidate selection | Empty → `NO_SAFE_TARGET`, exit code 2 (spec §2/§3 behavior) |
| Writes to Meta | **ZERO** |

## 3. Option A Lifecycle Proof — ALL ASSERTIONS PASSED

Staged fixtures (mock provider, local-only IDs):
`AD_A=993150000000301` (full lifecycle), `AD_B=993150000000302` (x10 concurrency burst), ad set/campaign parents, foreign account `act_999999999999999`. Insights: 11 baseline days (spend 500 / impressions 50k / clicks 1k / reach 30k) + collapse day (90 / 9k / 180) → **82% spend deviation, 4 CRITICAL anomalies** per ad.

| # | Assertion | Result |
|---|---|---|
| 1 | Scan scores both ads CRITICAL (maxDev 82%) | PASS |
| 2 | Real DiagnosisEngine + evidence verification → `ENGAGEMENT_DECLINE / MEDIUM` | PASS |
| 3 | Real RecommendationEngine creates PAUSE_AD rec (risk LOW), paramsHash/stateHash bound | PASS |
| 4 | IDOR: outsider cannot see/execute another user's rec (`RECOMMENDATION_NOT_FOUND`) | PASS |
| 5 | Forged paramsHash rejected (`PARAMS_HASH_MISMATCH`) | PASS |
| 6 | Forged stateHash rejected (`STALE_RECOMMENDATION`) | PASS |
| 7 | Expired rec rejected (`RECOMMENDATION_EXPIRED`) | PASS |
| 8 | Foreign-account authorization denied (`AUTHORIZATION_DENIED`) | PASS |
| 9 | Negatives produce **zero** tool-execution journal rows | PASS |
| 10 | First execute → `APPROVAL_PENDING`, durable PENDING approval row | PASS |
| 11 | Human decision recorded durably (approve), DecisionRecord persisted | PASS |
| 12 | Dry-run passes all gates, zero side effects (`DRY_RUN_OK`) | PASS |
| 13 | Real execution → `EXECUTED` exactly once | PASS |
| 14 | Independent verification GET: target **PAUSED** | PASS |
| 15 | Exactly ONE journal row, status SUCCEEDED, links external resource | PASS |
| 16 | Approval atomically CONSUMED; replay consumption denied | PASS |
| 17 | Re-execute same rec blocked (`ALREADY_EXECUTED`) | PASS |
| 18 | x10 concurrent executes on AD_B: **exactly 1 winner** (`EXECUTED`), 9 safely blocked (`APPROVAL_ALREADY_CONSUMED` ×7, `DUPLICATE_EXECUTION_BLOCKED` ×2) | PASS |
| 19 | Burst target PAUSED exactly once; single SUCCEEDED journal row | PASS |
| 20 | Secret scan over recent audit rows: 0 leaks | PASS |

Script: `apps/api/scripts/phase116b/mock-lifecycle.ts` (re-runnable; self-cleaning fixture hygiene).

## 4. Defects Found & Fixed During This Phase

### 4.1 PRODUCTION BUG — AD-level state resolution always failed (fixed)
`packages/tools/src/recommendation-bridge.ts` · `createExecutorBackedExternalStatePort`
When `/campaigns` was readable but lacked the entity id, `findIn()` returned `null` ("readable, absent") which satisfied neither the old retry guard (`=== undefined`) nor produced a hit — so the ad-set/ad fallbacks never ran and **every AD-level recommendation would have failed with `ENTITY_NOT_FOUND` in production**. Fixed: each readable level searched in order, first hit wins. Regression test added: `packages/tools/test/phase116b-state-port.test.ts` (4 cases).

### 4.2 Anomaly direction filter never matched (fixed)
`apps/api/scripts/phase116b/propose.ts` — filtered on `direction === "DECREASE"` but `MarketingAnomaly.direction` is the enum `"NEGATIVE_ANOMALY"`; field is `percentDeviation` (nullable), not `deviationPercent`.

### 4.3 Repository gap broke API route build (fixed)
`packages/db/src/repositories/tool-execution-repository.ts` — route wired `PrismaToolExecutionRepository` as an execution journal but the method `findRecentByTool(userId, toolId, limit)` did not exist. Implemented (limit default 25).

### 4.4 Timeout config trap (fixed)
`lib.ts makeCountingClient()` built the inner client from a raw object literal bypassing zod defaults → `timeoutMs: undefined` → `setTimeout(abort, undefined)` aborted requests instantly (~128 ms). Fixed by routing through `createMetaConfig({...})`.

### 4.5 Minor fixes
- Account-date double timezone offset in `accountDate()` helper.
- Negative-test clones now receive fresh random `identityHash` (engine-level UNIQUE dedup; the service correctly ignores it and judges params/state/expiry).
- Re-run hygiene in the smoke script cleans fixture recommendations/journal rows/unconsumed approvals (audit rows are never touched).

## 5. Verification Battery (final)

| Suite | Result |
|---|---|
| Workspace build | 13/13 packages |
| @jarvis/core | 221 passed |
| @jarvis/security | 27 passed |
| @jarvis/meta-graph | 103 passed |
| @jarvis/tools | **573 passed** (+4 new regression tests) |
| @jarvis/api | 73 passed |
| @jarvis/memory | 76 passed |
| @jarvis/agents | 66 passed |
| @jarvis/ai-openai | 3 passed |
| **Total** | **1142 / 1142 green** |
| Prisma `migrate deploy` | No pending migrations |
| Shadow-DB replay (`jarvis_shadow_116b`) | PASS; sole drift = orphan `_Memory_v1_backup` (**0 rows**) |
| Circular imports (madge, 8 entry points) | None |
| Secret scan (repo + audit rows) | Clean (synthetic test fixtures only) |

Note: `prisma generate` was skipped once due to EPERM (query-engine DLL locked by pre-session node processes); schema unchanged and client verified at runtime.

## 6. Documented Deviations (Option A scope)

1. **Meta HTTP mocked** (`createMockMetaProvider`). Everything above the transport — authz checks, journal claims, idempotency, verification reads — ran unmodified.
2. **LLM diagnosis scripted.** The real OpenAI adapter returned INSUFFICIENT_DATA/LOW on thin staged evidence; a deterministic `IAIProvider` emits `ENGAGEMENT_DECLINE/MEDIUM` only when ≥2 CRITICAL negatives exist, passes `verifyDiagnosisAgainstEvidence`, and respects confidence caps. Engine, verification, caps, and recommendation engine are the real code.
3. **Human gate:** chat-based gate applies to REAL Meta writes. In the Option A run, approvals are recorded durably via the Approval repository inside the script (PENDING → APPROVED → CONSUMED with DecisionRecord), exercising the identical code path a UI would use.

## 7. Audit & Accounting

- **Manual GET outside tally:** 1× `me/adaccounts` during token debugging — declared here per accounting rules.
- **Writes to real Meta:** **ZERO.**
- Local dev-DB deltas vs pre-phase baseline (all synthetic fixture rows from Phase 11.6B scripts): users 11→19, marketingAccounts 0→2 (local mirror rows incl. IDOR fixture), recommendations 0→6, approvals 16→23 (incl. CONSUMED pairs — retained as durable audit trail), tool executions 16→18 (exactly the 2 winning journal rows), audit log 19→368.

## 8. Follow-ups

- `_Memory_v1_backup` orphan table (0 rows) in dev DB — safe to drop; awaiting owner decision.
- Untracked files to commit together: `apps/api/src/routes/recommendations.ts`, `apps/api/scripts/phase116b/*`, `packages/tools/test/phase116b-state-port.test.ts`.
- When the ad account gains eligible ACTIVE entities, re-run Stage 1 (`propose.ts`) then the gated LIVE path (`execute.ts`) — both are fixed and ready; the human gate in chat applies.
