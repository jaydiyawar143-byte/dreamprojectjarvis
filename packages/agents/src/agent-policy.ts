// ---------------------------------------------------------------------------
// Sprint 6.1 — Server-authoritative agent policies.
//
// This module is the ONLY place that decides which tools an agent may execute.
// It is static data compiled into the server: no model output, no request body
// and no database row can add an agent or widen an allowlist. The Orchestrator
// reads a policy from the registry — never from the agent instance — so an
// agent that misreports its own `tools` array changes nothing.
//
// Allowlists hold REGISTRY tool ids (`meta.insights`). The names handed to a
// model are sanitized (`meta-insights`, because OpenAI function names cannot
// contain dots), so every membership test resolves the sanitized spelling back
// to the registry id first. Skipping that step would let an agent reach a tool
// it does not own simply by returning the other spelling.
// ---------------------------------------------------------------------------

import type { AgentPolicy, ITool, ToolRegistry } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Agent ids — the closed set. An id absent from here cannot be resolved.
// ---------------------------------------------------------------------------

export const AGENT_IDS = {
  general: "conversational-assistant",
  metaAds: "meta-ads-agent",
  googleAds: "google-ads-agent",
  knowledge: "knowledge-agent",
  analytics: "analytics-agent",
  automation: "automation-agent",
  communication: "communication-agent",
} as const;

// ---------------------------------------------------------------------------
// Tool groups — named so a policy reads as a capability, not a string list.
// ---------------------------------------------------------------------------

/** Meta reads. Safe for any agent that only needs to observe ad state. */
export const META_READ_TOOLS = [
  "meta.accounts",
  "meta.campaigns",
  "meta.adsets",
  "meta.ads",
  "meta.insights",
] as const;

/**
 * Meta writes. Every one is EXTERNAL_SIDE_EFFECT or higher and therefore
 * approval-gated by `ToolApprovalService`; the allowlist decides WHO may
 * propose them, the approval boundary decides whether they run.
 */
export const META_WRITE_TOOLS = [
  "meta.campaign.pause",
  "meta.campaign.resume",
  "meta.adset.pause",
  "meta.adset.resume",
  "meta.ad.pause",
  "meta.ad.resume",
  "meta.campaign.budget.update",
  "meta.adset.budget.update",
  "meta.campaign.create",
] as const;

/** Google Ads is read-only as of Sprint 5.2 — there is no write tool to grant. */
export const GOOGLE_READ_TOOLS = [
  "google.accounts",
  "google.campaigns",
  "google.insights",
] as const;

/** Local analysis helpers: no network, no side effect. */
export const ANALYSIS_TOOLS = ["data.csv.analyze"] as const;

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

function policy(p: AgentPolicy): AgentPolicy {
  return Object.freeze({
    ...p,
    allowedTools: Object.freeze([...p.allowedTools]),
    requiredPermissions: Object.freeze([...p.requiredPermissions]),
  });
}

/**
 * The general assistant keeps the broad tool surface it has held since Sprint 1.
 *
 * Narrowing it is not the lever that buys safety here: it is the fallback for
 * every unrouted message, so anything removed simply becomes unreachable rather
 * than becoming safer, and every write in the list is approval-gated anyway.
 * The least-privilege gain in Sprint 6 comes from the SPECIALIZED agents being
 * narrow — a Meta request now runs on an agent that cannot touch WhatsApp or
 * n8n at all, which was not true before.
 */
const GENERAL_POLICY = policy({
  agentId: AGENT_IDS.general,
  domain: "general",
  allowedTools: [
    ...META_READ_TOOLS,
    ...META_WRITE_TOOLS,
    ...GOOGLE_READ_TOOLS,
    ...ANALYSIS_TOOLS,
  ],
  requiredPermissions: ["read"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "General conversational assistant and routing fallback",
});

const META_ADS_POLICY = policy({
  agentId: AGENT_IDS.metaAds,
  domain: "meta-ads",
  allowedTools: [...META_READ_TOOLS, ...META_WRITE_TOOLS],
  requiredPermissions: ["read"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Meta Ads domain expert: read, analyze, recommend, propose approval-gated writes",
});

const GOOGLE_ADS_POLICY = policy({
  agentId: AGENT_IDS.googleAds,
  domain: "google-ads",
  allowedTools: [...GOOGLE_READ_TOOLS],
  requiredPermissions: ["read"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Google Ads domain agent over the Sprint 5.2 read-only provider",
});

/**
 * The knowledge agent holds NO tools on purpose.
 *
 * Retrieval already happened before the agent ran: the Orchestrator embeds the
 * query and injects the matching passages as context. Giving this agent a
 * retrieval tool would mean a second, model-chosen search over the same index
 * — a duplicate RAG path with no gate on what it asks for.
 */
const KNOWLEDGE_POLICY = policy({
  agentId: AGENT_IDS.knowledge,
  domain: "knowledge",
  allowedTools: [],
  requiredPermissions: ["read"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Answers from the user's own indexed documents, with source attribution",
});

/**
 * Analytics reads across ad platforms but owns no writes at all — an insight
 * that needs an action hands off to the domain agent that owns the write.
 */
const ANALYTICS_POLICY = policy({
  agentId: AGENT_IDS.analytics,
  domain: "analytics",
  allowedTools: [...META_READ_TOOLS, ...GOOGLE_READ_TOOLS, ...ANALYSIS_TOOLS],
  requiredPermissions: ["read"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Cross-platform KPI analysis, period comparison and anomaly explanation (read-only)",
});

/**
 * `requiredPermissions` mirrors what `n8n.trigger` itself demands
 * (`read` + `write`), rather than exceeding it.
 *
 * An agent floor stricter than its own tools would not add safety — the tool
 * check still runs either way — it would just make the agent unreachable for
 * roles that are perfectly entitled to the underlying capability, and push
 * those users onto the general assistant instead.
 */
const AUTOMATION_POLICY = policy({
  agentId: AGENT_IDS.automation,
  domain: "automation",
  allowedTools: ["n8n.trigger"],
  requiredPermissions: ["read", "write"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Triggers pre-registered n8n workflows behind the approval boundary",
});

const COMMUNICATION_POLICY = policy({
  agentId: AGENT_IDS.communication,
  domain: "communication",
  allowedTools: ["whatsapp.send"],
  requiredPermissions: ["read", "write"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Handles inbound WhatsApp context and proposes approval-gated outbound replies",
});

/** The complete, immutable policy set. */
export const AGENT_POLICIES: Readonly<Record<string, AgentPolicy>> = Object.freeze({
  [AGENT_IDS.general]: GENERAL_POLICY,
  [AGENT_IDS.metaAds]: META_ADS_POLICY,
  [AGENT_IDS.googleAds]: GOOGLE_ADS_POLICY,
  [AGENT_IDS.knowledge]: KNOWLEDGE_POLICY,
  [AGENT_IDS.analytics]: ANALYTICS_POLICY,
  [AGENT_IDS.automation]: AUTOMATION_POLICY,
  [AGENT_IDS.communication]: COMMUNICATION_POLICY,
});

export function getAgentPolicy(agentId: string): AgentPolicy | undefined {
  return Object.prototype.hasOwnProperty.call(AGENT_POLICIES, agentId)
    ? AGENT_POLICIES[agentId]
    : undefined;
}

// ---------------------------------------------------------------------------
// Tool-name resolution
// ---------------------------------------------------------------------------

/**
 * Mirrors the sanitisation the API applies before handing tools to a model.
 * Kept here as well so allowlist checks never depend on the caller having
 * threaded a reverse map through.
 */
export function sanitizeToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Whether `requestedToolId` — in either spelling — names a tool on `allowed`.
 *
 * Both directions are checked: the registry id as-is, and the sanitized form of
 * each allowed id compared against the request. A tool id that sanitizes into
 * another allowed id cannot be exploited, because the comparison is against the
 * allowlist rather than against the whole registry.
 */
export function isToolAllowed(
  requestedToolId: string,
  allowed: readonly string[]
): boolean {
  if (allowed.includes(requestedToolId)) return true;
  return allowed.some((id) => sanitizeToolName(id) === requestedToolId);
}

/** Resolves either spelling to the registry id, or null when not allowed. */
export function resolveAllowedToolId(
  requestedToolId: string,
  allowed: readonly string[]
): string | null {
  if (allowed.includes(requestedToolId)) return requestedToolId;
  return allowed.find((id) => sanitizeToolName(id) === requestedToolId) ?? null;
}

// ---------------------------------------------------------------------------
// Scoped registry — Sprint 6.9, least privilege for the agent's own lookups
// ---------------------------------------------------------------------------

/**
 * A `ToolRegistry` view restricted to one policy's allowlist.
 *
 * The Meta Ads agent calls `toolRegistry.get("meta.accounts")` directly during
 * `process()` to build its server-authoritative account context, so handing
 * agents the full registry would hand every agent every provider. This wrapper
 * is what an agent receives in its `AgentContext`: `get` returns undefined for
 * anything off-policy and `getAll` lists only what the agent owns, so an agent
 * cannot even enumerate the tools it is not allowed to use.
 */
export function scopedToolRegistry(
  registry: ToolRegistry,
  allowed: readonly string[]
): ToolRegistry {
  return {
    get(toolId: string): ITool | undefined {
      const resolved = resolveAllowedToolId(toolId, allowed);
      if (resolved === null) return undefined;
      return registry.get(resolved);
    },
    getAll(): ITool[] {
      return registry.getAll().filter((t) => isToolAllowed(t.id, allowed));
    },
  };
}
