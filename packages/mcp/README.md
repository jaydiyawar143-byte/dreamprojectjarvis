# @jarvis/mcp

The MCP runtime: one reviewed MCP server per `McpConnection`. This is the only
package that imports the MCP SDK (`@modelcontextprotocol/sdk`, pinned to exactly
`1.30.0`). The rest of JARVIS never sees the SDK.

**Status (S8.5).** `McpConnection` implements core's `McpCallPort`. The tool adapter
(`createMcpTools` in packages/tools) depends on that port alone and never imports
this package. With `JARVIS_MCP_ENABLED=true`, the API container registers the
reviewed servers' tools (S8.4), and the Integration Center checks their health
through `verify()` (S8.5). Nothing connects at boot.

## Why it exists

An MCP server is outside code that JARVIS can call. This package keeps that code
at arm's length. It starts a server only when one is first used, and only from a
reviewed manifest. It checks the server against that review before any call. It
never lets what the server says about itself reach a model.

## The reviewed manifest is the authority

A server is described by an S8.1 manifest entry (`@jarvis/core`, `mcp-manifest.ts`):
- the command and arguments that start it;
- the environment variables it is given;
- its expected name and exact version;
- every tool it lists, pinned by a fingerprint.

`McpConnection` re-validates its entry and refuses to exist if the entry is invalid.

Live metadata is untrusted. That covers descriptions, schemas, annotations,
`instructions`, icons, `_meta` and server text. It is fingerprinted and compared
with the review, never passed on. `listVerifiedTools()` returns the manifest's
own entries. Failures are fixed sentences.

## Lifecycle

```
idle ──connect()──▶ connecting ──verified──▶ ready
                        │                       │  drift · crash · timeout ·
                        ▼                       ▼  cancellation · oversize
                     failed ◀───────────────────┘
failed ──connect()──▶ connecting        any ──close()──▶ closed (final)
```

- **Lazy.** Constructing a connection spawns nothing. `connect()` does, once.
  Concurrent callers share one attempt. A caller's `AbortSignal` ends only its
  own wait.
- **Verified.** `ready` comes only after all of these:
  - `initialize`, with the protocol version negotiated by the SDK and never hard-coded;
  - every page of `tools/list`, within bounds;
  - a match with the review.
- **What counts as a match.** All of these must hold, or the connection fails
  closed with `SCHEMA_INVALID` and a drift list:
  - the server's name and exact version match;
  - every reviewed tool is present, with the same fingerprint;
  - no tool appears that nobody reviewed;
  - no tool is listed twice.
- **No runtime discovery.** A listing never registers or describes anything.
  `tools/list_changed` triggers a re-verification, which can only fail the
  server. It never adds a tool, edits the manifest or changes policy.
- **Calls.** `callTool(name, args, signal?)` refuses anything unless the
  connection is `ready`. It accepts only a reviewed, enabled tool name, and only
  arguments that fit that tool's reviewed flat schema. It never connects by
  itself.
- **Health check (S8.5).** `verify()` is the on-demand check behind the
  Integration Center's Test Connection. A server that is not running is started
  and verified, exactly as `connect()` would, breaker included. A running one is
  asked for `tools/list` again, now, and compared with its review. A difference,
  a broken stream or no answer within the connect timeout fails the server and
  stops it. Like `tools/list_changed`, it can only fail a server. `serverId` is
  the manifest's id, for naming the server in that report.

## Isolation

- **How the server starts.** It is spawned as `node <reviewed script> <reviewed args>`. `node` is
  `process.execPath`, so there is no PATH lookup, and there is no shell. Nothing
  is downloaded at runtime: no `npx`, no `uvx`.
- **Environment.** The child's environment is exactly the variables its manifest maps, each read
  from the server's own `JARVIS_MCP_<ID>_…` variable. Nothing else is forwarded:
  no `DATABASE_URL`, no `NODE_OPTIONS`, no `LD_PRELOAD`, no `PATH`.

  On Windows only, the OS process layer (libuv) adds its own fixed set of system
  variables (`SYSTEMROOT`, `PATH`, `TEMP`, `USERNAME`, …). Linux adds none.
- **Why the SDK's stdio transport isn't used.** `StdioClientTransport` always
  merges part of the parent environment into the child. This package spawns
  servers itself and reuses only the SDK's message framing (`ReadBuffer`, with
  its byte limit).
- **stderr** is discarded at the OS level. It is never read, collected or logged.
- **stdout** is read through a bounded buffer. One message over 1 MiB stops the
  server with `RESPONSE_TOO_LARGE`.
- **No server-initiated requests.** The client declares no capabilities, so
  sampling, elicitation and roots requests from a server are answered
  "method not found".

## Failures

Every failure is `{ code, message, drift? }`. The code is one of:

- SERVER_UNAVAILABLE
- INITIALIZATION_FAILED
- TOOL_NOT_FOUND
- SCHEMA_INVALID
- INVALID_ARGUMENTS
- TIMEOUT
- CANCELLED
- AUTH_FAILURE
- RATE_LIMITED
- REMOTE_ERROR
- RESPONSE_TOO_LARGE
- UNKNOWN

The vocabulary, its fixed sentences and the argument check against the reviewed
schema live in core (`mcpFailure`, `validateMcpArguments`). The runtime and the
tool adapter share them. Messages are fixed sentences, never server text. They are worded so the existing
tool-failure classifier never reads one as a Google or approval failure.
`AUTH_FAILURE` and `RATE_LIMITED` are reserved for remote transports; stdio
never produces them.

A call that is cancelled or timed out stops the server, because the server may
be stuck on that call. A broken stream stops it too. The next `connect()` starts
a fresh one.

## Breaker

Each connection holds core's `CircuitBreaker`:
- After **3** consecutive failed starts it opens for **60 s**. While open,
  `connect()` fails at once with `SERVER_UNAVAILABLE` and spawns nothing.
- After the cooldown, one probe start is let through.
- A verified start resets the count.
- Call failures, and a `close()` during a start, don't count.
- Nothing retries, and nothing is persisted.

## Shutdown

`close()` is final. It ends the server's input, sends SIGTERM if the server
lingers and SIGKILL if it still does, waiting up to 2 s at each step. It
resolves only once the process has exited. A connection closed while connecting
leaves no process behind.

## Not supported in v1

- Remote transports: Streamable HTTP, SSE, WebSocket.
- Resources, prompts, sampling, elicitation, roots, completions and tasks.
- Write tools: the manifest accepts READ_ONLY tools only.
- Per-user servers or credentials, OAuth, and retries.
- Servers listing tools outside their review, or schemas beyond flat scalars.

## Bounds

All bounds live in `MCP_RUNTIME` (`src/config.ts`):

| Bound | Value |
|---|---|
| Connect, including verification | 10 s |
| One call (ceiling under ToolExecutor) | 30 s |
| One message | 1 MiB |
| `tools/list` | at most 10 pages and 200 tools |
| Close grace, per step | 2 s |
| Breaker | 3 failed starts, then 60 s cooldown |

## Tests

`test/fixtures/fake-server.mjs` is a fake MCP server, used only by these tests.
It has no SDK and no secrets, and covers many modes: normal, drift, duplicate,
paged, init/list errors, hang, crash, slow, huge, stderr flood, binary,
`isError`, `list_changed`, sampling, env dump and a controllable start.

`connection-s8.test.ts` runs real processes of the fake server.
`verify-s8.test.ts` runs the health check against them, using the controllable
mode to make a running server drift or stop answering. `normalize-s8.test.ts`
covers the pure helpers. `boundaries-s8.test.ts` holds the package boundaries.
