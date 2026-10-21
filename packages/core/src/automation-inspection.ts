// ---------------------------------------------------------------------------
// Phase 18, Stage 18.3B — the sanitized structure of one library workflow, and
// the contract of a proposal to put it on the trigger allow-list.
//
// INSPECTION IS BUILT FROM WHAT THE CATALOG ALREADY HOLDS. A catalog entry is
// listing metadata that was normalized when it was stored (Stage 18.1): the
// name, n8n's active flag and versionId, and the node TYPES — never a node's
// parameters, credentials, expressions, settings, static or pinned data. This
// module derives a view from that entry alone, through an explicit allowlist
// of output fields; nothing else can appear in it because nothing else is
// copied. n8n is not contacted to fill a gap: what the listing did not carry
// is reported as unavailable, with the reason.
//
// WHAT IS DERIVED, AND HOW RELIABLY.
//   Trigger    the node types that start a workflow, from a curated table of
//              n8n's trigger nodes and the "…Trigger" naming convention. A
//              stored type says the node EXISTS, not that it is enabled.
//   Integrations  node types grouped into categories, from a curated table.
//              Anything not in it is listed as unrecognized, never guessed.
//   Inputs     never: input names live in node parameters, which are not read.
//
// Every value is re-validated on the way out (identifiers, node types) and a
// value that fails is dropped and reported — fail closed, per field. A display
// name keeps its words but loses any link in it.
// ---------------------------------------------------------------------------

import {
  LIBRARY_EXTERNAL_ID_PATTERN,
  LIBRARY_NODE_TYPE_PATTERN,
  LIBRARY_VERSION_ID_PATTERN,
  type LibraryEntryPresence,
  type LibraryEntryRecord,
  type LibraryResult,
} from "./automation-library.js";

export type LibraryTriggerKind =
  | "webhook"
  | "schedule"
  | "manual"
  | "form"
  | "chat"
  | "sub_workflow"
  | "error_handler"
  | "email"
  | "n8n_event"
  | "app_event";

export type LibraryIntegrationCategory =
  | "messaging"
  | "email"
  | "spreadsheet"
  | "database"
  | "crm"
  | "storage"
  | "calendar"
  | "ai"
  | "http"
  | "code"
  | "logic"
  | "social"
  | "payments"
  | "project_management";

/** The sanitized structure of one catalog entry. Every field is listed here; nothing else exists. */
export interface LibraryInspection {
  entryId: string;
  /** The workflow's display name, with any link removed. */
  name: string;
  /** n8n's own active flag, as last listed. */
  active: boolean;
  presence: LibraryEntryPresence;
  /** n8n's versionId, when the listing carried a valid one. */
  versionId: string | null;
  /** When the catalog last saw this workflow — the age of everything below. */
  observedAt: string;
  trigger: {
    /** derived: trigger node types found; none_found: none recognized; unavailable: node types unknown. */
    status: "derived" | "none_found" | "unavailable";
    kinds: Array<{ kind: LibraryTriggerKind; nodeType: string }>;
  };
  nodeTypes: {
    /** partial: some stored values failed validation and were left out. */
    status: "available" | "partial" | "unavailable";
    items: string[];
    /** The listing's node count, when it carried one. */
    count: number | null;
  };
  integrations: {
    status: "derived" | "unavailable";
    categories: Array<{ category: LibraryIntegrationCategory; nodeTypes: string[] }>;
    /** Node types the table does not know. Listed, never classified by guesswork. */
    unrecognized: string[];
  };
  /** Input names are node parameters, which are not read. Always unavailable. */
  inputs: { available: false; reason: string };
  stale: { stale: boolean; reason: string | null };
  /** Fixed sentences: what this view cannot tell. */
  limitations: string[];
}

export const LIBRARY_INSPECTION_LIMITS = {
  noParameters: "Built from the catalog's stored listing metadata. n8n was not contacted, and no node's parameters, credentials or data were read.",
  disabledUnknown: "A trigger node may be disabled in n8n; the listing does not say.",
  inputs: "Input names live in node parameters, which are not read.",
  noNodeTypes: "The listing n8n returned did not include this workflow's nodes, so its trigger and integrations are unknown.",
  partialNodeTypes: "Some stored node types failed validation and were left out.",
  noVersion: "n8n did not report a version for this workflow.",
  missing: "This workflow was not seen in the last complete scan; it may have been deleted in n8n.",
  removed: "This workflow was missing from consecutive complete scans and is treated as removed.",
} as const;

// ---------------------------------------------------------------------------
// The curated tables. A node type is `<package>.<name>`; matching is on the
// exact type first, then on the name for the n8n base package.
// ---------------------------------------------------------------------------

const TRIGGER_BY_TYPE: Readonly<Record<string, LibraryTriggerKind>> = {
  "n8n-nodes-base.webhook": "webhook",
  "n8n-nodes-base.formTrigger": "form",
  "n8n-nodes-base.scheduleTrigger": "schedule",
  "n8n-nodes-base.cron": "schedule",
  "n8n-nodes-base.interval": "schedule",
  "n8n-nodes-base.manualTrigger": "manual",
  "n8n-nodes-base.start": "manual",
  "n8n-nodes-base.executeWorkflowTrigger": "sub_workflow",
  "n8n-nodes-base.errorTrigger": "error_handler",
  "n8n-nodes-base.emailReadImap": "email",
  "n8n-nodes-base.n8nTrigger": "n8n_event",
  "@n8n/n8n-nodes-langchain.chatTrigger": "chat",
  "@n8n/n8n-nodes-langchain.manualChatTrigger": "chat",
};

/** By the node name in n8n's base package (and langchain's, for AI). */
const CATEGORY_BY_NAME: Readonly<Record<string, LibraryIntegrationCategory>> = {
  slack: "messaging",
  discord: "messaging",
  telegram: "messaging",
  mattermost: "messaging",
  microsoftTeams: "messaging",
  whatsApp: "messaging",
  twilio: "messaging",
  gmail: "email",
  emailSend: "email",
  emailReadImap: "email",
  microsoftOutlook: "email",
  sendGrid: "email",
  mailgun: "email",
  mailchimp: "email",
  googleSheets: "spreadsheet",
  microsoftExcel: "spreadsheet",
  airtable: "spreadsheet",
  postgres: "database",
  mySql: "database",
  mongoDb: "database",
  redis: "database",
  supabase: "database",
  microsoftSql: "database",
  hubspot: "crm",
  salesforce: "crm",
  pipedrive: "crm",
  zohoCrm: "crm",
  googleDrive: "storage",
  dropbox: "storage",
  awsS3: "storage",
  s3: "storage",
  microsoftOneDrive: "storage",
  ftp: "storage",
  googleCalendar: "calendar",
  openAi: "ai",
  httpRequest: "http",
  webhook: "http",
  respondToWebhook: "http",
  code: "code",
  function: "code",
  functionItem: "code",
  executeCommand: "code",
  if: "logic",
  switch: "logic",
  merge: "logic",
  set: "logic",
  filter: "logic",
  splitInBatches: "logic",
  splitOut: "logic",
  aggregate: "logic",
  noOp: "logic",
  wait: "logic",
  scheduleTrigger: "logic",
  manualTrigger: "logic",
  executeWorkflow: "logic",
  executeWorkflowTrigger: "logic",
  stickyNote: "logic",
  facebookGraphApi: "social",
  linkedIn: "social",
  twitter: "social",
  stripe: "payments",
  payPal: "payments",
  jira: "project_management",
  trello: "project_management",
  asana: "project_management",
  notion: "project_management",
  clickUp: "project_management",
  github: "project_management",
};

const BASE_PACKAGE = "n8n-nodes-base";
const LANGCHAIN_PACKAGE = "@n8n/n8n-nodes-langchain";

function splitType(type: string): { pkg: string; name: string } | null {
  const dot = type.lastIndexOf(".");
  if (dot <= 0 || dot === type.length - 1) return null;
  return { pkg: type.slice(0, dot), name: type.slice(dot + 1) };
}

/** The trigger kind of a node type, or null when it is not a recognized trigger. */
export function libraryTriggerKind(type: string): LibraryTriggerKind | null {
  const exact = TRIGGER_BY_TYPE[type];
  if (exact) return exact;
  const parts = splitType(type);
  // The naming convention every n8n app trigger follows: slackTrigger, githubTrigger…
  if (parts && /^[a-z][A-Za-z0-9]*Trigger$/.test(parts.name)) return "app_event";
  return null;
}

/** The integration category of a node type, or null when the table does not know it. */
export function libraryIntegrationCategory(type: string): LibraryIntegrationCategory | null {
  const parts = splitType(type);
  if (!parts) return null;
  if (parts.pkg === LANGCHAIN_PACKAGE) return "ai";
  if (parts.pkg !== BASE_PACKAGE) return null;
  if (Object.prototype.hasOwnProperty.call(CATEGORY_BY_NAME, parts.name)) return CATEGORY_BY_NAME[parts.name]!;
  // An app trigger belongs with its app: slackTrigger → slack → messaging.
  const app = parts.name.endsWith("Trigger") ? parts.name.slice(0, -"Trigger".length) : null;
  return app && Object.prototype.hasOwnProperty.call(CATEGORY_BY_NAME, app) ? CATEGORY_BY_NAME[app]! : null;
}

/** Text with every link replaced. Stage 18.4 uses it for planning text too. */
export function stripLinks(text: string): string {
  return text.replace(/\b(?:https?|ftp|file|wss?):\/\/\S*/gi, "[link removed]").replace(/\bwww\.\S+/gi, "[link removed]");
}

/** A display name with any link taken out: the inspection never carries a URL. */
export function withoutLinks(text: string): string {
  return stripLinks(text).slice(0, 256);
}

/** The sanitized structure of one catalog entry — pure, from the entry alone. */
export function inspectLibraryEntry(entry: LibraryEntryRecord): LibraryInspection {
  const limitations: string[] = [LIBRARY_INSPECTION_LIMITS.noParameters];

  // Node types, re-validated on the way out: a stored value that fails is dropped.
  let nodeTypes: LibraryInspection["nodeTypes"];
  if (entry.nodeTypes === null) {
    nodeTypes = { status: "unavailable", items: [], count: null };
    limitations.push(LIBRARY_INSPECTION_LIMITS.noNodeTypes);
  } else {
    const valid = [...new Set(entry.nodeTypes.filter((t) => typeof t === "string" && LIBRARY_NODE_TYPE_PATTERN.test(t)))].sort();
    const partial = valid.length !== entry.nodeTypes.length;
    if (partial) limitations.push(LIBRARY_INSPECTION_LIMITS.partialNodeTypes);
    const count = typeof entry.nodeCount === "number" && Number.isInteger(entry.nodeCount) && entry.nodeCount >= 0 ? entry.nodeCount : null;
    nodeTypes = { status: partial ? "partial" : "available", items: valid, count };
  }

  let trigger: LibraryInspection["trigger"];
  let integrations: LibraryInspection["integrations"];
  if (nodeTypes.status === "unavailable") {
    trigger = { status: "unavailable", kinds: [] };
    integrations = { status: "unavailable", categories: [], unrecognized: [] };
  } else {
    const kinds = nodeTypes.items
      .map((nodeType) => ({ kind: libraryTriggerKind(nodeType), nodeType }))
      .filter((k): k is { kind: LibraryTriggerKind; nodeType: string } => k.kind !== null);
    trigger = { status: kinds.length > 0 ? "derived" : "none_found", kinds };
    if (kinds.length > 0) limitations.push(LIBRARY_INSPECTION_LIMITS.disabledUnknown);

    const grouped = new Map<LibraryIntegrationCategory, string[]>();
    const unrecognized: string[] = [];
    for (const nodeType of nodeTypes.items) {
      const category = libraryIntegrationCategory(nodeType);
      if (!category) unrecognized.push(nodeType);
      else grouped.set(category, [...(grouped.get(category) ?? []), nodeType]);
    }
    integrations = {
      status: "derived",
      categories: [...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([category, types]) => ({ category, nodeTypes: types })),
      unrecognized,
    };
  }

  limitations.push(LIBRARY_INSPECTION_LIMITS.inputs);
  const versionId = typeof entry.versionId === "string" && LIBRARY_VERSION_ID_PATTERN.test(entry.versionId) ? entry.versionId : null;
  if (!versionId) limitations.push(LIBRARY_INSPECTION_LIMITS.noVersion);

  const stale =
    entry.presence === "removed"
      ? { stale: true, reason: LIBRARY_INSPECTION_LIMITS.removed }
      : entry.presence === "missing"
        ? { stale: true, reason: LIBRARY_INSPECTION_LIMITS.missing }
        : { stale: false, reason: null };

  return {
    entryId: entry.externalId,
    name: withoutLinks(entry.name),
    active: entry.active === true,
    presence: entry.presence,
    versionId,
    observedAt: entry.lastSeenAt,
    trigger,
    nodeTypes,
    integrations,
    inputs: { available: false, reason: LIBRARY_INSPECTION_LIMITS.inputs },
    stale,
    limitations,
  };
}

/** Whether an entry id is one the catalog could hold. */
export function isLibraryEntryId(value: unknown): value is string {
  return typeof value === "string" && LIBRARY_EXTERNAL_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// The trigger allow-list proposal.
//
// A proposal is an ordinary approval (the approval store, the Approvals page)
// for the page-only tool `automation.library.allowlist.add`, bound by its
// parameters to the exact entry and n8n version. That tool is a write through
// the shared n8n connection (`SHARED_CONNECTION_TOOLS`), so its approval
// belongs to the Organization that owns the connection from the moment it
// exists, must be approved by ANOTHER owner or admin, and is consumed only in
// the transaction that re-checks all of that under locks (Phase 17).
// ---------------------------------------------------------------------------

/** The parameters an allow-list approval is bound to. Nothing else, and nothing the server decides. */
export interface LibraryAllowlistParams {
  entryId: string;
  versionId: string;
}

export function validateLibraryAllowlistParams(input: unknown): LibraryAllowlistParams | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("entryId") || !keys.includes("versionId")) return null;
  const { entryId, versionId } = input as Record<string, unknown>;
  if (!isLibraryEntryId(entryId)) return null;
  if (typeof versionId !== "string" || !LIBRARY_VERSION_ID_PATTERN.test(versionId)) return null;
  return { entryId, versionId };
}

/** How the allow-list ties a registered workflow to its catalog entry: instance and n8n id. */
export function libraryEntryRef(instanceKey: string, entryId: string): string {
  return `${instanceKey}:${entryId}`;
}

export type LibraryProposalStatus = "none" | "awaiting_approval" | "approved" | "rejected" | "expired" | "used";

export interface LibraryInspectionView extends LibraryInspection {
  inspectedAt: string;
  source: "catalog";
  /** The CALLER's own trigger allow-list — whether this entry is on it. */
  allowlist: { status: "not_on_allowlist" | "on_allowlist" | "on_allowlist_other_version"; registeredVersionId: string | null };
  /** The caller's latest proposal for this entry, if any. `used` is not `applied`: see `allowlist`. */
  proposal: { status: LibraryProposalStatus; approvalId: string | null; versionId: string | null } | null;
  /** Whether this caller may propose it now, as the server decides it. A start is checked again. */
  canPropose: boolean;
  /** Why not, when not — a fixed sentence. */
  proposeBlockedReason: string | null;
}

export interface LibraryAllowlistProposal {
  approvalId: string;
  /** Another request for exactly this entry and version was already waiting. */
  existing: boolean;
  status: "awaiting_approval" | "approved";
  entryId: string;
  versionId: string;
  expiresAt: string;
}

export interface LibraryAllowlistApplied {
  entryId: string;
  versionId: string;
  /** created: added; unchanged: it was already there; updated: an earlier version's row now points at this one. */
  outcome: "created" | "unchanged" | "updated";
}

/** What a live read of one workflow may return to the server: the webhook trigger's target, validated. Never returned to a client. */
export interface LibraryTriggerTarget {
  versionId: string | null;
  /** Every ENABLED webhook node, reduced to these three values. */
  webhooks: Array<{ path: string | null; method: string | null; authentication: string | null }>;
}

export interface LibraryTriggerTargetSource {
  fetchTriggerTarget(
    entryId: string
  ): Promise<{ ok: true; target: LibraryTriggerTarget } | { ok: false; error: { code: string; httpStatus?: number } }>;
}

/** The trigger allow-list, as the library may extend it. */
export interface LibraryAllowlistRegistry {
  registerLibraryWorkflow(input: {
    userId: string;
    name: string;
    webhookPath: string;
    entryRef: string;
    versionId: string;
  }): Promise<{ outcome: "created" | "unchanged" | "updated" | "conflict" }>;
  findLibraryRegistrations(userId: string, entryRefs: string[]): Promise<Array<{ entryRef: string; versionId: string | null }>>;
}

/** The page-only apply path's port: run the change once its approval was consumed by the tool. */
export interface LibraryAllowlistApplyPort {
  applyAllowlist(
    userId: string,
    params: LibraryAllowlistParams,
    /** Consumes the approval with the Organization's scope; the change is made only when it succeeds. */
    consume: (scope: import("./types/tenant.js").SharedConnectionScope) => Promise<{ ok: true } | { ok: false; reason: string }>
  ): Promise<LibraryResult<LibraryAllowlistApplied>>;
}
