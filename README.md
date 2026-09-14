# JARVIS — Personal AI Operating System

A conversational assistant for marketing and business work. You talk to it in plain language, in English, Hindi or Hinglish; it reads your ad accounts, mail, calendar and documents, remembers what matters about your work, and proposes changes that run only after you approve them.

## What it is built from

| Layer | Technology |
|---|---|
| Web app | Next.js 14 (App Router), React, Zustand, Tailwind |
| API | Node.js, Express, Socket.IO |
| Database | PostgreSQL with pgvector, through Prisma |
| Models and voice | OpenAI (chat, embeddings, vision, speech-to-text, text-to-speech); ElevenLabs text-to-speech |
| Integrations | Meta Ads, Google Ads, Gmail / Drive / Calendar, Google Maps, WhatsApp Business, n8n, browser automation |
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

Typecheck, lint and build pass across all 18 workspaces. B-1 — six memory end-to-end tests that failed on every run — is fixed. It was a test-harness race, not a production memory bug. The six tests pass, and the API suite passes 1,159 tests with 8 skipped. The full repository suite and the Postgres-backed tests have not been run since the fix. A CI workflow is defined (`.github/workflows/ci.yml`) but has not run on GitHub yet. Details: [docs/CODEBASE_AUDIT.md](./docs/CODEBASE_AUDIT.md).

## License

Private — all rights reserved.
