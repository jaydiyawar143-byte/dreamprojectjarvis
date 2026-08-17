# JARVIS Architecture Document

## 1. System Overview

JARVIS is a personal AI operating system built as a modular, agent-based platform. It serves as a centralized hub for AI-powered assistants, marketing automation, knowledge management, and team operations for a Senior Digital Marketer and Team Leader.

### Design Principles

- **Modularity**: Every agent, tool, and integration is a self-contained module that can be added or removed without affecting the core system.
- **API-First**: All functionality is exposed through well-defined APIs. The frontend is a consumer of these APIs.
- **Security by Design**: Secrets are never hardcoded. High-impact actions require human approval. All actions are audit-logged.
- **Non-Technical Friendly**: The UI abstracts all complexity. One-click operations for common tasks.
- **Production-Grade**: Proper error handling, logging, monitoring, and graceful degradation from day one.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        JARVIS Platform                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────────────────────────────┐  │
│  │   Frontend   │    │           Backend API                 │  │
│  │   Next.js    │◄──►│     Express/Fastify + Socket.IO       │  │
│  │   (App Dir)  │    │         (Node.js/TS)                  │  │
│  └──────────────┘    └──────────┬───────────────────────────┘  │
│                                 │                               │
│                    ┌────────────▼────────────┐                  │
│                    │      Core Services      │                  │
│                    │  ┌──────┐ ┌──────────┐  │                  │
│                    │  │ Auth │ │Approval  │  │                  │
│                    │  └──────┘ │Queue     │  │                  │
│                    │  ┌──────┐ └──────────┘  │                  │
│                    │  │Audit │ ┌──────────┐  │                  │
│                    │  │Logger│ │Memory    │  │                  │
│                    │  └──────┘ │Manager   │  │                  │
│                    │           └──────────┘  │                  │
│                    └────────────┬────────────┘                  │
│                                 │                               │
│              ┌──────────────────┼──────────────────┐           │
│              │                  │                   │           │
│  ┌───────────▼──┐  ┌───────────▼──┐  ┌────────────▼────────┐  │
│  │ Agent System │  │  Tool System │  │   Integration Layer  │  │
│  │              │  │              │  │                      │  │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────┐ ┌────────┐ │  │
│  │ │ Registry │ │  │ │ Registry │ │  │ │Google│ │Meta    │ │  │
│  │ └──────────┘ │  │ └──────────┘ │  │ └──────┘ └────────┘ │  │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────┐ ┌────────┐ │  │
│  │ │ Agents   │ │  │ │ Tools    │ │  │ │n8n   │ │WhatsApp│ │  │
│  │ └──────────┘ │  │ └──────────┘ │  │ └──────┘ └────────┘ │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                      Data Layer                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  PostgreSQL   │  │    Redis     │  │   Vector Store       │  │
│  │  (Primary DB) │  │   (Cache)    │  │  (pgvector/RAG)      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Monorepo Structure (Turborepo)

JARVIS uses a **Turborepo-based monorepo** for shared types, coordinated builds, and unified dependency management.

### Packages

| Package | Purpose |
|---------|---------|
| `@jarvis/web` | Next.js 14+ frontend application (App Router) |
| `@jarvis/api` | Backend API server (Express + Socket.IO) |
| `@jarvis/core` | Shared types, interfaces, constants, utilities |
| `@jarvis/agents` | Agent system: registry, base classes, all 25+ agents |
| `@jarvis/tools` | Tool system: registry, base classes, all tools |
| `@jarvis/db` | Database schema (Prisma), migrations, seed data |
| `@jarvis/memory` | Long-term memory, knowledge base, RAG pipeline |
| `@jarvis/integrations` | Third-party API wrappers (Google, Meta, n8n, etc.) |
| `@jarvis/security` | Authentication, RBAC, approval system, audit logging |
| `@jarvis/config` | Shared configuration, environment validation |

---

## 4. Agent System Architecture

### 4.1 Agent Interface

Every agent implements the `IAgent` interface:

```typescript
interface IAgent {
  id: string;
  name: string;
  description: string;
  category: AgentCategory;
  tools: string[];           // Tool IDs this agent can use
  permissions: Permission[];  // Required permissions
  config: AgentConfig;

  initialize(context: AgentContext): Promise<void>;
  process(input: AgentInput): Promise<AgentOutput>;
  getStatus(): AgentStatus;
}
```

### 4.2 Agent Categories

| Category | Agents |
|----------|--------|
| **Communication** | WhatsApp Agent, CRM Agent, Team Leader Agent |
| **Marketing** | Marketing Agent, SEO Agent, Social Media Agent, Crypto Marketing Agent |
| **Advertising** | Meta Ads Agent |
| **Research** | Research Agent, Browser Automation Agent |
| **Content** | PDF/Report Agent |
| **Productivity** | Executive Assistant, Voice Interface |
| **Technical** | Developer Agent |
| **Knowledge** | Long-Term Memory, Knowledge Base/RAG |
| **AI Core** | Conversational Assistant |

### 4.3 Agent Registry

Agents are registered dynamically. Adding a new agent requires:

1. Create agent file in `packages/agents/src/agents/`
2. Implement `IAgent` interface
3. Register with `AgentRegistry`
4. Add tools if needed
5. No core system changes required

### 4.4 Agent Lifecycle

```
Register → Initialize → Ready → Process → Respond → [Approve] → Execute
                                    ↑                              │
                                    └──────────────────────────────┘
```

---

## 5. Tool System Architecture

### 5.1 Tool Interface

Every tool implements the `ITool` interface:

```typescript
interface ITool {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  parameters: ToolParameter[];
  requiresApproval: boolean;
  requiredPermissions: Permission[];

  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  validate(params: Record<string, unknown>): boolean;
}
```

### 5.2 Tool Categories

| Category | Examples |
|----------|----------|
| **Database** | ReadRecord, WriteRecord, SearchRecords |
| **Communication** | SendEmail, SendWhatsApp, SendNotification |
| **Marketing** | PostToSocial, AnalyzeCampaign, GenerateContent |
| **Research** | WebSearch, ScrapeUrl, AnalyzeData |
| **File** | CreatePDF, ReadDocument, ExportReport |
| **Integration** | GoogleSheets, MetaAPI, N8nWebhook |
| **System** | RunAutomation, ScheduleTask, ManageApproval |

### 5.3 Tool Permissions

Every tool has a permission level:

- **Read**: Safe, no approval needed
- **Write**: May require approval depending on config
- **Execute**: External actions, always require approval
- **Admin**: System-level changes, always require approval

---

## 6. Approval System

### 6.1 How It Works

High-impact actions are routed through an approval queue:

1. Agent requests action via a tool
2. System checks if tool `requiresApproval` is true
3. If yes, action enters the **Pending Approval Queue**
4. Owner receives notification (in-app, optional WhatsApp/email)
5. Owner approves or rejects via the UI
6. If approved, tool executes; if rejected, agent is notified

### 6.2 Approval Rules

```typescript
interface ApprovalRule {
  toolCategory: ToolCategory;
  action: string;
  requiresApproval: boolean;
  timeoutMs: number;          // Auto-reject after timeout
  escalationContact?: string; // Who to notify if timeout
}
```

### 6.3 Default Rules

| Action Type | Approval Required |
|-------------|-------------------|
| Read operations | No |
| Local data writes | No |
| External API calls | Yes |
| Financial transactions | Yes |
| Data deletion | Yes |
| System configuration changes | Yes |

---

## 7. Security Architecture

### 7.1 Authentication

- **NextAuth.js** with session-based authentication
- Support for email/password and OAuth providers
- JWT tokens for API communication between frontend and backend
- Session refresh and token rotation

### 7.2 Authorization (RBAC)

```typescript
enum Role {
  OWNER = 'owner',           // Full access to everything
  ADMIN = 'admin',           // Can manage agents, view logs
  MEMBER = 'member',         // Can use approved agents
  VIEWER = 'viewer',         // Read-only access
}

interface Permission {
  resource: string;
  action: 'read' | 'write' | 'execute' | 'admin';
}
```

### 7.3 Environment Security

- All secrets stored in `.env` files (never committed)
- `.env.example` committed as a template
- Environment validation at startup via `@jarvis/config`
- Secrets loaded at runtime, never exposed to frontend

### 7.4 Audit Logging

Every significant action creates an audit record:

```typescript
interface AuditLog {
  id: string;
  timestamp: Date;
  userId: string;
  agentId?: string;
  toolId?: string;
  action: string;
  parameters: Record<string, unknown>;
  result: 'success' | 'failure' | 'rejected' | 'pending';
  ipAddress: string;
  metadata: Record<string, unknown>;
}
```

---

## 8. Memory & Knowledge System

### 8.1 Long-Term Memory

- Conversation history stored in PostgreSQL
- Semantic search via pgvector embeddings
- Automatic summarization of old conversations
- Entity extraction and relationship mapping

### 8.2 Knowledge Base (RAG)

- Documents ingested and chunked
- Embeddings stored in PostgreSQL (pgvector)
- Retrieval-Augmented Generation for contextual answers
- Support for PDFs, web pages, notes, and API data

### 8.3 Memory Architecture

```
User Input → Embedding (OpenAI) → Vector Store (pgvector)
                                          │
Context Retrieval ────────────────────────►├──► LLM Prompt ──► Response
                                          │
Knowledge Chunks ─────────────────────────┘
```

---

## 9. Integration Layer

### 9.1 n8n Integration

- n8n runs as a separate service
- JARVIS communicates via REST webhooks
- n8n handles complex workflow automations
- JARVIS triggers workflows and receives results

### 9.2 Google Integration

- Google OAuth for account access
- Google Sheets for data management
- Google Calendar for scheduling
- Google Drive for document storage

### 9.3 Meta Integration

- Meta Business API for ad management
- Page and Instagram management
- Audience and campaign data

### 9.4 WhatsApp Integration

- WhatsApp Business API
- Two-way messaging
- Template management

---

## 10. Frontend Architecture

### 10.1 Next.js App Router

```
app/
├── (auth)/                # Authentication pages
├── (dashboard)/           # Main application
│   ├── chat/              # AI conversation interface
│   ├── agents/            # Agent management
│   ├── knowledge/         # Knowledge base
│   ├── approvals/         # Approval queue
│   ├── integrations/      # Integration settings
│   ├── team/              # Team management
│   ├── reports/           # Analytics & reports
│   └── settings/          # System settings
├── api/                   # Next.js API routes (thin layer)
└── layout.tsx
```

### 10.2 UI Principles

- Clean, modern dashboard design
- One-click operations for common tasks
- Real-time updates via WebSocket
- Mobile-responsive
- Dark/light mode support

---

## 11. Database Schema (High-Level)

### Core Tables

| Table | Purpose |
|-------|---------|
| `users` | User accounts and profiles |
| `sessions` | Active user sessions |
| `agents` | Registered agents and their configurations |
| `conversations` | Chat conversation headers |
| `messages` | Individual messages in conversations |
| `memory_entries` | Long-term memory with embeddings |
| `knowledge_documents` | Uploaded documents for RAG |
| `knowledge_chunks` | Chunked document embeddings |
| `approvals` | Pending approval queue |
| `audit_logs` | Complete action audit trail |
| `integrations` | Connected third-party accounts |
| `team_members` | Team member roles and permissions |
| `tasks` | Scheduled and background tasks |
| `settings` | System and user settings |

---

## 12. API Design

### API Structure

```
/api/v1/
├── /auth           # Authentication endpoints
├── /users          # User management
├── /agents         # Agent CRUD and execution
├── /conversations  # Chat management
├── /messages       # Message operations
├── /memory         # Long-term memory
├── /knowledge      # Knowledge base operations
├── /approvals      # Approval queue management
├── /tools          # Tool registry
├── /integrations   # Integration management
├── /audit          # Audit log queries
├── /team           # Team management
├── /settings       # System settings
└── /health         # Health check
```

### API Conventions

- RESTful endpoints with JSON payloads
- Consistent error response format
- Pagination for list endpoints
- Rate limiting per user/role
- Request validation via Zod schemas

---

## 13. Development, Staging & Production

| Environment | Purpose | Database | API Keys |
|-------------|---------|----------|----------|
| **Development** | Local development | Local PostgreSQL | Test/sandbox keys |
| **Staging** | Pre-production testing | Staging PostgreSQL | Staging keys |
| **Production** | Live system | Production PostgreSQL | Production keys |

Each environment has its own `.env.{environment}` file.

---

## 14. Technology Stack Summary

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14+, TypeScript, Tailwind CSS, shadcn/ui |
| Backend | Node.js, Express/Fastify, TypeScript, Socket.IO |
| Database | PostgreSQL 16+, Prisma ORM, pgvector |
| Cache | Redis (optional, for session/queue caching) |
| AI/LLM | OpenAI API (GPT-4, Embeddings, Whisper) |
| Auth | NextAuth.js |
| Monorepo | Turborepo |
| Package Manager | pnpm |
| Automation | n8n (external service) |
| Monitoring | Winston (logging), OpenTelemetry (tracing) |
| Deployment | Docker, Docker Compose (dev), Vercel (frontend), Railway/Fly.io (backend) |

---

## 15. Deferred Decisions (To Be Made Later)

The following architectural decisions are intentionally deferred:

1. **n8n deployment model** - Self-hosted vs cloud
2. **Vector search strategy** - pgvector vs dedicated vector DB (Pinecone/Weaviate)
3. **WebSocket vs SSE** - For real-time updates
4. **Rate limiting strategy** - Per-user, per-agent, or per-tool
5. **Caching strategy** - Redis vs in-memory vs PostgreSQL
6. **Deployment infrastructure** - Vercel, Railway, Fly.io, or self-hosted
7. **Monitoring stack** - Sentry, Datadog, or self-hosted
8. **WhatsApp provider** - Official API vs third-party wrapper
9. **Voice interface implementation** - Web Speech API vs dedicated service
10. **Agent orchestration** - Sequential vs parallel execution for multi-agent tasks
