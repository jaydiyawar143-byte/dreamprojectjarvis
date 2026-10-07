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
// THE OUTCOMES:
//
//   EXECUTE     an unambiguous imperative — "check digitalonebox.com"
//   PLAN_ONLY   an imperative the user explicitly does NOT want run —
//               "iska plan banao, execute mat karo"
//   SCHEDULE    an imperative with an explicit future time (Scheduler V1) —
//               "tomorrow at 10 am check my system status"
//   NEEDS_TIME  an imperative with a VAGUE time — "check it later". Nothing is
//               scheduled and nothing runs; the caller asks for a real time,
//               because guessing one would run work at an hour nobody chose.
//   NONE        everything else, including anything ambiguous
//
// "Ambiguous" resolves to NONE, never to EXECUTE. "Website ka response?" names
// a subject and no action; it is a question, and a question is answered.
// ---------------------------------------------------------------------------

import {
  parseSchedulePhrase,
  mentionsVagueTime,
  mentionsExplicitTime,
} from "./schedule-phrase.js";

export type WorkRequest =
  | { type: "EXECUTE"; goal: string }
  | { type: "PLAN_ONLY"; goal: string }
  /**
   * Scheduler V1 — an imperative carrying an explicit future time.
   *
   * `goal` is the WORK ONLY: the temporal phrase has been removed, because it
   * is already represented by `at` and leaving it in made the planner read
   * "in 3 minutes check X" as two actions. `matched` keeps the phrase as the
   * user said it, for the confirmation message.
   */
  | { type: "SCHEDULE"; goal: string; at: Date; matched: string }
  /** An imperative with a VAGUE time. Nothing runs; ask for a real one. */
  | { type: "NEEDS_TIME"; goal: string }
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

/**
 * A turn ABOUT the conversation — "summarize our conversation", "check what I
 * asked earlier", "analyze the current conversation and identify the latest
 * test".
 *
 * WHY THIS IS NOT WORK. The work path plans from the goal alone: the planner is
 * handed one sentence and a tool catalogue, and no history. A request that
 * points back into the conversation cannot be planned from there by anything —
 * the only component that can see what was said is the assistant. Sending it
 * to the planner produced a task called "Summarize our conversation" and the
 * answer "I cannot carry it out yet"; that was the reported defect.
 *
 * So this is not a judgement that the verb is harmless. It is a statement
 * about WHERE the subject of the sentence lives. The result is NONE, the
 * detector's safe direction, and the assistant path keeps every gate it has.
 *
 * WHAT COUNTS AS A REFERENCE, deliberately narrow:
 *
 *   - the conversation itself: "this / our / the current conversation", "this
 *     chat", "the conversation so far"
 *   - a turn in it, by position: "my previous message", "your last reply",
 *     "the latest test". With `the`, the words `response` and `request` are
 *     left out — "check the latest response of example.com" is about a website.
 *   - what someone said or did: "what I asked", "what you just did", "what we
 *     discussed"
 *   - the same in Hinglish: "pichla message", "hamari baatcheet", "maine pehle
 *     kya kaha"
 */
const ORDINAL = "last|previous|prior|earlier|first|second|third|fourth|fifth|latest|most\\s+recent|preceding";
const SAID_OR_DID =
  "said|say|asked|ask|told|tell|wrote|write|typed|sent|mentioned|discussed|talked|replied|answered|did|do|tested|ran";

const CONVERSATION_SIGNALS = new RegExp(
  [
    // The conversation itself.
    "\\b(?:this|our|the|current|ongoing|whole|entire|above|previous|earlier)\\s+(?:conversation|discussion)\\b",
    "\\b(?:this|our)\\s+(?:chat|thread|session|transcript)\\b",
    "\\b(?:conversation|chat|discussion)\\s+(?:so\\s+far|history|above|till\\s+now|until\\s+now|transcript)\\b",
    // A turn in it, by position.
    `\\b(?:my|your|our)\\s+(?:very\\s+)?(?:${ORDINAL})\\s+(?:message|question|reply|response|answer|request|prompt|query|instruction|statement|test|action|turn)s?\\b`,
    `\\bthe\\s+(?:very\\s+)?(?:${ORDINAL})\\s+(?:message|question|reply|answer|prompt|turn|test|action)s?\\b`,
    // What someone said or did.
    `\\bwhat\\s+(?:did\\s+|have\\s+)?(?:i|you|we)\\s+(?:just\\s+|already\\s+)?(?:${SAID_OR_DID})\\b`,
    "\\bwe\\s+(?:just\\s+|have\\s+|had\\s+)?(?:discussed|talked\\s+about|spoke\\s+about|covered|went\\s+over)\\b",
    "\\b(?:i|you)\\s+(?:just\\s+|already\\s+)?(?:said|asked|told|mentioned)\\b",
    // Hinglish.
    "\\b(?:pichhl[aie]|pichl[aie]|pehl[aie]\\s+wal[aie]|upar\\s+wal[aie]|aakhri|akhri|last|previous)\\s+(?:message|sawaal|sawal|question|jawaab|jawab|reply|baat|test)\\b",
    "\\b(?:hamari|humari|hamaari|apni|is|yeh|ye)\\s+(?:baat\\s?cheet|conversation|chat)\\b",
    "\\b(?:maine|mene|meine|humne|hamne|tumne|aapne)\\s+(?:abhi\\s+|pehle\\s+|upar\\s+)?kya\\s+(?:kaha|poocha|pucha|puchha|bola|likha|kiya|bheja)\\b",
  ].join("|"),
  "i"
);

const MAX_GOAL = 500;

/**
 * Day words that belong to a consumed schedule phrase.
 *
 * Only the four the grammar itself recognises, and only when one sits directly
 * against the phrase that was removed — see `withoutSchedulePhrase`.
 */
const ADJACENT_DAY_WORD = "today|tomorrow|aaj|kal";

/**
 * The goal with its temporal phrase taken out.
 *
 * WHY THIS EXISTS. The detector consumed "In 3 minutes" to produce the
 * schedule, but the goal kept it — so the planner was asked to plan "In 3
 * minutes check my system status" and read it, correctly, as two actions:
 * wait, then check. It answered `requiresMultipleActions: true` and the task
 * was refused. The model was not wrong; the input was.
 *
 * It broke the run twice over: the feasibility check refused the schedule up
 * front, and the execution-time re-plan would have refused it again three
 * minutes later, because the scheduler re-plans from the task's stored title.
 * Cleaning the goal HERE fixes both, because the task is stored clean.
 *
 * NOT A SECOND PARSER. It removes the exact substring `parseSchedulePhrase`
 * reported as `matched`, and nothing else it had to find for itself.
 *
 * The day word is the one addition, and it is deliberately narrow: only a word
 * sitting IMMEDIATELY against the removed phrase is taken, because that is the
 * one that can only have been part of the time. "Tomorrow at 9 AM send the
 * report about tomorrow's meeting" loses the first `tomorrow` and keeps the
 * second, which is the difference between reading the phrase and guessing at
 * the sentence.
 */
function withoutSchedulePhrase(message: string, matched: string): string {
  const at = message.indexOf(matched);
  if (at === -1) return message;

  let start = at;
  let end = at + matched.length;

  // A day word directly BEFORE the phrase: "Today at 10:45 PM", "Kal 5 baje".
  const before = message.slice(0, start);
  const leading = new RegExp(`\\b(?:${ADJACENT_DAY_WORD})\\s*$`, "i").exec(before);
  if (leading) {
    start = leading.index;
  } else {
    // Or directly AFTER it: "at 10 am tomorrow".
    const after = message.slice(end);
    const trailing = new RegExp(`^\\s*\\b(?:${ADJACENT_DAY_WORD})\\b`, "i").exec(after);
    if (trailing) end += trailing[0].length;
  }

  const stripped = (message.slice(0, start) + " " + message.slice(end))
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.–—-]+/, "")
    .trim();

  // A goal that is now empty says nothing at all. Rule 1 guarantees an action
  // word is in there somewhere, so this should be unreachable — but a goal is
  // what gets planned and stored, and an empty one is worse than a noisy one.
  return stripped.length === 0 ? message : stripped;
}

/**
 * Decide whether a chat message is asking JARVIS to perform work.
 *
 * Order matters and is the safety design:
 *
 *   1. no action word at all      -> NONE  (protects every informational turn)
 *   2. "create a task"            -> NONE  (the existing tool owns that)
 *   2b. about the conversation    -> NONE  (only the assistant can see it)
 *   3. explicit "don't execute"   -> PLAN_ONLY
 *   4. interrogative opener       -> NONE  (a question about doing, not an order)
 *   5. trailing question mark     -> NONE  (asking, not instructing)
 *   5b. explicit future time      -> SCHEDULE   (runs nothing now; the goal
 *                                               carries the WORK, not the WHEN)
 *   5c. vague time word           -> NEEDS_TIME (ask, never guess)
 *   5d. stated time, unusable     -> NEEDS_TIME (never silently "run it now")
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
export function detectWorkRequest(message: string, now: Date = new Date()): WorkRequest {
  const trimmed = message.trim();
  if (trimmed.length === 0) return { type: "NONE" };

  // 1. The loose gate. No action word at all, no work — this is the rule that
  //    leaves ordinary conversation completely untouched.
  if (!MENTIONS_ACTION.test(trimmed)) return { type: "NONE" };

  // 2. Recording a task is not performing one.
  if (TASK_CREATION_SIGNALS.test(trimmed)) return { type: "NONE" };

  // 2b. A turn about the conversation belongs to the one component that can
  //     see the conversation. Before PLAN_ONLY on purpose: "summarize our
  //     conversation, don't execute anything" is still a question about the
  //     conversation, and a plan made without the conversation answers nothing.
  if (CONVERSATION_SIGNALS.test(trimmed)) return { type: "NONE" };

  const goal = trimmed.slice(0, MAX_GOAL);

  // 3. An explicit refusal to execute beats the imperative beside it.
  if (PLAN_ONLY_SIGNALS.test(trimmed)) return { type: "PLAN_ONLY", goal };

  // 4. "How do I check X" is a question about checking.
  if (INFORMATION_SIGNALS.test(trimmed)) return { type: "NONE" };

  // 5. A question mark means asking. Nothing runs on a maybe.
  if (trimmed.endsWith("?")) return { type: "NONE" };

  // 5b. Scheduler V1 — an explicit future time turns "do it" into "do it then".
  //
  // Checked BEFORE the imperative gate for the same reason PLAN_ONLY is: the
  // user has said WHEN, and scheduling runs nothing now, so it does not need
  // the strict gate that immediate execution needs. A VAGUE time word with no
  // parsable instant is refused outright rather than guessed at — "later" is
  // not a time, and the caller asks for a real one.
  const schedule = parseSchedulePhrase(trimmed, now);
  if (schedule) {
    return {
      type: "SCHEDULE",
      // The WORK, with the WHEN taken out — the time has been turned into
      // `at` and must not also survive as part of the thing to do.
      goal: withoutSchedulePhrase(trimmed, schedule.matched).slice(0, MAX_GOAL),
      at: schedule.at,
      // Unchanged, and still the original phrase: the confirmation message
      // echoes what was understood, which is only useful verbatim.
      matched: schedule.matched,
    };
  }
  if (mentionsVagueTime(trimmed)) {
    return { type: "NEEDS_TIME", goal };
  }

  // 5d. AN EXPLICIT TIME THAT COULD NOT BE USED IS NEVER "RUN IT NOW".
  //
  // `parseSchedulePhrase` returns null for two different reasons: there was no
  // time at all, or there WAS one that cannot be scheduled — a named day that
  // has already gone, an hour out of range. Before this rule the detector
  // could not tell those apart, so it dropped the time and carried on to the
  // imperative gate. "Check my system status today at 1:50 PM", asked at 2 PM,
  // therefore EXECUTED IMMEDIATELY: the user named an hour, the hour was
  // refused, and the work ran anyway at an instant nobody chose.
  //
  // Stating a time is stating a constraint. If the constraint cannot be met,
  // the answer is a question, not a different action — so the caller asks for
  // a usable time and nothing is created and nothing runs.
  //
  // Placed BEFORE the strict gate deliberately: "today at 1:50 PM check my
  // system status" puts the verb mid-sentence and would otherwise fall to
  // NONE, which is silent. Asking is better than silence, and asking runs
  // nothing, so it does not need the gate that execution needs.
  if (mentionsExplicitTime(trimmed)) {
    return { type: "NEEDS_TIME", goal };
  }

  // 6. THE STRICT GATE. An action word is not an instruction — it has to be in
  //    imperative position. This is the asymmetry the detector rests on:
  //    planning reached step 3 on a LOOSE match because planning runs nothing,
  //    while executing needs the user to have actually said "do it".
  if (!IMPERATIVE.test(trimmed) && !HINGLISH_IMPERATIVE.test(trimmed)) {
    return { type: "NONE" };
  }

  return { type: "EXECUTE", goal };
}
