---
name: run-jarvis
description: Build, run, and drive the JARVIS stack (Next.js web + Express API + Postgres/pgvector). Use when asked to start JARVIS, boot the API or web app, send a chat message through the agent stack, hit an API endpoint, take a screenshot of the UI, run the tests, or confirm a change works in the real running app.
---

JARVIS is a pnpm/Turborepo monorepo: an Express + Socket.IO API (`apps/api`,
port 3001), a Next.js 14 app-router frontend (`apps/web`, port 3000), and 11
shared packages, all on Postgres with the **pgvector** extension.

**Drive it with the committed driver**, not by hand:

```bash
node .claude/skills/run-jarvis/driver.mjs help
```

All paths below are relative to the repo root. Everything here was run on
Windows 11 (PowerShell + Git Bash, Node 24.16.0, pnpm 9.15.9).

## Prerequisites

Node 24 (the repository's runtime — ledger R-19), pnpm 9, Docker Desktop, and
a Chromium-family browser (the driver
uses the **system Chrome** — it never downloads one).

**Docker Desktop must be running.** The `docker` CLI is on PATH even when the
daemon is down, so check the daemon, not the binary:

```bash
docker info --format '{{.ServerVersion}}'
```

If that errors, start it and wait ~60s:

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
```

Install the driver's own dependency (`playwright-core`). The skill directory is
**not** a pnpm workspace member, so a root `pnpm install` will not provision it:

```bash
npm --prefix .claude/skills/run-jarvis install
```

## Setup

### 1. Postgres with pgvector

The schema uses `vector(1536)` columns, so a plain `postgres` image will **not**
work — migrations call `CREATE EXTENSION vector`.

If the container already exists, just start it (this preserves existing data):

```bash
docker start jarvis-postgres
```

To create it from scratch, matching the `DATABASE_URL` in the repo-root `.env`:

```bash
docker run -d --name jarvis-postgres \
  -e POSTGRES_USER=jarvis -e POSTGRES_PASSWORD=<password from .env> \
  -e POSTGRES_DB=jarvis -p 5432:5432 pgvector/pgvector:pg16
```

Verify it is actually accepting connections *and* that the port is published:

```bash
docker exec jarvis-postgres pg_isready -U jarvis
docker port jarvis-postgres
```

### 2. Dependencies, Prisma client, schema

Run these from the repo root. They stay there on purpose — `cd packages/db`
leaves you in a directory where the relative `driver.mjs` path no longer
resolves:

```bash
pnpm install --frozen-lockfile
pnpm --filter @jarvis/db exec prisma generate
pnpm --filter @jarvis/db exec prisma migrate status
```

If migrations are pending, apply them and seed the agent rows:

```bash
pnpm --filter @jarvis/db exec prisma migrate deploy
pnpm --filter @jarvis/db run db:seed
```

Note `db:seed` is a package **script**, not a binary —
`pnpm --filter @jarvis/db exec tsx src/seed.ts` fails with
`Command "tsx" not found`.

### 3. Build

```bash
pnpm build
```

Turborepo caches aggressively — a warm build reports `FULL TURBO` in ~1s.

## Run (agent path)

The driver is the primary interface. It preflights, starts and stops the stack,
authenticates as a real user, and drives the real UI in Chrome.

```bash
node .claude/skills/run-jarvis/driver.mjs doctor   # preflight everything
node .claude/skills/run-jarvis/driver.mjs up       # postgres + api + web, ~21s
node .claude/skills/run-jarvis/driver.mjs smoke    # full end-to-end + screenshot
node .claude/skills/run-jarvis/driver.mjs down     # stop api + web
```

`doctor` output when the machine is healthy:

```
  ok    docker daemon reachable
  ok    container jarvis-postgres running
  ok    postgres reachable on 127.0.0.1:5432
  ok    api listening on 3001
  ok    web listening on 3000
  ok    chrome: C:\Program Files\Google\Chrome\Application\chrome.exe
  ok    playwright-core installed
```

### Hitting the API

Every command authenticates itself (registers `driver@jarvis.local` on first
run, logs in thereafter) — no manual token juggling.

```bash
node .claude/skills/run-jarvis/driver.mjs api:health
node .claude/skills/run-jarvis/driver.mjs api:auth
node .claude/skills/run-jarvis/driver.mjs api:chat "Hello JARVIS, reply with exactly: SMOKE OK"
node .claude/skills/run-jarvis/driver.mjs api:get /api/v1/conversations
node .claude/skills/run-jarvis/driver.mjs api:get /api/v1/opportunities
```

`api:chat` runs the whole agent stack — intent routing, memory, tools, OpenAI —
and returns the model reply plus `conversationId`:

```json
{ "success": true, "data": { "message": "SMOKE OK",
  "conversationId": "cmtl3vinw0006ssv0el0pa3b3",
  "agentId": "conversational-assistant",
  "metadata": { "model": "gpt-4o-mini-2024-07-18" } } }
```

### Driving the UI

Screenshots land in `.claude/skills/run-jarvis/screenshots/`.

```bash
node .claude/skills/run-jarvis/driver.mjs web:login
node .claude/skills/run-jarvis/driver.mjs web:chat "Hello JARVIS, reply with exactly: UI OK"
node .claude/skills/run-jarvis/driver.mjs web:shot /approvals approvals
node .claude/skills/run-jarvis/driver.mjs web:shot /opportunities opportunities
```

`web:chat` does the real thing: fills the login form, submits, waits for
`/chat`, types into the composer, presses Enter, waits for the assistant bubble,
and screenshots the reply. **Look at the PNG** — it is the only proof the change
you made actually renders.

## Checking the dashboard

Two committed scripts, both driving the real app in real Chrome. Both need the
stack up and both exit non-zero on failure, so either can gate a change.

```bash
node .claude/skills/run-jarvis/viewport-audit.mjs      # no page scroll, full width
node .claude/skills/run-jarvis/dashboard-acceptance.mjs  # drag, resize, persist
```

`viewport-audit` logs in at 1280×720, 1366×768, 1440×900, 1920×1080 and
2560×1440 and reports `documentElement.scrollWidth/scrollHeight` against the
viewport at each. It exists because the vitest suite cannot answer this
question: jsdom has no layout engine, so `scrollHeight <= innerHeight` passes
there whatever the CSS says. Pass a comma-separated list to override the sizes.
It also reports which widgets are scrolling **inside their own panel**, which is
the designed behaviour on a short screen rather than a defect.

`dashboard-acceptance` drives customise mode with the mouse: it drags widgets by
their grips, drags a corner handle to resize the map, drags an edge handle to
resize the system monitor, hides and restores a widget, saves, logs in again and
compares the layout **in grid units**. It restores the shipped default on the
way out, so it is safe to run repeatedly. Compare pixels across a save/reload
and you will chase a phantom: the customise toolbar is ~18px taller than the
collapsed one, which changes every row height and therefore every widget's
pixel size while the stored layout is identical.

## Run (human path)

Two terminals. Useful for watching logs; useless for an agent, since neither
command ever returns.

```bash
cd apps/api && npx tsx src/index.ts      # -> "JARVIS API running on port 3001"
cd apps/web && npx next dev --port 3000
```

## Test

There is **no root `test` script** — `pnpm test` fails with
`ERR_PNPM_NO_SCRIPT`. Turbo defines the task, so go through turbo:

```bash
npx turbo test
```

Current state: **17 of 19 tasks pass**. `@jarvis/api` fails 10 of 178 tests, all
in `apps/api/test/sprint-1.1d-memory-e2e.test.ts` — see Gotchas, this is
expected and predates this skill.

## Gotchas

- **The driver must browse `localhost:3000`, never `127.0.0.1:3000`.** The API
  answers a fixed `Access-Control-Allow-Origin: http://localhost:3000`
  regardless of request origin, so a page served from `127.0.0.1` has every XHR
  silently killed by CORS. The symptom is maddening: the login form submits, no
  error appears, and the page just never navigates.

- **A hard page load of a protected route 401s, even with a valid token.**
  `apps/web/src/lib/api.ts` keeps the JWT in a module-level `_accessToken`,
  populated only by `setTokens()` (login) or `loadTokens()` (AuthProvider's
  mount effect). React runs child effects *before* parent effects, so
  `ApprovalsPage`'s fetch fires while `_accessToken` is still `null`. The
  401-retry path can't rescue it either — `_refreshToken` is null for the same
  reason. Seeding `sessionStorage` does **not** fix this. The driver therefore
  logs in through the form and then navigates **client-side** by clicking the
  `next/link` anchor, which preserves the in-memory token. Reproduce it by
  hard-refreshing `/approvals` while logged in: "Authentication required".

- **`apps/api/test/sprint-1.1d-memory-e2e.test.ts` passes without a database and
  fails with one.** Its `beforeEach` falls back to an in-process store when
  Prisma won't connect. With a live DB it writes `userId: "user-alpha"`, which
  has no `User` row, and 10 tests die on `Memory_userId_fkey`. Proof:

  ```bash
  cd apps/api && DATABASE_URL="postgresql://jarvis:x@127.0.0.1:59999/jarvis?schema=public" \
    npx vitest run test/sprint-1.1d-memory-e2e.test.ts
  ```

  That reports `12 passed (12)`. The same file under `npx turbo test` reports 10
  failures. Do not "fix" this by pointing at the driver.

- **Git Bash mangles POSIX-looking arguments.** `api:get /api/v1/health` arrives
  at node as `C:/Program Files/Git/api/v1/health`. The driver detects and undoes
  this, so its own commands are safe — but any *other* tool you invoke with a
  path argument from Git Bash needs `MSYS_NO_PATHCONV=1` or PowerShell.

- **`cwd` matters for the API.** `apps/api/src/config/env.ts` loads the root
  `.env` as `resolve(process.cwd(), "../../.env")`. Start it from anywhere but
  `apps/api` and it boots with no `DATABASE_URL`.

- **There are two `.env` files with a `DATABASE_URL`**: the repo root one (read
  by the API) and `packages/db/.env` (read by Prisma CLI). They must agree, or
  migrations and the running app will point at different databases.

- **Registering an existing account returns `400 INVALID_REQUEST`, not 409.**
  The driver treats that 400 as the normal steady state.

- **A `404` console error on every page is just `/favicon.ico`.** There is no
  favicon in `apps/web`. Ignore it; anything else in that list is real.

- **Postgres port publishing lags the container.** Right after Docker Desktop
  starts, `docker ps` can show the container up while `docker port` returns
  nothing and 5432 refuses connections — Prisma then reports
  `P1001: Can't reach database server`. Wait ~30s and re-check `docker port`.

- **Access tokens expire in 900s.** Long driver sessions re-authenticate before
  each call rather than reusing the cached token.

- **Killing the API by pid does not reliably kill it.** The driver spawns
  through `cmd.exe` (required to run `npx.cmd` on Windows), so the pid it
  records is the shell wrapper. The real node process can re-parent and survive
  `taskkill /PID <wrapper> /T /F`. The visible damage is subtle: a stale API
  keeps serving 3001, a later `up` reports "api already up", and you spend a
  while wondering why your code change had no effect. `down` therefore sweeps
  whatever is *listening* on 3000/3001 in addition to its recorded pids, and
  prints `port NNNN free` to prove it. If you ever kill these servers by hand,
  kill by port, not by pid.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `failed to connect to the docker API at npipe:...` | Docker Desktop isn't running. `Start-Process "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"`, wait ~60s. |
| `Error: P1001: Can't reach database server at localhost:5432` | Container up but port not published yet, or not started. `docker start jarvis-postgres` then confirm with `docker port jarvis-postgres`. |
| `P3018 ... column "conversationId" of relation "Approval" already exists` | The DB drifted from migration history (those objects were applied out of band). Confirm they already exist, then reconcile the bookkeeping without touching data — from `packages/db`: `npx prisma migrate resolve --applied 20260826000000_phase119a_pending_action`, then `npx prisma migrate deploy`. Return to the repo root afterwards. |
| Login form submits, nothing happens, no error | CORS. You are on `127.0.0.1:3000`; use `localhost:3000`. |
| `Authentication required` on `/approvals` or `/opportunities` | Hard page load race (see Gotchas). Use `driver.mjs web:shot <route>`, which logs in and navigates client-side. |
| `page.goto: Cannot navigate to invalid URL ...http://localhost:3000C:/Program Files/Git/...` | Git Bash path mangling. Prefix with `MSYS_NO_PATHCONV=1` or use PowerShell. |
| `ERR_PNPM_NO_SCRIPT Missing script: test` | Use `npx turbo test`. |
| `Cannot find module '...run-jarvis/.claude/skills/run-jarvis/driver.mjs'` | You are already inside the skill dir. Run the driver from the repo root, or `node driver.mjs`. |
| `No Chrome/Edge found` | Set `CHROME_PATH` to a browser executable. |
| Driver hangs after "web serving on 3000" | You are on an old copy of `driver.mjs`. It must launch children with raw file descriptors, not `stdio: "pipe"` — pipes keep the parent's event loop alive forever. |
| Code change has no effect; `up` says "api already up on 3001" | Stale orphaned API from an earlier run. `driver.mjs down` (it sweeps by port and prints `port 3001 free`), then `up`. |
| `Error: Cannot find module './727.js'` (or any `./<digits>.js`) from `.next/server/webpack-runtime.js` | `next build` was run while `next dev` was live — they share `apps/web/.next`, and the build replaced the chunks the dev server still references. Nothing is wrong with the source. `driver.mjs down`, `rm -rf apps/web/.next`, `driver.mjs up`. Avoid it by stopping the dev server before any `next build` / `turbo build`. |

## The driver

`.claude/skills/run-jarvis/driver.mjs` — committed alongside this file. Its only
dependency is `playwright-core`, installed into the skill directory itself so
the workspace manifest and lockfile stay untouched. Runtime artifacts
(`screenshots/`, `logs/`, `node_modules/`, `.driver-state.json`, which caches a
live JWT) are gitignored.

Override any default with env vars: `JARVIS_API_URL`, `JARVIS_WEB_URL`,
`JARVIS_USER_EMAIL`, `JARVIS_USER_PASSWORD`, `JARVIS_PG_CONTAINER`,
`CHROME_PATH`.
