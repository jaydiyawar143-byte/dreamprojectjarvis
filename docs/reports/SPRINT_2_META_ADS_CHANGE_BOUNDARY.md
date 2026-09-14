# SPRINT 2 — Meta Ads Dedicated Agent: Change Boundary

> **Type:** Change-Boundary Specification (pre-implementation)
> **Applies to:** JARVIS monorepo (`@jarvis/*`)
> **Date:** 2026-08-27 · **Branch:** main
> **Objective:** Turn the existing single `conversational-assistant` into a SIMPLIFIED single-agent Meta Ads agent WITHOUT a new physical file or structural refactor, reusing the existing tooling, approval, and intelligence stack. Zero meta Ads-behavioral changes in this sprint.

---

## 1. Scope Intent

Sprint 2 introduces a dedicated Meta Ads agent that a user can explicitly target. It MUST be a **single-agent, single-name** simplification — NOT a new physical agent file, NOT an orchestrator refactor to multi-agent routing, and NOT a rewrite of any existing infrastructure. The entire build sits on top of the already-implemented and verified tools, engines, and approval flow.

---

## 2. OUT OF SCOPE (MUST NOT CHANGE)

The following are **frozen** for Sprint 2. Any change request touching them is REJECTED unless a **written exception** is granted:

| Area | Boundary | Reason |
|------|----------|--------|
| **Meta Graph provider** | `packages/meta-graph/src/*` (provider, client, config, error-handler, reconciler, response-validator) | Already full-featured: v21.0, read+write+budget+create, validation, reconciliation. Duplicating or replacing it is prohibited. |
| **Tool implementations** | `packages/tools/src/tools/meta-ads-*.ts`, `meta-ads-mock.ts`, `base-tool.ts` | All 5 READ + 9 WRITE tools + validators + budget guardrails already exist and are verified. No new tools in Sprint 2. |
| **Tool infrastructure** | `registry.ts`, `executor.ts`, `execution-journal.ts`, `reconciliation.ts`, `recommendation-bridge.ts`, `output-sanitizer.ts` | Registry, executor (approval+paramsHash+timeout), journal, reconciliation, and bridge are the safety backbone. No behavioral change. Sprint 2 only *wires* to them. |
| **Core engines** | `packages/core/src/kpi-engine.ts`, `performance-aggregator.ts`, `anomaly-engine.ts`, `diagnosis-engine.ts`, `recommendation-engine.ts`, `opportunity-*.ts`, `outcome-*.ts`, `historical-outcome-engine.ts`, `recommendation-confidence.ts` | All implemented + verified. Sprint 2 does NOT alter their deterministic logic. |
| **Prisma schema / DB** | `packages/db/prisma/schema.prisma` and all migrations | Zero schema drift. No new tables/columns in Sprint 2. |
| **Security / Approval** | `packages/security/src/*`, `packages/core/src/utils/params-hash.ts` | Approval+paramsHash+consumption+expiry+IDOR are intact. No bypasses. |
| **Security credentials / secrets** | `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_GRAPH_API_VERSION`, other secrets | All real Meta credentials are READ-ONLY during Sprint 2; none are rotated, added, or exposed. |
| **Real Meta writes** | Any real Graph API write call | Sprint 2 MUST keep real Meta write count = 0 (approvals + journal only; execution layer is unchanged). |

**"Simplification" caveat:** If Sprint 2's *"simplify the smart agent"* work requires touching even one of the frozen files above, that task is a **blocker** and must be surfaced in a written exception (see §6). Do not silently alter frozen behavior.

---

## 3. IN SCOPE (can be modified / added)

| Area | Allowed change | Evidence source |
|------|----------------|-----------------|
| **`apps/api/src/services/container.ts`** | Add/register a **single** new dedicated Meta Ads agent into the existing `agentRegistry`, wiring: the same `ToolRegistry`/`agentToolRegistry`, the same `ToolExecutor` (approval+paramsHash), the same `intent-detector`, `pendingActionService`, and execution-journal. Add the existing 13 meta tools to the agent's tool list. NO rewrite of the registry / orchestrator / security layer. | container.ts (real-meta gated on env; `resolvingRegistry`) |
| **`packages/agents/src/registry.ts`** | Register the one dedicated Meta Ads agent (id, category, name) — still a hand-rolled, explicit registry entry (this is NOT a multi-agent router). | registry.ts (`export const agentRegistry`) |
| **`packages/agents/src/orchestrator.ts`** | Read-use of the new agent (add it to the result of the existing registry selection). NO change to auto-namespace routing or default behavior. | orchestrator.ts (DEFAULT_MAX_TOOL_EXECUTIONS=10, DEPTH=5) |
| **`apps/api/src/routes/*.ts`** | Possibly an `POST /api/v1/chat/agents/:agentId`-style explicit agent route — only if the sprint plan includes it. If not, the dedicated agent is reachable via the existing `POST /api/v1/chat`. | chat.ts (`detectIntent` used) |
| **`apps/web/src/**`** | Minimal UI labels: show the dedicated meta-ads agent name in chat header / agent picker. NO new charts/canvases in Sprint 2. | `apps/web/src` (22 .ts/.tsx files) |
| **`docs/*`** | Update `JARVIS_USER_MANUAL.md`, `JARVIS_CAPABILITY_MATRIX.md`, `JARVIS_ARCHITECTURE.md`, plus this change boundary and the sprint report. | repo root |
| **Tests** | New unit tests for the new agent wiring (destroy/destroy-dedicated behavior), always against MOCK meta provider. Real-meta tests are forbidden. | `packages/agents/test/*`, `apps/api/test/container-wiring-meta-tools.test.ts` (13 tests) |

---

## 4. CONTRACTS STABLE (MUST NOT CHANGE)

| Contract | File(s) | Rule |
|----------|---------|------|
| Tool id strings | `meta.accounts`, `meta.campaigns`, `meta.ad-sets`, `meta.ads`, `meta.insights`, `meta.campaign.pause/resume`, `meta.adset.pause/resume`, `meta.ad.pause/resume`, `meta.campaign.budget.update`, `meta.adset.budget.update`, `meta.create-campaign` | Never rename. `resolvingRegistry` (sanitizeToolName dots→hyphens) is the only name translation and MUST stay. |
| Approval contracts | `Approval` DB model, `paramsHash` binding, expiration, one-time consumption | Never weaken. |
| Execution journal | `ToolExecution` DB model, states (PENDING/APPROVED/EXECUTING/SUCCEEDED/FAILED/UNKNOWN/RECONCILING/SAFE_TO_RETRY/CANCELLED); UNKNOWN never auto-retried | Never alter. |
| Budget guardrails | `DEFAULT_BUDGET_GUARDRAILS` (maxDailyBudget 10000, +25%/-50%, abs caps) + `RECOMMENDATION_BUDGET_GUARDRAILS` parity | Never change values. |
| Type contracts | `MetaAdAccountSchema`, `MetaCampaignSchema`, `MetaAdSetSchema`, `MetaAdSchema`, `MetaInsightsSchema` in `packages/core/src/types/meta-ads.ts` | Frozen in Sprint 2. |
| Risk model | `RiskLevel` (`READ_ONLY`/`LOW_IMPACT`/`EXTERNAL_SIDE_EFFECT`/`HIGH_IMPACT`/`FINANCIAL`) and `RiskLevelSchema` | Frozen. |

---

## 5. CLEAR OWNERSHIP (who owns what)

| Owner | Scope |
|-------|-------|
| **Sprint 2 dev** | New single dedicated Meta Ads agent + its container/registry wiring + docs + new tests (mock-only). |
| **Docs** | This boundary, `JARVIS_*` docs, `docs/diagrams/meta-ads-current-architecture.mmd`. |
| **Meta Graph / tools / security / core / db** | **Untouched** (frozen). Any need to touch → written exception (below). |

---

## 6. EXCEPTION PROCESS

If implementing the dedicated agent **requires** a change to any Out-of-Scope item above, the change is **blocked** until a written exception is captured here:

- **Exception 1: Baseline health defect resolution.** Restored the commented-out declaration of `comparePerformanceSummaries` inside `packages/core/src/performance-aggregator.ts` to restore health to core tests.

After every Sprint 2 commit, re-verify the following frozen invariants are still true:

- [x] `packages/meta-graph/src/*` content unchanged (byte-for-byte).
- [x] `packages/tools/src/tools/meta-ads-*.ts` and `base-tool.ts` content unchanged (byte-for-byte).
- [x] `packages/core/src/kpi-engine.ts`, `performance-aggregator.ts` (except Exception 1), `anomaly-engine.ts`, `diagnosis-engine.ts`, `recommendation-engine.ts`, `opportunity-*.ts`, `outcome-*.ts` unchanged (byte-for-byte).
- [x] `packages/db/prisma/schema.prisma` unchanged (zero-drift rule).
- [x] `packages/security/src/*` and `packages/core/src/utils/params-hash.ts` unchanged (byte-for-byte).
- [x] No real Meta write anywhere in the new agent code path (execution layer is git-tracked, but agent can only call existing tools).
- [x] No secrets / tokens added or exposed; `.env*` untouched.

---

## 7. Definition of "DONE" for Sprint 2 baseline

- The dedicated Meta Ads agent is registered in `agentRegistry` as a distinct entry with a stable agent id.
- It reuses the existing registered meta tools (no new tools).
- It routes every write request through the existing approval+paramsHash+journal flow.
- It stays **read-only-safe** in tests (mock provider only; zero real writes).
- All three `docs/JARVIS_*` files + this boundary + the architecture Mermaid diagram reflect the new single-agent meta-ads state.
- Final sprint report asserts: `Application code modified = YES (agent wiring)`, `Database modified = NO`, `Real Meta writes = 0`, `Credentials changed = NO`.

---

*Baseline-frozen on 2026-08-27. Any exception added here becomes part of the reason the sprint ships. This document is a living artifact for Sprint 2 only.*
