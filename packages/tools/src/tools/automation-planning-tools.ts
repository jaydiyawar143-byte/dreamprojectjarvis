// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — workflow planning tools.
//
//   automation.workflow.match   READ_ONLY   rank the library against a request
//   automation.draft.create     LOW_IMPACT  save a new draft in JARVIS
//   automation.draft.revise     LOW_IMPACT  save a new version of a draft
//   automation.draft.get        READ_ONLY   one draft (a version), re-checked
//   automation.draft.list       READ_ONLY   the organization's drafts
//
// TRANSLATIONS ONTO ONE SERVICE. Each tool hands its parameters, unchanged, to
// `AutomationPlanningPort` — the very instance the Automations page's router
// is given — and core's request rules check them there, so a sentence and a
// button are answered alike. The tools take the platform's `read` only; the
// Organization's role is asked in the service (`shared:read` to match and
// read, `shared:write` to create and revise).
//
// WHAT NONE OF THEM CAN DO. Reach n8n, change a workflow, put one on the
// trigger allow-list, or create an approval. A draft is a plan in JARVIS's
// store; nothing here deploys, activates, runs or publishes it, and none of
// these tools needs an approval because none acts outside JARVIS.
//
// Creating and revising write to JARVIS's own store (LOW_IMPACT), so the
// orchestrator runs them only for an explicit instruction ("save it as a
// draft", "create a draft…"): a request for a plan is answered with the match
// and an offer to save — the marketing calendar's precedent.
// ---------------------------------------------------------------------------

import { BaseTool } from "../base-tool.js";
import {
  AUTOMATION_PLANNING_TOOL_IDS,
  LIBRARY_INTEGRATION_CATEGORIES,
  LIBRARY_TRIGGER_KINDS,
  isDraftId,
  type AutomationPlanningPort,
  type DraftView,
  type PlanningResult,
  type ToolContext,
  type ToolResult,
} from "@jarvis/core";

abstract class PlanningTool extends BaseTool {
  constructor(
    protected readonly port: AutomationPlanningPort,
    id: string,
    name: string,
    description: string,
    parameters: ConstructorParameters<typeof BaseTool>[4],
    risk: "READ_ONLY" | "LOW_IMPACT"
  ) {
    super(id, name, description, "integration", parameters, false, ["read"], risk);
  }

  protected answer<T>(result: PlanningResult<T>, message: (value: T) => string): ToolResult {
    if (!result.ok) {
      return {
        success: false,
        error: result.message,
        metadata: { toolId: this.id, code: result.code, status: result.status, ...(result.issues ? { issues: result.issues } : {}) },
      };
    }
    return this.success(result.value, { toolId: this.id, message: message(result.value) });
  }
}

const REQUEST_PARAMS: NonNullable<ConstructorParameters<typeof BaseTool>[4]> = [
  { name: "goal", type: "string", description: "What the automation should do, in the user's words (up to 500 characters).", required: true },
  { name: "trigger", type: "string", description: `How it starts, only if the user said: ${LIBRARY_TRIGGER_KINDS.join(", ")}.`, required: false },
  { name: "services", type: "array", description: "App names the user named (Slack, Gmail, Google Sheets…). Never guess one.", required: false },
  { name: "integrations", type: "array", description: `Kinds of app the user asked for without naming one: ${LIBRARY_INTEGRATION_CATEGORIES.join(", ")}.`, required: false },
  { name: "inputs", type: "array", description: "The names of the data it receives, if the user said.", required: false },
  { name: "outcome", type: "string", description: "What should have happened when it finishes, if the user said.", required: false },
];

const statusLine = (draft: DraftView) =>
  draft.status === "needs_input"
    ? `${draft.requirements.filter((r) => r.state === "needs_input").length} item(s) still need an answer.`
    : draft.status === "unverified"
      ? "Its structure is checked; its settings are not validated against n8n's node schemas, which JARVIS does not have."
      : draft.status === "stale"
        ? "Its source workflow has changed since; start a new draft from the current version."
        : `Status: ${draft.status}.`;

export class MatchWorkflowTool extends PlanningTool {
  constructor(port: AutomationPlanningPort) {
    super(
      port,
      AUTOMATION_PLANNING_TOOL_IDS.match,
      "Find existing workflows for an automation request",
      "Compares an automation request with the organization's n8n workflow library and explains, criterion by criterion (trigger, apps, shared words, metadata), which existing workflows could be reused or customized — or says that none fits, or that there is too little to judge. " +
        "Use it FIRST whenever the user wants an automation, before suggesting a new one. It reads only the stored catalog: it cannot see how a workflow's nodes are configured, so present a match as a lead to inspect, not as proof. Read-only; changes nothing.",
      REQUEST_PARAMS,
      "READ_ONLY"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.answer(await this.port.match(context.userId, params, { via: "jarvis" }), (match) => {
      const open = match.request.openQuestions.length ? ` Still open: ${match.request.openQuestions.map((q) => q.question).join(" ")}` : "";
      return `${match.explanation}${open}`;
    });
  }
}

export class CreateDraftTool extends PlanningTool {
  constructor(port: AutomationPlanningPort) {
    super(
      port,
      AUTOMATION_PLANNING_TOOL_IDS.draftCreate,
      "Save a workflow draft",
      "Saves a reviewable draft in JARVIS — a NEW workflow, or a CUSTOMIZATION of a library workflow (kind customization, sourceEntryId) bound to its current version. Use it ONLY when the user asks for a draft to be saved or created; for a plan or ideas, answer in your reply and offer to save it. " +
        "A draft is never sent to n8n and changes nothing there. Without nodes and connections the server builds the structure the request implies. If you give nodes, each is { key, type, label?, source?, remove?, settings? } with a supported n8n node type; settings are questions to answer ({ key, label, kind: value | credential | in_n8n, value? }). " +
        "Never put parameters, credentials, secrets, expressions or URLs in a draft — they are refused. If a library workflow already covers the request the server says so; set overrideReuse only when the user still wants a new one.",
      [
        ...REQUEST_PARAMS,
        { name: "kind", type: "string", description: "new or customization.", required: true },
        { name: "sourceEntryId", type: "string", description: "For a customization: the library entry id.", required: false },
        { name: "title", type: "string", description: "A short title.", required: false },
        { name: "nodes", type: "array", description: "The proposed nodes (with connections).", required: false },
        { name: "connections", type: "array", description: "The proposed connections: { from, to, output? } by node key.", required: false },
        { name: "overrideReuse", type: "boolean", description: "True only when the user wants a new workflow although one in the library covers the request.", required: false },
      ],
      "LOW_IMPACT"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.answer(await this.port.createDraft(context.userId, params, { via: "jarvis" }), ({ draft, existing }) =>
      `${existing ? "This draft already existed" : "Saved draft"} "${draft.title}", version ${draft.version.number}. It is only in JARVIS — nothing in n8n changed. ${statusLine(draft)}`
    );
  }
}

export class ReviseDraftTool extends PlanningTool {
  constructor(port: AutomationPlanningPort) {
    super(
      port,
      AUTOMATION_PLANNING_TOOL_IDS.draftRevise,
      "Save a new version of a workflow draft",
      "Saves a NEW version of a draft from the version named in baseVersion — earlier versions never change. Give answers (\"question.<key>\" or \"<node key>.<setting key>\" → plain text) and/or a full replacement of nodes with connections. " +
        "Use it only when the user asks to change or answer the draft. Credentials are never given a value; a newer version than baseVersion is reported, not overwritten. Nothing in n8n changes.",
      [
        { name: "draftId", type: "string", description: "The draft's id.", required: true },
        { name: "baseVersion", type: "number", description: "The version this revision changes (normally the latest).", required: true },
        { name: "answers", type: "object", description: "Answers to open questions and settings.", required: false },
        { name: "nodes", type: "array", description: "A full replacement of the nodes (with connections).", required: false },
        { name: "connections", type: "array", description: "A full replacement of the connections.", required: false },
      ],
      "LOW_IMPACT"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { draftId, ...revision } = params;
    if (!isDraftId(draftId)) return this.answer({ ok: false, status: 400, code: "INVALID_DRAFT", message: "That is not a draft id." }, () => "");
    return this.answer(await this.port.reviseDraft(context.userId, draftId, revision, { via: "jarvis" }), ({ draft, unchanged }) =>
      unchanged
        ? `Nothing changed: version ${draft.version.number} already holds this.`
        : `Saved version ${draft.version.number} of "${draft.title}". Earlier versions are unchanged. ${statusLine(draft)}`
    );
  }
}

export class GetDraftTool extends PlanningTool {
  constructor(port: AutomationPlanningPort) {
    super(
      port,
      AUTOMATION_PLANNING_TOOL_IDS.draftGet,
      "Read a workflow draft",
      "Reads one workflow draft — its latest version, or the version named — with its proposed changes, its checks re-run now, what still needs an answer, and its version history. Read-only.",
      [
        { name: "draftId", type: "string", description: "The draft's id.", required: true },
        { name: "version", type: "number", description: "A version number; the latest when left out.", required: false },
      ],
      "READ_ONLY"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!isDraftId(params.draftId)) return this.answer({ ok: false, status: 400, code: "INVALID_DRAFT", message: "That is not a draft id." }, () => "");
    if (Object.keys(params).some((k) => k !== "draftId" && k !== "version")) {
      return this.answer({ ok: false, status: 400, code: "INVALID_REQUEST", message: "Only draftId and version are accepted." }, () => "");
    }
    const version = params.version === undefined ? undefined : Number(params.version);
    return this.answer(await this.port.getDraft(context.userId, params.draftId, version), (draft) =>
      `"${draft.title}", version ${draft.version.number} of ${draft.latestVersion}. ${statusLine(draft)}`
    );
  }
}

export class ListDraftsTool extends PlanningTool {
  constructor(port: AutomationPlanningPort) {
    super(
      port,
      AUTOMATION_PLANNING_TOOL_IDS.draftList,
      "List workflow drafts",
      "Lists the organization's workflow drafts, newest first. Read-only.",
      [
        { name: "page", type: "number", description: "Page, from 1.", required: false },
        { name: "limit", type: "number", description: "Up to 50.", required: false },
      ],
      "READ_ONLY"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const page = params.page === undefined ? 1 : Number(params.page);
    const limit = params.limit === undefined ? 20 : Number(params.limit);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50 || Object.keys(params).some((k) => k !== "page" && k !== "limit")) {
      return this.answer({ ok: false, status: 400, code: "INVALID_REQUEST", message: "Use page (1 or more) and limit (1 to 50)." }, () => "");
    }
    return this.answer(await this.port.listDrafts(context.userId, { page, limit }), (list) => `${list.total} draft(s).`);
  }
}

export const AUTOMATION_PLANNING_TOOLS = [
  AUTOMATION_PLANNING_TOOL_IDS.match,
  AUTOMATION_PLANNING_TOOL_IDS.draftCreate,
  AUTOMATION_PLANNING_TOOL_IDS.draftRevise,
  AUTOMATION_PLANNING_TOOL_IDS.draftGet,
  AUTOMATION_PLANNING_TOOL_IDS.draftList,
] as const;

export function createAutomationPlanningTools(port: AutomationPlanningPort): BaseTool[] {
  return [new MatchWorkflowTool(port), new CreateDraftTool(port), new ReviseDraftTool(port), new GetDraftTool(port), new ListDraftsTool(port)];
}
