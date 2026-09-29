// S7.2 L3 — learning validation and learning scope.
//
// L2 proves the user wrote the quoted words. L3 decides two things:
//
//   decision  does the user's own evidence establish the claim?
//             VALID    yes — eligible for storage
//             HOLD     maybe useful, not established (weak, uncertain,
//                      unclear, broader than what was said): NOT stored
//             INVALID  clearly not durable USER memory: NOT stored
//   scope     what kind of statement it is:
//             MEMORY     a durable preference, personal fact or working
//                        convention — the only scope memory ever stores
//             GOAL, TASK, PROJECT, DECISION, TEMPORARY
//                        not memory; they belong to future goal, task and
//                        project systems. L3 creates none of them.
//             UNKNOWN    anything else
//
// VALID comes only from the three durable categories L1b recognises —
// STABLE_PREFERENCE, STABLE_PERSONAL_FACT, STABLE_WORKING_CONVENTION — or
// from an explicit endorsement ("Yes, make that my default"). Every safety
// and context rule is checked before either VALID rule, so nothing lower in
// the order can override them. CLEAR → VALID; UNCLEAR → HOLD; CLEARLY NOT
// MEMORY → INVALID.
//
// Deterministic and deliberately narrow — no inference:
//   - the L1/L1b classification of the user's message, reused;
//   - a few small marker lists for goals, tasks, project state, decisions
//     and current-time scope, applied to the message and to the claim;
//   - three anchored explicit-endorsement shapes;
//   - a word check: every content word of the claim must be in the quote,
//     and — against the MESSAGE, which the model cannot trim — a negation
//     in the claim's sentence and a "my X" / "X's" subject of its clause
//     must survive.
//
// It sees the candidate only — claim, quote, the user's message and its
// provenance — never JARVIS's reply and never an existing memory, so it can
// neither be persuaded by JARVIS nor change what is already stored.
//
// Pure: no I/O, no clock, no randomness, no environment. It never throws; a
// malformed input is INVALID / MALFORMED_INPUT.

import { decideLearningCandidate, type LearningRule } from "./learning-candidate.js";
import { PROVENANCE_SOURCE_TYPES, resolveUserProvenance, type LearningProvenance } from "./learning-provenance.js";

export interface LearningValidationInput {
  /** The extraction model's claim, e.g. "User prefers short captions". */
  claim: string;
  /** The model's verbatim quote from the user's message. */
  evidence: string;
  /** The cited USER message, as saved. */
  userMessage: string;
  /** The L2 provenance of that message. */
  provenance: LearningProvenance;
}

export type LearningValidationDecision = "VALID" | "HOLD" | "INVALID";

/** What kind of statement a candidate is. Only MEMORY is ever stored. */
export const LEARNING_SCOPES = ["MEMORY", "GOAL", "TASK", "PROJECT", "DECISION", "TEMPORARY", "UNKNOWN"] as const;
export type LearningScope = (typeof LEARNING_SCOPES)[number];

/** The durable category of a direct statement (L1b's own names). */
export const LEARNING_CATEGORIES = ["STABLE_PREFERENCE", "STABLE_PERSONAL_FACT", "STABLE_WORKING_CONVENTION"] as const;
export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

/** Every rule, in the order it is checked. */
export const LEARNING_VALIDATION_RULES = [
  "MALFORMED_INPUT",
  "PROVENANCE_MISSING",
  "NOT_USER_SOURCE",
  "EVIDENCE_MISSING",
  "EVIDENCE_NOT_IN_MESSAGE",
  "USER_MESSAGE_NOT_LEARNABLE",
  "CLAIM_NOT_LEARNABLE",
  "TEMPORARY_SCOPE",
  "GOAL_OR_TASK",
  "PROJECT_OR_CURRENT_CONTEXT",
  "CURRENT_DECISION",
  "WEAK_ACKNOWLEDGEMENT",
  "UNCERTAIN_LANGUAGE",
  "GENERAL_STATEMENT",
  "NOT_ESTABLISHED",
  "CLAIM_UNSPECIFIC",
  "CLAIM_EXCEEDS_EVIDENCE",
  "CLAIM_CHANGES_MEANING",
  "CLAIM_NOT_SUPPORTED",
  "EXPLICIT_ENDORSEMENT",
  "DIRECT_USER_STATEMENT",
] as const;

export type LearningValidationRule = (typeof LEARNING_VALIDATION_RULES)[number];

export interface LearningValidationResult {
  decision: LearningValidationDecision;
  rule: LearningValidationRule;
  scope: LearningScope;
  /** Only on DIRECT_USER_STATEMENT: which durable kind of statement it is. */
  category?: LearningCategory;
}

export const LEARNING_VALIDATION_DECISIONS: Readonly<Record<LearningValidationRule, LearningValidationDecision>> = Object.freeze({
  MALFORMED_INPUT: "INVALID",
  PROVENANCE_MISSING: "INVALID",
  NOT_USER_SOURCE: "INVALID",
  EVIDENCE_MISSING: "INVALID",
  EVIDENCE_NOT_IN_MESSAGE: "INVALID",
  USER_MESSAGE_NOT_LEARNABLE: "INVALID",
  CLAIM_NOT_LEARNABLE: "INVALID",
  TEMPORARY_SCOPE: "INVALID",
  GOAL_OR_TASK: "INVALID",
  PROJECT_OR_CURRENT_CONTEXT: "INVALID",
  CURRENT_DECISION: "INVALID",
  WEAK_ACKNOWLEDGEMENT: "HOLD",
  UNCERTAIN_LANGUAGE: "HOLD",
  GENERAL_STATEMENT: "INVALID",
  NOT_ESTABLISHED: "HOLD",
  CLAIM_UNSPECIFIC: "HOLD",
  CLAIM_EXCEEDS_EVIDENCE: "HOLD",
  CLAIM_CHANGES_MEANING: "HOLD",
  CLAIM_NOT_SUPPORTED: "INVALID",
  EXPLICIT_ENDORSEMENT: "VALID",
  DIRECT_USER_STATEMENT: "VALID",
});

/** The scope(s) each rule can report. VALID rules report MEMORY only. */
const SCOPES_OF: Readonly<Record<LearningValidationRule, readonly LearningScope[]>> = Object.freeze({
  MALFORMED_INPUT: ["UNKNOWN"],
  PROVENANCE_MISSING: ["UNKNOWN"],
  NOT_USER_SOURCE: ["UNKNOWN"],
  EVIDENCE_MISSING: ["UNKNOWN"],
  EVIDENCE_NOT_IN_MESSAGE: ["UNKNOWN"],
  USER_MESSAGE_NOT_LEARNABLE: ["UNKNOWN"],
  CLAIM_NOT_LEARNABLE: ["UNKNOWN"],
  TEMPORARY_SCOPE: ["TEMPORARY"],
  GOAL_OR_TASK: ["GOAL", "TASK"],
  PROJECT_OR_CURRENT_CONTEXT: ["PROJECT"],
  CURRENT_DECISION: ["DECISION"],
  WEAK_ACKNOWLEDGEMENT: ["UNKNOWN"],
  UNCERTAIN_LANGUAGE: ["UNKNOWN"],
  GENERAL_STATEMENT: ["UNKNOWN"],
  NOT_ESTABLISHED: ["UNKNOWN"],
  CLAIM_UNSPECIFIC: ["MEMORY"],
  CLAIM_EXCEEDS_EVIDENCE: ["MEMORY"],
  CLAIM_CHANGES_MEANING: ["MEMORY"],
  CLAIM_NOT_SUPPORTED: ["MEMORY"],
  EXPLICIT_ENDORSEMENT: ["MEMORY"],
  DIRECT_USER_STATEMENT: ["MEMORY"],
});

/**
 * True only for a well-formed result: a known rule with that rule's decision,
 * one of that rule's scopes, and a known category exactly when the rule is
 * DIRECT_USER_STATEMENT.
 */
export function isLearningValidationResult(value: unknown): value is LearningValidationResult {
  if (typeof value !== "object" || value === null) return false;
  const { decision, rule, scope, category } = value as Record<string, unknown>;
  if (typeof rule !== "string" || !Object.prototype.hasOwnProperty.call(LEARNING_VALIDATION_DECISIONS, rule)) return false;
  const known = rule as LearningValidationRule;
  if (LEARNING_VALIDATION_DECISIONS[known] !== decision) return false;
  if (!(SCOPES_OF[known] as readonly unknown[]).includes(scope)) return false;
  if (known === "DIRECT_USER_STATEMENT") return (LEARNING_CATEGORIES as readonly unknown[]).includes(category);
  return category === undefined;
}

// ---------------------------------------------------------------------------
// What L1/L1b already says
// ---------------------------------------------------------------------------

/** L1 refuses these outright; nothing from such a message is ever learned. */
const NOT_LEARNABLE: ReadonlySet<LearningRule> = new Set<LearningRule>([
  "EMPTY_STATEMENT",
  "CONTAINS_SECRET",
  "GRANTS_AUTHORIZATION",
  "ORIGIN_UNKNOWN",
  "ASSISTANT_ONLY_CLAIM",
  "QUESTION_ONLY",
  "USER_MEMORY_VETO",
  "PERMISSION_LANGUAGE",
]);
const UNCERTAIN: ReadonlySet<LearningRule> = new Set<LearningRule>(["AMBIGUOUS_PREFERENCE", "HYPOTHETICAL_STATEMENT"]);
const TEMPORARY: ReadonlySet<LearningRule> = new Set<LearningRule>(["TEMPORARY_INSTRUCTION", "ONE_OFF_CONTEXT"]);

function l1(statement: string): LearningRule {
  return decideLearningCandidate({ statement, statedBy: "USER" }).rule;
}

function categoryOf(rule: LearningRule): LearningCategory | null {
  return (LEARNING_CATEGORIES as readonly string[]).includes(rule) ? (rule as LearningCategory) : null;
}

/** A claim is never learnable if L1 would refuse it as a statement: a secret, a grant, a temporary scope, permission language. */
function claimIsUnlearnable(claim: string): boolean {
  const { decision, rule } = decideLearningCandidate({ statement: claim, statedBy: "USER" });
  return decision === "REJECT" || decision === "NOT_A_CANDIDATE" || rule === "PERMISSION_LANGUAGE";
}

// ---------------------------------------------------------------------------
// Learning scope — small marker lists, applied to the message AND the claim
// ---------------------------------------------------------------------------

function anyMatch(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

function sentencesOf(text: string): string[] {
  return text
    .split(/[.!?;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Current-time wording L1 does not already treat as one-off. */
const CURRENT_TIME = /\b(?:currently|at\s+the\s+moment|for\s+the\s+time\s+being|as\s+of\s+now|nowadays)\b/i;

function isTemporary(text: string, rule: LearningRule): boolean {
  return TEMPORARY.has(rule) || CURRENT_TIME.test(text);
}

/** An intention to do something: "I want to …", "we plan to …", "my goal is …". */
const GOAL_MARKERS: readonly RegExp[] = [
  /\b(?:want|wants|wanted|need|needs|have|has|plan|plans|planning|hope|hopes|hoping|aim|aims|aiming|intend|intends|intending|try|tries|trying|wish|wishes|going|would\s+like|'d\s+like|would\s+love|'d\s+love)\s+to\s+(?!be\b)[a-z]/i,
  /\b(?:my|our|the|user's|their)\s+(?:main\s+|primary\s+|big\s+|next\s+)?(?:goal|target|objective|ambition|plan)s?\b/i,
];

/** A one-time thing to do: a sentence that opens with an action, with nothing that makes it standing. */
const TASK_OPENER =
  /^(?:(?:ok(?:ay)?|yes|yeah|sure|please|pls|hey|jarvis)[,!]?\s+)*(?:please\s+)?(?:remind|send|create|fix|call|book|schedule|draft|publish|buy|finish|complete|submit|email|pay|order|cancel|delete|upload|launch|check|review|arrange|contact|forward|ping|text|follow\s+up|set\s+up)\b/i;
const STANDING = /\b(?:always|never|every|daily|weekly|monthly|by\s+default|from\s+now\s+on|going\s+forward|whenever|as\s+a\s+rule|in\s+general|usually|regularly)\b/i;
const TASK_WORDS = /\b(?:remind(?:er|ers|ed)?|to-?do|task)\b/i;

function isTask(text: string): boolean {
  return TASK_WORDS.test(text) || sentencesOf(text).some((s) => TASK_OPENER.test(s) && !STANDING.test(s));
}

function goalOrTask(text: string): "GOAL" | "TASK" | null {
  if (isTask(text)) return "TASK";
  if (anyMatch(GOAL_MARKERS, text)) return "GOAL";
  return null;
}

/** State of a particular project, client, campaign or product. */
const PROJECT_MARKERS: readonly RegExp[] = [
  /\b(?:the|this|that|current)\s+(?:current\s+)?(?:project|client|campaign|app|application|website|site|product|codebase|repo|repository|stack|sprint|release|backend|frontend|database|server)\b/i,
  /\b(?:my|our|user's|client's)\s+(?:current\s+)?(?:project|client|campaign|codebase|repo|repository|sprint|release)\b/i,
];

/** A choice made now, for now. */
const DECISION_MARKERS: readonly RegExp[] = [
  /\b(?:decided|decide|decides|decision|chose|chosen|picked|opted|settled\s+on|went\s+with|going\s+with|go\s+with|goes\s+with|stick\s+with|sticking\s+with)\b/i,
  /\b(?:i|we|user)(?:'ll|\s+will|\s+shall)\s+(?:use|go|pick|choose|take|switch|move)\b/i,
  /\blet'?s\s+(?:use|go|pick|choose|take|switch|do)\b/i,
  /\b(?:switching|switched)\s+to\b/i,
];

/** Something someone else said about the user: "JARVIS says I …", "you said I …", "my boss thinks I …". */
const SECOND_HAND =
  /\b(?!(?:i|we|that|which|who|it|to)\b)[a-z]+\s+(?:say|says|said|thinks|thought|told\s+me|tells\s+me|mentioned|claims|claimed|suggested|suggests)\b/i;

// ---------------------------------------------------------------------------
// Weak acknowledgement — L1's own acknowledgement rule, applied to each part
// of the message ("Thanks, sounds good." is two), plus a few it does not list.
// ---------------------------------------------------------------------------

const MORE_ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set([
  "looks good",
  "looks great",
  "looks fine",
  "sounds great",
  "sounds fine",
  "sounds good to me",
  "that sounds good",
  "that sounds great",
  "that works",
  "that works for me",
  "works for me",
  "that's fine",
  "that's great",
  "all good",
  "makes sense",
]);

function isAcknowledgement(part: string): boolean {
  const text = part.replace(/\s+/g, " ").trim().toLowerCase().replace(/[‘’ʼ]/g, "'");
  return MORE_ACKNOWLEDGEMENTS.has(text) || l1(part) === "ACKNOWLEDGEMENT_ONLY";
}

function isWeakAcknowledgement(message: string, rule: LearningRule): boolean {
  if (rule === "ACKNOWLEDGEMENT_ONLY") return true;
  const parts = message
    .split(/[,.!;:]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every(isAcknowledgement);
}

// ---------------------------------------------------------------------------
// Explicit endorsement — the WHOLE message must be one of these, so nothing
// can ride along ("… for this campaign", "maybe …", "don't …").
// ---------------------------------------------------------------------------

const YES = "(?:(?:yes|yeah|yep|yup|ok|okay|sure|perfect|great|haan|ji)[,!.]?\\s+)?";
const PLEASE = "(?:please\\s+)?";
const REF = "(?:that|it)"; // "this" is the current item (L1: one-off), never a standing default
const TARGET = "(?:my|the)\\s+(?:new\\s+)?(?:default|preference|standard)";

const ENDORSEMENTS: readonly RegExp[] = [
  new RegExp(`^${YES}${PLEASE}(?:make|set|keep)\\s+${REF}\\s+(?:as\\s+)?${TARGET}$`), // "yes, make that my default"
  new RegExp(`^${YES}${REF}(?:'s|\\s+is)\\s+${TARGET}$`), // "that's my preference"
  new RegExp(`^${YES}${PLEASE}remember\\s+${REF}\\s+as\\s+${TARGET}$`), // "remember that as my default"
];

function isExplicitEndorsement(message: string): boolean {
  const text = message
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!\s]+$/, "");
  return ENDORSEMENTS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// The durable category of a direct statement — L1b's, for the message, or for
// what follows a plain opener ("Thanks! I prefer …", "Actually, I prefer …").
// ---------------------------------------------------------------------------

const OPENERS: ReadonlySet<string> = new Set([
  "actually",
  "also",
  "so",
  "well",
  "btw",
  "by the way",
  "fyi",
  "honestly",
  "oh",
  "and",
  "anyway",
  "plus",
  "just so you know",
  "for the record",
  "one more thing",
]);

function durableCategory(message: string): LearningCategory | null {
  let rest = message.trim();
  for (;;) {
    const category = categoryOf(l1(rest));
    if (category) return category;
    const lead = /^([^.!?;,]+)[.!?;,]+\s*/.exec(rest);
    if (!lead || lead[0].length >= rest.length) return null;
    const opener = lead[1]!.trim();
    if (!OPENERS.has(opener.toLowerCase()) && !isAcknowledgement(opener)) return null;
    rest = rest.slice(lead[0].length);
  }
}

// ---------------------------------------------------------------------------
// Word check — the claim must stay inside the user's own words.
// ---------------------------------------------------------------------------

/** Words that only frame a claim ("User's …", "… is …") and carry no content of their own. */
const FRAMING: ReadonlySet<string> = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "at", "by", "with", "as", "and", "or", "from", "into", "about",
  "is", "are", "was", "were", "be", "been", "being", "am", "has", "have", "had", "do", "does", "did",
  "user", "users", "they", "them", "their", "theirs", "he", "him", "his", "she", "her", "hers", "it", "its",
  "i", "i'm", "i've", "i'd", "i'll", "me", "my", "mine", "myself", "we", "we're", "we've", "us", "our", "ours",
  "that", "this", "which", "who",
]);
/** Liking something, in any of its usual words, counts as one word. */
const PREFERENCE_WORDS: ReadonlySet<string> = new Set([
  "prefer", "prefers", "preferred", "preference", "preferences", "like", "likes", "liked", "love", "loves", "loved",
  "want", "wants", "wanted", "favor", "favors", "favour", "favours", "favorite", "favourite", "enjoy", "enjoys", "pasand",
]);
/** So does negation. */
const NEGATION_WORDS: ReadonlySet<string> = new Set([
  "not", "no", "never", "don't", "dont", "doesn't", "doesnt", "didn't", "didnt", "won't", "can't", "cannot",
  "isn't", "aren't", "wasn't", "weren't", "nahi", "nahin", "mat",
]);
const PREFER = "<prefer>";
const NOT = "<not>";

function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** One word as the claim check sees it: a stem, <prefer>, <not>, or null for a framing word. */
function term(word: string): string | null {
  const base = word.endsWith("'s") ? word.slice(0, -2) : word;
  if (NEGATION_WORDS.has(word) || NEGATION_WORDS.has(base)) return NOT;
  if (PREFERENCE_WORDS.has(base)) return PREFER;
  if (FRAMING.has(word) || FRAMING.has(base)) return null;
  return stem(base);
}

function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of words(text)) {
    const t = term(word);
    if (t) out.add(t);
  }
  return out;
}

/**
 * Whose statement a clause is, when it names someone other than the user:
 * "My boss is …" → boss, "My boss's favourite …" → boss. The claim must keep
 * it, or "My boss is strict" would support "User is strict".
 */
function subjectOf(clause: string): string | null {
  const [first, ...rest] = words(clause);
  if (!first) return null;
  let subject: string | null = null;
  if (first === "my" || first === "our") subject = rest.map(term).find((t) => t !== null) ?? null;
  else if (first.endsWith("'s") && !FRAMING.has(first.slice(0, -2))) subject = term(first);
  return subject === NOT ? null : subject;
}

/**
 * Does the claim change what the user said, in the part of the message it
 * comes from? Checked against the MESSAGE, not the quote, which the model
 * chooses and could trim:
 *   - a negation in the sentence the claim draws on must be kept
 *     ("I don't like X" never supports "User likes X");
 *   - the named subject of the clause it draws on must be kept.
 * A sentence ends at . ! ? ; or "but"; a clause also at a comma or "and".
 */
function changesMeaning(claimed: Set<string>, specific: string[], message: string): boolean {
  const drawsOn = (text: string) => {
    const t = terms(text);
    return specific.some((s) => t.has(s));
  };
  for (const sentence of message.split(/[.!?;]+|\bbut\b/i)) {
    if (!drawsOn(sentence)) continue;
    if (terms(sentence).has(NOT) && !claimed.has(NOT)) return true;
    for (const clause of sentence.split(/,|\band\b/i)) {
      if (!drawsOn(clause)) continue;
      const subject = subjectOf(clause);
      if (subject && !claimed.has(subject)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function provenanceIsWellFormed(value: unknown): value is LearningProvenance {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    (PROVENANCE_SOURCE_TYPES as readonly unknown[]).includes(p.sourceType) &&
    nonBlank(p.sourceConversationId) &&
    nonBlank(p.sourceMessageId) &&
    (p.sourceTraceId === undefined || typeof p.sourceTraceId === "string")
  );
}

type Verdict = { rule: LearningValidationRule; scope: LearningScope; category?: LearningCategory };

function verdict(rule: LearningValidationRule, scope: LearningScope = "UNKNOWN", category?: LearningCategory): Verdict {
  return category ? { rule, scope, category } : { rule, scope };
}

function verdictFor(input: unknown): Verdict {
  // 1–5 — the input, its provenance, its evidence.
  if (typeof input !== "object" || input === null || Array.isArray(input)) return verdict("MALFORMED_INPUT");
  const { claim, evidence, userMessage, provenance } = input as Record<string, unknown>;
  if (!nonBlank(claim) || typeof userMessage !== "string") return verdict("MALFORMED_INPUT");
  if (!provenanceIsWellFormed(provenance)) return verdict("PROVENANCE_MISSING");
  if (provenance.sourceType !== "USER") return verdict("NOT_USER_SOURCE");
  // The L2 guarantee, re-checked with L2's own contract: the quote is really in the message.
  const quote = resolveUserProvenance({ source: "Q", evidence }, [
    {
      ref: "Q",
      sourceType: "USER",
      statement: userMessage,
      sourceConversationId: provenance.sourceConversationId,
      sourceMessageId: provenance.sourceMessageId,
    },
  ]);
  if (!quote.accepted) return verdict(quote.reason === "EVIDENCE_NOT_IN_SOURCE" ? "EVIDENCE_NOT_IN_MESSAGE" : "EVIDENCE_MISSING");
  const said = evidence as string;

  // 6–7 — safety: L1/L1b/L1c stay authoritative, for the message and the claim.
  const message = l1(userMessage);
  if (NOT_LEARNABLE.has(message)) return verdict("USER_MESSAGE_NOT_LEARNABLE");
  if (claimIsUnlearnable(claim)) return verdict("CLAIM_NOT_LEARNABLE");

  // 8–11 — scope: not memory at all, whatever else the statement is.
  if (isTemporary(userMessage, message) || isTemporary(claim, l1(claim))) return verdict("TEMPORARY_SCOPE", "TEMPORARY");
  const aim = goalOrTask(userMessage) ?? goalOrTask(claim);
  if (aim) return verdict("GOAL_OR_TASK", aim);
  if (anyMatch(PROJECT_MARKERS, userMessage) || anyMatch(PROJECT_MARKERS, claim)) return verdict("PROJECT_OR_CURRENT_CONTEXT", "PROJECT");
  if (anyMatch(DECISION_MARKERS, userMessage) || anyMatch(DECISION_MARKERS, claim)) return verdict("CURRENT_DECISION", "DECISION");

  // 12–14 — not established, or not about the user.
  if (isWeakAcknowledgement(userMessage, message)) return verdict("WEAK_ACKNOWLEDGEMENT");
  if (UNCERTAIN.has(message)) return verdict("UNCERTAIN_LANGUAGE");
  if (message === "GENERAL_STATEMENT" || SECOND_HAND.test(userMessage)) return verdict("GENERAL_STATEMENT");

  // 15 — a durable statement L1b recognises, or an explicit endorsement.
  const endorsed = isExplicitEndorsement(userMessage);
  const category = endorsed ? null : durableCategory(userMessage);
  if (!endorsed && !category) return verdict("NOT_ESTABLISHED");

  // 16–19 — the claim against the user's words. An endorsement's claim comes
  // from the context it endorses, so only 16 applies to it.
  const claimed = terms(claim);
  const quoted = terms(said);
  const specific = [...claimed].filter((t) => t !== PREFER && t !== NOT);
  if (specific.length === 0) return verdict("CLAIM_UNSPECIFIC", "MEMORY");
  if (category) {
    const supported = specific.some((t) => quoted.has(t));
    if (supported && [...claimed].some((t) => !quoted.has(t))) return verdict("CLAIM_EXCEEDS_EVIDENCE", "MEMORY");
    if (supported && changesMeaning(claimed, specific, userMessage)) return verdict("CLAIM_CHANGES_MEANING", "MEMORY");
    if (!supported) return verdict("CLAIM_NOT_SUPPORTED", "MEMORY");
    // 21
    return verdict("DIRECT_USER_STATEMENT", "MEMORY", category);
  }
  // 20
  return verdict("EXPLICIT_ENDORSEMENT", "MEMORY");
}

/**
 * Decides whether the user's own evidence establishes a durable memory.
 * Deterministic and pure; never throws; the result names a rule and a scope,
 * never text.
 */
export function validateLearningCandidate(input: LearningValidationInput): LearningValidationResult {
  const { rule, scope, category } = verdictFor(input);
  return category
    ? { decision: LEARNING_VALIDATION_DECISIONS[rule], rule, scope, category }
    : { decision: LEARNING_VALIDATION_DECISIONS[rule], rule, scope };
}
