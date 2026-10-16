# Phase 17 — hybrid capability-based REST/MCP authorization

**Status: STAGE 0 (audit) COMPLETE, STAGE 1 (Permission and Risk Engine)
COMPLETE AND AWAITING REVIEW, 2026-10-16.** Stages 2–5 are not started; per the
stage protocol nothing proceeds until Stage 1 is reviewed and verified.

| | |
|---|---|
| Architecture decision | Hybrid capability-based REST/MCP routing — the Phase 16 Automation Registry decides *which surface can do the job*; Phase 17 decides *whether this session may* |
| Permissions decision | REST and MCP hold **separate** capabilities, with explicit fallback rules — a fallback is checked on its own surface, never inherited from the surface it replaced |
| Approval decision | Writes and external side effects require approval; read-only operations follow the session's policy. The approval requirement derives from the **operation's** risk, so no surface fallback can shed it |
| Development decision | One stage implemented, tested, reviewed and verified before the next begins |
| What this stage did NOT do | No route, tool, agent, connector or catalog change; nothing is wired; nothing invokes anything; no live call to n8n; no `.env` change |

---

## 1. Stage 0 — audit

**Tree.** `main` at `origin/main`; nothing staged; 24 modified + 6 untracked,
all uncommitted: the user's OmniRoute work (integration catalogue/registry/
command-service/config/docs/web/tests, `pnpm-lock.yaml`, untracked
`packages/omniroute/`) and Phase 16's uncommitted MCP work. The OmniRoute diff
was inspected (an OpenAI-compatible AI-gateway entry claiming connection only,
no actions) and touches none of this phase's territory. No pre-existing file
was modified except this document's two additions and the ledger row.

**What Phase 16 left behind.** Read-only discovery (`GET /api/v1/n8n/mcp/tools`)
and the unified view (`/automations`), both session-authenticated, rate-limited
and audited; the Automation Registry (`packages/core/src/automation-registry.ts`)
with `resolveAutomationRoute` — capability-based routing by preference with
availability fallback; and `docs/n8n-mcp-execution-architecture.md`, whose §2–§3
(authorization, risk) existed on paper only.

**The gap this phase closes.** `resolveAutomationRoute` asks only "which
connector supports this operation?". It never asks who is calling, what role
they hold, whether the resource is theirs, or what the operation costs. Routing
by capability without an authorization layer means the first caller to wire it
up ships routing without authorization — and a fallback wired carelessly can
hand an operation to a surface nobody granted, or drop an approval on the way.

**Reusable, reused:** `AuthContext` (token-verified by `requireAuth`, never
body), `SessionContext.agentId` (server-set from the conversation row), the
`RiskLevel` enum, and — deliberately, as one shared table rather than a copy —
`RISK_REQUIRES_APPROVAL` in `packages/security/src/tool-approval.ts`, the exact
mapping `ToolExecutor`'s gate reads. Repository precedent for scope:
`findWorkflowForUser`, where the owning user id is part of the query filter,
never a post-hoc check.

## 2. Stage 1 — the Permission and Risk Engine

`packages/security/src/automation-authz.ts` — pure, no I/O, executes nothing.
One function answers: *may this session, on this surface, perform this
operation on this resource, and at what risk?*

**The decision order — each step default-denies:**

```
identity → operation → risk → scope → role → per-surface capability (grant-checked fallback)
```

1. **Identity** — a verified `AuthContext` (or refuse `IDENTITY_REQUIRED`).
   Absence is admitted, never guessed.
2. **Operation** — must be in the declared `AUTOMATION_OPERATIONS` set;
   unknown strings, non-strings, `constructor`, `__proto__` → `OPERATION_UNKNOWN`.
3. **Risk** — classified from the OPERATION in an exhaustive
   `Record<AutomationOperation, RiskLevel>`:
   `list`/`describe`/`monitor` → `READ_ONLY`; `manage` → `HIGH_IMPACT`;
   `execute` → `EXTERNAL_SIDE_EFFECT`. No classification → `RISK_UNCLASSIFIED`.
   Provider self-descriptions (`readOnly` annotations) are never consulted.
4. **Scope** — `ownerUserId` must equal the session's user (`SCOPE_OWNER_MISMATCH`
   otherwise). **No role overrides it** — `owner` holding every capability is
   still refused another principal's resource. An agent-scoped resource
   requires a matching session agent (`AGENT_CONTEXT_REQUIRED`,
   `AGENT_SCOPE_MISMATCH`).
5. **Role** — explicit table, unknown role → nothing (`ROLE_UNRECOGNIZED`).
6. **Per-surface capability, with fallback that cannot bypass:**

   | Role | `rest:read` | `rest:write` | `mcp:read` | `mcp:write` |
   |---|---|---|---|---|
   | owner | ✅ | ✅ | ✅ | ✅ |
   | admin | ✅ | ✅ | ✅ | ✅ |
   | member | ✅ | ❌ | ❌ | ❌ |
   | viewer | ✅ | ❌ | ❌ | ❌ |

   The registry names the preferred surface; if that surface lacks the grant it
   is **removed** and the registry re-consulted — every candidate passes the
   identical check, and when none holds a grant the answer is
   `SURFACE_PERMISSION_DENIED`, never the other surface. Because risk comes
   from the operation, `requiresApproval` is `true` for `manage`/`execute` on
   **every** surface — a fallback cannot shed it.

**Refusals are fixed sentences.** No deny message echoes an operation string,
a user id or an agent id — an attacker-supplied value is never reflected.

**Why the policy above (flagged for review):** `mcp:*` and `rest:write` are
owner/admin only — the reviewed-MCP precedent (execution spec §2.3: OWNER/ADMIN
for anything that reaches an instance) and read-only-first (§2.4). Changing the
policy is this one table; no other code encodes it.

## 3. What Stage 1 deliberately does not do

- **Not wired.** No route, tool, agent allowlist or connector consults the
  engine yet — wiring is Stage 2, reviewed first. The running system behaves
  exactly as after Phase 16.
- **No execution.** No `invokeTool` path exists; `docs/n8n-mcp-execution-architecture.md`
  §10 stays true in full.
- **No grant store.** Grants come from the role table only — there is no input
  a future careless caller could populate from a request body to escalate a
  capability. Per-principal stored grants, if ever needed, require a trusted
  store and their own stage.
- **No new HTTP error mapping, no rate limit, no audit row** — those belong to
  the wiring stage, where an engine decision first becomes an HTTP answer.

## 4. Verification (Stage 1)

| Check | Result |
|---|---|
| `packages/security` focused (`test/automation-authz.test.ts`) | **38 passed / 0 failed** |
| `packages/security` full suite | **112 passed / 0 failed** (74 pre-existing + 38 new; baseline confirmed 74/74 before the change) |
| `pnpm --filter @jarvis/security typecheck` | clean |
| `pnpm --filter @jarvis/security lint` | clean |
| repo-wide `pnpm typecheck` / `pnpm lint` / `pnpm build` | see §5 (recorded in the ledger row) |

The 38 tests cover the five the task requires — **allow** (read + write, with
risk and approval flags), **deny** (role without the capability),
**unknown operation** (incl. prototype-key and non-string inputs),
**cross-tenant** (owner role refused, with a matching-owner control), and
**connector-specific permissions** — plus: unknown role, absent identity,
agent scope (missing/mismatch/match), classification totality over all five
declared operations, no-echo of refusees, approval invariant across fallback,
and independent grant checks on every fallback candidate.

## 5. Known pre-existing failures (unchanged by this stage)

From `docs/phases/phase-16.md` §14/§15, re-confirmed during Phase 16: the
timing-sensitive MCP cases (`@jarvis/mcp` `verify-s8`; `@jarvis/api`
`mcp-pilot-failures-s8`, `mcp-integration-s8` under full-suite load — they pass
52/52 in isolation) and one `@jarvis/core` performance budget. None is touched
by Phase 17 Stage 1, which changes only `packages/security`.

## 6. Stages ahead (not started)

- **Stage 2** — wire the engine: the n8n MCP read routes consult it before the
  connector (with HTTP mapping, audit and rate-limit semantics decided there).
- **Stage 3** — approval binding for writes, per the Phase 16 execution spec §4.
- **Stage 4** — durable records and idempotency (spec §5–§6).
- **Stage 5** — timeouts/uncertain outcomes, revalidation and the REST write
  path (spec §7–§9); writes still never go through MCP.
