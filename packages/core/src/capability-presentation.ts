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

import {
  isUsable,
  type CapabilityAvailability,
  type CapabilityReport,
  type CapabilityView,
} from "./types/capability.js";
import type {
  SkillContext,
  SkillDefinition,
  SkillView,
  UnlistedTool,
} from "./types/skill.js";

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

/**
 * A goal group IS a skill — Skill System V1, Phase S1.
 *
 * This type used to be declared here as `GoalGroupRule`. It carried an id, a
 * user-facing title, a one-sentence summary, the tools it owns and the
 * phrasings it can offer: everything a skill needs except a name. So S1
 * PROMOTED it rather than building a second list beside it, and
 * `SkillDefinition` in @jarvis/core was fitted to these exact field names so
 * the promotion needed no rename and no data migration.
 *
 * The alias is kept because this module's internals still read "goal group",
 * and churning a hundred references would have been noise, not progress.
 */
type GoalGroupRule = SkillDefinition;

/**
 * THE SKILL CATALOGUE. One list, code-defined, and the only source of truth for
 * which outcomes JARVIS claims.
 *
 * Exported as `SKILL_CATALOG` so the skill layer reads the same array the
 * briefing does — there is deliberately no second copy to drift from.
 *
 * MEMBERSHIP HERE IS NOT AUTHORIZATION. Naming a tool in `prefixes` or `exact`
 * says "this tool serves this outcome". Whether it may RUN is decided by the
 * agent allowlist, at compile time, and `buildSkillViews` only ever sees
 * capabilities that already passed it.
 */
export const SKILL_CATALOG: readonly SkillDefinition[] = [
  {
    id: "advertising",
    title: "Business and advertising",
    summary: "Look at how your ad accounts are performing and act on what you find.",
    prefixes: ["meta."],
    // Google Ads, by EXACT id. S2 audit.
    //
    // The prefixes this once carried — `google.ads.` and `adwords.` — matched
    // no tool, and the reason is worth keeping: `google.ads.accounts` IS a
    // real id, but it is an INTEGRATION ACTION id in `integration-catalog.ts`,
    // which carries its own `toolId: "google.accounts"` precisely because the
    // two namespaces differ. Matching one namespace against the other left
    // three registered, authorized Google Ads tools in no skill at all.
    //
    // The obvious repair — a bare `google.` prefix — is worse: it would take
    // all nine `google.plan.*` Workspace tools away from the workspace skill,
    // because `ruleFor` returns the first match and this entry is declared
    // first. So membership here is stated, not pattern-matched.
    exact: ["google.accounts", "google.campaigns", "google.insights"],
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
    // S2 audit. `web.research` and `document.analyze` are research tools that
    // no prefix here reaches. They are members because membership is SEMANTIC;
    // no agent policy grants either one today, so `CapabilityService` drops
    // them from every report and they cannot reach a SkillView. Membership and
    // authorization are two axes, and this file only decides the first.
    //
    // `knowledge.` is kept although nothing matches it: knowledge retrieval in
    // this build is an ORCHESTRATOR step, not a tool. The prefix costs nothing
    // and would adopt a real `knowledge.*` tool the day one exists.
    exact: ["web.research", "document.analyze"],
    phrases: [
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
 * THE INTENTIONAL ORPHANS — Skill System V1, Phase S2.
 *
 * Every entry was audited against the tool's own description, the agent policy
 * that grants it and the label the capability report would give it. None is an
 * outcome a user asks for, so listing one would pad the catalogue with a skill
 * nobody can request.
 *
 * Note what this list is NOT: it is not a denial. Every tool here remains
 * exactly as callable as its agent policy says. Skill membership never granted
 * anything and never withheld anything.
 */
export const SKILL_UNLISTED_TOOLS: readonly UnlistedTool[] = [
  {
    id: "self.describe",
    reason:
      "Introspection, not an outcome. It answers what JARVIS IS — build, model, environment — where a skill answers what JARVIS can DO for you. Its own description sends 'what can you do' to capabilities.list instead. Granted to all nine agents and unaffected by being unlisted.",
  },
  {
    id: "task.create",
    reason:
      "JARVIS's own work queue, not the user's to-do list. Deliberately distinct from tasks.* — see SKILL_TASK_NAMESPACES.",
  },
  {
    id: "task.get",
    reason:
      "Reads one row of JARVIS's own work queue. Same domain as task.create: the Task Engine lifecycle, not a user-facing outcome.",
  },
  {
    id: "task.list",
    reason:
      "See task.create. tasks.list's own description routes 'what are you working on' here and 'what is due' to itself; the two are different questions about different data.",
  },
  {
    id: "task.updateStatus",
    reason:
      "Moves a row of JARVIS's own work queue through the lifecycle. Same domain as task.create, and driven by the engine rather than requested by name.",
  },
  {
    id: "system.echo",
    reason:
      "A test fixture — its own description says 'Harmless test tool'. This is why the monitoring skill claims system.status and time.now by EXACT id and not by a `system.` prefix.",
  },
];

/**
 * The singular/plural pair that looks like a typo and is not.
 *
 * `tasks.list` is the user's own dated to-do list. `task.*` is the work JARVIS
 * was asked to carry out — the Task Engine lifecycle, shown in the dashboard's
 * JARVIS Work section. Both tools say so in their own descriptions, and
 * `tasks.list` names `task.list` as the tool for "what are you working on".
 *
 * Kept here as data so the productivity skill's `tasks.` prefix can be asserted
 * NOT to reach `task.*`. Widening it would merge two different questions about
 * two different tables into one answer.
 */
export const SKILL_TASK_NAMESPACES = Object.freeze({
  userTodos: "tasks.",
  jarvisWork: "task.",
});

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

/**
 * The phrasings a user can offer for one skill, right now.
 *
 * The single derivation, called by the briefing and by `buildSkillViews` alike,
 * so the two can never drift into saying different things about the same tools.
 *
 * `usable` must already be filtered to usable capabilities: a phrase is shown
 * only when the tool behind it can actually run, which is how the answer
 * shrinks honestly instead of over-promising.
 */
function youCanAskFor(
  rule: SkillDefinition,
  usable: readonly CapabilityView[],
  usableIds: ReadonlySet<string>
): string[] {
  // Curated phrasing first, gated on the tool actually being usable.
  const phrases = rule.phrases.filter((p) => usableIds.has(p.requires)).map((p) => p.text);

  // Anything usable this group owns but has no phrase for still deserves a
  // mention — but only if its label is fit to read out. This is what keeps a
  // newly registered tool visible without hand-editing this file.
  const phrasedIds = new Set(rule.phrases.map((p) => p.requires));
  const extras = usable
    .filter((c) => !phrasedIds.has(c.id) && isHumanLabel(c.label))
    .map((c) => c.label.toLowerCase());

  return [...phrases, ...extras].slice(0, MAX_PHRASES_PER_GROUP);
}

function ruleFor(toolId: string): GoalGroupRule | undefined {
  const exact = GOAL_GROUPS.find((g) => g.exact?.includes(toolId));
  if (exact) return exact;
  return GOAL_GROUPS.find((g) => g.prefixes.some((p) => toolId.startsWith(p)));
}

/** Internal alias: this module's prose says "goal group", the model is a skill. */
const GOAL_GROUPS = SKILL_CATALOG;

/** The one place a tool id is matched to a skill. Exported for tests. */
export function skillForToolId(toolId: string): SkillDefinition | undefined {
  return ruleFor(toolId);
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

    const youCanAsk = youCanAskFor(rule, caps, usableIds);
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

/**
 * Availability ranked from most to least usable.
 *
 * This is the order `CapabilityAvailability` itself declares. It is repeated
 * here as data rather than re-judged, so a skill's headline state and a sorted
 * capability list can never disagree about which of two states is better.
 */
const AVAILABILITY_ORDER: readonly CapabilityAvailability[] = [
  "EXECUTABLE",
  "REQUIRES_CONFIRMATION",
  "NOT_CONNECTED",
  "PERMISSION_MISSING",
  "NOT_CONFIGURED",
  "NEEDS_REAUTH",
  "DISABLED",
  "PLANNED",
];

function rankOf(availability: CapabilityAvailability): number {
  const i = AVAILABILITY_ORDER.indexOf(availability);
  return i === -1 ? AVAILABILITY_ORDER.length : i;
}

/**
 * Fold a skill's member capabilities into the facts every caller needs.
 *
 * ONE derivation, used by `buildSkillViews` (all members) and by
 * `buildSkillContext` (members the selected agent may actually call). Sharing
 * it is the point: the reader-facing view and the model-facing context must
 * never disagree about whether a skill works.
 *
 * `members` must be non-empty.
 */
function summarizeMembers(members: readonly CapabilityView[]): {
  usable: CapabilityView[];
  availability: CapabilityAvailability;
  toolIds: string[];
  blockedBy: string[];
} {
  // The BEST member, not the weakest: an outcome with four working tools and
  // one unconnected provider is partly available, not unavailable. What is
  // missing is carried in the counts and in `blockedBy` instead of being
  // allowed to veto the headline.
  const availability = members.reduce<CapabilityAvailability>(
    (best, c) => (rankOf(c.availability) < rankOf(best) ? c.availability : best),
    members[0]!.availability
  );

  // Plain-English remedies, de-duplicated: four Google members blocked for
  // one reason are one thing to fix, not four.
  const blockedBy: string[] = [];
  for (const c of members) {
    if (isUsable(c.availability)) continue;
    const why = c.reason;
    if (why && !blockedBy.includes(why)) blockedBy.push(why);
  }

  return {
    usable: members.filter((c) => isUsable(c.availability)),
    availability,
    // PLANNED members have no tool in this build, so their ids are not tool
    // ids and do not belong in a list a caller might try to execute.
    toolIds: members.filter((c) => c.registered).map((c) => c.id),
    blockedBy,
  };
}

/**
 * Turn a live report into the skills it currently supports.
 *
 * DERIVED, NEVER STORED — the same rule capability itself follows. Every field
 * of every `SkillView` comes from the report passed in; nothing is read from a
 * database, a cache or a registry, so a skill cannot claim an availability that
 * stopped being true when a token expired.
 *
 * MEMBERSHIP IS NOT AUTHORIZATION. A skill's members are whatever the report
 * already contains for it, and the report has been filtered to the agent
 * allowlist upstream. So a definition naming a tool the policy does not permit
 * yields a skill WITHOUT that member — it cannot smuggle one in. This is what
 * keeps a future learned or MCP-sourced relationship from becoming executable
 * merely by being discovered.
 *
 * Skills with no member in this build are omitted rather than reported empty:
 * a skill this deployment cannot represent at all is not a skill it has.
 *
 * Pure and synchronous. Same report in, same skills out.
 */
export function buildSkillViews(report: CapabilityReport): SkillView[] {
  const usableIds = new Set(
    report.capabilities.filter((c) => isUsable(c.availability)).map((c) => c.id)
  );

  // One pass over the report rather than one per skill, and using the SAME
  // resolver the briefing uses, so a tool lands in exactly one skill.
  const members = new Map<string, CapabilityView[]>();
  for (const cap of report.capabilities) {
    const rule = ruleFor(cap.id);
    if (!rule) continue;
    const list = members.get(rule.id) ?? [];
    list.push(cap);
    members.set(rule.id, list);
  }

  const views: SkillView[] = [];
  for (const skill of SKILL_CATALOG) {
    const caps = members.get(skill.id);
    if (!caps || caps.length === 0) continue;

    const { usable, availability, toolIds, blockedBy } = summarizeMembers(caps);

    const integrations: string[] = [];
    for (const c of caps) {
      if (c.integration && !integrations.includes(c.integration)) integrations.push(c.integration);
    }

    views.push({
      id: skill.id,
      title: skill.title,
      summary: skill.summary,
      toolIds,
      integrations,
      availability,
      usableCount: usable.length,
      approvalCount: caps.filter((c) => c.availability === "REQUIRES_CONFIRMATION").length,
      unavailableCount: caps.length - usable.length,
      totalCount: caps.length,
      blockedBy,
      youCanAsk: youCanAskFor(skill, usable, usableIds),
    });
  }

  // Most usable first, then the richest, then by id — so the ordering is total
  // and a caller truncating the list keeps what the user can actually use.
  views.sort(
    (a, b) =>
      rankOf(a.availability) - rankOf(b.availability) ||
      b.usableCount - a.usableCount ||
      b.totalCount - a.totalCount ||
      a.id.localeCompare(b.id)
  );
  return views;
}

/**
 * The skills a SPECIFIC agent can serve right now — Skill System V1, Phase S3.
 *
 * A projection of `buildSkillViews`, narrowed twice:
 *
 *   1. `CapabilityService` has already dropped every tool no agent policy
 *      grants, before the report was built;
 *   2. this intersects what remains with the SELECTED agent's own allowlist.
 *
 * Both are narrowing. There is no argument to this function that widens
 * anything, and nothing it returns is consulted when a tool call is authorized
 * — `Orchestrator.executeTools` re-checks the policy afterwards regardless.
 * The result exists to ORIENT a planner, not to gate it.
 *
 * Availability is recomputed over the intersected members rather than copied
 * from the view. A skill whose only agent-visible tool is blocked must not
 * inherit a healthy headline from a sibling this agent cannot call.
 *
 * A skill with no callable member for this agent is omitted entirely: showing
 * it would invite a call the allowlist gate will deny and audit.
 *
 * Pure, synchronous, non-mutating. Same report and same allowlist in, same
 * contexts out.
 */
export function buildSkillContext(
  report: CapabilityReport,
  agentAllowedToolIds: ReadonlySet<string>
): SkillContext[] {
  // Reuse the S1 derivation for membership, titles and ordering rules rather
  // than re-deriving any of it here.
  const views = buildSkillViews(report);

  // The same resolver, over the same report — so a capability lands in the
  // same skill it landed in above.
  const membersBySkill = new Map<string, CapabilityView[]>();
  for (const cap of report.capabilities) {
    if (!agentAllowedToolIds.has(cap.id)) continue;
    const rule = ruleFor(cap.id);
    if (!rule) continue;
    const list = membersBySkill.get(rule.id) ?? [];
    list.push(cap);
    membersBySkill.set(rule.id, list);
  }

  const contexts: SkillContext[] = [];
  for (const view of views) {
    const members = membersBySkill.get(view.id);
    if (!members || members.length === 0) continue;

    const { availability, toolIds, blockedBy } = summarizeMembers(members);
    if (toolIds.length === 0) continue;

    contexts.push({
      id: view.id,
      title: view.title,
      summary: view.summary,
      availability,
      toolIds,
      blockedBy,
    });
  }

  // Re-sorted on the AGENT's availability, not the deployment's, so a caller
  // reading top-down sees what this agent can actually do first. Total, so the
  // ordering is deterministic.
  contexts.sort(
    (a, b) =>
      rankOf(a.availability) - rankOf(b.availability) ||
      b.toolIds.length - a.toolIds.length ||
      a.id.localeCompare(b.id)
  );
  return contexts;
}

/**
 * Which skills took part in a piece of work — Skill System V1, Phase S4.
 *
 * DERIVED, NOT RECORDED. Nothing stores skill participation, and nothing
 * should: `AuditLog` already carries the tool id, the trace id and the
 * execution id for every call, and `skillForToolId` is a pure function. So
 * "which skills participated in this objective?" is answerable by grouping the
 * rows that already exist and mapping them here — no column, no table, no
 * second write path that could disagree with the audit trail.
 *
 * Order follows first appearance, so a caller reading it top-down sees the
 * order the work actually happened in. Tools belonging to no skill — the
 * intentional orphans, `self.describe` and the `task.*` lifecycle — contribute
 * nothing rather than being invented a home, and an unknown id is simply
 * absent.
 */
export function skillsForToolIds(toolIds: readonly string[]): string[] {
  const seen: string[] = [];
  for (const id of toolIds) {
    const skill = ruleFor(id);
    if (skill && !seen.includes(skill.id)) seen.push(skill.id);
  }
  return seen;
}

/**
 * Skill context as the model reads it.
 *
 * OUTCOMES, NOT INVENTORY. The provider already receives every tool definition
 * by name; repeating them here would be noise at best. What the definitions
 * cannot express is which of them will actually work right now — a tool
 * definition looks identical whether Google is connected or not — and that is
 * the whole reason this block exists.
 *
 * DELIBERATELY ABSENT: tool ids, risk levels, parameter shapes, integration
 * ids, account identifiers, counts. Raw ids in particular are kept out because
 * a model shown one will eventually quote it to a user, which is the defect
 * the capability briefing was rewritten to fix.
 *
 * The closing line is not decoration. Without it a model reads a list of
 * skills as the list of things it may do, and stops calling the tools that
 * belong to no skill on purpose — `self.describe`, the `task.*` lifecycle.
 *
 * Returns "" when there is nothing to say, so the caller can concatenate
 * without a branch and the prompt is untouched.
 */
export function renderSkillContext(contexts: readonly SkillContext[]): string {
  if (contexts.length === 0) return "";

  const lines = ["WHAT YOU CAN ACTUALLY DO RIGHT NOW:", ""];
  for (const skill of contexts) {
    lines.push(`${skill.title} — ${skill.summary}`);
    if (skill.blockedBy.length > 0) {
      lines.push(`  Partly unavailable: ${skill.blockedBy.join(" ")}`);
    }
  }
  lines.push("");
  lines.push(
    "This is orientation, not a restriction: use whichever of your tools the request needs, including any not named above. Where something is listed as unavailable, say so and say why rather than attempting it."
  );

  return lines.join("\n");
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
