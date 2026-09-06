// ---------------------------------------------------------------------------
// Sprint 6.5 — Automation Agent (n8n).
//
// Reuses the Sprint 5.4 integration whole: `n8n.trigger` takes a JARVIS
// workflowId — never a URL and never a webhook path — and the tool resolves it
// against the caller's own workflow rows before building a URL through the
// SSRF-hardened `buildWebhookUrl`. Idempotency is a database uniqueness
// constraint on (userId, toolId, idempotencyKey), not agent state.
//
// So the agent's contribution is narrow and it stays that way: pick the right
// workflow from a catalog the SERVER supplied, and explain the result. It
// cannot register a workflow, cannot name a URL, and cannot invent a
// workflowId — an id the user does not own fails the tool's own lookup.
//
// The catalog is preloaded here rather than exposed as a "list workflows" tool
// because listing is not a decision the model should be able to make about
// another user: the lister is called with the authenticated userId from the
// agent context, so the catalog is scoped before the model sees it.
// ---------------------------------------------------------------------------

import { DomainAgent, type DomainAgentConfig } from "../domain-agent.js";
import { AGENT_IDS, AGENT_POLICIES } from "../agent-policy.js";
import type { AgentContext, AgentInput } from "@jarvis/core";

/**
 * Minimal read port over the workflow table.
 *
 * Narrower than `IN8nRepository` on purpose: the agent needs to name workflows
 * and nothing else, so it is not handed the execution-claim surface.
 */
export interface WorkflowDirectory {
  listWorkflowsForUser(
    userId: string
  ): Promise<Array<{ id: string; name: string; isActive: boolean }>>;
}

export interface AutomationAgentConfig extends DomainAgentConfig {
  workflows?: WorkflowDirectory;
}

const AUTOMATION_PROMPT = [
  "You are the JARVIS Automation Agent. You run the user's pre-registered n8n workflows.",
  "",
  "=== YOU MAY ONLY RUN WHAT IS REGISTERED ===",
  "A server-supplied catalog of the user's workflows appears below under AUTHORIZED WORKFLOWS. That list is exhaustive.",
  "To run one, call the trigger tool with its exact workflowId from the catalog.",
  "You cannot create, register, edit or delete workflows, and you cannot run one by URL, webhook path or name alone.",
  "Never invent a workflowId. If the user asks for something not in the catalog, say plainly that no such workflow is registered and list what is available.",
  "If the catalog is empty, say no workflows are registered and stop — do not guess an id to try.",
  "",
  "=== INACTIVE WORKFLOWS ===",
  "A workflow marked inactive cannot be triggered. Say so instead of attempting it.",
  "",
  "=== APPROVAL ===",
  "Triggering a workflow is an external side effect and always requires human approval. The system intercepts your tool call and creates a pending approval.",
  "When that happens, present the workflow name, what it will do, the payload you are sending, and the approval ID, and ask the user to confirm.",
  "NEVER say you cannot proceed — the approval step IS the normal path. NEVER claim a workflow ran until a tool result confirms it.",
  "",
  "=== REPEAT REQUESTS ===",
  "The system deduplicates identical triggers, so re-running the same workflow with the same payload is safe and will not double-fire.",
  "If a user asks to re-run something, confirm whether they want the same payload again or a changed one before triggering.",
  "",
  "=== PAYLOADS ===",
  "Send only the fields the user actually supplied. Do not pad a payload with invented values, and do not include credentials, tokens or secrets in one.",
  "",
  "=== REPORTING RESULTS ===",
  "Workflow results arrive asynchronously via callback. After a successful trigger, say the workflow was started and that results will follow — do not describe an outcome you have not received.",
  "If a trigger fails, report the error as returned. Do not speculate about the workflow's internals.",
].join("\n");

export class AutomationAgent extends DomainAgent {
  private readonly workflows?: WorkflowDirectory;

  constructor(config: AutomationAgentConfig) {
    super(
      AGENT_IDS.automation,
      "Automation Agent",
      "Triggers the user's registered n8n workflows behind the approval boundary",
      "productivity",
      [...AGENT_POLICIES[AGENT_IDS.automation]!.allowedTools],
      AUTOMATION_PROMPT,
      { ...config, temperature: config.temperature ?? 0.2 }
    );
    this.workflows = config.workflows;
  }

  protected override async buildSystemPrompt(
    _input: AgentInput,
    context: AgentContext | undefined
  ): Promise<string> {
    const catalog = await this.loadCatalog(context);
    return [
      this.providerSystemPrompt,
      "",
      "=== AUTHORIZED WORKFLOWS (server-resolved, exhaustive) ===",
      catalog,
      "==========================================================",
    ].join("\n");
  }

  private async loadCatalog(context: AgentContext | undefined): Promise<string> {
    if (!this.workflows || !context?.userId) {
      return "Workflow catalog unavailable. Do not attempt to trigger any workflow; tell the user automation is not currently available.";
    }

    try {
      const rows = await this.workflows.listWorkflowsForUser(context.userId);
      if (rows.length === 0) {
        return "No workflows are registered for this user.";
      }
      return rows
        .map(
          (w) =>
            `- workflowId: ${w.id} | name: ${w.name} | ${w.isActive ? "ACTIVE" : "INACTIVE (cannot be triggered)"}`
        )
        .join("\n");
    } catch {
      // A directory failure must not become an invented workflow id, so the
      // model is told the list is unavailable rather than left with nothing.
      return "Workflow catalog could not be loaded. Do not attempt to trigger any workflow; report the problem to the user.";
    }
  }
}
