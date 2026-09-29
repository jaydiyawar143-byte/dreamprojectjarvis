# Memory and Knowledge

How JARVIS remembers facts about a user and answers from their documents. Verified against the code on 2026-09-14; the memory write, recall and backfill sections were updated for S7 on 2026-09-27, the backfill safety rules on 2026-09-28, and the learning gate (S7.2 L1–L1c), memory provenance (S7.2 L2) and validation with learning scope (S7.2 L3) were added on 2026-09-29.

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
2. **Learning gate, without a model.** Each remaining user message is classified; the turn either stops here or continues unchanged. See [The learning gate](#the-learning-gate--s72-l1l1c) below.
3. **Extract.** The model sees each message labelled with its speaker — `[M1] USER`, `[M2] ASSISTANT (context only, never a source)` — and returns candidates typed `FACT`, `PREFERENCE`, `GOAL`, `PROJECT`, `DECISION` or `WORKFLOW`, each with an importance, a confidence, a `source` and an `evidence` quote.
4. **Validate** against a Zod schema, then **ground** each candidate in a USER message of the turn, or drop it (see [Provenance](#provenance--s72-l2) below). Then keep only a claim the user's own words establish as **durable memory** — a preference, a personal fact or a working convention, never a goal, task, project state, decision or temporary instruction (see [Validation](#validation-and-learning-scope--s72-l3)). **Embed** every remaining candidate with `text-embedding-3-small` (passed explicitly on each request), then **deduplicate** against the user's existing memories: similarity of 0.95 or more, or text overlap above 0.85, skips the candidate; 0.7 or more merges it into the existing memory.
5. **Store** each new memory with an expiry — 90 days by default.

### The learning gate — S7.2 L1–L1c

The gate decides whether a turn may reach the extraction model at all. It runs inside `MemoryExtractionService.extract`, after the pre-filter and before the model call. It uses one pure function, `decideLearningCandidate` in `packages/core/src/learning-candidate.ts`: no model, no network, no database, no clock, no environment.

**What it classifies.** Each user message that survived the pre-filter, verbatim, as `statedBy: "USER"`. It never classifies JARVIS's reply, a model candidate, a paraphrase or a recalled memory.

**Verdicts.** Every statement gets exactly one rule. The rules are checked in the order below, and the first match wins.

| Order | Rule | Decision | Layer |
|---|---|---|---|
| 1 | `EMPTY_STATEMENT` | `NOT_A_CANDIDATE` | L1 |
| 2 | `CONTAINS_SECRET` | `REJECT` | L1 |
| 3 | `GRANTS_AUTHORIZATION` — "you can send without asking me" | `REJECT` | L1 |
| 4 | `ORIGIN_UNKNOWN` | `REJECT` | L1 |
| 5 | `ASSISTANT_ONLY_CLAIM` | `REJECT` | L1 |
| 6 | `TEMPORARY_INSTRUCTION` — "only for this campaign…" | `REJECT` | L1 |
| 7 | `ACKNOWLEDGEMENT_ONLY` — "thanks, sounds good" | `NOT_A_CANDIDATE` | L1 |
| 8 | `QUESTION_ONLY` — "what's our CPA?" | `NOT_A_CANDIDATE` | L1 |
| 9 | `USER_MEMORY_VETO` — "don't save this", "off the record", Hinglish equivalents | `REJECT` | L1c |
| 10 | `PERMISSION_LANGUAGE` — "I prefer that you post without asking me" | `UNDECIDED` | L1b |
| 11–14 | `AMBIGUOUS_PREFERENCE`, `HYPOTHETICAL_STATEMENT`, `ONE_OFF_CONTEXT`, `GENERAL_STATEMENT` | `UNDECIDED` | L1b |
| 15–17 | `STABLE_PREFERENCE`, `STABLE_WORKING_CONVENTION`, `STABLE_PERSONAL_FACT` | `ACCEPT` | L1b |
| 18 | `NO_REJECTION_RULE_MATCHED` | `UNDECIDED` | L1b |

- **L1, the rejection boundary.** Rules 1–8 decide what can never be learned: secrets, grants of authority, temporary instructions, and statements JARVIS made itself. They also decide what is not a statement at all: acknowledgements and questions. At runtime the statement is always the user's, so rules 4 and 5 cannot fire there. They guard the contract for later callers.
- **L1b, the acceptance boundary.** `ACCEPT` covers only a clearly stable preference, working convention or personal fact. Anything uncertain is `UNDECIDED`, never a guess.
- **L1c, the user veto.** An explicit request not to remember rejects the statement, even beside an otherwise stable fact.

**Enforcement.** The most serious verdict among the turn's user messages decides the turn:

```
REJECT > NOT_A_CANDIDATE > PERMISSION_LANGUAGE > UNDECIDED > ACCEPT
```

- If any message is `REJECT` or `NOT_A_CANDIDATE`, or has the rule `PERMISSION_LANGUAGE`, the turn stops. There is no model call, no new memory and no update to an existing one.
- If every message is `ACCEPT` or `UNDECIDED`, the rest of the pipeline runs exactly as it did before the gate.
- `ACCEPT` means eligible for extraction, nothing more. It never writes a memory by itself.

**Fail closed.** The contract might throw, or return anything other than a known decision with a known rule. Either way the whole turn stops at once, with no model call, no new memory and no update to an existing one. The only thing logged is:

```json
{"event":"memory_learning_decision_failed"}
```

The error itself is never logged, because it could carry the user's text.

**Logging.** Each classified message logs one line and nothing more:

```json
{"event":"memory_learning_decision","decision":"ACCEPT","rule":"STABLE_PREFERENCE"}
```

The line never carries user text, JARVIS's text, candidate text, secrets or user ids.

**JARVIS's reply is context, not a source.** The rule from 2026-09-29 is that JARVIS's reply may be read as context, but it cannot by itself establish a memory about the user. Every automatically stored memory must be grounded in something the user said. The gate is the first half of this:

- The reply is never classified.
- A turn the gate stops never reaches the model, reply included.

On a turn that continues, the reply still reaches the extraction model, because it can explain what the user meant ("yes, make **that** my default"). L2 provenance, below, makes sure nothing is stored from it alone.

**Not implemented.** Do not assume any of the following exists:

- **Retroactive forgetting.** A veto stops only its own turn. It does not delete or change a memory stored earlier, and there is no "forget that" path.
- **Corroboration (L4) and memory management (L5).** No memory is strengthened because it was repeated, nothing asks the user to confirm one, and nothing corrects or supersedes an older memory. Later layers will add these.

**Tests.**

| File | What it covers |
|---|---|
| `packages/core/test/learning-candidate-s7.test.ts` | The contract: every rule, its precedence, and its isolation (no I/O, no consumers beyond this service). |
| `packages/memory/test/memory-learning-shadow-s7.test.ts` | Where the gate runs, what it classifies, the log lines, enforcement and failing closed. |
| `packages/memory/test/memory-learning-gate-s7-pg.integration.test.ts` | The same enforcement against a real pgvector database: refused and failed turns leave zero `Memory` rows. |

### Provenance — S7.2 L2

Every automatically extracted memory records where it came from, and **a USER memory is created only from USER evidence**.

**Where the ids come from.** All of them are set by the server, never by a request body or by the model:

| Field | Source |
|---|---|
| `sourceType` | `"USER"` for every memory extraction creates |
| `sourceConversationId` | the turn's conversation |
| `sourceMessageId` | the saved user `Message` row. The chat route saves it before calling the orchestrator and passes its id as `SessionContext.userMessageId`. |
| `metadata.sourceTraceId` | the request's `traceId`, the same one saved on that message. There is no column for it, so it lives in `metadata` beside the embedding. |

JARVIS's reply is passed to extraction with its role and content only. It has no stored id yet, and it is never a source.

**The check.** For every candidate the model must give `source`, the label of the USER message it comes from, and `evidence`, a word-for-word quote from that message. `resolveUserProvenance` (`packages/core/src/learning-provenance.ts`, pure) accepts the candidate only if all of these hold:

- the label names exactly one message of this turn;
- that message is USER, according to the service's own record rather than the model's claim;
- the message has a conversation id and a message id;
- the quote, compared as text (case, spacing and quote marks ignored), really appears in it.

The provenance is then built from the service's record of that message. The model never sees an id.

Anything else is dropped on its own; a valid candidate beside it is kept. That covers a candidate that cites JARVIS's reply, cites nothing, or quotes words the user never wrote. Each drop logs one content-free line:

```json
{"event":"memory_candidate_provenance_rejected","reason":"SOURCE_NOT_USER","candidateIndex":0,"candidateCount":2}
```

`reason` is one of `SOURCE_MISSING`, `SOURCE_UNKNOWN`, `SOURCE_NOT_USER`, `SOURCE_IDS_MISSING`, `EVIDENCE_MISSING` or `EVIDENCE_NOT_IN_SOURCE`. Missing provenance is never filled in as USER. The request's old `lastMessageId` is not used as a source.

**Merge and skip.** A merge replaces the memory's content, so it also moves the provenance — trace included — to the user message that restated it. A skipped duplicate leaves the earlier memory and its provenance untouched. Content, type, importance, confidence, embeddings and expiry are handled exactly as before.

**Legacy rows.** Memories written before L2 keep `sourceType: "conversation"` and no message id. They are not rewritten.

**What this cannot catch.** The quote check proves the user wrote the quoted words. It cannot prove that those words support the candidate: a model could pair a claim JARVIS made with genuine user words, such as "sounds good". [Validation](#validation-and-learning-scope--s72-l3), below, decides that.

**Tests.**

| File | What it covers |
|---|---|
| `packages/core/test/learning-provenance-l2.test.ts` | The contract: every acceptance and rejection, text comparison, serializability, isolation. |
| `packages/memory/test/memory-provenance-l2.test.ts` | Cases A–E, id propagation, merge and skip, embedding alignment, content-free events. |
| `packages/memory/test/memory-provenance-l2-pg.integration.test.ts` | The same against pgvector: each memory is joined back to its saved `Message` row. |
| `packages/agents/test/memory-provenance-l2.test.ts` | The orchestrator passes the saved message id and this turn's trace, and nothing from history. |
| `apps/api/test/chat-memory-provenance-l2.test.ts` | The chat route supplies the id of the message it just saved, and a request body cannot forge it. |

### Validation and learning scope — S7.2 L3

L2 proves the user wrote the quoted words. L3 decides whether those words establish **durable USER memory**. It runs after provenance and before anything is embedded or written.

**The layers.**

| Layer | Job |
|---|---|
| L1 | Safety and rejection: secrets, grants, temporary instructions, JARVIS's own claims, acknowledgements, questions |
| L1b | Candidate classification: stable, undecided or permission language |
| L1c | Enforcement before the model, including the user's veto; fails closed |
| L2 | Provenance: every candidate cites a USER message it really quotes |
| L3 | Validation and learning scope (this section) |
| L4 | Corroboration — not built |
| L5 | User memory management: correction, supersession, forgetting — not built |

```
L1 → L1b → L1c (the gate) → extraction model → L2 provenance → L3 validation
   → only VALID + MEMORY → the existing embed / dedup / merge / write
```

**The learning boundary.**

| Durable memory — can be stored | Not durable memory — never stored |
|---|---|
| A preference: "I prefer short captions." | A goal: "I want to launch my SaaS by Q3." |
| A personal fact: "I live in Balaghat." | A task: "Remind me to call the client." |
| A working convention: "Use 1:1 for my Instagram creatives." | Project state: "The current project uses Next.js." |
| An explicit endorsement of one of these: "Yes, make that my default." | A current decision: "I decided to use PostgreSQL." |
| | Temporary or session scope: "For this campaign use short captions." |

Goals, tasks and project facts belong to future goal, task and project systems. L3 creates none of them and routes nothing anywhere. It only refuses to store them as memory.

**The result.** `validateLearningCandidate` (`packages/core/src/learning-validation.ts`) returns:

```
{ decision: "VALID" | "HOLD" | "INVALID",
  rule:     one of the rules below,
  scope:    "MEMORY" | "GOAL" | "TASK" | "PROJECT" | "DECISION" | "TEMPORARY" | "UNKNOWN",
  category: "STABLE_PREFERENCE" | "STABLE_PERSONAL_FACT" | "STABLE_WORKING_CONVENTION" }
```

`category` appears only on `DIRECT_USER_STATEMENT`.

- **The three decisions:**
  - `VALID`: the user's own words establish durable memory. VALID is always scope `MEMORY`.
  - `HOLD`: may be useful, but not established.
  - `INVALID`: clearly not durable USER memory.
- **Only `VALID` with scope `MEMORY` is ever stored.** `HOLD` and `INVALID` are never persisted, and neither is any other scope.
- **Scope is not stored.** It and `category` are a validation result only; no field or column was added.

The contract is pure and never throws. It sees only the claim, the quote, the cited user message and its provenance — never JARVIS's reply and never an existing memory.

**The rules**, in the order they are checked — every safety and context rule before either VALID rule:

| # | Rule | Decision | Scope | When |
|---|---|---|---|---|
| 1–2 | `MALFORMED_INPUT`, `PROVENANCE_MISSING` | INVALID | UNKNOWN | Broken input. At runtime these fail the turn, see below. |
| 3 | `NOT_USER_SOURCE` | INVALID | UNKNOWN | ASSISTANT or SYSTEM provenance |
| 4–5 | `EVIDENCE_MISSING`, `EVIDENCE_NOT_IN_MESSAGE` | INVALID | UNKNOWN | No quote, or one the user never wrote. This re-checks L2 with L2's contract. |
| 6 | `USER_MESSAGE_NOT_LEARNABLE` | INVALID | UNKNOWN | L1 refuses the message: secret, grant, veto, question, permission language |
| 7 | `CLAIM_NOT_LEARNABLE` | INVALID | UNKNOWN | L1 would refuse the claim itself |
| 8 | `TEMPORARY_SCOPE` | INVALID | TEMPORARY | L1's temporary or one-off rules ("this", "today", "for now", …), or "currently", "at the moment" — in the message or the claim |
| 9 | `GOAL_OR_TASK` | INVALID | GOAL or TASK | A goal ("want / need / plan / hope / trying to …", "my goal …"), or a task (a sentence that opens with an action such as remind, send, fix, book, schedule, cancel, with nothing that makes it standing, or any reminder or to-do) |
| 10 | `PROJECT_OR_CURRENT_CONTEXT` | INVALID | PROJECT | "the / this / current project, client, campaign, app, website, codebase …", "my / our project, client, campaign …" |
| 11 | `CURRENT_DECISION` | INVALID | DECISION | "decided", "chose", "picked", "opted", "settled on", "go with", "we'll use", "let's use" |
| 12 | `WEAK_ACKNOWLEDGEMENT` | HOLD | UNKNOWN | "Thanks.", "Okay.", "Got it.", "Thanks, sounds good.", "That sounds good." |
| 13 | `UNCERTAIN_LANGUAGE` | HOLD | UNKNOWN | "I think…", "Maybe…", "I might…" |
| 14 | `GENERAL_STATEMENT` | INVALID | UNKNOWN | Not about the user ("People prefer…", "LeadVexo uses Supabase."), or second-hand ("JARVIS says I prefer…", "You said I…") |
| 15 | `NOT_ESTABLISHED` | HOLD | UNKNOWN | Neither a durable statement L1b recognises nor an explicit endorsement, e.g. "My company uses Meta Ads.", "Keep captions short." |
| 16 | `CLAIM_UNSPECIFIC` | HOLD | MEMORY | A claim with nothing to check ("User prefers it") |
| 17 | `CLAIM_EXCEEDS_EVIDENCE` | HOLD | MEMORY | Some of the claim's words are not the user's |
| 18 | `CLAIM_CHANGES_MEANING` | HOLD | MEMORY | The claim drops a negation in its sentence or the "my X" / "X's" subject of its clause. This is checked against the whole message, so a trimmed quote cannot hide it. |
| 19 | `CLAIM_NOT_SUPPORTED` | INVALID | MEMORY | None of the claim's words are the user's |
| 20 | `EXPLICIT_ENDORSEMENT` | VALID | MEMORY | The whole message is "Yes, make that my default", "That's my preference" or "Remember that as my default" (small variations: set/keep, it) |
| 21 | `DIRECT_USER_STATEMENT` | VALID | MEMORY | L1b calls the message — or what follows a plain opener such as "Thanks!" or "Actually," — a stable preference, personal fact or working convention, and every content word of the claim is in the quote |

Rules 17–19 compare the claim with the user's words, so they apply to direct statements only. An endorsement's claim comes from the context it endorses.

- **Content words:** the claim's words minus framing ("User", "the", "is", "for" …). The preference words count as one word, and so do the negation words.
- **No inference:** a paraphrase that uses other words is `HOLD`.

**Choices worth knowing.**

- **"Thanks, sounds good."** When JARVIS's claim is quoted against it, the result is `HOLD / WEAK_ACKNOWLEDGEMENT`, never VALID.
- **"Okay." after a suggestion from JARVIS** is `HOLD`. It never reaches L3 at all: the pre-filter and gate drop it before the model. Only an explicit endorsement validates a contextual preference, and the USER message is always the provenance.
- **"Make this my default."** is `TEMPORARY`: "this" is the current item (L1's one-off rule). An endorsement must say "that" or "it".
- **"My goal is to reach 10k followers."** is a stable personal fact to L1b. The goal rule (9) runs first, so it is `INVALID / GOAL`.
- **"I need to finish the campaign today."** is caught by the temporary rule (8) before the goal rule (9), so its scope is `TEMPORARY`. Neither is stored.
- **"LeadVexo uses Supabase."** has no project marker. It is refused as a statement about something other than the user (`GENERAL_STATEMENT`), not with scope `PROJECT`.

**Per candidate.** Each candidate is decided on its own. A refused one is dropped with one content-free line, and its `VALID` neighbours go on:

```json
{"event":"memory_candidate_validation_rejected","decision":"INVALID","rule":"GOAL_OR_TASK","scope":"GOAL","candidateIndex":1,"candidateCount":3}
```

**Fail closed.** The whole turn is refused if any of these happens:

- the validator throws;
- its answer is not a well-formed result — a known rule with its own decision, one of its scopes, and a category exactly when it is a direct statement;
- it reports `MALFORMED_INPUT` or `PROVENANCE_MISSING`, which L2 makes impossible;
- a `VALID` arrives outside scope `MEMORY`.

Nothing is then embedded, written, updated or merged, and no further model call is made. The only line logged is:

```json
{"event":"memory_learning_validation_failed"}
```

The error is never logged.

**What L3 does not do.**

- **Correct, supersede, delete or mutate memories — that is L5.** A `VALID` new preference that contradicts an older one is judged on its own evidence, and L3 never reads the older memory. The existing S7 dedup path is unchanged, though: if the two are close enough (cosine 0.7 up to 0.95), the merge replaces the older memory's content.
- **Change confidence, importance, expiry, embeddings, dedup or merge thresholds, or repository SQL.**
- **Use S5 feedback or S6 evaluation**, or corroborate (L4).
- **Create or feed** a task, project or goal system.
- **Grant anything.** A memory is data, never authorization.
- **Call a model.**

**Effect on what JARVIS learns.** Only durable preferences, facts and conventions stated in the user's own words, and explicit endorsements, are stored. Goals, tasks, projects and decisions are no longer stored as memories. A model that paraphrases freely gets more `HOLD`s. Watch the rejection events after deployment.

**Tests.**

| File | What it covers |
|---|---|
| `packages/core/test/learning-validation-l3.test.ts` | 12+ cases per durable category; 8+ each for goal, task, project, decision and temporary; HOLD, endorsement, security, provenance, claim safety, the rule order, result shape, determinism, isolation |
| `packages/memory/test/memory-validation-l3.test.ts` | Runtime: order, per-candidate drops, each non-memory scope, JARVIS-suggests-then-user-answers, fail-closed variants, no merge for refused candidates, content-free events |
| `packages/memory/test/memory-validation-l3-pg.integration.test.ts` | pgvector: VALID writes one aligned row; HOLD, INVALID, each non-memory scope and a failure leave a close earlier memory unchanged in every field |

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
