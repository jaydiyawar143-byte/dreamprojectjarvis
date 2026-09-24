// ---------------------------------------------------------------------------
// Multi-round tool context — Skill System V1, Phase S4.
//
// THE DEFECT THIS FIXES. The orchestration loop runs up to five rounds, and
// each round rebuilt the model's messages from ONE assistant turn and ONE set
// of results — the most recent. So a four-step objective lost its own evidence:
//
//   round 1   read insights            -> R1
//   round 2   sees R1, analyses        -> R2
//   round 3   sees R2 only. R1 is gone.
//
// By the time the model reached "now draft the email", the numbers it was
// supposed to write about were no longer in front of it. The loop was five
// rounds deep and the model's working memory was one.
//
// WHAT S4 IS NOT. It is not a workflow engine, a skill graph or a second
// planner. Multi-skill composition already works — the general assistant's
// allowlist spans seven of eight skills and the model chains tools across them
// by itself. The only thing missing was that it could not remember what it had
// already found. This module is that memory, and nothing else.
//
// WHY WHOLE ROUNDS AND NOT A SUMMARY BLOCK. The obvious cheaper fix is to
// prepend "here is what you found earlier" as prose. It is also a fabrication:
// `domain-agent.ts` already refuses to invent a synthetic tool-call turn
// because it "would put words in the model's mouth". Replaying the real
// assistant turns and their real tool messages says exactly what happened, and
// it is what the provider's own protocol expects — a `tool` message must
// answer an `assistant` message that requested it, by id. Anything else is
// either a lie or a protocol error.
//
// ONE IMPLEMENTATION. `ConversationalAssistant`, `MetaAdsAgent` and
// `DomainAgent` each carried a private copy of this message construction. They
// now all call this, so the three cannot drift into remembering different
// amounts of the same conversation.
// ---------------------------------------------------------------------------

import type {
  AICompletionResponse,
  AIMessage,
  AIToolCall,
  ConversationMessage,
  ToolExecutionResult,
} from "@jarvis/core";

/**
 * One completed round: the assistant turn that asked for tools, and what came
 * back. Kept as a pair because the provider protocol binds them by id.
 */
export interface ToolRound {
  assistant: AICompletionResponse;
  results: ToolExecutionResult[];
}

/**
 * How much accumulated tool output the model is shown, in characters.
 *
 * WHY A CHARACTER BUDGET AND NOT A TOKEN ONE. Every other context budget in
 * this repository is in characters — memory (2 000) and knowledge — and they
 * are compared and composed with each other. A token budget here would need a
 * tokenizer on the critical path to answer a question the existing budgets
 * already answer well enough.
 *
 * WHY 12 000. A round is capped at ten tool executions across the whole turn,
 * and a typical result envelope in this build runs a few hundred characters to
 * low thousands. 12 000 holds a realistic four-step objective whole while
 * leaving the 73 tool definitions, the system prompt, the skill block and the
 * conversation history comfortable room inside a 128k window. It is a ceiling
 * on the pathological case — a tool that returns a large document — not a
 * target.
 *
 * It bounds only what ACCUMULATION adds. The newest round is never truncated,
 * so no turn is worse off than it was before S4.
 */
export const DEFAULT_TOOL_RESULT_BUDGET_CHARS = 12_000;

/**
 * What an over-budget earlier result is replaced with.
 *
 * Identity and status survive: the model must still be able to see THAT it
 * called a tool and whether the call worked, because "I already tried that and
 * it failed" is the fact that stops it trying again. Only the payload goes.
 */
function elided(tr: ToolExecutionResult): string {
  return [
    `TOOL: ${tr.toolId}`,
    `STATUS: ${tr.status.toUpperCase()}`,
    "RESULT: (omitted — this earlier result fell outside the context budget; ask again if you need it)",
  ].join("\n");
}

/**
 * Render each result, newest first, until the budget runs out.
 *
 * DETERMINISTIC AND OLDEST-FIRST. Walking backwards means the newest round is
 * always considered first and therefore always kept; whatever is dropped is
 * dropped from the far end. The same rounds and the same budget always produce
 * the same output, which is what makes the behaviour testable rather than
 * merely plausible.
 *
 * THE NEWEST RESULT IS NEVER ELIDED, even when it alone exceeds the budget.
 * Eliding it would make a turn WORSE than before S4, and the caller asked for
 * that tool one moment ago — it is the least likely thing to be safe to drop.
 *
 * Returns rendered content per result, in the original order.
 */
export function budgetedEnvelopes(
  rounds: readonly ToolRound[],
  render: (tr: ToolExecutionResult) => string,
  budgetChars: number = DEFAULT_TOOL_RESULT_BUDGET_CHARS
): string[][] {
  const flat: Array<{ round: number; index: number; tr: ToolExecutionResult }> = [];
  rounds.forEach((round, r) =>
    round.results.forEach((tr, i) => flat.push({ round: r, index: i, tr }))
  );

  const out: string[][] = rounds.map((round) => new Array<string>(round.results.length));
  let used = 0;

  for (let k = flat.length - 1; k >= 0; k--) {
    const { round, index, tr } = flat[k]!;
    const full = render(tr);

    // The last result of the last round: always kept whole.
    const isNewest = k === flat.length - 1;
    if (isNewest || used + full.length <= budgetChars) {
      out[round]![index] = full;
      used += full.length;
      continue;
    }

    // Over budget. The stub still costs something, so it is counted too —
    // otherwise a long tail of elided results grows without limit.
    const stub = elided(tr);
    out[round]![index] = stub;
    used += stub.length;
  }

  return out;
}

/**
 * The full message list for a turn that has already executed tools.
 *
 * Shape, and why it is this shape:
 *
 *   system            the agent's prompt, dated by the caller
 *   ...history        the conversation before this turn
 *   user              the ORIGINAL question, not the last round's text
 *   assistant + tool  one pair per completed round, oldest first
 *
 * Replaying every round is what makes round four able to reason over round
 * one. The provider protocol requires each `tool` message to carry the
 * `toolCallId` of a preceding `assistant` turn, so the rounds cannot be
 * flattened or reordered — which is also why an earlier result is ELIDED
 * rather than removed. Dropping the message entirely would leave an assistant
 * tool call unanswered and the request would be rejected.
 */
export function buildRoundMessages(input: {
  systemPrompt: string;
  conversationHistory?: ConversationMessage[];
  userMessage: string;
  rounds: readonly ToolRound[];
  renderEnvelope: (tr: ToolExecutionResult) => string;
  budgetChars?: number;
}): AIMessage[] {
  const messages: AIMessage[] = [];

  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt });
  }

  for (const msg of input.conversationHistory ?? []) {
    messages.push({ role: msg.role as "user" | "assistant", content: msg.content });
  }

  messages.push({ role: "user", content: input.userMessage });

  const rendered = budgetedEnvelopes(input.rounds, input.renderEnvelope, input.budgetChars);

  input.rounds.forEach((round, r) => {
    messages.push({
      role: "assistant",
      content: round.assistant.message.content ?? "",
      toolCalls: round.assistant.message.toolCalls,
    });

    const byId = new Map<string, AIToolCall>();
    for (const tc of round.assistant.message.toolCalls ?? []) byId.set(tc.id, tc);

    round.results.forEach((tr, i) => {
      // Unchanged from the pre-S4 fallback: a result with no call id is
      // matched by tool id, then by first-available, so a provider that omits
      // one does not break the pairing.
      let toolCallId = tr.toolCallId;
      if (!toolCallId) {
        const matching = byId.get(tr.toolId) ?? [...byId.values()].shift();
        if (matching) toolCallId = matching.id;
      }

      messages.push({
        role: "tool",
        content: rendered[r]![i]!,
        name: tr.toolId,
        toolCallId,
      });
    });
  });

  return messages;
}
