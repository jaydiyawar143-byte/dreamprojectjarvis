# JARVIS — Personal AI Operating System

A conversational assistant for marketing and business work. You talk to it in plain language, in English, Hindi or Hinglish; it reads your ad accounts, mail, calendar and documents, remembers what matters about your work, and proposes changes that run only after you approve them.

## What it is built from

| Layer | Technology |
|---|---|
| Web app | Next.js 14 (App Router), React, Zustand, Tailwind |
| API | Node.js, Express, Socket.IO |
| Database | PostgreSQL with pgvector, through Prisma |
| Models and voice | OpenAI (chat, embeddings, vision, speech-to-text, text-to-speech); ElevenLabs text-to-speech |
| Integrations | Meta Ads, Google Ads, Gmail / Drive / Calendar, Google Maps, WhatsApp Business, n8n, browser automation, MCP (two reviewed, read-only tool servers; off unless `JARVIS_MCP_ENABLED=true`) |
| Monorepo | pnpm workspaces and Turborepo |

## Repository

```
apps/
  api/                Express + Socket.IO API
  web/                Next.js dashboard
packages/
  core/               shared types, Zod contracts, pure utilities
  agents/             orchestrator, router, planner, agent policy, domain agents
  tools/              tools, ToolExecutor, execution journal
  memory/             memory extraction, document chunking, embedding, retrieval
  db/                 Prisma schema, migrations, repositories
  security/           passwords, JWT, encryption, permissions, approvals, audit
  config/             environment schema
  ai-openai/  ai-elevenlabs/  ai-anthropic/        model and voice providers
  meta-graph/  google-ads/  google-workspace/
  whatsapp/  n8n/  browser/                        provider clients
  mcp/                MCP runtime and the reviewed MCP servers
docs/                 architecture, API, memory, capabilities, development
```

## Quick start

```bash
pnpm install
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, OPENAI_API_KEY
```

Then follow [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) for the database container, migrations and `pnpm dev`. The web app runs on http://localhost:3000 and the API on http://localhost:3001.

## Documentation

| Read | For |
|---|---|
| [AGENTS.md](./AGENTS.md) | The rules for changing this codebase, and where new code goes |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | How the system fits together |
| [docs/API.md](./docs/API.md) | Every HTTP route |
| [docs/SKILLS.md](./docs/SKILLS.md) | Agents, tools, and what JARVIS can do |
| [docs/JARVIS_CAPABILITY_MATRIX.md](./docs/JARVIS_CAPABILITY_MATRIX.md) | Every capability: status, execution path, approval, agent scope, tests |
| [docs/MEMORY.md](./docs/MEMORY.md) | Memory and document knowledge |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Setup, environment variables, quality gates |
| [docs/CODEBASE_AUDIT.md](./docs/CODEBASE_AUDIT.md) | The 2026-09-14 audit and cleanup |
| [docs/JARVIS_USER_MANUAL.md](./docs/JARVIS_USER_MANUAL.md) | Using JARVIS |

## Safety model

- No secret is hardcoded; credentials live in `.env` or are stored encrypted with AES-256-GCM.
- Anything that changes state outside JARVIS is planned, shown to you, confirmed or approved, executed once, journalled and audited.
- Approvals are bound to the exact parameters you saw and expire; a voice session cannot approve a write.
- Four roles control who can use which tools.

## Status

As of 2026-10-05, commit `68628c0`. The repository has 19 workspaces: 2 apps and 17 packages.

CI (`.github/workflows/ci.yml`) runs on GitHub on every push to `main` and on every pull request: lint, typecheck and build across all 19 workspaces, the typecheck of the API's test files, the `@jarvis/api`, `@jarvis/memory`, `@jarvis/n8n` and `@jarvis/web` suites, and — against a fresh pgvector database — every migration and the PostgreSQL-backed tests, failing if any of those is skipped. Run 37306626267 passed every step. `main` is protected by the active GitHub ruleset "Protect main": a change reaches it only through a pull request, and only after the required check "Lint, typecheck, build and tests" — this CI job — has passed on a branch that is up to date with `main`. Force pushes and deleting `main` are blocked. CI therefore blocks merges into `main`; other branches are not protected. No pull request has been merged through the ruleset yet. The other workspaces' tests run only locally, and there is no secret scan or dependency audit yet.

B-1 — six memory end-to-end tests that failed on every run — was fixed on 2026-09-14; it was a test-harness race, not a production memory bug. The eight `@jarvis/db` failures recorded then were test bugs and are fixed (ledger R-4). The production image builds and a fresh database migrates (ledger R-22, R-23). Details: [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) and [docs/CODEBASE_AUDIT.md](./docs/CODEBASE_AUDIT.md).

## License

Proprietary — all rights reserved.
