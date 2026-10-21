# Phase 18 — the automation engine

## Stage 18.1 — the persistent Automation Library

**Status: IMPLEMENTED, 2026-10-19 — uncommitted on `feat/automation-engine-phase-18`
(on top of `1fd1bb0`); not deployed, not run against a real n8n.** Stage 18.2
(below) builds on it. Nothing here activates, edits or runs a workflow.

### What it is

A durable catalog of the workflows an n8n instance holds, read from its Public
REST API and stored in PostgreSQL so it survives a restart. An instance can hold
more than 10,000 workflows — more than one bounded traversal reaches — so the
catalog is built by **scans** that may span several bounded **runs**, each
resuming from the checkpoint the previous one stored.

### Why a new table, not `N8nWorkflow`

`N8nWorkflow` is the per-account **trigger allow-list**: which workflows an
account may trigger, by webhook path — an outbound security boundary scoped to
a user. A library entry records that a workflow was **seen** in the instance, by
its n8n id, for the Organization that owns the connection. These are different
facts with different owners. Folding discovered workflows into the allow-list
would make every discovered workflow look triggerable, so the two stay apart. A
catalog entry grants nothing; triggering remains `n8n.trigger`, approval-gated.

### Data model

Migration `20261019120000_phase18_automation_library` — one enum and three
tables, additive.

| Table | One row per | Holds |
|---|---|---|
| `AutomationLibraryEntry` | Organization × provider × instance × n8n workflow id (unique) | name, active state, n8n's `createdAt`/`updatedAt`/`versionId`, tag names, node **types** and count (null when the listing did not carry them — unknown, never "none"), a normalized `search_text`, a SHA-256 `fingerprint` of all of those, `source` (`rest`), first/last seen (time and scan), when the listing last changed, consecutive missed complete scans, `missing_since`, `removed_at` |
| `AutomationLibrarySync` | catalog (unique Organization × provider × instance) | the open scan — id, the provider cursor to resume from, page size, pages and rows so far, SHA-256 hashes of every cursor already requested, start time; the last complete scan — id, time, record count; the **lease** — owning run and expiry |
| `AutomationLibrarySyncRun` | bounded run | scan id, requester, status (`RUNNING`, `PARTIAL`, `COMPLETE`, `FAILED`), whether it resumed a scan, pages, rows observed, created / updated / unchanged / rejected, marked missing / removed, a stable failure code, start, heartbeat, end |

**Scope.** A catalog belongs to the Organization that owns the n8n REST
connection (`AutomationConnectorOwner`, `n8n/rest`) **and** to one instance.
The instance is `libraryInstanceKey(N8N_BASE_URL)`, a hash of the scheme, host
and path; the URL is never stored, and pointing the server at another instance
starts another catalog. Every read and write names all three. Rows cascade with
their Organization.

**Never stored:** a node's parameters or credentials, a workflow's settings,
static data or pinned data, the API key, any header, and any text n8n returned
in an error. The listing is normalized in two places: `@jarvis/n8n` keeps only
the fields above, and core's `normalizeLibraryWorkflow` bounds them again.

### The sync lifecycle

```
POST /sync ─► authorize (owner/admin) ─► reserve budgets ─► beginRun (lease) ─► 202
                                                              │
               ┌──────────────── one bounded run, in the background ──────────────┐
               │  for each page, up to 20:                                        │
               │    fetch(cursor, pageSize)          ← @jarvis/n8n, read-only     │
               │    normalize + de-duplicate         ← @jarvis/core, pure         │
               │    persistPage: ONE transaction     ← @jarvis/db                 │
               │      renew lease (fencing) → upsert rows → advance checkpoint    │
               │      (last page: reconcile, close scan, COMPLETE, release lease) │
               └──────────────────────────────────────────────────────────────────┘
```

- **A scan** walks n8n's cursor chain from the first page to the page whose
  `nextCursor` is empty. Its page size is fixed when it opens, because n8n's
  cursor carries the page size.
- **A run** reads at most 20 pages (`LIBRARY_MAX_PAGES_PER_RUN`, the same bound
  as `N8N_MAX_LIST_PAGES`) and stops. The bound is never raised: a larger
  catalog takes more runs. A scan reading more than 4,000 pages is abandoned as
  unbounded (`SCAN_TOO_LONG`).
- **Checkpoint semantics.** A page is stored, and the checkpoint advanced past
  it, in **one transaction** that first renews the run's lease. A checkpoint
  never points past an unstored page, and a page whose transaction fails
  leaves the checkpoint where it was. The next run resumes from the stored
  cursor, with the scan's page size.
- **Statuses.**
  - `COMPLETE`: the chain ran out with every page stored.
  - `PARTIAL`: the page budget was spent, or the server is stopping. The scan
    stays open.
  - `FAILED`: the run failed; see the table below.
  - `RUNNING`: only while the run holds its lease.
  - The library's own `state` is `running`, `partial`, `complete`, `failed` or
    `never_synced`. `complete` requires that no scan is open and a complete
    scan is on record.

**What n8n's cursor is.** n8n documents cursor pagination for
`GET /api/v1/workflows`: a default page of 100, at most 250, and no
`nextCursor` on the last page. Its documented example cursor,
`eyJsaW1pdCI6MTAsIm9mZnNldCI6MTB9`, decodes to `{"limit":10,"offset":10}`, so
the cursor carries an **offset**. Two consequences shape the design:

- An item can appear on two pages when a workflow is created ahead of the
  window during a scan. Upserts are idempotent, so it is stored once.
- An existing workflow can be **skipped** when one ahead of it is deleted during
  a scan. One complete scan therefore never proves a workflow is gone.

### Recovery

| What happens | The run | The scan | The next run |
|---|---|---|---|
| n8n fails after some pages (timeout, unreachable, rate limit, 5xx) | `FAILED` with the code | open; checkpoint on the last stored page | re-reads that page and continues |
| n8n refuses the key | `FAILED PROVIDER_AUTH_FAILED` | open | continues once the key works |
| a page cannot be stored | `FAILED PERSISTENCE_FAILED` | open; nothing of that page recorded | reads it again |
| n8n rejects the saved cursor (400/422 to a request that carried one) | `FAILED CURSOR_REJECTED` | **closed** | starts a new scan from the first page; nothing stored is lost, and nothing is reconciled until a scan completes |
| a cursor comes back in the same scan — immediately or pages later | `FAILED CURSOR_CYCLE`; the page that returned it is stored | **closed** | starts again from the first page; a provider that always cycles never produces a complete scan |
| the process dies mid-run | stays `RUNNING` until its lease expires (3 minutes) | open | closes it as `FAILED INTERRUPTED` and resumes the scan |
| a run's lease expired and another run took it | `FAILED LEASE_LOST`; it stores nothing more | the other run's | — |
| the server is stopping | `PARTIAL` at the next page boundary | open | resumes |
| an owner asks `restart: true` | — | closed and reopened | starts from the first page |

### Deletions

Only the transaction that stores a scan's **last** page reconciles. Entries that
scan did not see gain one missed scan and a `missing_since`; an entry missing
from **two consecutive complete scans** (`LIBRARY_MISSED_SCANS_BEFORE_REMOVED`)
gets `removed_at`. Seen again, it is present again. Partial and failed scans
reconcile nothing, and no entry is ever deleted: removal is a mark. Two scans,
because n8n's offset cursor can skip a workflow during one scan (above).

### One run at a time

`beginRun` takes the catalog's lease with one conditional `UPDATE` (the lease is
free or expired). Of two runs starting together — two requests, two API
instances — exactly one gets it, and the other is answered `409
SYNC_ALREADY_RUNNING`. Every page renews the lease inside its own transaction
and stores nothing if the lease is no longer this run's (fencing). Every
conditional update filters on plain columns, so it is one SQL statement decided
under the row lock.

### Who may do what

The n8n REST connection is a shared connection, so every call asks
`SharedConnectionAccess` from the database:

| Membership role in the owning Organization | Read the catalog and status | Start a sync |
|---|---|---|
| owner, admin | yes | yes (`shared:sync`, added to the shared-connection grant table) |
| member, viewer | yes | no — `403 PERMISSION_DENIED` |
| not a member, or nobody owns the connection | no — `403 NOT_AVAILABLE`, the same whether n8n is configured or not | no |
| ownership or membership unreadable | `503 AUTHORIZATION_UNAVAILABLE` | same |

Authorization comes before the configuration check, so an outsider never learns
whether n8n is configured. Moving the connection to another Organization shows
that Organization an empty catalog, and the previous owner nothing.

**Budgets**, reserved in PostgreSQL before n8n is called (`AtomicRateLimiter`,
namespace `automation_library`): 10 sync starts per account per 10 minutes
(`sync_slot`), and 60 per catalog per hour (`sync_budget.<tenant>.<instance>`).
If a budget cannot be checked, nothing starts. Each route also has a
per-account attempt ceiling in memory, applied before the database: 120 reads
or 30 syncs a minute.

**Audit.** These are recorded in the audit table:
- every sync request (`automation_library.sync`), whether accepted or refused;
- every run's end (`automation_library.sync_run`), with its status, failure
  code and counts;
- every refused read (`automation_library.read`).

Rows hold ids, codes and counts — never a cursor, a URL or a provider's
words. The Organization's id appears only in rows for an authorized caller.

### API

| Endpoint | Does |
|---|---|
| `GET /api/v1/n8n/library/workflows?page&limit&search&active&presence` | The catalog, ordered by name. `limit` is at most 100. `search` (up to 100 characters) matches name, tags and node types. `presence` is `current` (default), `present`, `missing`, `removed` or `all` |
| `GET /api/v1/n8n/library/status` | `configured`, `state`, entry counts by presence, the open scan's progress, the last complete scan, and the last 10 runs, each with `failure: { code, message }` |
| `POST /api/v1/n8n/library/sync` `{ restart?: boolean }` | `202 { runId, resumed, state: "running" }`; the run continues in the background, and `/status` follows it |

- **Stable error codes:**
  - authentication and authorization: `AUTHENTICATION_REQUIRED`, `NOT_AVAILABLE`,
    `PERMISSION_DENIED`, `AUTHORIZATION_UNAVAILABLE`;
  - configuration and storage: `N8N_NOT_CONFIGURED`, `LIBRARY_UNAVAILABLE`;
  - limits and concurrency: `RATE_LIMITED`, `SYNC_ALREADY_RUNNING`;
  - bad requests: `REQUEST_SCOPE_REFUSED`, `INVALID_QUERY`, `INVALID_REQUEST`.
- **Run failure codes and their fixed sentences** are in
  `LIBRARY_FAILURE_MESSAGES` (`@jarvis/core`).
- **Refused request fields:** a query or body field that names a user,
  organization, tenant, account, workspace, provider, instance, URL, cursor or
  scan is refused outright, never obeyed. Headers are not read for scope.
- **What a response never carries:** a cursor, the instance key or URL, the
  Organization's id, a credential, or n8n's words.

No endpoint, tool or button activates, edits or runs a workflow.

### Where it lives

| Part | File |
|---|---|
| Rules and ports (pure) | `packages/core/src/automation-library.ts` |
| One page of the listing (network) | `packages/n8n/src/library-source.ts`; metadata in `packages/n8n/src/api-client.ts` |
| Storage | `packages/db/src/repositories/automation-library-repository.ts`; schema and migration |
| One bounded run | `apps/api/src/services/automation-library/sync-engine.ts` |
| The one implementation | `apps/api/src/services/automation-library/library-service.ts` |
| HTTP | `apps/api/src/routes/automation-library.ts`, mounted in `apps/api/src/index.ts`; built in `container.ts` |
| Grant | `shared:sync` in `packages/security/src/shared-connection-authz.ts` |

### Tests

```bash
# Without a database
pnpm --filter @jarvis/core exec vitest run automation-library
pnpm --filter @jarvis/n8n test
pnpm --filter @jarvis/security test
pnpm --filter @jarvis/api exec vitest run automation-library-sync automation-library-routes

# PostgreSQL — a separate throwaway database, never 5432 or 5433
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5436/DB?schema=public JARVIS_REQUIRE_POSTGRES=1 \
  pnpm --filter @jarvis/db exec vitest run automation-library
DATABASE_URL=… JARVIS_REQUIRE_POSTGRES=1 pnpm --filter @jarvis/api exec vitest run automation-library-p18-pg
```

| Required property | Proven by |
|---|---|
| More than one page | engine: 600 workflows in 3 pages |
| More than 5,000 records across bounded runs | engine: 10,500 in three runs of at most 20 pages; PostgreSQL: 5,600 in three runs, each on a new connection and service |
| Resume from a saved cursor | engine: a new service over the same store resumes at offset 200; PostgreSQL: every run after a restart |
| Duplicate pages, idempotent upserts | engine and PostgreSQL: a workflow repeated across pages, the same page stored twice, a row repeated in one page |
| A cursor cycle | engine: a cursor reappearing after three pages, and one repeated immediately; PostgreSQL |
| n8n failing after pages were stored | engine and PostgreSQL: pages kept, the checkpoint on the next page, resumed without re-reading; a page the database refused is read again |
| Partial versus complete | engine: page budget, server stopping, restart; route: `partial` then `complete` |
| Deletions reconciled only after complete scans | engine and PostgreSQL: partial and failed scans reconcile nothing; missing once, then removed after two complete scans; seen again, present; rows never deleted |
| Concurrent syncs for one catalog | PostgreSQL: two connections, five rounds; two API instances; engine and route: `409` |
| Organization isolation | engine, PostgreSQL and route: outsiders refused alike; a moved connection gives an empty catalog; Organizations and instances never mix |
| Credential and raw-error redaction | n8n: node parameters, credentials, static and pinned data dropped; the adapter passes codes only; engine, route and PostgreSQL: nothing secret, no cursor, instance or Organization id in any answer or row |
| Existing pagination and catalog tests | `@jarvis/n8n` whole suite |

### Verification

2026-10-19, Windows, Node 24, on the working tree; turbo's cache bypassed with
`--force`. PostgreSQL runs used brand-new `pgvector/pgvector:pg16` containers
with a random password and every migration applied — never the development
(5432) or deployment (5433) database. No request reached n8n.

| Command | Result |
|---|---|
| `pnpm typecheck` / `pnpm typecheck:tests` / `pnpm lint` / `pnpm build` | 37/37 · 20/20 · 20/20 · 20/20, none cached |
| `turbo run test --concurrency=1 --continue --force` (every workspace, no database) | **9,744 passed, 4 failed, 646 skipped**, 20 workspaces. The four are the timing-sensitive tests named in `docs/phases/phase-15.md` §15 and phase-17 §5: `evidence-builder` (core), `verify-s8` (mcp), `mcp-integration-s8` and `mcp-pilot-failures-s8` (api). Run alone straight after, their files passed 18/18, 8/8 and 52/52. Nothing in this stage touches them |
| CI's database steps, replayed in order | 33 migrations applied; `@jarvis/db` **417/417** (28 files), `@jarvis/memory` 93/93 (9), `@jarvis/api` **235/235** (10), the evaluation 13/13; the skip check: 0 not run in all four reports |
| The new CI step (`vitest run automation-library` in core) | 14/14 |
| The new suites | core 14; n8n 6 (and the whole n8n suite 141/141, its pagination and catalog tests unchanged); security 192 (4 new: who may sync); API engine and service 22, routes 20; PostgreSQL: db 7, API 7 |
| The two database suites with a configured database that cannot be reached | **failed** (`Failed Suites 1`), never skipped |

**Mutation checks**, each restored byte for byte afterwards (SHA-256):

| Control removed | Caught by |
|---|---|
| cursor-cycle detection | 2 engine tests |
| a page-budget run called COMPLETE | 9 (engine and route) |
| a rejected cursor not restarting the scan | 1 |
| one complete scan enough to remove an entry | 1 (core rebuilt for it, then restored) |
| a member allowed to start a sync | 2 (service and route) |
| request fields naming a scope or cursor obeyed | 8 route tests |
| a node's raw contents kept by the n8n listing | 1 |
| n8n's error words passed on by the page source | 2 |
| the lease taken whether or not it is held (PostgreSQL) | 1 |
| a page stored without the run holding the lease (PostgreSQL) | 2 |
| reconciliation on every page instead of at the end (PostgreSQL) | 1 |

### Known limitations

- **A run is started by a request.** Nothing continues a scan in the
  background until it completes: a 10,000-workflow catalog takes one request
  per 5,000 workflows. Nothing schedules a periodic resync.
- **The run belongs to the API process that started it.** If that process
  stops, the lease expires after up to 3 minutes and the next run recovers
  the scan.
- **Reads come from the catalog only.** No route or tool reads n8n live, and
  JARVIS (chat, voice, agents) cannot reach the library yet. The dashboard has
  no screen for it.
- **Search is a substring match** on a normalized text column, with no
  trigram index. It is adequate at tens of thousands of rows and is not
  designed for much more.
- **Metadata only.** There are no categories or derived integrations beyond
  node types, and the fingerprint covers listing metadata and n8n's
  `versionId`, never a workflow's nodes.
- **A cycle repeats.** A provider whose cursor always cycles fails every scan
  at the same place, so its catalog is never complete. That is honest, but
  nothing works around it.
- **Removal needs two complete scans.** A workflow deleted in n8n stays listed
  (as `missing`) until then.
- **Not exercised against a real n8n instance** or the deployed stack.

### Next: Stage 18.2 (done — see below)

Make the library reachable from JARVIS and the dashboard through the same
service, as the integration rule requires:

- `automation.library.search`, `automation.library.status` and
  `automation.library.sync` tools on the automation agent's allowlist, run
  through `ToolExecutor`, calling `AutomationLibraryService` — no second
  implementation;
- an Automations page section that lists the catalog and shows sync status;
- an owner-started **continue-until-complete** option that chains bounded runs
  under the same budgets and lease.

Acceptance:
- a sentence and a button reach the same method and get the same refusals;
- a voice session cannot start a sync;
- no tool can activate, edit or run a workflow.

---

## Stage 18.2 — JARVIS tools, the Automations page, continue until complete

**Status: IMPLEMENTED, 2026-10-20 — uncommitted on `feat/automation-engine-phase-18`,
beside Stage 18.1; not deployed, not run against a real n8n.** Nothing here
activates, edits or runs a workflow, and no live message is sent.

### What it adds

1. **Three JARVIS tools** on the automation agent, run through `ToolExecutor`
   and answered by the same `AutomationLibraryService` instance as the API.
2. **A voice rule, enforced server-side**: a spoken turn cannot start or
   continue a catalog sync.
3. **A catalog section on the Automations page**: the workflow list, sync
   status and history, and owner/admin-only Sync and Continue controls.
4. **Continue until complete**: an owner/admin-started **chain** of the
   bounded runs from Stage 18.1, kept going until the scan completes, under
   hard limits.

### One port, every surface

`AutomationLibraryPort` (`@jarvis/core`) has three methods: `list`, `status`
and `startSync`. The service implements it. The API router and the tools are
both handed the one instance built in `container.ts`:

```
  Automations page ──► /api/v1/n8n/library/*  ──┐
                                                ├──► AutomationLibraryService
  "n8n library sync karo" ──► ToolExecutor ──► automation.library.* ──┘
```

The request rules live in core and both arms use them, so an equivalent
request is refused in the same words on both:
- the query bounds (`validateLibraryEntryQuery`);
- the sync options (`validateLibrarySyncOptions`);
- the fields only the server decides (`namesLibraryServerScope` — now also
  `apiKey`, `credential`, `token`).

A tool's refusal carries the API's `status`, `code` and sentence in its result
metadata. `apps/api/test/automation-library-tools-p18.test.ts` compares the two
arms, refusal for refusal.

### The tools

| Tool | Risk | Platform permission | Approval | Does |
|---|---|---|---|---|
| `automation.library.search` | `READ_ONLY` | `read` | no | `list`: search, active, presence, page, limit — the API's filters and bounds |
| `automation.library.status` | `READ_ONLY` | `read` | no | `status`: the same view as `GET /status` |
| `automation.library.sync` | `LOW_IMPACT` | `read` | no | `startSync`: one bounded run, or `continueUntilComplete`; optional `restart` and `idempotencyKey` |

- **The Organization role decides; the platform role never does.** All three
  tools need only the platform's `read`, which every role has. The owning
  Organization's role is checked in the service, as for the API. A platform
  viewer who owns the Organization may sync; a platform owner who is only a
  member may not.
- **Why the sync is `LOW_IMPACT`.** It reads n8n and writes only JARVIS's own
  catalog: no approval, and it is refused once the server starts shutting
  down.
- **Where they are granted.** They are on the automation agent's allowlist
  only. They are registered on every deployment; where n8n is not configured
  the service says so.
- **What the agent is told.** Its prompt says a library entry is not
  permission to run anything (only the AUTHORIZED WORKFLOWS are). It also says
  a sync cannot be started by voice, and that the library may be called
  complete only when status says so.
- **The write-intent gate.** It now reads `sync`, `synchronize`, `resync` and
  `refresh` as orders. Otherwise "Sync the n8n library" would be refused as
  unrequested.
- **Capabilities and skills.** The catalog files the tools under
  `automation`, gated on `n8n`; the `productivity` skill owns the
  `automation.library.` prefix.

### Voice cannot start or continue a sync

**The problem.** The voice client sends its transcript through the ordinary
`POST /api/v1/chat`. Until now the server had no way to tell a spoken turn
from a typed one.

**How a turn is marked spoken.** The chat route marks the turn when either
holds:
- the request says `inputMode: "voice"` — the voice store now sends it;
- the text is one the server itself transcribed for **this account** in the
  last two minutes (`RecentTranscripts`, fed by `POST /voice/transcribe`).

**What the mark is.** It only narrows what may run. `"text"` never unmarks a
recognised transcript. The transcript memory keeps SHA-256 hashes, never
words, and is bounded in size and time.

**Where it is carried:**
- `SessionContext.inputMode`;
- `ToolExecutionRequest.inputMode` (set by the orchestrator and by the chat
  route's CONFIRM path);
- `ToolContext.inputMode`.

**Where it is enforced** — `VOICE_REFUSED_TOOLS` in
`packages/core/src/voice-tool-policy.ts` lists only `automation.library.sync`:

| Layer | What it does |
|---|---|
| `ToolExecutor` | Refuses before the access gate, any approval or the tool, under the registry id, whatever alias the model used: `permission_denied`, code `VOICE_NOT_ALLOWED`, a fixed sentence pointing to the Automations page. |
| Orchestrator | Answers the same sentence before any gate, pending action or execution, audited as `agent.tool_voice_refused`. |
| Sync tool | Refuses a spoken context itself. |

Tests prove that for a spoken turn the tool, the service and n8n are never
reached and no budget is spent. The reads stay open to voice.

### Continue until complete

`POST /sync { continueUntilComplete: true, idempotencyKey? }`, or the tool with
`continueUntilComplete`, starts a **chain**. A chain is the Stage 18.1 bounded
runs, one after another, of the same scan. It adds no engine, lease or budget
of its own. Each run is an ordinary run that also carries the chain's id.

| Rule | How |
|---|---|
| Who | `shared:sync` (owner, admin), checked when the chain starts **and again before every run**, from the database. A role taken away or the Organization left → `AUTHORIZATION_CHANGED`; the connection moved to another Organization or instance → `SCOPE_CHANGED`; unreadable → `AUTHORIZATION_UNAVAILABLE` |
| Budget | The caller's slot once, when the chain starts. The Organization's catalog slot for **every** run, before it begins. Exhausted → `BUDGET_EXHAUSTED`; uncheckable → `BUDGET_UNAVAILABLE` |
| Hard limits | `LIBRARY_CHAIN_MAX_RUNS` 25 runs, `LIBRARY_CHAIN_MAX_PAGES` 500 pages (the last run is given only the pages left), `LIBRARY_CHAIN_MAX_MS` 30 minutes (a run in flight stops at its next page boundary). Each may only be lowered |
| Failures | A run failure worth retrying (`PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `PERSISTENCE_FAILED`) is retried after a pause of 10 s × failures so far, at most 3 failed runs in a row (`RETRY_LIMIT`). Anything else stops it at once (`RUN_FAILED`, with the run's code) — a rejected cursor, a cursor cycle, refused credentials, a lost lease |
| Another sync | A chain is refused while a single run holds the lease. While a chain is alive, a single run gets `409 SYNC_ALREADY_RUNNING` |
| Repeated clicks | While a chain is alive, a request to continue — a second click, a retry, another admin — is answered with that chain (`existing: true`) and **nothing is spent**. An `idempotencyKey` (8–64 of `A-Z a-z 0-9 - _`, scoped to the requester) returns the chain it first started, even after it ended (HTTP 200 with its final state) |
| Complete | The chain is `COMPLETE` only when its last run completed the scan — the store closed it in the transaction of the last page. Every other end is `STOPPED` with a code, and the scan's place is kept |
| Shutdown | A stopping server ends the run at its next page and the chain as `SHUTDOWN` |

**How one chain at a time holds.** The catalog's sync row names the chain
that holds it (`activeChainId`) and its last sign of life
(`chainHeartbeatAt`):
- **Starting a chain** is ONE conditional `UPDATE`, applied only when no run
  holds the lease and no live chain holds the catalog.
- **A run's start** carries the chain condition in the same conditional
  `UPDATE` that takes the lease. A chain's run starts only while that chain
  still holds the catalog (`CHAIN_LOST` otherwise). A single run starts only
  while no live chain does.
- **When a chain is alive:** while one of its runs holds the lease, or its
  heartbeat is fresh (`LIBRARY_CHAIN_STALE_MS`, 3 minutes). The release of a
  run's lease refreshes the heartbeat in the same statement, so there is no
  gap between the two.

**Recovery after a restart.** Chains are rows (`AutomationLibrarySyncChain`),
so a restart loses nothing. A chain whose process died is:
1. shown as `INTERRUPTED` on `/status` as soon as its lease and heartbeat are
   stale;
2. closed as `INTERRUPTED` by whichever start next takes the catalog, in the
   same transaction;
3. continued from the scan's last stored page by the next run or chain.

Its old driver, if it ever wakes, holds nothing, stores nothing (fencing) and
claims nothing. **Nothing restarts by itself** — continuing is a person's
decision.

**Progress.** A chain's counters (runs, pages, workflows read) are written as
each run finishes. The open scan's own counters (`currentScan`) are written
page by page.

### Data model (migration `20261019180000_phase18_library_continuation`)

Additive: one enum, one table, three nullable columns, their indexes and
foreign keys. It alters no existing column and writes no row.
- `AutomationLibraryChainStatus`: `RUNNING`, `COMPLETE`, `STOPPED`,
  `INTERRUPTED`.
- `AutomationLibrarySyncChain`:
  - id, catalog, requester (`SET NULL` with the account), idempotency key
    (unique per catalog and requester);
  - status, stop and failure codes;
  - counters, limits, deadline and timestamps.
  - No cursor, address or provider text.
- `AutomationLibrarySync.active_chain_id` and `chain_heartbeat_at`.
- `AutomationLibrarySyncRun.chain_id` (`SET NULL`).

### API changes

| Endpoint | Change |
|---|---|
| `POST /api/v1/n8n/library/sync` | Body `{ restart?, continueUntilComplete?, idempotencyKey? }` (real booleans). Answers `202 { mode: "run", runId, resumed, state }` or `202 { mode: "continue", chainId, existing, state: "running" }`; a key's replay of a chain that already ended answers `200` with its final `state` |
| `GET /api/v1/n8n/library/status` | Adds `canSync` — the server's answer for this reader, now, a hint for the screen; every start is checked again — and `continuation`: the latest chain's status, stop `{ code, message }`, the failed run's code, counters, limits and times. Never the requester, the key or a cursor. `state` is `running` while a chain is alive, between its runs too |

New stable codes:
- chain stop codes and their sentences, in `LIBRARY_CHAIN_STOP_MESSAGES`
  (`@jarvis/core`);
- `VOICE_NOT_ALLOWED`.

**Audit.**
- `automation_library.sync` gains `mode`, `chainId`, `existing` and `via`
  (`api` or `jarvis`).
- Every chain run is an `automation_library.sync_run` with its `chainId`.
- A chain's end is `automation_library.sync_chain`, with its status, codes
  and counts.
- Log lines: `automation_library_chain_started` and
  `automation_library_chain_finished`.

### The Automations page

`apps/web/src/components/automations/workflow-library.tsx`, below the trigger
allow-list. It works whether or not that section's router is deployed.

**Layout.** It is built from the existing primitives (`Panel`, `Badge`,
`StatusDot`, `Tabs`, `DataTable`, `Button`, the state components):
- the server's state badge;
- presence counts, the last complete scan, and the open scan's progress;
- the latest chain, with runs and pages against their limits, and why it
  stopped;
- the workflow list, with search, presence and active filters and
  pagination;
- recent runs, with their fixed reasons.

**States:**
- loading;
- not available to your account (`NOT_AVAILABLE` and `PERMISSION_DENIED`) —
  no list request is made;
- authorization or storage failure, with a retry;
- n8n not configured — with no controls;
- never synchronized or empty;
- partial — "the list may be incomplete";
- failed — the run's fixed sentence;
- running — polled every 4 s, with the list reloaded when it stops.

**Controls.**
- **Sync** and **Continue until complete** render only when `canSync`, and
  are disabled while a sync runs or a click is pending.
- Each click carries its own idempotency key. A retry after a network failure
  reuses the click's key.
- There is no activate, edit or run control.
- No request carries an Organization, instance or cursor.

### Where it lives

| Part | File |
|---|---|
| Port, views, request rules, chain contract | `packages/core/src/automation-library.ts` |
| Voice list and `InputModeSchema` | `packages/core/src/voice-tool-policy.ts`, `packages/core/src/types/voice.ts`; `inputMode` on `types/request.ts`, `types/context.ts`, `types/execution.ts`, `types/tool.ts` |
| Chains in storage | `packages/db/src/repositories/automation-library-repository.ts`; schema and the new migration |
| Chain driver, `startSync`, `canSync` | `apps/api/src/services/automation-library/library-service.ts` |
| Router | `apps/api/src/routes/automation-library.ts` (core's validators) |
| Tools | `packages/tools/src/tools/automation-library-tools.ts`; registered in `container.ts` |
| Executor refusal | `packages/tools/src/executor.ts` (its byte pin moved, deliberately) |
| Orchestrator refusal | `packages/agents/src/orchestrator.ts` |
| Allowlist, prompt, write-intent verbs | `packages/agents/src/agent-policy.ts`, `agents/automation-agent.ts`, `write-intent-gate.ts` |
| Voice marker | `apps/api/src/services/recent-transcripts.ts`, `routes/voice.ts`, `routes/chat.ts`; `apps/web/src/lib/{api,chat-store}.ts`, `lib/voice/voice-store.ts` |
| Screen | `apps/web/src/components/automations/workflow-library.tsx`, `app/automations/page.tsx`, `lib/api.ts` |
| Capabilities and skill | `packages/core/src/capability-catalog.ts`, `capability-presentation.ts` |

### Tests

New files, and what each pins:

| File | Tests | Pins |
|---|---|---|
| `packages/core/test/automation-library-continuation-p18.test.ts` | 10 | the shared query and sync rules; server-only fields; chain limits and retryable failures; stop sentences that never claim completion; `chainActive` as running; the voice list and `inputMode` on request and session |
| `packages/tools/test/automation-library-tools-p18.test.ts` | 8 | the executor's voice refusal before the tool, under an alias; `inputMode` in the tool context; the tool's own refusal; scope and validation refusals before the port |
| `packages/agents/test/automation-library-voice-p18.test.ts` | 7 | the allowlist; "sync" as an order; a spoken sync refused before the executor, under either spelling; the same typed request runs; reads run spoken and carry the mode; the prompt |
| `apps/api/test/automation-library-continuation-p18.test.ts` | 24 | chains to complete, and complete only then; run, page and time limits; shutdown; budget per run, exhausted or uncheckable; non-retryable, rejected-cursor, retried and retry-limit failures; authorization changed, left, scope moved, uncheckable; owner/admin only; two clicks one chain; repeated click spends nothing; a key's chain after it ended; refused under a single run; recovery after a dead process; `canSync` by role; nothing secret in views or audit |
| `apps/api/test/automation-library-tools-p18.test.ts` | 17 | each tool through a real `ToolExecutor` with the shared-connection gate; tool and API answers identical; refusal parity for outsider, role, unreadable authorization, not configured, budget, running sync, server-only fields, bad query and options; platform role decides nothing; spoken sync refused with nothing spent; HTTP 202/200 for continue |
| `apps/api/test/automation-library-voice-route-p18.test.ts` | 8 | `RecentTranscripts` (per account, normalized, TTL, bound, hashes only); the chat route marks a turn from the flag or the server's own transcript, never from another account's, refuses an unknown mode, and the executor then refuses the sync |
| `apps/web/test/workflow-library.test.tsx` | 17 | every state; controls only with `canSync`, disabled while running; never an activate, edit or run control; one request per click with a key, the same key on retry; refusals in the server's words; filters and pages; the page section |
| `apps/web/test/chat-input-mode.test.ts` | 3 | the chat store forwards `inputMode` for a voice turn only; the body carries it only then |
| `packages/db/test/automation-library-chain-p18-pg.integration.test.ts` | 5 | PostgreSQL, two connections: one chain of two starting together; one key one chain; only the holder's runs begin; refused under a single run; a dead chain closed by either kind of start, its scan resumed; lease release keeps the chain alive |
| `apps/api/test/automation-library-continuation-p18-pg.integration.test.ts` | 4 | PostgreSQL: 1,300 workflows in one chain; two instances one chain; a restart mid-chain recovered on a new connection; a role taken away stops it |

**Changed tests, deliberately:**
- the executor's byte pin (`mcp-boundaries-s8` in core and tools);
- the automation agent's allowlist size, 13 → 16, and its exact list;
- the production-like tool census (`sprint6-harness`, `sprint6-agent-wiring`
  — the automation agent's acting tools are now the trigger plus the
  library);
- the skill census's file list;
- the 18.1 route test's `202` body, which now carries `mode`;
- one voice-store test, for the flag.

### Verification

The runs were on 2026-10-20:
- Windows, Node 24, on the working tree;
- turbo's cache bypassed with `--force`.

The PostgreSQL runs used brand-new `pgvector/pgvector:pg16` containers with a
random password and every migration applied — never the development (5432) or
deployment (5433) database. No request reached n8n, no workflow was touched,
and no message was sent.

| Command | Result |
|---|---|
| `pnpm build` / `typecheck` / `typecheck:tests` / `lint` | 20/20 · 37/37 · 20/20 · 20/20, none cached |
| `turbo run test --concurrency=1 --continue --force` (every workspace, no database) | **9,840 passed, 3 failed, 656 skipped**, 20 workspaces. See the note below |
| CI's database steps, replayed in order | **34 migrations** applied; `@jarvis/db` **422/422** (29 files), `@jarvis/memory` 93/93 (9), `@jarvis/api` **239/239** (11), the evaluation 13/13; the skip check: 0 not run in all four reports |
| The widened CI step (`vitest run automation-library`) | core 24/24 (2 files), tools 8/8, agents 7/7 |
| `prisma migrate diff` (database after every migration → `schema.prisma`) | no difference in any `AutomationLibrary*` object; only the drift noted before Phase 18 |

**The three failures in the full suite are not caused by this stage:**
- `verify-s8` (mcp);
- `mcp-integration-s8` and `mcp-pilot-failures-s8` (api).

Each spawns a real stdio server and expects a timeout. The server was still
starting when the 500 ms deadline fired. They fail alone too, and they fail
identically on an untouched checkout of `1fd1bb0` (a temporary git worktree,
since removed). They passed alone on 2026-10-19.

**Mutation checks**, each restored byte for byte afterwards (SHA-256): **15/15
caught**.

| Control removed | Caught by |
|---|---|
| the executor's voice refusal | 2 (tools) |
| the sync tool's own voice refusal | 1 (tools) |
| the orchestrator's voice refusal | 2 (agents) |
| the orchestrator dropping `inputMode` from the request | 1 (agents) |
| the chat route ignoring the server's own transcripts | 1 (api) |
| a chain not re-checking authorization before each run | 4 (api) |
| a chain stopped by its run limit called COMPLETE | 1 (api) |
| a chain's later runs taking no Organization budget | 3 (api) |
| a repeated request spending before finding the existing chain | 2 (api) |
| a dead chain shown as running | 1 (api) |
| the router obeying server-only fields | 1 (api, parity) |
| Sync shown to a reader the server says may not start one | 1 (web) |
| a chain taking the catalog while a live chain holds it (PostgreSQL) | 1 (db) |
| a single run beginning while a live chain holds it (PostgreSQL) | 1 (db) |
| a run's lease release not keeping its chain alive (PostgreSQL) | 1 (db) |

### Known limitations

- **Nothing continues by itself.** A chain is started by a person, and a
  chain whose process died is only shown and closed — never resumed
  automatically. Nothing schedules a periodic resync.
- **A chain runs in the background of the API process that started it**, for
  at most its 30 minutes. Its runs are sequential and all stay on that
  process. If the process stops, the chain stops with it — gracefully as
  `SHUTDOWN`, or shown as interrupted when it dies.
- **The voice marker is narrowing, not proof.** A client that leaves out
  `inputMode` and alters the transcript's words is not recognised. That is
  typing, in effect. `RecentTranscripts` is in process memory, so on several
  API instances a transcript made on one is not recognised on another; there
  the client's flag is what marks the turn.
- **Only the library sync is on the voice list.**
- **Pre-existing, found while building this — fixed in Stage 18.3A, below:**
  the "a voice session cannot confirm a write" rule (AGENTS.md,
  `docs/INTEGRATIONS.md`) was enforced only by the voice client.
  - The integration command service and the Google write service refuse when
    `context.voice` is true, but nothing on the server ever sets it.
  - The chat route's CONFIRM path does not check the turn's mode.
  - The marker added here makes the server-side fix small: forward
    `inputMode` to those two services, and refuse a spoken CONFIRM. It was
    left for its own reviewed change.
- **The chain's counters move per finished run**; the open scan's counters
  move per page.
- **Not exercised against a real n8n instance**, the deployed stack, or a
  browser.

### Next: Stage 18.3 (as proposed; 18.3A done — see below)

**Prerequisite hardening, small:** put the voice marker under the existing
voice rules.
- Forward `inputMode` from the integration and Google write tools as the
  services' `voice` flag.
- Refuse a CONFIRM, and `POST /pending-actions/:id/confirm`, for a spoken
  turn, with tests.

**Then, from catalog to capability, still read-only towards n8n:**
- read one workflow's structure on demand through the same service, sanitized
  — trigger type, the integrations its nodes use, its inputs; never
  parameters or credentials — and show it on the page and to the agent;
- let an owner or admin **propose** registering a library entry into the
  per-account trigger allow-list (`N8nWorkflow`) as an approval-gated
  action. The catalog stays an observation, and triggering stays
  `n8n.trigger`.

---

## Stage 18.3A — a spoken turn never confirms, enforced by the server

**Status: IMPLEMENTED, 2026-10-20 — uncommitted on `feat/automation-engine-phase-18`,
beside Stages 18.1 and 18.2; not deployed.** No workflow, message or external
write was touched.

### Root cause

`VOICE_APPROVAL_POLICY` (core, `types/voice.ts`) is a locked rule: voice may
**propose** an approval-gated action and never **confirm** one. Before this
stage only the voice client kept to it — it refuses to send a turn while an
approval is waiting. The server did not:

1. **The chat route confirmed a spoken "yes".** `detectIntent` reads "yes",
   "haan", "go ahead" as CONFIRM, and the route then:
   - confirmed the pending action and approved its approval;
   - ran the tool through `ToolExecutor`.

   It never asked whether the turn was spoken.
2. **A spoken "yes" reached the Google write service as not-voice.**
   `executeApprovedGoogleWrite` hard-coded `voice: false` for every caller,
   the chat route included. The service's own voice refusal could therefore
   never fire on that path.
3. **The services' `voice` flags were never set on the server.** The
   integration command service and the Google write service refuse a voice
   context, but no tool or route passed one. The integration tools, which
   reach `disconnect` (a token revoked at the provider), sent none.
4. **`ToolExecutor` spent an approved approval for any turn.** That covered an
   approval id carried over, or a cached approval for the same parameters.
5. **Two smaller gaps:**
   - The task path (a work request in chat) ran tools without the turn's mode.
   - The task allowlist, the union of every agent's tools, included
     `automation.library.sync` since Stage 18.2. So a spoken work request
     could start a library sync the 18.2 voice rule refuses elsewhere — a
     bypass of that stage's own rule, found here and closed.

### The boundary fixed

Between a spoken turn and an approved action being carried out: **no spoken
turn confirms, approves or spends an approval**, on any path. It is refused
before:
- the pending action or its approval changes;
- any write service, provider or tool runs;
- any mutation.

Asking stays open to voice: proposing, cancelling and changing a pending
action, and planning a Google write. Reads stay open where policy allows them.

### Trusted voice metadata — established once, carried everywhere

**Established** by the chat route, per turn, from the 18.2 server-side marker:
- the client's `inputMode: "voice"`, **or**
- the server's own memory of transcribing exactly this text for this account
  within two minutes (`RecentTranscripts`, fed by `POST /voice/transcribe`;
  hashes only).

A client's `"text"`, or no flag, never unmarks a recognised transcript, so a
client flag alone cannot establish that a turn is not voice. The mark is
decided for each turn from that turn alone. It is never stored on a pending
action or an approval, so it cannot be detached from its turn or replayed.

**Carried** on:
- `SessionContext.inputMode`;
- `ToolExecutionRequest.inputMode` — set by the orchestrator, by the chat
  route's CONFIRM path, and by the task path:
  `WorkTurnInput` → `TaskExecutionRequest` → executor;
- `ToolContext.inputMode`;
- into the integration command service as `IntegrationCommandContext.voice`,
  by the integration tools;
- into the Google write service as `WriteContext.voice`, by
  `executeApprovedGoogleWrite`, whose `voice` is now a required argument.

**The policy is one function:** `voiceConfirmationRefusal(inputMode)` in
`packages/core/src/voice-tool-policy.ts`. It reads `VOICE_APPROVAL_POLICY`
and is used by every layer below. There is no second voice-policy system.

### Where a spoken confirmation is refused

| Layer | Refuses | Before |
|---|---|---|
| Chat route (`routes/chat.ts`) | a spoken CONFIRM of any pending action — tool, Google write, memory | `confirmPendingAction`: nothing is approved or run; the action keeps waiting. Audited `chat.voice_confirmation_refused` (ids only) |
| `POST /api/v1/pending-actions/:id/confirm` | a confirmation whose body says `inputMode: "voice"` → `403 VOICE_NOT_ALLOWED`; an unknown mode → `400` | anything moves. Audited `pending_action.voice_confirmation_refused` |
| `ToolExecutor` | spending an approved approval for a spoken turn — with its id, or found by parameters → `permission_denied`, `VOICE_NOT_ALLOWED` | the approval is consumed and the tool runs. With no approval, a spoken turn still gets a pending one |
| Integration command service | `executeAction` (existing) and now `disconnect` when `voice` → `CONFIRMATION_REQUIRED` | a confirmation is issued or spent; anything is read, revoked or removed |
| Google write service | `execute` when `voice` (existing; now actually reachable) | the approval is read, consumed or the provider called |
| Task allowlist (`schedulableToolIds`) | tools on the voice list are not task tools | a scheduled run, which outlives the turn and its mode, could reach them |

The reply in every case is the fixed sentence
`VOICE_CONFIRMATION_REFUSED_MESSAGE`. The two exceptions keep their existing
format and words: the integration service (`CONFIRMATION_REQUIRED`, its
sentence) and the Google write service. No reply names a parameter, an
approval id or a recipient.

The endpoint is the **on-screen Confirm**, the one way a request made by voice
is committed. A confirmation that says nothing is a click.

### Files

| File | Change |
|---|---|
| `packages/core/src/voice-tool-policy.ts` | `voiceConfirmationRefusal`, `VOICE_CONFIRMATION_REFUSED_MESSAGE` |
| `packages/tools/src/executor.ts` | no approval spent for a spoken turn (byte pin moved, deliberately) |
| `packages/tools/src/tools/integration-tools.ts` | `voice` on the port context, passed for a spoken turn |
| `packages/agents/src/agent-policy.ts` | `schedulableToolIds` leaves out `VOICE_REFUSED_TOOLS` |
| `apps/api/src/routes/chat.ts` | the spoken-CONFIRM refusal; `voice` to the Google helper; `inputMode` to the task path; optional `auditLogger` dep |
| `apps/api/src/routes/pending-actions.ts` | the declared-voice refusal; `voice: false` to the Google helper |
| `apps/api/src/services/google/execute-approved-action.ts` | `voice` required and passed through |
| `apps/api/src/services/integrations/command-service.ts` | voice refusal on `disconnect` |
| `apps/api/src/services/tasks/task-conversation-service.ts`, `task-execution-service.ts` | `inputMode` carried to the executor |
| Tests | new: `apps/api/test/voice-confirmation-routes-p18.test.ts` (12), `apps/api/test/voice-confirmation-execution-p18.test.ts` (13); added: core slice +1, tools slice +3; changed deliberately: the executor pins (`mcp-boundaries-s8` in core and tools), the task allowlist pin (`mcp-policy-s8`), and `gmail-approval-execution` (the helper now forwards the caller's `voice` instead of always `false`) |
| Docs | `AGENTS.md`, `docs/INTEGRATIONS.md`, this file |

### Tests

| What | Where | Proves |
|---|---|---|
| Direct service calls | `voice-confirmation-execution-p18` (integration `disconnect`); existing `integration-write-security` (`executeAction`) and `google-write-approval` (Google `execute`) | each refuses a voice context before revoking, issuing or spending, or calling a provider |
| `ToolExecutor` | `voice-confirmation-execution-p18`; tools slice | a spoken turn's approval — by id or by parameters — is refused, the tool never runs, the approval is left `approved`; a spoken ask gets a pending approval; a typed turn runs |
| Orchestrator | `voice-confirmation-execution-p18` (the real `Orchestrator`, `AutomationAgent` and `ToolExecutor`; a cached approval) | a spoken turn ends at the refusal and the tool never runs; the same turn typed runs |
| Integration writes | `voice-confirmation-execution-p18`; tools slice | the tool passes `voice: true` for a spoken turn and nothing for a typed one; a spoken disconnect is refused directly, through the tool and through the executor, with nothing revoked, fetched or removed; the same approval confirmed on screen runs (against fakes) |
| Google writes | `voice-confirmation-routes-p18`; `gmail-approval-execution` | a spoken confirmation of a Google write never reaches the write service; typed and clicked ones reach it as `voice: false`; the helper forwards the caller's `voice` |
| The final confirmation endpoint | `voice-confirmation-routes-p18` | a declared-voice confirmation gets `403` with nothing moved; an unknown mode `400`; a click confirms and runs |
| Chat | `voice-confirmation-routes-p18` | a spoken "yes" — flagged, or recognised as the server's transcript despite `"text"` — moves nothing and is audited; voice can still cancel; a typed "yes" confirms and runs; another account's transcript marks nothing; a spoken work request reaches the task path with its mode |
| Task path | `voice-confirmation-execution-p18`; `mcp-policy-s8` | the mode reaches the executor, which refuses the approval; the typed request runs; the library sync is not a task tool |

All write paths in these tests are fakes: no provider, network, live message
or real write.

### Verification

2026-10-20, Windows, Node 24, on the working tree; turbo's cache bypassed with
`--force`. The database replay used a brand-new throwaway
`pgvector/pgvector:pg16` container, since removed. No provider, network,
workflow or live message was reached.

| Command | Result |
|---|---|
| Focused security suites (api: the two new files, `gmail-approval-execution`, `google-write-approval`, `integration-write-security`, `integration-command-parity`, 18.2's voice-route and tools files) | **179/179** (8 files) |
| CI slices: core / tools / agents (`automation-library`, plus `mcp-policy-s8`) | 25/25 · 11/11 · 14/14 |
| `pnpm build` / `typecheck` / `typecheck:tests` / `lint` | 20/20 · 37/37 · 20/20 · 20/20, none cached |
| `turbo run test --concurrency=1 --continue --force` (every workspace, no database) | **9,868 passed, 4 failed, 656 skipped**, 20 workspaces — the four below |
| CI's database steps, replayed | 34 migrations; `@jarvis/db` 422/422 (29 files), `@jarvis/memory` 93/93, `@jarvis/api` 239/239 (11), the evaluation 13/13; skip check 0 not run |

**The four failures, re-run individually, are not caused by this stage:**
- `verify-s8` (mcp, 1 of 8), `mcp-integration-s8` (api, 1 of 42) and
  `mcp-pilot-failures-s8` (api, 1 of 10) failed again alone. Each spawns a
  real stdio server, which is still starting when its 500 ms deadline fires.
  All three failed identically on an untouched checkout of `1fd1bb0` earlier
  the same day (Stage 18.2, Verification).
- `evidence-builder` (core) failed alone in 4 of 6 runs. Two back-to-back
  `new Date()` calls land in the same millisecond. This stage does not touch
  it.

**Mutation checks**, each restored byte for byte afterwards (SHA-256): **10/10
caught**.

| Control removed | Caught by |
|---|---|
| the executor's refusal to spend an approval for a spoken turn | 1 (tools) |
| the integration tools forwarding the turn's mode | 1 (tools) |
| the chat route's spoken-CONFIRM refusal | 3 (api) |
| the confirmation endpoint's declared-voice refusal | 1 (api) |
| the Google helper forwarding the caller's `voice` (back to `false`) | 1 (api) |
| the task run forwarding the mode to the executor | 1 (api) |
| the task conversation forwarding the mode | 1 (api) |
| the chat route forwarding the mode to the task path | 1 (api) |
| the voice-list tools kept out of task tools | 1 (agents) |
| the integration service's spoken-disconnect refusal | 2 (api) |

### Remaining limitations

- **The transcript memory is per process.** On several API instances a
  transcript made on one is not recognised on another. There a spoken turn is
  marked only by the client's flag, so a modified client that omits it could
  confirm a recognised-elsewhere "yes". The deployed stack runs one API
  instance. A cross-instance store (a keyed HMAC of the transcript in
  PostgreSQL) would close it. It was left out as an architectural change, and
  because persisting transcript hashes needs its own privacy review.
- **Altered words are typing, in effect.** A client that omits the flag and
  sends different words from the ones transcribed is not recognised.
- **Typed words identical to a recent transcript count as spoken** for two
  minutes. That only narrows: the person presses Confirm.
- **The confirmation endpoint trusts a click.** It refuses only a confirmation
  that says it was spoken. By design (`VOICE_APPROVAL_POLICY`) it is the
  on-screen way to commit. The Approvals page and `POST /google-writes/:id/execute`
  are on-screen paths too, unreachable from the voice pipeline, and unchanged.
- **A task scheduled by a spoken turn** runs later without that turn's mode.
  Tools speech may not start are excluded from tasks. An approval-gated tool
  in such a task runs only with an approval given on screen.
- **The integration `executeAction` command** is reached only from the
  Integrations page: no tool sends it. Its voice check remains as defence in
  depth.

### Next: Stage 18.3B (done — see below)

Workflow structure inspection and approval-gated trigger allow-list proposals,
as proposed above:
- read one workflow's structure on demand through `AutomationLibraryService`,
  sanitized — trigger type, node types and the integrations they use, inputs;
  never parameters, credentials, pinned or static data;
- show it on the Automations page and to the automation agent;
- let an owner or admin propose adding a library entry to the per-account
  trigger allow-list as an approval-gated action. It is confirmed on screen
  only — the 18.3A boundary applies to it — and never activates, edits or
  runs the workflow.

## Stage 18.3B — sanitized inspection, and approval-gated allow-list proposals

2026-10-21. Uncommitted, on `feat/automation-engine-phase-18`, on top of
Stages 18.1–18.3A.

### What it adds

- **Inspection.** One library entry's structure, sanitized on the server:
  its trigger kind, its node types and the integration categories they belong
  to, its version, and how current the catalog is. It is built from the stored
  catalog row alone, and n8n is not contacted. It is available on the
  Automations page and to the automation agent.
- **A proposal.** An owner or admin asks for one library workflow to be added
  to their own per-account trigger allow-list (`N8nWorkflow`) at its current
  version. The proposal is an approval in the existing approval store.
- **The change.** Once another owner or admin has approved the proposal, the
  requester adds it from the Automations page. The change is the page-only
  tool `automation.library.allowlist.add`, run by `ToolExecutor` with the
  approval named. It adds a row to the allow-list. It changes nothing in n8n,
  and nothing is triggered. Triggering stays `n8n.trigger`, which needs its own
  approval each time.

### Architecture inspected, and what was reused

| Need | Reused | Not added |
|---|---|---|
| Who may inspect, propose, apply | `AutomationLibraryService.authorize` → `SharedConnectionAccess` on `n8n/rest` (`shared:read` to inspect, `shared:write` to propose and apply, owners and admins) | a role check of its own, or `auth.role` |
| The catalog row | the 18.1 store, plus one read: `findEntry(scope, entryId)` by the existing unique key (catalog, external id) | a cache, a second table, or a stored workflow body |
| The proposal | the existing `Approval` (`approvalRepo.create`); the tool is in `SHARED_CONNECTION_TOOLS` as an n8n write, so the store sets `tenantId` from the owner record (Phase 17) | a proposal table or a second approval system |
| Its approval | the Approvals page's Organization review (`scope=review`, `decideApproval`): the requester cannot approve it, another owner or admin of the Organization can | an approve button of its own |
| Spending it | `consumeForExecution` with the Organization's scope (`sharedWriteScope(tenantId, n8n/rest)`) in the tool's journal step, as the memory and Meta write tools do | a check in application memory |
| Running it | `ToolExecutor` (the access gate, the 18.3A voice refusal, the approval's tool and parameter binding) | a direct service call from the route |
| The allow-list | `N8nWorkflow`, the per-account allow-list `n8n.trigger` already reads, with two nullable columns saying which library entry and version a row came from | a second allow-list |
| Audit | `automation_library.*` audit actions, as in 18.1/18.2 | — |

### Data flow and checks

```
Inspect   page / agent ──► route / automation.library.inspect (ToolExecutor)
                           └► service.inspect: authorize(read) → findEntry(scope)
                              → inspectLibraryEntry(row)   [pure, core]
                              → own allow-list rows + own latest proposal
                              → view (no n8n call)

Propose   page / agent ──► route / automation.library.allowlist.propose (ToolExecutor)
                           └► service.proposeAllowlist: authorize(write) → findEntry
                              → not stale, versionId known, a webhook trigger in the listing,
                                not already on the allow-list at this version
                              → the waiting proposal for exactly {entryId, versionId}? return it
                              → approvalRepo.create(automation.library.allowlist.add,
                                {entryId, versionId}, HIGH_IMPACT)  — tenantId from the owner record
                              → audit

Approve   Approvals page (another owner/admin) ──► decideApproval  [Phase 17, unchanged]

Apply     page only ──► POST …/allowlist-proposals/:approvalId/apply
                       └► LibraryAllowlistFlow: spoken? refuse · approval is this caller's,
                          for this tool and this entry · status approved (else a named refusal)
                          → ToolExecutor.execute(allowlist.add, approval.params, approvalId)
                            → access gate (shared:write) · voice refusal · approval binding
                            → tool: voice refusal · exactly {entryId, versionId} · approvalId present
                              → service.applyAllowlist: authorize(write) → findEntry
                                → not stale · catalog version = the proposal's
                                → ONE live read of the workflow, reduced at the n8n client
                                  to {versionId, enabled webhook nodes' path/method/auth}
                                → n8n's version = the proposal's · exactly one enabled webhook
                                  · a valid path · POST · authentication "none"
                                → consume(sharedWriteScope(tenantId, n8n/rest))
                                    = journal.begin + consumeForExecution (re-checks the
                                      Organization, the requester and the approver under locks)
                                → registerLibraryWorkflow (one transaction)
                                → audit, log
```

Every refusal before `consume` leaves the approval unspent. A proposal that
was refused because the version changed can be proposed again.

### Fields exposed, and fields excluded

The inspection is an explicit allowlist (`LibraryInspection`,
`LibraryInspectionView` in `packages/core/src/automation-inspection.ts`).
Anything not listed below is never returned.

| Field | From | How |
|---|---|---|
| `entryId` | the catalog row's external id | already validated at sync |
| `name` | the row's name | URLs and `www.` hosts replaced with "[link removed]" |
| `active`, `presence` | the row | as stored |
| `versionId` | the row | re-validated; null when it does not match the pattern |
| `observedAt`, `inspectedAt` | the row's last-seen time; now | — |
| `trigger` | node types | curated table of trigger node types → `webhook`, `schedule`, `manual`, `form`, `chat`, `sub_workflow`, `error_handler`, `email`, `n8n_event`, `app_event`. Status `derived`, `none_found` or `unavailable` (no node types stored) |
| `nodeTypes` | the row's node types | re-validated; an invalid one is dropped, never echoed; status `partial` when one was |
| `integrations` | node types | curated table → `messaging`, `email`, `spreadsheet`, `database`, `crm`, `storage`, `calendar`, `ai`, `http`, `code`, `logic`, `social`, `payments`, `project_management`; an unrecognized type is listed as unrecognized, never guessed |
| `inputs` | — | always `{available: false}`: input names live in node parameters, which are not read |
| `stale` | presence | missing or removed → stale, with a fixed sentence |
| `limitations` | — | fixed sentences saying what the view could not say |
| `allowlist`, `proposal`, `canPropose`, `proposeBlockedReason` | the caller's own allow-list rows and approvals | ids, statuses and fixed sentences |

**Never returned, stored, logged or audited:**
- node parameters and expressions;
- credentials or credential references, authorization headers, tokens, environment variables;
- URLs (including the instance's base URL);
- settings, static data, pinned data, connections;
- tags, the fingerprint;
- the workflow object itself.

The listing metadata the catalog stores (18.1) never contained them. The
inspection does not read n8n at all.

**The one live read, and why it is safe.** Adding a workflow to the
allow-list needs its webhook path: `n8n.trigger` posts to
`{base}/webhook/{path}`, and the catalog does not hold the path (it is a node
parameter). So, at apply time only, after the proposal was approved and every
other check passed, the service makes one read:
- `GET /api/v1/workflows/{id}`, the narrowest read n8n offers. The id is
  pattern-checked, so no request is made for an id that could leave the
  workflows path.
- `extractWorkflowTriggerTarget` (`packages/n8n/src/trigger-target.ts`)
  reduces the response inside the n8n client. It keeps `versionId` and, for
  each **enabled** `n8n-nodes-base.webhook` node: `path` through
  `validateWebhookPath` (the SSRF control `n8n.trigger` already uses, so
  expressions, URLs, traversal and authorities become null); `httpMethod` from
  a fixed set; and `authentication` from a fixed set (absent means n8n's
  default "none").
- Nothing else leaves the client. The reduced target is never returned to a
  caller, logged or audited. Its path is stored only in `N8nWorkflow`, where
  the allow-list already keeps paths.
- A failure is passed on as a code and a status, never n8n's words.

This is a deliberate security decision of this stage. The brief allowed it
"if a source read is required" and asked for the narrowest one, sanitized on
the server.

### Who may do what

| Action | Who | How it is decided |
|---|---|---|
| Inspect | owners, admins, members, viewers of the Organization that owns `n8n/rest` | `shared:read` |
| Propose | owners and admins | `shared:write`; `canPropose` says so in advance, and a start checks again |
| Approve | another owner or admin of that Organization | the Phase 17 store: the requester gets `self_approval_forbidden` |
| Apply | the requester, on screen | the approved approval, consumed with the Organization's scope |
| Anyone outside it, or before the connection is assigned | nobody | one "not available" answer, as for the rest of the library |

The agent gets `automation.library.inspect` and
`automation.library.allowlist.propose`. `automation.library.allowlist.add` is
on no agent's allowlist and refuses a call without an approval.

### A spoken confirmation can never apply it (18.3A)

Voice may propose. It can never apply, and is refused in four places:
1. **The apply flow** refuses a request that says it was spoken (`403
   VOICE_NOT_ALLOWED`, audited) before it looks at the approval.
2. **`ToolExecutor`** never spends an approval for a spoken turn.
3. **The tool** refuses a spoken context itself.
4. **The agent** does not hold the tool, so no chat turn reaches it.

The route accepts only `inputMode` "text" or "voice" (anything else gets
`400`). The approval itself is given on the Approvals page, which the voice
pipeline cannot reach.

### Lifecycle and audit

| Event | Audit action | Outcome recorded |
|---|---|---|
| Inspection | `automation_library.inspect` | success, or rejected with the authorization reason |
| Proposal created, or the waiting one returned | `automation_library.allowlist_propose` | success with `{entryId, versionId, approvalId, existing, tenantId}` |
| Proposal refused (role, stale, no webhook, already on the allow-list, store down) | `automation_library.allowlist_propose` | rejected or failure with a code |
| Approved or rejected | the Approvals page's existing audit | unchanged |
| Apply refused: spoken, rejected, expired | `automation_library.allowlist_apply` | rejected with the reason |
| Apply refused: version, webhook, approval, store | `automation_library.allowlist_apply` | rejected or failure with a code |
| Applied | `automation_library.allowlist_apply` + log `automation_library_allowlist_applied` | success with `{entryId, versionId, outcome}` |

Audit rows hold ids, versions, codes and outcomes. Never a path, a name, a
URL or anything n8n said.

**Retries.**
- **A repeated proposal** for the same entry and version returns the one
  waiting (`existing: true`, `200`).
- **A repeated apply** finds the approval consumed (`409 PROPOSAL_USED`).
- **Two applies at once**: the journal key `tool:approvalId` and the store's
  one-winner consume mean one change.
- **The allow-list write** is idempotent (`unchanged`) and never takes a
  path another row holds (`conflict`, refused).

### Data model (migration `20261021120000_phase18_library_allowlist_link`)

Additive: `N8nWorkflow` gains `library_entry_ref` (`<instance key>:<n8n id>`)
and `library_version_id`, both nullable, and an index on `(user_id,
library_entry_ref)`. Existing rows are untouched (null). A previous release
ignores the columns. Rolling back the code leaves them in place.

### API

All under `/api/v1/n8n/library`, all authenticated:

| Endpoint | Does |
|---|---|
| `GET /workflows/:entryId/inspection` | the sanitized view |
| `POST /workflows/:entryId/allowlist-proposals` | `201` a new proposal; `200` the one already waiting |
| `POST /workflows/:entryId/allowlist-proposals/:approvalId/apply` | applies an approved proposal; body `{inputMode?: "text" \| "voice"}` |

None accepts an Organization, a connection, a URL, a scope, a credential or a
workflow body.

### The Automations page

- **The Inspect button.** Each library row gets an Inspect button. It opens a
  panel showing the sanitized view only.
- **States.** The panel distinguishes:
  - loading;
  - unauthorized ("not available");
  - no longer in the library;
  - failed, with a retry;
  - stale;
  - unsupported metadata (shown as unknown);
  - inputs not available.
- **Badges.** One says whether the workflow is on the caller's allow-list (at
  this version, or another). A separate one gives the proposal's status
  (awaiting approval, approved, rejected, expired, used). A proposal is never
  worded as an applied change.
- **Propose for trigger allow-list.** Shown only when the server says
  `canPropose`. Otherwise its fixed reason is shown.
- **Add to trigger allow-list.** Shown only for an approved proposal that is
  not yet applied.
- **No other controls.** There is no edit, activate, run, trigger or publish
  control.

### Files

| File | Change |
|---|---|
| `packages/core/src/automation-inspection.ts` (new) | the inspection, its curated tables, the proposal contract, the ports |
| `packages/core/src/automation-library.ts`, `types/tenant.ts`, `index.ts` | tool ids, `findEntry`, port methods, `allowlist.add` as an n8n write |
| `packages/n8n/src/trigger-target.ts` (new), `api-client.ts`, `provider.ts`, `library-source.ts`, `index.ts` | the reduced one-workflow read |
| `packages/db/prisma/schema.prisma`, the migration, `n8n-repository.ts`, `automation-library-repository.ts` | the two columns; `registerLibraryWorkflow`, `findLibraryRegistrations`; `findEntry` |
| `packages/tools/src/tools/automation-library-tools.ts`, `index.ts` | the inspect, propose and add tools |
| `packages/agents/src/agent-policy.ts`, `agents/automation-agent.ts` | inspect and propose for the automation agent |
| `apps/api/src/services/automation-library/library-service.ts` | `inspect`, `proposeAllowlist`, `applyAllowlist` |
| `apps/api/src/services/automation-library/allowlist-flow.ts` (new) | the apply flow in front of the executor |
| `apps/api/src/services/approval-summary.ts` | what the approver is shown for a proposal |
| `apps/api/src/routes/automation-library.ts`, `services/container.ts` | the three endpoints; wiring |
| `apps/web/src/components/automations/workflow-inspection.tsx` (new), `workflow-library.tsx`, `lib/api.ts` | the panel; the Inspect column; the client |
| Tests | see below; pins moved deliberately for the two new agent tools (`mcp-policy-s8`, `sprint6-agent-architecture`, `sprint6-harness`, `sprint6-agent-wiring`, the 18.2 tools tests) |
| Docs | `AGENTS.md`, `docs/INTEGRATIONS.md`, `docs/DEPLOYMENT.md`, this file |

### Tests

| What | Where | Proves |
|---|---|---|
| Sanitization | core `automation-library-inspection-p18`; n8n `trigger-target-p18` | only the listed fields; links removed; bad node types dropped, not echoed; a workflow built to leak (tokens, passwords, headers, URLs, expressions, credentials, settings, static and pinned data, code) yields only the path, method and auth mode, validated, with nothing else in a result or an error; an id that could leave the path is never requested |
| Missing, stale, unsupported | core; api `automation-library-inspection-p18`; web | unavailable, never filled in; stale entries are not proposed |
| Cross-Organization, wrong connection | api | an outsider is refused; another instance's catalog has no such entry |
| Through `ToolExecutor` | api; tools `automation-library-allowlist-p18` | inspect and propose need only the platform's read and accept only the entry id; the add tool is on no agent and runs only with an approval |
| Unauthorized proposal and application | api; db `automation-library-allowlist-p18-pg` | members cannot propose or apply — the service refuses before n8n is read or anything consumed, behind the executor's gate; the requester cannot approve; a changed role, approver or Organization refuses |
| Binding | api; db | exactly `{entryId, versionId}`; a change in the library refuses before n8n is read, a change in n8n refuses after; an entry gone stale refuses; the approval is unspent in each case |
| What the approver sees | api | a fixed sentence from the two ids: what is added, that nothing in n8n changes or runs |
| Spoken confirmation | api; tools | refused by the flow, the executor and the tool; nothing consumed or added |
| Idempotency | api; tools; db | a repeated proposal returns the waiting one; a repeated or concurrent apply makes one row; concurrent registrations on two connections leave one row |
| Audit | api | each lifecycle event; no path, URL, name or n8n text in any audit row or log line |
| UI | web `workflow-inspection` | states; Propose only when the server allows it; a proposal is not worded as a change; no edit, activate, run, trigger or publish control |
| Never executes | api; web | the trigger tool beside them is never reached (`triggered` stays 0); the only n8n call is the one read of the workflow, made only by an apply; the page has no edit, activate, run, trigger or publish control. The n8n REST client sends only `GET` |

All of it uses fakes and synthetic workflows, except the PostgreSQL suite,
which uses a throwaway database. No n8n instance, messaging service or
network was reached.

### Verification

2026-10-21, Windows, Node 24, on the working tree. Turbo's cache was bypassed
with `--force`. The database runs used brand-new throwaway
`pgvector/pgvector:pg16` containers on ports 55436 and 55438, both since
removed. Docker Desktop had to be started for them, which also started the
`jarvis-docker-*` stack. That stack was left running and was not otherwise
touched. No n8n instance, provider, network, workflow or live message was
reached.

| Command | Result |
|---|---|
| Focused | api `automation-library-inspection-p18` 26/26 · n8n `trigger-target-p18` 8/8 · web `workflow-inspection` 14/14 · tools `automation-library-allowlist-p18` 9/9 · db `automation-library-allowlist-p18-pg` 6/6 |
| CI slices `automation-library`: core / tools / agents | 32/32 · 20/20 · 7/7 |
| `pnpm typecheck` / `typecheck:tests` / `lint` / `build` | 37/37 · 20/20 · 20/20 · 20/20, none cached |
| `turbo run test --concurrency=1 --continue --force` (every workspace, no database) | **9,932 passed, 4 failed, 662 skipped**, 20 workspaces — the four below |
| CI's database steps, replayed | 35 migrations; `@jarvis/db` 428/428 (30 files), `@jarvis/memory` 93/93, `@jarvis/api` 239/239 (11), the evaluation 13/13; skip check 0 not run |

**The four failures are the timing-sensitive tests named before.** They are
`verify-s8` (mcp), `mcp-integration-s8` and `mcp-pilot-failures-s8` (api),
and `evidence-builder` (core). This stage touches none of them. Re-run alone
the same day, all four passed (8/8, 52/52, and `evidence-builder` in 4 runs
of 4). Under the full sequential run they missed their deadlines, as after
Stages 18.2 and 18.3A.

**Mutation checks.** Each mutation was restored byte for byte afterwards
(SHA-256), and **all 18 were caught**.

The first run let three through: the catalog version check, the stale check
and the service's own role check at apply. Each was still refused later, by
the live version check or by the executor's gate and the store, so nothing
could be added. But the tests did not prove that the refusal came before n8n
was read. Three tests now prove it, and the re-run caught all three.

| Control removed | Caught by |
|---|---|
| links removed from the name | 1 (core) |
| stored node types re-validated | 1 (core) |
| the webhook path through `validateWebhookPath` | 1 (n8n) |
| disabled webhook nodes ignored | 2 (n8n) |
| the catalog version re-check at apply | 1 (api) |
| the live n8n version re-check | 1 (api) |
| webhook authentication must be "none" | 1 (api) |
| no allow-list write unless the approval was consumed | 2 (api) |
| the stale-entry refusal at apply | 1 (api) |
| a repeated proposal returns the waiting one | 2 (api) |
| `shared:write` to propose | 1 (api) |
| `shared:write` to apply, in the service | 1 (api) |
| the apply flow's spoken-confirmation refusal | 2 (api) |
| the add tool's spoken-turn refusal | 1 (tools) |
| the Organization's scope on the consume | 2 (tools) |
| the add tool kept off the automation agent | 1 (agents) |
| Propose shown only when the server allows it | 2 (web) |
| the allow-list writer refusing another row's path | 2 (db, PostgreSQL) |

### Known limitations

- **Input names are never available.** They live in node parameters, which
  are not read.
- **A disabled trigger is not visible in the inspection.** The listing does
  not say whether a node is disabled. The apply's read ignores disabled
  webhook nodes.
- **Classification covers the curated node types only.** Community and
  unlisted nodes are shown as unrecognized.
- **An independent approver is required.** An Organization with a single
  owner and no admin cannot complete a proposal. This follows Phase 17's rule
  for writes through a shared connection.
- **One 10-minute approval covers the whole proposal.** Proposal, approval
  and apply must all happen within it (`APPROVAL_TTL_MS`). After that, propose
  again.
- **Expiry has no event of its own.** It is recorded when an apply meets it.
  The approval store computes expiry when it is next read and has no
  sweeper.
- **Only a simple webhook can be added.** It must be exactly one enabled
  webhook, accept POST, and require no authentication, because `n8n.trigger`
  posts without credentials. Anything else is refused and explained: a
  method n8n left at its default, multiple methods, header auth, more than
  one webhook, or a path that is an expression.
- **The version is bound at apply, not at each trigger.** A workflow edited
  in n8n after it was added keeps its allow-list row. `n8n.trigger` still
  needs an approval each time and still validates the path.
- **The approver sees ids.** The Approvals page shows the workflow's id and
  version, not its name, because approval parameters are ids. The approver
  can inspect the entry on the Automations page.
- **A repeated proposal is matched among the requester's latest 100
  approvals.**
- **The read of n8n follows its documented workflow JSON**, against synthetic
  fixtures only. Those fields are `versionId`, `nodes[].type`,
  `nodes[].disabled`, and the webhook node's `parameters.path`, `httpMethod`
  and `authentication`. Anything unexpected is refused, never guessed.
- **Not run against a live n8n instance or the real stack.** By the brief's
  constraints.

### Next (Stage 18.4 followed — see below)

Stage 18.3B stops here, as the brief requires. Workflow customization and
execution are not started. Small follow-ups this stage leaves open:
- the workflow's name on the Approvals page, looked up on the server from the
  catalog;
- the cross-instance transcript store from 18.3A.

## Stage 18.4 — workflow matching and drafts

2026-10-21. Uncommitted, on `feat/automation-engine-phase-18`, on top of
Stages 18.1–18.3B.

### What it adds

- **Matching.** A request — a goal, and optionally its trigger, apps, inputs
  and outcome — is compared with the Organization's workflow library. The
  answer is one of:
  - `reuse` — an existing workflow appears to cover it;
  - `customize` — one could be adapted;
  - `no_match`;
  - `insufficient_evidence`.

  Each candidate comes with its reasons and its gaps.
- **Drafts.** A versioned, reviewable plan for a new workflow, or for a
  customization of a library workflow bound to its entry and version. A draft
  is kept in JARVIS. It is never sent to n8n and never becomes an approval or
  an allow-list row.
- **Both arms.** The Automations page's planning section and the automation
  agent's tools (`automation.workflow.match`, `automation.draft.create`,
  `.revise`, `.get`, `.list`) reach the one `AutomationPlanningService`.

### Architecture inspected, and what was reused

| Looked for | Found | Used |
|---|---|---|
| A workflow builder, draft model, validator or node-schema registry | None in the code. Phase 16 (`docs/phases/phase-16.md`) is a plan only. Its §6 boundaries (structured operations, pure diff and validation in core, write-once revisions, no writes through MCP) are followed here | its boundaries |
| n8n node schemas | None. No n8n package or node description is in the repository, and the instance was not asked (no live n8n contact in this stage). Phase 16's live check saw the n8n MCP server's 58 tool *names* only; JARVIS has no path to invoke them | the blocker below |
| Catalog search | `AutomationLibraryStore.listEntries` (name, tag and node-type search) | candidate retrieval, unchanged |
| Entry facts | `inspectLibraryEntry` (18.3B) | every candidate is judged on its sanitized inspection |
| Node vocabulary | the 18.3B tables (`TRIGGER_BY_TYPE`, `CATEGORY_BY_NAME`) | the services a request can name, and the draft node catalog's types |
| Authorization and scope | `AutomationLibraryService` → `SharedConnectionAccess` on `n8n/rest` | `resolveCatalog`, a public wrapper of the library's own check |
| Secret detection | `redactSecrets`' patterns | `containsSecret`, the same patterns plus credential shapes — detection only; `redactSecrets` unchanged |
| Hashing | `canonicalizeForHash` (approval params) | draft content hashes |
| Immutable rows | the `OutcomeRecord` immutability trigger | the same guard on `AutomationDraftVersion` |
| "Save" versus "plan" | the write-intent gate and the marketing calendar's precedent | drafting tools are `LOW_IMPACT`: "draft a workflow…" is answered, "create / save a draft…" saves |
| UI | `Panel`, `Badge`, `Button`, `DataTable`, the dashboard states, `WorkflowInspectionPanel` | the planning section and the draft panel |

### The blocker: configuration cannot be validated, so it is not drafted

The brief requires "validated node schemas and SDK-supported configuration
contracts only". JARVIS has neither. Getting them would need a reviewed read
of the instance's node type descriptions: through n8n's MCP tools, which JARVIS
cannot invoke, or an n8n endpoint this stage may not contact.

So a draft holds **no n8n parameter at all**. What each node needs is written
as a *setting*: a question with a plain answer, a credential reference, or a
value left for n8n. The configuration check reports **not run**, with that
reason, and a draft is never reported validated. This is the safe substitute
the brief asks for, and the documented blocker on anything more.

### Matching

Deterministic and explainable (`packages/core/src/automation-planning.ts`).

**Reading the request.** The trigger, apps and categories are read from the
goal's own words, by closed English word lists:
- a named service (Slack, Gmail, Google Sheets…) maps to its base-package
  node type;
- category words (messages, email, spreadsheet, CRM…) are used only when no
  named app covers them.

What is stated wins over what the words suggest, and a conflict is noted.
When the words point two ways, or nowhere, the request asks instead
(`openQuestions`). An unrecognized app is noted, never used.

**What the request may carry.** Links and n8n expressions are taken out of
it. Text shaped like a secret refuses the whole request; it is never stored,
even redacted. A scope field (organization, instance, URL…) is refused, as in
every library request.

**Retrieval.** Through the library store's own listing:
- a catalog of up to 500 workflows is compared in full;
- a larger one is searched by the request's node names, trigger and purpose
  words — at most 6 searches of 100 each — and the answer says it was not a
  full comparison.

**Criteria**, each with a status the reader can check against the
inspection:

| Criterion | Status | Weight |
|---|---|---|
| Trigger | match · mismatch · unknown · not requested | 35 |
| Apps | full · partial · none · unknown · not requested | 35 |
| Shared purpose words | shared · none · not comparable | 20 |
| Metadata | complete · incomplete (node types, version, last complete scan) | 10 |

The score orders the candidates; it is not a probability.

**Shared words count only if they are about purpose.** Words that only name a
trigger or an app are left out of the comparison: "a support form" and "a
lead form" share "form", which says nothing about what either does. This was
found by the stage's own API tests.

**Fit:**
- **reuse** — trigger and apps fully covered (or not asked), purpose words
  not contradicted, node types known, and seen in the last complete scan;
- **customize** — some apps covered, or the trigger matching *and* purpose
  words shared;
- nothing else is offered.

A stale entry, or one whose listing carried no node types, is never
recommended. When every compared entry lacks node types, or the request has
nothing to compare, the answer is `insufficient_evidence`.

**What may be repeated back.** Explanations are fixed sentences over the
criteria, and they quote only the requester's own words. Tags are compared
but never echoed, and names have their links removed.

**No duplicates.** A new draft is refused with `REUSE_AVAILABLE`, naming the
workflow, while the library appears to cover the request. Only an explicit
`overrideReuse` drafts one anyway; it is offered on the page as "anyway" and
recorded in the audit row.

### Drafts

**Representation** (`packages/core/src/automation-draft.ts`):
- `content` holds the kind, the title, the request (sanitized), the source
  (customization only: entry, version, name, node types, node count), open
  questions and their answers, notes, nodes and connections;
- a **node** is a key, a type from the draft catalog, a label, its origin
  (`added`, or `source`: "the source workflow's node of this type"), `remove`,
  and settings;
- a **setting** is a key and a label, plus one of three kinds:
  - `value` — answered here, in plain words;
  - `credential` — configured in n8n, never with a value here;
  - `in_n8n` — left for n8n, for example a URL.

**The draft node catalog** — 28 documented n8n base-package types, with the
fixed main inputs and outputs their descriptions declare:
- triggers: webhook, form, schedule, manual, IMAP email, error, called by
  another workflow;
- apps: Slack, Discord, Telegram, Teams, Gmail, SMTP, Outlook, Google Sheets,
  Airtable, Postgres, MySQL, HubSpot, Notion, Google Calendar, Google Drive,
  HTTP request;
- logic: Edit fields, Filter, Wait, No-op, and If (true and false outputs).

**Not in it, on purpose:**

| Left out | Why |
|---|---|
| Switch, Merge, error outputs | their ports depend on configuration |
| AI and LangChain nodes | they connect through sub-node ports |
| Code, Execute Command | their content is a program |
| app triggers | they need event configuration |
| any community node | none is documented in JARVIS |

A service node gets its credential as a reference automatically.

**Customizations.** The catalog holds the source's node types, not its graph.
So a customization refers to "the source's node of type X":
- at most once per type;
- only types the source has;
- when the source's node count exceeds its distinct types, the draft asks
  *which* node is meant;
- new steps attach to the source's trigger as a new branch.

**Skeleton.** Without nodes, the server builds only what the request implies:
the trigger, if it maps to exactly one catalog node, then the named apps
chained in order. Nothing is guessed. An app the catalog cannot hold becomes a
note ("plan that step in n8n").

**Versioning.**
- A draft is a series of versions, each with the SHA-256 of its canonical
  content.
- A revision names its `baseVersion` and is stored as the next version, only
  while that is still the latest: ONE conditional `UPDATE` of
  `latest_version`, then the insert, in one transaction.
- A revision of an older version gets `409 DRAFT_CHANGED`.
- The same revision retried is answered with the version already stored, and
  so is a request whose content is unchanged.
- Earlier versions stay readable.
- PostgreSQL refuses any `UPDATE` of a stored version (the trigger in
  `20261021180000_phase18_automation_drafts`). The one exception is the
  foreign key's own `SET NULL` when an author's account is deleted.
- The same create request twice is one draft: a create key hashes the
  author and the first content, unique per catalog.

**Who.** The catalog's Organization, through the library's check:

| Action | Who |
|---|---|
| Match, list and read drafts | members and viewers (`shared:read`) |
| Create and revise | owners and admins (`shared:write`) |

Anyone outside the Organization, or on another instance, is refused or sees
nothing. Drafts are scoped by Organization, provider and instance.

**Staleness.** A view reads the source entry again:
- changed version, missing from the last scan, removed, or not found →
  `stale`;
- a stale draft cannot be revised (`409 DRAFT_STALE`), checked before any
  change is applied.

### Validation

Every check reports passed, failed, pending (needs input) or not run, with
its reason. It runs at creation, at revision, and again on every view, so a
stored row is never taken on trust:

| Check | What it covers |
|---|---|
| `node_types` | catalog types only; source references only to the source's types |
| `graph` | unique keys, existing endpoints, valid outputs, no self-loop, no duplicate edge, no cycle, every step reached from a trigger (or from the source) |
| `triggers` | nothing connects into a trigger; something still starts the workflow |
| `safety` | no secret, n8n expression or link stored anywhere in the draft |
| `credentials` | references only; a value is refused |
| `requirements` | pending while a question, a value setting or a structural need is open |
| `configuration_schema` | **not run**: no schema |
| `source_graph` | customization: **not run** — the source's connections are unknown |
| `source_version` | customization: the source is still at the bound version |
| `scope` | read inside the caller's Organization and instance |

The statuses add up to `invalid`, `stale`, `needs_input`, `unverified` or
`validated`. `validated` needs every check passed, so in this stage the best
status is `unverified`, shown as "Structure checked — not validated against
n8n's node schemas".

An invalid proposal is refused (`422 DRAFT_INVALID` or `SECRET_REFUSED`) with
every issue and where it is. It is never stored.

### Agent integration

- **The grant.** The automation agent holds the five tools. No other agent
  does, and none is approval-gated (none acts outside JARVIS).
- **Inputs.** The tools take only the request's own fields and the draft's
  own fields. Organization, instance and version come from the server. A
  caller cannot set a version number, a hash or a status.
- **Speech.** Voice may ask for a match or a draft: a proposal, as `AGENTS.md`
  allows. Nothing in planning confirms anything.
- **The prompt.** It says:
  - match first;
  - never guess an app;
  - save a draft only when asked;
  - put no parameter, secret or URL in a draft;
  - never call a draft validated or deployed.

### API

Under `/api/v1/n8n/planning`, authenticated, attempts counted per account:

| Endpoint | Does |
|---|---|
| `POST /match` | rank the library against a request |
| `GET /drafts` | the Organization's drafts |
| `POST /drafts` | `201` a new draft; `200` the same draft again |
| `GET /drafts/:draftId?version=N` | a version, re-checked |
| `POST /drafts/:draftId/versions` | `201` a new version; `200` when unchanged |

None reaches n8n, and none deploys, activates, runs, publishes or edits a
workflow.

### The Automations page

- **What is named.** The four things a reader must not confuse: catalog
  entry, workflow on the trigger allow-list, draft, live workflow.
- **The request.** A goal, an optional trigger, apps and outcome.
- **The answer.** Its own badge and explanation, the open questions, and each
  candidate's reasons (✓) and gaps (–), with Inspect.
- **Its states.** "No suitable workflow found", "Not enough to compare",
  unauthorized, failed and loading are each their own state.
- **Drafting controls.** "Draft a customization", "Start a new draft" and
  "Draft a new workflow anyway" appear only when the server says
  `canDraft`.
- **The draft panel:**
  - "Draft — not in n8n", the status, and the version's number and hash;
  - the source and its drift;
  - the diff (triggers, steps, connections with If's branch, configuration);
  - the checks, including those not run;
  - questions and settings, with inputs for values only — a credential reads
    "configure in n8n";
  - "Save as version N+1";
  - refusals with every issue;
  - the version history, an earlier version read-only.
- **No other controls.** There is no deploy, activate, run, execute, publish
  or live-edit control.

### Files

| File | Change |
|---|---|
| `packages/core/src/automation-planning.ts`, `automation-draft.ts`, `automation-vocabulary.ts`, `automation-planning-view.ts` (new) | matching, drafts, vocabulary, the browser-safe entry `@jarvis/core/automation-planning` |
| `packages/core/src/automation-inspection.ts`, `utils/redact-secrets.ts`, `capability-catalog.ts`, `capability-presentation.ts`, `index.ts`, `package.json` | `stripLinks`; `containsSecret`; labels and the productivity skill; exports |
| `packages/db/prisma/schema.prisma`, migration `20261021180000_phase18_automation_drafts`, `repositories/automation-draft-repository.ts` (new), `index.ts` | two tables, the immutability trigger, the store |
| `apps/api/src/services/automation-library/planning-service.ts` (new), `library-service.ts` (`resolveCatalog`), `routes/automation-planning.ts` (new), `services/container.ts`, `index.ts` | the one service, its router, wiring |
| `packages/tools/src/tools/automation-planning-tools.ts` (new), `index.ts` | the five tools |
| `packages/agents/src/agent-policy.ts`, `agents/automation-agent.ts` | the grant and the prompt |
| `apps/web/src/components/automations/workflow-planner.tsx`, `workflow-draft.tsx` (new), `app/automations/page.tsx`, `lib/api.ts` | the planning section and the draft panel |
| Tests | new: core `automation-library-planning-p18`, `automation-library-drafts-p18`; tools `automation-library-planning-p18`; agents `automation-library-planning-p18`; api `automation-library-planning-p18` (+ `helpers/memory-drafts.ts`); web `workflow-planner`; db `automation-draft-p18-pg` |
| Pins moved deliberately | the automation agent's allowlist (`sprint6-agent-architecture`, `mcp-policy-s8` 18 → 23, `sprint6-harness`), the skill census source list, the API's registered tools (`sprint6-agent-wiring`) |
| Docs | `AGENTS.md`, `docs/INTEGRATIONS.md`, `docs/DEPLOYMENT.md`, `docs/DEVELOPMENT.md`, this file; `.github/workflows/ci.yml` comments |

### Tests

| What | Where | Proves |
|---|---|---|
| Ranking and explainability | core planning; api | the criteria, their statuses and sentences; reuse before customize; deterministic order; purpose words only; a trigger alone is not a candidate |
| No match, incomplete metadata | core planning; api; web | `no_match` and `insufficient_evidence` as their own answers; workflows without node types never recommended, and named in the limitations |
| Reuse versus new | api; web | `REUSE_AVAILABLE` names the workflow and stores nothing; `overrideReuse` drafts anyway; a customization binds the candidate |
| Immutability and binding | core drafts; api; db | hashes; answers applied to a copy; a revision appends; v1 unchanged and readable; older-base revision refused; retry and concurrent revisions give one version; PostgreSQL refuses an UPDATE; stale source refuses revision |
| Invalid configuration | core drafts; api | unsupported types (Code), n8n fields, duplicates, disconnected nodes, invalid edges, cycles, trigger inputs, missing triggers, source references outside the source |
| Organization isolation | api; db | members read, owners and admins draft; outsiders refused; another Organization or instance finds nothing |
| Secrets and hostile input | core; api | secrets, expressions, links and credential values refused everywhere; nothing secret in drafts, audit rows or logs; goal and answers never in audit rows |
| Voice and approvals | tools; agents; api | voice may ask; nothing is approval-gated; no approval row is created; the allow-list change stays on no agent; "draft…" is planning, "create/save a draft…" is an instruction |
| Never touches a live workflow | api | no n8n read beyond the catalog's own sync, the trigger never reached; the service is built with no n8n client |

### Verification

2026-10-21, Windows, Node 24, on the working tree. Turbo's cache was bypassed
with `--force`.

The database runs used brand-new throwaway `pgvector/pgvector:pg16`
containers, since removed. The `jarvis-docker-*` stack, running since Docker
Desktop was started for Stage 18.3B, was not touched.

No n8n instance, provider, network, workflow or message was reached.

| Command | Result |
|---|---|
| Focused | core planning 17/17 and drafts 16/16 · tools 6/6 · agents 4/4 · api 17/17 · web 16/16 · db `automation-draft-p18-pg` 6/6 |
| CI slices `automation-library`: core / tools / agents | 65/65 · 26/26 · 11/11 |
| `pnpm typecheck` / `typecheck:tests` / `lint` / `build` | 37/37 · 20/20 · 20/20 · 20/20, none cached |
| `turbo run test --concurrency=1 --continue --force` (every workspace, no database) | **10,009 passed, 3 failed, 668 skipped**, 20 workspaces |
| CI's database steps, replayed | 36 migrations; `@jarvis/db` 434/434 (31 files), `@jarvis/memory` 93/93, `@jarvis/api` 239/239 (11), the evaluation 13/13; skip check 0 not run |

**The three failures are the MCP timeout tests named before:** `verify-s8`
(mcp), `mcp-integration-s8` and `mcp-pilot-failures-s8` (api). Re-run alone
the same day, they failed again. This is as Stage 18.2 recorded, when they
failed alone and on an untouched checkout of `1fd1bb0`. Each starts a real
stdio server that is still starting when its 500 ms deadline fires. This
stage changes neither `packages/mcp` nor the MCP routes.

**Mutation checks.** Each mutation was restored byte for byte afterwards
(SHA-256), and **all 23 were caught**.

The first run caught 20. Two survived; one did not run:
- **The service's write check on revise.** The tests proved members cannot
  create a draft, not that they cannot revise one. A test now does.
- **The conditional `UPDATE`'s version condition.** The unique (draft,
  version) key backstopped every case tested. A revision claiming a base the
  draft never reached would have been stored at a gap; a PostgreSQL test now
  proves it is refused.
- **The status-label mutation.** The harness read its list without UTF-8, so
  the anchor did not match.

All three were caught on the re-run.

| Control removed | Caught by |
|---|---|
| Code kept out of the draft node catalog | 1 (core) |
| n8n definition fields refused by name | 1 (core) |
| secrets refused in draft text | 2 (core) |
| expressions refused in draft text | 1 (core) |
| a credential never takes a value | 1 (core) |
| the configuration check reported not run | 1 (core) |
| cycles refused | 1 (core) |
| disconnected steps refused | 1 (core) |
| source version drift detected | 1 (core) |
| only purpose words shared | 3 (core) |
| stale entries never recommended | 3 (core) |
| a trigger alone is not a candidate | 1 (core) |
| a covered request refused a new draft | 1 (api) |
| `shared:write` to create | 1 (api) |
| `shared:write` to revise | 1 (api) |
| staleness checked before a revision is applied | 1 (api) |
| a retried revision answered with the stored version | 1 (api) |
| a revision only from the latest version | 1 (db, PostgreSQL) |
| the immutability trigger | 1 (db, PostgreSQL) |
| drafts scoped by Organization and instance | 1 (db, PostgreSQL) |
| drafting controls only when the server allows | 1 (web) |
| "unverified" never shown as validated | 1 (web) |
| a credential never given an input | 1 (web) |

### Known limitations

- **Configuration is not validated, and cannot be here.** JARVIS has no n8n
  node schemas. A draft carries no parameters, its configuration check never
  runs, and no draft can reach `validated` in this stage.
- **A small node vocabulary.** It has 28 types, chosen because their ports
  are fixed. These are refused, and their steps go into notes "to plan in
  n8n":
  - Switch, Merge and error outputs;
  - AI and LangChain nodes;
  - Code and Execute Command;
  - app triggers;
  - community nodes.
- **A customization cannot see its source's graph.** It refers to the
  source's nodes by type and asks which one when a type may repeat. The
  effect on existing paths is not checked (`source_graph` not run).
- **Matching is keyword-based.**
  - English word lists and a closed list of apps, so synonyms outside them
    are missed.
  - Names and tags are what authors typed.
  - Input names cannot be read from a goal; they must be stated.
  - A catalog over 500 workflows is searched by the request's words, not
    compared in full, and the answer says so.
- **How current a candidate is depends on the last sync.** A candidate is
  only as current as the last library synchronization; matching never reads
  n8n.
- **The thresholds are heuristics.** Reuse, customize and the score are
  explained, but they are heuristics. A wrong refusal of a new draft is
  overridden with `overrideReuse`, which is audited.
- **A graph revision replaces the whole graph.** Answers on settings must be
  carried over by whoever proposes it; the server does not merge.
- **Drafts are permanent and shared.** There is no delete or archive, and
  every owner or admin of the Organization may revise any of its drafts.
- **Saving needs an explicit instruction.** By the write-intent gate, "draft
  a workflow…" is answered rather than saved; the user says "create" or
  "save".

### Next: Stage 18.5 (proposed, not started)

**A reviewed source of node schemas** for the draft catalog's types:
- a pinned, reviewed snapshot of their n8n node descriptions in the
  repository, or a reviewed read-only n8n MCP tool added to `MCP_MANIFEST`;
- so that settings can become validated parameters, and
  `configuration_schema` can run.

Then, possibly, **compiling a validated draft into an n8n workflow
definition for a person to review and import**: still no deployment.

Creating, activating or running a workflow in n8n stays out of scope until it
has its own approval-gated design (Phase 16 §5, §6.8). Stage 18.4 stops here.
