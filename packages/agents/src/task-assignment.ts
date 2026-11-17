// ---------------------------------------------------------------------------
// VO-3.1 — which agent a piece of work is assigned to.
//
// A task runs ONE tool (TaskPlannerService picks it, TaskExecutionService runs
// it). Which agent that work belongs to is decided here, from the agent
// policies, once — so the API, the scheduler and the tests all ask the same
// question and get the same answer.
//
// THE RULE, in order:
//
//   1. Only REGISTERED agents whose policy grants the tool are candidates.
//      None: the work stays JARVIS system work (null).
//   2. Exactly one specialist (any agent but the general assistant) holds it:
//      that specialist. `maps.route` is the Location Agent's.
//   3. Several specialists hold it: the one whose DOMAIN the tool's namespace
//      names. `meta.insights` is held by Meta Ads, Analytics and Marketing;
//      it is the Meta Ads Agent's.
//   4. Several specialists and no namespace match (cross-cutting tools such as
//      `integration.status` or `capabilities.*`), or no specialist at all
//      (`time.now`): the general assistant, when it holds the tool.
//   5. Otherwise the first specialist in policy order — a fixed order, so the
//      answer never depends on iteration accidents.
//
// WHAT THIS IS NOT. It is attribution for the office and the task record, not
// authority. The executor is never handed this agent: a task still runs with
// the caller's role and nothing else, because handing an agent id to a tool
// changes what some tools do (the marketing tools treat an agent's call as
// JARVIS's, not the person's). The run is linked to its audit row by the
// task's `executionId`, not by this field.
//
// Pure: no I/O, no clock, no registry lookups beyond the ids it is handed.
// ---------------------------------------------------------------------------

import { AGENT_POLICIES } from "./agent-policy.js";
import type { AgentPolicy } from "@jarvis/core";

/**
 * A tool namespace that names a domain by another word. Everything else is
 * compared literally (`browser.*` is the `browser` domain).
 */
const NAMESPACE_DOMAIN: Readonly<Record<string, string>> = Object.freeze({
  meta: "meta-ads",
  google: "google-ads",
});

export type TaskAssignmentReason =
  | "only_specialist"
  | "domain_specialist"
  | "general_assistant"
  | "first_specialist";

export interface TaskAssignment {
  agentId: string;
  reason: TaskAssignmentReason;
}

export interface TaskAssignmentOptions {
  /** Agents this process actually constructed. Others are never assigned. */
  registeredAgentIds: ReadonlySet<string>;
  /** Defaults to the compiled policies; tests may hand their own. */
  policies?: Readonly<Record<string, AgentPolicy>>;
}

function namespaceOf(toolId: string): string {
  const dot = toolId.indexOf(".");
  return dot === -1 ? toolId : toolId.slice(0, dot);
}

export function assignAgentForTool(
  toolId: string,
  options: TaskAssignmentOptions
): TaskAssignment | null {
  if (typeof toolId !== "string" || toolId.length === 0) return null;

  const policies = Object.values(options.policies ?? AGENT_POLICIES);
  const candidates = policies.filter(
    (policy) =>
      options.registeredAgentIds.has(policy.agentId) && policy.allowedTools.includes(toolId)
  );
  if (candidates.length === 0) return null;

  const general = candidates.find((policy) => policy.domain === "general");
  const specialists = candidates.filter((policy) => policy.domain !== "general");

  if (specialists.length === 1) {
    return { agentId: specialists[0]!.agentId, reason: "only_specialist" };
  }

  if (specialists.length > 1) {
    const namespace = namespaceOf(toolId);
    const domain = NAMESPACE_DOMAIN[namespace] ?? namespace;
    const named = specialists.find((policy) => policy.domain === domain);
    if (named) return { agentId: named.agentId, reason: "domain_specialist" };
  }

  if (general) return { agentId: general.agentId, reason: "general_assistant" };

  return { agentId: specialists[0]!.agentId, reason: "first_specialist" };
}
