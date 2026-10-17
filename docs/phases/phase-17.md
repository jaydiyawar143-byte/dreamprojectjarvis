# Phase 17 — hybrid capability-based REST/MCP authorization

**Status: STAGE 0 (audit) COMPLETE, STAGE 1 (Permission and Risk Engine)
COMPLETE, 2026-10-16. STAGE 2 (wiring into the n8n MCP read routes) COMPLETE
AND AWAITING REVIEW, 2026-10-17 — uncommitted. STAGE 3A (the tenant /
Organization foundation) IMPLEMENTED AND REVIEWED, and the review's pre-merge
fixes APPLIED, 2026-10-17 — uncommitted, not deployed (§7).** Stage 3B (the
Durable Execution Ledger) is not started; nothing proceeds until the fixes are
accepted and Stage 3A is merged.

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

## 6. Stage 2 — the engine wired into the n8n MCP read routes

`GET /api/v1/n8n/mcp/tools` and `GET /api/v1/n8n/mcp/automations`
(`apps/api/src/routes/n8n-mcp.ts`) now consult `authorizeAutomationOperation`
on every request, after `requireAuth` and **before** the limiter, the
connector accessor and discovery. Nothing else changed: no tool, no agent
allowlist, no connector, no catalog builder, no `packages/security` change.

**The request path:**

```
requireAuth → server-only fields refused → engine + route invariants → limiter → connector → discovery
```

**What the route supplies to the engine — all from the server:**

| Input | Value | Source |
|---|---|---|
| `subject.auth` | `req.auth` (`userId`, `role`, `email`) | the verified access token (`requireAuth`) |
| `subject.agentId` | none | an HTTP session carries no agent context; no request field can supply one |
| `operation` | `list` for both routes (`N8N_MCP_ROUTE_OPERATIONS`) | a literal in the route |
| `scope` | `{ ownerUserId: req.auth.userId }` (`defaultN8nMcpScope`) | resolved server-side through the `resolveScope` dependency |
| `connectors` | MCP alone, `operations: ["list"]` | declared statically by the route |

**Why MCP alone.** `list` prefers REST, and every role holds `rest:read`.
Offering both surfaces would let a `member` be approved on REST and then be
served MCP discovery — a fallback that bypasses `mcp:read`. With MCP alone
there is nothing to fall back to.

**Route invariants on top of an allowed decision** (`authorizeN8nMcpRead`),
each of which stands even if the declared surface is ever widened:

- the operation is one of `N8N_MCP_READ_OPERATIONS` (exactly `["list"]`);
  `describe` is read-only but unused here, so it is refused too;
- `risk` is `READ_ONLY` and `requiresApproval` is `false`;
- the decision names `surface: "mcp"` and `capability: "mcp:read"`.

**Request-supplied scope is refused, never obeyed.** A query or body that
carries `operation`, `userId`, `ownerUserId` or `agentId` is answered `400
REQUEST_SCOPE_REFUSED` — the marketing precedent for a `projectId` naming
another project. The value is neither echoed nor audited.

**HTTP mapping.**

| Outcome | Status | Code |
|---|---|---|
| no session / bad token (`requireAuth`) | 401 | `AUTHENTICATION_REQUIRED` (unchanged) |
| engine `IDENTITY_REQUIRED` (e.g. empty user id) | 401 | `AUTHENTICATION_REQUIRED` |
| request names an operation, owner or agent | 400 | `REQUEST_SCOPE_REFUSED` |
| any other engine refusal | 403 | the engine's code (`ROLE_UNRECOGNIZED`, `SURFACE_PERMISSION_DENIED`, `SCOPE_OWNER_MISMATCH`, `AGENT_CONTEXT_REQUIRED`, `AGENT_SCOPE_MISMATCH`, `OPERATION_UNKNOWN`, …) and its fixed sentence |
| allowed, but not a read-only listed operation | 403 | `OPERATION_NOT_PERMITTED` |
| allowed, but not `mcp:read` | 403 | `SURFACE_PERMISSION_DENIED` |

With the role table from Stage 1, `owner`/`admin` are served; `member`/`viewer`
receive `403 SURFACE_PERMISSION_DENIED`.

**Audit, rate limit, safe errors — preserved.** A refusal with a user id is
audited like every other attempt: `n8n_mcp.<bucket>`, result `rejected`,
metadata `{ authz: <code> }` and nothing else. Because the limiter counts those
rows, refusals count against the same per-user budget. An authorized request
is metered, audited and answered exactly as before (429, 404
`MCP_NOT_CONFIGURED`, 502/503/504 with fixed sentences). Authorization runs
first, so a refused caller does not learn whether the surface is configured.

### Stage 2 files

| File | Change |
|---|---|
| `apps/api/src/routes/n8n-mcp.ts` | Phase 16 file (still uncommitted); Stage 2 adds the header section, `N8N_MCP_ROUTE_OPERATIONS`, `N8N_MCP_READ_OPERATIONS`, `defaultN8nMcpScope`, `authorizeN8nMcpRead`, the `resolveScope` dependency and one `authorize` call per route |
| `apps/api/test/n8n-mcp-authz-p17.test.ts` | new — the Stage 2 route tests |
| `docs/phases/phase-17.md` | this section |

### Stage 2 verification (2026-10-17, Windows, no database)

| Command | Result |
|---|---|
| `pnpm --filter @jarvis/api exec vitest run n8n-mcp-authz-p17 n8n-mcp-discovery` | **79 passed / 0 failed** — 65 new, 14 Phase 16 discovery tests unchanged |
| `pnpm --filter @jarvis/security test` | 112 passed / 0 failed (no `packages/security` change) |
| `pnpm --filter @jarvis/n8n test` | 135 passed / 0 failed |
| `pnpm --filter @jarvis/core exec vitest run mcp-boundaries automation-registry` | 28 passed / 0 failed (the MCP boundary list is unchanged: no new `apps/api/src` file references MCP) |
| `pnpm --filter @jarvis/api test` | **2,450 passed / 0 failed / 202 skipped** (99 files; the skips are the PostgreSQL-backed files, with no database) |
| `pnpm typecheck` | 37/37 tasks clean |
| `pnpm --filter @jarvis/api typecheck:tests` | clean |
| `pnpm lint` | 20/20 tasks clean |
| `pnpm build` | 20/20 tasks |

**The tests catch a regression — checked by mutation, then reverted:**
offering REST as a fallback surface failed 12 tests (the `mcp:read` invariant
refuses a REST decision even for an owner, and members stay refused); removing
the authorization call from `/tools` failed 16.

**What the 65 tests cover**, on both routes: owner/admin served with discovery
called once and invoke never; no session, a non-JARVIS token, and an empty user
id refused before audit, limiter or connector; `member`/`viewer` refused
`SURFACE_PERMISSION_DENIED` with no REST borrowing; an unknown role; refusal
before the configuration check; server-resolved owner mismatch (even for
`owner`); `?userId`, `?ownerUserId`, a body owner, `?agentId` (even the
matching one) and `?operation=execute|manage|…` refused with nothing echoed or
audited; agent-scoped resource refused for lack of context; the 429, 404, 502
fixed-sentence paths unchanged; refusals audited under the route's own action;
and, directly on `authorizeN8nMcpRead`, `execute`/`manage`/`describe`, unknown
operations (`""`, `LIST`, `__proto__`, `constructor`, …), absent identity,
agent mismatch/match and owner mismatch for every role. A source scan pins
that the route contains no `invokeTool`, `callTool`, executor or workflow
trigger call, and every scenario counts zero invocations.

**Pre-existing failures, not regressions.** None occurred in these runs. The
timing-sensitive MCP cases of §5 (`@jarvis/mcp` `verify-s8`, `@jarvis/api`
`mcp-integration-s8` and `mcp-pilot-failures-s8`) failed on this machine on
2026-10-16 on an unchanged tree and passed in this API run; `@jarvis/core`'s
`evidence-builder` "regardless of builtAt" case can fail when two `new Date()`
calls land in one millisecond. Stage 2 touches none of them.

### Stage 2 limitations

- **Owner scope is the session's own view.** The MCP surface is configured per
  deployment and holds no per-principal records, so the default resolver
  returns the caller's own user id and the owner check cannot fail in
  production today. The `resolveScope` seam is where a per-tenant surface must
  resolve its owner, from a trusted store; the tests drive it to prove a
  mismatch is refused.
- **No agent path.** These are HTTP routes, so no agent context exists; an
  agent-scoped resource is therefore refused (`AGENT_CONTEXT_REQUIRED`). An
  agent-side caller of discovery would have to pass `SessionContext.agentId`.
- **REST is not wired.** The REST n8n routes (`apps/api/src/routes/n8n.ts`)
  do not consult the engine yet; `rest:*` grants are therefore unexercised by
  any route. That belongs to a later stage.
- **The policy table is Stage 1's.** Whether `member` should hold `mcp:read`
  is still the flagged review question in §2; Stage 2 enforces the table as it
  stands.

## 7. Stage 3A — the tenant (Organization) foundation

**Status: IMPLEMENTED, 2026-10-17; reviewed the same day, and the review's
pre-merge fixes applied (below) — uncommitted, not deployed, not verified in
production.** Built on `docs/tenant-model-design.md`, approved with the
decisions below. Nothing was staged or committed.

### Decisions applied

| # | Decision | Where it is enforced |
|---|---|---|
| 1 | A tenant viewer cannot read MCP discovery | the grant table: `viewer` holds `rest:read` only |
| 2 | Account-wide owners/admins get no implicit tenant access | the engine never reads `auth.role`; only the membership role counts |
| 3 | Non-members get one uniform refusal; the precise reason stays internal | the route answers `TENANT_ACCESS_DENIED`; the audit row keeps the engine's code |
| 4 | The shared n8n connection's owner is a database row, set only by an operator command; missing or invalid ownership fails closed | `AutomationConnectorOwner`, the operator command, and the route's `RESOURCE_OWNERSHIP_MISSING` / `RESOURCE_OWNERSHIP_INVALID` refusals |
| 5 | No personal tenants for existing users | the migration writes no row |
| 6 | The reviewed membership grant table is the policy; no per-tenant toggle | `ROLE_GRANTS` in `automation-authz.ts` is the only table |
| 7 | "Organization" in the product, `Tenant` in code and schema | every refusal sentence says "organization"; codes and schema say tenant |

### What was built

- **Schema** (`schema.prisma`): the `TenantRole` enum, `Tenant`,
  `TenantMembership` (unique `(tenant, user)`, cascade with either side) and
  `AutomationConnectorOwner` (unique `(provider, connector)`, `RESTRICT` on its
  tenant); a relation field on `User`, no column. The schema still contains no
  MCP reference (the S8 boundary test checks).
- **Migration** `20261017120000_phase17_tenant_foundation`, generated with
  `prisma migrate diff` — additive, no backfill.
- **Contract** (`packages/core/src/types/tenant.ts`): `TenantRole`,
  `TenantMembershipContext` (tenant, user AND role, so a membership read for one
  account or tenant cannot pass for another), the two read ports, and
  `SHARED_CONNECTOR_KEYS` — the only connections whose owner may be recorded.
- **Reads** (`PrismaTenantRepository`): `findMembership(userId, tenantId)` by
  the unique key — there is no read by user alone — and `findConnectorOwner`,
  which reports `invalid` when the record's tenant cannot be resolved. No cache.
- **The only writer** (`packages/db/src/maintenance/tenant-admin.ts`) and its
  operator command (`apps/api/scripts/tenant-admin/`): create a tenant WITH its
  first owner, add/re-role/remove a member, assign/unassign the connection,
  list. Each change is one transaction with its audit row; a dry run unless
  `--execute`; every change to one tenant's memberships serialized by a row lock
  (`SELECT … FOR UPDATE`), so the last owner cannot be removed even by two
  concurrent demotions. Explicit `DATABASE_URL` + `--confirm-target`, as the
  memory backfill requires.
- **The engine** (`automation-authz.ts`): `scope.tenantId` is required,
  `subject.membership` is the caller's membership in that tenant, and grants
  come from the membership role. New refusals: `RESOURCE_OWNERSHIP_MISSING`,
  `TENANT_MEMBERSHIP_REQUIRED`, `SCOPE_TENANT_MISMATCH`. `grantsForAutomationRole`
  became `grantsForTenantRole`. Decision order: identity → operation → risk →
  ownership → membership → owner/agent → membership role → per-surface grant
  (every fallback candidate re-checked).
- **The routes** (`n8n-mcp.ts`): on every request, from the database —

  ```
  requireAuth → identity → attempt ceiling (in memory) → server-only fields refused
              → owner read → membership read → engine + Stage 2 checks → limiter → connector → discovery
  ```

  | Outcome | Status | Code to the caller | Audit `authz` |
  |---|---|---|---|
  | more than 30 attempts on that route this minute, from this account (per API instance) | 429 | `RATE_LIMITED`, with `Retry-After` | one row per window, `throttled: true`; nothing read |
  | the request names a tenant, organization, org, business, account, workspace, owner, user, agent or operation (any case or separator) | 400 | `REQUEST_SCOPE_REFUSED` | same |
  | the owner or membership cannot be read | 503 | `AUTHORIZATION_UNAVAILABLE` | same |
  | no owner recorded | 403 | `TENANT_ACCESS_DENIED` | `RESOURCE_OWNERSHIP_MISSING` |
  | an owner record that is invalid or malformed | 403 | `TENANT_ACCESS_DENIED` | `RESOURCE_OWNERSHIP_INVALID` |
  | not a member of the owning Organization (platform owners/admins included) | 403 | `TENANT_ACCESS_DENIED` | `TENANT_MEMBERSHIP_REQUIRED` |
  | a viewer of it | 403 | `SURFACE_PERMISSION_DENIED` | same |
  | an unknown membership role | 403 | `ROLE_UNRECOGNIZED` | same |
  | owner, admin or member of it | served read-only, as before | — | `success` with `tenantId` |

  A refusal row never carries a tenant id. Nothing reaches the limiter or the
  connector after any refusal, and past the attempt ceiling nothing reaches
  the database at all, apart from the one row that marks the window. A header
  is never read for scope: `X-Tenant-Id` and the like are ignored, neither
  refused nor obeyed.

### Migration and backfill

`20261017120000_phase17_tenant_foundation` creates one enum and three tables,
alters nothing and writes no row: **no account is put into an Organization**,
and every existing row stays owned by its user. A previous release never reads
the tables, so a rollback leaves them in place. After the deploy, n8n MCP
discovery refuses everyone — owners included — until an operator creates an
Organization, adds its members and assigns the connection
(`docs/DEPLOYMENT.md`, "Organizations"). The routes have never been part of a
deployed release, so no deployed behaviour changes.

### Verification (2026-10-17, Windows)

PostgreSQL runs used a throwaway `pgvector/pgvector:pg16` container on port
55433 with a random password — never the development (5432) or deployment
(5433) database — and `JARVIS_REQUIRE_POSTGRES=1`, as CI's database steps set.

| Command | Result |
|---|---|
| `prisma migrate deploy` on the fresh database | 31 migrations found, all applied, `phase17_tenant_foundation` last |
| `prisma migrate diff --from-url <db> --to-schema-datamodel schema.prisma` | no difference in the three new tables or the enum; the remaining drift is pre-existing (`_Memory_v1_backup`, defaults and foreign keys on `OutcomeRecord`, `OutcomeRevision`, `PerformanceRecommendation`) |
| `vitest run tenant-foundation-p17` (`packages/db`, PostgreSQL) | **21 passed / 0 failed / 0 skipped** |
| `vitest run` (`packages/db`, PostgreSQL) | **386 passed / 0 failed / 0 skipped** (26 files; 365 before + 21), run twice, the second on a rebuilt database |
| `pnpm --filter @jarvis/security test` | **132 passed / 0 failed** (74 untouched + 58 engine tests, up from 38) |
| `vitest run n8n-mcp-authz-p17 n8n-mcp-discovery tenant-admin-cli-p17` (`apps/api`) | **155 passed / 0 failed** — 110 organization route tests, 14 Phase 16 discovery tests, 31 operator command tests |
| `pnpm typecheck` / `pnpm --filter @jarvis/api typecheck:tests` / `pnpm lint` / `pnpm build` | 37/37 · clean · 20/20 · 20/20; the command's entry point `run.ts` compiled separately, clean |
| `turbo run test --concurrency=1 --continue` (every workspace, no database) | **9,486 passed, 1 failed, 596 skipped** — the one failure is pre-existing (below); the skips are the database-backed files. *Corrected 2026-10-17:* first reported as 9,351, a hand sum that left out `@jarvis/n8n`'s 135; the run's log, summed over all 20 workspaces, gives 9,486 |

**Mutation checks, each reverted afterwards:** removing the row lock failed 2
PostgreSQL tests (both last-owner races — the tenant was left with no owner);
running a change outside its transaction failed 6 (every audit-atomicity test
and a race); taking the role from `auth.role` instead of the membership failed
24 route tests.

**The operator command, end to end** against the throwaway database: the dry
run wrote nothing; `--execute` created the Organization with its owner; a
demotion of the only owner was refused `LAST_OWNER` (exit 65); a wrong
`--confirm-target` was refused (exit 64); `assign-connector` and `list` worked;
exactly two audit rows were written (`tenant.create`,
`tenant.connector.assign`), ids and roles only.

**What the tests hold:** cross-organization denial; viewer denial; account-wide
owner/admin non-membership; missing, invalid and malformed ownership, refused
alike and without reading a membership; the uniform answer; a membership removed
or re-roled, or the connection moved, taking effect on the next request through
the same router; read failures answered 503 before the limiter and the
connector; forged scope fields, including the true owning Organization's id;
audit atomicity for every write verb; the last-owner invariant, deterministically
and over repeated races, with two connection pools; the unique, foreign-key,
`RESTRICT` and cascade constraints; and that no runtime code imports the writer
and the repository can only read.

**Pre-existing failures, not regressions.** `@jarvis/core`'s `evidence-builder`
"identical evidenceHash … regardless of builtAt" fails when two `new Date()`
calls land in one millisecond; it failed the same way on 2026-10-16, and Stage
3A does not touch it. The timing-sensitive MCP cases of §5 passed in these runs.

### Security guarantees

- The owning Organization comes from a stored record, and the membership from
  the database, on every protected request. No request field selects either.
- On the Organization's resource, only the membership role counts. A
  platform owner or admin who is not a member is refused.
- A missing, invalid or unreadable ownership or membership refuses — before the
  limiter, the connector or discovery.
- A member's `mcp:read` implies nothing else: no write grant, and writes still
  require approval for every role. Discovery stays read-only; nothing invokes a
  tool or runs a workflow.
- Memberships and the connection's owner change only through the operator
  command, each change committed with its audit row or not at all, and no
  Organization can be left without an owner.

### Limitations and remaining risks

- **Only n8n MCP discovery is Organization-owned.** Memories, conversations,
  projects, marketing, tasks, registered n8n workflows and the n8n REST routes
  are still owned by their user and authorized by the account-wide role.
- **The last-owner rule lives in the only writer, not in the database.** A
  direct SQL edit, or a future account-deletion path (memberships cascade with
  the account), could leave an Organization without an owner. No such path
  exists today; one must transfer ownership first.
- **Authorization is decided once, when a request starts.** Discovery then runs
  under the connector's own deadlines — `N8N_MCP_TIMEOUT_MS` to connect, when no
  session is open yet, and `N8N_MCP_TIMEOUT_MS` again for the whole listing —
  so at most twice that value: 30 s by default, 240 s at the configured
  maximum. Nothing cancels it; the route passes no abort signal. A membership
  removed or re-roled, or the connection moved to another Organization, during
  that time does not stop it: the listing goes to the caller authorized at the
  start, recorded against the Organization that owned the connection then, and
  the very next request is decided on the new state. (The review stated the
  bound as one timeout; it is two.)
- **The operator command's `--as` is attribution, not authentication.** Anyone
  who can reach the database can change it anyway; the command adds the audit
  row and the guards, not access control.
- **The attempt ceiling and the rate limit are per account**, not per
  Organization, and the ceiling is per API instance and forgotten on restart
  (ip-rate-limiter.ts). One account's refusals are bounded; the total grows with
  the number of accounts, and registration is open (throttled to 5 a minute per
  address). A per-address or global ceiling would be an API-wide change.
- **Not exercised against the real stack** or a real n8n MCP server; the
  operator command ran only against the throwaway database.

### Pre-merge fixes from the security review (2026-10-17)

A read-only security and release-readiness review of Stage 3A (shared as the
doc "Stage 3A Security Review") verified 8 of its 10 required properties and
asked for the fixes below before merge. All are applied. None needed a design
decision beyond the review; one gate is narrower than asked, and says so.

| Finding | Fix | Proven by |
|---|---|---|
| **M1** — refused discovery requests were unthrottled | Every attempt, refused or not, takes a place in a per-account, per-route window held in process memory (`N8N_MCP_ATTEMPT_LIMITS`, 30 a minute, the existing `IpRateLimiter` counter) right after the identity check and before any database read or audit write. Past it the answer is 429 `RATE_LIMITED` with `Retry-After`, and nothing is read or written — except ONE audit row (`throttled: true`) and one log line per window | 16 route tests on both routes (a non-member, an unassigned connection, unreadable organization reads, forged fields, an authorized member's budget, windows per account and per route, a window's reset, identity checked first); on PostgreSQL, 50 refusals wrote 31 audit rows; mutations: the ceiling switched off failed 14 tests, one read placed before it failed 42 |
| **M2** — CI gaps | A required step `Test @jarvis/security`; `typecheck:tests` added to `@jarvis/db` and `@jarvis/security`; the API's `typecheck:tests` now covers `scripts/`, and its lint runs on `src/ scripts/` | `pnpm typecheck:tests` 20/20 and `pnpm lint` 20/20; the workflow parses, with 20 named steps |
| **L1** — an invalid owner was answered as an outage | The owner lookup reads the record, then its tenant, as two reads. A dangling record is now `invalid` instead of the error Prisma raises for it — `PrismaClientUnknownRequestError: Inconsistent query result: Field tenant is required…`, observed on the old query against a real database | PostgreSQL: a dangling and a malformed record come back `invalid` through the real repository, inside a rolled-back transaction, and the route answers 403 `TENANT_ACCESS_DENIED` with `RESOURCE_OWNERSHIP_INVALID` recorded; putting the old query back fails the test |
| **L2** — headers | Documented and tested: apart from `Authorization` (read by `requireAuth`), the route reads no header. A header naming a tenant, organization, owner or agent is ignored — neither refused nor obeyed | 6 route tests (an outsider naming the owning Organization, a member naming another, identical answers with and without the headers) and a source check that the route never reads `req.headers`, `req.get` or `req.header` |
| **L3** — in-flight semantics | Documented (Limitations above, and the route's header): decided once at the start; up to twice `N8N_MCP_TIMEOUT_MS`; never cancelled; the next request follows the new state | 6 deterministic route tests: a membership removed and the owner moved while a discovery waits — the started listing completes for its caller and is recorded against the Organization that owned the connection then, the next request is refused, and no abort signal is passed |

**Narrower than asked — the test-file typecheck.** In `@jarvis/db` and
`@jarvis/security` it covers the Phase 17 test files and all sources; their
older test files have 15 pre-existing type errors (13 in seven Phase 10–11
files of `@jarvis/db`, 2 in two files of `@jarvis/security`) and are not yet
gated. In `apps/api` it covers every script except `scripts/phase116b`, whose
four files have 23 errors: they no longer match the code they call — for
example, wrong argument counts — and whether to repair or retire them is a
separate decision. Lint covers all of `scripts/`.

**Verification of the fixes** (2026-10-17, Windows, Node 24.20.0, on the
working tree as it stands; turbo's cache bypassed with `--force`, so nothing
below is a replay). PostgreSQL runs used brand-new `pgvector/pgvector:pg16`
containers with a random password, every migration applied — never the
development (5432) or deployment (5433) database — and
`JARVIS_REQUIRE_POSTGRES=1` wherever CI sets it. The full run below had no
`DATABASE_URL`: every database-backed file skipped, as designed.

| Command | Result |
|---|---|
| `vitest run n8n-mcp-authz-p17 n8n-mcp-discovery tenant-admin-cli-p17` (`apps/api`) | **184 passed / 0 failed** — 139 organization route tests (110 + 29 for M1, L2 and L3), 14 Phase 16 discovery tests, 31 operator command tests |
| `vitest run tenant-foundation-p17` (`packages/db`, PostgreSQL) | **22 passed / 0 failed / 0 skipped** (21 + the L1 test) |
| `vitest run n8n-mcp-tenancy-p17-pg` (`apps/api`, PostgreSQL, new) | **5 passed / 0 failed / 0 skipped** — the route over the real repository and audit logger |
| `pnpm --filter @jarvis/security test` | **132 passed / 0 failed** |
| CI's database steps, replayed in order (`docs/DEVELOPMENT.md`, "Continuous integration") | 31 migrations applied; `@jarvis/db` **387/387** (26 files), `@jarvis/memory` 93/93 (9), `@jarvis/api` **220/220** (8), the evaluation 13/13; the skip check: 0 not run in all four reports |
| `pnpm typecheck` / `pnpm typecheck:tests` / `pnpm lint` / `pnpm build` | 37/37 · 20/20 · 20/20 · 20/20, none cached |
| `turbo run test --concurrency=1 --continue --force` (every workspace, no database) | **9,515 passed, 1 failed, 602 skipped** (20 workspaces) — 29 more passing than Stage 3A's run (the new route tests), 6 more skipped (the new and extended database tests); the failure is pre-existing (below) |

**Pre-existing failure, not a regression.** `apps/api`'s `mcp-integration-s8`
"is ERROR — timed out — when a running server stops answering" failed under
the full run's load — one of the timing-sensitive MCP cases of §5, which give
a real stdio server 500 ms and fail on this machine on clean `main` too. Run
alone right after, its file passed 42/42, three times in a row. Nothing here
touches the MCP Servers integration.

### H1 — the pull request this needs

Stage 3A cannot be merged on its own: the route it changes is Phase 16's
uncommitted, untracked file, and the working tree also holds the unrelated
OmniRoute integration. Nothing was moved, staged or committed. The coherent
split is two pull requests; five files hold both and are staged hunk by hunk
(`git add -p`) — each of their hunks belongs wholly to one side.

**PR 1 — the n8n MCP read routes (Phase 16) and Phase 17, together.** One PR:
`apps/api/src/routes/n8n-mcp.ts` holds Phase 16's routes and Phase 17's
authorization in one untracked file, and no Phase 16-only version of it exists.

| Part | Files |
|---|---|
| Phase 16 | `apps/api/src/routes/n8n-mcp.ts` *(untracked)*, `apps/api/src/index.ts` (the mount), `apps/api/src/services/rate-limiter.ts` (`n8n_mcp`), `apps/api/test/n8n-mcp-discovery.test.ts` *(untracked)*, `packages/n8n/src/automation-catalog.ts` and `packages/n8n/test/automation-catalog.test.ts` *(untracked)*, `packages/n8n/src/index.ts`, `packages/n8n/src/mcp-config.ts`, `packages/core/test/mcp-boundaries-s8.test.ts`, `docs/n8n-mcp-execution-architecture.md` *(untracked)*, `docs/phases/phase-16.md`; and the `N8N_MCP_TOKEN` wording hunks of `.env.example`, `packages/config/src/index.ts` and `docs/INTEGRATIONS.md` |
| Phase 17 — engine and contract | `packages/security/src/automation-authz.ts`, `packages/security/src/index.ts`, `packages/security/test/automation-authz.test.ts`, `packages/security/package.json`, `packages/security/tsconfig.test.json` *(untracked)*, `packages/core/src/types/tenant.ts` *(untracked)*, `packages/core/src/index.ts` |
| Phase 17 — database | `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261017120000_phase17_tenant_foundation/` *(untracked)*, `packages/db/src/repositories/tenant-repository.ts` and `packages/db/src/maintenance/tenant-admin.ts` *(untracked)*, `packages/db/src/index.ts`, `packages/db/test/tenant-foundation-p17-pg.integration.test.ts` *(untracked)*, `packages/db/package.json`, `packages/db/tsconfig.test.json` *(untracked)* |
| Phase 17 — API | `apps/api/src/services/container.ts`, `apps/api/scripts/tenant-admin/` *(untracked)*, `apps/api/test/n8n-mcp-authz-p17.test.ts`, `apps/api/test/tenant-admin-cli-p17.test.ts` and `apps/api/test/n8n-mcp-tenancy-p17-pg.integration.test.ts` *(untracked)*, `apps/api/tsconfig.test.json`; and the `lint` hunk of `apps/api/package.json` |
| Phase 17 — CI and docs | the two Phase 17 hunks of `.github/workflows/ci.yml` (the header paragraph and the `Test @jarvis/security` step); `docs/phases/phase-17.md`, `docs/tenant-model-design.md` *(untracked)*, `docs/DEPLOYMENT.md`, `docs/DEVELOPMENT.md` |

`pnpm-lock.yaml` is **not** part of PR 1: Phases 16 and 17 add no dependency,
so PR 1 keeps the committed lockfile, and CI's `--frozen-lockfile` holds.

**PR 2 — OmniRoute, on its own:** `packages/omniroute/` *(untracked)*,
`AGENTS.md`, `Dockerfile`, `pnpm-lock.yaml`,
`apps/api/src/services/integration-registry.ts`,
`apps/api/src/services/integrations/command-service.ts`,
`apps/api/src/services/integrations/environment.ts`,
`apps/api/test/integration-command-parity.test.ts`,
`apps/api/test/integration-control-center.test.ts`,
`apps/web/src/app/integrations/page.tsx`, `apps/web/src/lib/api.ts`,
`packages/core/src/integration-catalog.ts`,
`packages/core/src/types/integration.ts`; and the OmniRoute hunks of
`.env.example`, `packages/config/src/index.ts`, `docs/INTEGRATIONS.md`,
`apps/api/package.json` (the `@jarvis/omniroute` dependency) and
`.github/workflows/ci.yml` (the header's package list and the
`Test @jarvis/omniroute` step). Neither PR needs the other.

### Blockers for any multi-tenant launch — H2, M3, L11 (not fixed here)

These are pre-existing and outside Stage 3A, and they block running JARVIS for
more than one business — or with open registration — wherever the shared
integrations are configured:

- **H2.** Any account can read and change the operator's Meta ad account: the
  Meta tools hold the deployment's `META_ACCESS_TOKEN`
  (`apps/api/src/services/container.ts`), the account-wide `member` role passes
  the tool check (`packages/tools/src/executor.ts`), and the account that asks
  for a write also approves it (`apps/api/src/routes/approvals.ts`).
  Registration is open. Critical wherever `META_*` is set.
- **M3.** Any account can run connection tests that spend the shared
  credentials — the n8n key, the WhatsApp token, the Maps quota, the Meta
  token, the reviewed MCP servers' start-up, the OmniRoute key
  (`apps/api/src/routes/integrations.ts`).
- **L11.** Every account sees the operator's identifiers: the n8n base URL, the
  WhatsApp phone number id, the Meta ad account id, the OmniRoute base URL and
  the MCP server ids (`apps/api/src/services/integration-registry.ts`).

**Proposed separate stage.** Make the deployment-wide integrations (Maps,
WhatsApp, n8n REST and MCP, MCP Servers, OmniRoute, the Meta environment
fallback) Organization-owned with the same owner rows and operator command;
enforce it in `IntegrationCommandService`, so a button and a sentence get the
same check, with one uniform answer and no identifiers for non-members; allow
connection tests only to the owning Organization's owners and admins, refused
before any outbound call, with a per-Organization budget; require membership
with a write grant for shared-credential tools, Meta first, in chat as on the
page, and decide whether multi-tenant mode drops the Meta environment
fallback; decide who may approve a write on an Organization's resource (no
self-approval by members) and whether registration stays open; and test
button/voice parity, cross-Organization denial, no platform-role bypass, no
identifier leakage and zero provider calls after a refusal. Per-Organization
credentials stay a later phase.

### Stage 3A files

| File | Change |
|---|---|
| `packages/db/prisma/schema.prisma` | enum, three models, `User` relation field |
| `packages/db/prisma/migrations/20261017120000_phase17_tenant_foundation/migration.sql` | new |
| `packages/db/src/repositories/tenant-repository.ts` | new — reads; the owner lookup as two reads (L1) |
| `packages/db/src/maintenance/tenant-admin.ts` | new — the only writer |
| `packages/db/src/index.ts` | exports |
| `packages/db/test/tenant-foundation-p17-pg.integration.test.ts` | new — PostgreSQL, with the dangling-owner test (L1) |
| `packages/db/package.json`, `packages/db/tsconfig.test.json` | `typecheck:tests` (M2) |
| `packages/core/src/types/tenant.ts`, `packages/core/src/index.ts` | new contract, export |
| `packages/security/src/automation-authz.ts`, `packages/security/src/index.ts` | engine, export |
| `packages/security/test/automation-authz.test.ts` | rewritten to the new contract (see below) |
| `packages/security/package.json`, `packages/security/tsconfig.test.json` | `typecheck:tests` (M2) |
| `apps/api/src/routes/n8n-mcp.ts` | Organization reads, uniform refusal, forged fields; the attempt ceiling (M1); headers and in-flight documented (L2, L3) |
| `apps/api/src/services/container.ts` | `tenantRepo` |
| `apps/api/scripts/tenant-admin/tenant-admin-cli.ts`, `run.ts` | new — operator command |
| `apps/api/test/n8n-mcp-authz-p17.test.ts` | rewritten for Stage 3A; M1, L2 and L3 tests |
| `apps/api/test/n8n-mcp-tenancy-p17-pg.integration.test.ts` | new — the route on the real reads and audit log, PostgreSQL |
| `apps/api/test/tenant-admin-cli-p17.test.ts` | new |
| `apps/api/test/n8n-mcp-discovery.test.ts` | Phase 16's file: the harness now injects an owning Organization; no assertion changed |
| `apps/api/tsconfig.test.json`, `apps/api/package.json` (`lint`) | scripts type-checked and linted (M2) |
| `.github/workflows/ci.yml` | `Test @jarvis/security`; header (M2) |
| `docs/phases/phase-17.md`, `docs/tenant-model-design.md`, `docs/DEPLOYMENT.md`, `docs/DEVELOPMENT.md` | this record, design status, runbook, CI record |

**Tests that changed meaning, and why.** Two Stage 1 assertions changed with
the approved policy: `member` now holds `mcp:read`, so "member holds REST read
only" became "member holds REST and MCP read, no write", and "rest:read is not
mcp:read" is now pinned with `viewer`. Every other Stage 1 and Stage 2 property
is still asserted, against the tenant contract. No test was removed or skipped
to make the suite pass.

### How Stage 3A started — the preflight blocker

**The confirmed policy.** A multi-tenant SaaS: each business is a separate
ownership and data boundary; owner, admin and member may read MCP, subject to
explicit policy and tenant membership; members receive no write or
external-side-effect permission; writes need approval; production execution
stays disabled.

**The blocker.** The policy needs a tenant to be a member of, and the stage
spec forbids inventing a schema or trusting a client's tenant id. The preflight
found:

- no tenant, business, organization, workspace or membership model — the
  schema says *"there is no separate tenant model, the user IS the isolation
  boundary everywhere else"*;
- one account-wide role per user (`User.role`, default `MEMBER`), signed into a
  15-minute access token — no way to say "member of business A, admin of B";
- every new account created as `member` by both signup paths, and no code path
  that changes a role;
- one n8n MCP connection for the whole deployment, built from `N8N_MCP_*`, with
  no owner recorded.

Granting the account-wide `member` role `mcp:read` would therefore let every
self-registered account read the operator's n8n tool list — the cross-tenant
exposure the policy forbids. The stage stopped and reported instead.

**What happened next.** On the user's choice, `docs/tenant-model-design.md`
proposed the six decisions — tenant and membership models, existing users,
active-tenant selection, which role decides, who owns the shared connection,
and the membership lifecycle — with seven open questions. The user approved it
with the answers above, and Stage 3A was built on it.

## 8. Stages ahead (not started)

- **Stage 3B onwards** — the Durable Execution Ledger, approval binding for writes
  (Phase 16 execution spec §4–§6), then timeouts and uncertain outcomes,
  revalidation and the REST write path (spec §7–§9); writes still never go
  through MCP.
