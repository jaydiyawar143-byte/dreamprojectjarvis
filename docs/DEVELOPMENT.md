# Developing JARVIS

Setup, configuration and the checks a change must pass. Verified on 2026-09-14; reconciled with the code and with CI on 2026-10-05, commit `68628c0`.

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

Deploying the Docker stack, checking that it is healthy, rolling it back and monitoring it are in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Quality gates

Run all four before calling a change done.

| Command | What it proves | Today |
|---|---|---|
| `pnpm typecheck` | every workspace compiles | all 19 workspaces — green in CI |
| `pnpm lint` | the ESLint baseline holds (`eslint.config.mjs`) | all 19 workspaces — green in CI |
| `pnpm test` | all suites, one workspace at a time | see below |
| `pnpm build` | production build of every workspace | all 19 workspaces — green in CI |

"Green in CI" means GitHub Actions run 37306626267, commit `68628c0`. GitHub's job logs need admin access, so per-task counts were not read from that run; on 2026-09-14, with 18 workspaces, they were typecheck 33/33, lint 18/18 and build 18/18.

**One workspace or one file:**

```bash
pnpm --filter @jarvis/api exec vitest run
pnpm --filter @jarvis/api exec vitest run test/access-log.test.ts
```

**B-1 is fixed.** The six memory end-to-end tests that failed on every run pass since 2026-09-14. The cause was a race in the test harness, not a production memory bug; [MEMORY.md](./MEMORY.md) has the details. To check them:

```bash
pnpm --filter @jarvis/api exec vitest run test/sprint-1.1d-memory-e2e.test.ts -t "TEST (A|B|C|G|N):|TEST E & TEST F:"
```

On 2026-09-14 that command gave `6 passed | 7 skipped` in three consecutive runs, and the whole API suite passed 1,159 tests with 8 skipped. Both used the in-process memory store because Postgres was not running. Only the API and `@jarvis/memory` suites were re-run after the fix; the file has since also passed 13/13 against Postgres. The full repository suite was run on 2026-10-06 (Phase 13), one workspace at a time: 7,668 tests passed without a database across 18 workspaces, with the 80 database-backed ones skipping themselves, and those and `@jarvis/db` then passed against a fresh database (below). None failed.

**`@jarvis/db` tests** need PostgreSQL with pgvector. Point `DATABASE_URL` at a separate test database, never the development one: the tests insert and delete rows. On 2026-09-14 they gave 188 passed / 8 failed. The 8 were 7 test bugs and 1 stale test, classified in the ledger (R-4) and fixed in test code on 2026-09-16. One more test, `phase102` crash recovery, failed once in seven runs that day; its cause was not established. **Today** they give 234 passed / 0 failed on a fresh throwaway pgvector database (21 files, 2026-10-06), and CI runs them on every push — see "PostgreSQL-backed tests" below. A fresh database migrates cleanly since `39b190d` (R-22).

**Load-sensitive timing tests (observed 2026-10-05).** In full local runs of the `@jarvis/api` suite on Windows, two S8 MCP timing tests failed occasionally: `mcp-pilot-failures-s8` › "timeout: ToolExecutor's deadline ends the call…" in 2 of 2 full runs with a database (the 500 ms deadline fell while the server was still starting), and `mcp-integration-s8` › "is ERROR — timed out — when a running server stops answering" in 1 of 2 full runs without one. Run alone, the first passed 5 of 5. GitHub CI is green. No deterministic failure has been established, and neither test is marked flaky — ledger R-5.

**Line endings.** The root `.gitattributes` (`* text=auto eol=lf`) makes every platform check text files out as LF, so `apps/api/test/google-write-reachability.test.ts` — which asserts a source snippet spanning a line break — no longer fails on a fresh Windows clone, and a `migration.sql` hashes to the same Prisma checksum everywhere. Git already stored every tracked file with LF, so nothing committed was rewritten. **A clone made before this** keeps its CRLF files on disk until it checks them out again or is renormalized (`git add --renormalize .`); in such a checkout that test still reports a false failure, and `prisma migrate` still reports a checksum mismatch on the three migrations that are CRLF there — ledger R-20.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on pushes to `main`, on pull requests, and on demand. It is one job on Ubuntu with Node 24 — the same major the production image runs since R-19, so CI now exercises the production runtime. Node 20 could not run the web tests at all: the test toolchain (jsdom 30) requires Node `^22.22.2` or `^24.15.0`.

| Step | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Prisma client | `pnpm --filter @jarvis/db exec prisma generate` |
| Lint | `pnpm lint` |
| Typecheck | `pnpm typecheck` |
| Typecheck test files | `pnpm typecheck:tests` — the API's test files |
| Build | `pnpm build` |
| Tests | `pnpm --filter <name> test` for `@jarvis/api`, `@jarvis/memory`, `@jarvis/n8n` and `@jarvis/web` |
| Migrations | `pnpm --filter @jarvis/db exec prisma migrate deploy`, against the CI database |
| PostgreSQL tests | `vitest run` for all of `@jarvis/db`; `vitest run pg.integration` for `@jarvis/memory`; `vitest run pg.integration sprint-1.1d-memory-e2e` for `@jarvis/api` |
| Skip check | `node .github/scripts/assert-no-skipped-tests.mjs` on the PostgreSQL tests' JSON reports |

Any failure fails the run. Each test step runs once the build has passed, even if an earlier test step failed, so one run lists every failing suite.

**PostgreSQL-backed tests.** The job starts a `pgvector/pgvector:pg16` service container, pinned by digest, that exists for that run only, on port 5436, away from the development (5432) and deployment (5433) databases; the two L5 memory suites refuse those ports, the other database tests do not. Its credentials are fixed test values written in the workflow; no repository secret is involved. Every migration is applied to the empty database first, so a migration that cannot apply from scratch fails the run (R-22). Then all of `@jarvis/db`, the `*-pg.integration` files of `@jarvis/memory` and `@jarvis/api`, and the API's memory end-to-end test run against it. `DATABASE_URL` is set on those steps only; the four test steps above still run without a database, as before.

Those files skip themselves when they cannot reach a database, and vitest counts a skip as a pass. The skip check therefore fails the run if any test in the PostgreSQL steps was skipped, or a report is missing. A database that is down, a migration that fails and a test that fails each fail the run. The memory end-to-end test is the exception: without a database it falls back to an in-process store instead of skipping, so for that file only the migration step proves the database was there.

A new database-backed test in `apps/api` or `packages/memory` must be named `*-pg.integration.test.ts`: CI selects those files by that name. Every `@jarvis/db` test runs.

The PostgreSQL steps were added on 2026-10-05 and replayed locally, in order, on a fresh container of the pinned image: 27 migrations applied; `@jarvis/db` 223/223, `@jarvis/memory` 61/61, `@jarvis/api` 25/25; nothing skipped. Those counts are local. On GitHub the steps first ran in run 37306626267 (commit `68628c0`): the service started, every migration applied, the three database steps and the skip check passed. The skip check passing there means each report existed, held tests and skipped none; GitHub's job logs need admin access, so the exact counts were not read from GitHub.

Phase 13 (2026-10-06) added one migration and two database test files, and needed no change to the workflow: the new files are picked up by the names above. The same local replay then gave 28 migrations applied; `@jarvis/db` 234/234, `@jarvis/memory` 61/61, `@jarvis/api` 32/32; nothing skipped. Those are local counts too, taken before that change's own GitHub run.

**Protected `main`.** Since 2026-10-05 the active GitHub ruleset "Protect main" applies to `main`, the default branch, and GitHub reports it as protected:

- A change reaches `main` only through a pull request; pushing to `main` directly is refused. The required number of approvals is 0, "Require approval of the most recent reviewable push" is on, and every review conversation must be resolved.
- The status check "Lint, typecheck, build and tests" — the job in `ci.yml` — must pass, on a branch that is up to date with `main`.
- Force pushes and deleting `main` are blocked. The ruleset has no bypass list.

So CI blocks merges into `main`. Other branches are not protected. No pull request has been merged through the ruleset yet.

**Not covered yet:**

- **Test files outside `apps/api`.** `typecheck:tests` exists only in that workspace, so other packages' test files are not type-checked. (Ledger R-18, the API's own 60 errors, is closed: they were fixed in `1c1c1bd` and CI gates the script.)
- **The other workspaces' tests** — `@jarvis/agents`, `tools`, `security`, `core`, `config` and the provider packages. Run them locally with `pnpm test`.
- **Secret scanning and dependency audits** — audit finding SEC-7.

**Status, 2026-10-05:** the workflow runs on GitHub on every push to `main` and on pull requests, since its first run on 2026-09-14 (`df1d099`). Run 37306626267, for `68628c0`, passed every step.

**Historical, 2026-09-14 — before its first GitHub run:** its `run` steps were replayed locally, in order, in a clean checkout with LF line endings, no `.env`, no Turborepo cache, Node 24.16.0 and pnpm 9.0.0 — on Windows, not Ubuntu. Every step passed: lint 18/18, typecheck 33/33, build 18/18, `@jarvis/api` 1,159 passed and 8 skipped, `@jarvis/memory` 453/453, `@jarvis/n8n` 65/65, `@jarvis/web` 552/552. The three `uses:` actions — checkout, pnpm setup and Node setup — have not been exercised.

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
