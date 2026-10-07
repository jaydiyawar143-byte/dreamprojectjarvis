# JARVIS Architecture

How the system is built today. Verified against the code on 2026-10-05, commit `68628c0`; the Phase 13 parts — durable confirmations, health, the operational log and error monitor, deployment — on 2026-10-06.

- For the marketing-intelligence pipeline (analysis → recommendation → approval → outcome) and its phase-by-phase history, see [JARVIS_ARCHITECTURE.md](./JARVIS_ARCHITECTURE.md).
- The superseded first architecture document is kept at [archive/ARCHITECTURE_LEGACY_2026-08.md](./archive/ARCHITECTURE_LEGACY_2026-08.md). It describes Fastify and Redis; neither is used.

---

## In one paragraph

JARVIS is a pnpm + Turborepo monorepo of 19 workspaces: 2 apps and 17 packages. A Next.js dashboard (`apps/web`) talks only to an Express + Socket.IO API (`apps/api`). The API hands each chat turn to an orchestrator (`packages/agents`), which recalls relevant memories and documents and routes the turn to a domain agent. Agents act only through tools (`packages/tools`), and tools reach the outside world only through ports that one package per provider implements. Everything that changes state outside JARVIS passes a single execution authority, `ToolExecutor`, and is gated, journalled and audited on the way. PostgreSQL with pgvector stores users, conversations, memory, documents, approvals and the execution journal.

## Where things live

| Concept | Home | Notes |
|---|---|---|
| Web UI | `apps/web` | Next.js 14 App Router, 21 pages, Zustand stores, customisable widget grid |
| HTTP and realtime API | `apps/api` | 26 routers under `/api/v1` ([API.md](./API.md)); Socket.IO; wiring in `src/services/container.ts` |
| Contracts | `packages/core` | Types, Zod schemas and pure utilities. No I/O. Named "core", but it is **not** the brain |
| The brain | `packages/agents` | `orchestrator.ts`, `agent-router.ts`, `tool-planner.ts`, `intent-detector.ts`, `agent-policy.ts`, `agents/` |
| What JARVIS can do | agents + tool allowlists | [SKILLS.md](./SKILLS.md) |
| Memory and documents | `packages/memory`; storage in `packages/db/src/repositories` | [MEMORY.md](./MEMORY.md) |
| Tools | `packages/tools` | Registry, `ToolExecutor`, execution journal, output sanitiser, `AnalysisGenerator` — the shared on-demand account analysis service behind both `POST /api/v1/analysis` and the `meta.analyze` tool |
| Provider integrations | `packages/ai-openai`, `ai-elevenlabs`, `meta-graph`, `google-ads`, `google-workspace`, `whatsapp`, `n8n`, `browser`, `mcp` | One package per provider. `ai-anthropic` exists but is not wired. `mcp` is the MCP runtime and the only home of the MCP SDK ([its README](../packages/mcp/README.md)) |
| Widget data | `apps/api/src/services/providers` | Weather, markets, geo, system monitor — used only by the API |
| Database | `packages/db` | Prisma schema (28 models), 28 migrations, repositories, the single `PrismaClient` |
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
   ├─ memory:    embed the message, recall this user's relevant memories
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
   any non-read-only call the user did not ask for (audited, never executed)
   ▼
ToolExecutor — packages/tools
   validate → agent allowlist + role permission → approval gate → single deadline → journal → audit
   ▼
Tool → port → provider package → provider API
   ▼
Result, with secrets stripped → agent → reply to the browser
   └─ afterwards: extract durable memories from the turn
```

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
- `MemoryEngine` is tested and not used at runtime.
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
