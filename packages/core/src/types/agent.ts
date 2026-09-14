import { z } from "zod";
import type { ITool, ToolPermission } from "./tool.js";
import type { AuditEntry } from "./common.js";
import type { IMemoryStore } from "./memory.js";
import { ConversationMessageSchema } from "./conversation.js";

export const AgentCategorySchema = z.enum([
  "communication",
  "marketing",
  "advertising",
  "research",
  "content",
  "productivity",
  "technical",
  "knowledge",
  "ai-core",
]);

export type AgentCategory = z.infer<typeof AgentCategorySchema>;

export const AgentStatusSchema = z.enum([
  "idle",
  "initializing",
  "ready",
  "processing",
  "error",
  "disabled",
]);

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentConfigSchema = z.object({
  model: z.string().default("gpt-4"),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().positive().default(4096),
  systemPrompt: z.string().optional(),
  customSettings: z.record(z.unknown()).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AgentInputSchema = z.object({
  message: z.string(),
  conversationId: z.string().optional(),
  conversationHistory: z.array(ConversationMessageSchema).optional().default([]),
  metadata: z.record(z.unknown()).optional(),
});

export type AgentInput = z.infer<typeof AgentInputSchema>;

export const AgentOutputSchema = z.object({
  message: z.string(),
  actions: z
    .array(
      z.object({
        toolId: z.string(),
        toolCallId: z.string().optional(),
        params: z.record(z.unknown()),
      })
    )
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;

export interface ToolRegistry {
  get(toolId: string): ITool | undefined;
  getAll(): ITool[];
}

export interface AuditLogger {
  log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void>;
}

export interface AgentContext {
  userId: string;
  conversationId?: string;
  traceId: string;
  memoryManager: IMemoryStore;
  toolRegistry: ToolRegistry;
  auditLogger: AuditLogger;
}

export interface IAgent {
  id: string;
  name: string;
  description: string;
  category: AgentCategory;
  tools: string[];
  config: AgentConfig;

  initialize(context: AgentContext): Promise<void>;
  process(input: AgentInput): Promise<AgentOutput>;
  getStatus(): AgentStatus;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sprint 6 — Specialized agents: domain, policy and resolution contracts.
//
// The types below exist so that "which agent may do what" is a SERVER-OWNED
// declaration rather than something a model or a client can talk its way into.
// An agent's identity, its tool allowlist and its permission floor are data,
// checked by the Orchestrator on every step; an agent object that lies about
// its own allowlist changes nothing, because the Orchestrator reads the policy,
// not the instance.
// ---------------------------------------------------------------------------

/**
 * The problem space an agent owns.
 *
 * Distinct from `AgentCategory`, which describes the KIND of work an agent
 * does and predates Sprint 6. A domain is what the router matches on, so the
 * two are kept apart rather than overloaded: several marketing-category agents
 * (Meta, Google, analytics) occupy different domains.
 */
export const AgentDomainSchema = z.enum([
  "general",
  "meta-ads",
  "google-ads",
  "knowledge",
  "analytics",
  "automation",
  "communication",
  // Sprint 7 — controlled web browsing.
  "browser",
  // Maps, places and routing. Separate from `general` because it is the only
  // domain whose tools read the user's physical position.
  "location",
]);

export type AgentDomain = z.infer<typeof AgentDomainSchema>;

/**
 * Server-authoritative capability declaration for one agent.
 *
 * `allowedTools` holds REGISTRY tool ids (`meta.insights`), never the sanitized
 * names handed to a model (`meta-insights`); the Orchestrator resolves a call
 * back to its registry id before checking membership, so an agent cannot slip
 * past the allowlist by returning the sanitized spelling of a tool it does not
 * own.
 *
 * An empty `allowedTools` is a real, useful configuration: the knowledge agent
 * answers purely from retrieved context and is meant to hold no tools at all.
 */
export interface AgentPolicy {
  agentId: string;
  domain: AgentDomain;
  /** Registry tool ids this agent may execute. Empty means none. */
  allowedTools: readonly string[];
  /**
   * Permissions the CALLER's role must hold before this agent may be used.
   * Checked against the same `PermissionService` the tool layer uses, so an
   * agent can never widen what a role is allowed to reach.
   */
  requiredPermissions: readonly ToolPermission[];
  /**
   * Defense in depth. When true the Orchestrator refuses to execute any tool
   * this agent selected that carries a non-READ_ONLY risk without an approval,
   * even if some future tool were registered with `requiresApproval: false`.
   */
  writesRequireApproval: boolean;
  /** Whether a client may name this agent explicitly on a request. */
  clientSelectable: boolean;
  /** Human-readable purpose, surfaced in audit metadata and errors. */
  description: string;
}

/** Outcome of server-side agent resolution. */
export type AgentResolutionStatus =
  | "resolved"
  | "ambiguous"
  | "unknown"
  | "unsupported"
  | "unauthorized";

export interface AgentResolution {
  status: AgentResolutionStatus;
  agentId?: string;
  domain?: AgentDomain;
  /** 0-1. Only meaningful when `status` is "resolved" or "ambiguous". */
  confidence: number;
  /** Why the router landed here; recorded in the audit trail. */
  reason: string;
  /** Candidate agents when `status` is "ambiguous". */
  candidates?: string[];
}
