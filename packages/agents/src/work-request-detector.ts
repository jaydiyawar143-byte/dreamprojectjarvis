// ---------------------------------------------------------------------------
// Work-request detection — Task Planner V1.1.
//
// Answers one narrow question about a chat message: is the user asking JARVIS
// to DO something, or asking it something?
//
// A pure heuristic detector, no model call — the same shape as
// `intent-detector.ts`, which already decides CONFIRM / REJECT / MODIFY for a
// pending action. This is deliberately NOT an intent classifier: it recognises
// a small, closed set of imperative work verbs and refuses everything else.
//
// THE DEFAULT IS "NO". Every message that does not clearly ask for work falls
// through to the existing chat path untouched. That asymmetry is the whole
// safety argument: a missed action is a conversation that behaves exactly as
// it did yesterday, while a false positive is JARVIS running a tool nobody
// asked it to run. So the rules below are written to under-trigger.
//
// THREE OUTCOMES:
//
//   EXECUTE    an unambiguous imperative — "check digitalonebox.com"
//   PLAN_ONLY  an imperative the user explicitly does NOT want run —
//              "iska plan banao, execute mat karo"
//   NONE       everything else, including anything ambiguous
//
// "Ambiguous" resolves to NONE, never to EXECUTE. "Website ka response?" names
// a subject and no action; it is a question, and a question is answered.
// ---------------------------------------------------------------------------

export type WorkRequest =
  | { type: "EXECUTE"; goal: string }
  | { type: "PLAN_ONLY"; goal: string }
  | { type: "NONE" };

/**
 * Imperative work verbs, English and Hinglish.
 *
 * A CLOSED list on purpose. Widening it is a deliberate act with a test, not
 * something that happens because a synonym felt obvious — every entry here is
 * a word that can start a tool call.
 */
const ACTION_WORDS =
  "check|fetch|analyse|analyze|research|send|generate|run|test|verify|monitor|download|summarise|summarize|scan|inspect|lookup";

/** An action word ANYWHERE. A loose gate, used only where nothing runs. */
const MENTIONS_ACTION = new RegExp(
  `\\b(?:${ACTION_WORDS})\\b|\\b(?:karo|kar\\s+do|bhejo|nikalo|chalao|dekho)\\b`,
  "i"
);

/**
 * An action word in IMPERATIVE POSITION — the strict gate, and the only one
 * that can lead to something running.
 *
 * English imperatives open a sentence or a clause ("check X", "… and check
 * X"). Hinglish puts the imperative at the end ("… check karo"), so those
 * verbs count wherever they sit.
 *
 * The distinction separates an instruction from a mention. "I was reading
 * about web.fetch today" contains `fetch` and is not an order — an earlier
 * draft of this detector executed on it, and the negative test in
 * task-conversation-v11 is what caught that.
 */
const IMPERATIVE = new RegExp(
  `(?:^|[.;!]\\s+|,\\s*(?:and|then|aur|phir)\\s+|\\b(?:and|then|please|kindly|ab|now)\\s+)` +
    `(?:please\\s+|kindly\\s+)?(?:${ACTION_WORDS})\\b`,
  "i"
);

/** Hinglish imperative markers. Commands wherever they appear. */
const HINGLISH_IMPERATIVE = /\b(karo|kar\s+do|bhejo|nikalo|chalao|dekho)\b/i;

/**
 * "Plan it, don't run it."
 *
 * Checked BEFORE the execute decision, so an explicit refusal to execute
 * always wins over the imperative that sits beside it in the same sentence.
 */
const PLAN_ONLY_SIGNALS =
  /(\bplan\s+(banao|bana\s+do|karo|kar\s+do|only|first)\b|\bonly\s+plan\b|\bjust\s+plan\b|\bdon'?t\s+execute\b|\bdo\s+not\s+execute\b|\bexecute\s+mat\b|\bmat\s+karo\b|\bwithout\s+executing\b|\bplan\s+it\b|\bka\s+plan\b|\bplan\s+bana\b)/i;

/**
 * Interrogative and explanatory openers.
 *
 * "How do I check a website?" contains `check` and is a question about doing,
 * not an instruction to do. These suppress EXECUTE entirely.
 */
const INFORMATION_SIGNALS =
  /(^\s*(what|why|how|when|where|who|which|explain|define|describe|tell me|can you explain|kya|kaise|kyun|kab|kahan|kaun|samjhao|batao\s+ki)\b|\bwhat\s+is\b|\bhow\s+does\b|\bhow\s+do\s+i\b|\bkya\s+ha[ie]\b|\bkaise\s+kaam\b)/i;

/**
 * "Create a task to …".
 *
 * Deliberately NOT treated as work to perform. The user is asking for a task
 * to be RECORDED, and Core V1's `task.create` tool already does exactly that
 * through the normal orchestrator path. Routing it here instead would execute
 * the thing they asked to be written down — the opposite of the request — and
 * would give task creation two implementations.
 */
const TASK_CREATION_SIGNALS =
  /(\bcreate\s+a?\s*task\b|\bmake\s+a?\s*task\b|\badd\s+a?\s*task\b|\btask\s+(banao|bana\s+do|create\s+karo)\b|\bremember\s+(this|that)\s+as\s+a?\s*task\b|\bnote\s+this\s+down\b)/i;

const MAX_GOAL = 500;

/**
 * Decide whether a chat message is asking JARVIS to perform work.
 *
 * Order matters and is the safety design:
 *
 *   1. no action word at all      -> NONE  (protects every informational turn)
 *   2. "create a task"            -> NONE  (the existing tool owns that)
 *   3. explicit "don't execute"   -> PLAN_ONLY
 *   4. interrogative opener       -> NONE  (a question about doing, not an order)
 *   5. trailing question mark     -> NONE  (asking, not instructing)
 *   6. not in imperative position -> NONE  (a mention, not an instruction)
 *   7. otherwise                  -> EXECUTE
 *
 * Steps 1 and 6 are deliberately different strengths. Planning is reached on
 * the loose match because planning runs nothing; execution needs the strict
 * one, because it does.
 *
 * Steps 4 and 5 are what make "Website ka response?" safe: it reaches neither
 * the planner nor the executor, and the conversation answers it as before.
 */
export function detectWorkRequest(message: string): WorkRequest {
  const trimmed = message.trim();
  if (trimmed.length === 0) return { type: "NONE" };

  // 1. The loose gate. No action word at all, no work — this is the rule that
  //    leaves ordinary conversation completely untouched.
  if (!MENTIONS_ACTION.test(trimmed)) return { type: "NONE" };

  // 2. Recording a task is not performing one.
  if (TASK_CREATION_SIGNALS.test(trimmed)) return { type: "NONE" };

  const goal = trimmed.slice(0, MAX_GOAL);

  // 3. An explicit refusal to execute beats the imperative beside it.
  if (PLAN_ONLY_SIGNALS.test(trimmed)) return { type: "PLAN_ONLY", goal };

  // 4. "How do I check X" is a question about checking.
  if (INFORMATION_SIGNALS.test(trimmed)) return { type: "NONE" };

  // 5. A question mark means asking. Nothing runs on a maybe.
  if (trimmed.endsWith("?")) return { type: "NONE" };

  // 6. THE STRICT GATE. An action word is not an instruction — it has to be in
  //    imperative position. This is the asymmetry the detector rests on:
  //    planning reached step 3 on a LOOSE match because planning runs nothing,
  //    while executing needs the user to have actually said "do it".
  if (!IMPERATIVE.test(trimmed) && !HINGLISH_IMPERATIVE.test(trimmed)) {
    return { type: "NONE" };
  }

  return { type: "EXECUTE", goal };
}
