# Working in this repository

Instructions for any agent or contributor changing this codebase.

---

## The integration rule

> **Every integration must support both JARVIS command control and manual
> frontend control through the same backend integration service.**

This is not a style preference. It is the rule that keeps the two ways of
operating JARVIS honest with each other, and it has a specific consequence:

**There is exactly one place where an integration operation is implemented:**
[`apps/api/src/services/integrations/command-service.ts`](apps/api/src/services/integrations/command-service.ts).

```
  Frontend button ──┐
                    ├──► IntegrationCommandService.execute() ──► provider
  JARVIS command  ──┘
```

- The REST router ([`apps/api/src/routes/integrations.ts`](apps/api/src/routes/integrations.ts))
  translates HTTP into an `IntegrationCommandInput` and calls the service.
- The JARVIS tools ([`packages/tools/src/tools/integration-tools.ts`](packages/tools/src/tools/integration-tools.ts))
  translate a sentence into the same `IntegrationCommandInput` and call the
  same service, through `IntegrationCommandPort`.
- Both receive the same `IntegrationCommandResult`.

**Why it is enforced this way.** Permission checks, rate limits, audit rows and
write confirmations all live inside the command service. A second path — a
"quick" endpoint for the dashboard, or a tool that calls a provider directly —
would be a path on which those checks are absent, and it would be absent
*silently*. The single shared instance is what makes the guarantee structural
instead of aspirational.

`apps/api/test/integration-command-parity.test.ts` asserts it by instrumenting
one service instance and proving both arms arrive at it.

### What this forbids

| Do not | Instead |
|---|---|
| Add provider logic (HTTP, scopes, keys) to a JARVIS tool | Add it to the command service; the tool forwards a command |
| Add a validation check to the REST router | Add it to the command service, so the voice path gets it too |
| Call a provider API from the frontend | Call the backend endpoint; secrets stay server-side |
| Add a frontend-only field to the integration view | There is one `IntegrationView` type in `@jarvis/core` |
| Execute a provider write outside `ToolExecutor` | The command service *gates*; `ToolExecutor` *executes* |

### Adding a new integration

1. Add its descriptor to `INTEGRATION_CATALOG` in
   [`packages/core/src/integration-catalog.ts`](packages/core/src/integration-catalog.ts)
   — id, fields, actions, supported commands, environment variables.
2. Add its id to `INTEGRATION_IDS` in
   [`packages/core/src/types/integration.ts`](packages/core/src/types/integration.ts).
3. Add its connection test to `runCheck` in
   [`apps/api/src/services/integration-registry.ts`](apps/api/src/services/integration-registry.ts).
   The test must be a **read** that really reaches the provider.
4. Add any provider-specific branches to the command service handlers.

You do **not** write a new route, a new tool, or a new frontend control. All
three are generic and pick the integration up from the catalogue.

---

## Other standing rules

### Status must be observed, never assumed

`CONNECTED` is only ever the result of a real provider call that succeeded.
Credentials being present makes an integration *configured*, not connected —
that state is `UNVERIFIED` and the UI renders it as "Not checked". Never
collapse `connection` (is it set up?) into `health` (does it work?).

### Secrets

- Stored encrypted at rest (`EncryptionService`, AES-256-GCM envelopes).
- Never returned to a client — not even to the operator who typed them. A
  stored secret comes back as `hasValue` plus a fixed mask, never a prefix.
- Never logged, and never placed in an audit row or an error message.
- The encryption key lives only in
  [`apps/api/src/services/integrations/build.ts`](apps/api/src/services/integrations/build.ts);
  the command service receives a `CredentialPort` and has no key at all.

### External writes

Anything that changes state outside JARVIS follows:

```
Plan → Explain → Confirm → Execute → Audit → Verify → Report
```

- The confirmation token is bound to `(user, integration, action, params-hash)`,
  so a confirmation for one campaign cannot be replayed against another.
- It is single-use and expires in two minutes.
- It is stored in PostgreSQL (`Confirmation`), as a SHA-256 of the token — never
  the token, a parameter or the summary — so it survives a restart and is shared
  by every API instance. Spending it is ONE conditional `UPDATE`. Never read it,
  check it in application memory and then write: two requests would both pass
  the check.
- If the confirmation store is missing or cannot be reached, the write is
  refused. There is no in-memory fallback, and none may be added.
- **A voice session cannot confirm a write at all.** Speech is a fine way to ask
  for one and not a fine way to authorize one.
- **A pending action is answered by its id.** `POST /api/v1/pending-actions/:id/confirm`,
  `/reject` and `/modify` act only when `:id` is the action waiting in that
  conversation. Any other id — replaced, used, expired, unknown — gets `409
  PENDING_ACTION_MISMATCH` (or `404` when nothing waits) and changes nothing, so
  a screen still showing an older request can never answer a newer one. A
  memory action can never be modified.
- **One answer wins.** Confirming, cancelling or changing a pending action is
  ONE conditional `UPDATE` in PostgreSQL (`decideApproval`, `fromPendingOnly`)
  that applies only while the action is still waiting. Of two answers that
  arrive together — two tabs, two API instances — exactly one wins; the other
  gets `409 PENDING_ACTION_ALREADY_RESOLVED` and changes nothing. A cancelled
  action can never be approved, so it never runs. Never resolve an approval
  with a read followed by an unconditional write.

### Google scopes

Progressive, always. `scopesForConnect()` cannot produce a write scope — there
is no argument to it that could. Write access is only ever added through
`scopesForWriteUpgrade()`, a separate call at a separate site, driven by an
explicit user decision. Never request every Google scope at initial login.

Authorization decisions read **granted** scopes, never requested ones: Google
may grant fewer than were asked for.

### Memory

The contract is in [`docs/MEMORY.md`](docs/MEMORY.md); these are the parts a
change must not break. `packages/memory/test/memory-architecture-p14.test.ts`
fails when one of the first three does.

- **One writer.** Only `MemoryExtractionService` creates or changes a memory —
  extraction after a reply, and a confirmed correction. Never add a tool, a
  route or a service method that writes one. The L1–L4 learning contracts in
  `packages/core` have that one consumer, and their tests pin it.
- **One way to delete.** `MemoryManagementService`, reached only through the
  memory tools, which `ToolExecutor` runs. Forgetting and correcting are
  HIGH_IMPACT pending actions the user confirms; no route deletes or edits a
  memory, and none may be added.
- **Agents hold no memory store.** `AgentContext` carries none and the
  orchestrator is typed against a read-only port. An agent's only memory tool
  is `memory.list`. `memory.forget`, `memory.forget_all`, `memory.correct` and
  `memory.purge_expired` stay on no agent's allowlist.
- **Scope beside ownership.** A memory is personal or belongs to one project of
  its owner. Every project filter is written beside the user filter, never
  instead of it. The active project is the conversation's, read from the
  conversation row — never from a request body after the conversation exists.
- **Parameters are ids, never memory text.** A pending action, an approval and
  an audit row hold ids, versions and counts. The words stay in the message.
- **The controls fail closed.** Unreadable or corrupt controls: nothing is
  learned and nothing is recalled. Recall reads them through `recallControl`,
  which refuses a corrupt document; a valid pause stops learning only.
- **Retention deletes only what the policy says** (`MEMORY_RETENTION` in
  `packages/core`): bounded, one user at a time, through `memory.purge_expired`.

### Marketing

The contract is in [`docs/MARKETING.md`](docs/MARKETING.md); these are the
parts a change must not break.

- **One implementation.** Marketing behaviour lives in `MarketingService`
  (`apps/api/src/services/marketing`). The `marketing.*` tools hold it as their
  port, and the Marketing page's router runs those same tools through
  `ToolExecutor` — one endpoint, one tool. Never put a marketing rule in a route
  or a tool, and never add an endpoint that reaches the service or the
  repository around the executor.
- **Published means read back.** An item is recorded `VERIFIED` only after the
  post was read from the provider by its id. Never from a provider's
  "accepted", a status code or a timeout. `REPORTED_BY_USER` is a different
  thing and is never upgraded to it, or worded like it.
- **An unknown outcome is a state, not a failure to retry.** A publish that was
  sent and not confirmed leaves the item `UNCONFIRMED` and unpublished. The
  next attempt looks for the post before it sends anything, and posts nothing
  if it cannot look.
- **The text of a post comes from the saved item.** No endpoint accepts it. A
  publish whose text is not exactly the saved text is refused, even after a
  person approved it.
- **Publishing is approval-gated by the exact text and Page**, and the item is
  claimed by ONE conditional `UPDATE` (`claimForPublish`). Never read the
  publish state, check it in memory and then write. No path may publish
  without an approval, and nothing publishes because a date arrived.
- **Nothing is reported that was not read.** Reports, audits and
  recommendations are pure functions in `packages/core` over rows that were
  read; no model writes them. A source that could not be read is listed as
  unread and contributes no figure. Never estimate a metric, a keyword, a
  ranking or a competitor's numbers.
- **Google Ads stays out of marketing reports** until a grant carrying the Ads
  scope exists and a read against it has been verified. A report records
  whether it could have been read — from the **granted** scopes — and why not.
- **A page a user names is read only through `PublicPageFetcher`**
  (`packages/browser`), which judges every hop and pins the connection to the
  address it judged. Page research registers only while `BROWSER_ENABLED=true`.
- **Scope beside ownership**, as for memory. In a conversation the project is
  the conversation's; a `projectId` in the parameters that names another is
  refused, never obeyed.
- **A recommendation is advice.** Each carries `executed: false`. Never add a
  tool, a route or a button that carries one out.

### Operational logs and errors

- An operational event — start-up, shutdown, a failed request, anything a
  deployment is followed by — is written through the operational log in
  `apps/api/src/services/observability`, not with a bare `console.log`. It adds
  the timestamp, the service and component, and the audit system's redaction.
- An error nobody handled is reported to the error monitor in the same folder.
  Its context is identifiers — a component, an operation, a trace id — never a
  token, a password, a header or a payload.
- Neither may throw, delay a request, or become something the application needs
  in order to run. No monitoring vendor is called from a route, a service or a
  tool; a hosted monitor is a sink given to `createErrorMonitor`.

### Deployment

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) is the runbook: deploy, verify,
  roll back. A change that alters how the stack is deployed, stopped or checked
  updates it in the same change.
- Migrations only go forward and are additive wherever possible, so that a
  previous release can start against a newer database. Rolling back never
  undoes a migration.
- Every service in `docker-compose.yml` has a health check, and the API's
  `stop_grace_period` stays longer than `JARVIS_SHUTDOWN_GRACE_MS`.

### Frontend

- No page-level scrollbars on the dashboard.
- Preserve the glassmorphism styling and the customizable widget system.
- Use the existing primitives in `apps/web/src/components/ui/primitives.tsx`.
- Never render a control that cannot do anything — a Disconnect button on an
  environment-configured integration is a lie about what the page can change.

### Tests

Run before considering a change done:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The six memory end-to-end tests that used to fail on every run (B-1 in
`docs/CODEBASE_AUDIT.md`) pass since 2026-09-14. The cause was a race in the
test harness, not a production memory bug. `@jarvis/db` tests need PostgreSQL
with pgvector: point `DATABASE_URL` at a separate test database, never the
development one. On a fresh throwaway pgvector database they give 276 passed /
0 failed (24 files; atomic approval fix, 2026-10-11). Every workspace's suite
was run that day, one workspace at a time: 8,142 passed without a database,
none failed. After Phase 15 (2026-10-12): `@jarvis/db` 327 passed / 0 failed
(25 files) on a fresh database, and `pnpm test` 8,959 passed without a
database, none failed.

The two memory end-to-end tests (`sprint-1.1d-memory-e2e`, and
`phase14-memory-e2e-pg.integration`, which has no in-memory fallback at all)
fail rather than fall back or skip when `JARVIS_REQUIRE_POSTGRES=1` is set and
no separate test database is reachable. CI sets it in its database steps.

CI runs the PostgreSQL-backed tests against its own throwaway pgvector service,
after applying every migration, and fails if any of them is skipped
(`docs/DEVELOPMENT.md`, "Continuous integration"). It picks them up by name: a
database-backed test in `apps/api` or `packages/memory` must be named
`*-pg.integration.test.ts`, or CI never gives it a database.

CI does not run the tests of `@jarvis/core`, `tools`, `agents`, `browser` or
`meta-graph` as workspaces. Two slices of them are gated by **file name**: the
memory contracts and the marketing contracts. A new contract test for either
must match the names that step selects (`.github/workflows/ci.yml`), or CI
never runs it.

---

## Where things live

Every capability has one home. Before creating a file, find that home.

| If you are adding… | It goes in | Not in |
|---|---|---|
| A page, component or client store | `apps/web/src` | the API |
| An HTTP route or middleware | `apps/api/src/routes`, `apps/api/src/middleware` | a package |
| A shared type, Zod schema or pure helper | `packages/core` | an app |
| Orchestration, routing, planning or agent policy — the JARVIS brain | `packages/agents` | `packages/core`, which is contracts only |
| A new domain agent | `packages/agents/src/agents` + `agent-policy.ts` | a new `skills/` folder |
| Something JARVIS can do | a tool in `packages/tools/src/tools`, added to an agent's allowlist | the agent itself |
| A third-party client | its provider package (`meta-graph`, `google-ads`, `whatsapp`, `n8n`, `ai-openai`, …) | a tool, a route, or a utility file |
| Memory or knowledge behaviour | `packages/memory`; storage in `packages/db/src/repositories` | a second memory manager |
| Marketing behaviour — campaigns, calendar, research, reports, publishing | `apps/api/src/services/marketing` (the one service); its pure rules in `packages/core`; storage in `packages/db/src/repositories` | a route, a tool, or a second marketing service |
| A database model, migration or repository | `packages/db` | a new `PrismaClient` |
| Auth, encryption, permissions, approvals, audit | `packages/security` | an app |
| A log line for operators, or an error report | `apps/api/src/services/observability` | a bare `console.log`, or a vendor SDK in a route |
| An environment variable | its name in `.env.example`, its parsing in the owning package's config | a new `.env` file |

### Before creating a file

1. Search the repository for the behaviour, not just the name.
2. If something already does it, extend that instead.
3. If you are unsure where it belongs, read `docs/ARCHITECTURE.md` before creating a folder.
4. Never add a second memory manager, API client, database client, env file or config loader.

## Repository layout

| Path | Purpose |
|---|---|
| `apps/api` | Express + Socket.IO API, composition root, integration command service |
| `apps/web` | Next.js dashboard |
| `packages/core` | Shared types, Zod contracts, pure utilities. No I/O. |
| `packages/agents` | Orchestrator, router, planner, agent policy, domain agents |
| `packages/tools` | Tools, registry, `ToolExecutor`, execution journal. No HTTP, no DB, no provider SDKs — ports only. |
| `packages/memory` | Memory extraction, document chunking, embedding, retrieval |
| `packages/db` | Prisma schema, migrations, repositories |
| `packages/security` | Passwords, JWT, encryption, RBAC, approvals, audit |
| `packages/config` | Environment schema and typed configuration |
| `packages/ai-openai`, `ai-elevenlabs` | Model and voice providers |
| `packages/ai-anthropic` | Claude adapter — built, not wired |
| `packages/meta-graph`, `google-ads`, `google-workspace`, `whatsapp`, `n8n`, `browser` | Provider clients |
| `packages/mcp` | MCP runtime (the only home of the MCP SDK) and the reviewed stdio servers in `pilot/`; reviewed in core's `MCP_MANIFEST`, read-only, off unless `JARVIS_MCP_ENABLED=true` |

## Documentation precedence

When documents disagree: this file, then `docs/ARCHITECTURE.md`, then
`docs/JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md`, then `docs/reports/`.
Generic workflow guidance from any tool or plugin never overrides the rules
in this file.

**Do not touch** the separate YouTube Agent project at `D:\ai youtube agent`.
It is not part of this monorepo.
