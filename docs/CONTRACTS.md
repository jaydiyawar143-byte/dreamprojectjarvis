# JARVIS Core Runtime Contracts

## 1. Overview

This document defines the core runtime contracts for the JARVIS platform. All contracts live in `@jarvis/core` and are validated at runtime using Zod schemas. The system is provider-agnostic — no contract depends on a specific AI provider.

### Design Principles

- **Zod-first**: Every contract has a Zod schema for runtime validation
- **Provider-agnostic**: Contracts reference capabilities, not implementations
- **Layered**: Base contracts for all consumers, extended contracts for API/server
- **Auditable**: Every action produces an audit trail
- **Approval-gated**: High-impact actions require human approval

---

## 2. Contract Registry

| Contract | File | Purpose |
|----------|------|---------|
| `AuthContext` | `context.ts` | Authenticated user identity |
| `SessionContext` | `context.ts` | Full request context with trace |
| `TraceContext` | `context.ts` | Request correlation/trace ID |
| `JarvisRequest` | `request.ts` | Inbound chat/action request |
| `JarvisResponse` | `request.ts` | Outbound response envelope |
| `ConversationMessage` | `conversation.ts` | Single message in a conversation |
| `Conversation` | `conversation.ts` | Conversation with message history |
| `AgentExecution` | `execution.ts` | Agent execution state tracking |
| `ToolInvocation` | `execution.ts` | Tool call within an execution |
| `Permission` | `common.ts` | RBAC permission (resource + action) |
| `Approval` | `common.ts` | Approval request for high-impact actions |
| `AuditEntry` | `common.ts` | Audit log record |
| `ErrorCode` | `errors.ts` | Standardized error codes |
| `JarvisError` | `errors.ts` | Application error class |
| `StreamChunk` | `streaming.ts` | SSE stream event chunk |

---

## 3. Runtime Flow

```
┌──────────┐     JarvisRequest      ┌──────────┐
│  Client  │ ──────────────────────► │   API    │
│ (Web/App)│                         │ (Express)│
└──────────┘                         └────┬─────┘
                                          │
                              ┌───────────▼───────────┐
                              │   1. JWT Validate      │
                              │   → AuthContext         │
                              └───────────┬───────────┘
                                          │
                              ┌───────────▼───────────┐
                              │   2. Build Session     │
                              │   SessionContext        │
                              │   (auth + trace)       │
                              └───────────┬───────────┘
                                          │
                              ┌───────────▼───────────┐
                              │   3. Route to Agent    │
                              │   AgentRegistry.get()  │
                              └───────────┬───────────┘
                                          │
                              ┌───────────▼───────────┐
                              │   4. Agent.process()   │
                              │   AgentInput → Output  │
                              └───────────┬───────────┘
                                          │
                              ┌───────────▼───────────┐
                              │   5. Tool Calls?       │
                              │   ToolInvocation[]     │
                              └─────┬─────────┬───────┘
                                    │         │
                          ┌─────────▼──┐  ┌───▼─────────┐
                          │ No Approval│  │ Approval    │
                          │ Execute    │  │ Required    │
                          └─────────┬──┘  └───┬─────────┘
                                    │         │
                                    │  ┌──────▼──────────┐
                                    │  │ 6. Approval     │
                                    │  │ Queue → Resolve │
                                    │  └──────┬──────────┘
                                    │         │
                              ┌─────▼─────────▼───┐
                              │   7. Response      │
                              │   JarvisResponse   │
                              └─────────┬─────────┘
                                        │
                              ┌─────────▼─────────┐
                              │   8. Audit Log     │
                              │   AuditEntry       │
                              └───────────────────┘
```

---

## 4. Contract Details

### 4.1 AuthContext

Set after JWT validation. Represents the authenticated user.

```typescript
{
  userId: string;      // User ID from JWT
  role: Role;          // "owner" | "admin" | "member" | "viewer"
  email: string;       // User email
}
```

### 4.2 SessionContext

Full request context. Created once per request and passed through the system.

```typescript
{
  auth: AuthContext;        // Who is making the request
  conversationId?: string;  // Current conversation (if any)
  agentId?: string;         // Target agent (if any)
  traceId: string;          // UUID for request tracing
  ipAddress?: string;       // Client IP (for audit)
}
```

### 4.3 JarvisRequest

Inbound request schema. Validated with Zod before processing.

```typescript
{
  message: string;                    // User message (required, non-empty)
  conversationId?: string;            // Continue existing conversation
  agentId?: string;                   // Target specific agent
  metadata?: Record<string, unknown>; // Arbitrary metadata
  stream?: boolean;                   // Request SSE streaming (default: false)
}
```

### 4.4 JarvisResponse

Outbound response envelope. Always includes `traceId` and `timestamp`.

```typescript
{
  success: boolean;
  data?: {
    message: string;                  // Agent response
    conversationId: string;           // Conversation ID
    agentId?: string;                 // Responding agent
    metadata?: Record<string, unknown>;
  };
  error?: {
    code: ErrorCode;                  // Standardized error code
    message: string;                  // Human-readable error
    details?: Record<string, unknown>;
  };
  traceId: string;                    // Request trace ID
  timestamp: string;                  // ISO 8601
}
```

### 4.5 ConversationMessage

A single message within a conversation.

```typescript
{
  id: string;                         // Message ID
  role: "user" | "assistant" | "system" | "tool";
  content: string;                    // Message content
  metadata?: Record<string, unknown>;
  createdAt: string;                  // ISO 8601
}
```

### 4.6 AgentExecution

Tracks the state of an agent processing a request.

```typescript
{
  id: string;                         // Execution ID (UUID)
  agentId: string;                    // Agent performing the work
  userId: string;                     // Requesting user
  conversationId: string;             // Conversation context
  traceId: string;                    // Request trace ID
  status: "pending" | "running" | "completed" | "failed" | "awaiting_approval";
  input: string;                      // Original user input
  output?: string;                    // Agent response (when complete)
  toolCalls?: ToolInvocation[];       // Tools invoked during execution
  error?: string;                     // Error message (when failed)
  startedAt: string;                  // ISO 8601
  completedAt?: string;               // ISO 8601 (when complete)
}
```

### 4.7 ToolInvocation

Represents a tool call within an agent execution.

```typescript
{
  toolId: string;                     // Tool to invoke
  params: Record<string, unknown>;    // Tool parameters
  requiresApproval: boolean;          // Whether this needs human approval
}
```

### 4.8 Permission

RBAC permission entry. Used by `PermissionService` for authorization checks.

```typescript
{
  resource: string;       // Resource name (e.g., "agents", "conversations", "*" for all)
  action: ToolPermission; // "read" | "write" | "execute" | "admin"
}
```

### 4.9 Approval

High-impact action requiring human approval before execution.

```typescript
{
  id: string;                         // Approval ID
  userId: string;                     // Requesting user
  agentId?: string;                   // Agent requesting the action
  toolId: string;                     // Tool to be executed
  action: string;                     // Human-readable action description
  params: Record<string, unknown>;    // Tool parameters
  status: ApprovalStatus;             // "pending" | "approved" | "rejected" | "expired"
  expiresAt: string;                  // ISO 8601 — auto-reject after this time
  resolvedAt?: string | null;         // ISO 8601 — when approved/rejected
  createdAt: string;                  // ISO 8601
}
```

### 4.10 AuditEntry

Immutable audit log record. Created for every significant action.

```typescript
{
  id: string;
  timestamp: Date;
  userId: string;
  agentId?: string;
  toolId?: string;
  action: string;
  parameters: Record<string, unknown>;
  result: "success" | "failure" | "rejected" | "pending";
  ipAddress: string;
  metadata: Record<string, unknown>;
}
```

### 4.11 ErrorCode

Standardized error codes for consistent error handling across the system.

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `AUTHENTICATION_REQUIRED` | 401 | No valid JWT token |
| `AUTHORIZATION_FAILED` | 403 | Insufficient permissions |
| `INVALID_REQUEST` | 400 | Malformed or invalid request |
| `AGENT_NOT_FOUND` | 404 | Requested agent does not exist |
| `AGENT_ERROR` | 500 | Agent processing failed |
| `TOOL_NOT_FOUND` | 404 | Requested tool does not exist |
| `TOOL_EXECUTION_FAILED` | 500 | Tool execution failed |
| `APPROVAL_REQUIRED` | 428 | Action requires approval |
| `APPROVAL_REJECTED` | 403 | Approval was rejected |
| `CONVERSATION_NOT_FOUND` | 404 | Conversation does not exist |
| `MEMORY_ERROR` | 500 | Memory operation failed |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `INTERNAL_ERROR` | 500 | Unexpected internal error |

### 4.12 StreamChunk

SSE event chunk for streaming agent responses. Used when `JarvisRequest.stream = true`.

```typescript
{
  type: StreamEventType;              // Event type
  data: Record<string, unknown>;      // Event payload
  traceId: string;                    // Request trace ID
  timestamp: string;                  // ISO 8601
}
```

Stream event types:

| Type | When | Data Shape |
|------|------|------------|
| `message.start` | Agent begins response | `{ agentId }` |
| `message.delta` | Partial message token | `{ content: string }` |
| `message.stop` | Agent finishes response | `{}` |
| `tool.call` | Agent invokes a tool | `ToolInvocation` |
| `tool.result` | Tool execution complete | `ToolResult` |
| `error` | Error occurred | `{ code, message }` |
| `done` | Stream complete | `{}` |

---

## 5. Approval Flow

```
Agent decides to call a tool
        │
        ▼
Tool.requiresApproval === true?
        │
   ┌────┴────┐
   No        Yes
   │         │
   ▼         ▼
Execute   Create Approval (status: "pending")
directly      │
              ▼
         Emit "approval:pending" event
              │
              ▼
         Owner notified (WebSocket/push)
              │
              ▼
         Owner approves/rejects
              │
         ┌────┴────┐
      Approved   Rejected
         │         │
         ▼         ▼
      Execute   Emit "approval:resolved"
      tool      Agent notified of rejection
```

---

## 6. Error Handling

All errors flow through `JarvisError` with a standardized `ErrorCode`. The API maps errors to HTTP status codes automatically:

```typescript
throw new JarvisError("AGENT_NOT_FOUND", "Agent 'xyz' not found");
// → HTTP 404, response: { success: false, error: { code: "AGENT_NOT_FOUND", message: "..." } }
```

---

## 7. Tracing

Every request receives a `traceId` (UUID v4). This ID propagates through:

1. `JarvisRequest` → API generates traceId
2. `SessionContext.traceId` → Passed to agent
3. `AgentExecution.traceId` → Tracked in execution
4. `JarvisResponse.traceId` → Returned to client
5. `StreamChunk.traceId` → Included in every stream event
6. `AuditEntry` → Logged with trace correlation

This enables end-to-end request tracing across services.

---

## 8. Package Dependencies

```
@jarvis/core          (no dependencies — foundation)
    ├── @jarvis/agents      (depends on core)
    ├── @jarvis/tools       (depends on core)
    ├── @jarvis/memory      (depends on core)
    ├── @jarvis/security    (depends on core)
    ├── @jarvis/integrations (depends on core)
    └── @jarvis/db          (Prisma — standalone)

@jarvis/config        (no dependencies — env validation)
@jarvis/api           (depends on all packages)
```

All domain types flow from `@jarvis/core`. No package depends on another peer package — only on `core`.
