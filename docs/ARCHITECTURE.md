# JARVIS Architecture

How the system is built today. Verified against the code on 2026-09-14.

- For the marketing-intelligence pipeline (analysis → recommendation → approval → outcome) and its phase-by-phase history, see [JARVIS_ARCHITECTURE.md](./JARVIS_ARCHITECTURE.md).
- The superseded first architecture document is kept at [archive/ARCHITECTURE_LEGACY_2026-08.md](./archive/ARCHITECTURE_LEGACY_2026-08.md). It describes Fastify and Redis; neither is used.

---

## In one paragraph

JARVIS is a pnpm + Turborepo monorepo of 18 workspaces. A Next.js dashboard (`apps/web`) talks only to an Express + Socket.IO API (`apps/api`). The API hands each chat turn to an orchestrator (`packages/agents`), which recalls relevant memories and documents and routes the turn to a domain agent. Agents act only through tools (`packages/tools`), and tools reach the outside world only through ports that one package per provider implements. Everything that changes state outside JARVIS passes a single execution authority, `ToolExecutor`, and is gated, journalled and audited on the way. PostgreSQL with pgvector stores users, conversations, memory, documents, approvals and the execution journal.

## Where things live

| Concept | Home | Notes |
|---|---|---|
| Web UI | `apps/web` | Next.js 14 App Router, 21 pages, Zustand stores, customisable widget grid |
| HTTP and realtime API | `apps/api` | 24 routers under `/api/v1` ([API.md](./API.md)); Socket.IO; wiring in `src/services/container.ts` |
| Contracts | `packages/core` | Types, Zod schemas and pure utilities. No I/O. Named "core", but it is **not** the brain |
| The brain | `packages/agents` | `orchestrator.ts`, `agent-router.ts`, `tool-planner.ts`, `intent-detector.ts`, `agent-policy.ts`, `agents/` |
| What JARVIS can do | agents + tool allowlists | [SKILLS.md](./SKILLS.md) |
| Memory and documents | `packages/memory`; storage in `packages/db/src/repositories` | [MEMORY.md](./MEMORY.md) |
| Tools | `packages/tools` | Registry, `ToolExecutor`, execution journal, output sanitiser |
| Provider integrations | `packages/ai-openai`, `ai-elevenlabs`, `meta-graph`, `google-ads`, `google-workspace`, `whatsapp`, `n8n`, `browser` | One package per provider. `ai-anthropic` exists but is not wired |
| Widget data | `apps/api/src/services/providers` | Weather, markets, geo, system monitor — used only by the API |
| Database | `packages/db` | Prisma schema, 23 migrations, repositories, the single `PrismaClient` |
| Security | `packages/security` | scrypt passwords, JWT, AES-256-GCM encryption, RBAC, approvals, audit |
| Configuration | `packages/config` | Plus a `config.ts` in each integration package ([DEVELOPMENT.md](./DEVELOPMENT.md)) |
| Generic utilities | `packages/core/src/utils` | Parameter hashing, secret redaction, identifier masking |
| Tests | `test/` in each workspace | |

## Dependency rules

A workspace can import only what its `package.json` declares, so these arrows are enforced rather than advised:

```
core, config                              depend on nothing
security, tools, n8n, whatsapp            → core
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
apps/api — auth middleware → chat router
   ▼
Orchestrator — packages/agents
   ├─ memory:    embed the message, recall this user's relevant memories
   ├─ knowledge: retrieve matching passages from the user's documents
   └─ route:     choose a registered domain agent
   ▼
Domain agent → model (OpenAI) → tool calls, limited to the agent's allowlist
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
| Confirmation | `apps/api/src/services/integrations/confirmations.ts` | Process memory, deliberately — persisting it would create a replayable permit | 2 minutes, single use | user, integration, action, parameters |
| Approval | `packages/security`, `Approval` table | PostgreSQL | 10 minutes, consumed atomically with the execution claim | user, tool, parameters |

- Both gates hash parameters with the same canonical function, `computeParamsHash` in `packages/core`, which sorts keys at every depth.
- The integration command service **gates** an action and hands it to `ToolExecutor`, which **executes** it. Nothing calls a provider write directly. `AGENTS.md` sets out the rules.
- Google write tools only **plan**: they create an approval row. The write runs when a person approves that row.
- A voice session cannot confirm a write.

## Identity

- Email and password (scrypt), or Google sign-in.
- A short-lived JWT access token in the `Authorization` header is the only source of identity. A user id in a body or path is never trusted.
- Refresh tokens rotate on use and are stored hashed. A browser may opt into an HttpOnly, `SameSite=Lax` refresh cookie by sending `X-Auth-Mode: cookie`.
- HTTP and Socket.IO verify through the same `TokenService.verifyAccessToken`.

## Observability

- Every request carries an id (`middleware/request-id.ts`) and produces one access-log line in morgan's combined layout, with credential-bearing query values redacted (`middleware/access-log.ts`).
- Every tool execution is journalled (`ToolExecution`) and audited (`AuditLog`).
- `/api/v1/health`, `/live` and `/ready` report lifecycle state truthfully during shutdown.

## Deployment

One Docker image (`node:20-alpine`, runs as the `node` user) serves both the API and the web app. `docker-compose.yml` runs PostgreSQL with pgvector, the API and the web app on ports 5433, 3101 and 3100, so a local development stack on 5432, 3001 and 3000 can run beside it with its own database. The API applies migrations when it starts. A CI workflow, `.github/workflows/ci.yml`, is defined but has not yet run on GitHub — see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Known gaps

- `@jarvis/ai-anthropic` is built and not wired.
- `MemoryEngine` is tested and not used at runtime.
- Five tool classes are tested but never registered — including `data.csv.analyze`, which two agents are granted. See [SKILLS.md](./SKILLS.md).
- CI has not run on GitHub yet, and it does not cover the Postgres-backed tests, `typecheck:tests` (ledger R-18), the other workspaces' tests, or secret scanning — [DEVELOPMENT.md](./DEVELOPMENT.md).
- Without `OPENAI_API_KEY` a development API runs with chat switched off: every message answers 503 `AI_PROVIDER_NOT_CONFIGURED`, while `GET /api/v1/agents` still lists the agents. Production refuses to start without the key — ledger R-21.
- An agent stays in service after every classified provider failure — a missing, rejected or unauthorised key, an unknown model, a timeout, a rate limit, a 5xx, an open circuit, an exceeded context window or a cancelled call. Only an unexpected error still leaves it in `error` until the process restarts; a plain request then answers 500 `AGENT_ERROR` instead of being handed to another agent — ledger R-24, R-30.
- Every agent calls the provider chain `FallbackAIProvider` (`packages/core/src/provider-fallback.ts`), which today holds OpenAI only; no fallback provider is wired (D-3). A provider that fails permanently is skipped for 5 minutes and then probed by one request; while no provider is usable, chat answers 503 `AI_PROVIDER_UNAVAILABLE` with the original code in `details.cause` — ledger R-30.
- The OpenAI adapter retries transient failures within a bounded policy (`packages/core/src/provider-retry.ts`) and refuses calls for 30 seconds after 5 consecutive transient failures (`provider-circuit-breaker.ts`). The circuit is in memory, one per adapter, so one per process and shared by every user — ledger R-26, R-27.
- The conversation history sent to the model is never trimmed or summarised. A conversation that outgrows the context window answers 413 `CONTEXT_LENGTH_EXCEEDED` until the user starts a new one — ledger R-25.
- `@jarvis/ai-anthropic` classifies its failures under the same contract and has adapter-level tests, but is still not wired (D-3) — ledger R-28.
- A provider failure reaches the browser with a fixed message for its category, never the provider's own text. The provider's status, type, code, request id and redacted text are logged as `ai_provider_error`, and `details.cause` is passed on only when it is an error code — ledger R-31. The orchestrator does not rewrite messages, so any provider added later must classify through the same contract (`packages/core/src/provider-error-safety.ts`).
