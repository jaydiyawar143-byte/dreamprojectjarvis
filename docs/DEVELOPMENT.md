# Developing JARVIS

Setup, configuration and the checks a change must pass. Verified on 2026-09-14.

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 24 | One runtime everywhere: the production image (`node:24-alpine`), CI and local development. Node 20 reached end of life on 2026-04-30, and the test toolchain refuses it — jsdom 30 requires `^22.22.2` or `^24.15.0`, undici 8 requires `>=22.19.0`. The root `engines` says `>=24.15.0`; there is no `engine-strict`, so an older Node warns rather than fails — ledger R-19 |
| pnpm | 9 | the workspace package manager |
| Docker | any recent | PostgreSQL **with pgvector** — a plain `postgres` image cannot run the migrations |
| Chrome or Edge | installed | browser automation, and the `run-jarvis` driver |

## Environment files

There is **one** environment file you edit: `.env` at the repository root. Two frameworks need a small file of their own beside it.

| File | Holds | Read by | Committed |
|---|---|---|---|
| `.env` | every value | the API and every package | never |
| `.env.example` | every variable **name**, with placeholders | people | yes |
| `packages/db/.env` | `DATABASE_URL` only, same value as the root | the Prisma CLI, which looks for `.env` beside the schema | never |
| `apps/web/.env.local` | `NEXT_PUBLIC_API_URL` only | Next.js, which reads env files from its own folder. Optional locally | never |

Nothing reads `.env.local`, `.env.development` or `.env.production` at the root or in `apps/api`.

**How the API finds the root `.env`:** `@jarvis/config` loads `./.env` from the working directory when it is imported, and `apps/api/src/config/env.ts` loads `../../.env`. The first covers a launch from the repository root (as the Dockerfile does); the second covers a launch from `apps/api` (as `pnpm dev` does). Neither overrides a variable already set, so container `env_file` values win.

**Adding a variable:** add its name and a placeholder to `.env.example`, and parse it in the owning package's config. Never add another env file.

## First-time setup

```bash
pnpm install

cp .env.example .env
# Fill in DATABASE_URL and JWT_SECRET (32+ characters). Add OPENAI_API_KEY for
# chat, memory and document search: without it the API still starts, but chat
# answers 503 AI_PROVIDER_NOT_CONFIGURED. Production refuses to start without it.
# Then create packages/db/.env containing the same DATABASE_URL.

docker run -d --name jarvis-postgres \
  -e POSTGRES_USER=jarvis -e POSTGRES_PASSWORD=<your password> \
  -e POSTGRES_DB=jarvis -p 5432:5432 pgvector/pgvector:pg16

pnpm db:generate
pnpm db:migrate
pnpm db:seed

pnpm dev
```

If the container already exists, `docker start jarvis-postgres` keeps its data.

## Ports

| Stack | Web | API | PostgreSQL |
|---|---|---|---|
| Local (`pnpm dev`) | 3000 | 3001 | 5432 |
| Docker (`docker-compose.yml`) | 3100 | 3101 | 5433 — a separate database |

The two stacks are deliberately side by side. Set `AUTH_COOKIE_NAME` differently for each, because cookies ignore the port.

## Quality gates

Run all four before calling a change done.

| Command | What it proves | Today |
|---|---|---|
| `pnpm typecheck` | every workspace compiles | 33/33 |
| `pnpm lint` | the ESLint baseline holds (`eslint.config.mjs`) | 18/18 |
| `pnpm test` | all suites, one workspace at a time | see below |
| `pnpm build` | production build of every workspace | 18/18 |

**One workspace or one file:**

```bash
pnpm --filter @jarvis/api exec vitest run
pnpm --filter @jarvis/api exec vitest run test/access-log.test.ts
```

**B-1 is fixed.** The six memory end-to-end tests that failed on every run pass since 2026-09-14. The cause was a race in the test harness, not a production memory bug; [MEMORY.md](./MEMORY.md) has the details. To check them:

```bash
pnpm --filter @jarvis/api exec vitest run test/sprint-1.1d-memory-e2e.test.ts -t "TEST (A|B|C|G|N):|TEST E & TEST F:"
```

On 2026-09-14 that command gave `6 passed | 7 skipped` in three consecutive runs, and the whole API suite passed 1,159 tests with 8 skipped. Both used the in-process memory store because Postgres was not running. Only the API and `@jarvis/memory` suites were re-run after the fix; the file has since also passed 13/13 against Postgres. The full repository suite remains unverified.

**`@jarvis/db` tests** need PostgreSQL with pgvector. Point `DATABASE_URL` at a separate test database, never the development one: the tests insert and delete rows. On 2026-09-14 they gave 188 passed / 8 failed. The 8 are known — 7 test bugs and 1 stale test, classified in the ledger (R-4). One more test, `phase102` crash recovery, failed once in seven runs; its cause is not established. A fresh database migrates cleanly since `39b190d` (R-22).

**On a fresh Windows clone**, `apps/api/test/google-write-reachability.test.ts` fails because Git converts line endings to CRLF. It is a false failure — ledger R-20.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on pushes to `main`, on pull requests, and on demand. It is one job on Ubuntu with Node 24 — the same major the production image runs since R-19, so CI now exercises the production runtime. Node 20 could not run the web tests at all: the test toolchain (jsdom 30) requires Node `^22.22.2` or `^24.15.0`.

| Step | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Prisma client | `pnpm --filter @jarvis/db exec prisma generate` |
| Lint | `pnpm lint` |
| Typecheck | `pnpm typecheck` |
| Build | `pnpm build` |
| Tests | `pnpm --filter <name> test` for `@jarvis/api`, `@jarvis/memory`, `@jarvis/n8n` and `@jarvis/web` |

Any failure fails the run. Each test step runs once the build has passed, even if an earlier test step failed, so one run lists every failing suite.

**Not covered yet:**

- **Postgres-backed tests.** `@jarvis/db` and the API's real-PostgreSQL file stay separate until a pgvector service container is configured. Without a database that API file skips itself and the memory end-to-end test runs against its in-process store, so a green run proves nothing about the Postgres paths.
- **`typecheck:tests`** in `apps/api` fails with 60 pre-existing errors — ledger R-18, still open. CI does not run it.
- **The other workspaces' tests** — `@jarvis/agents`, `tools`, `security`, `core`, `config` and the provider packages. Run them locally with `pnpm test`.
- **Secret scanning and dependency audits** — audit finding SEC-7.

**Status:** as of 2026-09-14 the workflow has never run on GitHub. Its `run` steps were replayed locally, in order, in a clean checkout with LF line endings, no `.env`, no Turborepo cache, Node 24.16.0 and pnpm 9.0.0 — on Windows, not Ubuntu. Every step passed: lint 18/18, typecheck 33/33, build 18/18, `@jarvis/api` 1,159 passed and 8 skipped, `@jarvis/memory` 453/453, `@jarvis/n8n` 65/65, `@jarvis/web` 552/552. The three `uses:` actions — checkout, pnpm setup and Node setup — have not been exercised.

## Driving the real app

The committed driver starts the stack, signs in as a real user and drives the UI in Chrome.

```bash
npm --prefix .claude/skills/run-jarvis install         # once

node .claude/skills/run-jarvis/driver.mjs doctor       # preflight
node .claude/skills/run-jarvis/driver.mjs up           # postgres + api + web
node .claude/skills/run-jarvis/driver.mjs smoke        # end-to-end check + screenshot
node .claude/skills/run-jarvis/driver.mjs api:chat "Hello JARVIS"
node .claude/skills/run-jarvis/driver.mjs web:shot /approvals approvals
node .claude/skills/run-jarvis/driver.mjs down
```

Dashboard checks that exit non-zero on failure:

```bash
node .claude/skills/run-jarvis/viewport-audit.mjs
node .claude/skills/run-jarvis/dashboard-acceptance.mjs
```

The full guide is `.claude/skills/run-jarvis/SKILL.md`.

## Never commit

- Any `.env` file except `.env.example`.
- Database dumps. The driver's `backups/` folder is ignored because a dump holds real user rows.
- Build output: `dist/`, `.next/`, `*.tsbuildinfo`.

## Before you create a file

Search for the behaviour, extend what exists, and put new code in its one home. `AGENTS.md` has the table — read it first.
