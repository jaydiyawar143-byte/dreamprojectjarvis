# JARVIS Architecture

How the system is built today. Verified against the code on 2026-10-05, commit `68628c0`; the Phase 13 parts — durable confirmations, health, the operational log and error monitor, deployment — on 2026-10-06; the Phase 14 parts — project-scoped memory, the memory API and screen, correction and retention — on 2026-10-08; the Phase 15 parts — the marketing workspace — on 2026-10-12.

- For the marketing-intelligence pipeline (analysis → recommendation → approval → outcome) and its phase-by-phase history, see [JARVIS_ARCHITECTURE.md](./JARVIS_ARCHITECTURE.md).
- The superseded first architecture document is kept at [archive/ARCHITECTURE_LEGACY_2026-08.md](./archive/ARCHITECTURE_LEGACY_2026-08.md). It describes Fastify and Redis; neither is used.

---

## In one paragraph

JARVIS is a pnpm + Turborepo monorepo of 19 workspaces: 2 apps and 17 packages. A Next.js dashboard (`apps/web`) talks only to an Express + Socket.IO API (`apps/api`). The API hands each chat turn to an orchestrator (`packages/agents`), which recalls relevant memories and documents and routes the turn to a domain agent. Agents act only through tools (`packages/tools`), and tools reach the outside world only through ports that one package per provider implements. Everything that changes state outside JARVIS passes a single execution authority, `ToolExecutor`, and is gated, journalled and audited on the way. PostgreSQL with pgvector stores users, conversations, memory, documents, approvals and the execution journal.

## Where things live

| Concept | Home | Notes |
|---|---|---|
| Web UI | `apps/web` | Next.js 14 App Router, 23 pages, Zustand stores, customisable widget grid |
| HTTP and realtime API | `apps/api` | 28 routers under `/api/v1` ([API.md](./API.md)); Socket.IO; wiring in `src/services/container.ts` |
| Contracts | `packages/core` | Types, Zod schemas and pure utilities. No I/O. Named "core", but it is **not** the brain |
| The brain | `packages/agents` | `orchestrator.ts`, `agent-router.ts`, `tool-planner.ts`, `intent-detector.ts`, `agent-policy.ts`, `agents/` |
| What JARVIS can do | agents + tool allowlists | [SKILLS.md](./SKILLS.md) |
| Memory and documents | `packages/memory`; storage in `packages/db/src/repositories` | [MEMORY.md](./MEMORY.md) |
| Marketing workspace | `apps/api/src/services/marketing` (the one implementation); rules in `packages/core`; storage in `packages/db/src/repositories/marketing-repository.ts` | Campaigns, content calendar, page research, reports, recommendations, approval-gated publishing — [MARKETING.md](./MARKETING.md) |
| Tools | `packages/tools` | Registry, `ToolExecutor`, execution journal, output sanitiser, `AnalysisGenerator` — the shared on-demand account analysis service behind both `POST /api/v1/analysis` and the `meta.analyze` tool |
| Provider integrations | `packages/ai-openai`, `ai-elevenlabs`, `meta-graph`, `google-ads`, `google-workspace`, `whatsapp`, `n8n`, `browser`, `mcp` | One package per provider. `ai-anthropic` exists but is not wired. `mcp` is the MCP runtime and the only home of the MCP SDK ([its README](../packages/mcp/README.md)) |
| Widget data | `apps/api/src/services/providers` | Weather, markets, geo, system monitor — used only by the API |
| Database | `packages/db` | Prisma schema (33 models), 30 migrations, repositories, the single `PrismaClient` |
| Operational log and error monitor | `apps/api/src/services/observability` | One of each per process; see Observability below |
| Security | `packages/security` | scrypt passwords, JWT, AES-256-GCM encryption, RBAC, approvals, audit |
| Configuration | `packages/config` | Plus a `config.ts` in each integration package ([DEVELOPMENT.md](./DEVELOPMENT.md)) |
| Generic utilities | `packages/core/src/utils` | Parameter hashing, secret redaction, identifier masking |
| Tests | `test/` in each workspace | |

## Dependency rules

A workspace can import only what its `package.json` declares, so these arrows are enforced rather than advised:

```
core, config                              depend on nothing
security, tools, n8n, whatsapp, mcp       → core
ai-openai, ai-anthropic, ai-elevenlabs    → core
db                                        → core, security
agents, meta-graph, google-ads            → core, tools
google-workspace                          → core, google-ads
memory                                    → core, db, ai-openai
browser                                   → core, memory
web                                       → core
api                                       → every package except ai-anthropic
```

The arrow that matters most is the one that is missing: `packages/tools` cannot import the database, an HTTP client or a provider SDK. A tool therefore has no way to perform a write that skips the executor.

## A chat turn, end to end

```
Browser — apps/web
   │  POST /api/v1/chat   Authorization: Bearer <access token>
   ▼
apps/api — auth middleware → chat router, which answers here, in order:
   a reply to a pending action → a memory command → a work request (the Task Engine)
   ▼  anything else — including a turn about the conversation itself, and a work
   │  request no tool can carry out, which the Task Engine hands back
Orchestrator — packages/agents
   ├─ memory:    embed the message, recall this user's relevant memories —
   │             personal ones, plus those of the conversation's own project
   ├─ knowledge: retrieve matching passages from the user's documents
   ├─ skills:    which of this agent's skills work right now
   └─ route:     choose a registered domain agent
   ▼
Domain agent → model (OpenAI) → tool calls, limited to the agent's allowlist
   the model is sent, in order: the agent's prompt · the conversation so far ·
   what the orchestrator gathered above, as a system message of its own ·
   the user's message exactly as typed
   ▼
Orchestrator — the allowlist is checked again; the write-intent gate refuses
   any non-read-only call the user did not ask for (audited, never executed);
   an approval-gated call from a role that could not run it is refused before
   any pending action is created (Phase 15); a call to a tool the server named
   as switched off is answered `unavailable`, with the server's reason, before
   the executor is asked — no execution, approval or pending action (Phase 15)
   ▼
ToolExecutor — packages/tools
   validate → agent allowlist + role permission → approval gate → single deadline → journal → audit
   ▼
Tool → port → provider package → provider API
   ▼
Result, with secrets stripped → agent → reply to the browser
   └─ afterwards: extract durable memories from the turn, into the
                  conversation's project (or as personal memories)
```

## Memory

One chain, described in [MEMORY.md](./MEMORY.md). What holds across all of it:

- **One writer, one deleter.** `MemoryExtractionService` (`packages/memory`) is the only code that creates or changes a memory — extraction after a reply, and a confirmed correction. `MemoryManagementService` is the only code that deletes one, and it is reached only through the memory tools, which `ToolExecutor` runs. `packages/memory/test/memory-architecture-p14.test.ts` fails if a second path appears.
- **Scope.** A memory is personal or belongs to one project of its owner (`Memory.projectId`). The active project is a property of the **conversation**, fixed when it is created from one of the user's own projects, and read from the conversation row on every turn. Every scope filter is written beside the user filter; the database itself refuses a memory in a project its user does not own.
- **Recall is ranked by one score** — `0.70 × similarity + 0.10 × recency + 0.10 × confidence + 0.10 × importance`, in `packages/core/src/memory-relevance.ts` — after a similarity floor that no other signal can lift a memory over.
- **The orchestrator reads memory; it cannot write it.** It is typed against a read-only port, and agents are handed no memory store at all. An agent's only memory tool is the read-only `memory.list`.
- **The user's controls** — list, forget, correct, veto, pause — are reachable from chat and from the memory API (`/api/v1/memories`) and screen (`/memory`), through the same service. Forgetting and correcting are pending actions the user confirms; there is no endpoint that deletes or edits a memory.
- **Retention.** A learned memory expires 90 days after the user last stated it and is hidden at once; a bounded sweep, started by the API after it is listening, purges rows 30 days after expiry through the `memory.purge_expired` tool.

## The marketing workspace

Added in Phase 15; the contract is [MARKETING.md](./MARKETING.md). What holds across all of it:

- **One implementation, two ways in.** `MarketingService` (`apps/api/src/services/marketing`) is the only place a marketing rule lives. The `marketing.*` tools hold it as their port, and the Marketing page's router runs those same tools through `ToolExecutor` — one endpoint, one tool. A sentence and a button pass one permission check, one approval gate and one audit row.
- **It holds no provider and no credential.** A report reads the ad account by running the registered `meta.*` **read** tools through the executor, as a `viewer`. A page is read only through `PublicPageFetcher` (`packages/browser`), which judges every hop and pins the connection to the address it judged. A post goes out only through a `ContentPublisher` — today one: a Facebook Page publisher in `packages/meta-graph`.
- **Three registrations, three conditions.** The workspace tools always register (they reach only the database). The two page reads register only while `BROWSER_ENABLED=true`. The two publish tools register only when a publisher could be built. What is not registered is offered to no model and has no control on the screen.
- **Published means read back.** A publish is approval-gated and bound to the exact text and Page; the approval is consumed in the step that claims the execution; the item is claimed by one conditional `UPDATE`; and the item is recorded as published only after the post was read from the provider by its id. A sent post whose outcome is unknown is its own state, and the next attempt looks for it before sending anything.
- **Nothing is reported that was not read.** Reports and audits are pure functions in `packages/core` over rows that were read; no model writes them. A source that could not be read is listed as unread. Google Ads is recorded as a source and never read.
- **Scope beside ownership.** A row is its owner's, and optionally one of their projects'. In a conversation the project is the conversation's own.

## Writes that leave JARVIS

Two gates stand in front of one execution authority.

| Gate | Code | State | Lifetime | Bound to |
|---|---|---|---|---|
| Confirmation | `apps/api/src/services/integrations/confirmations.ts`, `Confirmation` table | PostgreSQL — a SHA-256 of the token and a hash of the parameters, never the token or anything the user typed | 2 minutes, single use, spent by one conditional `UPDATE` | user, integration, action, parameters |
| Approval | `packages/security`, `Approval` table | PostgreSQL | 10 minutes, consumed atomically with the execution claim | user, tool, parameters |

- A confirmation is durable since Phase 13. It used to be a Map in one process, kept out of the database so that it could not become a stored, replayable permit — at the cost that a restart lost a pending confirmation and a second API instance could not honour it. The table answers that objection rather than ignoring it: it holds no token to replay, spending is atomic so one of any number of presenters wins, and the two-minute lifetime is unchanged.
- With no confirmation store wired, or with the store unreachable, an external write is refused. Nothing falls back to process memory.
- Both gates hash parameters with the same canonical function, `computeParamsHash` in `packages/core`, which sorts keys at every depth.
- The integration command service **gates** an action and hands it to `ToolExecutor`, which **executes** it. Nothing calls a provider write directly. `AGENTS.md` sets out the rules.
- Google write tools only **plan**: they create an approval row. The write runs when a person approves that row.
- A marketing publish (`marketing.content.publish`) is the third kind of external write. Its approval carries the exact text and Page; the tool consumes it in the step that claims the execution; and the service checks the saved item against it again before sending. It exists only where `MARKETING_PUBLISH_ENABLED=true`. A publish whose outcome is not known is never followed by a second send: a retry only looks for the earlier post, and sending again takes a person's recorded decision. The approval's parameters say which of the two it is for — a send, or a look at one named earlier attempt — and the claim is taken only from that state, so an approval to look can never send. One post is one item's post, and a person's decision to clear an attempt is one transaction with its audit row. See [MARKETING.md](./MARKETING.md#5-publishing).
- Marketing work that reaches outside JARVIS without an approval — a page read, a report's reads of the ad account, a publish check — reserves a slot first, atomically, in the audit table (`AtomicRateLimiter` over `PrismaAuditRepository.reserveSlot`). The older `DbBackedRateLimiter` counts and leaves the row to its caller; it is not used for these.
- A voice session cannot confirm a write.

## Work tasks and scheduling

Work JARVIS is asked to carry out is a `Task` row, separate from the user's own to-do list.

```
chat ("check this site at 9am") or /api/v1/tasks
   ▼
Task — PostgreSQL; `scheduledAt` holds a one-time schedule
   ▼
task-scheduler-loop — claims a due task once (durable claim; abandoned claims are recovered)
   ▼
TaskPlannerService — proposes ONE tool call, from the registry, limited to the schedulable
   ▼                 tools: every agent's allowlist except the MCP group
TaskExecutionService → ToolExecutor, as the user who asked
```

- The plan is made when the task runs, not when it is scheduled, so every check runs on the actual run.
- From chat, a `Task` is recorded only for work a tool can carry out. A request nothing can carry out is answered by the assistant instead, which — unlike the planner — sees the conversation. A request with an explicit time is always answered by the Task Engine, so that a stated time can never turn into "run it now".
- An approval-gated tool is not run unattended: the task fails with a message to approve it on the Approvals page.
- Scheduling is one-time only. There is no recurrence, cron or automatic retry, and a failed task is final.
- The outcome worker (`apps/api/src/services/outcome-worker-scheduler.ts`) is the other background loop.

## MCP tools

MCP servers are outside code that JARVIS can call, kept at arm's length ([packages/mcp/README.md](../packages/mcp/README.md)):

```
MCP_MANIFEST — packages/core; every reviewed server, its tools pinned by fingerprint
   ▼  only while JARVIS_MCP_ENABLED=true
registerMcpTools — one McpConnection per server; one registry entry per tool, mcp.<server>.<tool>
   ▼
agent policy — the general assistant's grant, derived from the manifest; never schedulable
   ▼
ToolExecutor — permission (read + execute: owner, admin), deadline, the ordinary audit row
   ▼
McpConnection — packages/mcp; starts the server on first use and verifies it against the review
   ▼
the reviewed stdio server — packages/mcp/pilot: `dates` and `units`, read-only
```

- A server's live listing never registers or describes anything; one that differs from its review fails closed.
- Each server has its own connection, process and breaker, so one failing never touches another.
- There is no MCP-specific execution path, approval or audit.

## Identity

- Email and password (scrypt), or Google sign-in.
- A short-lived JWT access token in the `Authorization` header is the only source of identity. A user id in a body or path is never trusted.
- Refresh tokens rotate on use and are stored hashed. A browser may opt into an HttpOnly, `SameSite=Lax` refresh cookie by sending `X-Auth-Mode: cookie`.
- HTTP and Socket.IO verify through the same `TokenService.verifyAccessToken`.

## Observability

- Every request carries an id (`middleware/request-id.ts`) and produces one access-log line in morgan's combined layout, with credential-bearing query values redacted (`middleware/access-log.ts`).
- Every tool execution is journalled (`ToolExecution`) and audited (`AuditLog`).
- `/api/v1/health`, `/live` and `/ready` report lifecycle state truthfully during shutdown. The web app answers `/healthz` for itself. What each one means to a monitor is in [DEPLOYMENT.md](./DEPLOYMENT.md).
- Operational events — start-up, shutdown, a failed request, a confirmation — are one JSON line each, written through `apps/api/src/services/observability/operational-log.ts`: a timestamp, the service and component, the event, and the audit system's redaction applied before the line leaves the process.
- An error nobody handled is reported to the error monitor, `apps/api/src/services/observability/error-monitor.ts`: a request that threw and was answered `5xx`, an unhandled rejection, an integration command that failed in a way nothing expected (an unreachable confirmation store among them), a failed shutdown step. Where a report goes is a sink. The one that ships writes a `monitor_exception` log line, so nothing depends on a monitoring service; a hosted one would be another sink behind the same interface.

## Deployment

One Docker image (`node:24-alpine`, runs as the `node` user) serves both the API and the web app. `docker-compose.yml` runs PostgreSQL with pgvector, the API and the web app on ports 5433, 3101 and 3100, so a local development stack on 5432, 3001 and 3000 can run beside it with its own database. The API applies migrations when it starts. All three containers have a health check, and Docker gives the API 40 seconds to stop — longer than the 30-second grace period the API gives work that is already running, so that grace period is real. Shutdown always finishes: open requests get what is left of the grace period and are then closed. How to deploy, verify and roll back is in [DEPLOYMENT.md](./DEPLOYMENT.md). CI, `.github/workflows/ci.yml`, runs on GitHub on every push to `main` and on every pull request — see [DEVELOPMENT.md](./DEVELOPMENT.md). Every tracked text file is stored and checked out with LF (`.gitattributes`), so a source snippet spanning a line break and a Prisma migration checksum mean the same thing on every platform — ledger R-20.

## Known gaps

- `@jarvis/ai-anthropic` is built and not wired.
- Marketing, after Phase 15: JARVIS can publish only a text post (with an optional link) to a Facebook Page; Instagram, LinkedIn, X and the rest can be planned for and not published to. Google Ads figures are in no report — no Google connection carries the Ads scope and no developer token is configured. SEO research reads what a page says about itself: there is no keyword-volume, ranking, traffic or backlink data, because no provider of them is integrated. A client report is a downloaded HTML or Markdown file; nothing sends it. Nothing publishes on a date: the calendar is a plan. See [MARKETING.md](./MARKETING.md) and [phases/phase-15.md](./phases/phase-15.md).
- `MemoryEngine` is tested and not used at runtime.
- Memory, after Phase 14: project *state* is still not learned (only the user's own durable statements are, in whichever project they were made); a reworded restatement replaces a memory instead of adding to its evidence; a contradiction replaces without keeping the old wording; memory content is stored as plain text; there is no vector index; and a project cannot be renamed or deleted. See [MEMORY.md](./MEMORY.md#known-limitations).
- The structured operational log covers start-up, shutdown, failed requests, confirmations, the two background loops and error reports. Everything else still writes its own JSON line without a timestamp, and the request log is text.
- No hosted error monitor is configured. Reports are `monitor_exception` log lines until a sink for one is added.
- The per-IP rate limiter and the provider circuit breaker are still per process. Confirmations no longer are.
- Five tool classes are tested but never registered — including `data.csv.analyze`, which two agents are granted. See [SKILLS.md](./SKILLS.md).
- CI does not run the other workspaces' tests, secret scanning or dependency audits, and `typecheck:tests` exists only in `apps/api`. Merges into `main` do wait for it: the active GitHub ruleset "Protect main" requires a pull request whose CI check has passed on an up-to-date branch — [DEVELOPMENT.md](./DEVELOPMENT.md).
- Without `OPENAI_API_KEY` a development API runs with chat switched off: every message answers 503 `AI_PROVIDER_NOT_CONFIGURED`, while `GET /api/v1/agents` still lists the agents. Production refuses to start without the key — ledger R-21.
- An agent stays in service after every classified provider failure — a missing, rejected or unauthorised key, an unknown model, a timeout, a rate limit, a 5xx, an open circuit, an exceeded context window or a cancelled call. Only an unexpected error still leaves it in `error` until the process restarts; a plain request then answers 500 `AGENT_ERROR` instead of being handed to another agent — ledger R-24, R-30.
- Every agent calls the provider chain `FallbackAIProvider` (`packages/core/src/provider-fallback.ts`), which today holds OpenAI only; no fallback provider is wired (D-3). A provider that fails permanently is skipped for 5 minutes and then probed by one request; while no provider is usable, chat answers 503 `AI_PROVIDER_UNAVAILABLE` with the original code in `details.cause` — ledger R-30.
- The OpenAI adapter retries transient failures within a bounded policy (`packages/core/src/provider-retry.ts`) and refuses calls for 30 seconds after 5 consecutive transient failures (`provider-circuit-breaker.ts`). The circuit is in memory, one per adapter, so one per process and shared by every user — ledger R-26, R-27.
- The conversation history sent to the model is never trimmed or summarised. A conversation that outgrows the context window answers 413 `CONTEXT_LENGTH_EXCEEDED` until the user starts a new one — ledger R-25.
- `@jarvis/ai-anthropic` classifies its failures under the same contract and has adapter-level tests, but is still not wired (D-3) — ledger R-28.
- Outcome records are created at runtime, but only after an advertising write has already succeeded: `RecommendationExecutionService` (`packages/tools/src/recommendation-bridge.ts`) builds the baseline from the recommendation's own evidence snapshot — a genuine pre-action baseline, never a second provider call — and a missing required counter or a failed persistence is audited and swallowed, never surfaced as anything but `EXECUTED` (ledger R-32). `measureOutcome` carries `diagnosisCategory` onto the record it builds, so category-based historical matching sees real values. The worker re-measures existing records on a background interval: `startOutcomeWorkerSweep` (`apps/api/src/services/outcome-worker-scheduler.ts`) calls `OutcomeWorker.processDue` after the server is listening, with an overlap guard, lifecycle tracking so a drain waits for the in-flight sweep, an immediate first sweep for stale lease recovery, and a tunable interval (`JARVIS_OUTCOME_WORKER_INTERVAL_MS`, `0` disables it).
- A provider failure reaches the browser with a fixed message for its category, never the provider's own text. The provider's status, type, code, request id and redacted text are logged as `ai_provider_error`, and `details.cause` is passed on only when it is an error code — ledger R-31. The orchestrator does not rewrite messages, so any provider added later must classify through the same contract (`packages/core/src/provider-error-safety.ts`).
