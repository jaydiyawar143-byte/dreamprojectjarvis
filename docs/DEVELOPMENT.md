# Developing JARVIS

Setup, configuration and the checks a change must pass. Verified on 2026-09-14.

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 20 or newer | `engines` in the root `package.json` |
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
# Fill in DATABASE_URL, JWT_SECRET (32+ characters) and OPENAI_API_KEY.
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

**B-1 is fixed.** The six memory end-to-end tests that failed on every run pass since 2026-09-14; [MEMORY.md](./MEMORY.md) has the root cause. To check them:

```bash
pnpm --filter @jarvis/api exec vitest run test/sprint-1.1d-memory-e2e.test.ts -t "TEST (A|B|C|G|N):|TEST E & TEST F:"
```

On 2026-09-14 that command gave `6 passed | 7 skipped` in three consecutive runs, and the whole API suite passed 1,159 tests with 8 skipped. Both used the in-process memory store because Postgres was not running. Only the API and `@jarvis/memory` suites were re-run after the fix; no claim is made here about the other workspaces.

**`@jarvis/db` tests** need the Postgres container running.

There is no CI. These gates run only when someone runs them.

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
