// S7.2 L1 — the learning-candidate contract.
//
// Step 1 locked the decision-independent REJECTION rules: what may never be
// learned is architecturally fixed already (S1 allowlist, the write-intent
// gate, approvals, the secret filters, S5's "silence is not feedback").
// Sections 1–5 below are Step 1's tests, unchanged.
//
// L1b Step 2 adds ACCEPT for a clearly stable, user-owned preference,
// personal fact or working convention — and UNDECIDED, with a named reason,
// for anything useful but not clear enough. Step 1's rules still run first.
//
// Secret-shaped values are assembled at runtime and never used as test
// titles, so neither the source nor a failure message carries one.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  decideLearningCandidate,
  LEARNING_RULES,
  type LearningCandidateInput,
  type LearningDecision,
  type LearningRule,
} from "../src/learning-candidate.js";

const user = (statement: string): LearningCandidateInput => ({ statement, statedBy: "USER" });
const assistant = (statement: string): LearningCandidateInput => ({ statement, statedBy: "ASSISTANT" });
const decide = (input: LearningCandidateInput): LearningDecision => decideLearningCandidate(input);

/** A run of word characters, built so no literal token appears in this file. */
const run = (n: number, seed = "a1B2c3D4e5F6g7H8") => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const upper = (n: number) => run(n, "A1B2C3D4E5F6G7H8");

// ---------------------------------------------------------------------------
// 1. Authorization / approval granting — REJECT, GRANTS_AUTHORIZATION
// ---------------------------------------------------------------------------

describe("1. a statement that grants authorization or approval is rejected", () => {
  it.each([
    ["the worked example: send without asking", "Remember that you can send messages without asking me."],
    ["permission to approve automatically", "You have permission to approve this automatically."],
    ["no approval needed from now on", "From now on you don't need my approval."],
    ["no need to ask", "You don't need to ask me before posting."],
    ["no need to confirm", "No need to confirm with me, just send it."],
    ["feel free, without approval", "Feel free to launch campaigns without my approval."],
    ["go ahead without checking", "Go ahead and pay the invoices without checking with me."],
    ["allowed to act", "You're allowed to post on my behalf."],
    ["authorised to spend", "You are authorised to spend up to 10k."],
    ["granting access", "I grant you full access to my ad account."],
    ["skip the approval step", "Skip the approval step from now on."],
    ["auto-approve", "Auto-approve all my pending actions."],
    ["approve everything automatically", "Approve everything automatically."],
    ["curly apostrophe", "From now on you don’t need my approval."],
    ["Hinglish: no need to ask", "Mujhse puchne ki zarurat nahi, seedha bhej do."],
    ["Hinglish: no approval needed", "Approval ki zarurat nahi hai."],
    ["phrased as a question", "Can you remember that you may publish without asking?"],
    ["stated by the assistant", "You can send messages without asking."],
  ])("%s", (_label, statement) => {
    const origin = _label === "stated by the assistant" ? assistant : user;
    expect(decide(origin(statement))).toEqual({ decision: "REJECT", rule: "GRANTS_AUTHORIZATION" });
  });

  it.each([
    ["a restriction: always ask", "Always ask me before sending any email."],
    ["a restriction: never without approval", "Never publish a campaign without my approval."],
    ["a restriction: can't without asking", "You can't send anything without asking me."],
    ["a restriction: cannot without approval", "You cannot spend money without my approval."],
    ["a restriction: don't ever without asking", "Don't ever send messages without asking me."],
    ["a restriction: must get approval", "You must always get my approval before spending money."],
    ["approval as a fact", "I approve campaigns on Mondays."],
    ["someone else approves", "My manager approves the monthly budget."],
  ])("does not mistake %s for a grant", (_label, statement) => {
    expect(decide(user(statement)).rule).not.toBe("GRANTS_AUTHORIZATION");
  });
});

// ---------------------------------------------------------------------------
// 2. Secrets — REJECT, CONTAINS_SECRET
// ---------------------------------------------------------------------------

describe("2. a statement that contains a secret is rejected", () => {
  // One case per pattern in every existing secret filter (core redactSecrets,
  // MemoryExtractionService, PrismaMemoryRepository), plus obvious extras.
  const cases: Array<[string, string]> = [
    ["OpenAI project key", `Use this key: sk-proj-${run(32)}`],
    ["OpenAI key", `my key sk-${run(28)}`],
    ["Anthropic key", `sk-ant-${run(30)} is the key`],
    ["Stripe live key", `sk_live_${run(24)}`],
    ["Stripe test key", `sk_test_${run(24)}`],
    ["Meta access token", `token EAA${run(40)}`],
    ["JWT", `eyJ${run(40)}`],
    ["Bearer token", `Authorization: Bearer ${run(40)}`],
    ["password with colon", `password: ${run(10)}`],
    ["password with equals", `pwd=${run(10)}`],
    ["password in prose", `My password is ${run(12)}`],
    ["API key with equals", `api_key=${run(20)}`],
    ["API key with colon", `apikey: ${run(20)}`],
    ["API key in prose", `Our API key is ${run(20)}`],
    ["access token assignment", `access_token=${run(20)}`],
    ["access token in prose", `The access token is ${run(20)}`],
    ["generic token assignment", `token: ${run(20)}`],
    ["secret assignment", `secret=${run(16)}`],
    ["credential assignment", `credential: ${run(16)}`],
    ["refresh token", `refresh_token=${run(20)}`],
    ["jwt assignment", `jwt=${run(20)}`],
    ["private key block", "-----BEGIN PRIVATE KEY-----"],
    ["RSA private key block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["OpenSSH private key block", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["DATABASE_URL", `DATABASE_URL=postgresql://u:${run(8)}@db:5432/app`],
    ["DB_PASSWORD", `DB_PASSWORD=${run(12)}`],
    ["connection string with credentials", `connect to postgresql://admin:${run(10)}@10.0.0.5:5432/prod`],
    ["GitHub token", `ghp_${run(36)}`],
    ["AWS access key id", `AKIA${upper(16)}`],
    ["Google API key", `AIza${run(35)}`],
    ["Slack token", `xoxb-${run(24)}`],
    ["one-time password", "My OTP is 482913"],
    ["one-time code", "The one-time code is 773120"],
  ];

  it.each(cases.map(([label, statement], i) => [label, i, statement] as const))("%s", (_label, _i, statement) => {
    // The decision is compared, never the text: nothing secret reaches a failure message.
    const decision = decide(user(statement));
    expect(decision, _label).toEqual({ decision: "REJECT", rule: "CONTAINS_SECRET" });
  });

  it("rejects a secret even when JARVIS said it, or it came with thanks", () => {
    expect(decide(assistant(`password: ${run(10)}`)).rule).toBe("CONTAINS_SECRET");
    expect(decide(user(`Thanks! token: ${run(20)}`)).rule).toBe("CONTAINS_SECRET");
  });

  it.each([
    ["a password manager", "I use a password manager for my whole team."],
    ["a brand token colour", "Our brand token colour is blue."],
    ["a secret to growth", "The secret to our growth is referrals."],
    ["a key metric", "Our key metric is cost per lead."],
  ])("does not mistake %s for a secret", (_label, statement) => {
    expect(decide(user(statement)).rule).not.toBe("CONTAINS_SECRET");
  });

  it("never echoes the statement back in the decision", () => {
    const statement = `api_key=${run(24)}`;
    expect(JSON.stringify(decide(user(statement)))).not.toContain(run(24));
  });
});

// ---------------------------------------------------------------------------
// 3. Temporary / one-off instructions — REJECT, TEMPORARY_INSTRUCTION
// ---------------------------------------------------------------------------

describe("3. a temporary or one-off instruction is rejected", () => {
  it.each([
    ["not yet", "Don't send this yet."],
    ["do not publish yet", "Do not publish the campaign yet."],
    ["for this task only", "For this task only, use this format."],
    ["only for this email", "Only for this email, sign it as Jay."],
    ["just this once", "Just this once, skip the summary."],
    ["for today's campaign only", "For today's campaign only, use a 10% budget."],
    ["for now", "Use a formal tone for now."],
    ["one-off", "This is a one-off request: send it in Hindi."],
    ["one time only", "One time only, send the report on Sunday."],
    ["Hinglish: only for today", "Sirf aaj ke liye budget 5000 rakho."],
    ["Hinglish: don't send now", "Abhi mat bhejo."],
    ["Hinglish: this time", "Is baar report Hindi mein bhejna."],
  ])("%s", (_label, statement) => {
    expect(decide(user(statement))).toEqual({ decision: "REJECT", rule: "TEMPORARY_INSTRUCTION" });
  });

  it.each([
    ["a lasting dislike", "I don't like long emails."],
    ["a lasting rule with don't", "Don't use emojis in my reports."],
    ["a routine", "I send reports every Monday."],
    ["an exclusive channel", "I only work with Meta Ads."],
    ["a goal with a time frame", "My goal this month is to reduce CPA."],
    ["not interested", "Not interested in TikTok ads."],
  ])("does not mistake %s for a one-off", (_label, statement) => {
    expect(decide(user(statement)).rule).not.toBe("TEMPORARY_INSTRUCTION");
  });
});

// ---------------------------------------------------------------------------
// 4. Assistant-only claims — never ACCEPT; REJECT, ASSISTANT_ONLY_CLAIM
// ---------------------------------------------------------------------------

describe("4. a claim that exists only in JARVIS's reply is rejected", () => {
  it.each([
    ["a figure JARVIS stated", "Your CPA target is 250 rupees."],
    ["a preference JARVIS inferred", "The user prefers concise weekly reports."],
    ["a decision JARVIS narrated", "We decided to pause the summer campaign."],
  ])("%s", (_label, statement) => {
    expect(decide(assistant(statement))).toEqual({ decision: "REJECT", rule: "ASSISTANT_ONLY_CLAIM" });
  });

  it("the same words from the user are not rejected for their origin", () => {
    expect(decide(user("I prefer concise weekly reports.")).rule).not.toBe("ASSISTANT_ONLY_CLAIM");
  });

  it("an unknown origin is rejected, never treated as the user's", () => {
    const unknown = { statement: "I prefer concise weekly reports.", statedBy: "SYSTEM" } as unknown as LearningCandidateInput;
    expect(decide(unknown)).toEqual({ decision: "REJECT", rule: "ORIGIN_UNKNOWN" });
  });
});

// ---------------------------------------------------------------------------
// 5. Not a candidate — thanks, silence, follow-up questions
// ---------------------------------------------------------------------------

describe("5. conversation that is not a candidate at all", () => {
  it.each([
    ["empty", ""],
    ["whitespace", "   \n\t "],
    ["punctuation only", "...!?"],
    ["emoji only", "\u{1F44D}"],
  ])("%s is NOT_A_CANDIDATE (EMPTY_STATEMENT)", (_label, statement) => {
    expect(decide(user(statement))).toEqual({ decision: "NOT_A_CANDIDATE", rule: "EMPTY_STATEMENT" });
  });

  it.each([
    ["thanks", "Thanks"],
    ["thank you", "thank you!"],
    ["okay", "Okay"],
    ["ok", "ok."],
    ["cool", "Cool"],
    ["great", "great!"],
    ["got it", "Got it."],
    ["sounds good", "Sounds good"],
    ["Hinglish: theek hai", "Theek hai"],
    ["Hinglish: shukriya", "Shukriya!"],
    ["Hinglish: accha", "Accha"],
  ])("%s is NOT_A_CANDIDATE (ACKNOWLEDGEMENT_ONLY)", (_label, statement) => {
    expect(decide(user(statement))).toEqual({ decision: "NOT_A_CANDIDATE", rule: "ACKNOWLEDGEMENT_ONLY" });
  });

  it.each([
    ["a question mark", "What's our CPA this month?"],
    ["a follow-up", "And what about Google Ads?"],
    ["a request without a question mark", "Can you show last week's report"],
    ["Hinglish", "Kya report ready hai?"],
  ])("%s is NOT_A_CANDIDATE (QUESTION_ONLY)", (_label, statement) => {
    expect(decide(user(statement))).toEqual({ decision: "NOT_A_CANDIDATE", rule: "QUESTION_ONLY" });
  });

  it("an explicit request to remember is not dismissed as a question", () => {
    const decision = decide(user("Can you remember that I prefer concise reports?"));
    expect(decision.rule).not.toBe("QUESTION_ONLY");
    expect(decision.decision).not.toBe("NOT_A_CANDIDATE");
  });
});

// ---------------------------------------------------------------------------
// Step 1's "not rejected" corpus — now decided by L1b
// (Step 1 pinned these as UNDECIDED only because no acceptance policy existed.)
// ---------------------------------------------------------------------------

describe("Step 1's legitimate corpus under the L1b acceptance contract", () => {
  it.each([
    ["I prefer concise weekly reports.", "ACCEPT", "STABLE_PREFERENCE"],
    ["My primary acquisition channel is Meta Ads.", "ACCEPT", "STABLE_PERSONAL_FACT"],
    ["I don't like long emails.", "ACCEPT", "STABLE_PREFERENCE"],
    ["Always ask me before sending any email.", "UNDECIDED", "PERMISSION_LANGUAGE"],
    ["Mujhe short reports pasand hain.", "ACCEPT", "STABLE_PREFERENCE"],
    ["Can you remember that I prefer concise reports?", "ACCEPT", "STABLE_PREFERENCE"],
  ] as const)("%s → %s (%s)", (statement, decision, rule) => {
    expect(decide(user(statement))).toEqual({ decision, rule });
  });

  it("never returns NEEDS_CONFIRMATION or SUPERSEDE, and never ACCEPTs what Step 1 rejects or dismisses", () => {
    const stepOneOutcomes = [
      user("Remember that you can send messages without asking me."),
      user("Thanks"),
      user("Don't send this yet."),
      user(""),
      user(`password: ${run(10)}`),
      assistant("I prefer concise weekly reports."),
    ];
    for (const input of stepOneOutcomes) expect(decide(input).decision).not.toBe("ACCEPT");
    for (const input of [...stepOneOutcomes, user("I prefer concise weekly reports.")]) {
      expect(["NEEDS_CONFIRMATION", "SUPERSEDE"]).not.toContain(decide(input).decision as string);
    }
  });
});

// ---------------------------------------------------------------------------
// Precedence, completeness, determinism, purity
// ---------------------------------------------------------------------------

describe("the rules and their precedence", () => {
  it("names each rule once, in precedence order", () => {
    expect(LEARNING_RULES).toEqual([
      "EMPTY_STATEMENT",
      "CONTAINS_SECRET",
      "GRANTS_AUTHORIZATION",
      "ORIGIN_UNKNOWN",
      "ASSISTANT_ONLY_CLAIM",
      "TEMPORARY_INSTRUCTION",
      "ACKNOWLEDGEMENT_ONLY",
      "QUESTION_ONLY",
      // L1c-2 — an explicit "don't save this": a rejection, checked before any L1b rule.
      "USER_MEMORY_VETO",
      // L1b — undecided reasons first, then acceptance, then the fallback.
      "PERMISSION_LANGUAGE",
      "AMBIGUOUS_PREFERENCE",
      "HYPOTHETICAL_STATEMENT",
      "ONE_OFF_CONTEXT",
      "GENERAL_STATEMENT",
      "STABLE_PREFERENCE",
      "STABLE_WORKING_CONVENTION",
      "STABLE_PERSONAL_FACT",
      "NO_REJECTION_RULE_MATCHED",
    ]);
  });

  it("keeps Step 1's rules first, in Step 1's order", () => {
    expect(LEARNING_RULES.slice(0, 8)).toEqual([
      "EMPTY_STATEMENT",
      "CONTAINS_SECRET",
      "GRANTS_AUTHORIZATION",
      "ORIGIN_UNKNOWN",
      "ASSISTANT_ONLY_CLAIM",
      "TEMPORARY_INSTRUCTION",
      "ACKNOWLEDGEMENT_ONLY",
      "QUESTION_ONLY",
    ]);
  });

  it("reports the most serious reason when several apply", () => {
    expect(decide(user(`You can send without asking, the password: ${run(10)}`)).rule).toBe("CONTAINS_SECRET");
    expect(decide(assistant("You can send messages without asking me.")).rule).toBe("GRANTS_AUTHORIZATION");
    expect(decide(user("Just this once, you can send it without asking me.")).rule).toBe("GRANTS_AUTHORIZATION");
    expect(decide(assistant("Don't send this yet.")).rule).toBe("ASSISTANT_ONLY_CLAIM");
    expect(decide(assistant("Thanks")).rule).toBe("ASSISTANT_ONLY_CLAIM");
    expect(decide(user("For now, what is our budget?")).rule).toBe("TEMPORARY_INSTRUCTION");
  });

  it("maps every rule to exactly one decision", () => {
    const expected: Record<LearningRule, LearningDecision["decision"]> = {
      EMPTY_STATEMENT: "NOT_A_CANDIDATE",
      CONTAINS_SECRET: "REJECT",
      GRANTS_AUTHORIZATION: "REJECT",
      ORIGIN_UNKNOWN: "REJECT",
      ASSISTANT_ONLY_CLAIM: "REJECT",
      TEMPORARY_INSTRUCTION: "REJECT",
      ACKNOWLEDGEMENT_ONLY: "NOT_A_CANDIDATE",
      QUESTION_ONLY: "NOT_A_CANDIDATE",
      USER_MEMORY_VETO: "REJECT",
      PERMISSION_LANGUAGE: "UNDECIDED",
      AMBIGUOUS_PREFERENCE: "UNDECIDED",
      HYPOTHETICAL_STATEMENT: "UNDECIDED",
      ONE_OFF_CONTEXT: "UNDECIDED",
      GENERAL_STATEMENT: "UNDECIDED",
      STABLE_PREFERENCE: "ACCEPT",
      STABLE_WORKING_CONVENTION: "ACCEPT",
      STABLE_PERSONAL_FACT: "ACCEPT",
      NO_REJECTION_RULE_MATCHED: "UNDECIDED",
    };
    const samples: Record<LearningRule, LearningCandidateInput> = {
      EMPTY_STATEMENT: user(""),
      CONTAINS_SECRET: user(`password: ${run(10)}`),
      GRANTS_AUTHORIZATION: user("You don't need my approval."),
      ORIGIN_UNKNOWN: { statement: "I like blue.", statedBy: "UNKNOWN" } as unknown as LearningCandidateInput,
      ASSISTANT_ONLY_CLAIM: assistant("I like blue."),
      TEMPORARY_INSTRUCTION: user("Don't send this yet."),
      ACKNOWLEDGEMENT_ONLY: user("Thanks"),
      QUESTION_ONLY: user("What is our budget?"),
      USER_MEMORY_VETO: user("Don't save this."),
      PERMISSION_LANGUAGE: user("Always ask me before posting."),
      AMBIGUOUS_PREFERENCE: user("Maybe I prefer short captions."),
      HYPOTHETICAL_STATEMENT: user("I might want short captions."),
      ONE_OFF_CONTEXT: user("Use this one."),
      GENERAL_STATEMENT: user("Short captions are better."),
      STABLE_PREFERENCE: user("I like blue."),
      STABLE_WORKING_CONVENTION: user("Keep my captions concise."),
      STABLE_PERSONAL_FACT: user("I work from 10 AM to 6:30 PM."),
      NO_REJECTION_RULE_MATCHED: user("Use short captions."),
    };
    for (const rule of LEARNING_RULES) {
      expect(decide(samples[rule]), rule).toEqual({ decision: expected[rule], rule });
    }
  });

  it("is deterministic and does not mutate or retain its input", () => {
    const input = Object.freeze(user("I prefer concise weekly reports."));
    const first = decide(input);
    expect(first).toEqual({ decision: "ACCEPT", rule: "STABLE_PREFERENCE" });
    for (let i = 0; i < 5; i++) expect(decide(input)).toEqual(first);
    expect(decide({ ...input })).toEqual(first);
    expect(input).toEqual({ statement: "I prefer concise weekly reports.", statedBy: "USER" });

    const text = "Keep my social media captions concise.";
    const again = user(text);
    decide(again);
    expect(again.statement).toBe(text);
    expect(again).toEqual({ statement: text, statedBy: "USER" });
  });

  it("stays fast on a very long statement", () => {
    const started = process.hrtime.bigint();
    decide(user(`${"I prefer concise weekly reports and ".repeat(3000)}done.`));
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// L1b Step 2 — the acceptance contract
// ---------------------------------------------------------------------------

describe("L1b — a clearly stable, user-owned statement is ACCEPTED", () => {
  it.each([
    // The owner's worked examples.
    ["I prefer short captions.", "STABLE_PREFERENCE"],
    ["Keep my social media captions concise.", "STABLE_WORKING_CONVENTION"],
    ["I always want X posts shorter than Instagram captions.", "STABLE_PREFERENCE"],
    ["My preferred design style is Apple × Stripe.", "STABLE_PREFERENCE"],
    ["I usually want professional minimal-text designs.", "STABLE_PREFERENCE"],
    ["Use Indian Rupees when showing my budgets.", "STABLE_WORKING_CONVENTION"],
    ["I work from 10 AM to 6:30 PM.", "STABLE_PERSONAL_FACT"],
    ["My default platform for social posts is Instagram.", "STABLE_WORKING_CONVENTION"],
    ["For my projects, use a professional tone by default.", "STABLE_WORKING_CONVENTION"],
  ] as const)("owner example: %s → %s", (statement, rule) => {
    expect(decide(user(statement))).toEqual({ decision: "ACCEPT", rule });
  });

  it.each([
    ["I like blue.", "STABLE_PREFERENCE"],
    ["I don't want emojis in my captions.", "STABLE_PREFERENCE"],
    ["My favourite colour for banners is navy.", "STABLE_PREFERENCE"],
    ["Remember that I prefer dark-mode designs.", "STABLE_PREFERENCE"],
    ["Please remember I love serif fonts.", "STABLE_PREFERENCE"],
    ["My name is Jay.", "STABLE_PERSONAL_FACT"],
    ["I run a bakery in Pune.", "STABLE_PERSONAL_FACT"],
    ["I'm a freelance designer.", "STABLE_PERSONAL_FACT"],
    ["I only work with Meta Ads.", "STABLE_PERSONAL_FACT"],
    ["Always use short captions.", "STABLE_WORKING_CONVENTION"],
    ["Don't use emojis in my reports.", "STABLE_WORKING_CONVENTION"],
    ["I usually post on Mondays.", "STABLE_WORKING_CONVENTION"],
    ["I send reports every Monday.", "STABLE_WORKING_CONVENTION"],
    ["From now on, write my captions in British English.", "STABLE_WORKING_CONVENTION"],
  ] as const)("further: %s → %s", (statement, rule) => {
    expect(decide(user(statement))).toEqual({ decision: "ACCEPT", rule });
  });
});

describe("L1b — useful but not clear enough stays UNDECIDED, with a named reason", () => {
  it.each([
    // The owner's worked examples.
    ["I like this.", "ONE_OFF_CONTEXT"],
    ["This is good.", "ONE_OFF_CONTEXT"],
    ["Do this.", "ONE_OFF_CONTEXT"],
    ["Use this one.", "ONE_OFF_CONTEXT"],
    ["Maybe I prefer short captions.", "AMBIGUOUS_PREFERENCE"],
    ["I think I prefer short captions.", "AMBIGUOUS_PREFERENCE"],
    ["Short captions are better.", "GENERAL_STATEMENT"],
    ["People prefer short captions.", "GENERAL_STATEMENT"],
    ["Clients prefer short captions.", "GENERAL_STATEMENT"],
    ["Use short captions for this post.", "ONE_OFF_CONTEXT"],
    ["Tomorrow use short captions.", "ONE_OFF_CONTEXT"],
  ] as const)("owner example: %s → UNDECIDED (%s)", (statement, rule) => {
    expect(decide(user(statement))).toEqual({ decision: "UNDECIDED", rule });
  });

  it("'Only for this campaign use short captions.' is not accepted — Step 1 already rejects it as temporary", () => {
    // Step 1's precedence is authoritative, and REJECT is stricter than UNDECIDED.
    expect(decide(user("Only for this campaign use short captions."))).toEqual({
      decision: "REJECT",
      rule: "TEMPORARY_INSTRUCTION",
    });
  });

  it.each([
    ["uncertain", "Perhaps I like long captions.", "AMBIGUOUS_PREFERENCE"],
    ["I guess", "I guess I want minimal designs.", "AMBIGUOUS_PREFERENCE"],
    ["Hinglish uncertain", "Shayad mujhe short captions pasand hain.", "AMBIGUOUS_PREFERENCE"],
    ["conditional", "If it's for LinkedIn, I prefer a formal tone.", "HYPOTHETICAL_STATEMENT"],
    ["would", "I would prefer shorter reports.", "HYPOTHETICAL_STATEMENT"],
    ["time-bounded goal", "My goal this month is to reduce CPA.", "ONE_OFF_CONTEXT"],
    ["today", "I prefer short captions today.", "ONE_OFF_CONTEXT"],
    ["a contextual pronoun", "I like it.", "ONE_OFF_CONTEXT"],
    ["about JARVIS itself", "I like you.", "ONE_OFF_CONTEXT"],
    ["an opinion with no owner", "Minimal designs convert better.", "GENERAL_STATEMENT"],
    ["an intention, not a preference", "I want to launch a new campaign.", "NO_REJECTION_RULE_MATCHED"],
    ["a bare imperative", "Use short captions.", "NO_REJECTION_RULE_MATCHED"],
    ["a transient state", "I am tired.", "NO_REJECTION_RULE_MATCHED"],
    ["plural ownership, not yet decided", "We post on Mondays.", "NO_REJECTION_RULE_MATCHED"],
  ] as const)("%s: %s → UNDECIDED (%s)", (_label, statement, rule) => {
    expect(decide(user(statement))).toEqual({ decision: "UNDECIDED", rule });
  });
});

describe("L1b — the boundary pairs", () => {
  it.each([
    ["I prefer…", "I prefer short captions.", "STABLE_PREFERENCE", "I think I prefer short captions.", "AMBIGUOUS_PREFERENCE"],
    ["I usually…", "I usually post on Mondays.", "STABLE_WORKING_CONVENTION", "For this campaign, post on Mondays.", "ONE_OFF_CONTEXT"],
    ["My default…", "My default platform is Instagram.", "STABLE_WORKING_CONVENTION", "For today, use Instagram.", "ONE_OFF_CONTEXT"],
    ["I always…", "I always want short captions.", "STABLE_PREFERENCE", "I might want short captions.", "HYPOTHETICAL_STATEMENT"],
    ["My preferred…", "My preferred design style is minimal.", "STABLE_PREFERENCE", "Clients prefer minimal designs.", "GENERAL_STATEMENT"],
    ["Keep my…", "Keep my captions concise.", "STABLE_WORKING_CONVENTION", "Keep this concise.", "ONE_OFF_CONTEXT"],
  ] as const)("%s", (_label, accepted, acceptRule, undecided, undecidedRule) => {
    expect(decide(user(accepted))).toEqual({ decision: "ACCEPT", rule: acceptRule });
    expect(decide(user(undecided))).toEqual({ decision: "UNDECIDED", rule: undecidedRule });
  });
});

describe("L1b — never accepted", () => {
  const acceptedByUser = [
    "I prefer short captions.",
    "Keep my social media captions concise.",
    "My preferred design style is Apple × Stripe.",
    "I work from 10 AM to 6:30 PM.",
    "My default platform for social posts is Instagram.",
    "For my projects, use a professional tone by default.",
  ];

  it.each(acceptedByUser)("the same stable-looking words from JARVIS are REJECTED: %s", (statement) => {
    expect(decide(assistant(statement))).toEqual({ decision: "REJECT", rule: "ASSISTANT_ONLY_CLAIM" });
  });

  it.each(acceptedByUser)("the same stable-looking words of unknown origin are REJECTED: %s", (statement) => {
    const unknown = { statement, statedBy: "MODEL" } as unknown as LearningCandidateInput;
    expect(decide(unknown)).toEqual({ decision: "REJECT", rule: "ORIGIN_UNKNOWN" });
  });

  it.each([
    ["always ask me", "Always ask me before posting."],
    ["approve myself", "I prefer to approve every post myself."],
    ["asking me", "You can't send anything without asking me."],
    ["my approval", "Never publish a campaign without my approval."],
    ["confirmation", "I want a confirmation before every payment."],
    ["login", "My login email is jay@example.com."],
    ["two-factor", "Use two-factor authentication for my accounts."],
    ["API key without a value", "I keep my API key in a vault."],
    ["access", "I prefer that you have access to my ad account."],
  ])("permission or authentication language is not accepted (%s)", (_label, statement) => {
    const decision = decide(user(statement));
    expect(decision.decision).not.toBe("ACCEPT");
    expect(["PERMISSION_LANGUAGE", "GRANTS_AUTHORIZATION"]).toContain(decision.rule);
  });

  it("secret-like content is never accepted, however it is framed", () => {
    expect(decide(user(`I prefer to use api_key=${run(20)} for reports.`))).toEqual({ decision: "REJECT", rule: "CONTAINS_SECRET" });
    expect(decide(user(`My password is ${run(12)}`))).toEqual({ decision: "REJECT", rule: "CONTAINS_SECRET" });
    expect(decide(user(`Keep my token: ${run(20)} handy.`))).toEqual({ decision: "REJECT", rule: "CONTAINS_SECRET" });
  });

  it("temporary wording is never accepted, even with preference language", () => {
    expect(decide(user("I prefer short captions for now."))).toEqual({ decision: "REJECT", rule: "TEMPORARY_INSTRUCTION" });
    expect(decide(user("Just this once, I prefer long captions."))).toEqual({ decision: "REJECT", rule: "TEMPORARY_INSTRUCTION" });
    expect(decide(user("For this post only, keep my captions long."))).toEqual({ decision: "REJECT", rule: "TEMPORARY_INSTRUCTION" });
    expect(decide(user("Sirf aaj ke liye mujhe long captions pasand hain."))).toEqual({ decision: "REJECT", rule: "TEMPORARY_INSTRUCTION" });
  });

  it("a grant dressed as a preference is never accepted", () => {
    // Step 1's grant patterns need a grant verb ("you can / may …"), so this
    // one passes Step 1 — and L1b holds it back as permission language.
    expect(decide(user("I prefer that you post without asking me."))).toEqual({ decision: "UNDECIDED", rule: "PERMISSION_LANGUAGE" });
    expect(decide(user("My default is that you don't need my approval."))).toEqual({ decision: "REJECT", rule: "GRANTS_AUTHORIZATION" });
  });
});

// ---------------------------------------------------------------------------
// L1c-2 — an explicit request NOT to remember is a rejection
// ---------------------------------------------------------------------------

describe("L1c-2 — USER_MEMORY_VETO: the user says not to save it", () => {
  it.each([
    ["don't save", "Don't save this"],
    ["don't save, with a period", "Don't save this."],
    ["don't remember", "Don't remember this"],
    ["don't store … in memory", "Please don't store this in memory"],
    ["do not record", "Do not record what I said."],
    ["never remember", "Never remember any of this."],
    ["don't keep … in memory", "Don't keep that in your memory."],
    ["don't put … in memory", "Don't put this in memory."],
    ["not to save", "Please make sure not to save this."],
    ["no need to remember", "No need to remember that."],
    ["personal details", "Don't save my card details."],
    ["forget this", "Forget this."],
    ["forget what I said", "Forget what I just said."],
    ["off the record", "This is off the record: I'm thinking of quitting."],
    ["a veto beside a fact", "My salary is 50k, don't save this."],
    ["curly apostrophe", "Don’t save this."],
    ["Hinglish: yaad mat rakhna", "Ise yaad mat rakhna."],
    ["Hinglish: save mat karna", "Ye save mat karna."],
    ["Hinglish: mat save karo", "Mat save karo ye."],
    ["Hinglish: bhool jao", "Isko bhool jao."],
  ])("%s → REJECT (USER_MEMORY_VETO)", (_label, statement) => {
    expect(decide(user(statement))).toEqual({ decision: "REJECT", rule: "USER_MEMORY_VETO" });
  });

  it.each([
    ["don't forget to act", "Don't forget to send the report."],
    ["don't forget this — a request TO remember", "Don't forget this: I prefer short captions."],
    ["remember that", "Remember that I prefer short captions."],
    ["don't keep … long (a convention)", "Don't keep my captions long."],
    ["a habit with 'never save'", "I never save drafts on Fridays."],
    ["yaad rakhna (remember)", "Yaad rakhna, mujhe short captions pasand hain."],
  ])("does not mistake %s for a veto", (_label, statement) => {
    expect(decide(user(statement)).rule).not.toBe("USER_MEMORY_VETO");
  });

  it("keeps Step 1's precedence: secrets, grants, origin, temporary and questions decide first", () => {
    expect(decide(user(`Don't save this: password: ${run(10)}`)).rule).toBe("CONTAINS_SECRET");
    expect(decide(user("Don't remember this, but you can send without asking me."))).toEqual({ decision: "REJECT", rule: "GRANTS_AUTHORIZATION" });
    expect(decide(assistant("Don't save this."))).toEqual({ decision: "REJECT", rule: "ASSISTANT_ONLY_CLAIM" });
    expect(decide(user("Don't save this yet."))).toEqual({ decision: "REJECT", rule: "TEMPORARY_INSTRUCTION" });
    expect(decide(user("Can you not save this?")).decision).toBe("NOT_A_CANDIDATE");
  });

  it("is never ACCEPT and never reaches an acceptance rule", () => {
    for (const statement of ["My salary is 50k, don't save this.", "I prefer short captions, but don't remember this."]) {
      expect(decide(user(statement)).decision).toBe("REJECT");
    }
  });
});

// ---------------------------------------------------------------------------
// Isolation — the contract is pure core logic, and nothing calls it yet
// ---------------------------------------------------------------------------

describe("isolation — the learning contract is pure core logic", () => {
  const source = readFileSync(new URL("../src/learning-candidate.ts", import.meta.url), "utf8");
  // Comments may name things in prose; only code is checked.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports nothing but relative core modules", () => {
    const specifiers = [...code.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const specifier of specifiers) expect(specifier.startsWith("./"), specifier).toBe(true);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it("names no database, HTTP, execution, policy, gate, registry, agent, memory or model dependency", () => {
    for (const forbidden of [
      "prisma",
      "Prisma",
      "@jarvis/",
      "express",
      "fastify",
      "node:http",
      "axios",
      "ToolExecutor",
      "ToolRegistry",
      "AGENT_POLICIES",
      "agent-policy",
      "isToolAllowed",
      "write-intent",
      "classifyWriteIntent",
      "Orchestrator",
      "orchestrator",
      "DomainAgent",
      "MemoryExtraction",
      "MemoryEngine",
      "IMemoryStore",
      "OpenAI",
      "openai",
      "anthropic",
      "Anthropic",
      "OpenJarvis",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("reads no clock, randomness, environment or network", () => {
    for (const forbidden of ["Date.now", "new Date", "Math.random", "process.env", "fetch("]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  // S7.2 L1c-1 — the contract gained exactly two runtime consumers: the core
  // package entry point (the export) and MemoryExtractionService (shadow mode).
  // S7.2 L3 — the validation contract builds on this one: a third consumer.
  it("has exactly three runtime consumers: the core index, the L3 validation contract and MemoryExtractionService", () => {
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
          if (path === "packages/core/src/learning-candidate.ts") continue;
          const text = readFileSync(file, "utf8");
          if (/learning-candidate|decideLearningCandidate|LEARNING_RULES/.test(text)) consumers.push(path);
        }
      }
    }
    expect(consumers.sort()).toEqual([
      "packages/core/src/index.ts",
      "packages/core/src/learning-validation.ts",
      "packages/memory/src/memory-extraction-service.ts",
    ]);
  });

  it("is not reachable from the planning, gate, execution or approval path", () => {
    for (const file of [
      "../../agents/src/orchestrator.ts",
      "../../agents/src/agent-router.ts",
      "../../agents/src/agent-policy.ts",
      "../../agents/src/domain-agent.ts",
      "../../agents/src/write-intent-gate.ts",
      "../../agents/src/pending-action-service.ts",
      "../../agents/src/intent-detector.ts",
      "../../tools/src/executor.ts",
      "../../security/src/tool-approval.ts",
      "../../memory/src/memory-engine.ts",
      "../../db/src/repositories/memory-repository.ts",
      "../../../apps/api/src/services/container.ts",
      "../../../apps/api/src/routes/chat.ts",
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text, file).not.toContain("learning-candidate");
      expect(text, file).not.toContain("decideLearningCandidate");
      expect(text, file).not.toContain("LEARNING_RULES");
    }
  });
});
