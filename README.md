# JARVIS - Personal AI Operating System

A modular, agent-based AI platform for digital marketers and team leaders.

## Overview

JARVIS is a personal AI operating system that combines conversational AI, marketing automation, knowledge management, and team operations into a single, secure platform. It is designed to be extremely simple to operate while maintaining production-grade architecture underneath.

## Architecture

- **Frontend**: Next.js 14+ with TypeScript and Tailwind CSS
- **Backend**: Node.js with Express/Fastify and Socket.IO
- **Database**: PostgreSQL with Prisma ORM and pgvector for embeddings
- **AI**: OpenAI API (GPT-4, Embeddings, Whisper)
- **Automation**: n8n integration
- **Monorepo**: Turborepo with pnpm workspaces

See `docs/ARCHITECTURE.md` for full architecture details.

## Project Structure

```
jarvis/
├── apps/
│   ├── web/          # Next.js frontend
│   └── api/          # Backend API server
├── packages/
│   ├── core/         # Shared types, interfaces, utilities
│   ├── db/           # Prisma schema, migrations, seed
│   ├── agents/       # Agent system (registry, base, agents)
│   ├── tools/        # Tool system (registry, base tools)
│   ├── security/     # Auth, permissions, audit, approvals
│   ├── memory/       # Long-term memory, knowledge base, RAG
│   ├── integrations/ # Google, Meta, n8n, WhatsApp
│   └── config/       # Environment validation
├── docs/             # Documentation
└── docker/           # Docker configuration
```

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+
- PostgreSQL 16+
- Docker (optional)

### Installation

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env.local
# Edit .env.local with your values

# Generate Prisma client
pnpm db:generate

# Run migrations
pnpm db:migrate

# Seed database
pnpm db:seed

# Start development servers
pnpm dev
```

### Environment Variables

Copy `.env.example` to `.env.local` and fill in the required values. See `.env.example` for the full list.

**Required:**
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret for JWT tokens (min 32 characters)
- `OPENAI_API_KEY` - OpenAI API key

**Optional (for integrations):**
- Google OAuth credentials
- Meta API credentials
- n8n connection details
- WhatsApp Business API credentials

## Development

```bash
pnpm dev          # Start all services in dev mode
pnpm build        # Build all packages
pnpm lint         # Lint all packages
pnpm typecheck    # Type-check all packages
```

## Security

- No API keys are hardcoded - all secrets stored in environment variables
- Role-based access control (Owner, Admin, Member, Viewer)
- Human approval required for high-impact actions
- Complete audit logging for all actions
- Environment validation at startup

## Adding a New Agent

1. Create a new file in `packages/agents/src/agents/`
2. Extend `BaseAgent` from `packages/agents/src/base-agent.ts`
3. Implement the `process` method
4. Register the agent in `packages/agents/src/index.ts`
5. Add required tools if needed

No changes to the core system are required.

## Adding a New Tool

1. Create a new file in `packages/tools/src/tools/`
2. Extend `BaseTool` from `packages/tools/src/base-tool.ts`
3. Implement the `execute` method
4. Register the tool in the tool registry

## License

Private - All rights reserved.
