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
  for one and not a fine way to authorize one. Enforced by the server since
  Phase 18.3A, from the turn's server-established `inputMode` — the client's
  flag, or the server's own recent transcript, never "text" alone. Each of
  these refuses:
  - **the chat route**, a spoken CONFIRM, before the pending action or its
    approval moves;
  - **`POST /pending-actions/:id/confirm`**, a confirmation that says it was
    spoken;
  - **`ToolExecutor`**, spending an approved approval for a spoken turn,
    however the id got there;
  - **the integration and Google write services**, through their `voice` flag,
    which the tools and `executeApprovedGoogleWrite` now pass on.

  Voice may still propose, cancel and change. Never add a confirmation path
  that does not carry the turn's mode to the executor (`voiceConfirmationRefusal`,
  `docs/phases/phase-18.md`, Stage 18.3A).
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
- **A change through a shared connection is approved by someone else.** An
  approval for a write through the deployment's Meta Ads connection belongs to
  the Organization that owns the connection from the moment it is created —
  `tenantId` comes from the owner record, never from a request. Only another
  owner or admin of that Organization may approve it (`decidedById`); its
  requester then runs it. It is consumed only in the transaction that re-checks,
  under locks, that the Organization still owns the connection and that both
  people still hold their roles (`consumeForExecution` with `tenantScope`).
  Never let a requester approve their own Organization write, and never
  consume such an approval without its scope.

### Google scopes

Progressive, always. `scopesForConnect()` cannot produce a write scope — there
is no argument to it that could. Write access is only ever added through
`scopesForWriteUpgrade()`, a separate call at a separate site, driven by an
explicit user decision. Never request every Google scope at initial login.

Authorization decisions read **granted** scopes, never requested ones: Google
may grant fewer than were asked for.

### Shared connections

The deployment-wide connections — Meta Ads, n8n (REST and MCP), WhatsApp,
Google Maps, the MCP servers and OmniRoute — each belong to one Organization.
The record of which (`AutomationConnectorOwner`) is set only by the operator
command (`docs/DEPLOYMENT.md`, "Organizations").

- **Unassigned means nobody.** Until a connection has an owner, every account
  is refused its test and its details — and, for Meta Ads, every read and
  write — platform owners and admins included.
- **Not yet Organization-owned:** sending a WhatsApp message and triggering an
  n8n workflow — still decided per account (the account the phone number is
  assigned to; the account's own registered workflows) and approved by that
  account — and the read-only Maps tools and reviewed MCP servers, which any
  account may use (Maps within the deployment's monthly ceiling). Moving them
  under their Organization is open work (`docs/phases/phase-17.md`, §8).
- **Only the membership role counts**, from the one table in
  `packages/security/src/shared-connection-authz.ts`: owners and admins may
  read, see diagnostics, test, change and approve; members and viewers may read
  and see status. `auth.role` never decides anything about a shared connection.
- **Refused before anything is spent.** A connection test is authorized first,
  then takes the caller's slot and the Organization's slot, and only then
  reaches the provider or starts a server. A lookup that fails refuses
  (`AUTHORIZATION_UNAVAILABLE`).
- **Outsiders get one answer.** Anyone outside the owning Organization sees a
  server-managed integration as one fixed "not available" view, and Meta Ads
  as on a deployment without the shared credential — whatever is configured.
  An operator identifier (an ad-account id, a phone-number id, a base URL, an
  MCP server id) reaches the owning Organization's owners and admins only.
- **One check for every surface.** The tool gate (`ToolAccessGate`) runs in
  `ToolExecutor` and in the orchestrator before a pending action exists; the
  integration command service, the Meta pages and the marketing service ask
  `SharedConnectionAccess` the same question. A new surface that reaches a
  shared connection asks it too — hiding a control is never the check.

### Automation Library

The record is `docs/phases/phase-18.md` (Stages 18.1 and 18.2); these are the
parts a change must not break.

- **An observation, not a permission.** A library entry records that a
  workflow was seen in the n8n instance. It never makes one triggerable: that
  stays the per-account `N8nWorkflow` allow-list and the approval-gated
  `n8n.trigger`. Never merge the two tables, and never add a path that
  activates, edits or runs a workflow from the library.
- **Bounded runs, never a bigger bound.** A run reads at most
  `LIBRARY_MAX_PAGES_PER_RUN` pages; a larger catalog takes more runs of the
  same scan. A page and the checkpoint past it are stored in ONE transaction
  that first renews the run's lease — a checkpoint never points past an
  unstored page.
- **Partial is never complete.** A scan is complete only when n8n's cursor
  chain ran out with every page stored. A repeated cursor fails the scan.
- **Absence needs two complete scans.** Only the last page of a complete scan
  reconciles; an entry missing from two consecutive complete scans is marked
  removed, and no entry is ever deleted. n8n's workflow cursor carries an
  offset, so one scan can skip a workflow that still exists.
- **One run per catalog**, by a lease taken in ONE conditional `UPDATE`. Never
  check it in memory and then write.
- **The catalog is the owning Organization's**, per instance (a hash of the
  base URL — the URL is not stored). Reads and syncs ask
  `SharedConnectionAccess`; starting a sync is `shared:sync` (owner, admin).
- **Nothing secret, nothing n8n said.** Only listing metadata is kept — never
  node parameters, credentials, settings, static or pinned data. Failures are
  stable codes with fixed sentences; a cursor, the instance, a credential or
  n8n's words never reach a response, a log or an audit row.
- **One port, every surface (Stage 18.2).** The router and the
  `automation.library.*` tools are handed the one `AutomationLibraryService`
  instance (`AutomationLibraryPort`). The request rules are in core
  (`validateLibraryEntryQuery`, `validateLibrarySyncOptions`,
  `namesLibraryServerScope`), so both arms refuse alike. Never validate in
  only one of them.
- **The Organization role decides, never `auth.role`.** The library tools need
  only the platform's `read`; `shared:read` and `shared:sync` are asked in
  the service.
- **Speech never starts or continues a sync.** A spoken turn is marked by the
  chat route — the client's `inputMode: "voice"`, or the server's own recent
  transcript (`RecentTranscripts`). The mark travels on the session, the
  execution request and the tool context. `ToolExecutor` refuses every tool
  in `VOICE_REFUSED_TOOLS` before the tool runs, and the orchestrator and the
  tool refuse too. The mark only narrows: never let `"text"` unmark a
  recognised transcript. Tools on that list are not task tools
  (`schedulableToolIds`), because a scheduled run outlives the turn's mode.
- **A chain is bounded runs, held by ONE conditional `UPDATE`.**
  Continue-until-complete holds the catalog through `activeChainId`, taken
  only while no run holds the lease and no live chain holds the catalog. A
  run's start checks the chain in the same statement that takes the lease.
  Before every run the chain re-reads the requester's authorization and the
  scope, and reserves the Organization's budget. It stops at its hard limits
  and is `COMPLETE` only when the store completed the scan. A repeated
  request, or an idempotency key, returns the existing chain and spends
  nothing. Never resume a chain automatically.
- **An inspection is the catalog row, sanitized (Stage 18.3B).**
  `inspectLibraryEntry` in core is the one place an entry becomes a view, and
  it is an explicit allowlist of fields. Trigger kinds and integration
  categories come only from its curated tables. Links are removed from names,
  and stored node types are re-validated. Input names are always "not
  available". It never reads n8n. Never add a field, never fill a gap with a
  guess or a source read, and never return node parameters, credentials,
  URLs, settings, static or pinned data, or a workflow object.
- **Inspecting or proposing never grants anything.** A proposal is an
  approval for the page-only `automation.library.allowlist.add`, bound to
  exactly `{entryId, versionId}`. It is an n8n write in
  `SHARED_CONNECTION_TOOLS`, so the Organization comes from the owner record
  and only *another* owner or admin approves it (Phase 17). Adding it to the
  allow-list still triggers nothing: `n8n.trigger` keeps its own approval.
  The add tool stays on NO agent's allowlist.
- **Apply re-checks, then reads n8n once, then spends.** Re-check: authorization,
  not stale, the catalog version. Then one read of the workflow, reduced
  *inside the n8n client* (`extractWorkflowTriggerTarget`) to the version
  and each enabled webhook node's path (`validateWebhookPath`), method and
  auth mode. Then the version must match, with exactly one usable webhook.
  Only then `consume` with the Organization's scope, then
  `registerLibraryWorkflow`. A refusal before the consume leaves the approval
  unspent. The reduced target is never returned, logged or audited; its path
  is stored only in `N8nWorkflow`. Never widen that read, and never move
  the consume ahead of a check.
- **Speech never applies one.** The apply flow, `ToolExecutor` and the tool
  each refuse a spoken turn (18.3A). Voice may propose.
- **Matching reads the catalog, never n8n (Stage 18.4).**
  `rankLibraryCandidates` in core judges each entry on its 18.3B inspection,
  and the planning service retrieves through the library store's own
  listing. Explanations are fixed sentences over the criteria. They quote
  only the requester's words, and never a tag or a link. Shared words count
  only if they are purpose words, never a trigger's or an app's name. Never
  recommend a stale entry, or one whose node types are unknown. Never claim
  what a node is configured to do.
- **A draft is a plan in JARVIS, not a workflow.** `AutomationPlanningService`
  is the one implementation; the planning router and the
  `automation.workflow.match` / `automation.draft.*` tools are both handed
  it. It holds no n8n client.
  - Never add a path that sends a draft to n8n, deploys, activates, runs or
    publishes one, or turns one into an approval or an allow-list row.
  - A new draft is refused while the library covers the request
    (`REUSE_AVAILABLE`), unless `overrideReuse` is set.
- **No n8n parameter without its schema.** JARVIS carries a pinned, reviewed,
  trusted copy of n8n node parameter schemas (Phase 18, Stage 18.5) for every
  node type in `DRAFT_NODE_CATALOG`. A draft holds structure, nodes from
  `DRAFT_NODE_CATALOG`, and settings written as questions. Credentials and
  URLs are references to configure in n8n, never values.
  - The `configuration_schema` check runs when the server holds the
    verified snapshot; a check that could not run completely is `not_run`
    (never `passed`).
  - Never add a node type, a parameter or a credential field to a draft
    without it being covered by the pinned schemas or explicitly reviewed.
  - Never report a draft `validated` while any check did not run.
  - Secrets, expressions and links are refused, never stored redacted.
- **Draft versions are immutable.** A revision names its `baseVersion` and is
  stored only while that is the latest: ONE conditional `UPDATE`, then the
  insert. PostgreSQL refuses an `UPDATE` of a stored version. A stale
  customization cannot be revised. Never add an update of a version.
- **The Organization role decides drafts too.** Matching and reading need
  `shared:read`; creating and revising need `shared:write`
  (`resolveCatalog`). Drafts are scoped by Organization, provider and
  instance. Audit rows hold ids, hashes and statuses — never the goal, an
  answer or a label.

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
- **Published means read back, with its text.** An item is recorded `VERIFIED`
  only after the post was read from the provider by its id AND the text that
  came back is the item's text. Never from a provider's "accepted", a status
  code or a timeout, and never from a post with other text or none — on the
  first attempt or on a retry. `REPORTED_BY_USER` is a different thing and is
  never upgraded to it, or worded like it.
- **One post is one item's post.** A provider post id another item already
  holds — any user's, since every user publishes through the same connection —
  is never recorded a second time. `finalizePublished` is the only writer of
  `VERIFIED`; it checks and writes under a lock on that post's id. A look for
  an earlier post passes such a post over and keeps looking. Never add a
  second writer of `VERIFIED`, and never take the check out of that
  transaction.
- **An unknown outcome is a state, and nothing is sent while it lasts.** A
  publish that was sent and not confirmed leaves the item `UNCONFIRMED` and
  unpublished. From then on: the item cannot be edited; the record of the
  original attempt — its Page, a hash of what was sent — is kept as it is; a
  retry is held to that Page and those words; and **a retry only looks, it
  never sends**. Not finding the post is not permission to post again. Never
  add a path that sends for an unconfirmed item.
- **Only a person settles an unconfirmed publish.** `marketing.publish.resolve`
  records "it was not published", looks once more, and clears the attempt only
  if the post is not there. It stays on NO agent's allowlist and refuses a call
  that carries an agent or a conversation. Before it looks, it is held to the
  attempt as a retry is: the item must still hold the words that attempt sent
  (by the hash that was kept — no hash, no clearing) and the attempt's Page
  must still be one the connection can read; otherwise nothing is cleared.
  And it settles only the attempt it checked: if the attempt under its claim
  is not the one it read a moment before, nothing is cleared.
- **A settle changes nothing without its audit row.** Clearing an attempt, and
  recording a post the settle found, are each ONE transaction with the audit
  row of the decision (`clearUnconfirmed`, `finalizePublished`). If the row
  cannot be written the decision is not carried out and the item stays
  unconfirmed. Never clear first and audit afterwards, and never swallow a
  failure to write that row.
- **The text of a post comes from the saved item.** No endpoint accepts it. A
  publish whose text is not exactly the saved text is refused, even after a
  person approved it.
- **Publishing is approval-gated by the exact text and Page**, and the item is
  claimed by a conditional `UPDATE` (`claimForPublish`) that says what it took:
  only a claim taken from an item with no publish outstanding may send. Never
  read the publish state, check it in memory and then write. No path may
  publish without an approval, and nothing publishes because a date arrived.
- **An approval is for a send or for a look, and its parameters say which.**
  While an earlier publish is unconfirmed the publish check adds
  `earlierAttempt` — the identity of that attempt, never its text — and what
  the person is shown is a look, not a post. The claim is taken ONLY from the
  state the approval was made for: an approval to look can never take the
  claim that may send, not even when the attempt it named was settled between
  the approval and its execution, and an approval to send is not run as a
  look. Never add a claim that tries one state and falls back to the other.
- **Publishing is off unless the operator switches it on.**
  `MARKETING_PUBLISH_ENABLED` must be exactly `true`; the Meta credentials alone
  never register a publish tool. Where it is off there is no publish tool for a
  sentence or a button to reach, so no approval for a publish can exist. Never
  add a fallback that builds a publisher without it.
- **What an agent is told about publishing follows the tools it was handed.**
  The marketing agent's prompt is computed from its definitions: without the
  publish tools it says publishing is not available here, why, and how an
  operator switches it on. A model that names a switched-off tool anyway is
  answered by the orchestrator (`unavailable`, `switchedOffTools`) before the
  executor is asked — an ordinary reply, with no execution, approval or
  pending action. The two page reads are named the same way wherever
  `BROWSER_ENABLED` is not `true`. Never tell a model to call a tool it was
  not given, and never register a stand-in tool to make such a call succeed.
- **Work that reaches outside JARVIS takes a slot first.** A page read, a
  report and a publish check each reserve a place in a per-user window —
  count and reservation in ONE step in PostgreSQL (`reserveSlot`,
  `AtomicRateLimiter`) — BEFORE the provider is called. Never count, act, and
  write the counted row afterwards: requests that arrive together would all
  pass. A report's cap is answered before the ad account is read, too. If the
  limit cannot be checked, the work is refused.
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
database, none failed. After the Phase 15 audit fixes (2026-10-13), on Linux
from a clean copy: `@jarvis/db` 341 passed / 0 failed (25 files) on a fresh
database; every CI step passed; and of the 9,049 tests that run without a
database, 9,048 passed — the one that did not is a performance budget in
`@jarvis/core` that is not gated by CI. Three tests outside marketing are
sensitive to the machine's timing and can fail under load; they are named in
`docs/phases/phase-15.md`, §15. After the final Phase 15 safety pass (same
day, same method): `@jarvis/db` 365 passed / 0 failed (25 files) on a fresh
database; every CI step passed, the marketing contracts at 565; and of the
9,111 tests that run without a database, all but one or two passed when every
workspace's suite was started at once — the performance budget again, and a
web test that waits one second for a page (`auth-session`, "/approvals loads
its data…"). Both pass alone and in CI's own steps; see §16.
After the Phase 17 multi-business hardening (2026-10-18, on Windows from the
working tree, turbo's cache bypassed): `@jarvis/db` 410 passed / 0 failed (27
files) on a fresh database;
CI's database steps all passed, 0 skipped; and every workspace's suite without
a database gave 9,682 passed, 0 failed (20 workspaces)
(`docs/phases/phase-17.md`, §8). After Phase 18, Stage 18.1 (2026-10-19, same
method): `@jarvis/db` 417 passed / 0 failed (28 files) on a fresh database;
CI's database steps all passed, 0 skipped; every workspace's suite without a
database gave 9,744 passed and 4 failed — the timing-sensitive tests named in
`docs/phases/phase-15.md` §15 (`evidence-builder` and three MCP timeout
tests), each passing when run alone (`docs/phases/phase-18.md`).
After Phase 18, Stage 18.2 (2026-10-20, same method): `@jarvis/db` 422 passed /
0 failed (29 files) on a fresh database; CI's database steps all passed, 0
skipped; every workspace's suite without a database gave 9,840 passed and 3
failed — the three MCP timeout tests, which that day failed alone and on an
untouched checkout of `1fd1bb0` alike (`docs/phases/phase-18.md`, Stage 18.2).
After Stage 18.3A (same day, same method): CI's database steps all passed
(`@jarvis/db` 422/422, 0 skipped). The full suite gave 9,868 passed and 4
failed: the same three MCP tests, plus the `evidence-builder` millisecond flake.
After Stage 18.3B (2026-10-21, same method): CI's database steps all passed
(`@jarvis/db` 428/428, 30 files, 0 skipped). The full suite gave 9,932 passed
and 4 failed — the same four timing-sensitive tests, each of which passed
when run alone that day.
After Stage 18.4 (2026-10-21, same method): CI's database steps all passed
(`@jarvis/db` 434/434, 31 files, 36 migrations, 0 skipped). The full suite
gave 10,009 passed and 3 failed: the three MCP timeout tests, which failed
alone that day too, as on the untouched `1fd1bb0` (Stage 18.2).
After Stage 18.5 (2026-10-22, on Windows from the working tree, same method):
`pnpm typecheck` 37/37, `pnpm lint` 20/20, `pnpm build` 20/20. The full suite
across 20 workspaces gave 10,077 passed, 4 failed and 668 skipped — the skips
are the database-backed suites (`@jarvis/db` 346, `@jarvis/api` 226,
`@jarvis/memory` 96), since no test database was pointed at (this stage adds no
migration and no repository). The 4 failures are the same timing-sensitive
ones named in §15: the three MCP timeout tests, each failing alone on this
machine too, and the `auth-session` web test ("/approvals loads its data…"),
which passes alone. CI's database steps were not run in that pass.

The two memory end-to-end tests (`sprint-1.1d-memory-e2e`, and
`phase14-memory-e2e-pg.integration`, which has no in-memory fallback at all)
fail rather than fall back or skip when `JARVIS_REQUIRE_POSTGRES=1` is set and
no separate test database is reachable. CI sets it in its database steps.

CI runs the PostgreSQL-backed tests against its own throwaway pgvector service,
after applying every migration, and fails if any of them is skipped
(`docs/DEVELOPMENT.md`, "Continuous integration"). It picks them up by name: a
database-backed test in `apps/api` or `packages/memory` must be named
`*-pg.integration.test.ts`, or CI never gives it a database.

CI does not run the tests of `@jarvis/core`, `tools`, `agents`, `browser`,
`meta-graph`, `browser-protocol` or `browser-service` as workspaces. Eight
slices of them are gated by **file name**: the memory contracts, the marketing
contracts, the shared-connection contracts (`shared-connection*` in `tools` and
`agents`), the Automation Library's rules (`automation-library*` in `core`,
`tools` and `agents`), since Phase 19.1 the computer-control contracts
(`computer-control*` in `core` and `tools`, and `sprint7-browser-tools`), the
Meta Ads write contracts (`meta-ads*` and three journal suites in `tools`) and
the tool-execution boundary pins (`mcp-boundaries-s8`, `mcp-tools-boundaries-s8`),
and since Phase 19.2 the browser-service contracts (`browser-service*` in
`browser-protocol` and `browser-service`, and since Phase 19.3 `ip-rules`,
`host-rules` and `navigation-policy` in `browser`). A new contract test for any
of them must match the names its step selects (`.github/workflows/ci.yml`), or
CI never runs it.

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
| `packages/meta-graph`, `google-ads`, `google-workspace`, `whatsapp`, `n8n`, `omniroute`, `browser` | Provider clients |
| `packages/mcp` | MCP runtime (the only home of the MCP SDK) and the reviewed stdio servers in `pilot/`; reviewed in core's `MCP_MANIFEST`, read-only, off unless `JARVIS_MCP_ENABLED=true` |

## Documentation precedence

When documents disagree: this file, then `docs/ARCHITECTURE.md`, then
`docs/JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md`, then `docs/reports/`.
Generic workflow guidance from any tool or plugin never overrides the rules
in this file.

**Do not touch** the separate YouTube Agent project at `D:\ai youtube agent`.
It is not part of this monorepo.
