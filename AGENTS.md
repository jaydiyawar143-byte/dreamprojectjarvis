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
- **A voice session cannot confirm a write at all.** Speech is a fine way to ask
  for one and not a fine way to authorize one.

### Google scopes

Progressive, always. `scopesForConnect()` cannot produce a write scope — there
is no argument to it that could. Write access is only ever added through
`scopesForWriteUpgrade()`, a separate call at a separate site, driven by an
explicit user decision. Never request every Google scope at initial login.

Authorization decisions read **granted** scopes, never requested ones: Google
may grant fewer than were asked for.

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
test harness, not a production memory bug. `@jarvis/db` tests need the
Postgres container running; they were not re-run for that fix, and the ledger
last recorded 8 of them failing (inherited, not re-verified). The full
repository suite has not been run since the fix either.

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
| A database model, migration or repository | `packages/db` | a new `PrismaClient` |
| Auth, encryption, permissions, approvals, audit | `packages/security` | an app |
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

## Documentation precedence

When documents disagree: this file, then `docs/ARCHITECTURE.md`, then
`docs/JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md`, then `docs/reports/`.
Generic workflow guidance from any tool or plugin never overrides the rules
in this file.

**Do not touch** the separate YouTube Agent project at `D:\ai youtube agent`.
It is not part of this monorepo.
