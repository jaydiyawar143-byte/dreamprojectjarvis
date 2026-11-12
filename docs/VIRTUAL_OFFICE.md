# Virtual Office

The Virtual Office (`/office`) is a 2D floor plan of the agents this deployment registered, the task engine's queue, and the newest audit records, with a live feed while the tab is open. It is a **window, not an authority**: nothing on the page runs, approves or writes anything.

This file is the contract for VO-1 (the page), VO-2 (the live stream) and VO-2.1 (hardening). AGENTS.md's "Virtual Office" section lists the parts a change must not break; this file says why, and what is still open.

## What it reads

| Source | Used for |
|---|---|
| `GET /api/v1/agents` | Which agents are registered (drawn) and which are declared but not registered (listed outside the floor) |
| `GET /api/v1/tasks` | The task engine's work list (titles), and since VO-2.1 `statusCounts`: every state's total for the caller's JARVIS work, counted in the database |
| `GET /api/v1/activity?limit=40` | The newest audit rows, already redacted at write time |
| Socket.IO `office:event` | Live activity and task events, after `office:subscribe` |

`buildOfficeModel` (`apps/web/src/components/office/office-model.ts`) is the one derivation; the renderer only paints what it returns.

## The rules

**A window.** The page's only controls select an actor, clear the selection and refresh. `office:subscribe` and `office:unsubscribe` are `READ_ONLY` in `SOCKET_EVENT_POLICY`, take no parameters and start no work. Tool execution and approval decisions stay `FORBIDDEN` over the socket.

**An allowlist, built in core.** `officeActivityEvent` and `officeTaskEvent` (`packages/core/src/office-stream.ts`) are the only way an audit row or a task row becomes an event. Each is built field by field: no title, description, error, parameters or `createdBy`; from an audit row's metadata only `executionId` and `durationMs`. The browser rebuilds every received event through `parseOfficeStreamEvent` and drops anything else. An activity event carries exactly the fields `GET /activity` returns, so the stream shows nothing that read does not.

**One owner, one audience.** An event carries no user id. The bus publishes to the row's owner, and the socket layer delivers only to that owner's sockets that subscribed, re-checking the identity the server resolved at the handshake. A payload cannot name another user (`SOCKET_IDENTITY_OVERRIDE`).

**After the write, never before.** The `AuditLogger` observer runs only after the durable row is stored, and `TaskService` announces a task only after its write succeeded. Neither can fail the write. The container installs them as `officeAuditObserver` and `officeTaskObserver` (`apps/api/src/services/office-events.ts`).

**No history, no replay.** Events go to whoever is subscribed at that moment. After any reconnect the page re-reads its three sources; missed events are recovered from the durable rows.

**Claims follow facts.** An agent is never shown as working, paused or with a percentage: there is no durable start row for a conversational turn and a task records no agent. JARVIS is "working" only while a task is `RUNNING`. An audit row is attributed to an agent only when it names a registered one. Since VO-2.1 the running, queued and completed counts are the server's totals, not the length of the capped list; when an API sends no totals, the page counts the listed rows and says so.

**A session ends with its token (VO-2.1).** A socket is verified once, at its handshake. The server records the token's expiry (`verifyAccessToken` returns `expiresAt`) and disconnects the socket at that instant; a socket whose token states no expiry is ended after `SOCKET_MAX_SESSION_MS` (15 minutes). A token already past its expiry is refused at the handshake. Every stream on the socket stops on that disconnect.

**The client renews (VO-2.1).** Both live streams (office and system metrics) open their socket through `openAuthenticatedSocket` (`apps/web/src/lib/authenticated-socket.ts`). It reads the access token for every connection attempt. When the server refuses the credential or ends the session, it first presents a newer token if the page already holds one (the HTTP client usually refreshed at the same expiry); otherwise it refreshes through `refreshAccessToken` — the same single-flight refresh the HTTP client uses, so a socket and a burst of `401`s rotate the refresh cookie once — and connects again. A failed refresh is "Not signed in"; a throttled handshake is not retried by itself; refusals of fresh tokens stop after `MAX_SOCKET_AUTH_RENEWALS` (3) in a row and report "Offline". The page's **Refresh** re-reads everything and calls `reconnect()`, so "Offline" is never a state only a page reload can leave.

## VO-2.1 hardening (2026-11-12)

From the post-merge audit of VO-1 and VO-2 (`main` at `82e6d71`). The scope was approved by the owner as listed below.

| Finding | What changed | Where |
|---|---|---|
| **M2** — Running and Queued were counted over `GET /tasks`, capped at 50 rows with completed ones included, so they undercounted past the cap | `PrismaTaskRepository.countByStatus` (one `GROUP BY status`, every state present, owner filter unconditional, creator filter narrows); `TaskService.countTasks` (JARVIS work only); `GET /api/v1/tasks` returns `statusCounts` beside the list, independent of the cap and of `?status=`. The page validates the totals (`parseTaskStatusCounts`, all or nothing), applies live moves of listed tasks (`overlayTaskCounts`), and says when it could only count listed rows | `packages/db/src/repositories/task-repository.ts`, `apps/api/src/services/tasks/task-service.ts`, `apps/api/src/routes/tasks.ts`, `apps/web/src/components/office/office-model.ts`, `apps/web/src/app/office/page.tsx` |
| **M1** — a socket's authorization outlived its token | `VerifiedAccessToken.expiresAt` from the verified JWT; the handshake records it and refuses one already past; the connection is disconnected at that instant (`socket_session_expired`), re-armed past `setTimeout`'s ceiling, cleared on disconnect | `packages/core/src/types/auth.ts`, `packages/security/src/tokens.ts`, `apps/api/src/socket/socket-auth.ts` |
| **H1** — after 15 minutes a dropped office stream could not come back | `openAuthenticatedSocket` (token per attempt, renew, bounded retries, `reconnect()`); `useOfficeStream` uses it and exposes `reconnect`; Refresh calls it | `apps/web/src/lib/authenticated-socket.ts`, `apps/web/src/lib/use-office-stream.ts`, `apps/web/src/lib/api.ts` (`refreshAccessToken`) |
| **D1** — the system metrics stream had the same defect | `useSystemStream` opens its socket through the same helper; "reconnecting" reads as "connecting" in that widget's vocabulary | `apps/web/src/lib/use-system-stream.ts` |
| **M4** — no test drove a real Socket.IO server | `office-stream-e2e-vo21`: real HTTP server on loopback, real Socket.IO server and client, real JWTs, `secureSocketServer` then `installOfficeStream`, and the container's own observers behind a real `AuditLogger` and `TaskService`. It also pins, against the real client library, that a refused or server-ended session is not reconnected by socket.io-client itself and that `connect()` reads the `auth` callback again. `socket.io-client` is now a dev dependency of `@jarvis/api` (the version `apps/web` already locks, 4.8.3) | `apps/api/test/office-stream-e2e-vo21.test.ts`, `apps/api/package.json`, `pnpm-lock.yaml` |

### Tests added

| File | Pins |
|---|---|
| `packages/db/test/task-status-counts-vo21-pg.integration.test.ts` | The `GROUP BY` against PostgreSQL: past the list cap, owner only, creator narrows (a NULL creator is not JARVIS), zeros for absent states, out-of-lifecycle values counted nowhere |
| `apps/api/test/task-status-counts-vo21.test.ts` | `countTasks` asks for JARVIS work only; `statusCounts` beside a capped list; a status filter narrows the list, never the totals; a refused request counts nothing |
| `apps/api/test/socket-session-expiry-vo21.test.ts` | Expiry recorded at the handshake, an expired token refused, disconnect at expiry and not before, the 15-minute bound, no timer left behind, no `setTimeout` overflow, identifiers only in the log line |
| `packages/security/test/token-expiry-vo21.test.ts` | `verifyAccessToken` reports the signed `exp`; an expired or foreign token is still refused |
| `apps/api/test/office-stream-e2e-vo21.test.ts` | See M4 above |
| `apps/web/test/authenticated-socket-vo21.test.ts` | Every branch of the client helper |
| `apps/web/test/system-stream-vo21.test.tsx` | The system stream renews and subscribes again |
| `apps/web/test/office-model.test.ts`, `office-page.test.tsx`, `office-stream.test.tsx` | Added cases for totals, the counts note, malformed totals, live moves, Refresh reconnecting, and the hook's renewal |

`apps/api/test/helpers/count-task-rows.ts` is the in-memory twin of `countByStatus` that the task tests' fake stores share.

### Evidence (2026-11-12, Windows, from the working tree, not committed)

Every turbo run used `--force`, so no result is a cache replay.

| Check | Command | Result |
|---|---|---|
| Build | `pnpm build --force` | 22/22 tasks |
| Typecheck | `pnpm typecheck --force` | 40/40 |
| Test typecheck | `pnpm typecheck:tests --force` | 23/23 |
| Lint | `pnpm lint --force` | 22/22 |
| Web, again after the last change (the client presents a token it already holds before refreshing) | `pnpm exec turbo run <build\|typecheck\|lint\|test> --filter=@jarvis/web --force`, one at a time | build 2/2, typecheck 2/2, lint 1/1, tests 991/991 (48 files) |
| Full suite, no database | `pnpm exec turbo run test --concurrency=1 --continue --force` | 22 workspaces: **11,676 passed, 2 failed, 792 skipped**. The 2 failures are the MCP timing tests below, not regressions. The skips are the database suites, which ran separately |
| Database, CI's steps | a throwaway `pgvector/pgvector:pg16@sha256:ccc6e83d…` (CI's digest) on `127.0.0.1:55433` with its own named volume, removed afterwards; `prisma migrate deploy`, then CI's four steps with `JARVIS_REQUIRE_POSTGRES=1` and `assert-no-skipped-tests.mjs` | 38 migrations applied. `@jarvis/db` 478/478 (34 files, the six VO-2.1 tests among them), `@jarvis/memory` 93/93, `@jarvis/api` 319/319, quality evaluation 13/13, **0 not run** |
| Mutation | a scratch vitest config that rewrites one guard in memory per run; no file changed | **13/13 caught**: 6 in the API (no session end, an expired token accepted, the audit wiring dropped, counts over every creator, delivery to any audience, the route counting from the list) and 7 in the web (the token read once, no renewal after a server-ended session, no give-up limit, counts from the list, negative totals accepted, Refresh not reconnecting, always rotating the cookie). The unmutated controls passed 47/47 and 98/98 |

The repo-wide build, typecheck, test-typecheck and lint ran before that last change, which touched only `apps/web`; the web gates were then run again. The full suite and the database steps ran on the final code.

### MCP timeout tests: environment timing, not a regression

Three MCP tests start a real Node child process and allow it 500 ms. On this Windows machine that process often takes longer, so they fail on code VO-2.1 never touched:

| Test | Failure |
|---|---|
| `apps/api/test/mcp-integration-s8.test.ts` › "is ERROR — timed out — when a running server stops answering" | line 394, `expected 'ERROR' to be 'CONNECTED'`: the server did not connect within `connectTimeoutMs: 500`, before the timeout behaviour is even reached |
| `apps/api/test/mcp-pilot-failures-s8.test.ts` › "timeout: ToolExecutor's deadline ends the call and the stuck server is stopped" | line 203, `expected 'connecting' to be 'failed'`: the connection was still starting when the 500 ms deadline fired |
| `packages/mcp/test/verify-s8.test.ts` › "times out a server that stopped answering, and stops it" | failed once under full-suite load with `INITIALIZATION_FAILED` |

The same commands were run alone, five rounds each, alternating between this tree and a clean worktree of `f004eca` (before the Virtual Office), on an otherwise idle machine. `packages/mcp`, both API test files and `ToolExecutor` are byte-identical in the two trees.

| Test | VO-2.1 tree | Clean `f004eca` |
|---|---|---|
| `mcp-integration-s8` › timed out | 1 passed, 4 failed | 0 passed, 5 failed |
| `mcp-pilot-failures-s8` › ToolExecutor deadline | 1 passed, 4 failed | 0 passed, 5 failed |
| `verify-s8` › times out a stopped server | 5 passed | 5 passed |

Both trees fail on the same lines with the same messages. Failing runs end at about 520–530 ms; the rare passing run takes about 1,020 ms, because the server connected in time and the timeout path then ran. The one-in-five passes in this tree against none in the clean one are chance at that failure rate: the code under test is the same. These are the timing-sensitive tests already named in AGENTS.md's test record and in `docs/phases/phase-15.md` §15. Neither the MCP implementation nor these tests were changed to make them pass.

## Known limitations

- **"Waiting for approval" is a heuristic** (audit M3). It is claimed only from a `pending` audit row under two minutes old. Approvals live ten minutes, so an agent waiting longer shows Idle, and the approve and reject rows carry no agent, so a rejected request can show Waiting for up to two minutes. VO-3 is to read the Approval table instead.
- **Some audit rows never stream** (L1). Rows written straight to the database — `outcome.*`, `recommendation.*`, marketing settle decisions, the tenant-admin CLI — reach the office only on a re-read.
- **One API instance** (L2). The event bus lives in the API process and there is no Socket.IO adapter. A second instance would not deliver the first one's events. Compose runs one.
- **The office reads the newest 40 audit rows** (L3). "No activity recorded for this agent yet" can be untrue when its last row is older.
- **First load** (L4). An event committed between the first reads and the subscription is missed until the next re-read.
- **FAILED and UNRESOLVED tasks are not shown** (L5), though `statusCounts` now counts them.
- **A row naming an agent that is no longer registered** is shown as JARVIS system work (L6).
- **A renewal every 15 minutes.** Each open live feed's socket (the Virtual Office, or the dashboard's system widget) is ended when its token expires and connects again with a fresh one: the office shows "Reconnecting" for a moment and re-reads its sources, the system widget shows its data as delayed, and the API logs `socket_session_expired`.
- **Access tokens are not revocable**, on either transport. A logout revokes the refresh token; an access token, and since VO-2.1 a socket opened with it, lasts until its expiry, at most 15 minutes.
- **Deploy the API and the web app together**, and reload open dashboards afterwards: a page from an earlier release cannot renew its socket session ([DEPLOYMENT.md](./DEPLOYMENT.md), section 5).
