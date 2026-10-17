# n8n MCP execution architecture — specification only

*Phase 16, Stage 3. Nothing in this document is implemented. It records how
execution WOULD work if and when it is built, so that when it is, it is built
against an explicit decision rather than an accumulation of choices made while
wiring something up.*

**Status: SPECIFICATION ONLY, 2026-10-16.**

| | |
|---|---|
| What exists today | Read-only MCP **discovery** (`GET /api/v1/n8n/mcp/tools`) and a unified read-only view (`GET /api/v1/n8n/mcp/automations`). Both come from Stage 1 and Stage 2 of this task. |
| What this document is | The design of execution: authz, risk, confirmation, durable records, audit, timeouts, retry, cancellation and revalidation. |
| What does **not** exist | No invocation path, no `ToolExecutor` entry for an n8n MCP tool, no agent allowlist entry, no registered callable MCP tool, no confirmation flow for an n8n write, no workflow `apply` / `setActive` / `rollback`. |
| What must stay true until then | `invokeTool` is reachable from no route, no tool and no agent. Nothing executes because a date arrived. |

---

## 1. The boundary this specification lives inside

JARVIS has one rule that overrides convenience, and it is the load-bearing wall
of this design (see `AGENTS.md`, "Other standing rules"):

```
Plan → Explain → Confirm → Execute → Audit → Verify → Report
```

Execution of an n8n MCP tool is an **external write** when the tool writes, and
an external write is not something a model may do because it asked. The
confirmation, the audit row and the approval gate are not add-ons to this design
— they are the reason it has the shape it has.

Two existing mechanisms are reused rather than re-invented:

- **`ToolExecutor`** (`packages/tools/src/tool-executor.ts`) — the one place a
  tool is executed, which already applies risk, approval and audit.
- **The approval gate and confirmation service**
  (`packages/security`, `apps/api/src/services/integrations/command-service.ts`
  and the confirmation flow) — already bind an approval to an exact intent, one
  use, with an expiry.

The integration rule from `AGENTS.md` applies verbatim: *one place where an
operation is implemented*, reached by both a command and a button. An n8n MCP
invocation must therefore be implemented **once**, as a port inside
`packages/tools`, and reached from a route by calling the same executor — never
as a second path that reaches the provider directly.

---

## 2. Authorization and least privilege

**Every call is evaluated for every tool, on every execution.** The grant is
checked at execution time, not at registration time.

1. **Session first.** The caller holds a valid JARVIS session. An n8n MCP
   bearer token is not, and must never become, a caller credential; it exists
   only server-side, in the connector (`packages/n8n/src/mcp-config.ts`,
   `apps/api/src/services/container.ts`). This is the same separation the route
   already enforces.
2. **The tool must be on an allowlist — by default, on none.** As with
   marketing's publish tools, registration of a callable n8n MCP tool is
   conditional on configuration *and* an explicit decision. Absent that
   decision there is no tool, so there is no sentence that could name one.
3. **Role.** The reviewed-MCP precedent is `OWNER` / `ADMIN` for anything that
   reaches an instance. A member-level session is refused regardless of its
   tool grant.
4. **Least privilege.** A tool is granted read-only first. Write capability is a
   *separate* grant, added by an explicit decision — the progressive-scope rule
   the Google work follows (`scopesForConnect()` / `scopesForWriteUpgrade()`),
   restated for tools.
5. **Per-user scope.** Where a record can belong to a user, the scope filter is
   written beside the user filter, never instead of it. The active project, if
   any, comes from the conversation row, never from a request body.

**Refusal shape.** A refused execution answers with a stable code and a fixed
sentence — never the provider's text, never a token, never the arguments. An
unavailable or not-configured tool says so, as `mcpToolUnavailable` does today.

---

## 3. Risk classification and approval

Every executable tool carries a risk in the **registry** (`packages/tools`),
which is the same registry `ToolExecutor` consults — so the risk shown to a
person and the risk that gates execution cannot drift apart.

| Class | Example | Gate |
|---|---|---|
| `READ_ONLY` | discover, list, inspect | Executes under the session's grant. No confirmation. |
| `LOW_IMPACT` | a write that changes **only JARVIS's own store** (a draft revision) | Executes under the grant; audited. |
| `HIGH_IMPACT` + external write | applying a revision, activating/deactivating a workflow, anything that changes state outside JARVIS | **Approval required.** Confirmation required. |

A tool's own annotations (`readOnly`, `destructive`) are **advisory and are not
the gate**. The registry's classification decides; a provider's self-description
does not — `automation-registry.ts` states this explicitly, and the same rule is
applied here. A server that claims a tool is read-only does not get to define
what counts as safe.

---

## 4. Confirmation, bound to the exact intent

The confirmation is bound to the exact action, so approving one intent never
approves another.

- **Bound to** `(user, integration/provider, action, params-hash, target-id,
  risk, expiry)`. Any change to any of those makes it a different confirmation.
- **Single-use.** Spending it is an atomic verify-and-consume. Two concurrent
  attempts result in exactly one execution.
- **Short expiry** — on the order of the existing confirmation windows (minutes,
  not hours). A confirmation that has expired must be re-derived from the
  current state, never renewed in place.
- **The prompt names the target and the key arguments.** The person confirming
  must be able to see *which* workflow and *what* is changing without running
  anything.
- **If the tool can no longer be listed** (the tool was removed by a server
  upgrade, the instance changed), the confirmation is void: re-discover and ask
  again.
- **A confirmation is never inferred from a scheduled time, a previous
  confirmation, or a yes/no reply to an unrelated question.**

No confirmation, no execution. There is no code path that skips it for
convenience, for a retry, or for "the same tool as before".

---

## 5. Durable records and idempotency

Every attempt leaves a durable record before anything reaches the provider, and
survives a process restart.

- **One row per attempt**, written first, carrying: user, tool id, risk,
  approval id, idempotency key, status, and timings. Not the arguments — an
  n8n node parameter can hold a token, a header or a pasted secret. Where a
  parameter must be remembered for audit, it is stored as a **hash**, not as
  its value.
- **Idempotency key** derived from the intended action and its arguments, so a
  retried delivery of the *same* intent is recognisable as the same intent.
  A different key is a different action and needs its own confirmation.
- **Status machine** with an explicit `UNKNOWN` state (see §7).
- **Verification before report**: a success is reported only after the result
  has been read back and matches the intent, not because a request returned.

---

## 6. Audit without secrets

Audit rows record **what was decided and what happened**, never the material
that made it possible.

- Allowed: ids, action names, risk, approval id, idempotency key, hash, counts,
  status, duration, trace id.
- Never: the MCP token, `N8N_API_KEY`, an `Authorization` header, a node
  parameter value, a provider's raw error text, or a full payload.
- The endpoint may be logged (the connector already logs only `transport.url`);
  the credential may not, which is why the token lives in `HttpMcpConnection`'s
  headers and never in a URL.
- Audit is written by the same code path that executes, so an execution without
  an audit row is not possible.

---

## 7. Timeouts, uncertain outcomes, retry and cancellation

This is the part where a wrong design silently double-executes.

- **Timeout.** A bounded deadline per call, from `N8N_MCP_TIMEOUT_MS`, applied
  by the transport. On timeout the attempt is **not** "failed" — it is
  **unknown**: n8n may have run the workflow.
- **`UNKNOWN` is a first-class state.** `N8nExecutionStatus.TRIGGERED` in
  `packages/core/src/types/n8n.ts` already encodes the reason: an automation may
  have side effects even if we never hear back, so it must never be
  auto-retried. The MCP path follows the same rule.
- **Retry** only when it is *provably* safe: the intent carries an idempotency
  key the provider honours, **or** a read-back has already established the
  action did not happen. Otherwise the user resolves it — never the client's
  timeout policy.
- **Cancellation.** An aborted request cancels the transport call
  (`AbortSignal`), records `CANCELLED` (still subject to §7's read-back, since a
  cancel racing a server-side run is also an uncertain outcome), and never
  un-runs what already ran.
- **Recovery.** The first action after an `UNKNOWN` is a **read**: inspect the
  execution / the workflow state and resolve the row to a known outcome. Only
  then may anything be offered for a decision.

---

## 8. Revalidation immediately before executing

State moves between confirmation and execution. The following are re-checked at
execution time, not trusted from the confirmation:

1. The session is still valid and the grant is still held.
2. The connector is still reachable and still authenticated (discovery gate is
   closed and re-opened with a fresh listing).
3. The tool still appears in the **current** discovery — the gate in
   `mcp-connector.ts` is re-evaluated against a fresh `tools/list`, not a cached
   one.
4. The risk classification has not changed (a registry reload or an upgrade can
   reclassify).
5. The target still exists and still is the target the confirmation named
   (id equality, not name equality).
6. The confirmation is still unexpired and unconsumed.

Any failure aborts with a specific, stable code. Nothing falls through to "just
run it anyway".

---

## 9. Writes do not go through MCP

This is the decision most likely to be argued with later, so it is written down
explicitly.

- **MCP is the discovery and read surface.** It answers which automation tools
  exist and, eventually, may execute a *read* tool. Its transport, token and
  error handling have been verified only for read-only discovery.
- **Workflow definition mutations do not use MCP.** Applying a revision,
  activating or deactivating, and rolling back go through the **REST surface**
  (`packages/n8n`'s workflow client, §7.2 of `docs/phases/phase-16.md`), behind
  the confirmation gate and the approval gate. MCP is not a write transport for
  JARVIS state, nor for n8n's state, in this design.
- **Nothing in JARVIS writes through an MCP tool as a shortcut** to avoid the
  REST write path. If a write cannot be done through the confirmation-gated path,
  it is not done — rather than being smuggled through a surface that was never
  authorized for it.

If a future change wants MCP writes, it must first answer: which confirmation
binds it, which approval records it, how an uncertain outcome is resolved, and
what makes the token's scope sufficient. Until those have answers, the answer is
no.

---

## 10. Explicitly out of scope

- No `invokeTool` call from any route, tool or agent.
- No agent allowlist entry for an n8n MCP tool.
- No registration of a callable MCP tool in the tool registry.
- No confirmation flow, approval row or durable execution record.
- No workflow `apply` / `setActive` / `rollback` implementation.
- No change to OmniRoute, `integration-catalog.ts` or `integration-registry.ts`.

## 11. Acceptance criteria for when this is built

1. There is exactly **one** implementation of an n8n MCP invocation, a port in
   `packages/tools`, reached by a route only through `ToolExecutor`.
2. A test proves the route **cannot** execute a tool that is not discovered,
   not granted, not approved, or has changed risk since confirmation.
3. A test proves an expired or already-consumed confirmation is refused, and
   that two concurrent confirmations produce exactly one execution.
4. A test proves no audit row, log line, error or response ever contains the
   token or a node parameter value.
5. A test proves a timeout leaves `UNKNOWN`, that nothing retries it, and that
   a read-back resolves it.
6. A test proves workflow writes go through the REST path, never through MCP.

---

*Specification only. The discovery route and the unified read-only view are the
only executable parts of this task, and they invoke nothing.*
