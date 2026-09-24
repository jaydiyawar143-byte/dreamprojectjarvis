// ---------------------------------------------------------------------------
// Write-intent gate — BUG-INTENT-001 / BUG-SAFETY-001.
//
// Decides ONE thing, in front of ANY side-effecting tool call in the chat
// path: did the user actually ask for this write? A statement of context —
// "My project budget is ₹50,000" — must never become a pending action or an
// approval request, and with this gate it cannot. The LLM inside the agent is
// the one that decides what tool to call, and a contextual statement is
// exactly the input that has been observed to summon `budget.update` with no
// request behind it.
//
// This is a PURE heuristic — no model call, no network, no I/O. It sits
// beside the other pure detectors (`intent-detector.ts`,
// `work-request-detector.ts`) and reuses their proven signals.
//
// THE VERDICTS:
//
//   ACTION      the message instructs this write. Proceed to the existing
//               permission / pending-action / approval gates unchanged.
//
//   AMBIGUOUS   the message touches the thing being written but does not
//               clearly instruct it, or hedges the instruction with
//               uncertainty. The write does NOT run; the agent asks for a
//               real instruction.
//
//   INFO        the message is a statement, a question, or a planning request
//               (a declared fact, "what is", "kya hai", "prepare/plan"). The
//               write does NOT run; the agent answers conversationally.
//
// THE DEFAULT IS "DO NOT WRITE". Uncertainty and unasked writes resolve to
// AMBIGUOUS/INFO — never to ACTION. A write we refuse is a conversation that
// behaves as before plus a clarifying question; a write we wrongly allow is a
// side-effect nobody requested. That asymmetry is the safety argument, and it
// is the same default-as-no philosophy as `work-request-detector.ts`.
// ---------------------------------------------------------------------------

import { CONFIRM_PATTERNS } from "./intent-detector.js";

export type WriteIntentVerdict =
  | { verdict: "ACTION" }
  | { verdict: "AMBIGUOUS"; reason: "hedged" | "underspecified" | "relevant" }
  | {
      verdict: "INFO";
      reason: "declarative" | "question" | "planning" | "irrelevant";
    };

/**
 * Direct write verbs, English. A CLOSED list, kept deliberately narrower than
 * "everything that could possibly mutate something": each entry is a verb
 * whose simple imperative is a side-effecting action on a running system.
 * "Think about it" verbs — prepare, plan, draft, propose, recommend — are
 * excluded on purpose and live in PLAN_VERBS, never here.
 */
const ACTION_VERBS =
  "change|update|modify|set|adjust|revise|edit|alter|amend|increase|decrease|" +
  "raise|lower|reduce|cut|boost|bump|double|halve|reset|pause|resume|start|stop|" +
  "activate|deactivate|enable|disable|connect|disconnect|reconnect|configure|" +
  "deploy|rollout|release|" +
  "send|create|make|delete|remove|add|rename|archive|restore|publish|share|submit|" +
  "trigger|run|execute|launch|click|open|close|approve|do|tell|inform|notify|message";

/**
 * Information-request framings that must beat a coincidental instruction:
 * "tell me about the campaign", "show me the budget", "update me on the
 * project", "how do I change the budget?", "do you know…". The user is asking
 * to be told, not ordering the write. Checked BEFORE the imperative test so
 * the new tell/show/update/do verbs never demote these to ACTION.
 */
const INFO_FRAMING =
  /\b(?:tell|show|brief|update|inform|notify|explain|describe)\s+(?:me|us)\b|\b(?:do|could|would|will)\s+(?:you|i|we|they)\s+(?:know|have|need|want)\b|\bhow\s+(?:do|does|can|could|would|should|to)\b/i;

/**
 * A write verb in IMPERATIVE POSITION — the strongest instruction signal.
 * The same positional grammar as `work-request-detector.ts`: a verb that opens
 * the message or a clause ("and then set…", "…, resume it") reads as an order,
 * while a verb merely sitting inside a sentence may be a mention or part of a
 * statement ("and change is expected" is not an instruction, so a verb
 * immediately followed by a copula or "will" is rejected).
 */
const WRITE_IMPERATIVE = new RegExp(
  `(?:^|[.;!]\\s+|,\\s*(?:and|then|aur|phir)?\\s*|\\b(?:and|then|please|kindly|ab|now)\\s+)` +
    `(?:please\\s+|kindly\\s+)?(?:${ACTION_VERBS})\\b` +
    `(?!\\s+(?:is|are|was|were|has|have|had|being|will)\\b)`,
  "i"
);

/** An action verb ANYWHERE. Used only with a request opener, never alone. */
const ACTION_VERB_ANYWHERE = new RegExp(`\\b(?:${ACTION_VERBS})\\b`, "i");

/**
 * Explicit request openers. "Can you set…", "please set…", "I want to set…"
 * are requests, not statements — but only count as instructions when an
 * action verb actually follows.
 */
const REQUEST_OPENER =
  /^\s*(?:please|kindly|plz|pls|can\s+i|can\s+you|could\s+i|could\s+you|will\s+you|would\s+you|i\s+would\s+like|i\s+want|i\s+need|i\s+want\s+you\s+to|i\s+need\s+you\s+to)\b/i;

/**
 * Hinglish imperatives. Commands wherever they appear, mirroring the work
 * detector's HINGLISH_IMPERATIVE — Hindi verbs sit at the END of the clause
 * ("Meta mein campaign pause kar do").
 */
const HINGLISH_IMPERATIVE =
  /\b(?:karo|kar\s+do|kar\s+de|banao|bana\s+do|bana\s+de|bhejo|bhej\s+do|badhao|badha\s+do|kam\s+karo|kam\s+kar\s+do|band\s+karo|chalu\s+karo|shuru\s+karo|roko|pause\s+karo|resume\s+karo|set\s+karo|change\s+karo|update\s+karo|delete\s+karo|create\s+karo|send\s+karo|add\s+karo|remove\s+karo|connect\s+karo|disconnect\s+karo|enable\s+karo|disable\s+karo|submit\s+karo|save\s+karo|approve\s+karo|cancel\s+karo)\b/i;

/**
 * Planning / preparation verbs want a RECOMMENDATION, not an action:
 * "prepare a campaign", "draft a plan", "what should I plan?". Only consulted
 * when no hard instruction is present, so "change the plan's budget to X"
 * still routes as ACTION and past-tense "created" statements stay facts.
 */
const PLAN_VERBS =
  "prepare|plan|propose|draft|recommend|suggest|outline|brainstorm|strategize|blueprint|present";
const PLAN_SIGNALS = new RegExp(`\\b(?:${PLAN_VERBS})\\b`, "i");

/**
 * Uncertainty content words. Consulted ONLY when a hard instruction already
 * exists, so a hedge demotes it ("change it, maybe" -> AMBIGUOUS) but a
 * request-opener modal ("can/could you change…") is never mistaken for one.
 */
const HEDGE =
  /\b(?:maybe|perhaps|possibly|probably|ideally|hoping|hopefully|not\s+sure|what\s+if|i\s+guess|thinking\s+of|thinking\s+about|considering|contemplating|if\s+it'?s\s+not\s+too\s+much)\b/i;

/**
 * Informational openers — a question or an explanation request. Reuses the
 * shape of `work-request-detector.ts`'s INFORMATION_SIGNALS. A message with
 * one of these and no hard instruction is answered, not executed.
 */
const QUESTION_SIGNALS =
  /^\s*(?:what|why|how|when|where|who|which|should\s+i|shall\s+i|can\s+i|could\s+i|is\s+it|explain|define|describe|tell\s+me|kya|kaise|kyun|kab|kahan|kaun|samjhao|batao)\b|\b(?:what\s+is|what\s+are|how\s+much|how\s+many|kya\s+ha[ie])\b/i;

/**
 * Declarative fact: a subject ("my project budget", "the campaign") followed
 * within a short window by a copula / ownership / naming verb, or a bare
 * first-person preference statement ("I prefer concise reports").
 *
 * "My Meta campaign has a monthly budget of ₹50,000" is the exact shape of the
 * observed unintended write. It is a fact, and only a fact.
 */
const DECLARATIVE_FACT =
  /\b(?:my|our|its|their|his|her|the|this|that|it|project|account|campaign|company|test)\b.{0,60}\b(?:is|are|was|were|has|have|had|named|called|stands?\s+at|sits?\s+at|is\s+set|is\s+set\s+to|hai)\b|\bi\s+(?:prefer|like|would\s+like)\b/i;

/**
 * Something a write tool can act on — the subject of a write. Used twice:
 * once to prove a hard instruction HAS a target (ACTION), and once to decide
 * that an instruction-less message is ABOUT an entity (AMBIGUOUS) rather
 * than irrelevant (INFO).
 */
const WRITABLE_ENTITY =
  /\b(?:campaign|campaigns|ad\s+set|adsets?|ad|ads|budget|spend|daily\s+budget|monthly\s+budget|annual\s+budget|ad\s+account|account|page|lead\s+form|audience|targeting|creative|name|status|schedule|objective|bidding|bid|placement|copy|image|video|post|comment|message|template|email|mail|document|doc|file|folder|sheet|report|event|meeting|calendar|contact|customer|client|recipient|list|segment|tag|workflow|trigger|sync|cron|automation|task|project|integration|connection|credential|google|meta|facebook|instagram|whatsapp|gmail|n8n)\b/i;

/**
 * A target for the write: the named entity ("Create a campaign named Test"),
 * a pronoun standing in for one, a concrete value ("₹50,000", "to 50k/day"),
 * or a prepositional object ("deploy to prod", "send a draft for the
 * client"). A command with none of these has no object and must be asked
 * about.
 */
const HAS_TARGET = new RegExp(
  `${WRITABLE_ENTITY.source}` +
    `|\\b(?:it|this|that|them|these|those|things?)\\b` +
    `|\\d` +
    `|(?:₹|rs\\.?|inr|usd|eur|gbp|[$€£])` +
    `|\\b(?:to|for|on|into|at|from|under)\\s+(?:[a-z][a-z0-9_-]*(?:\\s+[a-z0-9_-]+){0,2})\\b`,
  "i"
);

/**
 * Classify whether a chat message instructs the given side-effecting action.
 *
 * `message` is the ORIGINAL user turn, verbatim — never the composed prompt
 * passed to the model and never a string the model generated. `toolId` is
 * carried for audit/reporting context only; it does not influence the verdict.
 */
export function classifyWriteIntent(message: string): WriteIntentVerdict {
  const trimmed = message.trim();
  if (trimmed.length === 0) return { verdict: "INFO", reason: "irrelevant" };

  const imperative = WRITE_IMPERATIVE.test(trimmed);
  const hinglish = HINGLISH_IMPERATIVE.test(trimmed);
  const requested =
    REQUEST_OPENER.test(trimmed) && ACTION_VERB_ANYWHERE.test(trimmed);
  const hasStrongAction = imperative || hinglish || requested;

  // Confirmations — "yes", "haan kar do", "go ahead", "please do", "sure" —
  // are consent to an action the assistant already proposed. Same signal
  // `intent-detector.ts` trusts for pending actions, checked FIRST so a
  // consent that also reads as a bare imperative ("haan kar do") stays an
  // authorization and is not demoted to "underspecified".
  for (const pattern of CONFIRM_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { verdict: "ACTION" };
    }
  }

  // Information-request framings beat a coincidental verb: the user asked to
  // be TOLD about something ("tell me about the campaign", "how do I change
  // the budget?", "do you know…"). Answer, do not act.
  if (INFO_FRAMING.test(trimmed)) {
    return { verdict: "INFO", reason: "question" };
  }

  // A hard instruction exists: this is a command-shaped turn. The only
  // remaining questions are whether it is hedged and whether it names a
  // target. Neither resolves to ACTION silently.
  if (hasStrongAction) {
    if (HEDGE.test(trimmed)) {
      return { verdict: "AMBIGUOUS", reason: "hedged" };
    }
    if (!HAS_TARGET.test(trimmed)) {
      return { verdict: "AMBIGUOUS", reason: "underspecified" };
    }
    return { verdict: "ACTION" };
  }

  // No hard instruction. Planning and question turns are answered, facts are
  // acknowledged, entity-adjacent musings are asked about.
  if (PLAN_SIGNALS.test(trimmed)) {
    return { verdict: "INFO", reason: "planning" };
  }

  if (QUESTION_SIGNALS.test(trimmed) || trimmed.endsWith("?")) {
    return { verdict: "INFO", reason: "question" };
  }

  if (DECLARATIVE_FACT.test(trimmed)) {
    return { verdict: "INFO", reason: "declarative" };
  }

  if (WRITABLE_ENTITY.test(trimmed) || /\d/.test(trimmed)) {
    // "The campaign budget should be ₹50,000" — a value and a wish, no
    // command. Relevant but uncommitted: ask rather than act.
    return { verdict: "AMBIGUOUS", reason: "relevant" };
  }

  return { verdict: "INFO", reason: "irrelevant" };
}