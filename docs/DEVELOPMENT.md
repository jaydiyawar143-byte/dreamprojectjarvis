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

**Phase 14 (2026-10-08) — the same file, a second race.** With PostgreSQL it still failed occasionally: `PrismaMemoryRepository.list()` read its page and its total as two statements, so a memory committed between them gave a total of 1 beside an empty page. Fixed in the repository (one REPEATABLE READ batch transaction) and pinned by `packages/db/test/memory-list-coherence-p14-pg.integration.test.ts`; [MEMORY.md](./MEMORY.md#b-1--resolved) has the details. The suite now uses PostgreSQL only when `DATABASE_URL` is a separate test database (never port 5432 or 5433 — it used to write its fixture users into the development database when that was running), and with `JARVIS_REQUIRE_POSTGRES=1` it fails instead of falling back to its in-process store.

**The Phase 14 memory end-to-end test** is `apps/api/test/phase14-memory-e2e-pg.integration.test.ts`: state a preference, recall it, correct it, list it, forget it through `ToolExecutor`, project isolation, expiry and the retention sweep — on the production classes and PostgreSQL. It has no in-memory fallback: with a database configured but unreachable it **fails**; with none configured it is reported as skipped, and `JARVIS_REQUIRE_POSTGRES=1` turns that into a failure too.

```bash
# A throwaway pgvector database on a spare port — never 5432 or 5433.
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5436/DB?schema=public JARVIS_REQUIRE_POSTGRES=1 \
  pnpm --filter @jarvis/api exec vitest run phase14-memory-e2e sprint-1.1d-memory-e2e
```

**The Phase 15 marketing end-to-end test** is `apps/api/test/marketing-e2e-pg.integration.test.ts`: campaigns, the calendar, research, reports, recommendations and the whole publish lifecycle — from the Marketing page's router and from chat — on the production classes and PostgreSQL. The real `ToolExecutor`, approval, audit and journal repositories, rate limiter and Meta **read** tools run; only the three edges are stand-ins (the ad account behind those tools, a Facebook Page, and the web), plus a chat model that proposes exactly the tool call a test queues. It reaches no network and no provider. Like the Phase 14 test it has no in-memory fallback, refuses ports 5432 and 5433, and with `JARVIS_REQUIRE_POSTGRES=1` fails instead of skipping.

```bash
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5436/DB?schema=public JARVIS_REQUIRE_POSTGRES=1 \
  pnpm --filter @jarvis/api exec vitest run marketing-e2e-pg
```

**Starting an API by hand, away from your `.env`.** `@jarvis/config` loads `./.env` from the **working directory** when it is imported, and `apps/api` loads `../../.env` — so that both launch styles read the one root file (`apps/api/src/config/env.ts`). Cleaning the process's environment does not undo that. An API started from the repository root, or from `apps/api`, therefore has every credential in the root `.env` — including the Meta token, which is enough to register the real Page publisher. To run an instance that cannot reach a provider, start it from an empty directory (`node /path/to/apps/api/dist/index.js`) with only the variables you mean it to have, and read its `marketing_wiring` and `meta_credentials_check` lines before using it: `"publishers":[]` and `"tokenSet":false`.

The rest of the marketing tests need no database: `pnpm --filter @jarvis/api exec vitest run marketing` (routes, publish flow, container wiring, the Google Ads source), `pnpm --filter @jarvis/web exec vitest run marketing`, and the contract files CI selects by name — see "Continuous integration".

**The full repository suite, Phase 15 (2026-10-12).** One `pnpm test`, on Windows with Node 24: **8,959 passed without a database across 19 workspaces; the 480 database-backed tests skipped themselves; none failed.** Those 480 and all of `@jarvis/db` then passed against a fresh database (below). `pnpm typecheck` (35 tasks), `pnpm lint` (19) and `pnpm typecheck:tests` passed on the final code. `pnpm build` passed for all 19 workspaces, including the Next.js production build of the new `/marketing` page; after the last edits the three workspaces they touched — `@jarvis/core`, `@jarvis/api` and `@jarvis/web` — were each rebuilt and passed, and the repo-wide build was not repeated. These are local results; the change has not run on GitHub.

**After the Phase 15 audit fixes (2026-10-13).** The whole CI sequence was replayed on Linux (Node 24, Docker) from a clean copy of the working tree — tracked and new files, nothing ignored, so no `.env` and no local build output — with a brand-new pgvector database. Every step passed: lint 19/19, typecheck 35/35, test-file typecheck 17/17, the repo-wide build 19/19; `@jarvis/api` 2,332 passed (168 database-backed skipped), `@jarvis/memory` 660 (96 skipped), `@jarvis/n8n` 65, `@jarvis/web` 797; the memory contracts 632 + 75 + 162; the marketing contracts 205 + 83 + 107 + 58 + 61 = 514; 30 migrations applied; `@jarvis/db` 341/341 (25 files), `@jarvis/memory` 93/93, `@jarvis/api` 181/181 (7 files), the evaluation 13/13; the skip check 0 not run. Every workspace's tests were also run there, which is more than CI gates: 9,048 passed, 520 database-backed skipped, **1 failed** — `historical-outcome-engine` test 17 in `@jarvis/core`, a performance budget (10,000 outcomes in under 100 ms; it took 206 ms while every workspace's tests ran at once). It is not in a file these fixes touched and is not gated by CI.

**Three timing-sensitive tests, none of them marketing.** They were seen failing on 2026-10-13 and are recorded here so a red run is not mistaken for a regression: (1) the performance budget above; (2) `evidence-builder` in `@jarvis/core`, "identical evidenceHash … regardless of builtAt", which expects two timestamps taken one after the other to differ and fails when both fall in the same millisecond — 5 of 8 runs on the Windows machine that day; (3) three MCP tests that give a child server 500 ms — `packages/mcp/test/verify-s8` and `apps/api/test/mcp-integration-s8` as its connection timeout, `mcp-pilot-failures-s8` as the executor's deadline for the call — which failed on that machine in full-suite runs. Why was not established. An earlier version of this paragraph said they failed while starting a Node process took about 550 ms and passed once it took about 250 ms; that does not hold: they passed with a measured start-up of 642 ms on 2026-10-13, and 3 of 3 with about 340 ms on 2026-10-14. All three pass on the Linux replay except (1). None was changed.

**Memory quality evaluation.** `pnpm --filter @jarvis/memory eval` runs the evaluation dataset through the production extraction service and the real repository and prints a report — extraction precision and recall, forbidden-memory rate, retrieval relevance, control compliance, correction and project-isolation pass rates, and the relevance-weight comparison. It needs the same throwaway `DATABASE_URL` and calls no model provider. `MEMORY_EVAL_REPORT=<file>` also saves it as JSON. The real-embedding evaluation is separate and opt-in — `JARVIS_MEMORY_EVAL_REAL_EMBEDDINGS=1` with `OPENAI_API_KEY` set; it sends 30 invented sentences in one embeddings request and is never run by CI. Both are described in [MEMORY.md](./MEMORY.md#quality-evaluation).

**`@jarvis/db` tests** need PostgreSQL with pgvector. Point `DATABASE_URL` at a separate test database, never the development one: the tests insert and delete rows. On 2026-09-14 they gave 188 passed / 8 failed. The 8 were 7 test bugs and 1 stale test, classified in the ledger (R-4) and fixed in test code on 2026-09-16. One more test, `phase102` crash recovery, failed once in seven runs that day; its cause was not established. **Today** they give 234 passed / 0 failed on a fresh throwaway pgvector database (21 files, 2026-10-06), and CI runs them on every push — see "PostgreSQL-backed tests" below. A fresh database migrates cleanly since `39b190d` (R-22). After Phase 15 (2026-10-12): 327 passed / 0 failed, 25 files, 30 migrations applied from scratch.

**Load-sensitive timing tests (observed 2026-10-05).** In full local runs of the `@jarvis/api` suite on Windows, two S8 MCP timing tests failed occasionally: `mcp-pilot-failures-s8` › "timeout: ToolExecutor's deadline ends the call…" in 2 of 2 full runs with a database (the 500 ms deadline fell while the server was still starting), and `mcp-integration-s8` › "is ERROR — timed out — when a running server stops answering" in 1 of 2 full runs without one. Run alone, the first passed 5 of 5. GitHub CI is green. No deterministic failure has been established, and neither test is marked flaky — ledger R-5.

**Line endings.** The root `.gitattributes` (`* text=auto eol=lf`) makes every platform check text files out as LF, so `apps/api/test/google-write-reachability.test.ts` — which asserts a source snippet spanning a line break — no longer fails on a fresh Windows clone, and a `migration.sql` hashes to the same Prisma checksum everywhere. Git already stored every tracked file with LF, so nothing committed was rewritten. **A clone made before this** keeps its CRLF files on disk until it checks them out again or is renormalized (`git add --renormalize .`); in such a checkout that test still reports a false failure, and `prisma migrate` still reports a checksum mismatch on the three migrations that are CRLF there — ledger R-20.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on pushes to `main`, on pull requests, and on demand. It is one job on Ubuntu with Node 24 — the same major the production image runs since R-19, so CI now exercises the production runtime. Node 20 could not run the web tests at all: the test toolchain (jsdom 30) requires Node `^22.22.2` or `^24.15.0`.

| Step | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Prisma client | `pnpm --filter @jarvis/db exec prisma generate` |
| Lint | `pnpm lint` — each package's `src/`, and the API's `scripts/` too |
| Typecheck | `pnpm typecheck` |
| Typecheck test files | `pnpm typecheck:tests` — the API's test files and scripts (except `scripts/phase116b`), and the Phase 17 test files of `@jarvis/db` and `@jarvis/security` |
| Build | `pnpm build` |
| Tests | `pnpm --filter <name> test` for `@jarvis/api`, `@jarvis/memory`, `@jarvis/n8n` and `@jarvis/web`; `@jarvis/security` (Phase 17) in its own step after the marketing contracts |
| Memory contracts (Phase 14) | `vitest run memory learning` in `@jarvis/core`, `vitest run memory-tools` in `@jarvis/tools`, `vitest run memory` in `@jarvis/agents` — by file name; those workspaces' other tests are still not gated |
| Marketing contracts (Phase 15) | `vitest run marketing seo-audit` in `@jarvis/core`, `vitest run marketing-tools` in `@jarvis/tools`, `vitest run marketing-agent` in `@jarvis/agents`, `vitest run page-fetcher` in `@jarvis/browser`, `vitest run page-publisher` in `@jarvis/meta-graph` — by file name, for the same reason as the memory contracts |
| Shared-connection contracts (Phase 17 hardening) | `vitest run shared-connection` in `@jarvis/tools` and in `@jarvis/agents` — by file name, for the same reason |
| Migrations | `pnpm --filter @jarvis/db exec prisma migrate deploy`, against the CI database |
| PostgreSQL tests | `vitest run` for all of `@jarvis/db`; `vitest run pg.integration` for `@jarvis/memory`; `vitest run pg.integration sprint-1.1d-memory-e2e` for `@jarvis/api` |
| Memory quality evaluation (Phase 14) | `vitest run memory-quality-eval-p14-pg` in `@jarvis/memory`, against the CI database — its own gate, with the report in the log and a JSON report for the skip check |
| Skip check | `node .github/scripts/assert-no-skipped-tests.mjs` on the PostgreSQL tests' JSON reports — `@jarvis/db`, `@jarvis/memory`, `@jarvis/api` and the evaluation step |

Any failure fails the run. Each test step runs once the build has passed, even if an earlier test step failed, so one run lists every failing suite.

**PostgreSQL-backed tests.** The job starts a `pgvector/pgvector:pg16` service container, pinned by digest, that exists for that run only, on port 5436, away from the development (5432) and deployment (5433) databases; the two L5 memory suites refuse those ports, the other database tests do not. Its credentials are fixed test values written in the workflow; no repository secret is involved. Every migration is applied to the empty database first, so a migration that cannot apply from scratch fails the run (R-22). Then all of `@jarvis/db`, the `*-pg.integration` files of `@jarvis/memory` and `@jarvis/api`, and the API's memory end-to-end test run against it. `DATABASE_URL` is set on those steps only; the four test steps above still run without a database, as before.

Those files skip themselves when they cannot reach a database, and vitest counts a skip as a pass. The skip check therefore fails the run if any test in the PostgreSQL steps was skipped, or a report is missing. A database that is down, a migration that fails and a test that fails each fail the run. The memory end-to-end test is the exception: without a database it falls back to an in-process store instead of skipping, so for that file only the migration step proves the database was there.

A new database-backed test in `apps/api` or `packages/memory` must be named `*-pg.integration.test.ts`: CI selects those files by that name. Every `@jarvis/db` test runs.

The PostgreSQL steps were added on 2026-10-05 and replayed locally, in order, on a fresh container of the pinned image: 27 migrations applied; `@jarvis/db` 223/223, `@jarvis/memory` 61/61, `@jarvis/api` 25/25; nothing skipped. Those counts are local. On GitHub the steps first ran in run 37306626267 (commit `68628c0`): the service started, every migration applied, the three database steps and the skip check passed. The skip check passing there means each report existed, held tests and skipped none; GitHub's job logs need admin access, so the exact counts were not read from GitHub.

Phase 13 (2026-10-06) added one migration and two database test files, and needed no change to the workflow: the new files are picked up by the names above. The same local replay then gave 28 migrations applied; `@jarvis/db` 234/234, `@jarvis/memory` 61/61, `@jarvis/api` 32/32; nothing skipped. Those are local counts too, taken before that change's own GitHub run.

Phase 14 (2026-10-08) added one migration and seven database test files, picked up by the names above, and changed the workflow in three places: the memory-contract step and the evaluation step in the table, and `JARVIS_REQUIRE_POSTGRES=1` on the three PostgreSQL test steps, so the two memory end-to-end tests fail rather than fall back or skip if the database cannot be reached. No step calls a model provider. The same local replay gave 29 migrations applied; `@jarvis/db` 269/269 (23 files), `@jarvis/memory` 89/89 (9 files), `@jarvis/api` 44/44 (5 files); the memory-contract step 614 + 73 + 162; nothing skipped. The database-backed API files and the memory end-to-end test were then run 30 times in a row on the final code, each on a brand-new container with every migration applied from scratch: all passed. One earlier failure of that loop is not explained — see [MEMORY.md](./MEMORY.md#b-1--resolved). Those are local counts, taken on Windows with Node 24 on 2026-10-09; the changed workflow has not run on GitHub yet.

Phase 15 (2026-10-12) added one migration and two database test files — `packages/db/test/marketing-p15-pg.integration.test.ts` and `apps/api/test/marketing-e2e-pg.integration.test.ts` — both picked up by the names above, and **added one step** to the workflow: the marketing-contract step in the table. It adds a gate and changes no existing one. The tests it selects would otherwise not run in CI at all, because `@jarvis/core`, `tools`, `agents`, `browser` and `meta-graph` are not gated as workspaces. No step reaches a provider: the Page publisher and the page reader are tested against stand-ins. The same local replay, on a brand-new `pgvector/pgvector:pg16` container (the tag, not CI's pinned digest) with every migration applied from scratch, gave 30 migrations applied; `@jarvis/db` 327/327 (25 files), `@jarvis/memory` 93/93 (9 files), `@jarvis/api` 155/155 (7 files), the evaluation 13/13; the skip check reported 0 not run in all four reports; the marketing-contract step 203 + 74 + 106 + 58 + 46. Those are local counts, taken on Windows with Node 24 on 2026-10-12; the changed workflow has not run on GitHub yet. The audit fixes of 2026-10-13 changed no step of the workflow. They added one test file to `apps/api` that needs no database (`marketing-limits-p15`, run by "Test @jarvis/api") and tests to files CI already selects; the counts after them are in the paragraph "After the Phase 15 audit fixes" above.

Phase 17 (2026-10-17) added one migration and two database test files — `packages/db/test/tenant-foundation-p17-pg.integration.test.ts` and `apps/api/test/n8n-mcp-tenancy-p17-pg.integration.test.ts` — both picked up by the names above, and changed the workflow in two ways: **one new step**, `Test @jarvis/security`, and a wider `typecheck:tests` (the API's `scripts/`, except `scripts/phase116b`; the Phase 17 test files of `@jarvis/db` and `@jarvis/security`), with the API's lint now covering `scripts/` as well. It adds gates and changes no existing one. The new step reaches no provider and needs no database: the authorization engine is pure. The same local replay, on a brand-new `pgvector/pgvector:pg16` container (the tag, not CI's pinned digest) with every migration applied from scratch, gave 31 migrations applied; `@jarvis/db` 387/387 (26 files), `@jarvis/memory` 93/93 (9 files), `@jarvis/api` 220/220 (8 files), the evaluation 13/13; the skip check reported 0 not run in all four reports. Those are local counts, taken on Windows with Node 24 on 2026-10-17; the changed workflow has not run on GitHub yet.

The Phase 17 multi-business hardening (2026-10-18) added one migration and two database test files — `packages/db/test/shared-connection-approvals-p17-pg.integration.test.ts` and `apps/api/test/shared-connection-hardening-p17-pg.integration.test.ts` — both picked up by the names above, the first also type-checked by `typecheck:tests`; and **one new step**, the shared-connection contracts in the table. It adds gates and changes no existing one. The two database suites never skip quietly: with a database configured that cannot be reached, or with none under `JARVIS_REQUIRE_POSTGRES=1`, they fail. Both — and `phase116a-bridge-pg` — need the deployment-wide `meta/ads` owner row to themselves, and vitest runs files in parallel, so they take a PostgreSQL advisory lock for it first (`apps/api/test/helpers/shared-connection-lock.ts`, `holdSharedConnection`). The same local replay, on a brand-new `pgvector/pgvector:pg16` container with every migration applied from scratch, gave 32 migrations applied; `@jarvis/db` 410/410 (27 files), `@jarvis/memory` 93/93 (9 files), `@jarvis/api` 228/228 (9 files), the evaluation 13/13; the skip check reported 0 not run in all four reports; the new step 11 + 8. Every workspace's tests without a database: 9,682 passed, 0 failed, 633 skipped. Those are local counts, taken on Windows with Node 24 on 2026-10-18; the changed workflow has not run on GitHub yet.

**Protected `main`.** The active GitHub ruleset "Protect main" applies to `main`, the default branch. As the GitHub API reports its rules on 2026-10-17:

- The status check "Lint, typecheck, build and tests" — the job in `ci.yml` — is required, **non-strict**: the branch need not be up to date with `main`, so the merge result of a stale branch is not re-tested.
- Force pushes and deleting `main` are blocked. The ruleset has no bypass list.
- There is **no pull-request rule**: no approval and no resolved-conversation requirement. A direct push is still held to the required check — GitHub accepts it only for a commit on which that check has already passed, in a pull request or a run started on demand.

From 2026-10-05 this paragraph said a pull request was required, with "Require approval of the most recent reviewable push" on, every conversation resolved and an up-to-date branch. The API reports none of those rules today; when they stopped applying is not recorded here. Other branches are not protected. The ruleset was read, not changed.

**Not covered yet:**

- **Most test files outside `apps/api`.** `typecheck:tests` runs in `apps/api` and, for their Phase 17 test files only, in `@jarvis/db` and `@jarvis/security`; other packages' test files are not type-checked. Left out by name until they are fixed or retired: the older test files of `@jarvis/db` (13 errors in seven Phase 10–11 files) and `@jarvis/security` (2 errors in two files), and `apps/api/scripts/phase116b` (23 errors in four files, which no longer match the code they call). (Ledger R-18, the API's own 60 errors, is closed: they were fixed in `1c1c1bd` and CI gates the script.)
- **The other workspaces' tests** — `@jarvis/agents`, `tools`, `core`, `config` and the provider packages. Run them locally with `pnpm test`. Three slices of them are gated by file name: the memory contracts (Phase 14), the marketing contracts (Phase 15) and the shared-connection contracts (Phase 17). Everything else in those workspaces — including the pinned agent-policy and skill censuses that Phase 15 updated, and the executor's byte pin in `mcp-boundaries-s8` — still runs only locally.
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
