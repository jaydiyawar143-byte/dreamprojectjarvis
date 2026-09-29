// S7.2 L3 — the validation contract, with learning scope (L3 finalization).
//
// L2 proves the user wrote the quoted words. L3 decides two things:
//   - does the user's own evidence SUPPORT the claim?     → decision
//   - is it durable USER memory at all, or a goal, a task,
//     project state, a current decision, or temporary?   → scope
//
// Only VALID with scope MEMORY is ever stored, and VALID comes only from the
// three durable categories L1b recognises — STABLE_PREFERENCE,
// STABLE_PERSONAL_FACT, STABLE_WORKING_CONVENTION — or from an explicit
// endorsement ("Yes, make that my default"). CLEAR → VALID, UNCLEAR → HOLD,
// CLEARLY NOT MEMORY → INVALID. Every safety and context rule is checked
// before any VALID rule.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEARNING_SCOPES,
  LEARNING_VALIDATION_DECISIONS,
  LEARNING_VALIDATION_RULES,
  isLearningValidationResult,
  validateLearningCandidate,
  type LearningValidationInput,
} from "../src/learning-validation.js";
import type { LearningProvenance } from "../src/learning-provenance.js";

const USER_PROVENANCE: LearningProvenance = {
  sourceType: "USER",
  sourceConversationId: "conv-1",
  sourceMessageId: "msg-1",
  sourceTraceId: "trace-1",
};

/**
 * Validate `claim` against the user's message; the quote defaults to the whole
 * message and the provenance to USER. Defaults apply only when an argument is
 * OMITTED — an explicit `undefined` is passed through, so it can be tested.
 */
function v(userMessage: string, claim: string, ...rest: [evidence?: unknown, provenance?: unknown]) {
  const evidence = rest.length >= 1 ? rest[0] : userMessage;
  const provenance = rest.length >= 2 ? rest[1] : USER_PROVENANCE;
  return validateLearningCandidate({ claim, evidence, userMessage, provenance } as LearningValidationInput);
}

const CLAIM = "User prefers short captions.";

// ---------------------------------------------------------------------------
// VALID — the three durable categories
// ---------------------------------------------------------------------------

describe("VALID / MEMORY — STABLE_PREFERENCE", () => {
  it.each([
    ["I prefer short captions.", "User prefers short captions."],
    ["I like minimal designs.", "User likes minimal designs."],
    ["I prefer professional tone.", "User prefers professional tone."],
    ["I always want professional tone.", "User prefers a professional tone."],
    ["I love bold colours.", "User loves bold colours."],
    ["I prefer dark mode.", "User prefers dark mode."],
    ["I don't like emojis.", "User does not like emojis."],
    ["I hate long captions.", "User hates long captions."],
    ["My favourite colour is teal.", "User's favourite colour is teal."],
    ["My preferred tone is formal.", "User's preferred tone is formal."],
    ["Mujhe short captions pasand hai.", "User prefers short captions."],
    ["I really like carousel posts.", "User likes carousel posts."],
  ])("%s → VALID", (message, claim) => {
    expect(v(message, claim)).toEqual({ decision: "VALID", rule: "DIRECT_USER_STATEMENT", scope: "MEMORY", category: "STABLE_PREFERENCE" });
  });
});

describe("VALID / MEMORY — STABLE_PERSONAL_FACT", () => {
  it.each([
    ["I work with Digital One Box.", "User works with Digital One Box."],
    ["I live in Balaghat.", "User lives in Balaghat."],
    ["My name is Sirish.", "User's name is Sirish."],
    ["I'm based in Mumbai.", "User is based in Mumbai."],
    ["I'm a freelance designer.", "User is a freelance designer."],
    ["I run a digital marketing agency.", "User runs a digital marketing agency."],
    ["I manage three Instagram accounts.", "User manages three Instagram accounts."],
    ["I speak Hindi and English.", "User speaks Hindi and English."],
    ["I sell handmade candles.", "User sells handmade candles."],
    ["My agency is Digital One Box.", "User's agency is Digital One Box."],
    ["My timezone is IST.", "User's timezone is IST."],
    ["I own a bakery in Pune.", "User owns a bakery in Pune."],
  ])("%s → VALID", (message, claim) => {
    expect(v(message, claim)).toEqual({ decision: "VALID", rule: "DIRECT_USER_STATEMENT", scope: "MEMORY", category: "STABLE_PERSONAL_FACT" });
  });
});

describe("VALID / MEMORY — STABLE_WORKING_CONVENTION", () => {
  it.each([
    ["Use 1:1 for my Instagram creatives.", "Use 1:1 for user's Instagram creatives."],
    ["Keep my X captions short.", "Keep user's X captions short."],
    ["Use Indian Rupees in my budgets.", "User uses Indian Rupees in budgets."],
    ["My default currency is INR.", "User's default currency is INR."],
    ["My default design style is minimal.", "User's default design style is minimal."],
    ["Always reply to me in Hinglish.", "Always reply to the user in Hinglish."],
    ["Never use emojis in my captions.", "Never use emojis in user's captions."],
    ["From now on, sign my emails as Sirish.", "Sign user's emails as Sirish."],
    ["By default, format my reports as PDF.", "Format user's reports as PDF by default."],
    ["My default platform is Instagram.", "User's default platform is Instagram."],
    ["I usually post on Mondays.", "User usually posts on Mondays."],
    ["I send reports every Friday.", "User sends reports every Friday."],
    ["Keep my LinkedIn posts under 200 words.", "Keep user's LinkedIn posts under 200 words."],
    ["Yes, make short captions my default.", "User's default is short captions."],
  ])("%s → VALID", (message, claim) => {
    expect(v(message, claim)).toEqual({ decision: "VALID", rule: "DIRECT_USER_STATEMENT", scope: "MEMORY", category: "STABLE_WORKING_CONVENTION" });
  });
});

describe("VALID — a durable statement after a plain opener", () => {
  it.each([
    ["Thanks! I prefer short captions.", "I prefer short captions"],
    ["Okay, I prefer short captions.", "I prefer short captions"],
    ["Actually, I prefer long captions now.", "I prefer long captions now"],
  ])("%s → VALID", (message, evidence) => {
    const claim = message.includes("long") ? "User prefers long captions." : CLAIM;
    expect(v(message, claim, evidence).decision).toBe("VALID");
  });
});

// ---------------------------------------------------------------------------
// NOT MEMORY — goal, task, project, decision, temporary (INVALID, no write)
// ---------------------------------------------------------------------------

describe("INVALID / GOAL — a goal is not a memory", () => {
  it.each([
    ["I want to launch my SaaS by Q3.", "User wants to launch their SaaS by Q3."],
    ["I want to buy a new laptop.", "User wants to buy a new laptop."],
    ["I plan to hire two designers.", "User plans to hire two designers."],
    ["My goal is to reach 10k followers.", "User's goal is to reach 10k followers."],
    ["I'm trying to grow my Instagram.", "User is trying to grow their Instagram."],
    ["I hope to double our revenue.", "User hopes to double revenue."],
    ["I'd like to learn video editing.", "User would like to learn video editing."],
    ["We want to expand to Dubai.", "User wants to expand to Dubai."],
    ["I intend to start a podcast.", "User intends to start a podcast."],
  ])("%s → INVALID / GOAL", (message, claim) => {
    expect(v(message, claim)).toEqual({ decision: "INVALID", rule: "GOAL_OR_TASK", scope: "GOAL" });
  });

  it("L1b calls 'My goal is …' a stable personal fact; the goal rule still wins — no VALID rule overrides it", () => {
    expect(v("My goal is to reach 10k followers.", "User's goal is to reach 10k followers.").decision).toBe("INVALID");
  });
});

describe("INVALID / TASK — a task is not a memory", () => {
  it.each([
    ["Remind me to send the proposal.", "User wants a reminder to send the proposal."],
    ["Remind me to call the client.", "Remind user to call the client."],
    ["Fix the Meta API issue.", "Fix the Meta API issue."],
    ["Send the report to Rahul.", "Send the report to Rahul."],
    ["Book a meeting with the design team.", "Book a meeting with the design team."],
    ["Draft an email to the vendor.", "Draft an email to the vendor."],
    ["Schedule the post for Friday.", "Schedule the post for Friday."],
    ["Cancel my Canva subscription.", "Cancel user's Canva subscription."],
    ["Create the campaign in Ads Manager.", "Create the campaign in Ads Manager."],
  ])("%s → INVALID / TASK", (message, claim) => {
    expect(v(message, claim)).toEqual({ decision: "INVALID", rule: "GOAL_OR_TASK", scope: "TASK" });
  });

  it("a standing instruction with the same verb is a convention, not a task", () => {
    expect(v("I send reports every Friday.", "User sends reports every Friday.").scope).toBe("MEMORY");
  });
});

describe("INVALID / PROJECT — project state and current context are not memories", () => {
  it.each([
    ["The current project uses Next.js.", "User's current project uses Next.js."],
    ["The client budget is 50000 rupees.", "The client budget is 50000 rupees."],
    ["Our client wants a blue logo.", "User's client wants a blue logo."],
    ["My project deadline is Friday.", "User's project deadline is Friday."],
    ["The campaign budget is 20k.", "The campaign budget is 20k."],
    ["The backend runs on Supabase.", "The backend runs on Supabase."],
    ["The codebase uses TypeScript.", "The codebase uses TypeScript."],
    ["The website uses WordPress.", "The website uses WordPress."],
    ["The client prefers short captions.", "The client prefers short captions."],
  ])("%s → INVALID / PROJECT", (message, claim) => {
    expect(v(message, claim)).toEqual({ decision: "INVALID", rule: "PROJECT_OR_CURRENT_CONTEXT", scope: "PROJECT" });
  });

  it("'LeadVexo uses Supabase.' is never memory: with no project marker it is a statement about something else → INVALID", () => {
    expect(v("LeadVexo uses Supabase.", "User's LeadVexo uses Supabase.")).toEqual({ decision: "INVALID", rule: "GENERAL_STATEMENT", scope: "UNKNOWN" });
  });
});

describe("INVALID / DECISION — a current decision is not a memory", () => {
  it.each([
    ["I decided to use PostgreSQL.", "User decided to use PostgreSQL."],
    ["We decided to go with Supabase.", "User decided to go with Supabase."],
    ["I chose Stripe for payments.", "User chose Stripe for payments."],
    ["We'll use Meta Ads.", "User will use Meta Ads."],
    ["I'm going with the blue logo.", "User is going with the blue logo."],
    ["Let's go with option B.", "User goes with option B."],
    ["I picked Canva for the designs.", "User picked Canva for designs."],
    ["We settled on weekly reports.", "User settled on weekly reports."],
    ["I opted for the annual plan.", "User opted for the annual plan."],
  ])("%s → INVALID / DECISION", (message, claim) => {
    expect(v(message, claim)).toEqual({ decision: "INVALID", rule: "CURRENT_DECISION", scope: "DECISION" });
  });
});

describe("INVALID / TEMPORARY — temporary, session or current-time scope", () => {
  it.each([
    ["For this campaign use short captions.", CLAIM],
    ["For today's post use this style.", "User prefers this style."],
    ["For this conversation, keep replies short.", "Keep replies short."],
    ["Only this time use short captions.", CLAIM],
    ["For now, use short captions.", CLAIM],
    ["Use short captions today.", CLAIM],
    ["Currently I prefer short captions.", CLAIM],
    ["I need to finish the campaign today.", "User needs to finish the campaign today."],
    ["Create the campaign tomorrow.", "Create the campaign tomorrow."],
    ["For this campaign only use short captions.", CLAIM],
  ])("%s → INVALID / TEMPORARY", (message, claim) => {
    expect(v(message, claim)).toEqual({ decision: "INVALID", rule: "TEMPORARY_SCOPE", scope: "TEMPORARY" });
  });

  it("an endorsement with 'this' is read as the current item: 'Make this my default.' → TEMPORARY", () => {
    expect(v("Make this my default.", CLAIM).scope).toBe("TEMPORARY");
  });
});

// ---------------------------------------------------------------------------
// HOLD — possibly useful, not established
// ---------------------------------------------------------------------------

describe("HOLD — weak acknowledgement", () => {
  it.each(["Thanks.", "Thanks, sounds good.", "Okay.", "That sounds good.", "Got it.", "Looks good.", "Fine.", "Okay, sounds good."])(
    "%s → HOLD",
    (message) => {
      expect(v(message, CLAIM)).toEqual({ decision: "HOLD", rule: "WEAK_ACKNOWLEDGEMENT", scope: "UNKNOWN" });
    }
  );

  it("JARVIS's claim quoted against the user's real 'Thanks, sounds good.' (the L2 residual) → HOLD", () => {
    expect(v("Thanks, sounds good.", "User's default style is short captions.", "Thanks, sounds good.").decision).toBe("HOLD");
  });
});

describe("HOLD — uncertainty", () => {
  it.each(["I think I prefer short captions.", "Maybe I prefer short captions.", "I might prefer short captions.", "I'm not sure, but I like short captions."])(
    "%s → HOLD",
    (message) => {
      expect(v(message, CLAIM)).toEqual({ decision: "HOLD", rule: "UNCERTAIN_LANGUAGE", scope: "UNKNOWN" });
    }
  );

  it("the hedge cannot be cut out of the quote: the whole message is judged", () => {
    expect(v("I think I prefer short captions.", CLAIM, "I prefer short captions").decision).toBe("HOLD");
  });
});

describe("HOLD — ambiguous scope: not a durable statement L1b recognises", () => {
  it.each([
    ["Keep captions short.", "Keep captions short."],
    ["Short captions for me.", "User wants short captions."],
    ["My company uses Meta Ads.", "User's company uses Meta Ads."],
    ["I'm building a finance app called FinTrack.", "User is building a finance app called FinTrack."],
  ])("%s → HOLD", (message, claim) => {
    expect(v(message, claim)).toEqual({ decision: "HOLD", rule: "NOT_ESTABLISHED", scope: "UNKNOWN" });
  });
});

describe("HOLD — ambiguous evidence: the claim is not quite what the user said", () => {
  it.each([
    ["adds a detail", "I prefer short captions.", "User prefers short captions with emojis.", "CLAIM_EXCEEDS_EVIDENCE"],
    ["adds 'always'", "I prefer short captions.", "User always prefers short captions.", "CLAIM_EXCEEDS_EVIDENCE"],
    ["is too vague to check", "I prefer short captions.", "User prefers it.", "CLAIM_UNSPECIFIC"],
    ["turns 'like' into 'hates'", "I like short captions.", "User hates short captions.", "CLAIM_EXCEEDS_EVIDENCE"],
  ])("a claim that %s → HOLD", (_label, message, claim, rule) => {
    expect(v(message, claim)).toEqual({ decision: "HOLD", rule, scope: "MEMORY" });
  });
});

// ---------------------------------------------------------------------------
// Endorsement
// ---------------------------------------------------------------------------

describe("ENDORSEMENT — only an explicit one validates a contextual preference", () => {
  it.each(["Yes, make that my default.", "That's my preference.", "Remember that as my default.", "Yes, set that as my default."])(
    "%s → VALID (no category: what was endorsed is in JARVIS's context, which L3 never sees)",
    (message) => {
      expect(v(message, CLAIM)).toEqual({ decision: "VALID", rule: "EXPLICIT_ENDORSEMENT", scope: "MEMORY" });
    }
  );

  it("JARVIS suggests, the user says 'Okay.' → HOLD, never VALID", () => {
    expect(v("Okay.", CLAIM)).toEqual({ decision: "HOLD", rule: "WEAK_ACKNOWLEDGEMENT", scope: "UNKNOWN" });
  });

  it.each([
    ["negated", "Don't make that my default."],
    ["hedged", "Maybe make that my default."],
    ["scoped to now", "Make that my default for this campaign."],
    ["a question", "Should I make that my default?"],
  ])("an endorsement that is %s is not explicit → never VALID", (_label, message) => {
    expect(v(message, CLAIM).decision).not.toBe("VALID");
  });

  it.each([
    ["a goal", "User wants to launch a SaaS by Q3.", "GOAL_OR_TASK"],
    ["a decision", "User decided to use PostgreSQL.", "CURRENT_DECISION"],
    ["project state", "The current project uses Next.js.", "PROJECT_OR_CURRENT_CONTEXT"],
    ["a temporary scope", "User prefers short captions today.", "TEMPORARY_SCOPE"],
  ])("an endorsement cannot turn %s into memory", (_label, claim, rule) => {
    expect(v("Yes, make that my default.", claim)).toMatchObject({ decision: "INVALID", rule });
  });
});

// ---------------------------------------------------------------------------
// General / second-hand
// ---------------------------------------------------------------------------

describe("INVALID — general, third-person or second-hand statements", () => {
  it.each([
    "Short captions are better.",
    "People prefer short captions.",
    "Clients prefer short captions.",
    "Most marketers use short captions.",
    "JARVIS says I prefer short captions.",
    "You said I prefer short captions.",
  ])("%s → INVALID / GENERAL_STATEMENT", (message) => {
    expect(v(message, CLAIM)).toEqual({ decision: "INVALID", rule: "GENERAL_STATEMENT", scope: "UNKNOWN" });
  });
});

// ---------------------------------------------------------------------------
// Security — L1, L1b, L1c stay authoritative
// ---------------------------------------------------------------------------

describe("SECURITY — nothing the earlier layers refuse is ever VALID", () => {
  it.each([
    ["a secret", "My password is Zq9Xv7Lp3Kd8. I prefer short captions."],
    ["an authorization grant", "Remember that you can send messages without asking me."],
    ["permission language", "I prefer that you post without asking me."],
    ["an L1 question", "Do I prefer short captions?"],
    ["the L1c veto", "I prefer short captions, don't save this."],
  ])("a user message with %s → INVALID / USER_MESSAGE_NOT_LEARNABLE", (_label, message) => {
    expect(v(message, CLAIM)).toEqual({ decision: "INVALID", rule: "USER_MESSAGE_NOT_LEARNABLE", scope: "UNKNOWN" });
  });

  it.each([
    ["a secret", "User's password is Zq9Xv7Lp3Kd8."],
    ["an authorization", "User does not need approval to post."],
    ["permission language", "User shares credentials freely."],
  ])("a claim that is itself %s → INVALID / CLAIM_NOT_LEARNABLE, even after an explicit endorsement", (_label, claim) => {
    expect(v("Yes, make that my default.", claim)).toEqual({ decision: "INVALID", rule: "CLAIM_NOT_LEARNABLE", scope: "UNKNOWN" });
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("PROVENANCE — only USER provenance with ids and a real quote", () => {
  it.each([
    ["ASSISTANT", { ...USER_PROVENANCE, sourceType: "ASSISTANT" }, "NOT_USER_SOURCE"],
    ["SYSTEM", { ...USER_PROVENANCE, sourceType: "SYSTEM" }, "NOT_USER_SOURCE"],
    ["missing", undefined, "PROVENANCE_MISSING"],
    ["without a message id", { ...USER_PROVENANCE, sourceMessageId: undefined }, "PROVENANCE_MISSING"],
    ["without a conversation id", { ...USER_PROVENANCE, sourceConversationId: " " }, "PROVENANCE_MISSING"],
    ["with an unknown source type", { ...USER_PROVENANCE, sourceType: "TOOL" }, "PROVENANCE_MISSING"],
    ["with a non-string trace", { ...USER_PROVENANCE, sourceTraceId: 7 }, "PROVENANCE_MISSING"],
  ])("provenance %s → INVALID", (_label, provenance, rule) => {
    expect(v("I prefer short captions.", CLAIM, "I prefer short captions.", provenance)).toEqual({ decision: "INVALID", rule, scope: "UNKNOWN" });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["punctuation only", " ... "],
    ["not a string", 42],
  ])("evidence %s → INVALID / EVIDENCE_MISSING", (_label, evidence) => {
    expect(v("I prefer short captions.", CLAIM, evidence)).toEqual({ decision: "INVALID", rule: "EVIDENCE_MISSING", scope: "UNKNOWN" });
  });

  it("a quote the user never wrote → INVALID / EVIDENCE_NOT_IN_MESSAGE", () => {
    expect(v("Thanks, sounds good.", CLAIM, "I prefer short captions")).toEqual({ decision: "INVALID", rule: "EVIDENCE_NOT_IN_MESSAGE", scope: "UNKNOWN" });
  });
});

// ---------------------------------------------------------------------------
// Claim safety
// ---------------------------------------------------------------------------

describe("CLAIM SAFETY — the claim must say what the user said", () => {
  it("real user words that do not support the claim → INVALID / CLAIM_NOT_SUPPORTED", () => {
    expect(v("I prefer short captions.", "User prefers dark mode.")).toEqual({ decision: "INVALID", rule: "CLAIM_NOT_SUPPORTED", scope: "MEMORY" });
  });

  it.each([
    ["dropping a negation by trimming the quote", "I don't like long captions.", "User likes long captions.", "like long captions"],
    ["dropping the subject", "My boss is strict.", "User is strict.", "My boss is strict."],
    ["dropping the subject by trimming the quote", "My boss's favourite colour is blue.", "User's favourite colour is blue.", "favourite colour is blue"],
  ])("changing the meaning by %s → HOLD / CLAIM_CHANGES_MEANING", (_label, message, claim, evidence) => {
    expect(v(message, claim, evidence)).toEqual({ decision: "HOLD", rule: "CLAIM_CHANGES_MEANING", scope: "MEMORY" });
  });

  it.each([
    ["keeping the subject", "My boss's favourite colour is blue.", "User's boss's favourite colour is blue."],
    ["keeping the negation", "I don't like long captions.", "User does not like long captions."],
    ["the office claim beside a drink clause", "My favourite drink is masala chai and my office is in Pune.", "User's office is in Pune."],
    ["a preference beside someone else's in another sentence", "I prefer short captions. My boss likes long ones.", CLAIM],
  ])("%s → VALID", (_label, message, claim) => {
    expect(v(message, claim).decision).toBe("VALID");
  });
});

// ---------------------------------------------------------------------------
// Contradiction — validated on its own; correction is L5
// ---------------------------------------------------------------------------

describe("CONTRADICTION — a new preference is judged on its own evidence", () => {
  it("an explicit new preference is VALID; L3 has no input through which it could see or change an older memory", () => {
    expect(v("I prefer long captions now.", "User prefers long captions.").decision).toBe("VALID");
    expect(validateLearningCandidate.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rules, scopes and robustness
// ---------------------------------------------------------------------------

describe("the decision model", () => {
  it("rules, in the order they are checked — every safety and context rule before any VALID rule", () => {
    expect([...LEARNING_VALIDATION_RULES]).toEqual([
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
    ]);
    const byDecision = (d: string) => LEARNING_VALIDATION_RULES.filter((r) => LEARNING_VALIDATION_DECISIONS[r] === d);
    expect(byDecision("VALID")).toEqual(["EXPLICIT_ENDORSEMENT", "DIRECT_USER_STATEMENT"]);
    expect(byDecision("HOLD")).toEqual([
      "WEAK_ACKNOWLEDGEMENT",
      "UNCERTAIN_LANGUAGE",
      "NOT_ESTABLISHED",
      "CLAIM_UNSPECIFIC",
      "CLAIM_EXCEEDS_EVIDENCE",
      "CLAIM_CHANGES_MEANING",
    ]);
  });

  it("the scopes", () => {
    expect([...LEARNING_SCOPES]).toEqual(["MEMORY", "GOAL", "TASK", "PROJECT", "DECISION", "TEMPORARY", "UNKNOWN"]);
  });

  it.each([
    ["a real VALID result", { decision: "VALID", rule: "DIRECT_USER_STATEMENT", scope: "MEMORY", category: "STABLE_PREFERENCE" }, true],
    ["a real endorsement", { decision: "VALID", rule: "EXPLICIT_ENDORSEMENT", scope: "MEMORY" }, true],
    ["a real HOLD", { decision: "HOLD", rule: "WEAK_ACKNOWLEDGEMENT", scope: "UNKNOWN" }, true],
    ["a real TASK", { decision: "INVALID", rule: "GOAL_OR_TASK", scope: "TASK" }, true],
    ["an unknown decision", { decision: "MAYBE", rule: "DIRECT_USER_STATEMENT", scope: "MEMORY", category: "STABLE_PREFERENCE" }, false],
    ["an unknown rule", { decision: "VALID", rule: "LOOKS_FINE", scope: "MEMORY" }, false],
    ["a rule with the wrong decision", { decision: "VALID", rule: "WEAK_ACKNOWLEDGEMENT", scope: "UNKNOWN" }, false],
    ["VALID outside MEMORY scope", { decision: "VALID", rule: "EXPLICIT_ENDORSEMENT", scope: "GOAL" }, false],
    ["a rule with the wrong scope", { decision: "INVALID", rule: "GOAL_OR_TASK", scope: "PROJECT" }, false],
    ["an unknown scope", { decision: "HOLD", rule: "WEAK_ACKNOWLEDGEMENT", scope: "LATER" }, false],
    ["a direct statement without its category", { decision: "VALID", rule: "DIRECT_USER_STATEMENT", scope: "MEMORY" }, false],
    ["an unknown category", { decision: "VALID", rule: "DIRECT_USER_STATEMENT", scope: "MEMORY", category: "GOAL" }, false],
    ["a category on a non-direct rule", { decision: "HOLD", rule: "WEAK_ACKNOWLEDGEMENT", scope: "UNKNOWN", category: "STABLE_PREFERENCE" }, false],
    ["null", null, false],
    ["a string", "VALID", false],
  ])("isLearningValidationResult: %s → %s", (_label, value, expected) => {
    expect(isLearningValidationResult(value)).toBe(expected);
  });

  it("every result the contract gives is well-formed", () => {
    for (const [message, claim] of [
      ["I prefer short captions.", CLAIM],
      ["Thanks.", CLAIM],
      ["People prefer short captions.", CLAIM],
      ["Yes, make that my default.", CLAIM],
      ["Remind me to call the client.", "Remind user to call the client."],
      ["I decided to use PostgreSQL.", "User decided to use PostgreSQL."],
    ]) {
      expect(isLearningValidationResult(v(message!, claim!))).toBe(true);
    }
  });

  it("same input → same output", () => {
    const first = v("I prefer short captions.", CLAIM);
    for (let i = 0; i < 5; i++) expect(v("I prefer short captions.", CLAIM)).toEqual(first);
  });

  it("the input is not mutated, and a frozen input is accepted", () => {
    const input = { claim: CLAIM, evidence: "I prefer short captions", userMessage: "I prefer short captions.", provenance: { ...USER_PROVENANCE } };
    const snapshot = JSON.parse(JSON.stringify(input));
    expect(validateLearningCandidate(Object.freeze({ ...input, provenance: Object.freeze({ ...input.provenance }) })).decision).toBe("VALID");
    validateLearningCandidate(input);
    expect(input).toEqual(snapshot);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "I prefer short captions."],
    ["an array", []],
    ["no claim", { evidence: "x", userMessage: "x", provenance: USER_PROVENANCE }],
    ["a blank claim", { claim: "  ", evidence: "x", userMessage: "x", provenance: USER_PROVENANCE }],
    ["a non-string user message", { claim: CLAIM, evidence: "x", userMessage: 5, provenance: USER_PROVENANCE }],
  ])("malformed input (%s) → INVALID / MALFORMED_INPUT, never a throw", (_label, input) => {
    expect(validateLearningCandidate(input as never)).toEqual({ decision: "INVALID", rule: "MALFORMED_INPUT", scope: "UNKNOWN" });
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("isolation — the validation contract is pure core logic", () => {
  const source = readFileSync(new URL("../src/learning-validation.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports only the L1 and L2 core contracts", () => {
    const specifiers = [...code.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]!).sort();
    expect(specifiers).toEqual(["./learning-candidate.js", "./learning-provenance.js"]);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it("names no database, HTTP, execution, policy, agent, memory, filesystem or model dependency", () => {
    for (const forbidden of [
      "prisma",
      "Prisma",
      "@jarvis/",
      "express",
      "node:",
      "axios",
      "ToolExecutor",
      "ToolRegistry",
      "AGENT_POLICIES",
      "agent-policy",
      "write-intent",
      "Orchestrator",
      "orchestrator",
      "MemoryExtraction",
      "IMemoryStore",
      "OpenAI",
      "openai",
      "anthropic",
      "Anthropic",
      "readFile",
      "writeFile",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("reads no clock, randomness, environment or network", () => {
    for (const forbidden of ["Date.now", "new Date", "Math.random", "process.env", "fetch("]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("has exactly two runtime consumers: the core index and MemoryExtractionService", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const consumers: string[] = [];
    for (const group of ["apps", "packages"]) {
      for (const pkg of readdirSync(join(root, group))) {
        const src = join(root, group, pkg, "src");
        if (!existsSync(src)) continue;
        for (const entry of readdirSync(src, { recursive: true }) as string[]) {
          if (!/\.(?:ts|tsx|mts)$/.test(entry) || entry.endsWith(".d.ts")) continue;
          const file = join(src, entry);
          if (!statSync(file).isFile()) continue;
          const path = relative(root, file).split(sep).join("/");
          if (path === "packages/core/src/learning-validation.ts") continue;
          const text = readFileSync(file, "utf8");
          if (/learning-validation|validateLearningCandidate|LEARNING_VALIDATION_RULES/.test(text)) consumers.push(path);
        }
      }
    }
    expect(consumers.sort()).toEqual(["packages/core/src/index.ts", "packages/memory/src/memory-extraction-service.ts"]);
  });
});
