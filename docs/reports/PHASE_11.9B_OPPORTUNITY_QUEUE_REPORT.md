# PHASE 11.9B — OPPORTUNITY QUEUE + HUMAN DECISION INTERFACE REPORT

## Objective

Deliver a ranked, read-only opportunity queue with a web-based human review interface and an approval handoff that routes through the existing Phase 10 approval flow. Zero autonomous execution. Zero Meta writes. Zero LLM calls.

## Implementation Surface

- **Core service:** `packages/core/src/opportunity-queue-service.ts` (527L)
  - `buildOpportunityQueue()` — Scores, ranks, deduplicates, and paginates opportunities using the Phase 11.9A scoring engine.
  - `buildOpportunityDetail()` — Produces a full detail view for a single opportunity with server-computed score breakdown and display status.
  - `explainNoOpportunities()` — Returns a structured "no opportunities" explanation when the queue is empty.
  - Stale/conflict detection, expiration checks, and priority band classification.

- **API routes:** `apps/api/src/routes/opportunities.ts` (252L)
  - `GET /api/v1/opportunities` — Paginated ranked queue with filters (priority, status, entityType, actionType, limit).
  - `GET /api/v1/opportunities/:id` — Full detail for human review.
  - IDOR protection: `accountId` always from `process.env.META_AD_ACCOUNT_ID`, never from client.
  - `isValidId()` guard prevents probing with malformed IDs.
  - Score, priority, and historical evidence are server-computed — clients cannot inject forged values.
  - No mutation endpoints. No POST. No execute.

- **DB repository:** `packages/db/src/repositories/recommendation-repository.ts`
  - `listForOpportunityQueue(userId, accountId)` — Fetches all eligible records scoped by user+account.
  - `getForOpportunityDetail(recommendationId, userId, accountId)` — Fetches a single record with IDOR-safe access control.

- **Web UI:**
  - `apps/web/src/app/opportunities/page.tsx` (275L) — Queue list page with filters, priority badges, loading/empty states.
  - `apps/web/src/app/opportunities/[id]/page.tsx` (594L) — Detail review page with score breakdown, evidence, action preview, approve/reject buttons.
  - `apps/web/src/components/opportunity-card.tsx` (211L) — Reusable card component.

- **Tests:** `apps/api/test/opportunities.test.ts` (30 test cases)

## Security Architecture

- All operations scoped to `req.auth.userId` — IDOR-safe.
- `accountId` ALWAYS from `process.env.META_AD_ACCOUNT_ID`, never from client.
- Score/priority/historical evidence server-computed via Phase 11.9A engine.
- NO mutation endpoints. No POST. No execute. ZERO Meta writes on any path.
- ZERO LLM calls on any path.
- Secrets (tokens, keys) never appear in output.
- Approval handoff routes through existing Phase 10 approval flow — no new approval logic.

## Test Results

### A. Queue creation: PASS
Returns empty queue with `noOpportunity` explanation for account with no records.

### B. Ranking: PASS
Items returned in descending score order.

### C. Pagination: PASS
`limit` query param restricts result count; server cap enforced at 100.

### D. Filters: PASS
Invalid priority string silently ignored (whitelist). Valid priority filter restricts to matching items. entityType and actionType filters work correctly. Combined filters narrow results.

### E. Priority bands: PASS
All items have a valid priority band (CRITICAL/HIGH/MEDIUM/LOW/IGNORE).

### F. Recommendation detail: PASS
Returns full detail with score breakdown, display status, and server-computed fields.

### G. Account isolation: PASS
Different account ID returns different results. Cannot see another account's opportunities.

### H. User isolation: PASS
Different user token returns different results. Cannot see another user's opportunities.

### I. IDOR protection: PASS
Forged account ID in request is ignored — server uses env var. Malformed recommendation IDs rejected by `isValidId()` guard.

### J. Expired opportunity: PASS
Expired recommendations are filtered from the queue (display status: EXPIRED).

### K. Stale state: PASS
Stale recommendations flagged with stale reasons in detail view.

### L. Conflict state: PASS
Conflicting recommendations for same entity are detected and flagged. Higher-scoring recommendation surfaces.

### M. No-opportunity state: PASS
Empty queue returns structured `noOpportunity` explanation with possible reasons.

### N. Unauthorized access: PASS
Request without valid token returns 401.

### O. Forged score: PASS
Client cannot inject or override server-computed score. Score in response matches server computation.

### P. Forged priority: PASS
Client cannot inject or override server-computed priority.

### Q. Forged historical evidence: PASS
Client cannot inject or override server-computed historical evidence.

### R. paramsHash protection: PASS
paramsHash is server-computed and returned in response for approval binding.

### S. Approval handoff: PASS
Approving an opportunity creates a proper approval record routed through the existing Phase 10 approval flow.

### T. No automatic execution: PASS
Approving does not automatically execute. Approval creates a record; execution requires separate step.

### U. Zero Meta writes while browsing: PASS
Browsing queue and viewing detail never calls any Meta write tool. Spy confirms zero invocations.

### V. Deterministic ordering: PASS
Two identical calls return identical order. Same inputs → same outputs.

### W. Error handling: PASS
Server errors return structured error response with code and message.

### X. Secret redaction: PASS
Tokens and keys never appear in API responses.

### Y. Backward compatibility: PASS
Existing recommendation routes unaffected. Opportunity queue is additive.

### Z. POST rejection: PASS
POST to opportunities endpoint returns 404 — no mutation routes exist.

## Regression Results

| Check | Result |
|-------|--------|
| `pnpm typecheck` | 23/23 packages PASS |
| `pnpm db:generate` | Prisma Client v5.22.0 PASS |
| Opportunity API tests | 30/30 PASS |
| Core scoring tests | 32/32 PASS (pre-existing) |
| API tests (non-opportunity) | 30/30 PASS (excl. pre-existing PG integration) |

### Pre-existing failures (NOT Phase 11.9B)

- `apps/api/test/phase116a-bridge-pg.integration.test.ts` — 8 failures (PostgreSQL unavailable locally).
- `packages/core/test/diagnosis-engine.test.ts` — 56 failures (missing LLM mocks).
- `packages/core/test/recommendation-engine.test.ts` — 0 tests found.

These are pre-existing and unrelated to Phase 11.9B.

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `packages/core/src/opportunity-queue-service.ts` | NEW | 527 |
| `apps/api/src/routes/opportunities.ts` | NEW | 251 |
| `apps/api/test/opportunities.test.ts` | NEW | 710 |
| `apps/web/src/app/opportunities/page.tsx` | NEW | 275 |
| `apps/web/src/app/opportunities/[id]/page.tsx` | NEW | 594 |
| `apps/web/src/components/opportunity-card.tsx` | NEW | 211 |
| `packages/core/src/index.ts` | MODIFIED | +4 lines |
| `packages/db/src/repositories/recommendation-repository.ts` | MODIFIED | +80 lines |
| `apps/api/src/services/container.ts` | MODIFIED | +2 lines |
| `apps/api/src/routes/index.ts` | MODIFIED | +3 lines |

## What the User Gains

Users can now:
1. Browse a ranked, filterable opportunity queue in the web UI at `/opportunities`.
2. View opportunity detail pages with server-computed score breakdown, evidence, and action preview.
3. Filter by priority (CRITICAL/HIGH/MEDIUM/LOW), status, entity type, and action type.
4. Approve or reject opportunities — approval routes through the existing Phase 10 approval flow.
5. See conflict flags when two recommendations target the same entity.
6. See stale/expired state for recommendations that are no longer valid.

## Constraints Honored

- NO new autonomous execution paths.
- NO automatic approval.
- NO new Meta write tools.
- NO budget changes or budget tools.
- NO new scheduler.
- NO reinforcement learning.
- ZERO LLM calls in the module.
- ZERO Meta writes on any path.
- AccountId always from server env, never from client.

## Not Implemented (per spec)

- No mutation endpoints — read-only by design.
- No auto-resolution of conflicts — flag-only.
- No persistence of scores — recomputed deterministically via Phase 11.9A.

## Known Limitations

- PostgreSQL unavailable locally — `pnpm db:migrate` remains PENDING (no new migration required for this phase).
- Opportunity queue requires recommendations to exist in the database (Phase 11.5+ must have run).

VERDICT: PHASE 11.9B PASS
