// ---------------------------------------------------------------------------
// Phase 18, Stage 18.2 — the Automation Library's JARVIS tools.
//
//   automation.library.search   the catalog, filtered and paginated
//   automation.library.status   the sync state, progress and recent runs
//   automation.library.sync     start (or resume) a synchronization — one
//                               bounded run, or continue until complete
//
// THE SECOND ARM ONTO ONE SERVICE. Each tool is a translation, not an
// implementation: it checks the request with core's rules — the same the API
// router uses — and hands it to `AutomationLibraryPort`, which the API
// implements with the very `AutomationLibraryService` instance the routes
// call. Who may do what (the owning Organization's roles, read from the
// database), the budgets, the lease and the chain are all decided there, so a
// sentence and a button get the same answer and the same refusal.
//
//     "JARVIS, n8n workflows sync karo"  ──┐
//                                          ├──► AutomationLibraryService
//     [Sync] on the Automations page     ──┘
//
// NOTHING HERE NAMES A SCOPE. The caller is `context.userId`, set by the
// executor from the verified session; the Organization, the instance and the
// position in a scan are the server's. A parameter that tries to name one is
// refused, never obeyed.
//
// NOTHING HERE ACTS ON A WORKFLOW. A catalog entry is an observation: none of
// these tools activates, edits or runs one. Triggering stays `n8n.trigger`,
// approval-gated, on its own allow-list.
//
// RISK LEVELS ARE HONEST. The reads are READ_ONLY. A sync reads n8n on the
// shared credential and writes only JARVIS's own catalog, so it is LOW_IMPACT
// (no approval; refused once shutdown begins). All three need only the
// platform's "read": the Organization role decides, never `auth.role`.
//
// STAGE 18.3B — INSPECT AND PROPOSE; THE PAGE ADDS.
//   automation.library.inspect           READ_ONLY: one entry's sanitized
//                                        structure, from the catalog alone.
//   automation.library.allowlist.propose LOW_IMPACT: an approval row asking
//                                        for the entry to go on the caller's
//                                        trigger allow-list. Nothing changes.
//   automation.library.allowlist.add     HIGH_IMPACT, approval-gated, on NO
//                                        agent's allowlist: the Automations
//                                        page runs it through ToolExecutor,
//                                        naming the approved proposal. It
//                                        consumes the approval — with the
//                                        Organization's scope — in the journal's
//                                        durable step, and a spoken turn never
//                                        reaches the change (18.3A).
//
// SPEECH DOES NOT START A SYNC. The executor refuses `automation.library.sync`
// for a spoken turn before this file is reached (`voiceToolRefusal`); the
// tool refuses again on its own context, so the port is never called for one.
// ---------------------------------------------------------------------------

import { BaseTool } from "../base-tool.js";
import { withSafeTerminalTransitions } from "../execution-journal.js";
import {
  AUTOMATION_LIBRARY_TOOL_IDS,
  BLOCKED_STATUSES,
  computeParamsHash,
  isLibraryEntryId,
  validateLibraryAllowlistParams,
  voiceConfirmationRefusal,
  type ExecutionJournalPort,
  type IApprovalConsumptionPort,
  type LibraryAllowlistApplyPort,
  LIBRARY_INVALID_QUERY_MESSAGE,
  LIBRARY_INVALID_SYNC_MESSAGE,
  LIBRARY_LIST_LIMIT_MAX,
  LIBRARY_SCOPE_REFUSED_MESSAGE,
  LIBRARY_SEARCH_MAX,
  VOICE_TOOL_REFUSED_CODE,
  namesLibraryServerScope,
  validateLibraryEntryQuery,
  validateLibrarySyncOptions,
  voiceToolRefusal,
  type AutomationLibraryPort,
  type LibraryResult,
  type ToolContext,
  type ToolResult,
} from "@jarvis/core";

abstract class LibraryTool extends BaseTool {
  constructor(
    protected readonly port: AutomationLibraryPort,
    id: string,
    name: string,
    description: string,
    parameters: ConstructorParameters<typeof BaseTool>[4],
    risk: "READ_ONLY" | "LOW_IMPACT"
  ) {
    super(id, name, description, "integration", parameters, false, ["read"], risk);
  }

  /** A refusal with the API's status, code and sentence. */
  protected refused(status: number, code: string, message: string): ToolResult {
    return { success: false, error: message, metadata: { toolId: this.id, code, status } };
  }

  protected answer<T>(result: LibraryResult<T>, message: (value: T) => string): ToolResult {
    if (!result.ok) return this.refused(result.status, result.code, result.message);
    return this.success(result.value, { toolId: this.id, message: message(result.value) });
  }

  /** A parameter that names what only the server decides. */
  protected namesScope(params: Record<string, unknown>): ToolResult | null {
    return namesLibraryServerScope(params) ? this.refused(400, "REQUEST_SCOPE_REFUSED", LIBRARY_SCOPE_REFUSED_MESSAGE) : null;
  }
}

export class SearchAutomationLibraryTool extends LibraryTool {
  constructor(port: AutomationLibraryPort) {
    super(
      port,
      AUTOMATION_LIBRARY_TOOL_IDS.search,
      "Search the n8n workflow library",
      "Searches the catalog of workflows observed on the organization's n8n instance — names, tags, node types, active flag, and whether each is present, missing from the last scan, or removed. Use for 'kaunse n8n workflows hain', 'find the invoice workflow'. Read-only. A library entry is NOT permission to run a workflow: only the AUTHORIZED WORKFLOWS list can be triggered.",
      [
        { name: "search", type: "string", description: `Words to find in a workflow's name, tags or node types (up to ${LIBRARY_SEARCH_MAX} characters).`, required: false },
        { name: "active", type: "boolean", description: "Only workflows that are active (true) or inactive (false) in n8n.", required: false },
        { name: "presence", type: "string", description: "current (default: not removed), present, missing, removed or all.", required: false },
        { name: "page", type: "number", description: "Page number, from 1.", required: false },
        { name: "limit", type: "number", description: `Workflows per page, 1 to ${LIBRARY_LIST_LIMIT_MAX} (default 50).`, required: false },
      ],
      "READ_ONLY"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const scoped = this.namesScope(params);
    if (scoped) return scoped;
    const query = validateLibraryEntryQuery({
      page: params.page,
      limit: params.limit,
      search: params.search,
      active: params.active,
      presence: params.presence,
    });
    if (!query) return this.refused(400, "INVALID_QUERY", LIBRARY_INVALID_QUERY_MESSAGE);
    return this.answer(await this.port.list(context.userId, query), (page) =>
      page.total === 0
        ? "No workflow in the library matches."
        : `Page ${page.page} of ${page.totalPages}: ${page.items.length} of ${page.total} matching workflows.`
    );
  }
}

export class AutomationLibraryStatusTool extends LibraryTool {
  constructor(port: AutomationLibraryPort) {
    super(
      port,
      AUTOMATION_LIBRARY_TOOL_IDS.status,
      "n8n workflow library status",
      "Reports the n8n workflow library's synchronization: running, partial, complete or failed; how far the open scan has read; when the last complete scan finished and how many workflows it saw; the latest continue-until-complete chain; and recent runs with their fixed failure reasons. Use for 'library sync ka status', 'is the n8n catalog up to date'. Read-only.",
      [],
      "READ_ONLY"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const scoped = this.namesScope(params);
    if (scoped) return scoped;
    return this.answer(await this.port.status(context.userId), (status) => {
      if (!status.configured) return "n8n is not configured on this server, so there is no library to synchronize.";
      const complete = status.lastCompleteScan
        ? `The last complete scan finished at ${status.lastCompleteScan.completedAt} and saw ${status.lastCompleteScan.records} workflows.`
        : "No scan has completed yet.";
      return `The library is ${status.state.replace("_", " ")}. ${complete}`;
    });
  }
}

export class SyncAutomationLibraryTool extends LibraryTool {
  constructor(port: AutomationLibraryPort) {
    super(
      port,
      AUTOMATION_LIBRARY_TOOL_IDS.sync,
      "Synchronize the n8n workflow library",
      "Starts a synchronization of the n8n workflow library — reading the workflow list from n8n into JARVIS's catalog. It changes nothing in n8n and runs no workflow. One call reads a bounded number of pages and resumes where the last run stopped; continueUntilComplete keeps going until the scan completes (within hard limits). Only an owner or admin of the organization may start one, and never by voice. It continues in the background: report that it started, then use automation.library.status.",
      [
        { name: "continueUntilComplete", type: "boolean", description: "Keep running bounded runs until the scan completes.", required: false },
        { name: "restart", type: "boolean", description: "Discard an unfinished scan and start again from the first page.", required: false },
        { name: "idempotencyKey", type: "string", description: "Optional 8-64 letters, digits, '-' or '_' identifying this one request; repeating it returns the same chain.", required: false },
      ],
      "LOW_IMPACT"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Behind the executor's own refusal: a spoken turn never reaches the port.
    const spoken = voiceToolRefusal(this.id, context.inputMode);
    if (spoken) return this.refused(403, VOICE_TOOL_REFUSED_CODE, spoken);
    const scoped = this.namesScope(params);
    if (scoped) return scoped;
    if ([params.restart, params.continueUntilComplete].some((value) => value !== undefined && typeof value !== "boolean")) {
      return this.refused(400, "INVALID_REQUEST", LIBRARY_INVALID_SYNC_MESSAGE);
    }
    const options = validateLibrarySyncOptions({
      restart: params.restart,
      continueUntilComplete: params.continueUntilComplete,
      idempotencyKey: params.idempotencyKey,
    });
    if (!options) return this.refused(400, "INVALID_REQUEST", LIBRARY_INVALID_SYNC_MESSAGE);
    return this.answer(await this.port.startSync(context.userId, { ...options, via: "jarvis" }), (started) => {
      if (started.mode === "run") {
        return started.resumed
          ? "A synchronization run started, continuing the unfinished scan. It runs in the background."
          : "A synchronization run started from the first page. It runs in the background.";
      }
      if (started.state !== "running") return `That synchronization already ended (${started.state.toLowerCase()}).`;
      return started.existing
        ? "A continue-until-complete synchronization is already running; this request joined it."
        : "A continue-until-complete synchronization started. It runs in the background until the scan completes or a limit stops it.";
    });
  }
}

const ENTRY_PARAM = {
  name: "entryId",
  type: "string",
  description: "The library entry's id, exactly as automation.library.search returned it.",
  required: true,
} as const;

export class InspectAutomationLibraryTool extends LibraryTool {
  constructor(port: AutomationLibraryPort) {
    super(
      port,
      AUTOMATION_LIBRARY_TOOL_IDS.inspect,
      "Inspect an n8n library workflow",
      "Shows the sanitized structure of one workflow in the n8n workflow library: its trigger kind, node types, the integration categories they belong to, its version, and how current the catalog is — built from the stored catalog, never from the workflow's parameters, credentials or data. Input names are never available. Read-only; inspecting a workflow does not make it triggerable. Use for 'what does the invoice workflow do', 'which apps does it use'.",
      [ENTRY_PARAM],
      "READ_ONLY"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const scoped = this.namesScope(params);
    if (scoped) return scoped;
    if (Object.keys(params).some((key) => key !== "entryId")) {
      return this.refused(400, "INVALID_REQUEST", "Only the library entry id is accepted — no workflow data, options or scope.");
    }
    if (!isLibraryEntryId(params.entryId)) return this.refused(400, "INVALID_ENTRY", "That is not a workflow library entry id.");
    return this.answer(await this.port.inspect(context.userId, params.entryId), (view) => {
      const trigger =
        view.trigger.status === "derived"
          ? `It starts by ${[...new Set(view.trigger.kinds.map((k) => k.kind.replace("_", " ")))].join(", ")}.`
          : view.trigger.status === "none_found"
            ? "No recognized trigger node was found."
            : "Its trigger is unknown.";
      const proposal = view.canPropose
        ? " It can be proposed for your trigger allow-list."
        : view.proposeBlockedReason
          ? ` ${view.proposeBlockedReason}`
          : "";
      return `${view.name}: ${trigger}${view.stale.stale ? ` ${view.stale.reason}` : ""}${proposal}`;
    });
  }
}

export class ProposeAllowlistTool extends LibraryTool {
  constructor(port: AutomationLibraryPort) {
    super(
      port,
      AUTOMATION_LIBRARY_TOOL_IDS.propose,
      "Propose a library workflow for the trigger allow-list",
      "Asks for one n8n library workflow to be added to YOUR trigger allow-list, at its current version. This only creates a proposal: another owner or admin of the organization must approve it on the Approvals page, and it is then added from the Automations page. Nothing is added, activated, edited or run by this tool, and it can never be confirmed by voice. Only an owner or admin may propose, and only a workflow with a webhook trigger.",
      [ENTRY_PARAM],
      "LOW_IMPACT"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const scoped = this.namesScope(params);
    if (scoped) return scoped;
    if (Object.keys(params).some((key) => key !== "entryId")) {
      return this.refused(400, "INVALID_REQUEST", "Only the library entry id is accepted — no workflow data, options or scope.");
    }
    if (!isLibraryEntryId(params.entryId)) return this.refused(400, "INVALID_ENTRY", "That is not a workflow library entry id.");
    return this.answer(await this.port.proposeAllowlist(context.userId, params.entryId, { via: "jarvis" }), (proposal) =>
      proposal.status === "approved"
        ? "A proposal for this workflow is already approved. Add it from the Automations page."
        : proposal.existing
          ? "A proposal for this workflow is already waiting for another owner or admin to approve it."
          : "Proposed. Another owner or admin of your organization must approve it on the Approvals page; then add it from the Automations page. Nothing has changed yet."
    );
  }
}

/**
 * Stage 18.3B — the trigger allow-list change itself. Page-only: on no
 * agent's allowlist. It runs only with an approved proposal, which it consumes
 * in the journal's durable step with the Organization's scope (resolved by the
 * service, re-checked by the approval store) — and only after the service has
 * checked everything again. One approval, one change.
 */
export class AllowlistAddTool extends BaseTool {
  private readonly journal: ExecutionJournalPort;

  constructor(
    private readonly port: LibraryAllowlistApplyPort,
    journal: ExecutionJournalPort,
    private readonly approvals?: IApprovalConsumptionPort
  ) {
    super(
      AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd,
      "Add a library workflow to the trigger allow-list",
      "Adds one approved n8n library workflow to the requester's trigger allow-list. Run from the Automations page with an approved proposal. It changes nothing in n8n.",
      "integration",
      [
        ENTRY_PARAM,
        { name: "versionId", type: "string", description: "The n8n version the proposal was approved for.", required: true },
      ],
      true,
      ["read"],
      "HIGH_IMPACT"
    );
    this.journal = withSafeTerminalTransitions(journal);
  }

  private refused(status: number, code: string, message: string): ToolResult {
    return { success: false, error: message, metadata: { toolId: this.id, code, status } };
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Behind ToolExecutor's own refusal (18.3A): a spoken turn never applies it.
    const spoken = voiceConfirmationRefusal(context.inputMode);
    if (spoken) return this.refused(403, "VOICE_NOT_ALLOWED", spoken);
    const bound = validateLibraryAllowlistParams(params);
    if (!bound) return this.refused(400, "INVALID_REQUEST", "A proposal names exactly one entry and its version.");
    if (!context.approvalId) return this.refused(403, "APPROVAL_REQUIRED", "This needs an approved proposal.");
    if (!this.approvals) return this.refused(503, "APPROVAL_UNAVAILABLE", "Approval verification unavailable.");
    const approvalId = context.approvalId;
    const approvals = this.approvals;
    const paramsHash = computeParamsHash(params);

    let executionId: string | null = null;
    const consume = async (scope: Parameters<Parameters<LibraryAllowlistApplyPort["applyAllowlist"]>[2]>[0]) => {
      let record;
      try {
        record = await this.journal.begin({
          userId: context.userId,
          toolId: this.id,
          idempotencyKey: `${this.id}:${approvalId}`,
          paramsHash,
          provider: "jarvis",
          traceId: context.traceId,
          approvalId,
        });
      } catch {
        return { ok: false as const, reason: "journal_unavailable" };
      }
      if (BLOCKED_STATUSES.has(record.status)) return { ok: false as const, reason: `already_${record.status.toLowerCase()}` };
      const result = await approvals.consumeForExecution({
        approvalId,
        userId: context.userId,
        toolId: this.id,
        paramsHash,
        executionId: record.executionId,
        tenantScope: scope,
      });
      if (result.ok) executionId = record.executionId;
      return result;
    };

    const result = await this.port.applyAllowlist(context.userId, bound, consume);
    if (executionId) {
      if (result.ok) await this.journal.markSucceeded(executionId);
      else await this.journal.markFailed(executionId, { code: result.code, message: result.message });
    }
    if (!result.ok) return this.refused(result.status, result.code, result.message);
    return this.success(result.value, {
      toolId: this.id,
      message:
        result.value.outcome === "unchanged"
          ? "This workflow was already on your trigger allow-list."
          : "Added to your trigger allow-list. Triggering it still needs your approval each time.",
    });
  }
}

export const AUTOMATION_LIBRARY_TOOLS = [
  AUTOMATION_LIBRARY_TOOL_IDS.search,
  AUTOMATION_LIBRARY_TOOL_IDS.status,
  AUTOMATION_LIBRARY_TOOL_IDS.sync,
  AUTOMATION_LIBRARY_TOOL_IDS.inspect,
  AUTOMATION_LIBRARY_TOOL_IDS.propose,
] as const;

export function createAutomationLibraryTools(port: AutomationLibraryPort): BaseTool[] {
  return [
    new SearchAutomationLibraryTool(port),
    new AutomationLibraryStatusTool(port),
    new SyncAutomationLibraryTool(port),
    new InspectAutomationLibraryTool(port),
    new ProposeAllowlistTool(port),
  ];
}

/** Stage 18.3B — the page-only, approval-gated change. Registered beside the others; granted to no agent. */
export function createAutomationLibraryAllowlistTool(
  port: LibraryAllowlistApplyPort,
  journal: ExecutionJournalPort,
  approvals?: IApprovalConsumptionPort
): BaseTool {
  return new AllowlistAddTool(port, journal, approvals);
}
