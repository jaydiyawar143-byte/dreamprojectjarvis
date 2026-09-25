// ---------------------------------------------------------------------------
// S6 — Objective extraction (Implementation Phase 1).
//
// `extractObjectives(traceId, request)` turns the user's OWN words into a flat,
// ordered list of objectives, each carrying one evidence class and the skills
// its words name. It is the first half of S6 Objective Evaluation; the second
// half (facts, attribution, statuses) is a later phase and is not tested here.
//
// WHAT THESE TESTS PIN, and why each matters:
//
//   PURE        no model, no I/O, no clock, no randomness. The same request
//               produces byte-identical output every time, so an evaluation
//               can be re-derived and audited.
//   VERBATIM    every objective's text is a trimmed substring of what the
//               user typed. Nothing is paraphrased, generated or rewritten.
//   CLOSED      the markers and the skill vocabulary are fixed lists. The
//               skill ids are exactly the S2 catalogue's; none is invented.
//   CONSERVATIVE when a request cannot be split safely it stays one objective,
//               and a request that names nothing classifiable yields none.
//
// The corpus at the bottom is the contract in executable form. A sentence
// whose result looks surprising is pinned deliberately under "known edges",
// so a later change to the closed lists is a visible, reviewed decision.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  extractObjectives,
  extractionMissing,
  EVIDENCE_CLASS_PRECEDENCE,
  MAX_OBJECTIVES,
  OBJECTIVE_SKILL_VOCABULARY,
  type EvidenceClass,
  type Objective,
} from "../src/objective-extraction.js";
import { SKILL_CATALOG } from "../src/capability-presentation.js";

const TRACE = "trace-s6";

const R: EvidenceClass = "RETRIEVE";
const W: EvidenceClass = "EXTERNAL_WRITE";
const C: EvidenceClass = "COMPOSE";
const A: EvidenceClass = "ANALYZE";

function classes(request: string): EvidenceClass[] {
  return extractObjectives(TRACE, request).map((o) => o.evidenceClass);
}

function only(request: string): Objective {
  const objectives = extractObjectives(TRACE, request);
  expect(objectives).toHaveLength(1);
  return objectives[0]!;
}

// ---------------------------------------------------------------------------
// The four requests the S6 contract was designed around
// ---------------------------------------------------------------------------

describe("the contract's worked requests", () => {
  it("1. A — one RETRIEVE objective about advertising", () => {
    expect(extractObjectives(TRACE, "Check my campaign performance.")).toEqual([
      {
        objectiveId: `${TRACE}#0`,
        text: "Check my campaign performance.",
        evidenceClass: R,
        skills: ["advertising"],
      },
    ]);
  });

  it("2. B — RETRIEVE then ANALYZE", () => {
    expect(extractObjectives(TRACE, "Check my campaigns and tell me which ones are weak.")).toEqual([
      { objectiveId: `${TRACE}#0`, text: "Check my campaigns", evidenceClass: R, skills: ["advertising"] },
      { objectiveId: `${TRACE}#1`, text: "tell me which ones are weak.", evidenceClass: A, skills: [] },
    ]);
  });

  it("3. C — RETRIEVE, ANALYZE, COMPOSE", () => {
    expect(
      extractObjectives(TRACE, "Check my campaigns, identify weak ones, and draft an email.")
    ).toEqual([
      { objectiveId: `${TRACE}#0`, text: "Check my campaigns", evidenceClass: R, skills: ["advertising"] },
      { objectiveId: `${TRACE}#1`, text: "identify weak ones", evidenceClass: A, skills: [] },
      { objectiveId: `${TRACE}#2`, text: "draft an email.", evidenceClass: C, skills: ["workspace"] },
    ]);
  });

  it("4. D — adds an EXTERNAL_WRITE", () => {
    expect(
      extractObjectives(TRACE, "Check my campaigns, identify weak ones, draft an email, and send it.")
    ).toEqual([
      { objectiveId: `${TRACE}#0`, text: "Check my campaigns", evidenceClass: R, skills: ["advertising"] },
      { objectiveId: `${TRACE}#1`, text: "identify weak ones", evidenceClass: A, skills: [] },
      { objectiveId: `${TRACE}#2`, text: "draft an email", evidenceClass: C, skills: ["workspace"] },
      { objectiveId: `${TRACE}#3`, text: "send it.", evidenceClass: W, skills: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Framing, openers and questions
// ---------------------------------------------------------------------------

describe("framing and questions", () => {
  it("5. 'How do I change the budget?' is RETRIEVE, never EXTERNAL_WRITE", () => {
    const o = only("How do I change the budget?");
    expect(o.evidenceClass).toBe(R);
    expect(o.skills).toEqual(["advertising"]);
  });

  it("6. 'Can you pause the campaign?' is EXTERNAL_WRITE — the request opener beats the '?'", () => {
    expect(only("Can you pause the campaign?").evidenceClass).toBe(W);
  });

  it("34. a trailing '?' makes a write RETRIEVE unless the message opens with a request", () => {
    expect(classes("Pause the campaign?")).toEqual([R]);
    expect(classes("Please pause the campaign?")).toEqual([W]);
    expect(classes("Could you send it to the team?")).toEqual([W]);
    expect(classes("Would you share the file?")).toEqual([W]);
  });

  it("35. information framing suppresses a write, with or without a '?'", () => {
    expect(classes("Should I increase the budget?")).toEqual([R]);
    expect(classes("How to disable the integration")).toEqual([R]);
    expect(classes("Do you know how to delete a campaign")).toEqual([R]);
    expect(classes("Tell me about pausing campaigns")).toEqual([R]);
  });

  it("12. question forms classify by what they ask", () => {
    expect(classes("What is my ROAS?")).toEqual([R]);
    expect(classes("How much did I spend yesterday?")).toEqual([R]);
    expect(classes("Which campaigns are weak?")).toEqual([A]);
    expect(classes("Why are my ads not converting?")).toEqual([A]);
    expect(only("Is my Meta account connected?").skills).toEqual(["advertising", "integrations"]);
  });
});

// ---------------------------------------------------------------------------
// Negation, noun guard, merging
// ---------------------------------------------------------------------------

describe("negation", () => {
  it("7. 'iska plan banao, execute mat karo' keeps the compose objective and yields no action", () => {
    // "execute mat karo" carries no marker, so it is not a clause of its own:
    // it merges into the compose clause before it, and — being unmarked — its
    // negation has no effect. What matters is what the contract guarantees:
    // the compose objective survives and NO action objective is produced.
    const request = "iska plan banao, execute mat karo";
    const objectives = extractObjectives(TRACE, request);
    expect(objectives.map((o) => o.evidenceClass)).toEqual([C]);
    expect(objectives[0]!.text).toBe("iska plan banao, execute mat karo");
    expect(objectives.some((o) => o.evidenceClass === W)).toBe(false);
  });

  it("36. a negated clause that names an action is dropped", () => {
    expect(extractObjectives(TRACE, "Check my campaigns, don't pause anything")).toEqual([
      { objectiveId: `${TRACE}#0`, text: "Check my campaigns", evidenceClass: R, skills: ["advertising"] },
    ]);
    expect(classes("report banao, email mat bhejo")).toEqual([C]);
    expect(classes("Never delete my files")).toEqual([]);
    expect(classes("Do not send it")).toEqual([]);
  });

  it("negation in an UNMARKED clause has no effect on its neighbour", () => {
    const o = only("Don't worry, check my campaigns");
    expect(o.evidenceClass).toBe(R);
    expect(o.text).toBe("Don't worry, check my campaigns");
  });

  it("negated clauses do not count toward the objective cap", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `check list ${i}`).join(", ");
    expect(extractObjectives(TRACE, `${eight}, don't send anything`)).toHaveLength(8);
  });
});

describe("8. the noun guard", () => {
  it.each(["the draft", "an update", "the ad set"])("'%s' on its own yields no objective", (request) => {
    expect(extractObjectives(TRACE, request)).toEqual([]);
  });

  it("a guarded noun never becomes a write or a compose objective", () => {
    expect(classes("Show me the draft")).toEqual([R]);
    expect(classes("Give me an update")).toEqual([R]);
    expect(classes("Show the ad set")).toEqual([R]);
    expect(classes("Any update on the campaign?")).toEqual([R]);
  });
});

describe("merging unmarked clauses", () => {
  it("37. a leading unmarked clause merges into the next marked one", () => {
    expect(only("Hi JARVIS, show my tasks").text).toBe("Hi JARVIS, show my tasks");
  });

  it("38. trailing unmarked clauses merge into the previous objective", () => {
    expect(only("Check my ads and campaigns").text).toBe("Check my ads and campaigns");
    const pause = only("Pause the campaign, thanks");
    expect(pause.evidenceClass).toBe(W);
    expect(pause.text).toBe("Pause the campaign, thanks");
  });

  it("a request that cannot be split safely stays one objective", () => {
    const o = only("Compare Meta and Google ads");
    expect(o.evidenceClass).toBe(A);
    expect(o.text).toBe("Compare Meta and Google ads");
  });
});

// ---------------------------------------------------------------------------
// Class rules
// ---------------------------------------------------------------------------

describe("class rules", () => {
  it("31. precedence is EXTERNAL_WRITE > COMPOSE > ANALYZE > RETRIEVE", () => {
    expect(EVIDENCE_CLASS_PRECEDENCE).toEqual([W, C, A, R]);
    expect(classes("send the weak campaigns report")).toEqual([W]); // W + A
    expect(classes("draft which campaigns are worst")).toEqual([C]); // C + A + R
    expect(classes("show the worst campaigns")).toEqual([A]); // A + R
    expect(classes("check what changed")).toEqual([R]);
  });

  it("32. a creation verb with an artifact noun is COMPOSE", () => {
    expect(classes("Create a report on spend")).toEqual([C]);
    expect(classes("Generate a summary of my meetings")).toEqual([C]);
    expect(classes("report banao")).toEqual([C]);
  });

  it("33. a creation verb without an artifact noun is EXTERNAL_WRITE", () => {
    expect(classes("Create a campaign for Diwali")).toEqual([W]);
    expect(classes("Make it ₹200/day")).toEqual([W]);
    expect(classes("naya campaign banao")).toEqual([W]);
  });

  it("13. several clauses become several objectives, in request order", () => {
    expect(extractObjectives(TRACE, "Check the weather, list my tasks and find a cafe nearby")).toEqual([
      { objectiveId: `${TRACE}#0`, text: "Check the weather", evidenceClass: R, skills: ["research"] },
      { objectiveId: `${TRACE}#1`, text: "list my tasks", evidenceClass: R, skills: ["productivity"] },
      { objectiveId: `${TRACE}#2`, text: "find a cafe nearby", evidenceClass: R, skills: ["places"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Hinglish
// ---------------------------------------------------------------------------

describe("Hinglish", () => {
  it("9. write verbs", () => {
    expect(classes("Meta campaign band karo")).toEqual([W]);
    expect(classes("budget kam karo")).toEqual([W]);
    expect(classes("campaign roko")).toEqual([W]);
    expect(classes("budget badha do")).toEqual([W]);
    expect(classes("campaign pause karo")).toEqual([W]);
    expect(classes("is ad ko hatao")).toEqual([W]);
  });

  it("10. analysis verbs", () => {
    expect(classes("kaun sa campaign kharab chal raha hai")).toEqual([A]);
    expect(classes("sales kyun gir rahi hai")).toEqual([A]);
    expect(classes("ROAS samjhao")).toEqual([A]);
  });

  it("11. retrieval verbs", () => {
    expect(classes("mere campaigns dikhao")).toEqual([R]);
    expect(classes("aaj ka spend batao")).toEqual([R]);
    expect(classes("inbox dekho")).toEqual([R]);
    expect(classes("kitna spend hua?")).toEqual([R]);
  });

  it("splits on 'aur' and 'phir'", () => {
    expect(classes("campaigns check karo aur weak wale batao")).toEqual([R, A]);
    expect(classes("pehle ads check karo phir report bhejo")).toEqual([R, W]);
  });
});

// ---------------------------------------------------------------------------
// Empty and neutral requests
// ---------------------------------------------------------------------------

describe("14. requests that name nothing classifiable", () => {
  it.each(["yes", "no", "thanks", "ok", "", "   "])("'%s' yields no objectives", (request) => {
    expect(extractObjectives(TRACE, request)).toEqual([]);
  });

  it("an empty extraction is reported as OBJECTIVE_CLASS missing", () => {
    expect(extractionMissing(extractObjectives(TRACE, "yes"))).toEqual(["OBJECTIVE_CLASS"]);
    expect(extractionMissing(extractObjectives(TRACE, "no"))).toEqual(["OBJECTIVE_CLASS"]);
    expect(extractionMissing(extractObjectives(TRACE, "Check my campaigns"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The objective cap
// ---------------------------------------------------------------------------

describe("15 / 39. more than eight objectives collapse into one", () => {
  it("keeps exactly eight", () => {
    expect(MAX_OBJECTIVES).toBe(8);
    const eight = Array.from({ length: 8 }, (_, i) => `check list ${i}`).join(", ");
    expect(extractObjectives(TRACE, eight)).toHaveLength(8);
  });

  it("collapses nine into one objective with the highest class present", () => {
    const request =
      "check ads, check tasks, check mail, check weather, check cpu, check files, check maps, check health, pause the campaign";
    expect(extractObjectives(TRACE, request)).toEqual([
      {
        objectiveId: `${TRACE}#0`,
        text: request,
        evidenceClass: W,
        skills: ["advertising", "productivity", "workspace", "research", "monitoring", "places", "integrations"],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Identity and text
// ---------------------------------------------------------------------------

describe("identity and verbatim text", () => {
  it("16. objective ids are <traceId>#<index>, zero-based, in request order", () => {
    const ids = extractObjectives("abc-123", "Check my campaigns, identify weak ones, draft an email, and send it.").map(
      (o) => o.objectiveId
    );
    expect(ids).toEqual(["abc-123#0", "abc-123#1", "abc-123#2", "abc-123#3"]);
  });

  it("17. objective text is the exact trimmed substring, casing and punctuation preserved", () => {
    const request = "   CHECK my Campaigns,   Identify WEAK ones   ";
    const objectives = extractObjectives(TRACE, request);
    expect(objectives.map((o) => o.text)).toEqual(["CHECK my Campaigns", "Identify WEAK ones"]);
  });

  it("29. matching is case-insensitive; the text keeps the user's casing", () => {
    const upper = only("CHECK MY CAMPAIGNS");
    const lower = only("check my campaigns");
    expect(upper.evidenceClass).toBe(lower.evidenceClass);
    expect(upper.skills).toEqual(lower.skills);
    expect(upper.text).toBe("CHECK MY CAMPAIGNS");
  });

  it("30. markers match whole words only", () => {
    expect(extractObjectives(TRACE, "reset my password")).toEqual([]); // not "set"
    expect(extractObjectives(TRACE, "I updated it yesterday")).toEqual([]); // not "update"
    expect(extractObjectives(TRACE, "Checklist of campaigns")).toEqual([]); // not "check" / "list"
  });
});

// ---------------------------------------------------------------------------
// Skill vocabulary
// ---------------------------------------------------------------------------

describe("the closed skill vocabulary", () => {
  it("19 / 20. has exactly the SKILL_CATALOG ids, in catalogue order", () => {
    expect(Object.keys(OBJECTIVE_SKILL_VOCABULARY)).toEqual(SKILL_CATALOG.map((s) => s.id));
  });

  it("every entry is a non-empty, lowercase, trimmed phrase, and belongs to one skill only", () => {
    const seen = new Map<string, string>();
    for (const [skill, words] of Object.entries(OBJECTIVE_SKILL_VOCABULARY)) {
      expect(words.length).toBeGreaterThan(0);
      for (const word of words) {
        expect(word).toBe(word.trim().toLowerCase());
        expect(word.length).toBeGreaterThan(0);
        expect(seen.get(word), `"${word}" is in both ${seen.get(word)} and ${skill}`).toBeUndefined();
        seen.set(word, skill);
      }
    }
  });

  it.each<[string, string, string[]]>([
    ["21. advertising", "Show my Instagram ads ROAS", ["advertising"]],
    ["21. advertising (Google Ads)", "Show my Google Ads campaigns", ["advertising"]],
    ["22. workspace", "Search my inbox for the invoice", ["workspace"]],
    ["23. places", "Find a restaurant near me", ["places"]],
    ["24. research", "What's the weather in Pune?", ["research"]],
    ["25. productivity", "List my reminders", ["productivity"]],
    ["26. messaging", "whatsapp my team", ["messaging"]],
    ["27. monitoring", "Check the system status", ["monitoring"]],
    ["27. monitoring (disk)", "How much disk is free?", ["monitoring"]],
    ["28. integrations", "Show integration health", ["integrations"]],
  ])("%s", (_label, request, skills) => {
    expect(only(request).skills).toEqual(skills);
  });

  it("orders several skills by first appearance in the objective", () => {
    expect(only("Check my ads and my calendar").skills).toEqual(["advertising", "workspace"]);
    expect(only("Check my calendar and my ads").skills).toEqual(["workspace", "advertising"]);
  });

  it("never emits a skill id outside the catalogue", () => {
    const catalogue = new Set(SKILL_CATALOG.map((s) => s.id));
    for (const [request] of CORPUS) {
      for (const objective of extractObjectives(TRACE, request)) {
        for (const skill of objective.skills) expect(catalogue.has(skill)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 41. The corpus — the contract in executable form
// ---------------------------------------------------------------------------

const CORPUS: ReadonlyArray<[request: string, expected: EvidenceClass[]]> = [
  // English — the worked requests
  ["Check my campaign performance.", [R]],
  ["Check my campaigns and tell me which ones are weak.", [R, A]],
  ["Check my campaigns, identify weak ones, and draft an email.", [R, A, C]],
  ["Check my campaigns, identify weak ones, draft an email, and send it.", [R, A, C, W]],
  ["Check my Meta ads, identify weak campaigns, and draft an email summarizing the findings.", [R, A, C]],
  // Framing, openers, questions
  ["How do I change the budget?", [R]],
  ["Can you pause the campaign?", [W]],
  ["Pause the campaign?", [R]],
  ["Please pause the campaign?", [W]],
  ["Could you send it to the team?", [W]],
  ["Should I increase the budget?", [R]],
  ["How to disable the integration", [R]],
  ["Tell me about pausing campaigns", [R]],
  ["Do you know how to delete a campaign", [R]],
  ["What is my ROAS?", [R]],
  ["Which campaigns are weak?", [A]],
  ["How much did I spend yesterday?", [R]],
  ["Why are my ads not converting?", [A]],
  ["Is my Meta account connected?", [R]],
  // Noun guard
  ["Show me the draft", [R]],
  ["Give me an update", [R]],
  ["Show the ad set", [R]],
  ["the draft", []],
  ["an update", []],
  ["the ad set", []],
  // Neutral
  ["yes", []],
  ["no", []],
  ["thanks", []],
  // Creation verbs
  ["Create a report on spend", [C]],
  ["Generate a summary of my meetings", [C]],
  ["Create a campaign for Diwali", [W]],
  ["Make it ₹200/day", [W]],
  // Precedence
  ["send the weak campaigns report", [W]],
  ["draft which campaigns are worst", [C]],
  ["show the worst campaigns", [A]],
  // Negation and merging
  ["Check my campaigns, don't pause anything", [R]],
  ["Never delete my files", []],
  ["Don't worry, check my campaigns", [R]],
  ["Hi JARVIS, show my tasks", [R]],
  ["Check my ads and campaigns", [R]],
  ["Pause the campaign, thanks", [W]],
  ["Compare Meta and Google ads", [A]],
  // Several clauses
  ["Check the weather, list my tasks and find a cafe nearby", [R, R, R]],
  // Recipients
  ["whatsapp my team the numbers", [W]],
  ["tell me my spend", [R]],
  ["message the client about the delay", [W]],
  // Whole words
  ["reset my password", []],
  ["I updated it yesterday", []],
  ["Checklist of campaigns", []],
  ["CHECK MY CAMPAIGNS", [R]],
  // Everyday requests
  ["Summarize my unread emails", [C]],
  ["Compare this month's spend with last month", [A]],
  ["Recommend a budget for next week", [A]],
  ["Schedule a meeting with Raj tomorrow", [W]],
  ["Upload the file to Drive", [W]],
  ["Find the route to the airport", [R]],
  ["What's the weather in Pune?", [R]],
  ["Show integration health", [R]],
  ["Check the system status", [R]],
  // Hinglish
  ["iska plan banao, execute mat karo", [C]],
  ["Meta campaign band karo", [W]],
  ["budget kam karo", [W]],
  ["campaign roko", [W]],
  ["budget badha do", [W]],
  ["campaign pause karo", [W]],
  ["report banao, email mat bhejo", [C]],
  ["kaun sa campaign kharab chal raha hai", [A]],
  ["sales kyun gir rahi hai", [A]],
  ["ROAS samjhao", [A]],
  ["mere campaigns dikhao", [R]],
  ["aaj ka spend batao", [R]],
  ["inbox dekho", [R]],
  ["kitna spend hua?", [R]],
  ["campaigns check karo aur weak wale batao", [R, A]],
  ["naya campaign banao", [W]],
  ["email likh do client ke liye", [C]],
  ["pehle ads check karo phir report bhejo", [R, W]],
  ["report taiyar karo", [C]],
];

/**
 * KNOWN EDGES — behaviour the closed lists produce that a reader might not
 * expect. Pinned so that changing any of them is a deliberate, reviewed edit
 * to the contract rather than a silent drift. Each is reported in the phase
 * report; none is a bug against the locked contract.
 */
const KNOWN_EDGES: ReadonlyArray<[request: string, expected: EvidenceClass[], why: string]> = [
  ["Check my campaigns but don't pause anything", [], "no separator, so the negation drops the whole clause"],
  ["Check my campaigns without changing anything", [], "'without' negates the whole clause it sits in"],
  ["Pause the campaign, right?", [W, R], "a trailing '?' is itself a RETRIEVE marker"],
  ["What is my plan?", [C], "the noun guard does not cover possessives such as 'my'"],
  ["How do I create a report?", [C], "framing suppresses writes only; creation + artifact stays COMPOSE"],
];

describe("41. corpus of at least 60 English and Hinglish sentences", () => {
  it("is large enough", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(60);
  });

  it.each(CORPUS)("%s", (request, expected) => {
    expect(classes(request)).toEqual(expected);
  });

  it.each(KNOWN_EDGES)("known edge: %s", (request, expected) => {
    expect(classes(request)).toEqual(expected);
  });

  it("18. every objective in the corpus is verbatim: a trimmed, non-empty substring", () => {
    for (const [request] of [...CORPUS, ...KNOWN_EDGES]) {
      for (const objective of extractObjectives(TRACE, request)) {
        expect(objective.text.length).toBeGreaterThan(0);
        expect(objective.text).toBe(objective.text.trim());
        expect(request.includes(objective.text), `${objective.text} ⊄ ${request}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 40. Determinism
// ---------------------------------------------------------------------------

describe("40. determinism", () => {
  it("the same input produces byte-identical output, whatever ran in between", () => {
    const first = CORPUS.map(([request]) => JSON.stringify(extractObjectives(TRACE, request)));
    // Interleave unrelated calls so any leaked state (a global regex's
    // lastIndex, a cache) would show up as a difference.
    for (const [request] of [...CORPUS].reverse()) extractObjectives("other", request);
    const second = CORPUS.map(([request]) => JSON.stringify(extractObjectives(TRACE, request)));
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// 42. Bounded cost
// ---------------------------------------------------------------------------

describe("42. a 100 KB request stays within a CPU-time bound", () => {
  it("many clauses, one long clause, and a long whitespace run", () => {
    const manyClauses = "check my campaigns, ".repeat(5_000); // 100,000 characters
    const oneClause = "send ".repeat(20_000); // 100,000 characters, no separator
    const whitespace = `check${" ".repeat(100_000)}the draft?`;

    // CPU time, not wall clock — the same technique the core timing tests use,
    // so a busy machine running sibling test files cannot fail this.
    const cpu0 = process.cpuUsage();
    const a = extractObjectives(TRACE, manyClauses);
    const b = extractObjectives(TRACE, oneClause);
    const c = extractObjectives(TRACE, whitespace);
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;

    expect(manyClauses.length).toBe(100_000);
    expect(a).toHaveLength(1); // more than eight clauses collapse
    expect(a[0]!.evidenceClass).toBe(R);
    expect(b.map((o) => o.evidenceClass)).toEqual([W]);
    expect(c.length).toBeLessThanOrEqual(MAX_OBJECTIVES);
    expect(cpuMs).toBeLessThan(2_000); // generous; expected well under 100 ms
  });
});

// ---------------------------------------------------------------------------
// Architectural isolation
// ---------------------------------------------------------------------------

describe("isolation — the extractor is pure core logic", () => {
  const source = readFileSync(new URL("../src/objective-extraction.ts", import.meta.url), "utf8");
  // Comments may name things in prose; only code is checked.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports nothing but relative core modules", () => {
    const specifiers = [...code.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const specifier of specifiers) expect(specifier.startsWith("./"), specifier).toBe(true);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it("names no database, HTTP, execution, policy, planning, memory or model dependency", () => {
    for (const forbidden of [
      "prisma",
      "Prisma",
      "express",
      "fastify",
      "node:http",
      "@jarvis/",
      "ToolExecutor",
      "ToolRegistry",
      "AGENT_POLICIES",
      "isToolAllowed",
      "Orchestrator",
      "TaskPlanner",
      "Scheduler",
      "IMemoryStore",
      "MemoryExtraction",
      "OpenAI",
      "openai",
      "classifyWriteIntent",
      "detectWorkRequest",
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

  it("is not reachable from the planning path", () => {
    for (const planningFile of [
      "../../agents/src/orchestrator.ts",
      "../../agents/src/agent-router.ts",
      "../../agents/src/agent-policy.ts",
      "../../agents/src/domain-agent.ts",
      "../../agents/src/tool-rounds.ts",
      "../../agents/src/write-intent-gate.ts",
      "../../agents/src/intent-detector.ts",
      "../../agents/src/work-request-detector.ts",
      "../src/capability-presentation.ts",
    ]) {
      const planning = readFileSync(new URL(planningFile, import.meta.url), "utf8");
      expect(planning, planningFile).not.toContain("objective-extraction");
      expect(planning, planningFile).not.toContain("extractObjectives");
    }
  });
});
