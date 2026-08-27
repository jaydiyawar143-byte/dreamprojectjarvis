# JARVIS Capability Matrix

## Status Definitions

Every capability is classified across three independent dimensions:

| Status | Definition |
|--------|-----------|
| **IMPLEMENTED** | Code exists in the repository and is structurally complete |
| **VERIFIED** | Covered by automated tests that pass |
| **USER-ACCESSIBLE** | A user can actually reach this capability through the current interface |

These three statuses are **not the same thing.** A capability may be implemented and verified but not user-accessible if the conversational agent cannot currently invoke it.

---

## Capability Matrix

### Meta Integration

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Meta Graph API client | YES | YES | YES | 9.3-R | `packages/meta-graph/src/client.ts`, 103 tests | Requires valid META_ACCESS_TOKEN |
| Meta account authorization | YES | YES | YES | 9.3-R | `packages/meta-graph/test/meta-authorization.test.ts` | Token must be manually provisioned |
| Meta READ (insights) | YES | YES | YES | 9.3-R | Meta insights tool + provider integration | Account must have active campaigns |
| Meta READ (campaigns) | YES | YES | YES | 9.3-R | Meta campaigns tool | — |
| Meta READ (ad sets) | YES | YES | YES | 9.3-R | Meta ad-sets tool | — |
| Meta READ (ads) | YES | YES | YES | 9.3-R | Meta ads tool | — |
| Meta WRITE (pause/resume) | YES | YES | YES* | 9.3, 11.6B | `meta-ads-write-tools.ts`, approval-gated | *Requires human approval |
| Meta WRITE (budget update) | YES | YES | YES* | 9.3, 11.6B | `meta-ads-write-tools.ts`, approval-gated | Max $10,000, 25% increase cap, 50% decrease cap |
| Meta WRITE (create campaign) | YES | YES | YES* | 9.3, 11.6B | `MetaCreateCampaignTool` | Requires approval; mock-verified only |
| Meta response validation | YES | YES | YES | 9.3-R | `packages/meta-graph/src/response-validator.ts` | — |
| Meta error classification | YES | YES | YES | 9.3-R | `packages/meta-graph/src/error-handler.ts` | — |
| Meta secret redaction | YES | YES | YES | 9.3-R | Token patterns redacted in all output | — |

### Security & Approval

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| User authentication (JWT) | YES | YES | YES | 10.7 | `packages/security/src/auth.ts` | — |
| Password hashing (scrypt) | YES | YES | YES | — | `packages/security/src/password.ts` | Per-user salt, timing-safe |
| Refresh token rotation | YES | YES | YES | — | `packages/security/src/tokens.ts` | Reuse detection |
| RBAC (Owner/Admin/Member/Viewer) | YES | YES | YES | — | `packages/security/src/permissions.ts` | 4-level hierarchy |
| Approval creation | YES | YES | YES | 10.3 | `packages/security/src/approval.ts`, DB integration | — |
| Approval paramsHash binding | YES | YES | YES | 10.3 | `packages/core/src/utils/params-hash.ts`, SHA-256 | Canonical serialization |
| Approval consumption | YES | YES | YES | 10.3 | `packages/db/test/phase103-approval-consumption.test.ts` | Atomic one-time use |
| Approval expiry | YES | YES | YES | 10.7 | DB integration + API route | Time-limited |
| Approval IDOR protection | YES | YES | YES | 10.7 | Integration tests | Account + user isolation |
| Audit logging | YES | YES | YES | — | `packages/security/src/audit.ts` | Every request logged |

### Execution Journal & Idempotency

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Durable execution journal | YES | YES | YES | 10.1 | `packages/tools/src/execution-journal.ts`, DB-backed | — |
| Idempotency (UNIQUE constraint) | YES | YES | YES | 10.2 | `packages/db/test/phase102-concurrency-pg.integration.test.ts` | DB-enforced |
| Lease-based claims | YES | YES | YES | 10.2 | `phase102-concurrency-tools.test.ts` | Single-winner guaranteed |
| Crash recovery | YES | YES | YES | 10.2 | `phase102-lease-recovery.test.ts` | Stale → UNKNOWN (never FAILED) |
| Timeout/AbortSignal safety | YES | YES | YES | 10.4 | `phase104-timeout-classification-pg.integration.test.ts` | Cancellation propagates |
| Reconciliation | YES | YES | YES | 10.5 | `packages/tools/src/reconciliation.ts`, `packages/meta-graph/src/reconciler.ts` | FOUND/NOT_FOUND/UNCERTAIN |
| Shutdown lifecycle | YES | YES | YES | 10.6 | `phase106-shutdown-lifecycle.test.ts` | Forward-only state machine |
| Unknown outcome handling | YES | YES | YES | 10.5 | Reconciliation service | Never auto-retried |

### KPI & Analytics

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| KPI calculation (CTR, CPC, CPM, CPA, ROAS, CVR, Frequency) | YES | YES | YES | 11.1 | `packages/core/src/kpi-engine.ts`, 80+ tests | — |
| Performance aggregation | YES | YES | YES | 11.2 | `packages/core/src/performance-aggregator.ts` | — |
| Period-over-period comparison | YES | YES | YES | 11.2 | Metric comparison functions | — |
| Time window calculation | YES | YES | YES | 11.2 | `computeDateWindowRange` | 9 preset windows + custom |
| Data quality assessment | YES | YES | YES | 11.2 | COMPLETE/PARTIAL/UNAVAILABLE | — |

### Anomaly Detection

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Statistical anomaly detection | YES | YES | YES | 11.3 | `packages/core/src/anomaly-engine.ts`, 40+ tests | Median/MAD method |
| Directional semantics | YES | YES | YES | 11.3 | CPA higher = bad, CTR lower = bad | — |
| Severity classification | YES | YES | YES | 11.3 | WARNING/CRITICAL thresholds | z-score based |
| Deterministic anomaly IDs | YES | YES | YES | 11.3 | Content-based hashing | — |

### AI Diagnosis

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Evidence packaging | YES | YES | YES | 11.4 | `packages/core/src/evidence-builder.ts` | Strict Zod validation |
| AI-powered diagnosis | YES | YES | YES | 11.4 | `packages/core/src/diagnosis-engine.ts` | Only LLM-dependent step |
| Fact/inference separation | YES | YES | YES | 11.4 | Structured output labels | — |
| Prompt injection defense | YES | YES | YES | 11.4 | `packages/core/src/diagnosis-prompt.ts` | — |
| Deterministic parsing | YES | YES | YES | 11.4 | Zod-validated LLM output | Fallback to generic on parse failure |

### Recommendations

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Deterministic recommendation generation | YES | YES | YES | 11.5 | `packages/core/src/recommendation-engine.ts` | No LLM dependency |
| Action catalog (14 categories) | YES | YES | YES | 11.5 | PAUSE/RESUME + budget actions | — |
| Budget guardrails | YES | YES | YES | 11.5 | Max $10,000, 25%/50% caps | — |
| Conflict detection | YES | YES | YES | 11.5 | Per-entity conflict rules | — |
| State hash verification | YES | YES | YES | 11.5 | Stale-state protection | — |
| Execution bridge | YES | YES | YES | 11.6A | `packages/tools/src/recommendation-bridge.ts` | — |
| Recommendation confidence | YES | YES | YES | 11.8B | `packages/core/src/recommendation-confidence.ts` | Deterministic, no LLM |
| Historical evidence integration | YES | YES | YES | 11.8B | 48 tests, 15 checkpoints | — |
| Priority scoring | YES | YES | YES | 11.8B | Additive score ≠ confidence | — |

### Outcome Measurement

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Outcome recording | YES | YES | YES | 11.7A | `packages/core/src/outcome-engine.ts` | — |
| Baseline capture | YES | YES | YES | 11.7A | Immutable at execution time | — |
| Materiality thresholds | YES | YES | YES | 11.7A | 5% default threshold | — |
| Confounder detection | YES | YES | YES | 11.7A | 6 confounder types | — |
| Outcome worker (batch) | YES | YES | YES | 11.7B | `packages/core/src/outcome-worker.ts` | Idempotent, crash-recoverable |
| DB persistence | YES | YES | YES | 11.7A | OutcomeRecord + OutcomeRevision tables | Migrations pending |

### Historical Intelligence

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Historical outcome matching | YES | YES | YES | 11.8A | `packages/core/src/historical-outcome-engine.ts` | — |
| Consistency assessment | YES | YES | YES | 11.8B | CONSISTENT_POSITIVE/MIXED/CONSISTENT_NEGATIVE | — |
| Recency decay | YES | YES | YES | 11.8B | Time-weighted relevance | — |
| Evidence traceability | YES | YES | YES | 11.8B | Linked to source outcomes | — |
| No causal claims | YES | YES | YES | 11.8B | By design | — |

### Opportunity Prioritization

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Opportunity scoring | YES | YES | YES | 11.9A | `packages/core/src/opportunity-scoring.ts` | — |
| Weighted formula | YES | YES | YES | 11.9A | severity(.25) + impact(.20) + urgency(.15) + confidence(.15) + historical(.10) + reversibility(.05) | — |
| Priority bands | YES | YES | YES | 11.9A | CRITICAL(≥80)/HIGH(≥60)/MEDIUM(≥40)/LOW(≥20)/IGNORE | — |
| Eligibility gates | YES | YES | YES | 11.9A | PROPOSED/APPROVED only | — |
| Conflict detection | YES | YES | YES | 11.9A | Per-entity exclusivity | — |
| Explainability | YES | YES | YES | 11.9A | Score breakdown provided | — |
| Opportunity queue API | YES | YES | YES | 11.9B | `apps/api/src/routes/opportunities.ts`, 30 tests | Read-only, no mutations |
| Opportunity queue web UI | YES | YES | YES | 11.9B | `apps/web/src/app/opportunities/page.tsx`, detail page | — |
| Opportunity detail review | YES | YES | YES | 11.9B | Score breakdown, evidence, action preview | — |
| Approval handoff | YES | YES | YES | 11.9B | Routes through existing Phase 10 approval flow | — |
| IDOR protection (queue) | YES | YES | YES | 11.9B | Server-computed scores, accountId from env | — |

### Dedicated Meta Ads Agent (Sprint 2 Scope)

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Dedicated Meta Ads agent (Sprint 2.1) | YES | YES | YES | Sprint 2.1 | `packages/agents/src/agents/meta-ads-agent.ts`, `packages/agents/test/meta-ads-agent.test.ts` (24 tests) | Specialized Meta reasoning |
| Auto-namespace intent-based routing | YES | YES | YES | Sprint 2.1 | `packages/agents/src/orchestrator.ts` (`isMetaAdsQuery` routing) | Fallback to default ConversationalAssistant |
| Meta Ads domain reasoning (Sprint 2.2) | YES | YES | YES | Sprint 2.2 | Campaign hierarchy, objective-aware KPIs, relationships, creative fatigue, delivery states | Reuses existing engines, no duplicate engines |
| Meta agent write execution | YES | YES | YES | Sprint 2.1 | Writes handled via existing Tools & Approval Service | Bounded by human approval |
| Real Meta write via new agent | 0 | N/A | N/A | Sprint 2.1 | audit requirement | **Must stay 0** |

### Conversational Access

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Chat interface | YES | YES | YES | — | `apps/web/src/app/chat/`, `apps/api/src/routes/chat.ts` | — |
| WebSocket streaming | YES | YES | YES | — | Socket.IO integration | — |
| Conversation persistence | YES | YES | YES | — | Prisma Conversation + Message models | — |
| Conversation isolation | YES | YES | YES | — | Repository-level ownership checks | — |
| Agent selection | YES | YES | YES | — | Agent registry | 1 agent currently registered |

### Memory & Knowledge

| Capability | Implemented | Verified | User-Accessible | Phase | Evidence | Limitations |
|-----------|-------------|----------|----------------|-------|----------|-------------|
| Persistent memory wiring (Sprint 1.1A) | YES | YES | YES | Sprint 1.1A | `apps/api/src/services/container.ts` L319–357, `packages/db/src/repositories/memory-repository.ts`, `apps/api/test/sprint-1.1a-memory-wiring.test.ts` (24 tests) | Production container wired |
| Memory store (PrismaMemoryRepository) | YES | YES | YES | Sprint 1.1A | `packages/db/src/repositories/memory-repository.ts`, Memory table in PostgreSQL w/ pgvector | Only reachable with live DB |
| MemoryEngine | YES | YES | YES | Sprint 1.1A | `packages/memory/src/memory-engine.ts` | Requires persistent store + embedding provider |
| Memory extraction service (Sprint 1.1B) | YES | YES | YES | Sprint 1.1B | `packages/memory/src/memory-extraction-service.ts`, `apps/api/test/sprint-1.1b-memory-extraction.test.ts` (11 tests) | Runs in background post-conversation |
| Embedding generation | YES | YES | YES | Sprint 1.1A | `packages/ai-openai/src/openai-embedding-provider.ts` | Requires OPENAI_API_KEY; graceful degradation if absent |
| Knowledge base (RAG) | YES | YES | PARTIAL | — | `packages/memory/src/knowledge-base.ts` | Document upload UI incomplete |
| Memory recall in conversation (Sprint 1.1C) | YES | YES | YES | Sprint 1.1C | `packages/agents/src/orchestrator.ts` L122, `apps/api/test/sprint-1.1c-memory-recall.test.ts` (10 tests) | Active context retrieval; scoped by userId |
| Full memory E2E lifecycle (Sprint 1.1D) | YES | YES | YES | Sprint 1.1D | `apps/api/test/sprint-1.1d-memory-e2e.test.ts` (12 tests) | Complete extract → persist → recall behavioral verification |

### What Is NOT Implemented

| Capability | Status | Notes |
|-----------|--------|-------|
| User-triggered recommendation generation (HTTP) | NOT IMPLEMENTED | Pipeline generation exists only via `apps/api/scripts/phase116b/propose.ts` (standalone CLI, not a route/worker) |
| Outcome worker automation | NOT IMPLEMENTED | `OutcomeWorker` implemented + tested but never wired to a scheduler/cron/route |
| Autonomous optimization | NOT IMPLEMENTED | By design — every write requires human approval |
| A/B experimentation | NOT IMPLEMENTED | Explicitly deferred to Phase 12 |
| Multi-platform advertising | NOT IMPLEMENTED | Only Meta (Facebook/Instagram) supported |
| Website analytics integration | NOT IMPLEMENTED | No landing page or conversion tracking data |
| Automated bidding | NOT IMPLEMENTED | No programmatic bid management |
| Self-modifying prompts | NOT IMPLEMENTED | Prompts are static and auditable |
| Reinforcement learning | NOT IMPLEMENTED | No self-improving model optimization |
| Multi-user collaboration | PARTIAL | RBAC exists but no real-time collaboration |
| n8n automation integration | PARTIAL | Wrapper exists, no active workflows |
| WhatsApp integration | PARTIAL | Wrapper exists, not wired to agents |

---

*Document version: 1.6*
*Last updated: 2026-08-27*
*Sprint 2.2 complete: Dedicated MetaAdsAgent domain intelligence reasoning implemented, verified, and E2E tested (24 scenarios).*
