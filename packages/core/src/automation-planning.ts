// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — from an automation request to catalog candidates.
//
// WHAT THIS IS. Pure rules, shared by the Automations page and the JARVIS
// tools: the request's fields, the words they are read from, and the ranking
// of catalog entries against them. The entries come from the existing
// Automation Library store and its search; nothing here reads anything.
//
// WHAT IT CAN SEE. Each entry is first reduced by `inspectLibraryEntry` (Stage
// 18.3B), so a candidate is judged on exactly what the inspection shows: its
// trigger and app node types, the categories they belong to, its name, its
// version and whether the last complete scan saw it. Tags are compared as
// words and never echoed. A workflow's node parameters were never stored, so
// nothing here can say what a node is configured to do — and no sentence
// claims it.
//
// EXPLAINABLE, NOT CLEVER. Four criteria, each with a status the reader can
// check against the inspection: trigger, apps, shared words, metadata. The
// words quoted in an explanation are the requester's own. When the evidence
// is not enough to judge, the answer says so ("insufficient_evidence"); when
// nothing fits, it says that ("no_match"). It never ranks by guesswork.
// ---------------------------------------------------------------------------

import {
  inspectLibraryEntry,
  libraryIntegrationCategory,
  stripLinks,
  withoutLinks,
  type LibraryIntegrationCategory,
  type LibraryTriggerKind,
} from "./automation-inspection.js";
import { namesLibraryServerScope, type LibraryEntryPresence, type LibraryEntryRecord } from "./automation-library.js";
import { CATEGORY_LABEL, LIBRARY_INTEGRATION_CATEGORIES, LIBRARY_TRIGGER_KINDS, TRIGGER_LABEL } from "./automation-vocabulary.js";
import { sanitizeUntrustedText } from "./evidence-builder.js";
import { containsSecret } from "./utils/redact-secrets.js";

/** The registry ids of the planning tools. None of them reaches n8n. */
export const AUTOMATION_PLANNING_TOOL_IDS = {
  /** Read-only: rank the catalog against a request. */
  match: "automation.workflow.match",
  /** A new draft in JARVIS's own store. Nothing in n8n changes. */
  draftCreate: "automation.draft.create",
  /** A new, immutable version of a draft. Earlier versions never change. */
  draftRevise: "automation.draft.revise",
  draftGet: "automation.draft.get",
  draftList: "automation.draft.list",
} as const;

export const PLANNING_LIMITS = {
  goalMax: 500,
  outcomeMax: 300,
  titleMax: 120,
  inputsMax: 10,
  inputMax: 60,
  servicesMax: 8,
  integrationsMax: 8,
  termsMax: 12,
  candidatesMax: 5,
  /** A catalog this size or smaller is compared in full. */
  fullScanMax: 500,
  /** A larger one is searched by the request's own words, this many searches… */
  targetedSearchesMax: 6,
  /** …of at most this many entries each. */
  targetedPerSearch: 100,
} as const;

// ---------------------------------------------------------------------------
// The vocabulary. Each named service is a node of n8n's base package that the
// Stage 18.3B tables already classify; each word list is plain English (and a
// few common spellings). Matching is by whole word, case-insensitive.
// ---------------------------------------------------------------------------

/** [pattern, n8n base node name, label]. */
const SERVICES: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\bslack\b/i, "slack", "Slack"],
  [/\bdiscord\b/i, "discord", "Discord"],
  [/\btelegram\b/i, "telegram", "Telegram"],
  [/\bmattermost\b/i, "mattermost", "Mattermost"],
  [/\b(?:ms|microsoft)\s*teams\b/i, "microsoftTeams", "Microsoft Teams"],
  [/\bwhats\s?app\b/i, "whatsApp", "WhatsApp"],
  [/\btwilio\b/i, "twilio", "Twilio"],
  [/\bgmail\b/i, "gmail", "Gmail"],
  [/\boutlook\b/i, "microsoftOutlook", "Outlook"],
  [/\bsend\s?grid\b/i, "sendGrid", "SendGrid"],
  [/\bmailgun\b/i, "mailgun", "Mailgun"],
  [/\bmailchimp\b/i, "mailchimp", "Mailchimp"],
  [/\bgoogle\s*sheets?\b|\bgsheets?\b/i, "googleSheets", "Google Sheets"],
  [/\bexcel\b/i, "microsoftExcel", "Excel"],
  [/\bairtable\b/i, "airtable", "Airtable"],
  [/\bpostgres(?:ql)?\b/i, "postgres", "Postgres"],
  [/\bmysql\b/i, "mySql", "MySQL"],
  [/\bmongo(?:db)?\b/i, "mongoDb", "MongoDB"],
  [/\bredis\b/i, "redis", "Redis"],
  [/\bsupabase\b/i, "supabase", "Supabase"],
  [/\bhubspot\b/i, "hubspot", "HubSpot"],
  [/\bsalesforce\b/i, "salesforce", "Salesforce"],
  [/\bpipedrive\b/i, "pipedrive", "Pipedrive"],
  [/\bgoogle\s*drive\b/i, "googleDrive", "Google Drive"],
  [/\bdropbox\b/i, "dropbox", "Dropbox"],
  [/\bgoogle\s*calendar\b/i, "googleCalendar", "Google Calendar"],
  [/\bopen\s?ai\b|\bchat\s?gpt\b/i, "openAi", "OpenAI"],
  [/\bhttp\s+request\b|\brest\s+api\b|\bapi\s+call\b/i, "httpRequest", "HTTP request"],
  [/\bstripe\b/i, "stripe", "Stripe"],
  [/\bpaypal\b/i, "payPal", "PayPal"],
  [/\bjira\b/i, "jira", "Jira"],
  [/\btrello\b/i, "trello", "Trello"],
  [/\basana\b/i, "asana", "Asana"],
  [/\bnotion\b/i, "notion", "Notion"],
  [/\bclick\s?up\b/i, "clickUp", "ClickUp"],
  [/\bgithub\b/i, "github", "GitHub"],
  [/\blinked\s?in\b/i, "linkedIn", "LinkedIn"],
];

const CATEGORY_WORDS: ReadonlyArray<readonly [RegExp, LibraryIntegrationCategory]> = [
  [/\b(?:messages?|notify|notifications?|dms?)\b/i, "messaging"],
  [/\b(?:e-?mails?|inbox)\b/i, "email"],
  [/\b(?:spreadsheets?|sheets?)\b/i, "spreadsheet"],
  [/\b(?:database|db|sql)\b/i, "database"],
  [/\bcrm\b/i, "crm"],
  [/\b(?:files?|uploads?|folders?|storage)\b/i, "storage"],
  [/\b(?:calendar|meetings?|appointments?)\b/i, "calendar"],
  [/\b(?:ai|llm|summari[sz]e|classify)\b/i, "ai"],
  [/\b(?:payments?|refunds?)\b/i, "payments"],
  [/\b(?:tickets?|issues?)\b/i, "project_management"],
];

const TRIGGER_WORDS: ReadonlyArray<readonly [RegExp, LibraryTriggerKind]> = [
  [/\bwebhooks?\b/i, "webhook"],
  [/\bforms?\s+(?:is\s+|are\s+|gets?\s+)?(?:submitted|filled)|\bform\s+submissions?\b|\b(?:fills|submits)\s+(?:in\s+|out\s+)?(?:a|the|our)\s+form\b/i, "form"],
  [
    /\bevery\s+(?:day|morning|evening|night|hour|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+\s*(?:minutes?|hours?|days?))\b|\b(?:daily|hourly|weekly|monthly|nightly)\b|\bon\s+a\s+schedule\b|\bscheduled?\b|\bcron\b/i,
    "schedule",
  ],
  [/\b(?:incoming|new)\s+e-?mails?\b|\be-?mails?\s+(?:arrives?|comes?\s+in|is\s+received|lands?)\b/i, "email"],
  [/\bmanually\b|\bon\s+demand\b|\bwhen\s+i\s+(?:click|press|run\s+it)\b/i, "manual"],
  [/\bchat\s?bot\b|\bchat\s+messages?\b/i, "chat"],
  [/\bsub-?workflow\b|\bcalled\s+by\s+another\s+workflow\b/i, "sub_workflow"],
  [/\bwhen\s+(?:a|any)\s+workflow\s+fails\b|\bon\s+workflow\s+(?:error|failure)\b/i, "error_handler"],
];

const STOPWORDS = new Set(
  (
    "the and for with when whenever that this from into then each every new will should want need please send make create " +
    "workflow workflows automation automate automatically using use via our your their them they its are was has have been " +
    "get set add post all any some can could would let also after before about onto there where which what who how " +
    "jarvis n8n flow one two does doing done just like than only out over per run runs into within without " +
    "jab bhi karo kar mein hai hain aur jaise wala wali"
  ).split(/\s+/)
);

/**
 * Words that only name a trigger or an app. The trigger and app criteria
 * already count those; as shared words they would count them twice and say
 * nothing about the PURPOSE ("a support form" and "a lead form" share "form").
 */
const STRUCTURAL = new Set(
  (
    "form forms submitted submit submits submission submissions filled webhook webhooks schedule scheduled cron daily hourly " +
    "weekly monthly nightly hour day week month morning evening night email emails mail inbox incoming message messages notify " +
    "notification notifications sheet sheets spreadsheet spreadsheets row rows database file files upload uploads folder storage " +
    "calendar meeting meetings ticket tickets issue issues chat chatbot manual manually trigger triggers http request api call " +
    "google microsoft"
  ).split(/\s+/)
);
for (const [, name, label] of SERVICES) {
  for (const word of `${name.replace(/([a-z])([A-Z])/g, "$1 $2")} ${label}`.toLowerCase().split(/[^a-z0-9]+/)) if (word.length >= 3) STRUCTURAL.add(word);
}

const PLURAL = /^(.{4,}[^s])s$/;

function terms(text: string, max: number, skipStructural = false): string[] {
  const out: string[] = [];
  for (const raw of text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    if (skipStructural && (STRUCTURAL.has(raw) || STRUCTURAL.has(raw.replace(PLURAL, "$1")))) continue;
    const term = raw.replace(PLURAL, "$1");
    if (!out.includes(term)) out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

/** A base node name's full type: "slack" → "n8n-nodes-base.slack". */
const baseType = (name: string) => `n8n-nodes-base.${name}`;

/** The service a name or phrase refers to, from the reviewed list — or null. */
export function planningService(text: string): { name: string; nodeType: string; label: string } | null {
  for (const [pattern, name, label] of SERVICES) {
    if (pattern.test(text) || text.trim().toLowerCase() === name.toLowerCase() || text.trim() === baseType(name)) {
      return { name, nodeType: baseType(name), label };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text a request may carry. Links and n8n expressions are taken out; text
// shaped like a secret refuses the whole request — it is never stored, even
// redacted.
// ---------------------------------------------------------------------------

const EXPRESSION = /\{\{[\s\S]*?\}\}|\$(?:env|secrets|vars|execution|workflow|json|node|input)\b/gi;

export const PLANNING_SECRET_MESSAGE =
  "That text looks like it contains a secret — a token, key or password. Remove it: credentials are configured in n8n, never in JARVIS.";

/** Free text for a goal, an outcome, a title or an input name: cleaned, or refused when it carries a secret. */
export function planningText(value: string, max: number): { ok: true; text: string } | { ok: false } {
  if (containsSecret(value)) return { ok: false };
  const text = stripLinks(sanitizeUntrustedText(value, max * 2))
    .replace(EXPRESSION, "[expression removed]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// The request.
// ---------------------------------------------------------------------------

export interface AutomationRequest {
  goal: string;
  /** The goal's own PURPOSE words (not the trigger's or an app's name), for comparing with names — quoted back only as the requester's. */
  terms: string[];
  trigger: { kind: LibraryTriggerKind | null; source: "stated" | "from_goal" | "unknown" };
  services: Array<{ name: string; nodeType: string; label: string; category: LibraryIntegrationCategory | null; source: "stated" | "from_goal" }>;
  /** Categories asked for that no named service already covers. */
  integrations: Array<{ category: LibraryIntegrationCategory; source: "stated" | "from_goal" }>;
  inputs: string[];
  outcome: string | null;
  /** What was read, said plainly: a conflict, an unrecognized service. */
  notes: string[];
  /** What the request leaves open, as questions. */
  openQuestions: Array<{ key: string; question: string }>;
}

export const PLANNING_REQUEST_FIELDS = ["goal", "trigger", "integrations", "services", "inputs", "outcome"] as const;

export const PLANNING_INVALID_REQUEST_MESSAGE =
  `Describe the automation in goal (1 to ${PLANNING_LIMITS.goalMax} characters). Optional: trigger (${LIBRARY_TRIGGER_KINDS.join(", ")}), ` +
  `integrations (up to ${PLANNING_LIMITS.integrationsMax} of ${LIBRARY_INTEGRATION_CATEGORIES.join(", ")}), services (up to ${PLANNING_LIMITS.servicesMax} app names), ` +
  `inputs (up to ${PLANNING_LIMITS.inputsMax} names) and outcome (up to ${PLANNING_LIMITS.outcomeMax} characters).`;

export type PlanningRefusal = { ok: false; code: string; message: string };

const refusal = (code: string, message: string): PlanningRefusal => ({ ok: false, code, message });

function stringList(value: unknown, max: number, itemMax: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((v) => typeof v === "string" && v.trim().length > 0 && v.length <= itemMax)) return null;
  return value as string[];
}

/**
 * A request, validated and read — or a refusal. Takes only the request's own
 * fields: a scope field refuses it, as everywhere in the library.
 */
export function validateAutomationRequest(input: unknown, extraAllowed: readonly string[] = []): { ok: true; value: AutomationRequest } | PlanningRefusal {
  if (!input || typeof input !== "object" || Array.isArray(input)) return refusal("INVALID_REQUEST", PLANNING_INVALID_REQUEST_MESSAGE);
  if (namesLibraryServerScope(input)) {
    return refusal("REQUEST_SCOPE_REFUSED", "This takes its organization, instance and position from the server; they cannot be supplied in the request.");
  }
  const allowed = new Set<string>([...PLANNING_REQUEST_FIELDS, ...extraAllowed]);
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !allowed.has(key))) return refusal("INVALID_REQUEST", PLANNING_INVALID_REQUEST_MESSAGE);

  if (typeof fields.goal !== "string" || fields.goal.trim().length === 0 || fields.goal.length > PLANNING_LIMITS.goalMax) {
    return refusal("INVALID_REQUEST", PLANNING_INVALID_REQUEST_MESSAGE);
  }
  if (fields.trigger !== undefined && (typeof fields.trigger !== "string" || !(LIBRARY_TRIGGER_KINDS as readonly string[]).includes(fields.trigger))) {
    return refusal("INVALID_REQUEST", PLANNING_INVALID_REQUEST_MESSAGE);
  }
  const integrations = stringList(fields.integrations, PLANNING_LIMITS.integrationsMax, 40);
  const services = stringList(fields.services, PLANNING_LIMITS.servicesMax, 40);
  const inputs = stringList(fields.inputs, PLANNING_LIMITS.inputsMax, PLANNING_LIMITS.inputMax);
  if (!integrations || !services || !inputs) return refusal("INVALID_REQUEST", PLANNING_INVALID_REQUEST_MESSAGE);
  if (!integrations.every((c) => (LIBRARY_INTEGRATION_CATEGORIES as readonly string[]).includes(c))) {
    return refusal("INVALID_REQUEST", PLANNING_INVALID_REQUEST_MESSAGE);
  }
  if (fields.outcome !== undefined && (typeof fields.outcome !== "string" || fields.outcome.length > PLANNING_LIMITS.outcomeMax)) {
    return refusal("INVALID_REQUEST", PLANNING_INVALID_REQUEST_MESSAGE);
  }

  const texts = [fields.goal, ...(typeof fields.outcome === "string" ? [fields.outcome] : []), ...inputs, ...services];
  if (texts.some((t) => containsSecret(t))) return refusal("SECRET_REFUSED", PLANNING_SECRET_MESSAGE);

  const goal = (planningText(fields.goal, PLANNING_LIMITS.goalMax) as { ok: true; text: string }).text;
  if (goal.length === 0) return refusal("INVALID_REQUEST", PLANNING_INVALID_REQUEST_MESSAGE);
  const outcome = typeof fields.outcome === "string" ? (planningText(fields.outcome, PLANNING_LIMITS.outcomeMax) as { ok: true; text: string }).text || null : null;
  const inputNames = inputs.map((i) => (planningText(i, PLANNING_LIMITS.inputMax) as { ok: true; text: string }).text).filter((i) => i.length > 0);

  return { ok: true, value: readRequest(goal, fields.trigger as LibraryTriggerKind | undefined, integrations as LibraryIntegrationCategory[], services, inputNames, outcome) };
}

function readRequest(
  goal: string,
  statedTrigger: LibraryTriggerKind | undefined,
  statedCategories: LibraryIntegrationCategory[],
  statedServices: string[],
  inputs: string[],
  outcome: string | null
): AutomationRequest {
  const notes: string[] = [];
  const openQuestions: AutomationRequest["openQuestions"] = [];
  const text = `${goal} ${outcome ?? ""}`;

  // The trigger: stated wins; from the goal only when its words point one way.
  const fromGoal = [...new Set(TRIGGER_WORDS.filter(([pattern]) => pattern.test(goal)).map(([, kind]) => kind))];
  let trigger: AutomationRequest["trigger"];
  if (statedTrigger) {
    trigger = { kind: statedTrigger, source: "stated" };
    if (fromGoal.length > 0 && !fromGoal.includes(statedTrigger)) {
      notes.push(`The goal's words suggest ${fromGoal.map((k) => TRIGGER_LABEL[k]).join(" or ")}; the stated trigger, ${TRIGGER_LABEL[statedTrigger]}, was used.`);
    }
  } else if (fromGoal.length === 1) {
    trigger = { kind: fromGoal[0]!, source: "from_goal" };
  } else {
    trigger = { kind: null, source: "unknown" };
    openQuestions.push({
      key: "trigger",
      question:
        fromGoal.length > 1
          ? `What should start it: ${fromGoal.map((k) => TRIGGER_LABEL[k]).join(" or ")}?`
          : "What should start it — a webhook, a schedule, a form submission, an incoming email, or a manual start?",
    });
  }

  // Services: those named, then those the goal's words name.
  const services: AutomationRequest["services"] = [];
  const addService = (found: ReturnType<typeof planningService>, source: "stated" | "from_goal") => {
    if (!found || services.some((s) => s.name === found.name)) return;
    services.push({ ...found, category: libraryIntegrationCategory(found.nodeType), source });
  };
  for (const name of statedServices) {
    const found = planningService(name);
    if (found) addService(found, "stated");
    else {
      // Secrets were refused above, so the cleaned name is safe to say back.
      const shown = (planningText(name, 40) as { ok: true; text: string }).text;
      notes.push(`"${shown}" is not an app JARVIS recognizes as an n8n node, so it was not used for matching.`);
    }
  }
  for (const [pattern, name, label] of SERVICES) {
    if (services.length >= PLANNING_LIMITS.servicesMax) break;
    if (pattern.test(text)) addService({ name, nodeType: baseType(name), label }, "from_goal");
  }

  // Categories not already covered by a named service.
  const covered = new Set(services.map((s) => s.category).filter((c): c is LibraryIntegrationCategory => c !== null));
  const integrations: AutomationRequest["integrations"] = [];
  for (const category of statedCategories) {
    if (!covered.has(category) && !integrations.some((i) => i.category === category)) integrations.push({ category, source: "stated" });
  }
  for (const [pattern, category] of CATEGORY_WORDS) {
    if (pattern.test(text) && !covered.has(category) && !integrations.some((i) => i.category === category)) {
      integrations.push({ category, source: "from_goal" });
    }
  }
  // An incoming email is the trigger; the email words that said so are not also an app.
  const appIntegrations = integrations.filter((i) => !(i.category === "email" && i.source === "from_goal" && trigger.kind === "email"));
  for (const item of appIntegrations) {
    openQuestions.push({ key: `which_${item.category}`, question: `Which app should handle ${CATEGORY_LABEL[item.category]}?` });
  }
  if (services.length === 0 && appIntegrations.length === 0) {
    openQuestions.push({ key: "integrations", question: "Which apps should it use (for example Slack, Gmail or Google Sheets)?" });
  }
  if (inputs.length === 0 && (trigger.kind === "webhook" || trigger.kind === "form")) {
    openQuestions.push({ key: "inputs", question: "What data does it receive — the names of the fields?" });
  }
  if (!outcome) openQuestions.push({ key: "outcome", question: "What should have happened when it finishes?" });

  return {
    goal,
    terms: terms(goal, PLANNING_LIMITS.termsMax, true),
    trigger,
    services,
    integrations: appIntegrations,
    inputs,
    outcome,
    notes,
    openQuestions,
  };
}

// ---------------------------------------------------------------------------
// Ranking.
// ---------------------------------------------------------------------------

export type CandidateFit = "reuse" | "customize";

export interface PlanningCandidate {
  entryId: string;
  name: string;
  active: boolean;
  presence: LibraryEntryPresence;
  versionId: string | null;
  fit: CandidateFit;
  /** 0–100, from the four criteria below; for ordering, not a probability. */
  score: number;
  criteria: {
    trigger: { status: "match" | "mismatch" | "unknown" | "not_requested"; found: LibraryTriggerKind[] };
    apps: { status: "full" | "partial" | "none" | "unknown" | "not_requested"; covered: string[]; missing: string[] };
    words: { status: "shared" | "none" | "not_comparable"; shared: string[] };
    metadata: { status: "complete" | "incomplete"; missing: string[] };
  };
  /** Why it matches, and where it falls short — fixed sentences over the criteria. */
  matches: string[];
  gaps: string[];
}

export type PlanningOutcome = "reuse" | "customize" | "no_match" | "insufficient_evidence";

export interface PlanningMatch {
  request: AutomationRequest;
  outcome: PlanningOutcome;
  explanation: string;
  candidates: PlanningCandidate[];
  searched: { compared: number; catalogTotal: number; method: "full" | "targeted"; complete: boolean };
  limitations: string[];
}

export const PLANNING_LIMITATIONS = {
  scope:
    "Matching compares triggers, app node types and names stored in the catalog. It cannot see how a workflow's nodes are configured, so a match is a lead to inspect, not proof that it does the same thing.",
  targeted: "The library is large, so it was searched by the request's own words rather than compared in full; a relevant workflow with other words could have been missed.",
  noNodes: "Some workflows' listings carried no node types, so their trigger and apps could not be compared.",
} as const;

const WEIGHTS = { trigger: 35, apps: 35, words: 20, metadata: 10 } as const;

/** What a large catalog is searched for: the request's own node names, trigger and words. */
export function planningSearchTerms(request: AutomationRequest): string[] {
  const out: string[] = [];
  const push = (t: string) => {
    if (t.length >= 3 && !out.includes(t) && out.length < PLANNING_LIMITS.targetedSearchesMax) out.push(t);
  };
  for (const s of request.services) push(s.name.toLowerCase());
  const triggerNode: Partial<Record<LibraryTriggerKind, string>> = {
    webhook: "webhook",
    schedule: "scheduletrigger",
    form: "formtrigger",
    email: "emailreadimap",
    manual: "manualtrigger",
    chat: "chattrigger",
  };
  if (request.trigger.kind && triggerNode[request.trigger.kind]) push(triggerNode[request.trigger.kind]!);
  for (const t of request.terms) push(t);
  return out;
}

function evaluate(request: AutomationRequest, entry: LibraryEntryRecord): { candidate: PlanningCandidate; fit: CandidateFit | null; comparable: boolean } {
  const view = inspectLibraryEntry(entry);
  const nodesKnown = view.nodeTypes.status !== "unavailable";
  const nodeTypes = new Set(view.nodeTypes.items);
  const categories = new Set(view.integrations.categories.map((c) => c.category));
  const kinds = [...new Set(view.trigger.kinds.map((k) => k.kind))];

  // Trigger.
  const trigger: PlanningCandidate["criteria"]["trigger"] = {
    status: !request.trigger.kind ? "not_requested" : !nodesKnown ? "unknown" : kinds.includes(request.trigger.kind) ? "match" : "mismatch",
    found: kinds,
  };

  // Apps: each named service by its node type (or its app trigger), each other category by category.
  const needs = [
    ...request.services.map((s) => ({ label: s.label, met: nodeTypes.has(s.nodeType) || nodeTypes.has(`${s.nodeType}Trigger`) })),
    ...request.integrations.map((i) => ({ label: CATEGORY_LABEL[i.category], met: categories.has(i.category) })),
  ];
  const covered = needs.filter((n) => n.met).map((n) => n.label);
  const missing = needs.filter((n) => !n.met).map((n) => n.label);
  const apps: PlanningCandidate["criteria"]["apps"] = {
    status: needs.length === 0 ? "not_requested" : !nodesKnown ? "unknown" : missing.length === 0 ? "full" : covered.length > 0 ? "partial" : "none",
    covered: nodesKnown ? covered : [],
    missing: nodesKnown ? missing : needs.map((n) => n.label),
  };

  // Shared words: the requester's own, found in the entry's name or tags.
  const entryTerms = new Set(terms(`${entry.name} ${(entry.tags ?? []).join(" ")}`, 64));
  const shared = request.terms.filter((t) => entryTerms.has(t));
  const words: PlanningCandidate["criteria"]["words"] = {
    status: request.terms.length === 0 ? "not_comparable" : shared.length > 0 ? "shared" : "none",
    shared,
  };

  // Metadata.
  const metaMissing: string[] = [];
  if (!nodesKnown) metaMissing.push("node types");
  else if (view.nodeTypes.status === "partial") metaMissing.push("some node types");
  if (!view.versionId) metaMissing.push("version");
  if (view.stale.stale) metaMissing.push("presence in the last complete scan");
  const metadata: PlanningCandidate["criteria"]["metadata"] = { status: metaMissing.length === 0 ? "complete" : "incomplete", missing: metaMissing };

  // Score: each criterion 0..1, weighted; one not asked for leaves the scale.
  const parts: Array<[number, number | null]> = [
    [WEIGHTS.trigger, trigger.status === "not_requested" ? null : trigger.status === "match" ? 1 : 0],
    [WEIGHTS.apps, apps.status === "not_requested" ? null : needs.length === 0 ? 0 : nodesKnown ? covered.length / needs.length : 0],
    [WEIGHTS.words, words.status === "not_comparable" ? null : Math.min(1, shared.length / Math.min(3, request.terms.length))],
    [WEIGHTS.metadata, Math.max(0, 1 - metaMissing.length / 3)],
  ];
  const counted = parts.filter(([, v]) => v !== null) as Array<[number, number]>;
  const score = Math.round((100 * counted.reduce((sum, [w, v]) => sum + w * v, 0)) / counted.reduce((sum, [w]) => sum + w, 0));

  const usable = nodesKnown && !view.stale.stale;
  const asked = trigger.status !== "not_requested" || apps.status !== "not_requested";
  const reuse =
    usable &&
    asked &&
    (trigger.status === "match" || trigger.status === "not_requested") &&
    (apps.status === "full" || apps.status === "not_requested") &&
    words.status !== "none";
  // Customizable: some of the apps are there, or the trigger matches AND the purpose words are shared.
  const customize =
    usable && !reuse && (apps.status === "full" || apps.status === "partial" || (trigger.status === "match" && words.status === "shared")) && score >= 40;
  const fit: CandidateFit | null = reuse ? "reuse" : customize ? "customize" : null;

  const matches: string[] = [];
  const gaps: string[] = [];
  if (trigger.status === "match") matches.push(`Starts on ${TRIGGER_LABEL[request.trigger.kind!]}, as asked.`);
  if (trigger.status === "mismatch") {
    gaps.push(`Starts on ${kinds.length > 0 ? kinds.map((k) => TRIGGER_LABEL[k]).join(" or ") : "no recognized trigger"}, not ${TRIGGER_LABEL[request.trigger.kind!]}.`);
  }
  if (covered.length > 0) matches.push(`Uses ${covered.join(", ")}.`);
  if (apps.status !== "not_requested" && missing.length > 0) gaps.push(nodesKnown ? `Does not use ${missing.join(", ")}.` : "Its apps are unknown.");
  if (shared.length > 0) matches.push(`Its name shares your words: ${shared.join(", ")}.`);
  if (words.status === "none") gaps.push("Its name shares none of your words.");
  if (!nodesKnown) gaps.push("Its listing carried no node types, so its trigger and apps are unknown.");
  if (view.stale.stale) gaps.push("It was not seen in the last complete scan of the library.");
  if (!view.versionId) gaps.push("n8n reported no version for it.");
  if (!view.active) gaps.push("It is inactive in n8n.");

  return {
    candidate: {
      entryId: view.entryId,
      name: view.name,
      active: view.active,
      presence: view.presence,
      versionId: view.versionId,
      fit: fit ?? "customize",
      score,
      criteria: { trigger, apps, words, metadata },
      matches,
      gaps,
    },
    fit,
    comparable: nodesKnown,
  };
}

/**
 * Rank the entries read from the catalog against a request. Pure: the same
 * request and entries always give the same answer, in the same order.
 */
export function rankLibraryCandidates(
  request: AutomationRequest,
  entries: readonly LibraryEntryRecord[],
  searched: PlanningMatch["searched"]
): PlanningMatch {
  const limitations: string[] = [PLANNING_LIMITATIONS.scope];
  if (!searched.complete) limitations.push(PLANNING_LIMITATIONS.targeted);

  const nothingToCompare = request.trigger.kind === null && request.services.length === 0 && request.integrations.length === 0 && request.terms.length === 0;
  if (nothingToCompare) {
    return {
      request,
      outcome: "insufficient_evidence",
      explanation: "The request names no trigger, app or word the catalog can be compared with. Say how it should start and which apps it should use.",
      candidates: [],
      searched,
      limitations,
    };
  }

  const evaluated = entries.map((entry) => evaluate(request, entry));
  if (evaluated.some((e) => !e.comparable)) limitations.push(PLANNING_LIMITATIONS.noNodes);
  if (entries.length > 0 && evaluated.every((e) => !e.comparable)) {
    return {
      request,
      outcome: "insufficient_evidence",
      explanation: "None of the compared workflows' listings carried node types, so their triggers and apps cannot be compared. Nothing is claimed about them.",
      candidates: [],
      searched,
      limitations,
    };
  }

  const fitting = evaluated
    .filter((e) => e.fit !== null)
    .sort(
      (a, b) =>
        (a.fit === "reuse" ? 0 : 1) - (b.fit === "reuse" ? 0 : 1) ||
        b.candidate.score - a.candidate.score ||
        a.candidate.name.localeCompare(b.candidate.name) ||
        a.candidate.entryId.localeCompare(b.candidate.entryId)
    )
    .slice(0, PLANNING_LIMITS.candidatesMax)
    .map((e) => ({ ...e.candidate, fit: e.fit! }));

  if (fitting.length === 0) {
    return {
      request,
      outcome: "no_match",
      explanation:
        entries.length === 0
          ? "The library holds no workflows to compare yet. Synchronize it first, or start a new draft."
          : `No suitable workflow found: none of the ${entries.length} compared matched the trigger or the apps asked for. A new draft is reasonable.`,
      candidates: [],
      searched,
      limitations,
    };
  }
  const best = fitting[0]!;
  return {
    request,
    outcome: best.fit,
    explanation:
      best.fit === "reuse"
        ? `"${withoutLinks(best.name)}" appears to cover the request: ${best.matches.join(" ")} Inspect it before building something new.`
        : `No workflow covers the whole request; the closest can be customized. ${best.matches.join(" ")} ${best.gaps.join(" ")}`.trim(),
    candidates: fitting,
    searched,
    limitations,
  };
}
