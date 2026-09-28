# Memory and Knowledge

How JARVIS remembers facts about a user and answers from their documents. Verified against the code on 2026-09-14; the memory write, recall and backfill sections were updated for S7 on 2026-09-27, and the backfill safety rules on 2026-09-28.

---

## Two kinds of recall

| | Memory | Knowledge |
|---|---|---|
| What it holds | Short durable facts from conversations: a preference, a goal, a decision | Passages from documents the user uploaded |
| Created by | Automatic extraction after a chat turn | `POST /api/v1/knowledge/documents` |
| Table | `Memory` | `KnowledgeDocument`, `KnowledgeChunk` |
| Vector column | `Memory.embedding vector(1536)` | `KnowledgeChunk.embedding vector(1536)` |
| Read by | the orchestrator, before each reply | the orchestrator, before each reply |

Both are scoped to one user in every query.

## The runtime chain

Wired once, in `apps/api/src/services/container.ts`.

```
PrismaMemoryRepository       packages/db/src/repositories/memory-repository.ts
OpenAIEmbeddingProvider      packages/ai-openai
MemoryExtractionService      packages/memory/src/memory-extraction-service.ts
KnowledgeRetrievalService    packages/memory/src/retrieval
            │
            ▼
      Orchestrator            packages/agents/src/orchestrator.ts
```

### Before a reply — recall

1. The orchestrator embeds the user's message (`text-embedding-3-small` by default, 1536 dimensions).
2. It calls `memoryStore.recall(...)` with `limit` = `maxMemories` (default 5) and `minSimilarity` = `relevanceThreshold` (default 0.3). The threshold is a **similarity floor**, not an importance floor. The repository:
   - reads only rows of that user whose `embedding` column is set and which have not expired (`expiresAt` null or in the future);
   - keeps rows whose cosine similarity (`1 - (embedding <=> query)`) is at least `minSimilarity`;
   - orders by distance, then by `id`, so the same query always returns the same order;
   - selects explicit columns and never the vector itself — Prisma 5.22 cannot deserialize a `vector` column, and `SELECT m.*` made every vector recall throw before S7.
3. **Fallback.** If vector recall returns nothing, or throws, the orchestrator lists the user's 50 newest unexpired memories and scores each one's `metadata.embedding` against the query, keeping scores of at least `relevanceThreshold`. A throw is logged first as `memory_recall_failed` (below). This is what still serves legacy rows that have an embedding only in metadata.
4. It asks the knowledge retriever for matching document passages.
5. Both reach the model as context. Recalled memory is designed to be treated as **data, never as instructions** — TEST G in `apps/api/test/sprint-1.1d-memory-e2e.test.ts` checks that a malicious stored memory appears in the user message, alongside the `<user_memories>` block, and never in the system prompt. It passes since 2026-09-14.

The knowledge agent holds no search tool on purpose. Retrieval has already happened, and a model-chosen second search over the same index would be an ungated duplicate path.

### After a reply — extraction

`MemoryExtractionService.extract` runs when extraction is enabled:

1. **Pre-filter, without a model.** Messages matching secret patterns — API keys, bearer tokens, passwords, private keys, database URLs — are dropped. So is transient chit-chat: greetings, "ok", "thanks".
2. **Extract.** The model returns candidates typed `FACT`, `PREFERENCE`, `GOAL`, `PROJECT`, `DECISION` or `WORKFLOW`, each with an importance and a confidence.
3. **Validate** against a Zod schema, **embed** every candidate with `text-embedding-3-small` (passed explicitly on each request), then **deduplicate** against the user's existing memories: similarity of 0.95 or more, or text overlap above 0.85, skips the candidate; 0.7 or more merges it into the existing memory.
4. **Store** each new memory with an expiry — 90 days by default.

### The write path

There is one: `MemoryExtractionService` → `PrismaMemoryRepository.store` / `update`. Each write puts the same embedding in two places, in **one transaction**: `metadata.embedding` (read by the fallback) and the `embedding` vector column (read by vector recall). If the vector cannot be written, the row is not written either.

Before anything is written, the repository refuses an embedding that is not exactly 1536 finite numbers, and the service checks each vector the provider returns, one candidate at a time. Each new memory is stored in its own call, so one bad vector costs only its own candidate.

### Embedding failures — drop and report

A candidate whose embedding cannot be obtained, fails validation, or is refused by the database is **dropped**: no memory row, no half-written row. There is no queue, no retry and no re-embedding state. Each drop logs one JSON line:

```json
{"level":"warn","event":"memory_embedding_failed","stage":"embed | validate | persist",
 "reason":"provider_error | invalid_response | invalid_vector | storage_rejected",
 "problem":"dimensions | non_finite | empty_or_malformed","operation":"create | merge",
 "candidateIndex":0,"candidateCount":3,"embeddingModel":"text-embedding-3-small",
 "errorName":"...","errorCode":"...","action":"dropped"}
```

`problem` appears only for `invalid_vector`, `operation` only for `persist`, and `errorCode` only when it is a short upper-case code. The event never carries memory content, the user's or the assistant's text, embedding values, user ids, secrets, or a provider's error message or response body. A provider or response failure drops the whole batch; a bad vector or a refused write drops one candidate. A failed merge leaves the existing memory as it was. Only the repository's `MEMORY_EMBEDDING_FAILED` error is treated this way — any other storage error propagates as before.

### Recall failures

When vector recall throws, the orchestrator logs one line and falls back as described above:

```json
{"level":"warn","event":"memory_recall_failed","userId":"...","stage":"vector_recall",
 "fallback":"recent_memory_scan","errorName":"...","errorCode":"..."}
```

The error's message is never logged: it can carry query text or connection details.

### Documents — ingestion

```
upload → extract text (pdf-parse, mammoth) → DocumentChunkingService
       → DocumentEmbeddingService → PrismaKnowledgeRepository
```

All vector writes and searches use parameterised raw SQL, because Prisma cannot express the `vector` column type.

## Legacy memory rows and the vector backfill

Before S7 the write path stored the embedding in `metadata.embedding` only, and the vector column stayed empty. Those rows are served today by the fallback alone. Code that is older than S7 Step 5 — including any deployment image built before it — still writes such rows.

A one-off, operator-run tool fills the vector column for them:

```
packages/db/src/maintenance/memory-vector-backfill.ts    plan, cast, re-embed, rollback
apps/api/scripts/s7-memory-backfill/backfill-cli.ts      guards, batching, rollback log
apps/api/scripts/s7-memory-backfill/live-api.ts          reads the live API container's code
apps/api/scripts/s7-memory-backfill/run.ts               entry point
```

### Hard prerequisite: S7 code live, and no pre-S7 writer — before, during and after

**The S7 memory code must be deployed and running before the backfill, and no pre-S7 memory-writing code may run during or after it.** This is a requirement, not a recommendation. An earlier version of this plan (Step 8) called running the backfill under the old image harmless; that was wrong.

Pre-S7 code merges a memory by updating its content and `metadata.embedding` through Prisma, which cannot write the vector column. On a row the backfill has already given a vector, that leaves the vector describing the old content. The backfill then counts the row as already vectorized and never repairs it.

The command enforces the order:

- `--execute` inspects the running API container (`--live-api-container=<name>`) read-only: `docker inspect` for its running flag, then `grep -q -F` inside it for five identifiers of the S7 write and recall code in the compiled files the image runs. Unless the container is running and all five are present, nothing is read from or written to the database. The container's environment and file contents are never read.
- The plan counts rows whose vector disagrees with their own metadata embedding (`vectorMismatch`). S7 code always writes the two together, so a non-zero count means a pre-S7 writer has touched vectorized rows. Execution refuses while it is non-zero, and postflight requires it to be zero. Re-running the dry run later shows whether a pre-S7 writer has run since.

The check proves what the named container runs. It cannot see a writer it is not told about: any other process writing to the same database must be stopped or confirmed to run S7 code by the operator.

It sorts every row into exactly one category and acts on two of them:

| Category | Rule | Action |
|---|---|---|
| cast | active, no vector, `metadata.embedding` is 1536 finite numbers, not suspicious | the vector becomes a cast of `metadata.embedding`; nothing else on the row changes |
| re-embed (suspicious) | as above, but the stored embedding is ≥ 0.95 similar to an **earlier**, different memory of the same user, created more than 2 s before, and neither row was ever merged | the content is embedded again with `text-embedding-3-small`; the vector and `metadata.embedding` are replaced; the content is not changed |
| no embedding | no `metadata.embedding` | untouched — not deleted, not re-embedded |
| already vectorized, invalid, expired | — | untouched |

The suspicion rule exists because deduplication would have skipped or merged a candidate that similar at creation time, so such a stored embedding cannot be the row's own.

### Mandatory backup

Before `--execute`, take a plain-format `pg_dump` of the Memory table and pass it as `--backup-file=<path>`. The command refuses to execute unless the file:

- exists and is not empty;
- was written within the last 120 minutes;
- starts as a pg_dump and ends with pg_dump's `PostgreSQL database dump complete` line, which pg_dump writes only when it finishes;
- contains the Memory table's data block, properly terminated;
- holds exactly as many Memory rows as the table has at execution time.

Nothing in the file is printed. Take the dump inside the database container and copy it out, so no shell re-encodes it (a PowerShell `>` redirect writes UTF-16, which the check refuses):

```bash
docker exec <postgres container> pg_dump -U <user> -d <database> --data-only --table='public."Memory"' -f /tmp/memory-backup.sql
docker cp <postgres container>:/tmp/memory-backup.sql <backup path>
```

The backup holds every memory's content: keep it private, and delete it once it is no longer needed. The command never creates a backup itself.

### Guards

- Without `--execute` the tool is a dry run: it prints category counts and changes nothing.
- It refuses to run at all unless `DATABASE_URL` is set explicitly and `--confirm-target=<host>:<port>/<database>` names the same database.
- Arguments are strict. A malformed, empty, repeated or misplaced option is refused, and never read as a dry run: `--execute=yes`, a bare `--rollback`, a non-numeric count, or an execution option without `--execute`. Refusals name the option, never its value.
- Execution needs all of:
  - `--expect-cast` and `--expect-reembed` equal to a fresh plan's counts;
  - `--rollback-log` naming a file that does not yet exist;
  - `--backup-file` passing the checks above;
  - `--live-api-container` passing the S7 check;
  - no vector/metadata mismatch.
- Re-embedding needs `OPENAI_API_KEY`, with `OPENAI_EMBEDDING_MODEL` unset or `text-embedding-3-small`.
- Console output is counts and status only — no ids, content or vectors. An unexpected error is reported as `memory_backfill_failed` with its stage and error class name, never its message, and the exit code is non-zero.

### Safety

- **Casts** run in batches (default 50), each in one transaction. Every cast row is verified afterwards, and the whole batch rolls back on any mismatch.
- **Re-embeds** run one row per transaction. The provider call happens outside the transaction, so the row is re-read under its lock. If its content or metadata embedding changed in the meantime, nothing is written and the row is reported `conflicted`.
- **Repeat runs.** A second run finds nothing to do.
- **The rollback log.**
  - It is rewritten after every batch and every re-embed.
  - It records the md5 of every vector written. `--rollback=<log>` sets back to NULL only a vector whose md5 still matches. A vector that changed since — a later S7 merge, say — is reported as a conflict and left untouched.
  - Re-embedded rows also get their previous `metadata.embedding` restored. Content is never changed.
  - A successful rollback marks the log consumed, and a consumed log is refused.
  - The log holds row ids and the re-embedded rows' previous embeddings, so keep it private. It is written with mode `0600`, which Windows does not enforce.

**The re-embed set can drift.** A row is suspicious only while the earlier memory whose embedding it duplicates still holds that embedding. If S7 code merges into that earlier memory between the audit and the backfill, the suspicious row is classified `cast` instead, with its wrong embedding. The exact `--expect-cast` / `--expect-reembed` gate refuses that run. When the dry run's counts differ from the audited ones, stop and re-audit. Never change the expected counts to match the new plan.

### Tested

On a throwaway pgvector database, with synthetic rows in every category:

- `packages/db/test/memory-vector-backfill-s7-pg.integration.test.ts` covers the module, including:
  - exact-hash cast rollback, and a later vector left untouched;
  - re-embed conflicts when content or the metadata embedding changes during the provider call;
  - the mismatch count.
- `apps/api/test/memory-backfill-cli-s7.test.ts` covers every command guard.
- The command was run end to end there on 2026-09-28, with a real `pg_dump` backup:
  - refusals without a backup, with a pre-S7 live API, with an unfinished backup, and while a mismatch exists;
  - execute, and a no-op second run;
  - rollback with one conflict, then a refused second rollback;
  - recall through the real orchestrator afterwards.
- The live-API check was run read-only against the deployment's API container, whose image was built 2026-09-24. It found all five identifiers absent and refused. Against the S7-built packages, mounted read-only into a disposable container, it found all five present.

**Deployment status: not executed.** No deployment database has been changed by this tool.

## When OpenAI is not configured

A missing, blank or whitespace-only `OPENAI_API_KEY` counts as not set.

**Development:** the API starts. No memory store, embedding provider, extractor or knowledge retriever is created, and the orchestrator falls back to its no-op memory store. The agents receive `NotConfiguredAIProvider` (`packages/ai-openai/src/not-configured-provider.ts`) instead of `OpenAIAdapter`, so every chat message answers HTTP 503 with `AI_PROVIDER_NOT_CONFIGURED`, and startup logs `ai_provider_disabled`. Knowledge search and image understanding answer 503, as they already did.

**Production:** `checkProductionConfig` (`packages/config/src/index.ts`) refuses to start a `NODE_ENV=production` process without the key, or with the `.env.example` placeholder.

Until 2026-09-15 the API never reached the memory wiring without a key: `apps/api/src/services/container.ts` constructed the chat `OpenAIAdapter` unconditionally, its constructor threw, and the process exited (verified 2026-09-14 in the production container on Node 20 and Node 24). Fixed under ledger R-21.

## Not part of the runtime

| Code | Status |
|---|---|
| `packages/memory/src/memory-engine.ts` — `MemoryEngine` | A working, tested facade that production does not use. Whether it becomes the single entry point or is removed is an open decision (D-4 in `CODEBASE_AUDIT.md`). |
Two non-functional stubs, `MemoryManager` and `KnowledgeBase`, used to sit in this package: one discarded what it was asked to store, the other stored nothing it was asked to ingest. Nothing referenced them, and they were deleted on 2026-09-14 together with the deprecated `MemoryManager` interface in `@jarvis/core`. **Do not recreate them.** New memory behaviour goes into the runtime chain above, and nothing should be built on `MemoryEngine` until D-4 is decided.

## B-1 — resolved

Six of the thirteen tests in `apps/api/test/sprint-1.1d-memory-e2e.test.ts` used to fail on every run. They pass since 2026-09-14.

**Root cause — a test-harness race, not a production memory bug.** The suite's `MockAIProvider` served both the chat agent and `MemoryExtractionService`, and kept only its most recent request. `Orchestrator.process()` starts memory extraction after the reply without waiting for it. Whenever the memory store answered without I/O — always, with the in-process store the suite falls back to when Postgres is unreachable — extraction's request overwrote the chat request before the assertions read it. Diagnostic runs showed the chat request did carry the expected `<user_memories>` block, and delaying the store by 50 ms made all 13 tests pass with no other change. Postgres latency is what hid the race before.

**Fix.** `MemoryExtractionService` receives `extractionView(mockAI)`: the same scripted replies, without recording the request. Only the test file changed; no application code.

**Verified 2026-09-14**, with the in-process store (Postgres was not running):

```bash
pnpm --filter @jarvis/api exec vitest run test/sprint-1.1d-memory-e2e.test.ts -t "TEST (A|B|C|G|N):|TEST E & TEST F:"
```

`6 passed | 7 skipped` in each of three consecutive runs. The whole file passed 13 of 13, the four API memory suites 58 of 58, and `@jarvis/memory` 453 of 453. On 2026-09-14 the file also passed 13 of 13 in three runs against Postgres, on a dedicated test database (`memory backend: prisma-memory`). **Not verified since the fix:** the full repository suite.
