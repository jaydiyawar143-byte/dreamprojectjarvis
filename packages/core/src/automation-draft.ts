// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — workflow drafts: what one is, how it is checked, and
// what changed.
//
// A DRAFT IS A PLAN, NOT A WORKFLOW. It lives in JARVIS's own store, is never
// sent to n8n, and holds no n8n definition: no parameters, no credentials, no
// expressions, no URLs. It is a structure — nodes of reviewed types, the
// connections between them, the triggers — and, for each node, the SETTINGS a
// person still has to decide, written as questions with plain answers.
// Credentials are references ("a Slack account, configured in n8n"); a value
// for one is refused, never stored.
//
// WHY SO LITTLE. Stage 18.4 had no copy of n8n's node parameter schemas: the
// repository carried none, and the n8n instance was never asked for them
// (Stage 18.4 contacts no n8n). Stage 18.5 added one — a pinned, reviewed,
// offline copy for exactly the types below — so a setting may now name a real
// parameter and be checked against it. The node vocabulary is still the short
// list below — documented
// n8n base-package nodes that the Stage 18.3B tables already name, with the
// fixed number of inputs and outputs their descriptions declare — and a node
// whose ports depend on its configuration (Switch, Merge, error outputs, AI
// sub-nodes) or whose content is a program (Code) is not in it.
//
// NEVER "VALIDATED" BY OMISSION. Every check reports passed, failed, pending
// (input needed) or not_run, with its reason. `configuration_schema` runs
// against the trusted n8n schemas when the server holds them and is not_run
// when it does not, and a customization's `source_graph` is not run because
// the catalog holds no connections — so a draft is at best "unverified" until
// every check has run and passed.
//
// IMMUTABLE VERSIONS. A draft is a series of versions. A version, once
// stored, never changes (the store has no update, and PostgreSQL refuses one);
// a revision is a new version, taken only from the version it was based on.
// Its content hash is computed here, from the canonical content.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { isLibraryEntryId, libraryTriggerKind, type LibraryIntegrationCategory, type LibraryTriggerKind } from "./automation-inspection.js";
import { LIBRARY_NODE_TYPE_PATTERN, type LibraryEntryPresence } from "./automation-library.js";
import {
  PLANNING_LIMITS,
  PLANNING_REQUEST_FIELDS,
  PLANNING_SECRET_MESSAGE,
  planningText,
  validateAutomationRequest,
  type AutomationRequest,
  type PlanningMatch,
  type PlanningRefusal,
} from "./automation-planning.js";
import { sanitizeUntrustedText } from "./evidence-builder.js";
import { canonicalizeForHash } from "./utils/params-hash.js";
import { containsSecret } from "./utils/redact-secrets.js";
import {
  NODE_SCHEMA_MESSAGES,
  checkDraftConfiguration,
  type DraftSchemaHint,
  type NodeSchemaRegistry,
} from "./automation-node-schema.js";

// ---------------------------------------------------------------------------
// The node vocabulary.
// ---------------------------------------------------------------------------

export type DraftNodeKind = "trigger" | "action" | "logic";

export interface DraftNodeSpec {
  label: string;
  kind: DraftNodeKind;
  /** Main inputs and outputs, as the node's description declares them. */
  inputs: 0 | 1;
  outputs: 1 | 2;
  outputNames: readonly string[];
  /** The account it needs, configured in n8n; null when none is required. */
  credential: string | null;
}

const trigger = (label: string, credential: string | null = null): DraftNodeSpec => ({
  label,
  kind: "trigger",
  inputs: 0,
  outputs: 1,
  outputNames: ["main"],
  credential,
});
const action = (label: string, credential: string | null): DraftNodeSpec => ({ label, kind: "action", inputs: 1, outputs: 1, outputNames: ["main"], credential });
const logic = (label: string): DraftNodeSpec => ({ label, kind: "logic", inputs: 1, outputs: 1, outputNames: ["main"], credential: null });

/** The node types a draft may hold. Anything else is refused, never guessed. */
export const DRAFT_NODE_CATALOG: Readonly<Record<string, DraftNodeSpec>> = Object.freeze({
  "n8n-nodes-base.webhook": trigger("Webhook"),
  "n8n-nodes-base.formTrigger": trigger("Form submission"),
  "n8n-nodes-base.scheduleTrigger": trigger("Schedule"),
  "n8n-nodes-base.manualTrigger": trigger("Manual start"),
  "n8n-nodes-base.emailReadImap": trigger("Incoming email (IMAP)", "IMAP account"),
  "n8n-nodes-base.errorTrigger": trigger("When a workflow fails"),
  "n8n-nodes-base.executeWorkflowTrigger": trigger("Called by another workflow"),
  "n8n-nodes-base.slack": action("Slack", "Slack account"),
  "n8n-nodes-base.discord": action("Discord", "Discord account"),
  "n8n-nodes-base.telegram": action("Telegram", "Telegram bot"),
  "n8n-nodes-base.microsoftTeams": action("Microsoft Teams", "Microsoft account"),
  "n8n-nodes-base.gmail": action("Gmail", "Google account"),
  "n8n-nodes-base.emailSend": action("Send email (SMTP)", "SMTP account"),
  "n8n-nodes-base.microsoftOutlook": action("Outlook", "Microsoft account"),
  "n8n-nodes-base.googleSheets": action("Google Sheets", "Google account"),
  "n8n-nodes-base.airtable": action("Airtable", "Airtable account"),
  "n8n-nodes-base.postgres": action("Postgres", "Postgres account"),
  "n8n-nodes-base.mySql": action("MySQL", "MySQL account"),
  "n8n-nodes-base.hubspot": action("HubSpot", "HubSpot account"),
  "n8n-nodes-base.notion": action("Notion", "Notion account"),
  "n8n-nodes-base.googleCalendar": action("Google Calendar", "Google account"),
  "n8n-nodes-base.googleDrive": action("Google Drive", "Google account"),
  "n8n-nodes-base.httpRequest": action("HTTP request", null),
  "n8n-nodes-base.set": logic("Edit fields"),
  "n8n-nodes-base.filter": logic("Filter"),
  "n8n-nodes-base.wait": logic("Wait"),
  "n8n-nodes-base.noOp": logic("No operation"),
  "n8n-nodes-base.if": { label: "If", kind: "logic", inputs: 1, outputs: 2, outputNames: ["true", "false"], credential: null },
});

export function draftNodeSpec(type: string): DraftNodeSpec | null {
  return Object.prototype.hasOwnProperty.call(DRAFT_NODE_CATALOG, type) ? DRAFT_NODE_CATALOG[type]! : null;
}

/** The catalog node that starts a workflow of this kind, when there is exactly one. */
const TRIGGER_NODE_FOR_KIND: Partial<Record<LibraryTriggerKind, string>> = {
  webhook: "n8n-nodes-base.webhook",
  form: "n8n-nodes-base.formTrigger",
  schedule: "n8n-nodes-base.scheduleTrigger",
  manual: "n8n-nodes-base.manualTrigger",
  email: "n8n-nodes-base.emailReadImap",
  error_handler: "n8n-nodes-base.errorTrigger",
  sub_workflow: "n8n-nodes-base.executeWorkflowTrigger",
};

export const DRAFT_LIMITS = {
  nodesMax: 25,
  connectionsMax: 50,
  settingsMax: 10,
  labelMax: 80,
  settingLabelMax: 120,
  valueMax: 300,
  answersMax: 40,
  questionsMax: 12,
} as const;

// ---------------------------------------------------------------------------
// What a draft holds.
// ---------------------------------------------------------------------------

export type DraftKind = "new" | "customization";
export type DraftSettingKind = "value" | "credential" | "in_n8n";

export interface DraftSetting {
  key: string;
  label: string;
  /** value: answered here, in plain words. credential / in_n8n: configured in n8n, never here. */
  kind: DraftSettingKind;
  value: string | null;
}

export interface DraftNode {
  key: string;
  type: string;
  label: string;
  /** added: proposed by the draft. source: the source workflow's node of this type. */
  origin: "added" | "source";
  remove: boolean;
  settings: DraftSetting[];
}

export interface DraftConnection {
  from: string;
  to: string;
  /** The output of `from`: 0 for most nodes; If has 0 (true) and 1 (false). */
  output: number;
}

export interface DraftSource {
  entryId: string;
  versionId: string;
  name: string;
  nodeTypes: string[];
  nodeCount: number | null;
}

export interface DraftContent {
  schemaVersion: 1;
  kind: DraftKind;
  title: string;
  request: {
    goal: string;
    trigger: LibraryTriggerKind | null;
    services: string[];
    integrations: LibraryIntegrationCategory[];
    inputs: string[];
    outcome: string | null;
  };
  source: DraftSource | null;
  questions: Array<{ key: string; question: string; answer: string | null }>;
  /** What the draft could not hold, said plainly. */
  notes: string[];
  nodes: DraftNode[];
  connections: DraftConnection[];
}

export interface DraftIssue {
  code: string;
  /** Where: "nodes[2]", "connections[0]", "answers.slack-1.channel". */
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Text a draft may store: no secret, no expression, no link — refused, not
// rewritten, because a setting must say exactly what the person meant.
// ---------------------------------------------------------------------------

const EXPRESSION = /\{\{|\}\}|\$(?:env|secrets|vars|execution|workflow|json|node|input)\b|^\s*=/i;
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i;

export type DraftTextRefusal = "type" | "empty" | "length" | "secret" | "expression" | "link";

export function draftText(value: unknown, max: number): { ok: true; text: string } | { ok: false; reason: DraftTextRefusal } {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.trim().length === 0) return { ok: false, reason: "empty" };
  if (value.length > max) return { ok: false, reason: "length" };
  if (containsSecret(value)) return { ok: false, reason: "secret" };
  if (EXPRESSION.test(value)) return { ok: false, reason: "expression" };
  if (LINK.test(value)) return { ok: false, reason: "link" };
  return { ok: true, text: sanitizeUntrustedText(value, max).replace(/\s+/g, " ").trim() };
}

const TEXT_MESSAGE: Record<DraftTextRefusal, (what: string, max: number) => string> = {
  type: (what) => `${what} must be text.`,
  empty: (what) => `${what} is empty.`,
  length: (what, max) => `${what} is longer than ${max} characters.`,
  secret: () => PLANNING_SECRET_MESSAGE,
  expression: (what) => `${what} contains an n8n expression. Drafts hold plain words; expressions are written in n8n.`,
  link: (what) => `${what} contains a link. Drafts hold no URLs — mark the setting "in_n8n" and enter it in n8n.`,
};

// ---------------------------------------------------------------------------
// Parsing a proposed graph. Shape errors and unsafe text refuse the whole
// proposal; so do structural errors — an invalid draft is never stored.
// ---------------------------------------------------------------------------

const NODE_KEY = /^[a-z][a-z0-9-]{0,31}$/;
const SETTING_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const NODE_FIELDS = new Set(["key", "type", "label", "source", "remove", "settings"]);
const SETTING_FIELDS = new Set(["key", "label", "kind", "value"]);
const CONNECTION_FIELDS = new Set(["from", "to", "output"]);
const N8N_DEFINITION_FIELDS = new Set(["parameters", "credentials", "typeversion", "position", "webhookid", "pindata", "staticdata", "disabled", "id", "notes"]);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function parseSettings(raw: unknown, path: string, issues: DraftIssue[]): DraftSetting[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > DRAFT_LIMITS.settingsMax) {
    issues.push({ code: "INVALID_SETTINGS", path, message: `Settings must be a list of at most ${DRAFT_LIMITS.settingsMax}.` });
    return [];
  }
  const out: DraftSetting[] = [];
  raw.forEach((item, i) => {
    const at = `${path}[${i}]`;
    if (!isObject(item) || Object.keys(item).some((k) => !SETTING_FIELDS.has(k))) {
      issues.push({ code: "INVALID_SETTING", path: at, message: "A setting has key, label, kind (value, credential or in_n8n) and, for a value, value." });
      return;
    }
    if (typeof item.key !== "string" || !SETTING_KEY.test(item.key) || out.some((s) => s.key === item.key)) {
      issues.push({ code: "INVALID_SETTING_KEY", path: at, message: "A setting key is 1–40 lower-case letters, digits or '_', unique on its node." });
      return;
    }
    const label = draftText(item.label, DRAFT_LIMITS.settingLabelMax);
    if (!label.ok) {
      issues.push({ code: label.reason === "secret" ? "SECRET_REFUSED" : "INVALID_TEXT", path: `${at}.label`, message: TEXT_MESSAGE[label.reason]("A setting's label", DRAFT_LIMITS.settingLabelMax) });
      return;
    }
    const kind = item.kind ?? "value";
    if (kind !== "value" && kind !== "credential" && kind !== "in_n8n") {
      issues.push({ code: "INVALID_SETTING", path: `${at}.kind`, message: "A setting's kind is value, credential or in_n8n." });
      return;
    }
    let value: string | null = null;
    if (item.value !== undefined && item.value !== null) {
      if (kind === "credential") {
        issues.push({ code: "CREDENTIAL_VALUE_REFUSED", path: `${at}.value`, message: "A credential is configured in n8n. JARVIS never accepts or stores its value." });
        return;
      }
      if (kind === "in_n8n") {
        issues.push({ code: "IN_N8N_VALUE_REFUSED", path: `${at}.value`, message: "This setting is left for n8n; it takes no value here." });
        return;
      }
      const text = draftText(item.value, DRAFT_LIMITS.valueMax);
      if (!text.ok) {
        issues.push({ code: text.reason === "secret" ? "SECRET_REFUSED" : "INVALID_TEXT", path: `${at}.value`, message: TEXT_MESSAGE[text.reason]("A setting's value", DRAFT_LIMITS.valueMax) });
        return;
      }
      value = text.text;
    }
    out.push({ key: item.key, label: label.text, kind, value });
  });
  return out;
}

export interface DraftGraphContext {
  kind: DraftKind;
  source: DraftSource | null;
}

/** A proposed graph, parsed and checked — or every issue found. Nothing invalid is ever returned as a graph. */
export function parseDraftGraph(
  input: { nodes: unknown; connections: unknown },
  context: DraftGraphContext
): { ok: true; nodes: DraftNode[]; connections: DraftConnection[] } | { ok: false; issues: DraftIssue[] } {
  const issues: DraftIssue[] = [];
  if (!Array.isArray(input.nodes) || input.nodes.length > DRAFT_LIMITS.nodesMax) {
    return { ok: false, issues: [{ code: "INVALID_NODES", path: "nodes", message: `nodes must be a list of at most ${DRAFT_LIMITS.nodesMax}.` }] };
  }
  if (!Array.isArray(input.connections) || input.connections.length > DRAFT_LIMITS.connectionsMax) {
    return { ok: false, issues: [{ code: "INVALID_CONNECTIONS", path: "connections", message: `connections must be a list of at most ${DRAFT_LIMITS.connectionsMax}.` }] };
  }

  const nodes: DraftNode[] = [];
  const sourceTypes = new Set(context.source?.nodeTypes ?? []);
  input.nodes.forEach((raw, i) => {
    const path = `nodes[${i}]`;
    if (!isObject(raw)) {
      issues.push({ code: "INVALID_NODE", path, message: "A node is an object: key, type, label, source, remove, settings." });
      return;
    }
    const definitionField = Object.keys(raw).find((k) => N8N_DEFINITION_FIELDS.has(k.toLowerCase()));
    if (definitionField) {
      issues.push({
        code: "N8N_FIELD_REFUSED",
        path: `${path}.${definitionField}`,
        message: "Drafts carry no n8n parameters, credentials or definition fields. Describe each thing to configure as a setting instead.",
      });
      return;
    }
    if (Object.keys(raw).some((k) => !NODE_FIELDS.has(k))) {
      issues.push({ code: "INVALID_NODE", path, message: "A node has only key, type, label, source, remove and settings." });
      return;
    }
    if (typeof raw.key !== "string" || !NODE_KEY.test(raw.key)) {
      issues.push({ code: "INVALID_NODE_KEY", path: `${path}.key`, message: "A node key is 1–32 lower-case letters, digits or '-', starting with a letter." });
      return;
    }
    if (nodes.some((n) => n.key === raw.key)) {
      issues.push({ code: "DUPLICATE_NODE", path: `${path}.key`, message: `Two nodes have the key "${raw.key}".` });
      return;
    }
    if (typeof raw.type !== "string" || !LIBRARY_NODE_TYPE_PATTERN.test(raw.type)) {
      issues.push({ code: "UNSUPPORTED_NODE_TYPE", path: `${path}.type`, message: "That is not a node type." });
      return;
    }
    const spec = draftNodeSpec(raw.type);
    if (!spec) {
      issues.push({
        code: "UNSUPPORTED_NODE_TYPE",
        path: `${path}.type`,
        message: `"${raw.type}" is not a node type drafts can hold. Use a supported type, or note the step for building in n8n.`,
      });
      return;
    }
    const fromSource = raw.source === true;
    if (raw.source !== undefined && typeof raw.source !== "boolean") {
      issues.push({ code: "INVALID_NODE", path: `${path}.source`, message: "source is true or false." });
      return;
    }
    if (raw.remove !== undefined && typeof raw.remove !== "boolean") {
      issues.push({ code: "INVALID_NODE", path: `${path}.remove`, message: "remove is true or false." });
      return;
    }
    if (fromSource) {
      if (context.kind !== "customization") {
        issues.push({ code: "SOURCE_REF_IN_NEW", path: `${path}.source`, message: "Only a customization refers to the source workflow's nodes." });
        return;
      }
      if (!sourceTypes.has(raw.type)) {
        issues.push({ code: "NOT_IN_SOURCE", path: `${path}.type`, message: `The source workflow has no ${spec.label} node.` });
        return;
      }
      if (nodes.some((n) => n.origin === "source" && n.type === raw.type)) {
        issues.push({ code: "DUPLICATE_SOURCE_REF", path, message: `The source's ${spec.label} node is referred to twice.` });
        return;
      }
    }
    const remove = raw.remove === true;
    if (remove && !fromSource) {
      issues.push({ code: "REMOVE_NOT_SOURCE", path: `${path}.remove`, message: "Only a node of the source workflow can be removed." });
      return;
    }
    let label = spec.label;
    if (raw.label !== undefined) {
      const text = draftText(raw.label, DRAFT_LIMITS.labelMax);
      if (!text.ok) {
        issues.push({ code: text.reason === "secret" ? "SECRET_REFUSED" : "INVALID_TEXT", path: `${path}.label`, message: TEXT_MESSAGE[text.reason]("A node's label", DRAFT_LIMITS.labelMax) });
        return;
      }
      label = text.text;
    }
    const settings = parseSettings(raw.settings, `${path}.settings`, issues);
    if (remove && settings.length > 0) {
      issues.push({ code: "REMOVED_HAS_SETTINGS", path: `${path}.settings`, message: "A node being removed takes no settings." });
      return;
    }
    // The account a service node needs, as a reference to configure in n8n.
    if (!fromSource && spec.credential && !settings.some((s) => s.kind === "credential")) {
      settings.push({ key: "credential", label: spec.credential, kind: "credential", value: null });
    }
    // A source type that may occur more than once: which node is meant must be said.
    const ambiguous = fromSource && (context.source?.nodeCount == null || context.source.nodeCount > context.source.nodeTypes.length);
    if (ambiguous && !remove && !settings.some((s) => s.key === "which_node")) {
      settings.push({ key: "which_node", label: `Which ${spec.label} node of the source workflow (its name in n8n)?`, kind: "value", value: null });
    }
    nodes.push({ key: raw.key, type: raw.type, label, origin: fromSource ? "source" : "added", remove, settings });
  });

  if (issues.length > 0) return { ok: false, issues };

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const connections: DraftConnection[] = [];
  input.connections.forEach((raw, i) => {
    const path = `connections[${i}]`;
    if (!isObject(raw) || Object.keys(raw).some((k) => !CONNECTION_FIELDS.has(k))) {
      issues.push({ code: "INVALID_CONNECTION", path, message: "A connection is { from, to, output? }, naming two node keys." });
      return;
    }
    const from = typeof raw.from === "string" ? byKey.get(raw.from) : undefined;
    const to = typeof raw.to === "string" ? byKey.get(raw.to) : undefined;
    if (!from || !to) {
      issues.push({ code: "UNKNOWN_NODE", path, message: "A connection names a node the draft does not have." });
      return;
    }
    if (from.key === to.key) {
      issues.push({ code: "SELF_LOOP", path, message: `${from.label} cannot connect to itself.` });
      return;
    }
    if (from.remove || to.remove) {
      issues.push({ code: "CONNECTS_REMOVED", path, message: "A node being removed cannot be connected." });
      return;
    }
    const output = raw.output === undefined ? 0 : raw.output;
    const fromSpec = draftNodeSpec(from.type)!;
    if (typeof output !== "number" || !Number.isInteger(output) || output < 0 || output >= fromSpec.outputs) {
      issues.push({
        code: "INVALID_OUTPUT",
        path: `${path}.output`,
        message: `${from.label} has ${fromSpec.outputs === 1 ? "one output (0)" : `outputs 0 (${fromSpec.outputNames[0]}) and 1 (${fromSpec.outputNames[1]})`}.`,
      });
      return;
    }
    if (draftNodeSpec(to.type)!.inputs === 0) {
      issues.push({ code: "TRIGGER_HAS_INPUT", path, message: `${to.label} starts a workflow; nothing can connect into it.` });
      return;
    }
    if (connections.some((c) => c.from === from.key && c.to === to.key && c.output === output)) {
      issues.push({ code: "DUPLICATE_CONNECTION", path, message: `${from.label} is connected to ${to.label} twice.` });
      return;
    }
    connections.push({ from: from.key, to: to.key, output });
  });
  if (issues.length > 0) return { ok: false, issues };

  // No cycles: a draft's steps run forward.
  const next = new Map<string, string[]>();
  for (const c of connections) next.set(c.from, [...(next.get(c.from) ?? []), c.to]);
  const state = new Map<string, 1 | 2>();
  const cyclic = (key: string): boolean => {
    if (state.get(key) === 1) return true;
    if (state.get(key) === 2) return false;
    state.set(key, 1);
    const found = (next.get(key) ?? []).some(cyclic);
    state.set(key, 2);
    return found;
  };
  if (nodes.some((n) => cyclic(n.key))) {
    return { ok: false, issues: [{ code: "CYCLE", path: "connections", message: "The connections form a loop. Drafts hold steps that run forward." }] };
  }

  // Every added step is reached from a trigger — or, in a customization, from the source workflow.
  const roots = nodes.filter((n) => !n.remove && (draftNodeSpec(n.type)!.kind === "trigger" || n.origin === "source"));
  const reached = new Set<string>();
  const walk = (key: string) => {
    if (reached.has(key)) return;
    reached.add(key);
    for (const to of next.get(key) ?? []) walk(to);
  };
  roots.forEach((r) => walk(r.key));
  nodes.forEach((n, i) => {
    if (!n.remove && !reached.has(n.key)) {
      issues.push({ code: "DISCONNECTED_NODE", path: `nodes[${i}]`, message: `${n.label} is not reached from any trigger. Connect it, or take it out.` });
    }
  });

  // Something must still start the workflow.
  const triggers = nodes.filter((n) => !n.remove && draftNodeSpec(n.type)!.kind === "trigger");
  if (context.kind === "new" && nodes.length > 0 && triggers.length === 0) {
    issues.push({ code: "NO_TRIGGER", path: "nodes", message: "Nothing starts this workflow. Add a trigger." });
  }
  if (context.kind === "customization" && context.source) {
    const sourceTriggers = context.source.nodeTypes.filter((t) => libraryTriggerKind(t) !== null);
    const removed = new Set(nodes.filter((n) => n.remove).map((n) => n.type));
    if (sourceTriggers.length > 0 && sourceTriggers.every((t) => removed.has(t)) && triggers.every((t) => t.origin === "source")) {
      issues.push({ code: "NO_TRIGGER", path: "nodes", message: "Every trigger of the source workflow would be removed, and none is added." });
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, nodes, connections };
}

// ---------------------------------------------------------------------------
// Building a draft's content.
// ---------------------------------------------------------------------------

/** The structure a request implies, and nothing it does not: a trigger and the named apps, in order. */
export function draftSkeleton(request: AutomationRequest, kind: DraftKind, source: DraftSource | null): { nodes: unknown[]; connections: unknown[]; notes: string[] } {
  const notes: string[] = [];
  const nodes: Array<Record<string, unknown>> = [];
  const connections: Array<Record<string, unknown>> = [];

  let head: string | null = null;
  if (kind === "new") {
    const type = request.trigger.kind ? TRIGGER_NODE_FOR_KIND[request.trigger.kind] : undefined;
    if (type) {
      nodes.push({ key: "trigger", type });
      head = "trigger";
    } else if (request.trigger.kind) {
      notes.push("The trigger asked for is not one drafts can hold; choose it in n8n.");
    }
  } else if (source) {
    const usable = source.nodeTypes.filter((t) => libraryTriggerKind(t) !== null && draftNodeSpec(t));
    if (usable.length === 1) {
      nodes.push({ key: "source-trigger", type: usable[0], source: true });
      head = "source-trigger";
    } else {
      notes.push("The source workflow has no single trigger a draft can refer to, so new steps were not attached. Say where they go.");
    }
  }

  const present = new Set(source?.nodeTypes ?? []);
  let previous = head;
  for (const service of request.services) {
    const spec = draftNodeSpec(service.nodeType);
    if (!spec) {
      notes.push(`${service.label} is not a node drafts can hold yet; plan that step in n8n.`);
      continue;
    }
    if (present.has(service.nodeType)) continue;
    if (!previous) continue;
    const key = service.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32);
    if (nodes.some((n) => n.key === key)) continue;
    nodes.push({ key, type: service.nodeType });
    connections.push({ from: previous, to: key });
    previous = key;
  }
  return { nodes, connections, notes };
}

export function draftTitle(request: AutomationRequest, title: string | null): string {
  return (title ?? request.goal).slice(0, PLANNING_LIMITS.titleMax);
}

/** A draft's content from a request and a graph — the graph proposed, or the skeleton. */
export function buildDraftContent(input: {
  kind: DraftKind;
  title: string;
  request: AutomationRequest;
  source: DraftSource | null;
  graph: { nodes: unknown; connections: unknown } | null;
}): { ok: true; content: DraftContent } | { ok: false; issues: DraftIssue[] } {
  const skeleton = input.graph ? null : draftSkeleton(input.request, input.kind, input.source);
  const parsed = parseDraftGraph(input.graph ?? { nodes: skeleton!.nodes, connections: skeleton!.connections }, { kind: input.kind, source: input.source });
  if (!parsed.ok) return parsed;
  const notes = [...input.request.notes, ...(skeleton?.notes ?? [])];
  return {
    ok: true,
    content: {
      schemaVersion: 1,
      kind: input.kind,
      title: input.title,
      request: {
        goal: input.request.goal,
        trigger: input.request.trigger.kind,
        services: input.request.services.map((s) => s.label),
        integrations: input.request.integrations.map((i) => i.category),
        inputs: input.request.inputs,
        outcome: input.request.outcome,
      },
      source: input.source,
      questions: input.request.openQuestions.slice(0, DRAFT_LIMITS.questionsMax).map((q) => ({ key: q.key, question: q.question, answer: null })),
      notes,
      nodes: parsed.nodes,
      connections: parsed.connections,
    },
  };
}

const ANSWER_KEY = /^(?:question|[a-z][a-z0-9-]{0,31})\.[a-z][a-z0-9_]{0,39}$/;

/** Answers applied to a copy of the content: "question.<key>" or "<node key>.<setting key>". */
export function applyDraftAnswers(
  content: DraftContent,
  answers: Record<string, string>
): { ok: true; content: DraftContent } | { ok: false; issues: DraftIssue[] } {
  const next: DraftContent = structuredClone(content);
  const issues: DraftIssue[] = [];
  for (const [key, raw] of Object.entries(answers)) {
    const path = `answers.${key}`;
    const [owner, field] = key.split(".") as [string, string];
    const text = draftText(raw, DRAFT_LIMITS.valueMax);
    if (owner === "question") {
      const question = next.questions.find((q) => q.key === field);
      if (!question) {
        issues.push({ code: "UNKNOWN_ANSWER", path, message: "The draft has no such question." });
        continue;
      }
      if (!text.ok) {
        issues.push({ code: text.reason === "secret" ? "SECRET_REFUSED" : "INVALID_TEXT", path, message: TEXT_MESSAGE[text.reason]("An answer", DRAFT_LIMITS.valueMax) });
        continue;
      }
      question.answer = text.text;
      continue;
    }
    const node = next.nodes.find((n) => n.key === owner);
    const setting = node?.settings.find((s) => s.key === field);
    if (!node || node.remove || !setting) {
      issues.push({ code: "UNKNOWN_ANSWER", path, message: "The draft has no such setting." });
      continue;
    }
    if (setting.kind === "credential") {
      issues.push({ code: "CREDENTIAL_VALUE_REFUSED", path, message: "A credential is configured in n8n. JARVIS never accepts or stores its value." });
      continue;
    }
    if (setting.kind === "in_n8n") {
      issues.push({ code: "IN_N8N_VALUE_REFUSED", path, message: "This setting is left for n8n; it takes no value here." });
      continue;
    }
    if (!text.ok) {
      issues.push({ code: text.reason === "secret" ? "SECRET_REFUSED" : "INVALID_TEXT", path, message: TEXT_MESSAGE[text.reason]("An answer", DRAFT_LIMITS.valueMax) });
      continue;
    }
    setting.value = text.text;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, content: next };
}

/** The content's identity: SHA-256 of its canonical form. */
export function draftContentHash(content: DraftContent): string {
  return createHash("sha256").update(`automation-draft:v1:${canonicalizeForHash(content)}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Checks, requirements and status.
// ---------------------------------------------------------------------------

export type DraftCheckId =
  | "node_types"
  | "graph"
  | "triggers"
  | "safety"
  | "credentials"
  | "requirements"
  | "configuration_schema"
  | "source_graph"
  | "source_version"
  | "scope";

export interface DraftCheck {
  id: DraftCheckId;
  status: "passed" | "failed" | "pending" | "not_run";
  message: string;
}

export type DraftStatus = "invalid" | "stale" | "needs_input" | "unverified" | "validated";

export interface DraftRequirement {
  kind: "question" | "setting" | "credential" | "in_n8n" | "structure";
  /** The answer key for a question or a setting. */
  key: string | null;
  label: string;
  state: "answered" | "needs_input" | "configure_in_n8n";
  nodeKey: string | null;
}

export const DRAFT_CHECK_MESSAGES = {
  configurationSchema: NODE_SCHEMA_MESSAGES.unavailable,
  sourceGraph:
    "Not run: the catalog holds the source workflow's node types, not its connections or parameters, so the effect on its existing paths cannot be checked.",
} as const;

/** The structure a draft still needs before its steps are complete. */
function structureNeeds(content: DraftContent): string[] {
  const out: string[] = [];
  const live = content.nodes.filter((n) => !n.remove);
  if (content.kind === "new") {
    if (live.length === 0) out.push("Add a trigger and at least one step.");
    else if (live.every((n) => draftNodeSpec(n.type)?.kind === "trigger")) out.push("Add at least one step after the trigger.");
  } else {
    const changed =
      content.nodes.some((n) => n.origin === "added" || n.remove || n.settings.some((s) => s.key !== "which_node")) || content.connections.length > 0;
    if (!changed) out.push("No change to the source workflow is proposed yet.");
  }
  return out;
}

export function draftRequirements(content: DraftContent): DraftRequirement[] {
  const out: DraftRequirement[] = [];
  for (const q of content.questions) {
    out.push({ kind: "question", key: `question.${q.key}`, label: q.question, state: q.answer ? "answered" : "needs_input", nodeKey: null });
  }
  for (const n of content.nodes) {
    if (n.remove) continue;
    for (const s of n.settings) {
      out.push({
        kind: s.kind === "value" ? "setting" : s.kind,
        key: s.kind === "value" ? `${n.key}.${s.key}` : null,
        label: `${n.label}: ${s.label}`,
        state: s.kind === "value" ? (s.value ? "answered" : "needs_input") : "configure_in_n8n",
        nodeKey: n.key,
      });
    }
  }
  for (const need of structureNeeds(content)) out.push({ kind: "structure", key: null, label: need, state: "needs_input", nodeKey: null });
  return out;
}

export interface DraftLiveFacts {
  /** The source entry as the catalog holds it now; null when it is no longer there. Omit for a new draft. */
  source?: { versionId: string | null; presence: LibraryEntryPresence } | null;
  /** True when the draft was read inside the caller's own organization and instance. */
  scopeVerified?: boolean;
}

/**
 * Every check, its result, and the status they add up to. A check that did not
 * run is said, never passed.
 *
 * `schema` is the trusted n8n node-schema snapshot, when the server has one.
 * Without it the configuration check does not run at all; with it, the
 * settings that name a parameter are checked against n8n's own schemas
 * (Stage 18.5).
 */
export function evaluateDraft(
  content: DraftContent,
  live: DraftLiveFacts = {},
  schema?: NodeSchemaRegistry | null
): { status: DraftStatus; checks: DraftCheck[]; requirements: DraftRequirement[] } {
  const checks: DraftCheck[] = [];
  const add = (id: DraftCheckId, status: DraftCheck["status"], message: string) => checks.push({ id, status, message });

  // The structural checks are the parser's; content that exists passed them. Re-run them, so a
  // check is never taken on trust from a stored row.
  const reparsed = parseDraftGraph(
    {
      nodes: content.nodes.map((n) => ({
        key: n.key,
        type: n.type,
        label: n.label,
        ...(n.origin === "source" ? { source: true } : {}),
        ...(n.remove ? { remove: true } : {}),
        settings: n.settings.map((s) => ({ key: s.key, label: s.label, kind: s.kind, ...(s.value !== null ? { value: s.value } : {}) })),
      })),
      connections: content.connections,
    },
    { kind: content.kind, source: content.source }
  );
  const failed = reparsed.ok ? [] : reparsed.issues;
  const failedBy = (codes: string[]) => failed.filter((i) => codes.includes(i.code));
  const typeIssues = failedBy(["UNSUPPORTED_NODE_TYPE", "NOT_IN_SOURCE", "SOURCE_REF_IN_NEW", "N8N_FIELD_REFUSED"]);
  const triggerIssues = failedBy(["NO_TRIGGER", "TRIGGER_HAS_INPUT"]);
  const safetyIssues = failedBy(["SECRET_REFUSED", "INVALID_TEXT", "CREDENTIAL_VALUE_REFUSED", "IN_N8N_VALUE_REFUSED"]);
  const graphIssues = failed.filter((i) => !typeIssues.includes(i) && !triggerIssues.includes(i) && !safetyIssues.includes(i));

  add("node_types", typeIssues.length ? "failed" : "passed", typeIssues[0]?.message ?? "Every node is a supported n8n node type.");
  add(
    "graph",
    graphIssues.length ? "failed" : "passed",
    graphIssues[0]?.message ?? "Node keys are unique, connections name existing nodes and valid outputs, nothing loops, and every step is reached."
  );
  add("triggers", triggerIssues.length ? "failed" : "passed", triggerIssues[0]?.message ?? "Triggers have no incoming connections, and something starts the workflow.");
  add("safety", safetyIssues.length ? "failed" : "passed", safetyIssues[0]?.message ?? "No secret, n8n expression or link is stored in the draft.");

  const credentials = content.nodes.filter((n) => !n.remove).flatMap((n) => n.settings.filter((s) => s.kind === "credential"));
  add(
    "credentials",
    credentials.some((s) => s.value !== null) ? "failed" : "passed",
    credentials.length === 0
      ? "No credential is needed by the proposed steps."
      : `${credentials.length} credential${credentials.length === 1 ? "" : "s"} to configure in n8n; none is stored here.`
  );

  const requirements = draftRequirements(content);
  const open = requirements.filter((r) => r.state === "needs_input");
  add("requirements", open.length ? "pending" : "passed", open.length ? `${open.length} item${open.length === 1 ? "" : "s"} still need${open.length === 1 ? "s" : ""} an answer.` : "Every question and setting has an answer.");

  // The configuration check (Stage 18.5). It runs only when the server holds
  // the trusted n8n node schemas; a setting that names a parameter is checked
  // against it, and a check that could not run completely is said, never passed.
  const configuration = checkDraftConfiguration(content, schema ?? null);
  add("configuration_schema", configuration.status, configuration.message);

  if (content.kind === "customization") {
    add("source_graph", "not_run", DRAFT_CHECK_MESSAGES.sourceGraph);
    if (live.source === undefined) add("source_version", "not_run", "The source workflow's current version was not read.");
    else if (live.source === null) add("source_version", "failed", "The source workflow is no longer in the library.");
    else if (live.source.presence !== "present") add("source_version", "failed", "The source workflow was not seen in the last complete scan.");
    else if (live.source.versionId !== content.source?.versionId) {
      add("source_version", "failed", "The source workflow changed in n8n since this draft was made. Start a new draft from its current version.");
    } else add("source_version", "passed", "The source workflow is at the version this draft was made from.");
  }

  add(
    "scope",
    live.scopeVerified ? "passed" : "not_run",
    live.scopeVerified ? "Read inside your organization's catalog of the configured n8n instance." : "The draft's organization was not checked."
  );

  const anyFailed = checks.filter((c) => c.status === "failed");
  const status: DraftStatus = anyFailed.length
    ? anyFailed.every((c) => c.id === "source_version")
      ? "stale"
      : "invalid"
    : checks.some((c) => c.status === "pending")
      ? "needs_input"
      : checks.some((c) => c.status === "not_run")
        ? "unverified"
        : "validated";
  return { status, checks, requirements };
}

// ---------------------------------------------------------------------------
// What a draft changes.
// ---------------------------------------------------------------------------

export interface DraftDiff {
  nodesAdded: Array<{ key: string; type: string; label: string; kind: DraftNodeKind }>;
  nodesRemoved: Array<{ key: string; type: string; label: string }>;
  connectionsAdded: Array<{ from: string; fromLabel: string; to: string; toLabel: string; output: number; outputName: string | null }>;
  triggersAdded: Array<{ key: string; label: string }>;
  triggersRemoved: Array<{ key: string; label: string }>;
  configurationChanges: Array<{ nodeKey: string; nodeLabel: string; origin: "added" | "source"; setting: string; kind: DraftSettingKind; state: DraftRequirement["state"] }>;
  /** Source node types the draft does not touch. Their configuration and connections are unknown here. */
  untouchedSourceTypes: string[];
}

/** The proposed change, against the source workflow (a customization) or against nothing (a new workflow). */
export function draftDiff(content: DraftContent): DraftDiff {
  const kindOf = (type: string) => draftNodeSpec(type)?.kind ?? "action";
  const byKey = new Map(content.nodes.map((n) => [n.key, n]));
  const touched = new Set(content.nodes.filter((n) => n.origin === "source").map((n) => n.type));
  return {
    nodesAdded: content.nodes.filter((n) => n.origin === "added").map((n) => ({ key: n.key, type: n.type, label: n.label, kind: kindOf(n.type) })),
    nodesRemoved: content.nodes.filter((n) => n.remove).map((n) => ({ key: n.key, type: n.type, label: n.label })),
    connectionsAdded: content.connections.map((c) => {
      const from = byKey.get(c.from)!;
      const spec = draftNodeSpec(from.type);
      return {
        from: c.from,
        fromLabel: from.label,
        to: c.to,
        toLabel: byKey.get(c.to)!.label,
        output: c.output,
        outputName: spec && spec.outputs > 1 ? spec.outputNames[c.output] ?? null : null,
      };
    }),
    triggersAdded: content.nodes.filter((n) => n.origin === "added" && kindOf(n.type) === "trigger").map((n) => ({ key: n.key, label: n.label })),
    triggersRemoved: content.nodes.filter((n) => n.remove && kindOf(n.type) === "trigger").map((n) => ({ key: n.key, label: n.label })),
    configurationChanges: content.nodes
      .filter((n) => !n.remove)
      .flatMap((n) =>
        n.settings.map((s) => ({
          nodeKey: n.key,
          nodeLabel: n.label,
          origin: n.origin,
          setting: s.label,
          kind: s.kind,
          state: (s.kind === "value" ? (s.value ? "answered" : "needs_input") : "configure_in_n8n") as DraftRequirement["state"],
        }))
      ),
    untouchedSourceTypes: (content.source?.nodeTypes ?? []).filter((t) => !touched.has(t)),
  };
}

// ---------------------------------------------------------------------------
// Requests: the same rules for the page and the tools.
// ---------------------------------------------------------------------------

const DRAFT_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const isDraftId = (value: unknown): value is string => typeof value === "string" && DRAFT_ID.test(value);

export const DRAFT_CREATE_FIELDS = ["kind", "sourceEntryId", "title", "nodes", "connections", "overrideReuse"] as const;

export const DRAFT_INVALID_CREATE_MESSAGE =
  "A draft needs goal and kind (new or customization; a customization also needs sourceEntryId). Optional: the request's other fields, title, " +
  "nodes and connections (together), and overrideReuse (true to draft a new workflow although one in the library appears to cover the request).";

export const DRAFT_INVALID_REVISE_MESSAGE =
  `A revision needs baseVersion (the version it changes) and nodes with connections, or answers (up to ${DRAFT_LIMITS.answersMax}: "question.<key>" or "<node key>.<setting key>" → text).`;

export interface DraftCreateRequest {
  request: AutomationRequest;
  kind: DraftKind;
  sourceEntryId: string | null;
  title: string | null;
  graph: { nodes: unknown; connections: unknown } | null;
  overrideReuse: boolean;
}

export function validateDraftCreateInput(input: unknown): { ok: true; value: DraftCreateRequest } | PlanningRefusal {
  if (!isObject(input)) return { ok: false, code: "INVALID_REQUEST", message: DRAFT_INVALID_CREATE_MESSAGE };
  const requestFields: Record<string, unknown> = {};
  for (const key of PLANNING_REQUEST_FIELDS) if (input[key] !== undefined) requestFields[key] = input[key];
  for (const key of Object.keys(input)) {
    if (!(PLANNING_REQUEST_FIELDS as readonly string[]).includes(key) && !(DRAFT_CREATE_FIELDS as readonly string[]).includes(key)) {
      requestFields[key] = input[key]; // reaches the request check, which refuses it in its own words
    }
  }
  const request = validateAutomationRequest(requestFields);
  if (!request.ok) return request.code === "INVALID_REQUEST" ? { ok: false, code: "INVALID_REQUEST", message: DRAFT_INVALID_CREATE_MESSAGE } : request;

  if (input.kind !== "new" && input.kind !== "customization") return { ok: false, code: "INVALID_REQUEST", message: DRAFT_INVALID_CREATE_MESSAGE };
  if (input.kind === "customization" ? !isLibraryEntryId(input.sourceEntryId) : input.sourceEntryId !== undefined) {
    return { ok: false, code: "INVALID_REQUEST", message: DRAFT_INVALID_CREATE_MESSAGE };
  }
  if ((input.nodes === undefined) !== (input.connections === undefined)) return { ok: false, code: "INVALID_REQUEST", message: DRAFT_INVALID_CREATE_MESSAGE };
  if (input.overrideReuse !== undefined && typeof input.overrideReuse !== "boolean") return { ok: false, code: "INVALID_REQUEST", message: DRAFT_INVALID_CREATE_MESSAGE };
  let title: string | null = null;
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || input.title.length > PLANNING_LIMITS.titleMax) return { ok: false, code: "INVALID_REQUEST", message: DRAFT_INVALID_CREATE_MESSAGE };
    const text = planningText(input.title, PLANNING_LIMITS.titleMax);
    if (!text.ok) return { ok: false, code: "SECRET_REFUSED", message: PLANNING_SECRET_MESSAGE };
    title = text.text || null;
  }
  return {
    ok: true,
    value: {
      request: request.value,
      kind: input.kind,
      sourceEntryId: input.kind === "customization" ? (input.sourceEntryId as string) : null,
      title,
      graph: input.nodes !== undefined ? { nodes: input.nodes, connections: input.connections } : null,
      overrideReuse: input.overrideReuse === true,
    },
  };
}

export interface DraftReviseRequest {
  baseVersion: number;
  graph: { nodes: unknown; connections: unknown } | null;
  answers: Record<string, string> | null;
}

export function validateDraftReviseInput(input: unknown): { ok: true; value: DraftReviseRequest } | PlanningRefusal {
  const bad: PlanningRefusal = { ok: false, code: "INVALID_REQUEST", message: DRAFT_INVALID_REVISE_MESSAGE };
  if (!isObject(input)) return bad;
  if (Object.keys(input).some((k) => !["baseVersion", "nodes", "connections", "answers"].includes(k))) {
    return Object.keys(input).some((k) => ["tenantId", "organizationId", "userId", "instanceKey", "version", "contentHash", "status"].includes(k))
      ? { ok: false, code: "REQUEST_SCOPE_REFUSED", message: "A revision cannot set its organization, its version number, its hash or its status; the server does." }
      : bad;
  }
  const base = typeof input.baseVersion === "string" && /^\d{1,6}$/.test(input.baseVersion) ? Number(input.baseVersion) : input.baseVersion;
  if (typeof base !== "number" || !Number.isInteger(base) || base < 1) return bad;
  if ((input.nodes === undefined) !== (input.connections === undefined)) return bad;
  let answers: Record<string, string> | null = null;
  if (input.answers !== undefined) {
    if (!isObject(input.answers)) return bad;
    const entries = Object.entries(input.answers);
    if (entries.length === 0 || entries.length > DRAFT_LIMITS.answersMax) return bad;
    if (!entries.every(([k, v]) => ANSWER_KEY.test(k) && typeof v === "string" && v.length <= DRAFT_LIMITS.valueMax)) return bad;
    answers = Object.fromEntries(entries) as Record<string, string>;
  }
  const graph = input.nodes !== undefined ? { nodes: input.nodes, connections: input.connections } : null;
  if (!graph && !answers) return bad;
  return { ok: true, value: { baseVersion: base, graph, answers } };
}

// ---------------------------------------------------------------------------
// The store, and what every surface is shown.
// ---------------------------------------------------------------------------

export interface DraftRecord {
  draftId: string;
  kind: DraftKind;
  title: string;
  sourceEntryId: string | null;
  sourceVersionId: string | null;
  latestVersion: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface DraftVersionRecord {
  draftId: string;
  version: number;
  content: DraftContent;
  contentHash: string;
  /** The status when it was saved; a view recomputes it. */
  status: DraftStatus;
  createdById: string;
  createdAt: string;
}

/**
 * The database side. Every read and write is scoped to one catalog (the
 * Organization and the instance). There is no update of a version: a
 * revision appends one, taken only while `expectedVersion` is still the
 * latest — ONE conditional UPDATE, so of two revisions of the same version
 * exactly one is stored.
 */
export interface AutomationDraftStore {
  /** A new draft and its version 1 — or, for a createKey already used in this scope by this person, the draft it made. */
  createDraft(
    scope: import("./automation-library.js").LibraryScope,
    input: {
      createdById: string;
      kind: DraftKind;
      title: string;
      sourceEntryId: string | null;
      sourceVersionId: string | null;
      createKey: string;
      content: DraftContent;
      contentHash: string;
      status: DraftStatus;
    }
  ): Promise<{ created: boolean; draft: DraftRecord }>;
  appendVersion(
    scope: import("./automation-library.js").LibraryScope,
    input: { draftId: string; expectedVersion: number; createdById: string; content: DraftContent; contentHash: string; status: DraftStatus }
  ): Promise<{ ok: true; version: DraftVersionRecord } | { ok: false; reason: "not_found" | "conflict" }>;
  findDraft(scope: import("./automation-library.js").LibraryScope, draftId: string): Promise<DraftRecord | null>;
  findVersion(scope: import("./automation-library.js").LibraryScope, draftId: string, version: number): Promise<DraftVersionRecord | null>;
  listVersions(scope: import("./automation-library.js").LibraryScope, draftId: string): Promise<Array<Omit<DraftVersionRecord, "content">>>;
  listDrafts(scope: import("./automation-library.js").LibraryScope, query: { page: number; limit: number }): Promise<{ items: DraftRecord[]; total: number }>;
}

export interface DraftView {
  draftId: string;
  kind: DraftKind;
  title: string;
  createdAt: string;
  latestVersion: number;
  version: { number: number; contentHash: string; createdAt: string; isLatest: boolean; statusWhenSaved: DraftStatus };
  /** Now: the source's drift is read again. */
  status: DraftStatus;
  content: DraftContent;
  diff: DraftDiff;
  checks: DraftCheck[];
  requirements: DraftRequirement[];
  /**
   * What JARVIS knows about each node's parameters, so a setting can name one.
   * Bounded, and never the whole schema (Stage 18.5).
   */
  schema?: DraftSchemaHint[];
  source: {
    entryId: string;
    versionId: string;
    name: string;
    currentVersionId: string | null;
    drift: "none" | "changed" | "missing" | "removed" | "not_found";
  } | null;
  history: Array<{ version: number; contentHash: string; status: DraftStatus; createdAt: string }>;
  /** Whether this reader may revise it, as the server decides it. A revision is checked again. */
  canRevise: boolean;
}

export interface DraftListPage {
  items: Array<Pick<DraftRecord, "draftId" | "kind" | "title" | "latestVersion" | "sourceEntryId" | "updatedAt">>;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PlanningMatchView extends PlanningMatch {
  /** Whether this reader may start a draft, as the server decides it. */
  canDraft: boolean;
}

export type PlanningResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string; issues?: DraftIssue[] };

/** One port, every surface: the Automations page's router and the planning tools are handed the same instance. */
export interface AutomationPlanningPort {
  match(userId: string, input: unknown, options?: { via?: "api" | "jarvis" }): Promise<PlanningResult<PlanningMatchView>>;
  createDraft(userId: string, input: unknown, options?: { via?: "api" | "jarvis" }): Promise<PlanningResult<{ draft: DraftView; existing: boolean }>>;
  reviseDraft(userId: string, draftId: string, input: unknown, options?: { via?: "api" | "jarvis" }): Promise<PlanningResult<{ draft: DraftView; unchanged: boolean }>>;
  getDraft(userId: string, draftId: string, version?: number): Promise<PlanningResult<DraftView>>;
  listDrafts(userId: string, query: { page: number; limit: number }): Promise<PlanningResult<DraftListPage>>;
}
