// ---------------------------------------------------------------------------
// S6 — Objective extraction. Implementation Phase 1 of S6 Objective Evaluation.
//
// Turns the user's OWN words into a flat, ordered list of objectives:
//
//   "Check my campaigns, identify weak ones, and draft an email."
//     -> RETRIEVE  "Check my campaigns"   [advertising]
//     -> ANALYZE   "identify weak ones"   []
//     -> COMPOSE   "draft an email."      [workspace]
//
// WHAT THIS FILE IS. A fixed-rule reader of one sentence the user already
// sent. It is the first half of a READ-ONLY evaluation: a later phase joins
// these objectives to the audit trail of the same request and reports what
// is proven. Nothing here decides, authorizes, plans, routes or executes.
//
// WHAT THIS FILE IS NOT.
//
//   - Not a parser. It knows closed lists of words and a handful of positional
//     rules, and deliberately nothing else. A request the lists cannot read is
//     reported as unreadable (no objectives), never guessed at.
//   - Not a model. No LLM reads the request (S6 decision PD-1). The same text
//     produces the same objectives on every run, so an evaluation can be
//     re-derived and audited.
//   - Not the write-intent gate. The gate decides whether a write may be
//     ATTEMPTED; this vocabulary only describes what was ASKED FOR, after the
//     fact. The two are kept apart on purpose — neither imports the other —
//     so an evaluation can never loosen, tighten or stand in for the gate.
//
// THE RULES (locked in the S6 contract; see JARVIS_SKILL_SYSTEM_V1.md §7d):
//
//   1. Split at sentence punctuation followed by whitespace, line breaks,
//      commas, and the whole words and/then/also/plus/aur/phir/fir.
//   2. Mark each clause with the closed marker lists below. A write or
//      compose marker directly after a/an/the/any/this/that/latest/ad is a
//      noun ("the draft", "an update", "ad set") and is ignored.
//   3. Merge unmarked clauses into the marked clause before them — or after
//      them, when they come first.
//   4. Drop a clause whose MARKED part carries a negation. Negation in an
//      unmarked clause has no effect.
//   5. Information framing ("how do I…") and a trailing "?" (unless the
//      message opens with a request such as "can you…") rule out
//      EXTERNAL_WRITE for that clause.
//   6. Class by precedence EXTERNAL_WRITE > COMPOSE > ANALYZE > RETRIEVE; a
//      creation verb is COMPOSE with an artifact noun, EXTERNAL_WRITE without.
//   7. No classifiable clause -> no objectives. More than eight -> one
//      objective spanning the whole request, with the highest class present.
//
// Every objective's text is a trimmed substring of the request. Nothing is
// paraphrased, and nothing the user did not type can appear in it.
// ---------------------------------------------------------------------------

/** What kind of thing an objective asks for, and so what could ever satisfy it. */
export type EvidenceClass = "RETRIEVE" | "EXTERNAL_WRITE" | "COMPOSE" | "ANALYZE";

/** One thing the user asked for, in their own words. */
export interface Objective {
  /** `${traceId}#${index}`, zero-based, in the order the request states them. */
  objectiveId: string;
  /** The trimmed substring of the request this objective was read from. */
  text: string;
  evidenceClass: EvidenceClass;
  /** SKILL_CATALOG ids the text names, in order of first appearance. May be empty. */
  skills: readonly string[];
}

/** Strongest first. A clause carrying several classes takes the first present. */
export const EVIDENCE_CLASS_PRECEDENCE: readonly EvidenceClass[] = Object.freeze([
  "EXTERNAL_WRITE",
  "COMPOSE",
  "ANALYZE",
  "RETRIEVE",
] as const);

/**
 * Beyond this many clauses the request is not split at all.
 *
 * The orchestrator runs at most ten tool executions per turn, so a request
 * naming more than eight separate objectives cannot have had each of them
 * attempted; reporting them individually would imply a precision the evidence
 * cannot have. One objective with the highest class present is the honest
 * shape.
 */
export const MAX_OBJECTIVES = 8;

/**
 * The closed skill vocabulary: which words in an objective name which skill.
 *
 * Keyed by SKILL_CATALOG id, in catalogue order, and pinned to it by a test —
 * this file does not import the catalogue, so it cannot invent a skill, and
 * the test fails if the two ever disagree. A word belongs to one skill only.
 *
 * MEMBERSHIP, NOT AUTHORIZATION. Naming a skill here says what an objective is
 * about. It grants nothing and is never consulted when a call is authorized.
 */
export const OBJECTIVE_SKILL_VOCABULARY = Object.freeze({
  advertising: Object.freeze([
    "campaign", "campaigns", "ad", "ads", "ad set", "ad sets", "adset", "adsets",
    "creative", "creatives", "budget", "budgets", "spend", "roas", "ctr", "cpc", "cpm", "cpa",
    "impressions", "clicks", "conversions", "meta", "facebook", "instagram", "google ads",
  ]),
  places: Object.freeze([
    "nearby", "near me", "route", "directions", "distance", "restaurant", "restaurants",
    "cafe", "cafes", "place", "places", "map", "maps",
  ]),
  workspace: Object.freeze([
    "email", "emails", "mail", "gmail", "inbox", "draft", "drafts", "calendar", "meeting", "meetings",
    "event", "events", "drive", "file", "files", "folder", "folders", "document", "documents", "doc", "docs",
  ]),
  research: Object.freeze(["weather", "stock", "stocks", "price", "prices", "crypto", "csv", "pdf", "web"]),
  productivity: Object.freeze([
    "task", "tasks", "todo", "todos", "to-do", "to-dos", "reminder", "reminders",
    "n8n", "workflow", "workflows", "automation", "automations",
  ]),
  messaging: Object.freeze(["whatsapp"]),
  monitoring: Object.freeze(["cpu", "disk", "system status", "memory usage", "current time", "today's date"]),
  integrations: Object.freeze(["integration", "integrations", "connection", "connections", "connected", "health"]),
} as const satisfies Record<string, readonly string[]>);

/**
 * The closed marker lists. Exported so a reviewer — and a drift test — can
 * read exactly what the extractor recognises. Matching is whole-word and
 * case-insensitive; a multi-word entry matches with any run of whitespace.
 */
export const OBJECTIVE_MARKERS = Object.freeze({
  externalWrite: Object.freeze([
    "send", "pause", "resume", "stop", "launch", "activate", "deactivate", "enable", "disable",
    "connect", "disconnect", "reconnect", "configure", "update", "change", "set", "adjust",
    "increase", "decrease", "raise", "lower", "reduce", "cut", "boost", "delete", "remove", "add",
    "rename", "archive", "restore", "move", "upload", "publish", "share", "submit", "schedule",
    "book", "invite", "cancel", "trigger", "notify", "inform",
  ]),
  externalWriteHinglish: Object.freeze([
    "bhejo", "bhej do", "bhej de", "band karo", "chalu karo", "shuru karo", "roko",
    "badhao", "badha do", "kam karo", "hatao",
  ]),
  /** `tell|message|email|whatsapp` followed directly by one of `recipients` is a write. */
  recipientVerbs: Object.freeze(["tell", "message", "email", "whatsapp"]),
  recipients: Object.freeze(["my", "our", "the", "him", "her", "them"]),
  /** COMPOSE with an artifact noun in the clause, EXTERNAL_WRITE without. */
  creationVerbs: Object.freeze(["create", "make", "generate", "build", "banao", "bana do", "bana de"]),
  artifactNouns: Object.freeze([
    "report", "summary", "plan", "draft", "outline", "proposal", "strategy", "note", "notes",
    "script", "caption", "copy", "agenda", "email", "message",
  ]),
  compose: Object.freeze([
    "draft", "write", "compose", "prepare", "summarize", "summarise", "outline", "plan",
    "rewrite", "rephrase", "likho", "likh do", "taiyar karo",
  ]),
  analyze: Object.freeze([
    "analyze", "analyse", "identify", "compare", "evaluate", "assess", "diagnose", "rank",
    "recommend", "suggest", "explain", "why", "figure out",
    "weak", "weakest", "strong", "strongest", "best", "worst", "top", "bottom",
    "underperforming", "overperforming", "poor", "poorly", "better", "worse",
    "anomaly", "anomalies", "trend", "trends",
    "kyun", "kyon", "samjhao", "kharab", "accha",
  ]),
  retrieve: Object.freeze([
    "check", "show", "list", "get", "fetch", "find", "look up", "look at", "lookup", "see", "view",
    "read", "pull", "search", "status", "tell me", "give me",
    "what", "which", "who", "when", "where", "how much", "how many", "how is", "how are",
    "dikhao", "batao", "bata do", "dekho", "nikalo", "kya", "kitna", "kitne", "kaun", "kab", "kahan",
  ]),
  /** A write, compose or creation marker directly after one of these is a noun. */
  nounGuard: Object.freeze(["a", "an", "the", "any", "this", "that", "latest", "ad"]),
  negation: Object.freeze(["don't", "do not", "dont", "never", "no need to", "without", "mat", "nahi", "nahin"]),
  informationFraming: Object.freeze([
    "how do", "how can", "how to", "tell me about", "do you know", "what if",
    "should i", "can i", "could i", "is it",
  ]),
  /** A message opening with one of these keeps its write even when it ends in "?". */
  requestOpeners: Object.freeze(["can you", "could you", "would you", "will you", "please", "kindly"]),
});

/** Whole words that separate clauses, in addition to punctuation and line breaks. */
const CONJUNCTIONS = ["and", "then", "also", "plus", "aur", "phir", "fir"] as const;

// ---------------------------------------------------------------------------
// Pattern construction
//
// Every pattern is a flat alternation of literal phrases between word
// boundaries: no nested quantifiers, so matching stays linear in the length
// of the text. None carries the `g` flag, so no pattern holds state between
// calls — a global pattern's `lastIndex` would make the result depend on
// whatever ran before it.
// ---------------------------------------------------------------------------

function escapeForPattern(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One phrase: words joined by any whitespace; an apostrophe matches ' or ’. */
function phrase(entry: string): string {
  return entry
    .trim()
    .split(/\s+/)
    .map((word) => escapeForPattern(word).replace(/'/g, "['’]"))
    .join("\\s+");
}

function alternation(entries: readonly string[]): string {
  return entries.map(phrase).join("|");
}

const NOUN_GUARD = `(?<!\\b(?:${alternation(OBJECTIVE_MARKERS.nounGuard)})\\s+)`;

/**
 * A whole-word pattern over `entries`. The guard is placed AFTER the leading
 * word boundary so it is only evaluated where a word actually starts; inside a
 * long run of whitespace there is no boundary and the look-behind never runs.
 */
function wordsPattern(entries: readonly string[], guarded: boolean): RegExp {
  return new RegExp(`\\b${guarded ? NOUN_GUARD : ""}(?:${alternation(entries)})\\b`, "i");
}

const WRITE = wordsPattern(OBJECTIVE_MARKERS.externalWrite, true);
const WRITE_HINGLISH = wordsPattern(OBJECTIVE_MARKERS.externalWriteHinglish, true);
const WRITE_TO_RECIPIENT = new RegExp(
  `\\b${NOUN_GUARD}(?:${alternation(OBJECTIVE_MARKERS.recipientVerbs)})\\s+(?:${alternation(OBJECTIVE_MARKERS.recipients)})\\b`,
  "i"
);
const CREATION = wordsPattern(OBJECTIVE_MARKERS.creationVerbs, true);
const ARTIFACT = wordsPattern(OBJECTIVE_MARKERS.artifactNouns, false);
const COMPOSE = wordsPattern(OBJECTIVE_MARKERS.compose, true);
const ANALYZE = wordsPattern(OBJECTIVE_MARKERS.analyze, false);
const RETRIEVE = wordsPattern(OBJECTIVE_MARKERS.retrieve, false);
const NEGATION = wordsPattern(OBJECTIVE_MARKERS.negation, false);
const INFORMATION_FRAMING = wordsPattern(OBJECTIVE_MARKERS.informationFraming, false);
const REQUEST_OPENER = new RegExp(`^\\s*(?:${alternation(OBJECTIVE_MARKERS.requestOpeners)})\\b`, "i");

const SKILL_PATTERNS: ReadonlyArray<readonly [skill: string, pattern: RegExp]> = Object.entries(
  OBJECTIVE_SKILL_VOCABULARY
).map(([skill, words]) => [skill, wordsPattern(words, false)] as const);

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

/** The span with surrounding whitespace removed, or null when nothing is left. */
function trimmed(text: string, start: number, end: number): Span | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s]!)) s += 1;
  while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
  return s < e ? { start: s, end: e } : null;
}

/**
 * Clause spans, in order. Sentence punctuation stays with the clause it ends
 * — a trailing "?" is evidence the classifier needs — while commas, line
 * breaks and conjunctions are separators and belong to neither side.
 */
function segment(text: string): Span[] {
  const boundary = new RegExp(
    `[.!?;](?=\\s)|\\r?\\n|,|(?<=\\s)(?:${CONJUNCTIONS.join("|")})(?=\\s)`,
    "gi"
  );
  const spans: Span[] = [];
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const index = match.index!;
    const keepsPunctuation = /^[.!?;]$/.test(match[0]);
    const span = trimmed(text, start, keepsPunctuation ? index + 1 : index);
    if (span) spans.push(span);
    start = index + match[0].length;
  }
  const last = trimmed(text, start, text.length);
  if (last) spans.push(last);
  return spans;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function hasMarker(clause: string): boolean {
  return (
    WRITE.test(clause) ||
    WRITE_HINGLISH.test(clause) ||
    WRITE_TO_RECIPIENT.test(clause) ||
    CREATION.test(clause) ||
    COMPOSE.test(clause) ||
    ANALYZE.test(clause) ||
    RETRIEVE.test(clause) ||
    clause.endsWith("?")
  );
}

/**
 * The class of one (merged) clause.
 *
 * Every clause reaching here carries at least one marker. When its only
 * markers are writes that framing has ruled out ("how to disable the
 * integration"), what remains is a request to be told something — RETRIEVE,
 * the same answer the trailing-"?" rule gives a framed question.
 */
function classify(clause: string, openedWithRequest: boolean): EvidenceClass {
  const framed = INFORMATION_FRAMING.test(clause);
  const question = clause.endsWith("?");
  const writeAllowed = !framed && (!question || openedWithRequest);

  const creation = CREATION.test(clause);
  const artifact = creation && ARTIFACT.test(clause);

  if (
    writeAllowed &&
    (WRITE.test(clause) ||
      WRITE_HINGLISH.test(clause) ||
      WRITE_TO_RECIPIENT.test(clause) ||
      (creation && !artifact))
  ) {
    return "EXTERNAL_WRITE";
  }
  if (COMPOSE.test(clause) || artifact) return "COMPOSE";
  if (ANALYZE.test(clause)) return "ANALYZE";
  return "RETRIEVE";
}

function strongest(classes: readonly EvidenceClass[]): EvidenceClass {
  return EVIDENCE_CLASS_PRECEDENCE.find((c) => classes.includes(c)) ?? "RETRIEVE";
}

/** Skills named in `text`, ordered by first appearance, ties in catalogue order. */
function skillsNamedIn(text: string): string[] {
  const hits: Array<{ skill: string; at: number; order: number }> = [];
  SKILL_PATTERNS.forEach(([skill, pattern], order) => {
    const at = text.search(pattern);
    if (at >= 0) hits.push({ skill, at, order });
  });
  hits.sort((a, b) => a.at - b.at || a.order - b.order);
  return hits.map((h) => h.skill);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface Clause {
  /** The marked clause — the one whose words decided that this is an objective. */
  marked: Span;
  /** Its extent once neighbouring unmarked clauses are merged in. */
  span: Span;
}

/**
 * Objectives stated in `request`, in order.
 *
 * Pure: no I/O, no clock, no randomness, no state between calls. An empty
 * array means the request names nothing the closed lists can classify ("yes",
 * "no", "thanks") — see `extractionMissing`.
 */
export function extractObjectives(traceId: string, request: string): Objective[] {
  const text = typeof request === "string" ? request : "";

  // Merge unmarked clauses into their marked neighbour: the one before, or the
  // first one after when they lead the request.
  const clauses: Clause[] = [];
  let leading: Span | null = null;
  for (const span of segment(text)) {
    if (hasMarker(text.slice(span.start, span.end))) {
      clauses.push({ marked: span, span: { start: leading?.start ?? span.start, end: span.end } });
      leading = null;
    } else if (clauses.length > 0) {
      clauses[clauses.length - 1]!.span.end = span.end;
    } else {
      leading ??= span;
    }
  }

  // Negation is judged on the marked clause alone, so "Don't worry, check my
  // campaigns" keeps its objective while "Check my ads, don't pause anything"
  // loses only the clause it negates — together with any unmarked words that
  // merged into that clause, which belong to it.
  const openedWithRequest = REQUEST_OPENER.test(text);
  const kept = clauses
    .filter((c) => !NEGATION.test(text.slice(c.marked.start, c.marked.end)))
    .map((c) => {
      const clauseText = text.slice(c.span.start, c.span.end);
      return { text: clauseText, evidenceClass: classify(clauseText, openedWithRequest) };
    });

  if (kept.length === 0) return [];

  if (kept.length > MAX_OBJECTIVES) {
    const whole = text.trim();
    return [
      {
        objectiveId: `${traceId}#0`,
        text: whole,
        evidenceClass: strongest(kept.map((k) => k.evidenceClass)),
        skills: skillsNamedIn(whole),
      },
    ];
  }

  return kept.map((k, index) => ({
    objectiveId: `${traceId}#${index}`,
    text: k.text,
    evidenceClass: k.evidenceClass,
    skills: skillsNamedIn(k.text),
  }));
}

/**
 * The trace-level unknown an extraction leaves behind.
 *
 * A bound request that yields no objective is reported as `OBJECTIVE_CLASS`
 * missing — the request exists, but it states nothing these fixed rules can
 * classify. (An unbound trace has no request to extract from; that is
 * `REQUEST_TEXT`, and is the evaluation's to report, not this function's.)
 */
export function extractionMissing(objectives: readonly Objective[]): readonly "OBJECTIVE_CLASS"[] {
  return objectives.length === 0 ? ["OBJECTIVE_CLASS"] : [];
}
