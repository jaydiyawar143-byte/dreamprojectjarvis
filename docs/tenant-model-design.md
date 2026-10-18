# Tenant model — design for review (Phase 17, Stage 3A)

**Status: APPROVED and IMPLEMENTED (Stage 3A), 2026-10-17 — uncommitted, not
deployed.** The record of what was built, how it was verified and what remains
is `docs/phases/phase-17.md` §7. The open questions (§12) were answered as
proposed, with one wording decision: the product calls a tenant an
**Organization**; code and schema keep `Tenant`.

Settled while implementing (none changes a decision below):

- **Invalid ownership** — an owner record whose tenant cannot be resolved, or
  whose stored id is malformed — fails closed exactly like a missing owner. The
  audit row tells the two apart (`RESOURCE_OWNERSHIP_INVALID` /
  `RESOURCE_OWNERSHIP_MISSING`).
- **Refusal rows carry no tenant id at all**, for members and non-members
  alike; only a served request records `tenantId` (stricter than §6).
- **"Organization" is the word in every sentence a caller reads.** Error codes
  are API contract and keep the names in §6 (`TENANT_ACCESS_DENIED`, …); the
  operator command keeps `tenant`, its internal name.
- **`create-tenant` takes its first owner** (`--owner`), so a tenant never
  exists without one.

Settled by the pre-merge security review (2026-10-17; `docs/phases/phase-17.md`
§7, "Pre-merge fixes"):

- **Every attempt is counted before the database** — 30 a minute per account
  and route, in process memory; past it, 429 with nothing read and one audit
  row per window.
- **Headers are ignored, not refused** (§2, principle 1).
- **An in-flight discovery is neither re-checked nor cancelled**; it is
  bounded by twice `N8N_MCP_TIMEOUT_MS`, and the next request is decided on
  the new state.
- **§11's exposure is a blocker for any multi-tenant launch**, with its own
  proposed stage.

Extended by the Phase 17 multi-business hardening (2026-10-18;
`docs/phases/phase-17.md` §8), with no new model: the same owner rows and
operator command now cover every shared connection; one grant table for them
(`packages/security/src/shared-connection-authz.ts`) gives owners and admins
everything and members and viewers read and status; a Meta change is approved
by another owner or admin of the Organization; and connection tests have a
per-Organization budget beside the per-account one — the one place §10's "the
limiter stays per account" no longer holds.

This answers the six decisions that stopped Stage 3A at its preflight
(`docs/phases/phase-17.md` §7): the confirmed policy — *each business is a
separate ownership and data boundary; owner, admin and member may read MCP
subject to tenant membership* — needs a tenant to be a member of, and the
codebase has none.

---

## 0. The decisions at a glance

| # | Decision | Recommendation |
|---|---|---|
| 1 | Tenant and membership models | `Tenant`, `TenantMembership (tenantId, userId, role)` with its own `TenantRole` enum, and `AutomationConnectorOwner`. One additive migration, no data written |
| 2 | Existing users | No backfill and no signup change in Stage 3A. A tenant exists only where an operator creates one |
| 3 | Choosing the active tenant | Not needed in Stage 3A: the tenant comes from the **resource**, and the access token is unchanged. A conversation's tenant and a signed selection come later (§4.3) |
| 4 | Which role decides | On a tenant-owned resource, the **membership** role, read from the database on every request. `User.role` keeps every job it has today and grants nothing on tenant resources |
| 5 | Who owns the shared n8n MCP connection | One `AutomationConnectorOwner` row per (provider, connector), set only by an operator command. No row: everyone is refused |
| 6 | Creating and changing memberships | Operator command only in Stage 3A — one transaction with its audit row per change, last owner protected. Read per request, so a change applies on the next request |

---

## 1. Why this is needed

What the codebase has today:

- **No tenant or membership model.** The schema has no tenant, business,
  organization, workspace or membership model; `Project` is "not a
  project-management system: no members" (`packages/db/prisma/schema.prisma`,
  `model Project`), and the schema states the rule directly: *"there is no
  separate tenant model, the user IS the isolation boundary everywhere else"*
  (`schema.prisma`, the `MapsUsage` header). Every repository filters by
  `userId` alone.
- **Roles belong to the account.** `User.role` (`OWNER`/`ADMIN`/`MEMBER`/
  `VIEWER`, default `MEMBER`) is one value per account, signed into the access
  token (`packages/security/src/tokens.ts`, 15-minute access tokens, 7-day
  refresh tokens), and `requireAuth` exposes `{ userId, role, email }`
  (`apps/api/src/middleware/auth.ts`).
- **Every new account is a member.** Password registration and first Google
  sign-in both create the account with `role: "member"`
  (`packages/security/src/auth-service.ts`, `register` and
  `loginWithVerifiedIdentity`). No code path changes a role.
- **The n8n MCP connection has no owner.** It is one connection for the whole
  deployment, built from `N8N_MCP_*` (`apps/api/src/services/container.ts`,
  the `isN8nMcpConfigured()` block).

So "members may read MCP" cannot be expressed. Granting the account-wide
`member` role `mcp:read` would let every self-registered account read the
operator's n8n tool list — the cross-tenant exposure the policy forbids.

---

## 2. Principles

1. **The tenant comes from the resource, never from the request.** The server
   reads which tenant owns the resource, then the caller's membership *in that
   tenant* — both ids in one query. No header, query, body, path, tool
   parameter or socket payload selects a tenant. A query or body field that
   tries is refused, never obeyed: Stage 2's rule for `operation`/`userId`/
   `ownerUserId`/`agentId`, extended to `tenantId`, `accountId`, `businessId`,
   `organizationId` and `workspaceId` (the socket layer already refuses
   `tenantId` and `accountId`, `apps/api/src/socket/socket-auth.ts`). A header
   that tries is ignored rather than refused: the routes read no header but
   `Authorization`, so it cannot be obeyed (settled by the security review,
   finding L2).
2. **On a tenant's resource, only the membership role counts.** `User.role`
   keeps its current meaning everywhere it is used and grants nothing on a
   tenant-owned resource.
3. **Ownership is a row, and no row means no access.** A resource whose owning
   tenant is not recorded is refused to everyone, platform owners included.
4. **Fail closed when the facts cannot be read.** If the owner or the
   membership cannot be read, the request is refused before any connector is
   touched — the rate-limit rule ("if the limit cannot be checked, the work is
   refused") restated for authorization.
5. **One engine.** `authorizeAutomationOperation` is extended, not joined by a
   second authorizer. It stays pure: the caller resolves ownership and
   membership through trusted reads; the engine compares them.

---

## 3. Data model

```prisma
/// A tenant's role vocabulary. Deliberately NOT `Role`: that is the
/// account-wide role and keeps its meaning. Two enums make it impossible to
/// store one where the other belongs.
enum TenantRole {
  OWNER
  ADMIN
  MEMBER
  VIEWER
}

/// A business — the ownership and data boundary for tenant-owned resources.
model Tenant {
  id        String   @id @default(cuid())
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  memberships     TenantMembership[]
  connectorOwners AutomationConnectorOwner[]
}

/// One account's membership in one tenant: the only source of a tenant role.
model TenantMembership {
  id        String     @id @default(cuid())
  tenantId  String
  userId    String
  role      TenantRole
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([tenantId, userId])
  @@index([userId])
}

/// Which tenant owns a connection configured for the whole deployment —
/// today the n8n MCP connection built from N8N_MCP_*. At most one owner per
/// (provider, connector). Written only by the operator command (§4.6).
model AutomationConnectorOwner {
  id         String   @id @default(cuid())
  providerId String   // "n8n"
  connector  String   // "mcp"; "rest" once the REST routes consult the engine
  tenantId   String
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@unique([providerId, connector])
  @@index([tenantId])
}
```

`User` gains only the relation field `tenantMemberships TenantMembership[]` —
no column.

**Migration.** One folder,
`packages/db/prisma/migrations/<timestamp>_phase17_tenant_foundation/`: a new
enum type, three new tables, their unique constraints, indexes and foreign
keys. No existing column changes and no row is written, so a previous release
starts against the migrated database unchanged (`docs/DEPLOYMENT.md` §4).

**Why these constraints.**

- `@@unique([tenantId, userId])` — one role per account per tenant, and the
  lookup key: the repository offers `findMembership(userId, tenantId)` and no
  user-only read that could be mistaken for one.
- `@@unique([providerId, connector])` — the deployment's connection has
  exactly one owner at a time.
- `onDelete: Restrict` on the connector owner — a tenant that owns the
  deployment connection cannot disappear underneath it; ownership is moved or
  removed first, on purpose.

**Rejected:** reusing `Project` as the tenant (personal by design, and the
memory contract depends on that); reusing `Role` for memberships (two
vocabularies conflated in storage).

---

## 4. The six decisions

### 4.1 Tenant and membership models

As §3.

### 4.2 Existing users — no backfill yet

Stage 3A makes only the automation surface tenant-owned. Every other kind of
data — memories, conversations, projects, marketing, tasks, registered n8n
workflows — stays owned by its user, exactly as today. The memory contract
("a memory is personal or belongs to one project of its owner") is untouched.

So nothing needs a personal tenant yet, and creating one per account now would
change both signup paths and write a backfill that nothing reads. **Stage 3A
writes no tenant and changes no signup path.** Tenants exist where an operator
creates them.

*Later, when a stage makes user data tenant-owned:* add
`Tenant.personalForUserId String? @unique`, create one personal tenant (role
`OWNER`) per existing account in that migration and in the same transaction as
every new account, and repair on login any account an older release created
without one.

### 4.3 Choosing the active tenant — not needed in Stage 3A

The MCP read routes act on one resource whose owner is recorded. The server
reads that owner, then the caller's membership in it; there is nothing for a
caller to choose. **The access token stays as it is** (`sub`, `role`, `email`).

*Later, when there are tenant-owned lists, creation and agent work:*

- **A conversation's tenant** is set once, at creation, from one of the user's
  memberships — the rule `Conversation.projectId` already follows. Agent work
  in that conversation is bound to it, so a tool cannot reach another tenant's
  resource even for a user who belongs to both.
- **An HTTP tenant selection** is a signed claim minted only by an endpoint
  that checks membership, and membership is still re-read on every request: the
  claim selects, it never authorizes.
- **Rejected:** an `X-Tenant-Id` header, or a tenant id in the path, as the
  selection — a client value one forgotten check away from being trusted.

### 4.4 Which role decides

| Decision | Role it reads |
|---|---|
| Automation operations on a tenant-owned resource (MCP discovery now) | the **membership** role |
| Tool permissions (`PermissionService`), the orchestrator's tool checks, the command center's admin view, the role passed to `ToolExecutor` by the marketing, tasks, approvals and integration routes | `User.role`, unchanged |
| A future tool that reaches a tenant resource through `ToolExecutor` | both — each must pass, neither replaces the other |

**Platform owners get no implicit tenant access.** An account whose
`User.role` is `owner` and that is not a member of tenant T is refused T's
resources. If operator support access is ever wanted, it is an explicit,
audited membership — never a bypass.

**The grant table, keyed by membership role** (the confirmed policy):

| Membership role | `rest:read` | `rest:write` | `mcp:read` | `mcp:write` |
|---|---|---|---|---|
| owner | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ✅ |
| member | ✅ | ❌ | ✅ | ❌ |
| viewer | ✅ | ❌ | ❌ | ❌ |

- A member's read grant implies nothing else: grants come only from this
  table, and there is no stored per-account grant.
- Writes still require approval (`RISK_REQUIRES_APPROVAL`), and execution stays
  disabled: no write path exists for any role.
- The viewer row follows the policy's wording, which names owner, admin and
  member for MCP read (open question Q1).

### 4.5 Who owns the shared n8n MCP connection

One `AutomationConnectorOwner` row — `providerId: "n8n"`, `connector: "mcp"`,
`tenantId` — set and changed only by the operator command. With no row, every
request is refused.

| Option | Verdict |
|---|---|
| **Database row, operator command** | **Recommended.** Foreign-key integrity, an audit row per change, no restart, and the same table serves the REST connection later |
| `N8N_MCP_TENANT_ID` environment variable | Rejected: no integrity against a deleted tenant, no audit row, a restart per change, and a generated id living in deployment config |
| Per-tenant MCP credentials | A later phase: per-tenant connector lifecycle, encrypted per-tenant credentials, an SSRF review of tenant-supplied endpoints, and an OAuth grant per tenant |

### 4.6 Creating and changing memberships

**Stage 3A: an operator command only** — no route, tool or agent creates or
changes a tenant, a membership or a connector owner (the memory "one writer"
rule, applied here). The logic lives in `packages/db/src/maintenance/`, the
entry point in `apps/api/scripts/tenant-admin/`, following the memory vector
backfill.

| Verb | Effect |
|---|---|
| `create-tenant --name --owner` | a tenant, together with its first owner |
| `add-member --tenant --user --role` | a membership |
| `set-role --tenant --user --role` | a membership's role |
| `remove-member --tenant --user` | removes a membership |
| `assign-connector --provider n8n --connector mcp --tenant` | sets or moves the owner |
| `unassign-connector --provider n8n --connector mcp` | removes the owner |
| `list --tenant` | read-only |

- **A dry run by default;** `--execute` writes.
- **Each write is one transaction with its audit row** (`tenant.<verb>`,
  attributed to an existing account the operator names with `--as`). If the
  row cannot be written, the change is not made.
- **A tenant always keeps an owner.** `set-role` and `remove-member` refuse to
  leave a tenant without an `OWNER`, checked under a row lock inside the same
  transaction, so two demotions arriving together cannot both pass.

**Changes apply on the next request.** Membership is read from the database on
every authorization-sensitive request, so adding, removing or re-roling a
member needs no new token. (The account-wide role in the token keeps its
existing staleness of up to 15 minutes; that is unchanged.) There is no cache:
one indexed read per request is cheap, and a cache would bring staleness back.

*Later:* owners inviting members themselves — an invitation stored as a hash,
single-use, bound to an email and expiring, following the `Confirmation`
design.

---

## 5. The engine after Stage 3A

`packages/security/src/automation-authz.ts`, with a pure type in
`packages/core`:

```ts
// @jarvis/core
export type TenantRole = "owner" | "admin" | "member" | "viewer";
/** The caller's membership in ONE tenant, read by the server. */
export interface TenantMembershipContext { tenantId: string; role: TenantRole }

// @jarvis/security
export interface AutomationCallSubject {
  auth: AuthContext | null | undefined;   // identity: only userId is read
  membership: TenantMembershipContext | null | undefined;
  agentId?: string | undefined;
}
export interface AutomationResourceScope {
  tenantId: string;                       // required — the resource's owning tenant
  ownerUserId?: string | undefined;       // a user-owned resource inside it, checked BESIDE tenantId
  agentId?: string | undefined;
}
```

**Decision order** — each step denies by default:

```
identity → operation → risk → ownership recorded → membership in that tenant
         → owner (if any) → agent (if any) → membership role → per-surface grant (checked on every fallback candidate)
```

**New refusal codes:** `RESOURCE_OWNERSHIP_MISSING` (no `scope.tenantId`),
`TENANT_MEMBERSHIP_REQUIRED` (no membership), `SCOPE_TENANT_MISMATCH` (a
membership for a different tenant was passed). `ROLE_UNRECOGNIZED` now refers
to the membership role.

**Pinned by tests:** the engine never reads `auth.role` — an account-wide
`owner` holding a `member` membership gets member grants, and an account-wide
`member` holding an `owner` membership gets owner grants. Every fallback
candidate is checked against the membership's grants. `manage` and `execute`
require approval on every surface for every role.

---

## 6. The MCP read routes after Stage 3A

`GET /api/v1/n8n/mcp/tools` and `/automations`:

```
requireAuth → server-only fields refused → owner read → membership read
            → engine + Stage 2 route checks → limiter → connector → discovery
```

| Outcome | Status | Code returned | Audit `authz` |
|---|---|---|---|
| the request names a tenant, account, business, organization, workspace, operation, user, owner or agent | 400 | `REQUEST_SCOPE_REFUSED` | `REQUEST_SCOPE_REFUSED` |
| the owner or the membership cannot be read | 503 | `AUTHORIZATION_UNAVAILABLE` | `AUTHORIZATION_UNAVAILABLE` |
| no owner recorded | 403 | `TENANT_ACCESS_DENIED` | `RESOURCE_OWNERSHIP_MISSING` |
| not a member of the owning tenant | 403 | `TENANT_ACCESS_DENIED` | `TENANT_MEMBERSHIP_REQUIRED` |
| a member whose role holds no `mcp:read` (viewer) | 403 | `SURFACE_PERMISSION_DENIED` | `SURFACE_PERMISSION_DENIED` |
| an unrecognized membership role | 403 | `ROLE_UNRECOGNIZED` | `ROLE_UNRECOGNIZED` |
| Stage 2's read-only and `mcp:read` checks | 403 | unchanged | unchanged |

- **Non-members get one answer.** "No owner" and "someone else's tenant" both
  read `TENANT_ACCESS_DENIED`, so a caller cannot learn whether the connection
  is unassigned or who holds it. The audit row keeps the precise reason.
- **No tenant id in a non-member's audit row** — the row is the caller's own and
  must not name the tenant that owns the connection. A served request records
  `{ tenantId, count }`.
- An authorized member is metered, audited and answered exactly as today (429,
  404 `MCP_NOT_CONFIGURED`, 502/503/504 with fixed sentences).

**Who is served after Stage 3A:**

| Caller | MCP discovery |
|---|---|
| owner, admin or member of the owning tenant | served, read-only |
| viewer of the owning tenant | 403 `SURFACE_PERMISSION_DENIED` |
| any account outside the owning tenant — platform owners included | 403 `TENANT_ACCESS_DENIED` |
| anyone, while no owner is assigned | 403 `TENANT_ACCESS_DENIED` |

---

## 7. Rollout and rollback

- **No deployed behaviour regresses.** The MCP read routes have never shipped:
  `apps/api/src/routes/n8n-mcp.ts` is untracked on the Phase 17 branch.
- After the migration, discovery refuses everyone until an operator creates a
  tenant, adds its owner and members, and assigns the connector — the
  fail-closed default. MCP stays off unless `N8N_MCP_ENABLED=true`.
- These operator steps go into `docs/DEPLOYMENT.md` in the change that
  implements them.
- **Rollback:** the migration is forward-only and stays; the previous release
  ignores the three tables.

---

## 8. Test plan

| Layer | What is proven |
|---|---|
| Engine (`packages/security`) | ownership missing; membership missing; membership for another tenant; owner checked beside tenant; agent rules; unknown membership role; `auth.role` ignored in both directions; member `mcp:read` allowed while `mcp:write` and `rest:write` are refused; every fallback candidate re-checked; approval required for `manage`/`execute` on every surface |
| Routes (`apps/api`) | owner/admin/member of the owning tenant served; viewer refused; non-member refused; a platform owner who is not a member refused; no owner refused; each forged tenant field refused; a read failure answered 503 with no connector call; **no connector call, and no limiter query, after any refusal** (counted); precise audit codes with uniform caller codes; no tenant id in a non-member's audit row; 429/404/502 unchanged for an authorized member |
| Database (`packages/db`, PostgreSQL) | the migration applies on the existing schema; one membership per (tenant, user); membership is read only with both ids; one owner per (provider, connector); a tenant that owns the connection cannot be deleted; memberships go with their user |
| Operator command | a dry run writes nothing; every write commits with its audit row or not at all; the last owner cannot be removed or demoted, including by two concurrent requests; an unknown tenant or account is refused |
| Boundaries | no route, tool or agent imports the operator module; no repository method reads a membership by user id alone |

---

## 9. Implementation plan (Stage 3A, once approved)

| File | Change |
|---|---|
| `packages/db/prisma/schema.prisma` | the enum, three models and the `User` relation field (§3) |
| `packages/db/prisma/migrations/<timestamp>_phase17_tenant_foundation/migration.sql` | additive migration |
| `packages/db/src/repositories/tenant-repository.ts` | reads only: `findMembership(userId, tenantId)`, `findConnectorOwner(providerId, connector)` |
| `packages/db/src/maintenance/tenant-admin.ts` | the only writer (§4.6) |
| `apps/api/scripts/tenant-admin/run.ts` | the operator entry point |
| `packages/core/src/types/tenant.ts` | `TenantRole`, `TenantMembershipContext`, the two read ports |
| `packages/security/src/automation-authz.ts` | §5: scope, subject, decision order, grant table |
| `apps/api/src/routes/n8n-mcp.ts` | §6: owner and membership reads, forged-field refusal, error mapping |
| `apps/api/src/services/container.ts`, `apps/api/src/index.ts` | hand the repository to the router |
| tests | §8, database tests in the database-backed suites |
| `docs/phases/phase-17.md`, `docs/DEPLOYMENT.md` | the stage record; the operator steps |

---

## 10. Out of scope

- Making existing data tenant-owned (memories, conversations, projects,
  marketing, tasks, registered n8n workflows) — each is its own decision, and
  memory's would change its contract.
- Invitations and self-service membership management.
- An active-tenant selection and a tenant switcher (§4.3).
- Per-tenant connector credentials (§4.5).
- Per-tenant rate budgets — the limiter stays per account.
- Redesigning the account-wide role.
- The Durable Execution Ledger, the approval engine and any execution adapter.

---

## 11. A related finding — not part of Stage 3A

The deployment-wide integrations — Google Maps, WhatsApp, n8n, MCP Servers,
and Meta's environment fallback — show their state on the Integrations page to
every signed-in account, and any account can run their connection tests:
`apps/api/src/routes/integrations.ts` has no role or tenant check, and the
command service's `handleTest` checks only that the integration is enabled for
that account. In a multi-tenant deployment that is the operator's information
shown to every business. The connector-owner model above is the natural fix,
but it is a separate change.

The security review (2026-10-17) widened this: through the same shared
credentials, any account can also read and — approving its own request —
change the operator's Meta ad account. Findings H2, M3 and L11 are recorded in
`docs/phases/phase-17.md` §7 as **blockers for any multi-tenant launch**, with
the proposed stage that removes them.

**Addressed 2026-10-18** (`docs/phases/phase-17.md` §8), using the
connector-owner model above. What is still decided per account, and the
decisions left open, are listed there.

---

## 12. Open questions for the reviewer — answered 2026-10-17

All seven were answered as proposed below, except Q7, whose product word is
**Organization**.

| # | Question | Proposed answer |
|---|---|---|
| Q1 | May a tenant viewer read MCP discovery? | No — the policy names owner, admin and member |
| Q2 | Do platform owners get any implicit access to tenant resources? | No — only through an explicit membership |
| Q3 | Should non-members see one uniform refusal? | Yes, with the precise reason in the audit row |
| Q4 | Where is the MCP connection's owner recorded? | A database row set by the operator command |
| Q5 | Personal tenants and a backfill in Stage 3A? | Not yet — when user data becomes tenant-owned |
| Q6 | Is the reviewed grant table the "explicit policy", or should each tenant be able to switch member MCP read off? | The reviewed table alone, for now |
| Q7 | What is a tenant called in the product? | `Tenant` in code; the product word ("Business"?) when there is a screen |
