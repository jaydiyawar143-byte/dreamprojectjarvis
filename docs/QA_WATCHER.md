# Local QA watcher (zero tokens)

`scripts/qa-watch.mjs` is a local loop for the test suites. It uses Node
built-ins only, calls no model provider, and never reaches a database or an
external integration.

| Command | What it does |
|---|---|
| `pnpm qa:watch` | Watch every workspace and re-run what a change touches |
| `pnpm qa:watch:full` | Typecheck, lint and the whole suite, once, then exit |
| `pnpm qa:watch:stop` | Stop the watcher (graceful, with a process-tree fallback) |

A full check runs Turbo with `--continue=dependencies-successful`, so it reports
every failing workspace instead of stopping at the first one — and still refuses
to run a task whose dependency failed to build.

**What a change runs.**

| Change | Run |
|---|---|
| A test file | That file, or the changed files in that workspace |
| `src/` in `apps/*` | That workspace's suite (Turbo builds its dependencies first) |
| `src/` in `packages/*` | Build that package (so its `dist/` is fresh), then its suite |
| `vitest.config.ts`, `tsconfig*.json`, `package.json` | That workspace's suite |
| `*.pg.integration.test.ts` | Never run — skipped by design |
| `docs/`, `.github/`, other files outside a workspace | Nothing — not watched; run `pnpm qa:watch:full` yourself |

Suites run through `turbo run test`, whose `^build` dependency keeps the
workspace graph fresh; a changed library is built before its own suite because
the other workspaces import it from `dist/`, not `src/`. For the same reason,
`turbo watch test` is the correctness fallback when a library change may affect
its consumers:

```bash
pnpm exec turbo watch test --concurrency=1
```

**Safety.** Every child process gets a fenced environment:

- `DATABASE_URL` is blank — the repository's own "not set" convention — and
  every `*.pg.integration.test.ts` is excluded by glob as well. The fence is
  blank rather than deleted because a test's `dotenv` call reads the root `.env`
  and would otherwise load a live database. `DIRECT_URL`,
  `SHADOW_DATABASE_URL` and `JARVIS_REQUIRE_POSTGRES` are blank too.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, the Meta, Google,
  n8n, OmniRoute, WhatsApp and browser-service secrets are blanked, and
  `JARVIS_MEMORY_EVAL_REAL_EMBEDDINGS` is blank, so the opt-in real-embedding
  evaluation cannot run.
- An integration's **base URL is removed, not blanked**: `N8N_BASE_URL` and
  `N8N_MCP_ENDPOINT` are `z.string().url()` in `@jarvis/config`, where an empty
  string is an invalid URL rather than "not set" — blanking them stopped
  `getServerEnv()` for every suite. With the token blanked and the switch off,
  an endpoint on its own reaches nothing.
- `BROWSER_ENABLED`, `JARVIS_MCP_ENABLED`, `MARKETING_PUBLISH_ENABLED`,
  `DESKTOP_AGENT_ENABLED` and `VOICE_ENABLED` are `false`. A test that needs one
  turns it on for itself with `vi.stubEnv`.
- Turbo and Next telemetry are disabled.

**The fence has to survive Turbo.** Turbo 2 defaults to *strict* env mode: a
task process receives only the variables named in `turbo.json`'s
`env`/`globalEnv`. A blanked variable would arrive *absent*, and `dotenv` fills
an absent variable from the root `.env` — exactly the hole the fence closes.
Every Turbo run the watcher makes therefore passes `--env-mode=loose`
(`turboArgs`), which forwards the environment the watcher built. Undeclared
variables never enter a cache hash, so caching is unaffected. If you add a Turbo
run to the watcher, add it through `turboArgs`; `scripts/qa-watch.test.mjs` pins
it.

The watcher writes `.qa-watch/qa-watch.log`, `.qa-watch/qa-watch.pid`, and a
`.qa-watch/stop.request` file while stopping. The directory is gitignored. Both
modes register a PID, so `qa:watch:stop` stops a one-off `qa:watch:full` as
well, and a second watcher is refused while one is running.

The log is bounded for the whole session, not just at start-up: when it grows
past `QA_WATCH_LOG_MAX_BYTES` (default 5 MB) it is rotated to
`.qa-watch/qa-watch.log.1` and a fresh log is started, so the previous tail
survives for diagnosis while disk use stays bounded. A single very large write
from a child may overshoot the limit once; the next rotation replaces `.1`.

**A PID is not an identity.** Windows reuses process IDs, so a pid file left by
a crashed watcher can point at a completely unrelated live process. Both
scripts therefore verify the command line still runs `qa-watch.mjs`
(`scripts/qa-watch-process.mjs`) before acting:

- `qa:watch:stop` removes a stale record whose PID now belongs to another
  process, and never asks that process to stop. If the command line cannot be
  read at all, it asks for a graceful stop but does not force-kill.
- A new watcher removes the same stale record and starts, instead of refusing
  because of an unrelated program. If the recorded process cannot be verified,
  it refuses to start rather than risk running two watchers.

**Noise it ignores.** `fs.watch` on Windows reports the *directory* as well as
files, and a recursive watcher can report its own root after a change-buffer
overflow; acting on that once queued fifteen workspaces' suites at the same
instant. A directory-shaped path is ignored, and a file event is only acted on
when the file's mtime is newer than the watcher and differs from the last event
seen for it. Deleting a test file logs "nothing to run" instead of invoking
vitest on a path that no longer exists.

**Tuning and troubleshooting.**

- `QA_WATCH_DEBOUNCE_MS` (default 500), `QA_WATCH_FILE_TIMEOUT_MS` (300000) and
  `QA_WATCH_SUITE_TIMEOUT_MS` (900000) adjust the loop; `--verbose` logs ignored
  events, including the file that triggered each queued run.
  `QA_WATCH_STOP_TIMEOUT_MS` (10000) is how long `qa:watch:stop` waits for a
  graceful stop before it ends the process tree itself.
  `QA_WATCH_LOG_MAX_BYTES` (default 5 MB) is the log rotation threshold.
- The watcher runs one job at a time and coalesces saves. A change made during a
  run is queued, not run in parallel — builds and suites are never interrupted
  mid-write.
- If PowerShell refuses `pnpm` (`pnpm.ps1 cannot be loaded because running
  scripts is disabled`), use `pnpm.cmd`, or allow local scripts once:
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. The package scripts
  themselves call `node` directly and are unaffected.
- The watcher's own tests: `node --test scripts/qa-watch.test.mjs`.
- What it does not cover: a change outside a workspace (`docs/`, `turbo.json`,
  `pnpm-lock.yaml`, `tsconfig.base.json`) is not watched at all — run
  `pnpm qa:watch:full`. The watcher also does not run `*.pg.integration.test.ts`
  at all; those need a separate test database and are CI's job.
