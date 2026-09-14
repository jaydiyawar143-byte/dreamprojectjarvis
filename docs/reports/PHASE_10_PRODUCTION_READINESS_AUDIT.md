# PHASE 10 — PRODUCTION READINESS AUDIT

**Scope:** Full inspection-only audit of JARVIS production readiness. No production code was modified, no `.env` changes, no real Meta writes performed during this audit.

**Date:** 2026-08-21
**Baseline:** Post-Phase-9 tree (paramsHash work present, migration `20260821000000_approval_params_hash` applied).

---

## 1. EXECUTIVE SUMMARY

### Verdict: **NOT PRODUCTION-READY** — blocked by 6 CRITICAL findings, all concentrated in one subsystem: *the write path* (approval → idempotency → execution → reconciliation → audit).

The system is architecturally sound and defensively designed (fail-closed defaults, paramsHash binding, role gating, server-side budget guardrails, Zod validation everywhere). However, the human-in-the-loop approval pipeline that gates every real-money Meta Ads write is **not operationally wired**, and the mechanisms meant to prevent duplicate spends are **in-memory only and not crash-safe**.

**Current live risk is paradoxically LOW** (unwanted spend cannot happen because approvals can never be approved), but **the feature is dead**: every write tool returns an unusable `approval_pending` with an empty ID (`""`). The moment someone "fixes" the wiring naively, they inherit six latent duplicate-spend and lost-journal bugs. Fix order therefore matters: **execution integrity first, then enable approvals end-to-end**.

### Severity counts

| Severity | Count | Summary |
|----------|-------|---------|
| CRITICAL | 6 | Approval pipeline unwired; in-memory idempotency lost on restart; timeouts don't abort side effects; ambiguous-failure duplicates; approvals reusable/unconsumed; concurrency races |
| HIGH | 7 | Audit-after-side-effect fragility; dual divergent approval systems; output sanitizer dead code; no rate limiting; no graceful shutdown; embedding N+1 burn; raw error leakage |
| MEDIUM | 14 | Pagination blindness, rate-limit blindness, status defaulting to ACTIVE, scoring inconsistencies, non-transactional vector writes, approval lifecycle gaps, unbounded queries, silent repo failures, AI-controllable launch status, rename-defeats-idempotency, unauthenticated socket, open registration, log hygiene |
| LOW | 6 | Dead retry config, mislabeled args, currency heuristic, LIMIT interpolation, role-blind tool descriptions, error detail exposure |
| INFO | — | Strengths catalogued separately |

---

## 2. ARCHITECTURE ASSESSMENT

### 2.1 What exists (and works)

```
apps/api (Express + Socket.io)
  └─ container.ts wires: PrismaClient → repos → security services → tools → orchestrator
packages/
  core        types, JarvisError taxonomy, paramsHash canonicalization
  db          Prisma schema + repositories (user, refresh token, conversation, message,
              memory, knowledge, approval, audit log)
  security    PasswordHasher, TokenService (JWT access 15m + rotating refresh),
              AuthService (rotation + reuse detection), PermissionService (role matrix),
              ApprovalService, ToolApprovalService (pre-execution gate), AuditLogger
  meta-graph  MetaGraphClient (fetch + AbortController timeouts), MetaAdsProvider
              (typed ops + post-write verification), response validators, error classifier
  tools       ToolExecutor, ToolRegistry, BaseTool, output-sanitizer (UNUSED),
              meta-ads read tools, meta-ads WRITE tools (campaign/adset/ad/budget/status),
              budget guardrails, csv/pdf/web/system utilities
  agents      Orchestrator (plan → approve → execute loop), ConversationalAssistant,
              ToolPlanner/validator, memory integration
  memory      MemoryEngine, MemoryExtractionService (LLM extraction + secret pre-filter)
  ai-openai   OpenAI adapter (retry w/ backoff+jitter, error sanitization), embeddings
```

### 2.2 Architectural strengths (INFO)

| # | Strength | Evidence |
|---|----------|----------|
| S1 | **Canonical paramsHash** — sorted-key serialization, rejects bigint/function/symbol, fail-closed when hash absent on write-tool approvals. Legacy approvals without hash can never authorize writes. | `packages/core/src/utils/params-hash.ts`; enforced at `tool-approval.ts`, `executor.ts` |
| S2 | **Fail-closed posture everywhere** — missing approval/expiry/hash mismatch/role gap all block execution rather than allow. | `executor.ts`, `tool-approval.ts`, `permissions.ts` |
| S3 | **Password hashing done right** — scrypt N=16384, per-user salt, `timingSafeEqual`. | `packages/security/src/password.ts` |
| S4 | **Refresh-token rotation with reuse detection** — stolen/replayed refresh token revokes ALL sessions for the user. Access tokens 15 min. Tokens stored SHA-256-hashed. | `auth-service.ts`, `tokens.ts` |
| S5 | **Conversation isolation enforced at repository level** — every conversation/message path goes through `findByIdAndUserId` / userId-scoped queries. | `conversation-repository.ts`, `routes/conversations.ts` |
| S6 | **Role permission matrix** — viewer cannot execute any tool; owner has wildcard; membership checks precede execution. | `permissions.ts` |
| S7 | **Server-side budget guardrails independent of AI proposals** — maxDailyBudget 10000, increase ≤25% / ≤2500 absolute, decrease ≤50% / ≤5000; enforced pre-approval. | `meta-ads-budget-guardrails.ts` |
| S8 | **Zod validation at every trust boundary** — env config, Meta API responses (`response-validator.ts`), auth inputs, tool inputs (`meta-ads-validators.ts`: accountId/entityId patterns, date ranges, result caps). | throughout |
| S9 | **Meta error classification + secret redaction** — EAA tokens redacted from error messages; typed error taxonomy; post-write verification GETs confirm status/budget landed. | `meta-graph/error-handler.ts`, `provider.ts` |
| S10 | **OpenAI adapter hardening** — exponential backoff + jitter, abort-aware, API keys redacted from surfaced messages. | `ai-openai/error-handler.ts` |
| S11 | **Prompt-injection & CSV-injection scrubbing** — instruction-pattern redaction for web snippets; formula escaping for CSV export. | `web-research.ts`, `csv-analyzer.ts` |
| S12 | **Memory secret pre-filter** — deterministic regex blocklist before content reaches LLM extraction; second enforcement layer at repository store time. | `memory-extraction-service.ts`, `memory-repository.ts` |
| S13 | **Trace IDs end-to-end** — HTTP request → chat route → orchestrator → executor → audit rows carry correlation IDs. | `routes/chat.ts`, `orchestrator.ts`, `executor.ts` |
| S14 | **Status-transition discipline** — writes restricted to toggle pairs (PAUSED⇄ACTIVE), validated against current remote state before issuing. | `meta-ads-write-tools.ts` |

### 2.3 Architectural weaknesses (themes)

1. **Two parallel, divergent approval systems** (`ToolApprovalService.checkPreExecution` vs `ToolExecutor` internal logic) with different TTLs (10 min vs 1 h) and different status vocabularies (`approval_required` vs `approval_pending`) — drift is already visible.
2. **Ephemeral state for money-touching operations** — idempotency journal lives in a module-level `Map`.
3. **Timeout ≠ cancellation** — the timeout mechanism reports failure while the underlying operation continues.
4. **Audit is best-effort, positioned after side effects, and failure-propagating** — the worst possible placement.
5. **Observability split across `console.log` and DB rows** with no structured logger.
6. **No operational envelope** — no rate limiting, no graceful shutdown, no server timeouts, unauthenticated socket channel.

---

## 3. CRITICAL FINDINGS

> Format per finding: file · module · current behavior · failure scenario · impact · fix · migration? · affects real Meta writes? · test needed?

---

### C1 — Approval system is not wired to persistence or any API: human-in-the-loop is non-functional

- **File(s):** `apps/api/src/services/container.ts:50–56,117`; absence confirmed across `apps/api/src/**` (grep `approve|approval` → only container.ts hits)
- **Module:** DI container / ApprovalService wiring
- **Current behavior:** A local `noopApprovalRepo` object is passed to `new ApprovalService(noopApprovalRepo)`:
  - `create()` returns a fake record with `id: ""`
  - `findById()` always returns `null`
  - `updateStatus()` always returns `null`
  - `findExistingForTool()` always returns `null`
  Additionally, **no REST endpoint exists** to approve or reject anything (routes are limited to auth/chat/conversations/health). The `Approval` Prisma model and repository exist but are never instantiated into the container.
- **Failure scenario:** User asks agent to create a campaign → executor requests approval → receives `approval_pending` with empty `approvalId` → there is no way for any human to ever approve → every write attempt loops forever. The entire Phase 8/9 approval feature is unreachable in the production process.
- **Impact:** Business-blocking (feature-dead), not money-loss. Fail-closed, so safe — but the product's core differentiator does not work in production, and any naive "fix" that swaps in the real repo without fixing C2/C5/C6 immediately exposes duplicate-spend bugs.
- **Recommended fix:** Wire `PrismaApprovalRepository(prisma)` into `ApprovalService`; add authenticated `POST /api/approvals/:id/approve`, `POST /api/approvals/:id/reject`, `GET /api/approvals/pending` routes scoped to `req.auth.userId`; verify hash on approve; surface pending approvals in UI/socket events.
- **Schema migration needed?** No (tables exist; may want index on `(userId, status)`).
- **Affects real Meta writes?** Yes — it is the gate itself.
- **Test needed?** Yes — end-to-end approval round-trip test (request → approve → execute once → second attempt rejected).

---

### C2 — Idempotency/journal state is in-memory only: lost on restart, broken multi-worker, racy

- **File:** `packages/tools/src/tools/meta-ads-write-tools.ts:29` (`executionStore` module-level `Map`), used by `checkIdempotency` / `setExecutionState`
- **Module:** write-tool idempotency layer
- **Current behavior:** Execution state (`EXECUTING` / `COMPLETED` / `FAILED`) lives in a plain `Map<string, ExecutionState>` keyed by `toolId:accountId:{proposal|entity}:{...}`. Check-then-set (`checkIdempotency()` then later `setExecutionState(EXECUTING)`) is not atomic. No TTL eviction → unbounded growth.
- **Failure scenarios:**
  1. Process crashes/restarts mid-execution → key vanishes → identical retry creates a **duplicate campaign**.
  2. Horizontal scale-out (PM2 cluster, k8s replicas, even two dev terminals running the API) → each worker has its own Map → same intent executes twice concurrently.
  3. Two overlapping requests pass `checkIdempotency()` before either sets `EXECUTING` → both fire Meta calls.
  4. Long-running process leaks entries forever.
- **Impact:** Direct duplicate-spend risk on real ad accounts; violates the system's own idempotency guarantee; unbounded memory growth.
- **Recommended fix:** Replace with DB-backed execution journal table (e.g., `ToolExecution {id, toolId, userId, accountId, idempotencyKey UNIQUE, paramsHash, status, metaObjectId, startedAt, finishedAt}`) with a **UNIQUE constraint on idempotencyKey** so the database arbitrates races; upsert-with-status-guard instead of check-then-set; TTL cleanup job. Store returned Meta object ID in the journal for reconciliation (see C4).
- **Schema migration needed?** Yes.
- **Affects real Meta writes?** Yes.
- **Test needed?** Yes — concurrent duplicate execution, restart-persistence simulation, unique-constraint violation handling.

---

### C3 — Timeout does not cancel the underlying operation (no AbortSignal through the tool stack)

- **File:** `packages/tools/src/executor.ts` (`executeWithTimeout`); contrast `meta-graph/client.ts` (supports `AbortSignal.timeout`) and `ai-openai` (accepts signal)
- **Module:** ToolExecutor timeout wrapper
- **Current behavior:** `Promise.race([op, timer])` — on timeout the wrapper promise rejects and the caller is told the execution timed out, but **the Meta fetch keeps running to completion**. No `AbortSignal` is created or threaded from executor → tool → provider → client.
- **Failure scenario:** Meta responds slowly (e.g., 45 s under load); executor times out at 30 s and marks the run failed; the still-running fetch succeeds at t=45 s and **the campaign gets created anyway**; user retries → second campaign. Combined with C2 this is a reliable duplication recipe.
- **Impact:** Silent orphaned side effects contradicting reported outcomes; duplicates; misleading audit trail ("timed_out" rows whose effects exist).
- **Recommended fix:** Create `AbortController` in `ToolExecutor.execute()`, pass `signal` through `ToolContext` → tool implementations → provider methods → `MetaGraphClient` (which already honors signals); on timeout call `controller.abort()`; treat `AbortError` distinctly from other failures.
- **Schema migration needed?** No.
- **Affects real Meta writes?** Yes.
- **Test needed?** Yes — fake slow provider asserting abort fires and no post-timeout state mutation occurs.

---

### C4 — Ambiguous failures (timeout-after-transmission) are recorded as FAILED with no reconciliation → guaranteed duplicates on retry

- **File(s):** `packages/meta-graph/src/client.ts` (AbortError mapped to synthetic 408-style failure), `provider.ts` (`createCampaign` etc.), `meta-ads-write-tools.ts` (catch-all sets `FAILED`)
- **Module:** Meta client/tool error handling
- **Current behavior:** Any exception — including "we sent the POST but never saw the response" — flows into the tool catch block, which sets execution state `FAILED`. There is no follow-up lookup ("did my campaign actually get created?" by name/idempotency token) before allowing re-execution. `error-handler.ts` classifies errors with a `retryable` flag, but **no consumer uses it**.
- **Failure scenario:** Network blip after Meta accepted the create → tool reports failure → user (or auto-retry) resubmits → two identical campaigns spending money.
- **Impact:** Highest-severity money-risk scenario in the codebase; erodes trust in every failure message.
- **Recommended fix:** On ambiguous outcomes (timeout, connection reset, 5xx-after-send) enter a new `UNKNOWN` journal state and run reconciliation: search account campaigns for matching name/idempotency marker before permitting re-execution; embed a client-generated idempotency marker in the campaign name or a Meta field where available; only transition UNKNOWN→FAILED after reconciliation proves absence.
- **Schema migration needed?** Yes (journal status enum incl. `UNKNOWN`, plus `reconciledMetaId` column — folds into C2's table).
- **Affects real Meta writes?** Yes.
- **Test needed?** Yes — simulated accept-after-timeout followed by retry must reuse, not duplicate.

---

### C5 — Approvals are never consumed: one approval authorizes unlimited executions within its TTL (and TTLs disagree)

- **File(s):** `packages/tools/src/executor.ts` (post-execution logic leaves approval `APPROVED`; hardcoded `3600000` ms ≈ line 145), `packages/security/src/tool-approval.ts` (`DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000`)
- **Module:** ToolExecutor / approval lifecycle
- **Current behavior:** After a successful execution the approval row stays `APPROVED`. Because `findExistingForTool` matches any recent APPROVED entry for `(userId, toolId, paramsHash)`, the **same approved parameters can be executed repeatedly for up to 1 hour** with zero further human contact. Meanwhile the pre-execution service uses a 10-minute TTL — two clocks for the same concept.
- **Failure scenario:** User approves "create campaign X" → agent executes → later in the same session the model emits the identical tool call again (models do this) → executes again instantly → duplicate campaigns within the approval window, each individually "authorized."
- **Impact:** Defeats the point of human-in-the-loop; duplicates; inconsistent security semantics between the two approval systems.
- **Recommended fix:** Single source of truth for approval semantics. Atomically consume on use: `updateMany({ where: { id, status: APPROVED }, data: { status: CONSUMED, consumedAt } })` and require `count === 1` to proceed (this simultaneously fixes part of C6). Optionally allow `maxExecutions` config (default 1). Unify TTL in one constant.
- **Schema migration needed?** Yes (status enum value `CONSUMED` + `consumedAt`; fold into C2 migration batch).
- **Affects real Meta writes?** Yes.
- **Test needed?** Yes — approve once, execute twice → second must be rejected; expired-approved usage rejected.

---

### C6 — Concurrency races throughout approval + execution: TOCTOU on both grant and check

- **File(s):** `packages/security/src/approval.ts` (`approve()`/`reject()` do `findById` then `updateStatus`), `packages/db/src/repositories/approval-repository.ts` (`updateStatus` is an unconditional update), `executor.ts` (`findExistingForTool` check then separate execute), `tools/meta-ads-write-tools.ts` (check-then-set journal)
- **Module:** approval + execution concurrency
- **Current behavior:** No conditional updates, no row locks, no single-flight. Two simultaneous executors both observe `APPROVED` and both proceed; two approvers (or double-clicked UI) can both transition PENDING→APPROVED; approve does not verify expiry or hash at transition time atomically.
- **Failure scenario:** Double-submit / parallel tabs / retried HTTP requests produce concurrent duplicate executions of a paid action; audit shows one approval but two spends.
- **Impact:** Duplicate spend; audit integrity violation; unreproducible incident forensics.
- **Recommended fix:** Convert all state transitions to atomic conditional updates (`updateMany ... where status=PENDING` and assert count===1); add single-flight lock per `(userId, toolId, paramsHash)` (DB advisory lock or unique in-flight row); approve() must check expiry + paramsHash inside the same transaction.
- **Schema migration needed?** Partially (unique partial index on in-flight executions; folds into C2).
- **Affects real Meta writes?** Yes.
- **Test needed?** Yes — parallel execute storm test; parallel approve test asserting exactly-once transitions.

---

## 4. HIGH FINDINGS

### H1 — Audit written AFTER side effect; audit failure masks success; crash loses the record
- **File:** `packages/tools/src/executor.ts` (audit `await` following tool execution, no try/catch); `packages/security/src/audit.ts` (thin wrapper, throws on repo failure, `console.log`s)
- **Behavior:** If the audit insert fails (DB hiccup) after Meta already executed, `execute()` throws — the caller believes the write failed and retries → duplicate. Process death between Meta response and audit insert silently loses the only server-side record.
- **Fix:** Write an **intent/outbox row before execution** (same transaction family as C2 journal), mark outcome afterward; audit insert failures must be logged-and-alerted, never propagated as tool failure; reconcile outbox rows lacking outcomes on startup.
- **Migration?** With C2. **Meta writes?** Indirectly (retry storms). **Test?** Yes — audit-down simulation asserting success is preserved.

### H2 — Dual approval systems with divergent rules; orchestrator's copy is inert in production
- **File(s):** `container.ts:137` (Orchestrator built without `toolRegistry`/`toolApprovalService`), `tool-approval.ts` vs `executor.ts`
- **Behavior:** `Orchestrator.checkPreExecution` branch is dead code in the wired container; executor enforces its own variant with different TTL/vocabulary. Future contributors will "fix" one and not the other.
- **Fix:** Consolidate into one approval authority injected everywhere; delete or delegate the duplicate.
- **Migration?** No. **Meta writes?** Gate correctness. **Test?** Covered by C1/C5 tests.

### H3 — Output sanitizer exists but is never called in production paths
- **File(s):** `packages/tools/src/output-sanitizer.ts`; grep confirms usage **only in tests**; `conversational-assistant.ts:~123` feeds `JSON.stringify(tr.result)` raw into model context
- **Behavior:** Tool results (including internal IDs, error bodies, possibly tokens embedded in upstream payloads) go straight to the LLM and to API responses. Secret-pattern redaction, size caps, and truncation are implemented but dead.
- **Fix:** Wrap every tool result at the executor boundary (`sanitizeToolResult`) before returning to orchestrator/model/API.
- **Migration?** No. **Meta writes?** No. **Test?** Extend existing sanitizer tests with an integration assertion.

### H4 — No rate limiting anywhere; 10 MB JSON bodies; login brute-forceable
- **File(s):** `apps/api/src/index.ts` (no limiter middleware, `express.json({ limit: "10mb" })`), `routes/auth.ts` (no limiter on `/login`, `/register`, `/refresh`)
- **Behavior:** Unlimited request rates on every endpoint including credential guessing and expensive LLM-backed `/chat`.
- **Fix:** Global limiter + strict per-route limits on auth + cost-aware limits on chat; reduce body cap to what chat actually needs (e.g., 256 KB).
- **Migration?** No. **Meta writes?** No. **Test?** Rate-limit unit/integration tests.

### H5 — No graceful shutdown: deploys kill in-flight Meta writes mid-flight
- **File:** `apps/api/src/index.ts` (no SIGTERM/SIGINT handler, no `server.close`, no keep-alive timeouts)
- **Behavior:** SIGTERM during deploy terminates connections immediately; any in-flight Meta POST dies at an arbitrary byte — the canonical generator of C4 ambiguity.
- **Fix:** Signal handler → stop accepting new requests → drain with deadline → close socket.io → flush audit/outbox → disconnect Prisma. Add `server.headersTimeout`/`requestTimeout`.
- **Migration?** No. **Meta writes?** Yes (ambiguity reduction). **Test?** Manual/CI smoke: send SIGTERM under load, assert clean drain.

### H6 — Memory recall recomputes the query embedding once per candidate memory (N× API calls)
- **File:** `packages/agents/src/orchestrator.ts` (`recallMemories` loop over ≤50 memories calling `embed(texts=[query])` inside the loop)
- **Behavior:** Up to 50 identical embedding calls per user message → latency, cost, and 429 exposure on OpenAI; also dot-product on raw (non-normalized) vectors labeled as cosine similarity, inconsistent with pgvector's `<=>` used elsewhere.
- **Fix:** Embed once before the loop; normalize embeddings at write time (or switch scoring to pgvector cosine distance exclusively).
- **Migration?** Optional backfill for normalization. **Meta writes?** No. **Test?** Assert single embed call per recall.

### H7 — Raw internal error messages leak to API clients
- **File(s):** `routes/auth.ts` (catch blocks return `err.message` for arbitrary errors, including Prisma internals), `orchestrator.ts` `buildErrorResponse` (includes `details`)
- **Behavior:** Schema/table/driver details and provider payloads exposed to unauthenticated callers on register/login; chat errors may carry tool/provider internals.
- **Fix:** Map known error codes to canned client messages; log full detail server-side with traceId; never echo unknown `message`.
- **Migration?** No. **Meta writes?** No. **Test?** Error-mapping unit tests.

---

## 5. MEDIUM FINDINGS

| # | Finding | File / Module | Failure scenario | Impact | Fix | Migration? | Meta writes? | Test? |
|---|---------|---------------|------------------|--------|-----|------------|--------------|-------|
| M1 | Entity lookup scans page-1-only lists (default limit 25) | `meta-ads-write-tools.ts` pause/resume/budget paths | Entity beyond first page → false "not found"; pause fails on valid entity | Ops-blocking during incidents (can't pause what you can't find) | Use provider `getCampaignById`-style direct GET (already exists for verification) or paginate | No | Yes | Yes |
| M2 | 1–2 `checkAccountAccess` GETs before every write + list+verify reads → 4–6 Meta calls/op, uncached | write tools + `provider.ts` | BUC throttling under normal usage bursts | 429s cascade into C4 ambiguity | Cache authorization per (userId,accountId,ttl); skip redundant pre-reads where verification suffices | No | Yes | Yes |
| M3 | Unknown statuses parsed/default to `"ACTIVE"` | `meta-graph/response-validator.ts` (`parseCampaign` et al.) | Deleted/archived entity read as ACTIVE → wrong transition decisions | Wrong-state actions; misleading UI | Default to `"UNKNOWN"` and refuse transitions from it | No | Yes | Yes |
| M4 | Scoring labeled cosine but is dot product on unnormalized vectors (JS side), while DB uses `<=>` cosine distance | `orchestrator.ts`, `memory-extraction-service.ts` vs `memory-repository.recall` | Thresholds behave differently per codepath; relevance regressions | Quality/correctness | Normalize at write; single scoring utility | Backfill optional | No | Yes |
| M5 | `storeWithEmbedding` writes row then separate raw UPDATE for vector — non-transactional, per-row loop | `memory-repository.ts:122–158` | Crash/failure between → memories permanently vector-less (silently skipped by recall) | Silent quality loss | `prisma.$transaction([...create, $executeRaw])` per item or batch | No | No | Yes |
| M6 | Approve/reject lack expiry check, userId scoping, atomic transition | `security/approval.ts` | Expired PENDING can be approved then used | Stale authorization | Conditional update + expiry + ownership checks inside tx (pairs with C6) | With C5 | Yes | Yes |
| M7 | Audit query unbounded (no pagination/limit) | `db/repositories/audit-repository.ts` | Large table → giant result sets, memory spikes | Availability | Enforce max limit + cursor pagination | No | No | Yes |
| M8 | `updateStatus` swallows ALL exceptions → returns null | `approval-repository.ts` | DB outage indistinguishable from "not found" → approve appears to succeed-nothing | Debugging nightmare; silent inconsistency | Let errors throw; classify at service layer | No | Gate-level | Yes |
| M9 | Repeated blocked attempts accumulate duplicate PENDING approvals (hash-mismatch variants) | `executor.ts` request path | Approval inbox spam; stale-hash approvals linger | UX + hygiene | Upsert-one-pending per (user,tool,paramsHash) + cleanup job | Index maybe | No | Yes |
| M10 | Campaign creation accepts AI-proposed `status: "ACTIVE"` (`VALID_STATUSES` includes it; input fallback PAUSED) | `meta-ads-write-tools.ts:~1055,1302` | One approval launches a live-spending campaign immediately | Spend risk by design choice | Force `PAUSED` on create; require explicit separate activation approval | No | Yes | Yes |
| M11 | Proposal-based idempotency key includes proposal name → renaming defeats dedup | write tools key builder | Rename + retry = duplicate campaign even in-memory | Duplication edge | Key on stable business identity (advertiser+objective+normalized name hash) or explicit idempotency token | With C2 | Yes | Yes |
| M12 | Socket.IO accepts connections with no authentication handshake | `index.ts` | Any origin subscribes to events (future leak vector) | Info disclosure | Auth middleware on handshake (reuse JWT) | No | No | Yes |
| M13 | Registration open to world, everyone becomes MEMBER with full tool access | `auth-service.register`, `routes/auth.ts` | Multi-tenant abuse if deployed publicly | Abuse/cost | Invite codes/admin bootstrap flag/env-gated registration | No | Indirectly | Yes |
| M14 | Log hygiene: morgan combined (IPs), `console.log` audit lines, access_token passed in URL query strings | `index.ts`, `audit.ts`, `client.ts` | Tokens/IPs land in proxies/logs; URL-embedded tokens leak via any URL logging | Compliance/secret hygiene | Structured logger w/ redaction; move token to header where API allows; document exceptions | No | Indirect | No |

---

## 6. LOW FINDINGS

| # | Finding | File | Note / Fix |
|---|---------|------|------------|
| L1 | `maxRetries` config exists but no retry loop consumes it in meta-graph | `meta-graph/config.ts`, `provider.ts` | Either implement idempotent-safe retries (reads only, or with reconciliation) or remove the knob |
| L2 | `setExecutionState(..., context.userId)` passed into `executionId` parameter slot | write tools | Mislabel; cosmetic but confuses journal consumers — fix signature |
| L3 | Currency heuristic takes first ad account's currency for budget validation | write tools budget paths | Multi-account users could validate against wrong currency; resolve currency per target account |
| L4 | `LIMIT ${limit}` interpolated in `$queryRawUnsafe` | `memory-repository.ts:255` | Value is internally typed number (not user-controlled) — still prefer parameterized/template form for defense-in-depth |
| L5 | `getToolDescriptions(userId?)` ignores the user argument | `registry.ts` | Role-scoped tool catalogs would shrink model attack surface for viewers |
| L6 | `buildErrorResponse` forwards `details` field | `orchestrator.ts` | Strip or whitelist details for client responses (pairs with H7) |

---

## 7. RELIABILITY GAPS

1. **No recovery story after crash mid-write** (C2/C4/H1): no journal, no startup reconciliation, no outbox.
2. **Timeout semantics lie** (C3): reported failure while effect proceeds.
3. **No graceful shutdown** (H5): every deploy manufactures C4 ambiguities.
4. **No circuit breaker / backoff toward Meta**: 429s and 5xx hammer straight through; `retryable` flags computed but ignored (L1).
5. **Fire-and-forget background work** (`extractMemoryAsync(...).catch(() => {})`): silent loss with no retry queue or metric.
6. **Non-TTY `prisma migrate dev` limitation**: CI/CD must use `migrate deploy` (operational note from Phase 9).

## 8. SECURITY GAPS

1. Human-in-the-loop absent at runtime (C1) — the flagship control.
2. Approval reuse (C5) + races (C6) undermine approval guarantees once wired.
3. No rate limiting / brute-force protection (H4); open registration (M13).
4. Raw error leakage (H7/L6).
5. Unauthenticated socket channel (M12).
6. Unsanitized tool output to model and clients (H3).
7. Token-in-URL pattern for Meta GETs (M14) — logs/proxies exposure.
8. Secrets handling otherwise strong: hashed refresh tokens, scrypt passwords, redacted Meta/OpenAI errors, memory secret filters (S3, S4, S9, S12).

## 9. CONCURRENCY GAPS

- Journal check-then-set (C2), approval TOCTOU (C6), non-atomic approve (C6/M6), unconsumed approvals (C5), no single-flight, no DB-level uniqueness on business intents, non-transactional memory+vector writes (M5). Every stateful decision in the write path is currently a race window under load.

## 10. DATABASE GAPS

- Missing tables/constraints: execution journal with UNIQUE idempotencyKey (C2); approval `CONSUMED` state + `consumedAt` (C5); possibly composite indexes for hot lookups (`Approval(userId,status)`, `AuditLog(traceId)`).
- Repository behaviors to correct: swallowed errors in `updateStatus` (M8), unbounded audit query (M7), non-transactional embedding writes (M5).
- Positives: existing migrations replay cleanly in shadow DB (verified Phase 9); pgvector 0.8.6 initialized correctly; drift-free.

## 11. META API GAPS

- Ambiguous-failure handling (C4) — biggest gap.
- No rate-limit header awareness (`X-App-Usage` / `X-Business-Use-Case-Usage`) nor adaptive throttling (M2).
- Redundant pre-write access checks inflate call volume (M2).
- Page-1-only entity resolution (M1).
- Status parsing defaults to ACTIVE (M3).
- Dead `maxRetries` configuration (L1).
- Positives: timeouts via AbortController, response Zod validation, post-write verification reads, error redaction, typed provider surface.

## 12. AI SAFETY GAPS

- Model output reaches tool params directly (standard, mitigated by server-side validation/guardrails/approvals — but those gates are the broken parts above).
- Unsanitized tool results into model context (H3) — prompt-injection surface from Meta/web payloads.
- Web snippet injection scrubbing exists (S11) but tool-result channel bypasses equivalent treatment.
- AI may propose immediate `ACTIVE` launch (M10) — recommend forcing staged activation.
- Planner duplicate/cycle detection exists and is tested (S-strength); orchestrator loop bounded (MAX_TOOL_EXECUTIONS=10, depth 5).

## 13. OBSERVABILITY GAPS

- Dual-channel logging (`console.log` + morgan + DB audit rows) with no structured logger, levels, or redaction policy (M14).
- traceIds exist end-to-end (good) but aren't printed consistently or correlated into logs.
- No metrics (latency histograms, Meta call counts, approval funnel conversion, duplicate-block counter).
- No alerting hooks for: audit write failure, journal UNKNOWN aging, repeated approval_pending loops, OpenAI 429 storms.

## 14. MISSING TESTS (failure-mode inventory vs existing suites)

Existing coverage is strong on happy paths and pure logic (~780 tests across 25 files: budget 72, campaign 70, write-path 51, meta-graph 44, extraction 34, planner 28…). Absent failure-mode classes:

1. Concurrent duplicate execution (two executors, same intent) — C2/C6
2. Restart persistence of execution journal — C2
3. Timeout-after-transmission reconciliation (Meta accepted, client timed out) — C3/C4
4. Approval consumption semantics (second execution rejected) — C5
5. Parallel approve/reject exactly-once — C6/M6
6. DB unavailable during audit insert → success preserved — H1
7. DB unavailable during approval check → fail-closed (not crash) — M8
8. Meta 429 → backoff behavior end-to-end — M2/L1
9. Expired-but-APPROVED usage attempts — C5/M6
10. Multi-worker consistency (simulated second process against shared DB) — C2
11. Graceful shutdown drain under in-flight write — H5
12. Rate-limited endpoints — H4
13. Sanitizer integration (model-context path actually sanitized) — H3
14. Recall performs O(1) embedding calls — H6

---

## 15. RECOMMENDED IMPLEMENTATION ORDER

Rationale: **make the write path trustworthy BEFORE making approvals reachable.**

| Order | Item (finding) | Why first | Complexity |
|-------|----------------|-----------|------------|
| 1 | Execution journal table + DB-enforced idempotency + UNKNOWN state (C2, C4 schema, H1 outbox) | Foundation everything else hangs off | **L** |
| 2 | Atomic state transitions + single-flight (C6, M6, M8) | Correctness of journal + approvals | **M** |
| 3 | Consume approvals on use; unify TTL/authority (C5, H2) | Closes reuse hole before wiring approvals live | **S–M** |
| 4 | AbortSignal propagation executor→tools→Meta client (C3) | Makes timeouts truthful | **M** |
| 5 | Reconciliation on ambiguous outcomes (C4 runtime logic) | Requires journal (#1) | **M** |
| 6 | Graceful shutdown + server timeouts (H5) | Cheap, removes ambiguity generator | **S** |
| 7 | Wire real approval repo + REST endpoints + forced-PAUSED creates (C1, M10) | Now safe to enable the loop | **M** |
| 8 | Sanitizer integration + error-message hygiene (H3, H7, L6) | Boundary hardening | **S** |
| 9 | Rate limiting + body caps + socket auth + registration gating (H4, M12, M13) | Perimeter | **S–M** |
| 10 | Meta call efficiency + rate-limit headers + real retry policy (M1, M2, L1) | Throughput/throttling | **M** |
| 11 | Embedding single-call + normalization + transactional vector writes (H6, M4, M5) | Cost/quality | **S** |
| 12 | Observability consolidation: structured logger, metrics, alerts (§13, M14, L2) | Operability | **M** |

(S = hours, M = 1–3 days, L = 3–5 days for a single senior engineer, excluding review.)

## 16. PHASE 10 IMPLEMENTATION PLAN (proposed)

**Stage A — Write-path integrity (orders 1–5).** New migration: `ToolExecution` journal (+ approval `CONSUMED`/`consumedAt`). Executor refactor: AbortController per execution, journal-first flow (PENDING_INTENT → EXECUTING → COMPLETED/FAILED/UNKNOWN), atomic approval consumption, reconciliation routine for UNKNOWN. Tests: items 1–5, 7–10 from §14.

**Stage B — Enable the human loop safely (orders 6–7).** Shutdown hooks; wire `PrismaApprovalRepository`; add approval routes + socket notifications; force `PAUSED` on campaign creation; e2e test: propose → approve → execute exactly once → verify at Meta (mock) → second attempt blocked.

**Stage C — Perimeter & hygiene (orders 8–9).** Sanitizer at executor boundary; error mapper; rate limiters; socket auth; registration env-gating.

**Stage D — Efficiency & observability (orders 10–12).** Authorization cache; usage-header throttle; embedding fixes; structured logging + metrics + alert rules; remove dead knobs (L1), fix mislabels (L2), currency resolution (L3).

**Exit criteria for "production-ready":** all CRITICAL closed with regression tests; HIGH closed or explicitly risk-accepted; §14 failure modes covered; shadow-drift check green; typecheck/test suites green; manual drill: kill -9 mid-write then restart → zero duplicates, journal reconciled.

---

## APPENDIX — Inspection Coverage

**Files inspected (source):**
`apps/api`: index.ts, services/container.ts, routes/{auth,chat,conversations}.ts, middleware/auth.ts, config/env.ts ·
`packages/tools`: executor.ts, registry.ts, base-tool.ts, output-sanitizer.ts, tools/{meta-ads-write-tools,meta-ads-tools,meta-ads-budget-guardrails,meta-ads-validators,meta-ads-provider,web-research,csv-analyzer}.ts ·
`packages/security`: tool-approval.ts, approval.ts, audit.ts, permissions.ts, auth-service.ts, tokens.ts, password.ts ·
`packages/db`: repositories/{approval,audit,conversation,memory}-repository.ts, index.ts ·
`packages/meta-graph`: client.ts, provider.ts, config.ts, error-handler.ts, response-validator.ts ·
`packages/agents`: orchestrator.ts, tool-planner.ts, agents/conversational-assistant.ts ·
`packages/memory`: memory-engine.ts, memory-extraction-service.ts ·
`packages/core`: types/common.ts, utils/params-hash.ts ·
`packages/ai-openai`: openai-adapter.ts, error-handler.ts

**Tests inventoried:** 25 test files, ~780 cases (listed in §14 context).

**Constraints honored:** no production code modified; no `.env` changes; no real Meta writes; no campaigns created. Audit ends here by design.
