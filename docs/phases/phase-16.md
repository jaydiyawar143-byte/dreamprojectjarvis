# Phase 16 — Intelligent Workflow Engineering & Automation OS

**Date:** 2026-10-14 · **Branch:** `main` (planning only — nothing was changed) ·
**Base:** `origin/main` at `7b0e791` (the merge of Phase 15, pull request #7)

**Verdict: PLAN.** This document is a plan. **No application code, schema,
configuration, migration or workflow was created, changed or run.** It records
what was verified about the repository, what already exists, what is genuinely
missing, and how the phase is proposed to be built. Every claim about the
existing system carries a file reference; every proposal is labelled as a
proposal.

Section 2 is the verified state. Sections 3 and 4 separate what exists from what
is missing. Section 5 is the n8n/MCP boundary audit. Sections 6 to 8 are the
design. Section 9 is the security and release gate. Section 10 is what is
deferred and still unknown.

This is the "Phase 16 workflow builder" that
[`phase-15.md`](./phase-15.md#1-where-the-scope-came-from) names as out of scope
for Phase 15, and the row that
[`JARVIS_CAPABILITY_MATRIX.md`](../JARVIS_CAPABILITY_MATRIX.md) currently marks
**Planned / not implemented** ("Building an n8n workflow from JARVIS").

---

## 1. Where the scope came from

The brief names the Phase 16 objective and its six required areas: workflow
understanding, intelligent recommendations, natural-language editing, impact
analysis and change preview, a safe lifecycle, the n8n MCP boundary, and a
frontend. It also states the security constraints (below) and this deliverable.

As with Phase 15, the "MDD" master development document is not in this
repository: `docs/JARVIS-Project-Guide.doc` stops at Phase 10
([`phase-15.md`](./phase-15.md#1-where-the-scope-came-from)). The scope below is
the brief's own list, taken as written.

**Planning constraints the brief sets**, and which this document treats as hard
boundaries (they mirror `AGENTS.md`):

- `ToolExecutor` stays the sole execution authority.
- Owner/admin authorization, approval policy and audit logging are preserved.
- The MCP restrictions are preserved: reviewed manifest only, read-only,
  General Assistant only, OWNER/ADMIN, excluded from scheduled/background runs.
- No unrestricted dynamic tool registration, arbitrary remote downloads, or
  unreviewed credentials.
- No production workflow is activated or modified without the required
  authorization.
- No real customer message and no production automation is triggered in tests.
- No existing test is weakened and no established behaviour silently changed.

---

## 2. Verified current state

Checked read-only on 2026-10-14, before this document was written. Nothing was
switched, pulled, built, rebuilt, restarted or changed.

| Check | Result | Evidence |
|---|---|---|
| Branch | `main` | `git rev-parse --abbrev-ref HEAD` |
| HEAD | `7b0e79123cf8720905e2b518ddfc8316e471c004` | `git rev-parse HEAD` |
| HEAD is `origin/main` | Yes — identical | `git rev-parse origin/main` |
| Phase 15 merge present | Yes — `7b0e791` is the PR #7 merge; `ffb8536` is an ancestor of `HEAD` | `git merge-base --is-ancestor ffb8536… HEAD` → exit 0 |
| Working tree | Clean — no modified, staged or untracked files; no stashes | `git status --porcelain` empty |
| CI on this commit | Green (Phase 15 record: typecheck 35/35, lint 19/19, build 19/19, 8,959 passed without a database) | `docs/phases/phase-15.md`, §10; ledger daily log 2026-10-12 |
| Default Compose stack | One image `jarvis-app:latest`; web `3100→3000`, api `3101→3001`, postgres `5433→5432`; all three healthy | `docker-compose.yml`; `docker compose ps` |
| n8n reachable in the deployment | **Not configured and not reachable** — confirmed read-only by M0 (§8): no `N8N_*` in `.env`, in `docker-compose.yml`, in the host environment or in the API container, and nothing on `localhost:5678`. The Automations page renders its "not connected" state until they are set on the server | `apps/web/src/app/automations/page.tsx:65-70`; `apps/api/src/services/integration-registry.ts:734-771` |
| Live n8n workflows accessible | **Unknown and unverified.** This document does not assume any existing workflow is reachable or compatible | see §3.1, §5 |

One prior working session in this repository earlier the same day rebuilt and
recreated the `web` and `api` containers so that the merged Phase 15 `/marketing`
route is present. That is unrelated to Phase 16 and is not repeated or relied on
here.

---

## 3. What exists today

### 3.1 The n8n integration surface

The n8n integration exists and is deliberately small: JARVIS can **trigger** a
pre-registered workflow and **receive** its result. It cannot read, list, create,
edit, activate or execute a workflow through n8n's own API.

| Piece | What it does | Where |
|---|---|---|
| Provider package `@jarvis/n8n` | Exactly one operation — `triggerWorkflow(webhookPath, payload, …)` | `packages/n8n/src/provider.ts:34-41,60-106` |
| Its HTTP client | One outbound call: `POST {N8N_BASE_URL}/webhook/{path}`, header `X-N8N-API-KEY` | `packages/n8n/src/client.ts:49-99` |
| SSRF guard | `validateWebhookPath` / `buildWebhookUrl` reject traversal and re-check the origin | `packages/n8n/src/config.ts:83-119` |
| Callback verification | HMAC-SHA256 over the raw body, `X-Jarvis-Signature`, freshness window | `packages/n8n/src/signature.ts:40-96`; `apps/api/src/routes/n8n.ts:105-183` |
| Config | `N8N_BASE_URL`, `N8N_API_KEY`, `N8N_CALLBACK_SECRET`, `N8N_TIMEOUT_MS` (default 15000, max 120000) | `packages/n8n/src/config.ts:27-56`; `.env.example:140-164` |
| Integration catalogue entry | id `n8n`, `configKind: "server-managed"`, one action `n8n.trigger` (`writesExternally: true`) | `packages/core/src/integration-catalog.ts:476-492` |
| Commands | `UNIVERSAL_COMMANDS` + `executeAction` | `packages/core/src/integration-catalog.ts:490` |
| Permissions reported | `workflow_read` (read), `workflow_execute` (write, approval-gated) | `apps/api/src/services/integrations/command-service.ts:1072-1078` |
| Connection state vs health | `connectionState("n8n")` is "is it set up"; the health check is a live read | `command-service.ts:644-648`; `integration-registry.ts:734-771` |
| Health check (the only n8n REST call anywhere) | `GET {baseUrl}/api/v1/workflows?limit=1` with `X-N8N-API-KEY` — liveness only | `integration-registry.ts:745-757` |
| The only n8n tool | `n8n.trigger` — approval-gated (`requiresApproval = true`), `EXTERNAL_SIDE_EFFECT`, `read`+`write` | `packages/tools/src/tools/n8n-tools.ts:63-202` |
| Its port | `N8nTriggerProvider` (the tool imports no HTTP) | `packages/tools/src/tools/n8n-tools.ts:30-37` |
| Agent grant | `automation-agent` only, `writesRequireApproval: true` | `packages/agents/src/agent-policy.ts:481-485` |
| Router mounts | `/api/v1/n8n/callback` (HMAC, no session), `/workflows`, `/executions`, `/executions/:id` (session reads); only when `isN8nConfigured()`, and **before** `express.json()` so the raw body survives | `apps/api/src/routes/n8n.ts:105-235`; `apps/api/src/index.ts:191-208` |
| Data model | `N8nWorkflow` holds only a registered **webhook path**; `N8nExecution` holds the durable audit and idempotency record. **No workflow definition is stored** | `packages/db/prisma/schema.prisma:408-459` |
| Frontend | `/automations` is **read-only**: it lists registered workflows and executions and draws no run button | `apps/web/src/app/automations/page.tsx:1-171`; nav entry `apps/web/src/components/dashboard/nav.ts:75` |

**The gap in one line:** the `GET /api/v1/n8n/workflows` route lists *JARVIS's
registered webhook paths* (`PrismaN8nRepository.listWorkflowsForUser`), not the
n8n server's workflow catalogue. **Nothing in the repository today reads a real
n8n workflow definition.**

### 3.2 The MCP runtime

| Fact | Where |
|---|---|
| MCP is the only home of the MCP SDK; the pilot servers are `dates` and `units` | `packages/mcp/`; `packages/mcp/pilot/dates-server.mjs`, `units-server.mjs` |
| The reviewed manifest holds exactly two servers, four tools, each pinned by fingerprint | `packages/core/src/mcp-manifest.ts:96-202` |
| A manifest tool **must** be `readOnly: true`, `risk: "READ_ONLY"`, `requiresApproval: false`; anything else fails the manifest closed | `packages/core/src/mcp-manifest.ts:637-648`; `types/mcp.ts:91-94` |
| Tools reach the registry only while `JARVIS_MCP_ENABLED === "true"`, at boot, once | `packages/mcp/src/config.ts:71-73`; `apps/api/src/services/container.ts:1188` |
| Only `node` may be spawned, no shell, a pinned child environment, a fixed timeout/bounds | `packages/core/src/mcp-manifest.ts:66-67,550-556`; `packages/mcp/src/connection.ts:401-424` |
| MCP tools are granted to the general assistant **only** | `packages/agents/src/agent-policy.ts:304,377-378` |
| They need `read`+`execute`, i.e. OWNER or ADMIN | `packages/core/src/mcp-manifest.ts:70,641-648`; `packages/tools/src/executor.ts:133-147`; `packages/security/src/permissions.ts:3-36` |
| They can never be scheduled or run in the background | `packages/agents/src/agent-policy.ts:607-614`; `container.ts:1681-1699` |
| A live listing never registers or describes anything; drift fails the server closed | `packages/mcp/src/connection.ts:260-342` |
| **No n8n MCP server exists** | `packages/mcp/pilot/` contains only `dates` and `units`; no `n8n` match across `packages/mcp` |

### 3.3 The execution and safety infrastructure Phase 16 must reuse

| Mechanism | What it gives Phase 16 | Where |
|---|---|---|
| `ToolExecutor` | The one execution authority: validate → permission → approval → single deadline → audit | `packages/tools/src/executor.ts:59-438` |
| Deadline | One 30 s deadline per execution, composed with the caller's signal | `executor.ts:30,346-398` |
| Approval | PostgreSQL row, 10-minute TTL, consumed atomically with the execution claim | `packages/core/src/types/common.ts:42`; `packages/db/src/repositories/approval-repository.ts:225-333` |
| Confirmation (integration writes) | PostgreSQL row, 2-minute TTL, single use, bound to `(user, integration, action, params-hash)`, spent by one conditional `UPDATE`; voice cannot confirm; no in-memory fallback | `apps/api/src/services/integrations/confirmations.ts:54,104-206`; `command-service.ts:1340-1481` |
| Pending action | Answered by its id; one conditional `UPDATE` decides the winner | `packages/agents/src/pending-action-service.ts:222-267`; `apps/api/src/routes/pending-actions.ts:39-112` |
| Audit + redaction | Every execution writes one redacted audit row; secrets never persisted | `packages/security/src/audit.ts:88-97` |
| Execution journal | Durable claim/terminal transitions for a write whose outcome may be unknown | `packages/tools/src/execution-journal.ts:124-471`; `packages/db/src/repositories/tool-execution-repository.ts` |
| Provider retry | Bounded retry (2 retries, ≤8 s waits, ≤45 s) for a **provider call**, never a tool/message | `packages/core/src/provider-retry.ts:35,155` |
| Durable tasks | `PENDING → RUNNING → {COMPLETED,FAILED,UNRESOLVED}`, all terminal, **no retry**; durable claim; orphan/stale recovery | `packages/core/src/types/task.ts:20,78-100`; `apps/api/src/services/tasks/task-scheduler-service.ts:321-483` |
| Scheduling | One-time only; an approval-gated tool is never run unattended | `docs/ARCHITECTURE.md:133-153` |
| Versioning | **Only** `OutcomeRevision` exists (write-once, no rollback). No workflow or content version history anywhere | `packages/db/prisma/schema.prisma:814`; `packages/db/src/repositories/outcome-repository.ts:382-431` |
| Observability | One operational log and one error monitor per process; both may not throw | `apps/api/src/services/observability/operational-log.ts:83`; `error-monitor.ts:81` |
| RBAC | `owner`/`admin`/`member`/`viewer`; the executor enforces `requiredPermissions` | `packages/security/src/permissions.ts:3-50` |

### 3.4 The frontend conventions Phase 16 must follow

| Convention | Where |
|---|---|
| A new authenticated route wears `RequireAuth` + `DashboardShell` in its own `layout.tsx` | `apps/web/src/app/marketing/layout.tsx` (the model) |
| Navigation is data: one entry appended to `NAV_GROUPS` | `apps/web/src/components/dashboard/nav.ts:45-98` |
| Use the existing primitives (`Tabs`, `DataTable`, `Badge`, `StatusDot`, `Button`) | `apps/web/src/components/ui/primitives.tsx` |
| Page owns state; tabs are props-driven and read a server `status` payload to decide which controls to draw | `apps/web/src/app/marketing/page.tsx`; `components/marketing/*` |
| Draw **no control that could do nothing** | `AGENTS.md`; `apps/web/src/app/integrations/page.tsx:3-31` |
| API client: one typed `async` function per endpoint returning `ApiResponse<T>`, all through `request()` | `apps/web/src/lib/api.ts:159-225` and the marketing block `:2648-2888` |
| Router: HTTP only — identity from the verified token, one tool per endpoint, refusals mapped to status codes; **no business rule** | `apps/api/src/routes/marketing.ts:1-36,119-148` |
| Composition root: one wiring function, one shared `ToolExecutor` | `apps/api/src/services/container.ts:1645,2007-2010` |
| No page-level scrollbars; scroll regions need `min-h-0` + `overflow-y-auto` | `apps/web/src/app/globals.css:245-278`; `dashboard-shell.tsx:176-182` |
| Glassmorphism (`glass-panel`, `sys-*`) is preserved | `globals.css:280-322` |

### 3.5 The MCP configuration, as installed (inspected 2026-10-14)

Inspected read-only. No configuration was changed and no secret was printed.

| Check | Result | Evidence |
|---|---|---|
| Any MCP client config in the repository (`.mcp.json`, `mcp.json`, `claude_desktop_config.json`, `mcp_config.json`, …) | **None** | recursive search, `node_modules`/`.git`/`.next`/`dist`/`.turbo` excluded — zero results |
| `.claude/` | holds `skills/` only; no MCP configuration | `.claude/` listing |
| `JARVIS_MCP_ENABLED` in `.env.example` | documented; default `"false"` (commented out) | `.env.example:383-388` |
| `JARVIS_MCP_ENABLED` in the local `.env` | **not set** → MCP is **off** at runtime; no MCP tool registers | `Select-String` on `.env` |
| Servers in the reviewed manifest | exactly two — `dates` (`jarvis-dates` 1.0.0) and `units` (`jarvis-units` 1.0.0) | `packages/core/src/mcp-manifest.ts:99,149` |
| Server binaries | the two pilot scripts, spawned with `node` only | `packages/mcp/pilot/dates-server.mjs`, `units-server.mjs` |

**The exposed tools, and nothing else — four, all read-only:**

| Server | Tool | Manifest id | Risk / approval |
|---|---|---|---|
| dates | `days_between` | `mcp.dates.days_between` | READ_ONLY / none |
| dates | `day_of_week` | `mcp.dates.day_of_week` | READ_ONLY / none |
| units | `convert_length` | `mcp.units.convert_length` | READ_ONLY / none |
| units | `convert_temperature` | `mcp.units.convert_temperature` | READ_ONLY / none |

Both pilot servers declare `annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }` (`dates-server.mjs:26-53`; `units-server.mjs:37-50`), matching the manifest exactly. **No n8n tool is exposed through MCP**, and there is no transport, config or manifest entry through which one could appear at runtime.

---

## 4. Confirmed gaps

Each row is a thing the brief asks for that **does not exist today**, with the
evidence that it does not.

| # | The brief asks for | Today | Evidence of the gap |
|---|---|---|---|
| G-1 | Search and catalogue existing workflows | Only JARVIS's registered webhook paths are listable; the n8n catalogue is not read | `apps/api/src/routes/n8n.ts:188-203` (returns the local registry); `integration-registry.ts:745-757` reads `?limit=1` only |
| G-2 | Inspect nodes, connections, triggers, conditions, inputs, outputs, dependencies | No read of a workflow definition at all | No `getWorkflow` in `packages/n8n/src/provider.ts` (the interface has one method) |
| G-3 | Explain a workflow's purpose | Nothing | None |
| G-4 | Identify missing error handling, validation, duplicate-execution risks | Nothing | None |
| G-5 | Compare feasible approaches and recommend one, with assumptions | Ad-optimisation recommendations exist for Meta; there is no workflow recommendation engine | `packages/core/src/marketing-recommendations.ts` is marketing-only |
| G-6 | Natural-language editing → a proposed revision | Nothing; the matrix marks it Planned | `JARVIS_CAPABILITY_MATRIX.md:252` |
| G-7 | Impact analysis / change preview (nodes added/changed/removed, connections, downstream, side effects, validation) | Nothing | None |
| G-8 | A workflow lifecycle with versions, rollback, idempotency, retries, timeouts, alerts | No workflow version history and no rollback anywhere; the only versioned entity is `OutcomeRevision` | `schema.prisma:814`; `outcome-repository.ts:382-431` |
| G-9 | n8n MCP use | No n8n MCP server; the manifest accepts read-only tools only | `packages/mcp/pilot/`; `mcp-manifest.ts:637-648` |
| G-10 | A workflow frontend (library, details, editor, diff, validation, approvals, history, rollback, diagnostics) | `/automations` is read-only and has no run/edit control | `apps/web/src/app/automations/page.tsx` |
| G-11 | n8n `N8N_TIMEOUT_MS` declared where configuration is described | Read by the package but absent from the catalogue's `envVars` | `integration-catalog.ts:491` vs `config.ts:54` |

**Verified, not assumed.** Every row above rests on a file that was read, not on
the brief: the n8n surface (§3.1), the MCP runtime (§3.2–3.5) and the safety
infrastructure (§3.3) were each traced to the code at the line shown. What is
**not** verified — and what this plan therefore does **not** rest on — is the
live state of an n8n server: its version, whether the configured `N8N_API_KEY`
may read or edit workflows, and whether any existing workflow is reachable. No
workflow has been inspected. Both are Milestone 0 work (§8). The unverified
assumptions are gathered in §10.

---

## 5. n8n MCP audit and integration boundaries

**Audit result.** There is **no n8n MCP server installed**, reviewed or
configured (§3.5). The MCP manifest is frozen with two servers (`dates`,
`units`); the
pilot directory contains exactly those. An "n8n MCP" is therefore a **thing to
decide**, not a thing to use, and this phase does not assume it exists.

**What MCP structurally can and cannot carry.** The manifest validator refuses
any tool that is not `readOnly: true` with `requiresApproval: false`
(`packages/core/src/mcp-manifest.ts:637-648`). Everything an MCP tool can do is
read-only, granted to the general assistant alone
(`agent-policy.ts:377-378`), requires OWNER/ADMIN
(`mcp-manifest.ts:70`; `permissions.ts:3-36`), and is excluded from any
scheduled or background run (`agent-policy.ts:607-614`). Consequently:

| Operation | Can it come through MCP? | Why |
|---|---|---|
| List/inspect workflows (discovery) | **Possibly, read-only** — and only if a server is reviewed, pinned in `MCP_MANIFEST`, and `JARVIS_MCP_ENABLED=true` | manifest permits read-only tools only |
| Create / update / activate / deactivate / execute a workflow | **No** | the manifest cannot accept a write tool; and no agent's scheduled allowlist may hold an MCP id |

**Boundaries this phase will hold** (all proposals; §9 lists the gates):

1. **Discovery may use either source**, but there is **one parser and one
   normaliser** for a workflow, in `packages/core`, so both a REST read and an
   MCP read produce the same verified shape.
2. **Writes never travel through MCP.** Applying, activating or rolling back a
   workflow is an n8n **provider** operation, reached only through
   `ToolExecutor`, behind the approval gate, and — being an external write —
   behind the durable confirmation gate.
3. **No dynamic registration.** Adding an n8n MCP server means a reviewed
   manifest entry with pinned fingerprints, not a runtime discovery
   (`packages/mcp/src/connection.ts:260-342`).
4. **Read-only before write.** Milestones 0–2 are read-only. A write operation
   is added only after §8 M4's acceptance criteria — the installed server's API
   surface, the key's authorization, and the update schema — have been verified
   against the running n8n and written down.
5. **No live execution in tests, ever.** A workflow "test" inside JARVIS is
   **static validation**, never a run. Executing a workflow is what
   `n8n.trigger` already is, it stays approval-gated, and Phase 16 adds no test
   that reaches a real automation.
6. **Writes are not schedulable and not agent-only.** Workflow edits follow the
   publish precedent: reachable from chat *and* the page, approval-gated by the
   exact revision, with at least one action (`workflow.apply.resolve`-style, if
   a settle is ever needed) held by **no** agent.

---

## 6. Target architecture

### 6.1 One implementation, two ways in

`AGENTS.md` puts an *integration operation* in
`IntegrationCommandService`. Phase 15 established that a **workspace in JARVIS's
own database that reads one integration** is a domain service, not an
integration operation, and said why
([`phase-15.md`](./phase-15.md#two-design-decisions-an-auditor-should-weigh)).
Workflow engineering is that same shape: a store of proposed and applied
revisions in JARVIS's database, reading and (after verification) writing one
provider, with parameters that must come from the **saved revision** and not
from the client.

```
     chat ("add a WhatsApp follow-up to this workflow")
        │
        ▼
   Orchestrator ── allowlist · write-intent gate · role · pending action
        │
        ▼
   automation-agent  ──┐
                       ├──►  workflow.* tools ──► ToolExecutor
     /workflows page ──┤            (validate · role · approval · deadline · audit)
     /api/v1/workflows ┘                  │
                                          ▼
                              WorkflowIntelligenceService  (the one implementation)
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
      pure rules in packages/core   N8nWorkflowProvider port     PostgreSQL
      (diff · validate · recommend)  (read first; write after     (WorkflowCatalog,
              │                       verification)                WorkflowRevision)
              ▼                           │
        response/diff/plan                ▼
                                    packages/n8n → n8n REST API
```

- The **provider client** gains the operations, in `packages/n8n` — the one
  home of an n8n call (`AGENTS.md`, "Where things live").
- The **service** holds no credential and no HTTP: it receives an
  `N8nWorkflowProvider` port and a repository, exactly as `MarketingService`
  receives ports.
- The **tools** receive the service as their port; they never import HTTP.
- The **router** translates HTTP into one tool call; it holds no rule.
- **Both** chat and the page arrive at the same `ToolExecutor` and the same
  service — the structural guarantee `AGENTS.md` requires.

### 6.2 Component map (proposed)

| Layer | Proposed home | Responsibility |
|---|---|---|
| Vocabulary, schemas, limits | `packages/core/src/types/workflow.ts` | `WORKFLOW_TOOL_IDS`, revision states, the normalised workflow shape |
| Pure logic | `packages/core/src/workflow-diff.ts`, `workflow-validation.ts`, `workflow-recommendations.ts` | definition diff, static validation, fixed-rule recommendations |
| Provider client | `packages/n8n/src/workflow-client.ts` (new) | `listWorkflows`, `getWorkflow` (read); `updateWorkflow`, `setActive` (write, only after M4) |
| Tools | `packages/tools/src/tools/workflow-tools.ts` (new) | `workflow.*` tools + ports |
| Agent | `automation-agent` (existing) + its policy | grant the read tools broadly, the write tools to the automation agent alone |
| Storage | `packages/db` — new migration, `workflow-repository.ts` | `WorkflowCatalog`, `WorkflowRevision` |
| The one implementation | `apps/api/src/services/workflows/workflow-intelligence-service.ts` (new) | discovery, understanding, recommendation, draft, validate, apply, verify, rollback |
| Router | `apps/api/src/routes/workflows.ts` (new) | `/api/v1/workflows/*`, one endpoint = one tool |
| Page | `apps/web/src/app/workflows` + `components/workflows/*` (new) | the workspace |

### 6.3 The execution lifecycle

Mapped to what already exists, so no new authority is invented:

```
1  Inspect    read the catalogue + one definition      read tool → executor → audit
2  Understand pure summary + risk flags                packages/core (no model for the facts)
3  Recommend  fixed rules over the definition          packages/core; never "optimal"
4  Draft      a proposed revision, saved as DRAFT      workflow.* tool → service → DB
5  Validate   static checks over the DRAFT             packages/core; no provider call
6  Test       = validation only; NO live execute       by design (§5.5)
7  Approve    a person approves the exact revision     Approval (10 min) + Confirmation (2 min)
8  Apply      one conditional claim, then the write    executor + journal + n8n provider
9  Verify     read the workflow back by id; compare hash
10 Monitor     execution history reads + audit; alerts via the error monitor
```

Two facts keep this honest: **step 6 never runs a workflow** (§5.5), and
**step 7 is a person** — a voice session cannot confirm a write, and no agent
holds the settle action (§5.6).

### 6.4 Workflow understanding

Input: the normalised definition (nodes, connections, trigger(s), conditions,
inputs, outputs, credential **references** — never values). Output, all
computed in `packages/core`:

- a plain-language summary of the trigger(s) and the path through the nodes;
- the entry points and terminal nodes;
- a list of external services the workflow calls (derived from node types);
- **risk flags**, each with the node id it came from: no error branch, an HTTP
  node with no timeout/retry, a write with no idempotency guard, a
  duplicate-execution risk (a trigger with neither idempotency nor a
  de-duplication node), a credential reference whose credential does not exist.

The **facts** are computed; a model may phrase them. A model may not invent a
node, a flag or a number.

### 6.5 Intelligent recommendations

Given a stated objective ("stop duplicate reminder emails"), the service
proposes **feasible approaches**, each with a rationale and the trade-offs the
brief names (reliability, cost, complexity, performance, operational risk),
computed from the same normalised facts. It must:

- state its assumptions and ask for the missing critical input rather than
  guessing;
- never call an approach "optimal" — the strongest claim allowed is "best of the
  approaches considered, because …", with the comparison shown;
- mark every recommendation `executed: false` (the marketing precedent,
  `AGENTS.md` "A recommendation is advice").

### 6.6 Natural-language editing

"Add a WhatsApp follow-up to this workflow", "stop further reminders when the
customer replies", "add retries and a failure notification to the Sheets step",
"improve reliability without breaking existing behaviour."

Flow: the model proposes a **revision** as structured operations (add node,
add connection, change parameter, add error branch) over the **read** definition
— never free-form JSON the service cannot check. The service:

1. applies the operations to the stored base definition, in `packages/core`;
2. refuses an operation that names a node or connection that is not there;
3. produces the **human-readable change summary** and the **diff** (§6.7);
4. saves the result as a `DRAFT` revision, and nothing else changes.

The saved workflow is untouched until step 8 runs, approved.

### 6.7 Impact analysis and change preview

A pure diff between the base and the proposed definition, in `packages/core`:

| Shown | Source |
|---|---|
| Nodes added / removed / changed | definition diff |
| Connections added / removed / re-pointed | definition diff |
| Data-flow change | reachability over the connection graph |
| Affected downstream nodes and outputs | the same walk |
| Potential side effects | node-type classification (write / external call / messaging) added or removed |
| Validation results | §6.8's static checks |
| Previous vs proposed | the two definitions, side by side |

### 6.8 Version history, rollback, idempotency, retries, timeouts, alerts

- **Version history.** A `WorkflowRevision` row is write-once, numbered per
  workflow, and never updated — the `OutcomeRevision` pattern
  (`outcome-repository.ts:382-431`) extended to definitions. A revision records
  its parent, so history is a chain.
- **Rollback** is **applying a previous revision**: a new revision whose parent
  is the current head and whose content is the earlier one, itself approval-gated
  and verified. It is never a silent in-place revert.
- **Idempotency.** Applying is claimed through the execution journal before the
  write; a retry converges on the same revision. The write itself is a full
  definition replacement (idempotent); an activation toggle is not, so it is
  guarded by the journal and by reading the state back.
- **Conflict detection.** A workflow may have changed in n8n since it was read.
  Every revision is bound to the **hash of the base definition it was built
  from**; Apply reads the live definition first and refuses if the hash moved,
  answering "this workflow changed since you started; re-open it" rather than
  overwriting someone's edit. This mirrors the publish retry's "held to the
  attempt it was made for" rule.
- **Retries.** `runWithRetry` (`packages/core/src/provider-retry.ts:35,155`) is
  reused for **read/transport** failures only. A **write** is never blindly
  retried; it uses the journal's claim/terminal transitions
  (`execution-journal.ts:124-471`).
- **Timeouts.** Reads owe `ToolExecutor`'s 30 s deadline; the provider's own
  `N8N_TIMEOUT_MS` (15 s default) sits under it. A large definition plus a
  read-back may need a tool-specific deadline — an open question (§10).
- **Failure alerts.** Apply/Verify failures are audited and reported through the
  existing error monitor and operational log
  (`operational-log.ts:83`; `error-monitor.ts:81`). **Continuous** monitoring
  would need a new background loop; scheduling is one-time only today, so
  Monitoring in this phase is on-demand (§10, deferred).

---

## 7. Backend, database, API and frontend changes (proposed)

Nothing below exists yet. This is the change list the implementation is planned
against.

### 7.1 `packages/core`

- `src/types/workflow.ts` — `WORKFLOW_TOOL_IDS`, revision states
  (`DRAFT | VALIDATED | APPLIED | SUPERSEDED | REJECTED`), the normalised
  `WorkflowDefinition` shape, and the limits (max nodes, max definition bytes).
- `src/workflow-diff.ts` — the pure diff (§6.7).
- `src/workflow-validation.ts` — static checks and risk flags (§6.4).
- `src/workflow-recommendations.ts` — fixed rules (§6.5).
- Add `N8N_TIMEOUT_MS` to the n8n catalogue `envVars`
  (`integration-catalog.ts:491`) — closing G-11.

### 7.2 `packages/n8n`

- New `src/workflow-client.ts`: `listWorkflows({limit})`, `getWorkflow(id)` —
  **read**, over `X-N8N-API-KEY`, origin-checked like `buildWebhookUrl`.
- After M4: `updateWorkflow(id, definition)`, `setActive(id, bool)` —
  **write**, added only once the schema and authorization are verified (§8 M4).
- The package stays pure transport; it holds no authorization decision
  (`provider.ts:24-26`).

### 7.3 `packages/tools`

New `src/tools/workflow-tools.ts` with ports, no HTTP:

| Tool | Risk | Approval | Notes |
|---|---|---|---|
| `workflow.catalog.list` | READ_ONLY | no | the n8n catalogue, normalised |
| `workflow.get` | READ_ONLY | no | one definition + risk flags |
| `workflow.executions.list` | READ_ONLY | no | one workflow's runs |
| `workflow.recommend` | READ_ONLY | no | fixed rules; `executed: false` |
| `workflow.revision.draft` | LOW_IMPACT | no | writes only to JARVIS's store |
| `workflow.revision.validate` | READ_ONLY | no | static checks |
| `workflow.revision.list` / `.get` | READ_ONLY | no | history |
| `workflow.apply` | HIGH_IMPACT + writes externally | **yes** | applies one revision |
| `workflow.setActive` | HIGH_IMPACT + writes externally | **yes** | activate/deactivate |
| `workflow.rollback` | HIGH_IMPACT + writes externally | **yes** | applies an earlier revision |

No tool is registered that an agent cannot be granted; registration is
conditional on the feature and the credentials, as marketing's is
(`container.ts:1320-1339`).

### 7.4 `packages/agents`

- `automation-agent`: grant the read tools and the workspace tools; grant the
  write tools with `writesRequireApproval: true`. Read tools may also be granted
  to the general assistant, following the marketing precedent of split
  read/write grants.
- If a settle action is ever needed, it goes on **no** agent's allowlist, held by
  no agent, reached only from the page (the `marketing.publish.resolve`
  precedent, `SKILLS.md:102`).
- No new agent is required: workflow engineering is the automation agent's kind
  of request.

### 7.5 `packages/db`

One **additive** migration and `src/repositories/workflow-repository.ts`:

- `WorkflowCatalog` — a cached, read-only mirror of a discovered workflow:
  `userId`, `n8nWorkflowId`, `name`, `isActive`, `nodeCount`, `triggerTypes`,
  `lastReadAt`, `definitionHash`. Never the source of truth.
- `WorkflowRevision` — write-once, `workflowCatalogId`, `revisionNumber`
  (unique with the workflow), `parentRevisionId`, `definition`, `definitionHash`,
  `baseDefinitionHash`, `status`, `source` (`MODEL | USER | ROLLBACK`),
  `changeSummary`, `validationReport`, `createdBy`, timestamps,
  `appliedApprovalId`.

**Security note.** An n8n definition can carry author-typed data in node
parameters (URLs, headers, occasionally a pasted token). A revision's
`definition` is therefore treated as sensitive: it may hold **credential
references** (ids/names, never values) but must be **redacted on read** and, if
stored, **encrypted at rest** with the existing `EncryptionService` — or stored
only as a hash plus a diff. This is an unresolved question (§10).

### 7.6 `apps/api`

- `src/services/workflows/workflow-intelligence-service.ts` — the one
  implementation (§6.1).
- `src/routes/workflows.ts` — `/api/v1/workflows/*`; identity from the token,
  one tool per endpoint, no rule (the `marketing.ts` shape).
- `src/services/container.ts` — build the service, register the tools before the
  agents' definitions are computed (the `meta.analyze` lesson, R-34), and mount
  the router.
- Reuse the confirmation gate for the external write
  (`command-service.ts:1340-1481`) and the approval gate for the decision.

### 7.7 `apps/web`

- New `app/workflows/layout.tsx` (`RequireAuth` + `DashboardShell`), page, and
  `components/workflows/*`; one new `NAV_GROUPS` entry.
- Tabs: **Library** (catalogue), **Details** (understanding + risk flags),
  **Editor** (natural-language draft + change summary), **Compare** (diff,
  previous vs proposed), **Validation**, **Approvals** (the existing
  `ApprovalCard`), **History** (executions, from the read tool),
  **Versions** (revisions + rollback), **Diagnostics** (failures).
- The page reads a server `status` payload and draws no control this deployment
  or role cannot use — no Edit or Apply without the write tools and the role,
  exactly as `/marketing` does (`marketing/page.tsx:119-123`).
- Decision to confirm: **extend `/automations`** into this workspace, or add
  `/workflows` beside it (§10).

---

## 8. Implementation milestones and acceptance criteria

Each milestone is read-only until M4, and each is independently reviewable.

**M0 — Verify live n8n, read-only.** *Acceptance:* the installed n8n version and
the configured key's permissions are recorded; `GET /api/v1/workflows` returns
the catalogue and `GET /api/v1/workflows/:id` returns one definition, captured
as evidence; the update/activation endpoints' schemas are documented **without
calling them**; and it is stated plainly which existing workflows (if any) are
reachable. If n8n is not connected, M0 records that and the phase builds against
stand-ins only.

**M1 — Read-only discovery and understanding.** *Acceptance:* `workflow.catalog.list`,
`workflow.get`, `workflow.executions.list` reach n8n through the executor;
the definition is normalised and its risk flags computed in `packages/core`;
a page lists the catalogue and shows one workflow's understanding; no write tool
exists; `n8n.trigger` and every existing test are unchanged.

**M2 — Recommendations.** *Acceptance:* fixed rules produce approaches with a
comparison and stated assumptions; each carries `executed: false`; a request
missing a critical input is answered with a clarifying question, not a guess;
no code path carries a recommendation out.

**M3 — Natural-language draft, diff and static validation.** *Acceptance:* a
sentence produces a `DRAFT` revision plus a change summary and a diff; an
operation naming a missing node is refused; static validation reports the
results; nothing is sent to n8n; the draft is byte-stable (the same input gives
the same revision hash).

**M4 — Apply and rollback, behind the gates.** *Precondition:* M0's verification
is complete and written down. *Acceptance:* Apply is approval-gated and
confirmation-gated; it claims the execution before the write; it refuses if the
live definition's hash moved since the draft's base; Verify reads the workflow
back by id and records it as applied only when the read-back hash matches the
revision; rollback is a new revision, gated the same way; a failed verification
leaves nothing marked applied; no live customer automation runs in any test.

**M5 — Frontend.** *Acceptance:* every tab above exists; each control is drawn
only when the server says it can work; no page-level scrollbar; glassmorphism
and the primitives are preserved; the page and chat reach the same service
through the same executor (parity asserted, as
`integration-command-parity.test.ts` does).

**M6 — MCP boundary decision.** *Acceptance:* either (a) a reviewed n8n MCP
server is added to `MCP_MANIFEST`, read-only, GA-only, owner/admin, never
schedulable, with pinned fingerprints and a passing `validateMcpManifest`; or
(b) it is recorded that discovery uses the provider read client and no n8n MCP
server is used, with the reason. No write operation may travel through MCP
either way.

**M7 — Audit and diagnostics.** *Acceptance:* every apply, activation and
rollback writes an audit row; failures are reported through the error monitor;
the Diagnostics tab shows a workflow's failed runs from the read tool.

### M0 result — 2026-10-14 (read-only verification)

**Outcome: BLOCKED — no n8n environment is configured or reachable, so no live
read was possible.** Nothing was changed and no write endpoint was called. The
phase may proceed as planned against stand-ins (M0's own fallback clause), but
**M4 (Apply and rollback) may not ship** until this is re-run against a real
server.

**What was inspected (read-only; no secret was read or printed):**

| Check | Result | Evidence |
|---|---|---|
| `N8N_BASE_URL` / `N8N_API_KEY` / `N8N_CALLBACK_SECRET` / `N8N_TIMEOUT_MS` in the root `.env` | **absent** — the file is 24 lines with **0** occurrences of `N8N` | inspection of `.env` (values never printed) |
| Same variables in `docker-compose.yml` | **absent** — no `N8N` reference | `docker-compose.yml` |
| Same variables in the host process environment | **absent** — no `N8N*` name | host environment, names only |
| Same variables in the running `jarvis-docker-api` container | **absent** — no `N8N_*` name | `printenv` names only, inside the container |
| Any second env file (`apps/*/.env.local`, …) | **none** — only `.env` and `.env.example` exist | repository search |
| n8n on the documented default `http://localhost:5678` | **not reachable** — TCP 5678 closed; `GET /healthz` and `GET /` both fail to connect | TCP probe + read-only GET |
| An n8n container in the local Docker engine | **none** — only `jarvis-docker-web`, `-api`, `-postgres` run | `docker ps` |
| JARVIS's own n8n registry (PostgreSQL `N8nWorkflow`, `N8nExecution`) | **0 rows each** — no workflow was ever registered and no execution recorded | read-only `SELECT count(*)` in the `jarvis-docker-postgres` container (credentials not printed) |

**What the code does when nothing is set** — the system's own behaviour, which
does not pretend:

- `isN8nConfigured()` requires **all three** of `N8N_BASE_URL`, `N8N_API_KEY`
  and `N8N_CALLBACK_SECRET`; with none set it is `false`
  (`packages/n8n/src/config.ts:70-71`).
- The connection test short-circuits to
  `{ health: "CONFIG_REQUIRED", detail: "n8n is not configured on the server." }`
  and makes **no** request (`apps/api/src/services/integration-registry.ts:736-738`).
- `connectionState("n8n")` therefore reports `NOT_CONNECTED`
  (`apps/api/src/services/integrations/command-service.ts:644-648`), and the
  Automations page renders its "no n8n configuration" state
  (`apps/web/src/app/automations/page.tsx:68`).

**Against each M0 acceptance criterion:**

| Criterion | Result |
|---|---|
| The installed n8n version is recorded | **Not possible** — no server is reachable; the repository's only documented read (`GET /api/v1/workflows?limit=1`) reports no version either |
| The configured key's permissions are recorded | **Not possible** — no key is configured; there is nothing to probe |
| `GET /api/v1/workflows` returns the catalogue | **Not testable** — no server |
| `GET /api/v1/workflows/:id` returns one definition | **Not testable** — no server |
| The update/activation schemas are documented without calling them | **Deliberately not done** — the installed version is unknown, so its schema cannot be pinned; pinning it would be a guess, which §5.4 forbids |
| Plainly which existing workflows are reachable | **None** — nothing is configured or running, and JARVIS's own registry holds **0 workflows and 0 executions** |

**Effective permissions: not assumed from a name.** This is why requirement 2
matters, and the repository already shows why. JARVIS's own `workflow_read` and
`workflow_execute` "granted" flags are computed from the **presence** of
`N8N_BASE_URL` and `N8N_API_KEY` (`command-service.ts:1072-1078`), **not** from
a provider response — so "configured" and "working" are different claims. The
only place a real permission is proven is `testN8n`, which issues
`GET {baseUrl}/api/v1/workflows?limit=1` and treats `200` as "the API key was
accepted", `401`/`403` as "n8n rejected the API key", and any other status as
degraded (`integration-registry.ts:749-765`). That read is the minimum safe
probe; it was not reachable, and **no permission is claimed**. With no key
configured, the effective permission set is empty by construction.

**Evidence required to proceed (re-run M0 once access exists).** All read-only;
none of them a write:

1. A reachable n8n server with `N8N_BASE_URL` set to its origin (server-managed
   config only; the origin is not a secret, the API key is).
2. An `N8N_API_KEY` issued in n8n with at least the scope that may list
   workflows. Add `N8N_CALLBACK_SECRET` too, because JARVIS's own read path
   (`isN8nConfigured()`) will not run without it.
3. Then, with the key sent as `X-N8N-API-KEY` and nothing else changed, capture:
   - `GET {origin}/api/v1/workflows` — record the status; `200` proves workflow
     listing is permitted, `401`/`403` proves it is not.
   - `GET {origin}/api/v1/workflows/{id}` for one id from that list — record the
     status and whether a definition body is returned.
   - the **server version**, from the instance itself (its UI "About"/settings or
     logs) — the public `/api/v1` read does not report it.
4. Record per endpoint: HTTP status, the **sanitized** response shape (top-level
   keys and counts only — never node payload values, never a credential, never a
   webhook URL), and whether any workflow is reachable.

**Boundary held during M0:** no `POST`, `PUT`, `PATCH`, `DELETE`, activation,
deactivation, execution, trigger or webhook was called; no production workflow
was changed; no API key, authorization header, credential or webhook URL was
printed.

---

## 9. Security, approval, testing, rollback and release gates

### 9.1 Security and authorization (each mapped to a guard)

| Constraint | Guard |
|---|---|
| `ToolExecutor` is the sole execution authority | every tool runs through `container.ts`'s one executor (`container.ts:1645`) |
| Owner/admin authorization preserved | `requiredPermissions` on every tool; `executor.ts:133-147`; `permissions.ts:3-50` |
| Approval policy preserved | write tools `requiresApproval`; Approval row, 10-min TTL, atomic consume (`approval-repository.ts:225-333`) |
| External-write confirmation preserved | the durable 2-min, params-bound, single-use confirmation, refused with no store, never by voice (`confirmations.ts:54,104-206`) |
| MCP restrictions preserved | reviewed manifest, read-only, GA-only, OWNER/ADMIN, never schedulable (`mcp-manifest.ts:637-648`; `agent-policy.ts:377-378,607-614`) |
| No unrestricted dynamic tool registration | registration is a single boot-time call; the MCP live listing never registers (`connection.ts:260-342`) |
| No arbitrary remote downloads / unreviewed credentials | the n8n client talks only to the configured origin, as the trigger does (`config.ts:83-119`) |
| No production workflow activated or modified without authorization | Apply/Activate/Rollback are approval-gated and confirmation-gated |
| No secrets in a revision, a log or a response | redact credential references on read (`audit.ts:88-97`); encrypt at rest if definitions are stored |
| No live customer automation in tests | standardised stand-in n8n server; "Test" is static validation (§5.5) |

### 9.2 Testing

- Unit: every pure module (`workflow-diff`, `workflow-validation`,
  `workflow-recommendations`) — determinism, edge cases, empty/odd definitions.
- Tool: each `workflow.*` tool through the real `ToolExecutor` against an
  `n8n-mock` provider (the `n8n-mock.ts` pattern), including that a write
  without an approval is refused.
- Parity: chat and the page arrive at one service instance (the
  `integration-command-parity.test.ts` pattern).
- Database: revision write-once, numbering, the conflict check and the
  apply/verify flow, against PostgreSQL. **A database-backed API test must be
  named `*-pg.integration.test.ts`** or CI gives it no database
  (`AGENTS.md`, "Tests").
- No test triggers a real workflow, sends a real message, or points at a
  production n8n.
- Run the standard gate before the phase is called done: `pnpm install`,
  `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

### 9.3 Rollback (of the phase itself)

- The migration is additive and never destructive, so a previous release can
  start against the new database (`AGENTS.md`, "Deployment").
- Reverting the code leaves the two new tables unused; nothing else reads them.
- No existing table, tool, route, grant or test is altered in a way that a revert
  would strand; if a grant is widened, the revert narrows it.

### 9.4 Release gates

1. M0 evidence is written down before any write tool is added.
2. Every write path is approval-gated, confirmation-gated and journalled.
3. Parity, unit, tool and database tests pass; the full gate passes.
4. Docs updated (below) and the ledger row added — the phase is not "done"
   until the ledger says so (ledger §13, Definition of Done #7).
5. No live automation, publish or customer contact is performed by the phase.

---

## 10. Deferred features, unverified assumptions and unresolved questions

**Deferred (out of scope for Phase 16).**

- Cross-recipient or multi-user workflows; n8n per-user credentials.
- Recurring/cron scheduling and continuous background monitoring (scheduling is
  one-time only today; MCP is never schedulable).
- Automatically *executing* a workflow from the editor. Execution remains
  `n8n.trigger`, approval-gated.
- Self-repair (the brief's Phase 19) and computer control (Phase 18).
- Any channel other than what n8n itself provides.
- Live testing of a workflow.

**Assumptions.**

- An n8n server is reachable and a key with at least workflow-read permission can
  be configured. M0 verifies this; if not, the phase is built and verified
  against stand-ins and M4 does not ship.
- The n8n public REST API is the same family as the health check already calls
  (`/api/v1/workflows`).

**Unresolved questions.**

1. **Does an n8n MCP server exist that we would review?** If not, discovery uses
   the provider read client and M6 records that.
2. **What may the configured `N8N_API_KEY` actually do?** Read only, or edit too?
   M0 answers it.
3. **Store a revision's full definition, an encrypted definition, or only its
   hash plus diff?** Secrets-in-parameters make this a real decision.
4. **`/workflows` as a new route, or `/automations` grown into the workspace?**
5. **Tool deadline for Apply + read-back**: is 30 s enough for a large
   definition, or does Apply need a tool-specific deadline?
6. **Conflict granularity**: hash-of-whole-definition, or per-node? The former
   is proposed.
7. **Does a "settle" action exist** (an apply whose outcome is unknown), or does
   a full-definition replace make that state impossible? Proposal: reuse the
   journal's `UNKNOWN` and reconsider a settle only if M4 shows it is needed.
8. **Where do recommendations end and drafting begin** when the model proposes
   an approach? Proposal: recommendations are advisory and `executed: false`;
   only an explicit draft creates a revision.

---

## 11. Documentation updates required when this phase completes

Not done now — this is a planning document. On completion,
`docs/DOCUMENTATION_PROTOCOL.md` requires:

1. This phase document (this file) brought to its final record — scope, evidence,
   changed files, test counts, limitations and verdict.
2. `docs/JARVIS_CAPABILITY_MATRIX.md` — the "Planned / not implemented" workflow
   row (line 252) narrowed to what remains.
3. `docs/ARCHITECTURE.md` — a workflow section, if the architecture changes.
4. `docs/SKILLS.md` — the new tool group and the automation agent's grant.
5. `docs/INTEGRATIONS.md` — the n8n operations table, if writes are added.
6. `docs/JARVIS_USER_MANUAL.md` — if a user-facing capability changed.
7. `docs/diagrams/` — a workflow diagram if the flow is new.
8. `docs/JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md` — a daily-log row, new
   risk-register entries, and an update to §15, per the ledger's own Definition
   of Done (#7). **Not updated by this planning task**, because the ledger's
   update rule is tied to completed work, and none was done.

---

## 12. References

- Integration rule and repository rules: [`AGENTS.md`](../../AGENTS.md).
- How the system is built today: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
- The phase that set this one up and left it out of scope:
  [`phase-15.md`](./phase-15.md).
- The n8n integration, as it stands: [`../INTEGRATIONS.md`](../INTEGRATIONS.md);
  `packages/n8n/`; `apps/api/src/routes/n8n.ts`.
- The MCP runtime and its restrictions: `packages/mcp/README.md`;
  `packages/core/src/mcp-manifest.ts`.
- Tools, agents and grants: [`../SKILLS.md`](../SKILLS.md);
  `packages/agents/src/agent-policy.ts`.
- Durable execution: [`../architecture/JARVIS_TASK_LIFECYCLE_V2.md`](../architecture/JARVIS_TASK_LIFECYCLE_V2.md).
- Capability status: [`../JARVIS_CAPABILITY_MATRIX.md`](../JARVIS_CAPABILITY_MATRIX.md).
- Documentation rules: [`../DOCUMENTATION_PROTOCOL.md`](../DOCUMENTATION_PROTOCOL.md).

---

## 13. Development checkpoint — end of day, 2026-10-14

State another session needs to resume Phase 16: **verified facts**, then the
blocker, the exact next action, and what is *not* known.

### Verified facts

- **Git.** Branch `main`; HEAD `7b0e79123cf8720905e2b518ddfc8316e471c004` —
  the merge of Phase 15 (Marketing OS) pull request **#7** (`ffb8536` is the
  phase commit) — identical to `origin/main`. No staged changes and no stash;
  the only working-tree changes are this untracked file and the modified ledger
  from this planning session.
- **Phase 15 is merged** into `main` (PR #7, commit `7b0e791`).
- **Phase 16 is planned, not built.** This file is the only Phase 16 artefact.
  No M1 code exists: a repository-wide search found **no**
  `WorkflowIntelligenceService`, `workflow-tools.ts`, `workflow-diff.ts`,
  `workflow-validation.ts`, `workflow-recommendations.ts`,
  `workflow.catalog.list`, or `/api/v1/workflows` router.
- **M0 ran and is blocked** (see "M0 result", above): at audit time there was no
  `N8N_*` configuration and nothing reachable, and `N8nWorkflow` / `N8nExecution`
  each held **0** rows.
- **The environment changed after M0.** The root `.env` now holds **4 active
  `N8N_*` entries**: `N8N_BASE_URL` (**still the placeholder
  `https://YOUR-N8N-DOMAIN`**), `N8N_API_KEY` (set), `N8N_CALLBACK_SECRET`
  (set), `N8N_TIMEOUT_MS=15000`. No secret value was read into this document.
- **The running API is still unconfigured.** The `jarvis-docker-api` container
  exposes **no** `N8N_*` variable: `.env` was edited after it started and it has
  **not** been recreated. `docker-compose.yml` passes the root `.env` to each
  service via `env_file`, so a recreate would apply the change.
- **Registry still empty.** `N8nWorkflow` = 0 and `N8nExecution` = 0 rows,
  re-checked at this checkpoint.
- **Nothing was executed.** No workflow was activated, modified, executed or
  triggered, and no read-only n8n probe was run in this checkpoint. The
  documented read-only target remains `GET /api/v1/workflows?limit=1`
  (`apps/api/src/services/integration-registry.ts:749`).

### Completed today

1. Phase 15 merge confirmed on `main`.
2. The Phase 16 plan written (`docs/phases/phase-16.md`) and reviewed.
3. M0 read-only verification attempted; the blocker recorded with evidence.

### Blocker

The deployment is **not connected to n8n**: `N8N_BASE_URL` is a placeholder, and
the running API container does not carry the new variables. No read-only
verification is possible until a real, reachable origin is set and the API is
recreated.

### Exact next action (next session)

1. Replace `N8N_BASE_URL` in `.env` with the self-hosted n8n VPS origin (leave
   the API key and the callback secret as configured; never print or commit
   them).
2. Recreate **only** the API container so it picks up the root `.env` —
   `docker compose up -d --no-deps api` — and confirm `N8N_BASE_URL`,
   `N8N_API_KEY` and `N8N_CALLBACK_SECRET` are present **by name** in the
   container.
3. Re-run M0 read-only: `GET {origin}/api/v1/workflows?limit=1` with
   `X-N8N-API-KEY`, then `GET {origin}/api/v1/workflows` (catalogue) and
   `GET {origin}/api/v1/workflows/{id}` (one definition). Record status codes
   and sanitized shapes only — no payload values, no secrets.
4. Begin M1 only after M0 passes.

**Proposed, not yet done.** Steps 1–4 are the plan's proposal; none has been
executed.

### Unverified

- The n8n server version, and whether the configured key may list or edit
  workflows.
- Whether any workflow exists on the VPS (JARVIS's own registry holds none).
- Whether the placeholder origin has been replaced with a real host.

### Tests run

**None.** This checkpoint changed documentation only; no test suite ran and no
application code was touched.

---

## 14. Implementation — 2026-10-15 (dual-connector architecture, M1 groundwork)

This section records what was **built** on 2026-10-15, on top of the plan
above. It is deliberately separate from §8's milestones: it is the foundation
M1 rests on, not M1 itself.

### What was built

A dual-connector architecture for n8n: the existing REST surface is kept and
extended, and a second, opt-in MCP surface is added beside it, with one shared
**Automation Registry** in `@jarvis/core` that normalizes both and decides which
connector answers which operation.

```
  n8n REST  ──┐
              ├──► Automation Registry (core, pure) ──► routing decision
  n8n MCP   ──┘
```

### Files

**New**

| File | Purpose |
|---|---|
| `packages/core/src/automation-registry.ts` | Pure registry: normalize a REST workflow and a discovered MCP tool into one `AutomationRecord`, deduplicate (a REST workflow and an MCP tool naming the same provider workflow id become ONE record with both handles), and resolve which connector serves an operation. |
| `packages/core/test/automation-registry.test.ts` | 18 tests. |
| `packages/mcp/src/http-connection.ts` | The **second** MCP transport: Streamable HTTP, for a server JARVIS does not spawn and cannot review. SSRF-checked (HTTPS only, no embedded credentials, allowed-origin containment), bounded by per-operation deadlines, `fetch` injectable. |
| `packages/mcp/test/http-connection-s8.test.ts` | 20 tests. |
| `packages/n8n/src/api-client.ts` | The read-only REST client (`X-N8N-API-KEY`, `{ data, nextCursor }` pagination, errors as values). |
| `packages/n8n/src/mcp-config.ts` | MCP environment config: endpoint derivation, allowed origins, the enabled/configured switches. |
| `packages/n8n/src/mcp-connector.ts` | The n8n MCP connector: `discoverTools`, discovery-gated `invokeTool`, `close`. The transport is **injected**, so the package stays SDK-free. |
| `packages/n8n/test/n8n-api.test.ts`, `packages/n8n/test/n8n-mcp.test.ts` | 36 tests in the MCP file. |

**Changed**

| File | Change |
|---|---|
| `packages/core/src/index.ts` | Export the automation registry. |
| `packages/core/src/integration-catalog.ts` | The n8n descriptor records why the optional `N8N_MCP_*` vars are deliberately **not** in its all-must-be-present `envVars`. |
| `packages/mcp/src/index.ts` | Export the HTTP transport. |
| `packages/mcp/test/boundaries-s8.test.ts` | The SDK allow-list is widened, deliberately and documented: the client, the two client transports (`index`, `streamableHttp`), the HTTP auth helper, the shared modules and the types. `server/*` stays banned (JARVIS is never an MCP server) and `client/stdio.js` stays banned (JARVIS keeps its own stdio framing). |
| `packages/n8n/src/index.ts` | Export both new modules. |
| `packages/n8n/src/provider.ts` | `N8nApiProvider`: a read-only management surface (check, list workflows, list executions, get execution) on the same provider. |
| `packages/config/src/index.ts` | The five `N8N_MCP_*` variables, beside the REST block. |
| `apps/api/src/services/integration-registry.ts` | `testN8n` now performs its read through the same provider the trigger tool uses; `readN8nBaseUrl` separates "configured" from "configured wrongly". |
| `apps/api/src/services/container.ts` | Builds the connector when `isN8nMcpConfigured()`, holds it, exposes `getN8nMcpConnector()`, clears it on reset. |
| `apps/api/src/index.ts` | Closes the connector during `RELEASE_RESOURCES`. |
| `.env.example`, `docs/INTEGRATIONS.md` | The five variables, documented; the OAuth-vs-API-key distinction stated. |

### Why MCP is a second transport, not the existing one

The existing `@jarvis/mcp` runtime is **stdio-only and manifest-verified**:
servers are reviewed in code, pinned by fingerprint, and fail closed on drift.
The n8n MCP server is the opposite — it is discovered at runtime and was never
reviewed. Forcing it through that runtime would either weaken the review
guarantee or require inventing a manifest for tools that change without a code
review. So a separate `HttpMcpConnection` was added that **never claims a
discovered tool was reviewed**, and the approval boundary lives above it.

### Routing

Operation-based, in core's pure `resolveAutomationRoute`:

| Operation | Preference |
|---|---|
| `list`, `describe` | REST first |
| `monitor`, `manage` | REST only — a discovered tool carries neither |
| `execute` | MCP first, REST fallback |

### Live verification (read-only — 2026-10-15)

- **REST is blocked.** `checkConnection()` against the configured origin returns
  **HTTP 401** (`AUTHENTICATION_REQUIRED`). The stored `N8N_API_KEY` is 49
  characters with no dots and is not a JWT shape, so it is not a valid n8n Cloud
  key. No workflows were read, activated, modified, executed or deleted.
- **MCP needs OAuth, not the REST key.** `GET /mcp-server/http` answers `401`
  with `WWW-Authenticate: Bearer realm="n8n MCP Server"`. Its public metadata
  (`/.well-known/oauth-protected-resource/mcp-server/http`, RFC 9728, and
  `/.well-known/oauth-authorization-server`, RFC 8414) advertises
  `authorization_code` + PKCE (S256) + dynamic client registration, at
  `/mcp-oauth/authorize`, `/mcp-oauth/token`, `/mcp-oauth/register`, with scopes
  `workflow:read` / `workflow:write` / `workflow:execute` / `execution:read`.
  `POST` with the REST API key answers `500`. **There is no static-token grant**,
  so a bearer token cannot be obtained without interactive consent.

### Environment variables (names only — no values)

`N8N_MCP_ENABLED`, `N8N_MCP_TOKEN`, `N8N_MCP_ENDPOINT`, `N8N_MCP_ALLOWED_ORIGINS`,
`N8N_MCP_TIMEOUT_MS`. The endpoint is derived as `N8N_BASE_URL` +
`/mcp-server/http`; off unless `N8N_MCP_ENABLED` is exactly `true`.

### Tests run (2026-10-15)

| Scope | Result |
|---|---|
| `@jarvis/core` | 2,167 passed / 0 failed on a clean run; `automation-registry` 18/18. One **flaky, pre-existing** test (`evidence-builder.test.ts`, asserts two wall-clock `builtAt` values differ) fails ~50% of runs — unrelated to this work and untouched by it. |
| `@jarvis/mcp` | 138 passed / 1 failed. The failure is the **pre-existing** timing-sensitive `verify-s8` case ("times out a server that stopped answering"); that file imports only `connection.ts` and `config.ts`, both byte-identical to HEAD, and does not load the new file at all. The new `http-connection-s8` file is 20/20 and the boundaries guard passes. |
| `@jarvis/n8n` | 128 passed / 0 failed (`n8n-mcp` 36/36). |
| `apps/api` (MCP wiring, container) | 37 passed / 0 failed. |
| `apps/api` (integration parity, MCP integration) | 72 passed / 1 failed — the **pre-existing** stdio connect-deadline case ("expected `ERROR` to be `CONNECTED`"). |
| `pnpm typecheck` | Clean (exit 0). |
| `pnpm lint` | Clean (exit 0). |
| `pnpm build` | Clean (exit 0), including the Next.js production build. |
| **Full suite** — `turbo run test --concurrency=1 --continue`, `DATABASE_URL` cleared | 32 of 35 workspaces pass; **9,226 tests pass, 4 fail, 0 new**. The four are the three MCP timing cases and the `evidence-builder` flake below. Database-backed suites skip cleanly without a database (`@jarvis/db` 85 passed / 280 skipped, `@jarvis/memory` 96 skipped, `@jarvis/api` 202 skipped). |

The four failures a full local run leaves, none caused by this work:

| Failure | Why it is not ours |
|---|---|
| `@jarvis/mcp` `verify-s8` — "times out a server that stopped answering" | Named in `docs/phases/phase-15.md` §15 as Windows-only in full-suite runs; its file imports only `connection.ts` and `config.ts`, byte-identical to HEAD. |
| `@jarvis/api` `mcp-integration-s8` — "is ERROR — timed out" | Same, named in §15. |
| `@jarvis/api` `mcp-pilot-failures-s8` — "ToolExecutor's deadline ends the call" | Same, named in §15. |
| `@jarvis/core` `evidence-builder` — two wall-clock `builtAt` values compared with `not.toBe` | Proven flaky in isolation (2 fail / 2 pass across 4 direct runs) on an unmodified file; a real, minor test defect, noted rather than silently changed. |

The `N8N_MCP_ENABLED` switch is unset in `.env`, so the new container block
never executes during tests — it cannot have affected any existing test.

### Rebuild and verify

Building is required because the apps resolve `@jarvis/core`, `@jarvis/mcp` and
`@jarvis/n8n` from their `dist` output:

```bash
pnpm --filter @jarvis/core --filter @jarvis/mcp --filter @jarvis/n8n --filter @jarvis/config build
docker compose up -d --no-deps api        # apply new code + .env to the API only
```

For a fresh image instead:

```bash
docker compose up -d --build api
```

### Blockers (unchanged by this work)

1. **A valid n8n REST key** is needed; the stored one is rejected with 401.
2. **An OAuth 2.1 grant** is needed for MCP; there is no static-token grant, so
   this requires an interactive consent flow that this task did not perform.

Because of (2), the MCP surface is **implemented and wired but not live-verified
against a real tool list**. Its behaviour is pinned by the injected-transport
tests, and it reports `AUTH_FAILURE` honestly when discovery cannot authenticate.

### Not done, deliberately

- **No invocation tool was added to an agent allowlist.** Invoking an n8n MCP
  tool is an external write, so it must be approval-gated; that tool, its
  approval path and its allowlist decision are M1's work, and cannot be verified
  live until the OAuth grant above exists.
- **No workflow was read, activated, modified, executed or deleted**, and no
  production workflow was touched. All live probes were read-only.

---

*Status: PARTIAL — 2026-10-15. The dual-connector foundation of §14 is built,
typechecked, linted, built and tested; the live n8n surfaces remain blocked (REST
401, MCP OAuth). No migration was written or run, no workflow was read,
activated, modified, executed or triggered, and nothing was committed, pushed,
merged or opened as a pull request by this task.*

