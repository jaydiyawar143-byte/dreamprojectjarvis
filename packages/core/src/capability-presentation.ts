// ---------------------------------------------------------------------------
// Capability PRESENTATION — how a live CapabilityReport becomes an answer a
// person actually wants to hear.
//
// THE BUG THIS REPLACES. `CapabilityService` already derives the truth (see
// capability-service.ts): what is registered, connected, permitted and
// approval-gated. That part was right. What went wrong is what happened next —
// the capability tool handed the model four FLAT ARRAYS of `{id, label, group}`
// and the model did the only sensible thing with a flat list: it read the list
// out. "What can you do?" answered with 34 bullet points across technical
// buckets named "Ambient" and "System", including seven raw registry ids
// (`integration.list`, `integration.status`, …) because a tool with no label
// override falls back to its own id.
//
// That is a capability REGISTRY talking, not an assistant. So this module sits
// between the derived truth and the answer, and does three things a flat list
// cannot:
//
//   1. Regroups by what the USER is trying to get done, not by which provider
//      happens to implement it. "Maps, places and travel" is a goal; "ambient"
//      is an implementation detail that leaked.
//   2. Speaks in requests, not in tool names. Every phrase is something the
//      user could actually say.
//   3. Offers concrete examples — but only examples that are backed by a
//      capability the live report says is usable RIGHT NOW.
//
// NOTHING HERE INVENTS A CAPABILITY. Every phrase, example and group is gated
// on a tool id being present and usable in the report that was passed in. A
// deployment with no Meta connection produces a briefing with no advertising
// group and no advertising examples, because the filter found nothing to keep.
// This module cannot make JARVIS claim something the registry does not have —
// it can only choose words for what the registry already reported.
// ---------------------------------------------------------------------------

import { isUsable, type CapabilityReport, type CapabilityView } from "./types/capability.js";

/**
 * A capability group as a USER would think of it.
 *
 * Deliberately not `CapabilityGroup`. That type mirrors the integration
 * categories, which is right for the registry and wrong for a person: nobody
 * asks "what are your ambient capabilities?".
 */
export interface CapabilityGoalGroup {
  id: string;
  /** Plain, user-facing heading. */
  title: string;
  /** One sentence on what this group gets done. */
  summary: string;
  /** Things the user can ask for, phrased as requests. Derived, never invented. */
  youCanAsk: string[];
  /** How many live capabilities sit behind this group. */
  capabilityCount: number;
  /** Of those, how many stop for explicit approval before running. */
  approvalCount: number;
}

/** One thing JARVIS cannot currently do, and what would change that. */
export interface UnavailableBrief {
  what: string;
  why: string;
  toFix: string;
}

/**
 * The complete, user-oriented answer to a capability question.
 *
 * A model handed THIS still has to write the prose, but every fact it needs is
 * pre-grouped and pre-phrased, so the failure mode of "read the list aloud"
 * produces something reasonable instead of a registry dump.
 */
export interface CapabilityBriefing {
  /** A natural opening line, already reflecting what is actually connected. */
  intro: string;
  /** Four to six goal-oriented groups, richest first. */
  groups: CapabilityGoalGroup[];
  /** Three to six things the user could say right now, all backed by live tools. */
  examples: string[];
  /** How approval works here — null only when nothing is approval-gated. */
  approvalNote: string | null;
  /** Only what is genuinely blocked, with the remedy. Empty when nothing is. */
  unavailable: UnavailableBrief[];
  /** Named but not built. Never presented as usable. */
  planned: string[];
  counts: {
    usable: number;
    needsApproval: number;
    unavailable: number;
    planned: number;
    groupsShown: number;
    groupsOmitted: number;
  };
}

// ---------------------------------------------------------------------------
// Goal groups
//
// `match` decides membership from the TOOL ID, not from `CapabilityGroup`,
// because the registry's grouping is too coarse in exactly the places a user
// cares about: `ambient` holds both "how is this machine doing" (monitoring)
// and "what is the weather" (information), and those are different questions.
//
// Order is the tie-breaker when two rules could claim a tool, so the specific
// ones come first.
// ---------------------------------------------------------------------------

interface GoalGroupRule {
  id: string;
  title: string;
  summary: string;
  /** Tool-id prefixes owned by this group. */
  prefixes: string[];
  /** Exact tool ids owned by this group, checked before prefixes. */
  exact?: string[];
  /**
   * Request phrasings, each gated on a tool. A phrase whose tool is not usable
   * is dropped — which is how an honest group shrinks instead of lying.
   */
  phrases: Array<{ requires: string; text: string }>;
}

const GOAL_GROUPS: GoalGroupRule[] = [
  {
    id: "advertising",
    title: "Business and advertising",
    summary: "Look at how your ad accounts are performing and act on what you find.",
    prefixes: ["meta.", "google.ads.", "adwords."],
    phrases: [
      { requires: "meta.insights", text: "check how your campaigns are performing over any date range" },
      { requires: "meta.campaigns", text: "list your campaigns and see which are active or paused" },
      { requires: "meta.adsets", text: "break performance down by ad set" },
      { requires: "meta.ads", text: "look at individual ads" },
      { requires: "meta.campaign.create", text: "set up a new campaign (I prepare it, you approve it)" },
      { requires: "meta.campaign.pause", text: "pause or resume a campaign (with your approval)" },
      { requires: "meta.adset.budget.update", text: "change a budget (with your approval)" },
    ],
  },
  {
    id: "places",
    title: "Maps, places and travel",
    summary: "Find places around you and work out how to get to them.",
    prefixes: ["maps."],
    phrases: [
      { requires: "maps.nearby", text: "find restaurants, cafes or anything else near you" },
      { requires: "maps.search", text: "search for a specific place" },
      { requires: "maps.route", text: "plan a route between two places" },
      { requires: "maps.distance", text: "get distance and travel time" },
      { requires: "maps.place", text: "pull up details and opening hours for a place" },
    ],
  },
  {
    id: "workspace",
    title: "Email, files and calendar",
    summary: "Read across your Google Workspace and prepare changes for you to approve.",
    prefixes: ["gmail.", "drive.", "calendar.", "google.plan."],
    phrases: [
      { requires: "gmail.listUnread", text: "go through your unread mail" },
      { requires: "gmail.search", text: "search your inbox" },
      { requires: "calendar.listUpcomingEvents", text: "tell you what is coming up on your calendar" },
      { requires: "drive.searchFiles", text: "find a file in Drive" },
      { requires: "google.plan.gmail.createDraft", text: "draft an email for you to approve before it sends" },
      { requires: "google.plan.calendar.createEvent", text: "prepare a calendar event for your approval" },
    ],
  },
  {
    id: "research",
    title: "Research and information",
    summary: "Look things up — on the open web, in your own documents, or in the world right now.",
    prefixes: ["browser.", "knowledge.", "weather.", "market.", "pdf.", "data."],
    phrases: [
      { requires: "knowledge.search", text: "answer questions from documents you have given me" },
      { requires: "weather.current", text: "check the weather anywhere" },
      { requires: "market.quote", text: "look up a stock or crypto price" },
      { requires: "data.csv.analyze", text: "analyse a CSV you share" },
    ],
  },
  {
    id: "productivity",
    title: "Tasks and productivity",
    summary: "Keep track of what you have to do and let your automations run.",
    prefixes: ["tasks.", "n8n."],
    phrases: [
      { requires: "tasks.list", text: "go over your task list" },
      { requires: "n8n.trigger", text: "kick off one of your n8n workflows" },
    ],
  },
  {
    id: "messaging",
    title: "Messaging",
    summary: "Reach people through your connected messaging channels.",
    prefixes: ["whatsapp."],
    phrases: [{ requires: "whatsapp.send", text: "send a WhatsApp message (with your approval)" }],
  },
  {
    id: "monitoring",
    title: "System monitoring",
    summary: "Keep an eye on the machine JARVIS is running on.",
    prefixes: [],
    exact: ["system.status", "time.now"],
    phrases: [
      { requires: "system.status", text: "check CPU, memory and disk health on this machine" },
      { requires: "time.now", text: "tell you the current date and time" },
    ],
  },
  {
    id: "integrations",
    title: "Connected integrations",
    summary: "See what is connected, check its health, and connect or switch things off.",
    prefixes: ["integration.", "capabilities."],
    phrases: [
      { requires: "integration.list", text: "tell you what is connected and what is not" },
      { requires: "integration.health", text: "run a health check across your integrations" },
      { requires: "integration.connect", text: "walk you through connecting a new account" },
      { requires: "integration.disable", text: "switch an integration off (with your approval)" },
    ],
  },
];

/**
 * Example commands, in the user's own register.
 *
 * Each is gated on the tool that would actually serve it, so an example is
 * never an invitation to a capability that would then fail. Hinglish is
 * deliberate: it is how this operator speaks, and an example the user can say
 * verbatim is worth more than a grammatically tidy one they would not.
 */
const EXAMPLE_RULES: Array<{ requires: string; text: string }> = [
  { requires: "meta.insights", text: "Mere Meta campaigns ke insights batao." },
  { requires: "meta.insights", text: "Last 7 days ka ad performance compare karo." },
  { requires: "maps.nearby", text: "Nearby restaurants find karo." },
  { requires: "system.status", text: "Mere system ki health check karo." },
  { requires: "integration.list", text: "Connected integrations ka status batao." },
  { requires: "meta.campaign.create", text: "Ek test campaign create karo." },
  { requires: "gmail.listUnread", text: "Aaj ke unread emails dikhao." },
  { requires: "calendar.listUpcomingEvents", text: "Is hafte ka calendar batao." },
  { requires: "weather.current", text: "Aaj ka weather batao." },
  { requires: "tasks.list", text: "Mere pending tasks dikhao." },
];

const MAX_GROUPS = 6;
const MIN_GROUPS = 4;
const MAX_EXAMPLES = 6;
const MIN_EXAMPLES = 3;
const MAX_PHRASES_PER_GROUP = 4;
const MAX_UNAVAILABLE = 4;

/**
 * Does this label read as something written for a person?
 *
 * A capability with no entry in LABEL_OVERRIDES is labelled with its own tool
 * id, and `integration.status` is not English. Rather than special-casing that
 * table, anything shaped like an identifier is refused here — a dotted token
 * with no spaces — so a NEW tool added without a label degrades to being
 * counted but not quoted, instead of leaking its id into the answer.
 */
function isHumanLabel(label: string): boolean {
  if (!label.includes(" ")) return false;
  if (/^[a-z0-9]+(\.[a-z0-9.]+)+$/i.test(label.trim())) return false;
  return true;
}

function ruleFor(toolId: string): GoalGroupRule | undefined {
  const exact = GOAL_GROUPS.find((g) => g.exact?.includes(toolId));
  if (exact) return exact;
  return GOAL_GROUPS.find((g) => g.prefixes.some((p) => toolId.startsWith(p)));
}

/**
 * Turn a live report into a briefing.
 *
 * Pure and synchronous: it reads only the report it is handed, so the same
 * report always produces the same briefing, and there is no path by which this
 * can consult a registry the caller did not already consult.
 */
export function buildCapabilityBriefing(report: CapabilityReport): CapabilityBriefing {
  const usableCaps = report.capabilities.filter((c) => isUsable(c.availability));
  const usableIds = new Set(usableCaps.map((c) => c.id));

  const approvalIds = new Set(
    report.capabilities.filter((c) => c.availability === "REQUIRES_CONFIRMATION").map((c) => c.id)
  );

  // --- groups -------------------------------------------------------------
  const buckets = new Map<string, CapabilityView[]>();
  for (const cap of usableCaps) {
    const rule = ruleFor(cap.id);
    if (!rule) continue;
    const list = buckets.get(rule.id) ?? [];
    list.push(cap);
    buckets.set(rule.id, list);
  }

  const allGroups: CapabilityGoalGroup[] = [];
  for (const rule of GOAL_GROUPS) {
    const caps = buckets.get(rule.id);
    if (!caps || caps.length === 0) continue;

    // Curated phrasing first, gated on the tool actually being usable.
    const phrases = rule.phrases.filter((p) => usableIds.has(p.requires)).map((p) => p.text);

    // Anything usable this group owns but has no phrase for still deserves a
    // mention — but only if its label is fit to read out. This is what keeps a
    // newly registered tool visible without hand-editing this file.
    const phrasedIds = new Set(rule.phrases.map((p) => p.requires));
    const extras = caps
      .filter((c) => !phrasedIds.has(c.id) && isHumanLabel(c.label))
      .map((c) => c.label.toLowerCase());

    const youCanAsk = [...phrases, ...extras].slice(0, MAX_PHRASES_PER_GROUP);
    if (youCanAsk.length === 0) continue;

    allGroups.push({
      id: rule.id,
      title: rule.title,
      summary: rule.summary,
      youCanAsk,
      capabilityCount: caps.length,
      approvalCount: caps.filter((c) => approvalIds.has(c.id)).length,
    });
  }

  // Richest groups first, so a six-group cap keeps what the user most likely
  // wants rather than whatever happened to be declared first.
  allGroups.sort((a, b) => b.capabilityCount - a.capabilityCount);
  const groups = allGroups.slice(0, MAX_GROUPS);
  const groupsOmitted = Math.max(0, allGroups.length - groups.length);

  // --- examples -----------------------------------------------------------
  const examples: string[] = [];
  for (const rule of EXAMPLE_RULES) {
    if (examples.length >= MAX_EXAMPLES) break;
    if (usableIds.has(rule.requires)) examples.push(rule.text);
  }

  // --- unavailable --------------------------------------------------------
  //
  // Collapsed per integration. Four separate Google rows saying "connect
  // Google" is four times the noise for one action.
  const unavailableByRemedy = new Map<string, UnavailableBrief>();
  for (const cap of report.capabilities) {
    if (isUsable(cap.availability) || cap.availability === "PLANNED") continue;
    const key = cap.integration ?? cap.id;
    if (unavailableByRemedy.has(key)) continue;
    unavailableByRemedy.set(key, {
      what: cap.integration ? integrationLabel(report, cap.integration) : cap.label,
      why: cap.reason ?? "Not available on this deployment.",
      toFix: cap.requiredAction ?? "No action available.",
    });
  }
  const unavailable = [...unavailableByRemedy.values()].slice(0, MAX_UNAVAILABLE);

  const planned = report.capabilities
    .filter((c) => c.availability === "PLANNED")
    .map((c) => c.label.replace(/\s*\(planned\)\s*$/i, ""));

  // --- intro and approval note --------------------------------------------
  const connected = report.integrations.filter((i) => i.connection === "CONNECTED");
  const intro =
    connected.length > 0
      ? `I'm connected to ${listToProse(connected.map((i) => i.name))}, so here's where I can actually be useful to you right now.`
      : "Nothing is connected yet, so here's what I can do on my own — and what opens up once you connect an account.";

  const needsApproval = report.summary.requiresConfirmation;
  const approvalNote =
    needsApproval > 0
      ? "Anything that changes something outside JARVIS — creating or pausing a campaign, changing a budget, sending a message, disconnecting an account — I prepare first and show you. It only runs after you explicitly approve it on screen."
      : null;

  return {
    intro,
    groups,
    examples,
    approvalNote,
    unavailable,
    planned,
    counts: {
      usable: report.summary.executable + report.summary.requiresConfirmation,
      needsApproval,
      unavailable: report.summary.unavailable,
      planned: report.summary.planned,
      groupsShown: groups.length,
      groupsOmitted,
    },
  };
}

function integrationLabel(report: CapabilityReport, integrationId: string): string {
  return report.integrations.find((i) => i.integration === integrationId)?.name ?? integrationId;
}

function listToProse(names: string[]): string {
  if (names.length === 0) return "nothing";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Exported for tests and for anything that needs the group vocabulary. */
export const CAPABILITY_GOAL_GROUP_IDS = GOAL_GROUPS.map((g) => g.id);
export { MIN_GROUPS as CAPABILITY_MIN_GROUPS, MIN_EXAMPLES as CAPABILITY_MIN_EXAMPLES };
