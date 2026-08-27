# SPRINT 2.0 — Meta Ads Capability Baseline Audit

> **Audit type:** READ-ONLY baseline (no application code, DB, env, or credentials modified)
> **Date:** 2026-08-27 · **Repo:** `D:\dreamprojectjarvis\dreamprojectjarvis` (pnpm + Turbo monorepo, branch main)
> **Auditor:** JARVIS planner agent
> **Real Meta writes performed during audit:** **0**

---

## 0. EXECUTIVE SUMMARY

JARVIS already contains a **complete, verified Meta Ads capability stack**: a real Graph API provider (`@jarvis/meta-graph`, v21.0), 5 read tools, 9 approval-bound write tools (pause/resume + budget + campaign create), a deterministic intelligence pipeline (KPI → aggregator → anomaly → diagnosis → recommendation → confidence → opportunity scoring → outcome), durable execution journaling with idempotency and reconciliation, and a strict approval+paramsHash human-in-the-loop security model.

However, the baseline reveals **one major access gap** relevant to Sprint 2: **there is no dedicated Meta Ads agent**. The only registered agent is `conversational-assistant` (`packages/agents/src/registry.ts`). Moreover, most of the intelligence pipeline is **not user-accessible via a production HTTP route** — the only user-accessible stages are the read-only projections (`GET /api/v1/opportunities`, `GET /api/v1/recommendations`, `GET /api/v1/outcomes`, `GET /api/v1/approvals`, `GET /api/v1/pending-actions`). The **only** end-to-end entry that actually *generates* recommendations from Meta data is the standalone smoke CLI `apps/api/scripts/phase116b/propose.ts`, which is not a route and not automated, and the `OutcomeWorker` is implemented but **not wired** to any scheduler/cron/route.

This report is the official pre-Sprint-2 baseline. It documents exactly what exists, what is user-accessible, what is verified, and what is missing — so Sprint 2 can create a dedicated Meta Ads agent without breaking any of it.

---

## 1. FROZEN INVARIANTS VERIFIED (all PASS)

| # | Invariant | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Application code modified | **NO** | Read-only session; no source file written |
| 2 | Database modified | **NO** | No migration, no SQL, no schema change |
| 3 | Env vars / credentials changed | **NO** | `.env*` untouched; token presence logged but not modified |
| 4 | Real Meta writes | **0** | All provider calls were MOCK (unit tests) or none; no real write executed |
| 5 | No behavior modified | **YES** | All read/verify only |

**Verdict: `SPRINT 2.0 META ADS BASELINE AUDIT — PASS`** (inventory complete, no behavior modified, no real Meta write.)

---

## 2. MONOREPO LAYOUT

```
apps/
  api/    Express + Socket.IO backend (routes, container, scripts)
  web/    Next.js 14 frontend (22 .ts/.tsx files)
packages/
  core/       types, engines (KPI, aggregator, anomaly, diagnosis, recommendation, opportunity, outcome, confidence, history), utils (params-hash)
  db/         Prisma schema + repositories (ToolExecution, Approval, PerformanceRecommendation, OutcomeRecord, ...)
  agents/     AgentRegistry, Orchestrator, intent-detector, pending-action-service
  tools/      ToolRegistry, ToolExecutor, ExecutionJournal, meta-ads read/write tools, budget guardrails, recommendation-bridge
  security/   ToolApprovalService, Permission/Approval/Audit, paramsHash binding
  meta-graph/ Provider, client, config, error-handler, reconciler, response-validator
  memory/     memory store/recall/extraction (Sprint 1.1A-D)
  ai-openai/  OpenAI provider
  config/     env validation
```

---

## 3. META GRAPH PROVIDER (`packages/meta-graph`)

| Item | Detail | File |
|------|--------|------|
| Default API version | `v21.0` | `config.ts` |
| Default timeout | `30000ms` | `client.ts` |
| Default maxRetries | `0` | `client.ts` |
| Read interfaces | `getAdAccounts/getCampaigns/getAdSets/getAds/getInsights` (all support `AbortSignal`) | `provider.ts` |
| Write interfaces | `updateCampaignStatus/updateAdSetStatus/updateAdStatus` (pause/resume only in Phase 9.1 boundary) | `provider.ts` |
| Budget interface | `updateCampaignBudget/updateAdSetBudget` | `provider.ts` |
| Create interface | `createCampaign` | `provider.ts` |
| Authorizer | `MetaAccountAuthorizer` (`getAuthorizedAccountIds`/`isAuthorized`) — server-side, never trust client account IDs | `provider.ts` |
| Validation | `response-validator.ts` | `response-validator.ts` |
| Error classification | `error-handler.ts` | `error-handler.ts` |
| Reconciliation | `reconciler.ts` | `reconciler.ts` |
| Secret protection | Provider never exposes credentials; output sanitizer redacts token patterns | everywhere |

**Real-data gate:** the API container (`apps/api/src/services/container.ts`) only registers real Meta tools when BOTH `META_ACCESS_TOKEN` AND `META_AD_ACCOUNT_ID` are set; otherwise the meta registry is empty (safe default).

---

## 4. TOOLS LAYER (`packages/tools`)

### 4.1 Registered Meta tools (13 total)
**READ (5):** `meta.accounts`, `meta.campaigns`, `meta.ad-sets`, `meta.ads`, `meta.insights`
**WRITE (9):**
- `meta.campaign.pause` / `meta.campaign.resume`
- `meta.adset.pause` / `meta.adset.resume`
- `meta.ad.pause` / `meta.ad.resume`
- `meta.campaign.budget.update`
- `meta.adset.budget.update`
- `meta.create-campaign`

All write tools carry `requiresApproval=true` + risk level (`EXTERNAL_SIDE_EFFECT`-level via base-tool + `RISK_REQUIRES_APPROVAL` map) + `stateHash`/`paramsHash` idempotency + execution-journal consumption. (Source: `meta-ads-write-tools.ts`, `meta-ads-provider.ts`, `base-tool.ts`.)

### 4.2 Budget guardrails (`meta-ads-budget-guardrails.ts`)
```
DEFAULT_BUDGET_GUARDRAILS = {
  maxDailyBudget: 10_000,     // $10k cap
  maxIncreasePercent: 25,     // +25%
  maxIncreaseAbsolute: 2500,
  maxDecreasePercent: 50,     // -50%
  maxDecreaseAbsolute: 5000,
}
```

### 4.3 Infrastructure
- **`ToolRegistry`** (`registry.ts`): keyed by `tool.id`; `get/getAll`.
- **`resolvingRegistry`** (in container.ts): wraps registry lookup with `sanitizeToolName` (dots→hyphens, e.g. `meta.insights`→`meta-insights`) to survive LLM tool-name sanitization; original id restored via map. This is the fix that makes read/write tools reachable via the LLM.
- **`ToolExecutor`** (`executor.ts`): approval check + `paramsHash` re-verify + `timeout 30000ms` optional `ShutdownLifecycle` gate (Phase 10.6).
- **`ExecutionJournal`** (`execution-journal.ts`): durable journal; production must inject `PrismaToolExecutionRepository`; `MemoryExecutionJournal` used in tests.
- **`recommendation-bridge.ts`** (Phase 11.6A): safe execution of an APPROVED recommendation via existing tools (ApprovalService + Journal + MetaAccountAuthorizer); never calls Graph directly.

---

## 5. AGENTS LAYER (`packages/agents`)

| Agent | Category | Status |
|-------|----------|--------|
| `conversational-assistant` | `ai-core` | The **only** registered agent (via `agentRegistry` singleton in `registry.ts`) |

- **`base-agent.ts`:** base class.
- **`orchestrator.ts`:** `DEFAULT_MAX_TOOL_EXECUTIONS=10`, `DEFAULT_MAX_ORCHESTRATION_DEPTH=5`, `DEFAULT_RELEVANCE_THRESHOLD=0.3`, plus `ToolDescriptionBuilder`/`ToolPlanValidator`/`ToolPlanParser`. Provides `process()` selection by `agentRegistry`.
- **`intent-detector.ts`:** heuristic (no LLM) for CONFIRM/REJECT/MODIFY/NEW_ACTION/CLARIFY over pending actions; supports ₹/INR budget parsing + objective mapping + expired detection.
- **`pending-action-service.ts` (Phase 11.9):** manages the `Approval`-backed lifecycle: create → WAITING_CONFIRMATION → APPROVED/REJECTED/NONE/EXECUTING; modify reissues a new approval.

**Sprint-2 gap:** none of the `conversational-assistant` behavior is Meta-specific; no dedicated meta ads agent id exists.

---

## 6. INTELLIGENCE PIPELINE (`packages/core`) — ACCESSIBILITY

| Stage | File | IMPLEMENTED | USER-ACCESSIBLE | Entry point |
|-------|------|-------------|-----------------|-------------|
| KPI Engine | `kpi-engine.ts` | ✓ | NO | internal to aggregator/outcome; script propose.ts |
| Performance Aggregator | `performance-aggregator.ts` | ✓ | NO | script propose.ts + outcome-worker (unwired) |
| Anomaly Engine | `anomaly-engine.ts` | ✓ | NO | script propose.ts only |
| Evidence Builder | `evidence-builder.ts` | ✓ | NO | script propose.ts + diagnosis |
| Diagnosis Engine | `diagnosis-engine.ts` (LLM) | ✓ | NO route | script propose.ts only |
| Recommendation Engine | `recommendation-engine.ts` | ✓ | NO (only list/execute routes read pre-seeded rows) | script propose.ts + DB repo |
| Recommendation Confidence | `recommendation-confidence.ts` | ✓ | NO | internal to rec-engine |
| Opportunity Scoring | `opportunity-scoring.ts` | ✓ | **YES** (indirect) | via queue service → GET /api/v1/opportunities |
| Opportunity Queue | `opportunity-queue-service.ts` | ✓ | **YES** | GET /api/v1/opportunities, GET /:id |
| Outcome Engine | `outcome-engine.ts` | ✓ | NO | internal to outcome-worker (unwired) |
| Outcome Worker | `outcome-worker.ts` | ✓ | **NO** | NOT wired anywhere (no route/cron/scheduler) |
| Historical Outcome Engine | `historical-outcome-engine.ts` | ✓ | NO | internal to rec-engine |

**Key finding:** Only `Opportunity Scoring` + `Opportunity Queue` are user-accessible (read-only). The full **generate** pipeline has exactly **one** entry: `apps/api/scripts/phase116b/propose.ts` (standalone CLI, not a route, not automated). Recommendations in the DB are produced only by that script or direct `PrismaRecommendationRepository` writes.

---

## 7. API ROUTES MOUNTED (`apps/api/src/index.ts` + relevant files)

| Route | Method | Purpose | Writes? |
|-------|--------|---------|---------|
| `/api/v1/health` | GET | Health | No |
| `/api/v1/auth` (+register/login/refresh) | POST | Auth | Yes (accounts) |
| `/api/v1/chat` | POST | Chat/orchestrator (`detectIntent`) | Indirect via tools |
| `/api/v1/conversations` | GET/CRUD | Conversations | Yes |
| `/api/v1/approvals` | GET, GET/:id, POST/:id/approve, POST/:id/reject | Approval flow (single-winner, idempotent reject) | Yes |
| `/api/v1/pending-actions` | GET, POST/:id/confirm|reject|modify | Pending-action handoff | Yes |
| `/api/v1/recommendations` | GET, GET/:id, POST/:id/execute | List/detail/execute (via RecommendationExecutionService + paramsHash/stateHash) | Yes (execute) |
| `/api/v1/opportunities` | GET, GET/:id | Ranked queue + full detail (read-only) | No |
| `/api/v1/recommendations/:id/outcome` | GET | Outcome view | No |
| `/api/v1/outcomes/:id` | GET | Outcome detail | No |

**No production route generates recommendations from Meta.** Web UI (`apps/web`) surfaces: approvals, opportunities (+detail), chat with message-list, pending-action-card, tool-execution-card — all calling the routes above.

---

## 8. DATABASE MODELS (PRISMA) — 22 models

`User`, `RefreshToken`, `Conversation`, `Message`, `Agent`, `Memory`, `KnowledgeDocument`, `KnowledgeChunk`, `Approval`, `AuditLog`, `Integration`, `UserSetting`, `ToolExecution`, `MarketingAccount`, `MetricSnapshot`, `PerformanceRecommendation`, `DecisionRecord`, `OutcomeRecord`, `OutcomeRevision`.

Relevant to Sprint 2 reuse: `ToolExecution` (execution journal), `Approval` (pending action backing), `PerformanceRecommendation` (proposed/approved recommendations), `OutcomeRecord`/`OutcomeRevision` (measured outcomes), `Agent` (agent registry rows — a future agent row could be added here).

---

## 9. TEST INVENTORY (verified counts; mock provider only, ZERO real Meta writes)

| Area | File(s) | `it(`/`test(` total |
|------|---------|----------------------|
| meta-graph | campaign-reconciler 20, client-signal 9+1, insights-validator 4, meta-authorization 19, meta-graph 44 | → **97** |
| tools | execution-journal 6, executor-abort 6, executor-params-hash 6, meta-ads-budget 72, meta-ads-campaign 70, meta-ads-write 51, meta-ads 78, output-sanitizer 21, phase102-concurrency 10, phase106-shutdown 20, state-port 4, recommendation-bridge 35, reconciliation 22, registry 28 | → **429** |
| core | recommendation-engine 53, opportunity-scoring 33, anomaly 13, diagnosis 56+3, kpi 4, outcome-engine 52, outcome-worker 11, historical 17, confidence 48 (+ evidence-builder, performance-aggregator, params-hash, tool-intelligence) | → **287+** |
| agents | approval-flow-regression, campaign-creation-context, meta-analytics-chat-access, multi-turn-context, orchestrator-memory, orchestrator-tool-intelligence, pending-action, tool-execution-anti-hallucination, tool-planner | (counted separately) |
| security | tool-approval-params-hash, tool-approval (18) | **18** |
| api | approvals 28, chat 25, container-wiring-meta-tools 13, opportunities 30, phase116a-bridge-pg (integration), + sprint-1.1a/b/c/d-memory | **96+** |

All Meta-provider tests use the `MockMetaProvider` (`packages/tools/src/tools/meta-ads-mock.ts`) or fake providers; the container gates real provider on env vars; **real Meta write count = 0** in every test.

---

## 10. HISTORICAL META BUGS ALREADY FIXED (evidence from code/tests)

| Bug / issue | Where fixed | Mechanism |
|-------------|-------------|-----------|
| Tool-name dots not resolvable by executor | `container.ts` `sanitizeToolName` + `resolvingRegistry` map | dots→hyphens then reverse-map to original id |
| Generic Meta errors not classified | `packages/meta-graph/src/error-handler.ts` + `response-validator.ts` | typed error taxonomy + response schema validation |
| Stale approval reuse / changed params | `packages/security/src/tool-approval.ts` + `packages/core/src/utils/params-hash.ts` | `paramsHash` SHA-256 binding, fail-closed on any mismatch or missing hash |
| Budget floor / oversized budget | `meta-ads-budget-guardrails.ts` + `recommendation.ts` (`RECOMMENDATION_BUDGET_GUARDRAILS` parity) | max $10k, +25%/-50%, abs caps, `proposeBudgetChange` clamping |
| Missing account ID (authorization) | `MetaAccountAuthorizer` + `container.ts` gating on env | server-side; no trust of client account ids |
| Provider authorization / ACTIVE check | `packages/meta-graph/test/meta-authorization.test.ts` (19 tests) | authorizer + account status check |
| Special ad categories (restricted) | `packages/meta-graph` + write-tools risk levels | approval-bound high-risk writes |
| Recommendation bridge unsafe direct Graph call | `packages/tools/src/recommendation-bridge.ts` | routes through existing safe tools + ApprovalService + Journal |
| Timeout ambiguity | `packages/tools/src/executor.ts` + execution-journal | `UNKNOWN` outcome; never auto-retried |
| Execution idempotency / duplicate write | journal UNIQUE constraint + `paramsHash` | atomic consumption, single-winner lease |

---

## 11. KEY GAPS FOR SPRINT 2

1. **No dedicated Meta Ads agent** — only `conversational-assistant` exists (`packages/agents/src/registry.ts`).
2. **Intelligence pipeline not user-triggered** — only read-only projections (opportunities/recommendations/outcomes) are HTTP-accessible; generation requires `phase116b/propose.ts` script.
3. **OutcomeWorker not wired** — no scheduler/cron/startup hook invokes it.
4. **No user-facing automation trigger** for a full "analyze my account → recommend" flow (only chat can call read tools + the standalone script can generate rows).
5. **Real provider is env-gated** — with `META_ACCESS_TOKEN`/`META_AD_ACCOUNT_ID` unset, the meta registry is empty (safe but not operational for a dedicated agent).

---

## 12. RECOMMENDED SPRINT-2 APPROACH (consistent with this baseline)

- Register a **single** dedicated Meta Ads agent (id, category, name) in `packages/agents/src/registry.ts` — still a single-agent, single-name simplification, no new physical file/struct refactor.
- Wire it in `apps/api/src/services/container.ts` with the **same** `agentToolRegistry`/`ToolExecutor`/`approvalService`/`pendingActionService`/`executionJournal` — reusing all 13 existing meta tools, budget guardrails, and `resolvingRegistry`.
- Ensure the agent only ever executes write tools via the existing approval+paramsHash+journal path. All tests use `MockMetaProvider`; **real Meta writes stay 0**.
- Update `docs/JARVIS_USER_MANUAL.md`, `JARVIS_CAPABILITY_MATRIX.md`, `JARVIS_ARCHITECTURE.md`, plus this baseline + change-boundary + architecture Mermaid.
- Do NOT touch `packages/meta-graph/*`, `packages/tools/src/*`, `packages/core/src/*`, `packages/db/prisma/schema.prisma`, or `packages/security/*` (frozen per `SPRINT_2_META_ADS_CHANGE_BOUNDARY.md`).

---

## 13. FINAL SAFETY ASSERTION

| Check | Result |
|-------|--------|
| Application code modified | **NO** |
| Database modified | **NO** |
| Real Meta writes | **0** |
| Credentials changed | **NO** |

**Verdict: `SPRINT 2.0 META ADS BASELINE AUDIT — PASS`** — inventory complete, no behavior modified, no real Meta write.
