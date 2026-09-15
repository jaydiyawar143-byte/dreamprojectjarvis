# Memory and Knowledge

How JARVIS remembers facts about a user and answers from their documents. Verified against the code on 2026-09-14.

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
2. It calls `memoryStore.recall(...)`. The repository ranks the user's memories by cosine distance with pgvector's `<=>` operator, optionally filtered by memory type and a minimum importance.
3. It asks the knowledge retriever for matching document passages.
4. Both reach the model as context. Recalled memory is designed to be treated as **data, never as instructions** — TEST G in `apps/api/test/sprint-1.1d-memory-e2e.test.ts` checks that a malicious stored memory appears in the user message, alongside the `<user_memories>` block, and never in the system prompt. It passes since 2026-09-14.

The knowledge agent holds no search tool on purpose. Retrieval has already happened, and a model-chosen second search over the same index would be an ungated duplicate path.

### After a reply — extraction

`MemoryExtractionService.extract` runs when extraction is enabled:

1. **Pre-filter, without a model.** Messages matching secret patterns — API keys, bearer tokens, passwords, private keys, database URLs — are dropped. So is transient chit-chat: greetings, "ok", "thanks".
2. **Extract.** The model returns candidates typed `FACT`, `PREFERENCE`, `GOAL`, `PROJECT`, `DECISION` or `WORKFLOW`, each with an importance and a confidence.
3. **Validate** against a Zod schema, **deduplicate** against existing memories (similarity threshold 0.7), and **store** with an expiry — 90 days by default.

### Documents — ingestion

```
upload → extract text (pdf-parse, mammoth) → DocumentChunkingService
       → DocumentEmbeddingService → PrismaKnowledgeRepository
```

All vector writes and searches use parameterised raw SQL, because Prisma cannot express the `vector` column type.

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
