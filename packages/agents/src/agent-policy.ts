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
import { BROWSER_READ_TOOL_IDS, BROWSER_ACTION_TOOL_IDS } from "@jarvis/core";

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
  browser: "browser-agent",
  location: "location-agent",
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
  // Phase 11.10 — the on-demand analysis tool. READ_ONLY on the surface, but
  // it forwards through the shared AnalysisGenerator which itself executes the
  // reads above (same authorization) and only ever PERSISTS a bounded PROPOSED
  // recommendation. It is granted with the reads, never with the writes.
  "meta.analyze",
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

/**
 * Maps reads. Every one is READ_ONLY — a map query changes nothing anywhere.
 *
 * Granted to the general assistant as well as the location agent, because
 * "how far is Gondia" arrives mid-conversation about something else at least
 * as often as it arrives on its own, and the fallback agent going tool-less
 * for it would just produce a guessed distance.
 */
export const MAPS_TOOLS = [
  "maps.search",
  "maps.nearby",
  "maps.geocode",
  "maps.reverse.geocode",
  "maps.current.location",
  "maps.route",
  "maps.distance",
  "maps.place",
] as const;

/**
 * Capability discovery.
 *
 * Granted to EVERY agent, without exception. "What can you do?" is not a
 * domain question — it arrives on whichever agent the router happened to pick,
 * and an agent without this tool answers it from its own system prompt. That is
 * precisely the failure this group exists to remove: the fallback agent's
 * prompt described one provider, so every capability question returned that
 * provider's feature list regardless of what was registered or connected.
 *
 * All READ_ONLY. Asking what you can do changes nothing, and none of these can
 * execute the capabilities they describe.
 */
export const CAPABILITY_TOOLS = [
  "capabilities.list",
  "capabilities.connected",
  "capabilities.integration",
  "capabilities.permissions",
] as const;

/**
 * Google Workspace READS — Phase 12.
 *
 * Real Gmail, Drive and Calendar access, all READ_ONLY. There is no write tool
 * in this group and no write scope behind it: this phase cannot send mail,
 * delete a file or create an event, and the absence is structural rather than
 * a policy choice made here.
 *
 * Granted to the general assistant (where "meri unread emails dikhao" lands,
 * since it matches no domain signal) and to the Google Ads agent (which is
 * where anything naming Google may route). Not granted to the Meta, WhatsApp,
 * n8n or browser agents: none of them has business reading the user's mail.
 */
export const GOOGLE_WORKSPACE_TOOLS = [
  "gmail.listUnread",
  "gmail.search",
  "gmail.getMessage",
  "gmail.getThread",
  "drive.searchFiles",
  "drive.listRecentFiles",
  "drive.getFileMetadata",
  "calendar.listUpcomingEvents",
  "calendar.getEvent",
] as const;

/**
 * Google write PLANNING — Phase 13.
 *
 * These tools PLAN. None of them can perform a Google write: the port they
 * hold has no execute method, so granting them cannot grant the ability to
 * send an email, move a file or delete an event.
 *
 * Execution is not a tool at all. It happens when a human approves the row a
 * plan created, consumed atomically through the REST approval path — which is
 * why there is no `GOOGLE_WRITE_EXECUTE_TOOLS` group here to grant, and could
 * not be.
 *
 * Granted to the general assistant (where "Priya ko email likho" lands) and to
 * the Google Ads agent (where anything naming Google may route). NOT granted
 * to the Meta, WhatsApp, n8n, browser or knowledge agents: none of them has
 * business drafting the user's mail or touching their calendar.
 */
export const GOOGLE_WRITE_PLAN_TOOLS = [
  "google.plan.gmail.createDraft",
  "google.plan.gmail.updateDraft",
  "google.plan.gmail.sendDraft",
  "google.plan.drive.createFolder",
  "google.plan.drive.uploadFile",
  "google.plan.drive.moveFile",
  "google.plan.drive.renameFile",
  "google.plan.calendar.createEvent",
  "google.plan.calendar.updateEvent",
  "google.plan.calendar.deleteEvent",
] as const;

/**
 * Integration management READS.
 *
 * Every one is READ_ONLY and answers a question about JARVIS's own
 * configuration rather than about a provider's data. Granted broadly — to the
 * general assistant and to every domain agent — because "is Google still
 * connected?" arrives in the middle of a conversation about campaigns at least
 * as often as it arrives on its own, and an agent that cannot check will answer
 * from the conversation instead of from the system.
 *
 * `integration.test` is here despite reaching a provider: every connection test
 * in this system is a read that sends nothing and changes nothing, and putting
 * a diagnostic behind an approval would mean a user debugging a broken
 * connection needs a second person to let them look at it.
 */
export const INTEGRATION_READ_TOOLS = [
  "integration.list",
  "integration.status",
  "integration.health",
  "integration.permissions",
  "integration.audit",
  "integration.test",
  "integration.validate",
] as const;

/**
 * Integration management CHANGES.
 *
 * Granted narrowly — to the general assistant, which is where setup
 * conversations actually happen, and to the domain agents for their own
 * provider. A Meta agent has no business disconnecting Google.
 *
 * `integration.disconnect` is EXTERNAL_SIDE_EFFECT and approval-gated in its
 * own definition: this allowlist decides who may PROPOSE it, the approval
 * boundary decides whether it runs. The others write only to our own encrypted
 * store and reach no provider.
 */
export const INTEGRATION_WRITE_TOOLS = [
  "integration.connect",
  "integration.configure",
  "integration.reconnect",
  "integration.enable",
  "integration.disable",
  "integration.disconnect",
] as const;

/**
 * Ambient reads: the weather, a market price, this machine's telemetry.
 *
 * READ_ONLY, and granted to the general assistant for the same reason the maps
 * tools are: these questions arrive in the middle of other conversations. "aaj
 * Solana ka kya price hai?" is not a session with a market agent, it is one
 * sentence — and an assistant that cannot look the number up is an assistant
 * that answers from memory, which for a live price means answering wrongly.
 */
export const AMBIENT_TOOLS = [
  "weather.current",
  "market.quote",
  "system.status",
  "time.now",
  // Reads the CALLER's own tasks and nothing else — the owner is the
  // authenticated user, not a parameter. READ_ONLY: listing is granted here,
  // and creating or completing a task still goes through the write path and
  // its approval gate, exactly as it did before.
  "tasks.list",
] as const;

/**
 * Core V1 — managing the work JARVIS has been asked to hold on to.
 *
 * Granted to the GENERAL assistant only, deliberately. "Remember this as a
 * task" is a conversation with the assistant, not a Meta Ads request or a
 * browsing session, and a specialist that could quietly create tasks mid-run
 * would be doing something the user never asked for. If a domain agent later
 * needs to record its own follow-up, that is a grant made on purpose, not one
 * inherited by default.
 *
 * The two writes reach JARVIS's own store only — no provider, no spend — so
 * they are LOW_IMPACT and ungated, the same treatment integration writes get.
 */
export const TASK_TOOLS = [
  "task.create",
  "task.list",
  "task.get",
  "task.updateStatus",
] as const;

/**
 * Core V1 — JARVIS describing itself: build, environment, model, and a count
 * of what it can currently do. Read-only, and granted to every agent for the
 * same reason CAPABILITY_TOOLS are: "what are you?" is a question any
 * conversation can reach, and an agent that cannot answer it will invent one.
 */
export const SELF_TOOLS = ["self.describe"] as const;

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
    ...MAPS_TOOLS,
    ...AMBIENT_TOOLS,
    // Setup conversations land here: "Google connect karo" matches no domain
    // signal, so the fallback is the agent that has to be able to do it.
    ...INTEGRATION_READ_TOOLS,
    ...INTEGRATION_WRITE_TOOLS,
    ...CAPABILITY_TOOLS,
    ...SELF_TOOLS,
    // Core V1 — only the general assistant may record work. "Remember this as
    // a task" is a conversation with the assistant, not a domain request.
    ...TASK_TOOLS,
    ...GOOGLE_WORKSPACE_TOOLS,
    ...GOOGLE_WRITE_PLAN_TOOLS,
  ],
  requiredPermissions: ["read"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "General conversational assistant, capability discovery, integration management, and routing fallback",
});

const META_ADS_POLICY = policy({
  agentId: AGENT_IDS.metaAds,
  domain: "meta-ads",
  allowedTools: [...META_READ_TOOLS, ...META_WRITE_TOOLS, ...INTEGRATION_READ_TOOLS, ...CAPABILITY_TOOLS, ...SELF_TOOLS],
  requiredPermissions: ["read"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Meta Ads domain expert: read, analyze, recommend, propose approval-gated writes",
});

const GOOGLE_ADS_POLICY = policy({
  agentId: AGENT_IDS.googleAds,
  domain: "google-ads",
  // "Google Ads reconnect karo" routes HERE, not to the general assistant, so
  // this agent needs the management verbs for its own provider or the request
  // dead-ends on an agent that can see the problem and not fix it.
  allowedTools: [
    ...GOOGLE_READ_TOOLS,
    ...INTEGRATION_READ_TOOLS,
    ...INTEGRATION_WRITE_TOOLS,
    ...CAPABILITY_TOOLS,
    ...SELF_TOOLS,
    ...GOOGLE_WORKSPACE_TOOLS,
    ...GOOGLE_WRITE_PLAN_TOOLS,
  ],
  requiredPermissions: ["read"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Google Ads domain agent over the Sprint 5.2 read-only provider, including its connection lifecycle",
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
  // Capability discovery only. Retrieval already happened before this agent
  // ran, so it still owns no search tool — but a capability question landing
  // here must reach the registry rather than this agent's prompt.
  allowedTools: [...CAPABILITY_TOOLS, ...SELF_TOOLS],
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
  allowedTools: [
    ...META_READ_TOOLS,
    ...GOOGLE_READ_TOOLS,
    ...ANALYSIS_TOOLS,
    ...INTEGRATION_READ_TOOLS,
    ...CAPABILITY_TOOLS,
    ...SELF_TOOLS,
  ],
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
  allowedTools: ["n8n.trigger", ...INTEGRATION_READ_TOOLS, ...CAPABILITY_TOOLS, ...SELF_TOOLS],
  requiredPermissions: ["read", "write"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Triggers pre-registered n8n workflows behind the approval boundary",
});

const COMMUNICATION_POLICY = policy({
  agentId: AGENT_IDS.communication,
  domain: "communication",
  allowedTools: ["whatsapp.send", ...INTEGRATION_READ_TOOLS, ...CAPABILITY_TOOLS, ...SELF_TOOLS],
  requiredPermissions: ["read", "write"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Handles inbound WhatsApp context and proposes approval-gated outbound replies",
});

/**
 * Sprint 7 — controlled browsing.
 *
 * The reads are open and the six actions are approval-gated, which is what the
 * `writesRequireApproval` flag below enforces a second time: even if a browser
 * tool were ever registered with `requiresApproval: false`, the Orchestrator
 * would refuse it for carrying a non-READ_ONLY risk.
 *
 * The permission floor is `["read", "write"]` like the other two agents that
 * can act on the outside world. It is not stricter than the tools it holds —
 * a stricter floor would not add safety, since the per-tool check runs anyway,
 * and would only push entitled users onto the general assistant.
 */
const BROWSER_POLICY = policy({
  agentId: AGENT_IDS.browser,
  domain: "browser",
  allowedTools: [...BROWSER_READ_TOOL_IDS, ...BROWSER_ACTION_TOOL_IDS, ...CAPABILITY_TOOLS, ...SELF_TOOLS],
  requiredPermissions: ["read", "write"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Reads public web pages and proposes approval-gated interactions with them",
});

/**
 * Maps, places and routing.
 *
 * Read-only throughout, so `writesRequireApproval` has nothing to gate here —
 * it stays true because a policy that declares otherwise would silently widen
 * if a write tool were ever added to this domain.
 *
 * The permission floor is `["read"]`, matching the tools. Location is sensitive
 * but it is not a WRITE: reading where the user already told the browser they
 * are does not change anything, and requiring `write` would lock read-only
 * roles out of asking for a distance.
 *
 * Tenant isolation is NOT enforced here. It is enforced one level down, in the
 * tools: coordinates are resolved from `context.userId`, never from a model
 * parameter, so no allowlist decision can expose one user's position to another.
 */
const LOCATION_POLICY = policy({
  agentId: AGENT_IDS.location,
  domain: "location",
  allowedTools: [...MAPS_TOOLS, ...INTEGRATION_READ_TOOLS, ...CAPABILITY_TOOLS, ...SELF_TOOLS],
  requiredPermissions: ["read"],
  writesRequireApproval: true,
  clientSelectable: true,
  description: "Maps, place search, routing, distance and travel time over Google Maps Platform",
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
  [AGENT_IDS.browser]: BROWSER_POLICY,
  [AGENT_IDS.location]: LOCATION_POLICY,
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
