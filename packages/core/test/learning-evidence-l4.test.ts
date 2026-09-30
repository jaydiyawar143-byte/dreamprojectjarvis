// S7.2 L4 — the evidence contract.
//
// Evidence is how many genuine USER statements stand behind a memory, from how
// many distinct conversations — ids and timestamps only, never text. It turns
// into a deterministic confidence (DIRECT 0.70, ENDORSEMENT 0.55, +0.10 per
// additional distinct conversation, never above 0.95) and says when expiry is
// refreshed. Replaying the same message changes nothing. Pure: the caller
// supplies every timestamp.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEARNING_EVIDENCE_LIMIT,
  hasNegationConflict,
  isLearningEvidence,
  resolveLearningEvidence,
  type LearningEvidence,
  type LearningEvidenceEvent,
} from "../src/learning-evidence.js";

const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-02T10:00:00.000Z";
const T3 = "2026-09-03T10:00:00.000Z";

function event(over: Partial<LearningEvidenceEvent> = {}): LearningEvidenceEvent {
  return { kind: "NEW", evidenceKind: "DIRECT", sourceMessageId: "msg-1", conversationId: "conv-A", traceId: "trace-1", occurredAt: T1, ...over };
}

/** Evidence after a NEW event, for the corroboration and revision cases. */
function created(over: Partial<LearningEvidenceEvent> = {}): LearningEvidence {
  const result = resolveLearningEvidence(event(over), undefined);
  if (!result.accepted) throw new Error("expected acceptance");
  return result.evidence;
}

/** Apply a list of CORROBORATE events, in order, to `start`. */
function corroborate(start: LearningEvidence, sources: Array<[messageId: string, conversationId: string, kind?: "DIRECT" | "ENDORSEMENT"]>) {
  let evidence = start;
  let last = resolveLearningEvidence(event({ kind: "CORROBORATE" }), evidence);
  for (const [messageId, conversationId, kind] of sources) {
    last = resolveLearningEvidence(
      event({ kind: "CORROBORATE", sourceMessageId: messageId, conversationId, evidenceKind: kind ?? "DIRECT", occurredAt: T2 }),
      evidence
    );
    if (!last.accepted) throw new Error("expected acceptance");
    evidence = last.evidence;
  }
  return last;
}

// ---------------------------------------------------------------------------
// NEW
// ---------------------------------------------------------------------------

describe("L4 — a new memory", () => {
  it("1. a DIRECT statement starts the evidence: one source, one conversation, confidence 0.70", () => {
    expect(resolveLearningEvidence(event(), undefined)).toEqual({
      accepted: true,
      reason: "CREATED",
      changed: true,
      refreshExpiry: true,
      confidence: 0.7,
      evidence: {
        v: 1,
        count: 1,
        conversations: 1,
        firstSeenAt: T1,
        lastSeenAt: T1,
        sources: [{ messageId: "msg-1", conversationId: "conv-A", traceId: "trace-1", kind: "DIRECT", at: T1 }],
        revisions: 0,
        previousSourceMessageIds: [],
      },
    });
  });

  it("2. an ENDORSEMENT starts at 0.55", () => {
    const result = resolveLearningEvidence(event({ evidenceKind: "ENDORSEMENT" }), undefined);
    expect(result).toMatchObject({ accepted: true, confidence: 0.55 });
  });

  it("a source without a trace simply has no traceId", () => {
    const evidence = created({ traceId: undefined });
    expect("traceId" in evidence.sources[0]!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CORROBORATE
// ---------------------------------------------------------------------------

describe("L4 — corroboration", () => {
  it("3. the same conversation adds a source but not a conversation: confidence stays 0.70", () => {
    const result = corroborate(created(), [["msg-2", "conv-A"]]);
    expect(result).toMatchObject({ accepted: true, reason: "CORROBORATED", changed: true, confidence: 0.7 });
    if (result.accepted) expect(result.evidence).toMatchObject({ count: 2, conversations: 1, firstSeenAt: T1, lastSeenAt: T2 });
  });

  it("4. a different conversation adds both: confidence 0.80", () => {
    const result = corroborate(created(), [["msg-2", "conv-B"]]);
    expect(result).toMatchObject({ accepted: true, confidence: 0.8 });
    if (result.accepted) expect(result.evidence).toMatchObject({ count: 2, conversations: 2 });
  });

  it("5. A/msg1, A/msg2, B/msg3 → count 3, conversations 2, confidence 0.80; C → 0.90; D → 0.95", () => {
    const ab = corroborate(created(), [["msg-2", "conv-A"], ["msg-3", "conv-B"]]);
    expect(ab).toMatchObject({ confidence: 0.8 });
    if (ab.accepted) expect(ab.evidence).toMatchObject({ count: 3, conversations: 2 });
    expect(corroborate(created(), [["msg-2", "conv-A"], ["msg-3", "conv-B"], ["msg-4", "conv-C"]])).toMatchObject({ confidence: 0.9 });
    expect(corroborate(created(), [["msg-2", "conv-B"], ["msg-3", "conv-C"], ["msg-4", "conv-D"]])).toMatchObject({ confidence: 0.95 });
  });

  it("6. confidence never exceeds 0.95, and an ENDORSEMENT climbs from 0.55", () => {
    const many = corroborate(created(), [["m2", "B"], ["m3", "C"], ["m4", "D"], ["m5", "E"], ["m6", "F"]]);
    expect(many).toMatchObject({ confidence: 0.95 });
    const endorsed = created({ evidenceKind: "ENDORSEMENT" });
    expect(corroborate(endorsed, [["m2", "conv-B", "ENDORSEMENT"]])).toMatchObject({ confidence: 0.65 });
    expect(corroborate(endorsed, [["m2", "B", "ENDORSEMENT"], ["m3", "C", "ENDORSEMENT"], ["m4", "D", "ENDORSEMENT"], ["m5", "E", "ENDORSEMENT"]])).toMatchObject({
      confidence: 0.95,
    });
  });

  it("a DIRECT statement lifts an endorsed memory to the DIRECT base", () => {
    expect(corroborate(created({ evidenceKind: "ENDORSEMENT" }), [["m2", "conv-B", "DIRECT"]])).toMatchObject({ confidence: 0.8 });
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("L4 — idempotency: the same message never counts twice", () => {
  it("7. a source message already counted changes nothing", () => {
    const evidence = created();
    const again = resolveLearningEvidence(event({ kind: "CORROBORATE", occurredAt: T3 }), evidence);
    expect(again).toEqual({ accepted: true, reason: "SOURCE_ALREADY_COUNTED", changed: false, refreshExpiry: false, confidence: 0.7, evidence });
  });

  it("8. replaying a corroboration gives the same state, with no second refresh", () => {
    const once = corroborate(created(), [["msg-2", "conv-B"]]);
    if (!once.accepted) throw new Error("expected acceptance");
    const twice = resolveLearningEvidence(event({ kind: "CORROBORATE", sourceMessageId: "msg-2", conversationId: "conv-B", occurredAt: T3 }), once.evidence);
    expect(twice).toMatchObject({ accepted: true, changed: false, refreshExpiry: false, confidence: 0.8 });
    if (twice.accepted) expect(twice.evidence).toEqual(once.evidence);
  });

  it("a revision replayed from the message that made it changes nothing", () => {
    const revised = resolveLearningEvidence(event({ kind: "REVISE", sourceMessageId: "msg-9", occurredAt: T2 }), created(), {
      memorySource: { messageId: "msg-1" },
    });
    if (!revised.accepted) throw new Error("expected acceptance");
    const replay = resolveLearningEvidence(event({ kind: "REVISE", sourceMessageId: "msg-9", occurredAt: T3 }), revised.evidence, {
      memorySource: { messageId: "msg-9" },
    });
    expect(replay).toMatchObject({ accepted: true, changed: false, refreshExpiry: false });
    if (replay.accepted) expect(replay.evidence).toEqual(revised.evidence);
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("L4 — identity is required, never invented", () => {
  it.each([
    ["no conversation id", { conversationId: undefined }],
    ["a blank conversation id", { conversationId: " " }],
    ["no message id", { sourceMessageId: undefined }],
    ["a blank message id", { sourceMessageId: "" }],
  ])("9. %s → refused, nothing counted", (_label, over) => {
    expect(resolveLearningEvidence(event(over as Partial<LearningEvidenceEvent>), undefined)).toEqual({ accepted: false, reason: "INVALID_EVENT" });
  });
});

// ---------------------------------------------------------------------------
// REVISE
// ---------------------------------------------------------------------------

describe("L4 — revision", () => {
  const strong = () => {
    const result = corroborate(created(), [["m2", "B"], ["m3", "C"], ["m4", "D"]]);
    if (!result.accepted) throw new Error("expected acceptance");
    return result.evidence;
  };

  it("10–12. a revision starts fresh evidence, counts the revision and records what it replaced", () => {
    const result = resolveLearningEvidence(event({ kind: "REVISE", sourceMessageId: "msg-new", conversationId: "conv-Z", occurredAt: T3 }), strong(), {
      memorySource: { messageId: "msg-1", conversationId: "conv-A" },
    });
    expect(result).toEqual({
      accepted: true,
      reason: "REVISED",
      changed: true,
      refreshExpiry: true,
      confidence: 0.7,
      evidence: {
        v: 1,
        count: 1,
        conversations: 1,
        firstSeenAt: T3,
        lastSeenAt: T3,
        sources: [{ messageId: "msg-new", conversationId: "conv-Z", traceId: "trace-1", kind: "DIRECT", at: T3 }],
        revisions: 1,
        lastRevisedAt: T3,
        previousSourceMessageIds: ["msg-1"],
      },
    });
  });

  it("11. the old confidence (0.95) is never inherited: an ENDORSEMENT revision starts at 0.55", () => {
    const result = resolveLearningEvidence(event({ kind: "REVISE", sourceMessageId: "msg-new", evidenceKind: "ENDORSEMENT" }), strong(), {
      memorySource: { messageId: "msg-1" },
    });
    expect(result).toMatchObject({ accepted: true, confidence: 0.55 });
  });

  it("13. only the last 10 previous source ids are kept", () => {
    let evidence = created();
    for (let i = 1; i <= 12; i++) {
      const result = resolveLearningEvidence(event({ kind: "REVISE", sourceMessageId: `msg-r${i}`, occurredAt: T2 }), evidence, {
        memorySource: { messageId: i === 1 ? "msg-1" : `msg-r${i - 1}` },
      });
      if (!result.accepted) throw new Error("expected acceptance");
      evidence = result.evidence;
    }
    expect(evidence.revisions).toBe(12);
    expect(evidence.previousSourceMessageIds).toEqual(["msg-r2", "msg-r3", "msg-r4", "msg-r5", "msg-r6", "msg-r7", "msg-r8", "msg-r9", "msg-r10", "msg-r11"]);
  });

  it("a revision of a memory with no source id records nothing it does not know", () => {
    const result = resolveLearningEvidence(event({ kind: "REVISE", sourceMessageId: "msg-new" }), undefined, { memorySource: {} });
    expect(result).toMatchObject({ accepted: true, evidence: { revisions: 1, previousSourceMessageIds: [] } });
  });
});

// ---------------------------------------------------------------------------
// Caps, expiry, determinism, validity, content
// ---------------------------------------------------------------------------

describe("L4 — bounds and behaviour", () => {
  it("14. only the last 10 sources are kept; the counts keep going", () => {
    const list: Array<[string, string]> = Array.from({ length: 11 }, (_, i) => [`msg-${i + 2}`, "conv-A"]);
    const result = corroborate(created(), list);
    if (!result.accepted) throw new Error("expected acceptance");
    expect(LEARNING_EVIDENCE_LIMIT).toBe(10);
    expect(result.evidence.sources.map((s) => s.messageId)).toEqual(list.slice(-10).map(([id]) => id));
    expect(result.evidence.count).toBe(12);
    expect(result.evidence.conversations).toBe(1);
  });

  it("15. new, corroborating and revising evidence refresh expiry", () => {
    expect(resolveLearningEvidence(event(), undefined)).toMatchObject({ refreshExpiry: true });
    expect(corroborate(created(), [["msg-2", "conv-A"]])).toMatchObject({ refreshExpiry: true });
    expect(resolveLearningEvidence(event({ kind: "REVISE", sourceMessageId: "msg-9" }), created(), {})).toMatchObject({ refreshExpiry: true });
  });

  it("16. a replay does not refresh expiry", () => {
    expect(resolveLearningEvidence(event({ kind: "CORROBORATE" }), created())).toMatchObject({ refreshExpiry: false, changed: false });
  });

  it("17. same input → same output, and the inputs are not mutated", () => {
    const existing = created();
    const snapshot = JSON.parse(JSON.stringify(existing));
    const e = event({ kind: "CORROBORATE", sourceMessageId: "msg-2", conversationId: "conv-B", occurredAt: T2 });
    const first = resolveLearningEvidence(e, existing);
    for (let i = 0; i < 5; i++) expect(resolveLearningEvidence(e, existing)).toEqual(first);
    expect(existing).toEqual(snapshot);
    const frozen = Object.freeze({ ...existing, sources: Object.freeze([...existing.sources]) });
    expect(resolveLearningEvidence(e, frozen)).toEqual(first);
  });

  it.each([
    ["an unknown event kind", { kind: "MERGE" }],
    ["an unknown evidence kind", { evidenceKind: "ASSISTANT" }],
    ["a missing timestamp", { occurredAt: undefined }],
    ["a timestamp that is not ISO", { occurredAt: "yesterday" }],
    ["a non-string trace", { traceId: 7 }],
  ])("18. %s → refused", (_label, over) => {
    expect(resolveLearningEvidence(event(over as Partial<LearningEvidenceEvent>), undefined)).toEqual({ accepted: false, reason: "INVALID_EVENT" });
  });

  it.each([
    ["a null event", null],
    ["a string event", "NEW"],
  ])("18. %s → refused, never a throw", (_label, value) => {
    expect(resolveLearningEvidence(value as never, undefined)).toEqual({ accepted: false, reason: "INVALID_EVENT" });
  });

  it.each([
    ["a future version", { ...created(), v: 2 }],
    ["a non-numeric count", { ...created(), count: "3" }],
    ["sources that are not a list", { ...created(), sources: "msg-1" }],
    ["more than 10 sources", { ...created(), sources: Array.from({ length: 11 }, () => created().sources[0]) }],
    ["a source with an unknown kind", { ...created(), sources: [{ ...created().sources[0], kind: "ASSISTANT" }] }],
    ["a string", "evidence"],
  ])("18. existing evidence that is %s → refused rather than overwritten", (_label, existing) => {
    expect(resolveLearningEvidence(event({ kind: "CORROBORATE", sourceMessageId: "msg-2" }), existing)).toEqual({
      accepted: false,
      reason: "INVALID_EXISTING_EVIDENCE",
    });
    expect(isLearningEvidence(existing)).toBe(false);
  });

  it("19. no content is stored: an event carrying text keeps only ids, kinds, counts and times", () => {
    const secret = ["Zq9", "Xv7", "Lp3"].join("");
    const withText = { ...event(), content: `User prefers short captions ${secret}`, quote: "I prefer short captions", reply: "Noted." };
    const result = resolveLearningEvidence(withText as LearningEvidenceEvent, undefined);
    if (!result.accepted) throw new Error("expected acceptance");
    const text = JSON.stringify(result);
    for (const forbidden of [secret, "short captions", "Noted", "prefer"]) expect(text).not.toContain(forbidden);
    expect(Object.keys(result.evidence).sort()).toEqual(["conversations", "count", "firstSeenAt", "lastSeenAt", "previousSourceMessageIds", "revisions", "sources", "v"]);
    expect(Object.keys(result.evidence.sources[0]!).sort()).toEqual(["at", "conversationId", "kind", "messageId", "traceId"]);
    expect(isLearningEvidence(result.evidence)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy memories
// ---------------------------------------------------------------------------

describe("L4 — a memory from before L4", () => {
  it("20. with its own message and conversation ids, it counts as one legacy source (weaker kind: its kind was never recorded)", () => {
    const result = resolveLearningEvidence(event({ kind: "CORROBORATE", sourceMessageId: "msg-2", conversationId: "conv-B", occurredAt: T2 }), undefined, {
      memorySource: { messageId: "msg-old", conversationId: "conv-A", createdAt: T1 },
    });
    expect(result).toMatchObject({ accepted: true, reason: "CORROBORATED", confidence: 0.8 });
    if (result.accepted) {
      expect(result.evidence).toMatchObject({ count: 2, conversations: 2, firstSeenAt: T1, lastSeenAt: T2 });
      expect(result.evidence.sources).toEqual([
        { messageId: "msg-old", conversationId: "conv-A", kind: "ENDORSEMENT", at: T1 },
        { messageId: "msg-2", conversationId: "conv-B", traceId: "trace-1", kind: "DIRECT", at: T2 },
      ]);
    }
  });

  it.each([
    ["no message id (a pre-L2 row)", { conversationId: "conv-A", createdAt: T1 }],
    ["no conversation id", { messageId: "msg-old", createdAt: T1 }],
    ["no creation time", { messageId: "msg-old", conversationId: "conv-A" }],
    ["nothing at all", {}],
  ])("20. with %s it gets no invented source: evidence starts from the new statement", (_label, memorySource) => {
    const result = resolveLearningEvidence(event({ kind: "CORROBORATE", sourceMessageId: "msg-2", occurredAt: T2 }), undefined, { memorySource });
    expect(result).toMatchObject({ accepted: true, confidence: 0.7 });
    if (result.accepted) {
      expect(result.evidence).toMatchObject({ count: 1, conversations: 1, firstSeenAt: T2 });
      expect(result.evidence.sources.map((s) => s.messageId)).toEqual(["msg-2"]);
      expect(JSON.stringify(result.evidence)).not.toContain("msg-old");
    }
  });

  it("a legacy memory created by this very message is a replay, not new evidence", () => {
    const result = resolveLearningEvidence(event({ kind: "CORROBORATE", sourceMessageId: "msg-old", occurredAt: T2 }), undefined, {
      memorySource: { messageId: "msg-old", conversationId: "conv-A", createdAt: T1 },
    });
    expect(result).toMatchObject({ accepted: true, changed: false, refreshExpiry: false });
  });
});

// ---------------------------------------------------------------------------
// L4.1 — negation safety
// ---------------------------------------------------------------------------

describe("L4.1 — a statement and its negation are never the same statement", () => {
  // Word overlap 0.92: the pre-L4.1 dedup called this pair a duplicate.
  const REPORT = "User prefers to receive the weekly performance report every Monday morning";
  const NOT_REPORT = "User prefers not to receive the weekly performance report every Monday morning";

  it("1. positive against negative is a conflict", () => {
    expect(hasNegationConflict(REPORT, NOT_REPORT)).toBe(true);
  });

  it("2. negative against positive is a conflict — the order never matters", () => {
    expect(hasNegationConflict(NOT_REPORT, REPORT)).toBe(true);
  });

  it.each([
    ["3. not", "User is a morning person", "User is not a morning person"],
    ["4. don't", "I want long captions", "I don't want long captions"],
    ["5. do not", "I want long captions", "I do not want long captions"],
    ["doesn't", "User likes emojis", "User doesn't like emojis"],
    ["does not", "User likes emojis", "User does not like emojis"],
    ["6. never", "User works on Sundays", "User never works on Sundays"],
    ["7. no longer", "User prefers minimal design", "User no longer prefers minimal design"],
    ["8. cannot", "User can attend Monday meetings", "User cannot attend Monday meetings"],
    ["can't", "User can attend Monday meetings", "User can't attend Monday meetings"],
    ["a curly apostrophe", "User wants long captions", "User doesn’t want long captions"],
    ["capitals", "User works on Sundays", "User NEVER works on Sundays"],
  ])("%s: a clear negation on one side only is a conflict", (_label, positive, negative) => {
    expect(hasNegationConflict(positive, negative)).toBe(true);
    expect(hasNegationConflict(negative, positive)).toBe(true);
  });

  it.each([
    ["both positive", REPORT, REPORT],
    ["both negative", NOT_REPORT, NOT_REPORT],
    ["both negative, worded differently", "User doesn't like emojis", "User does not like emojis"],
  ])("9. the same polarity is no conflict (%s)", (_label, a, b) => {
    expect(hasNegationConflict(a, b)).toBe(false);
  });

  it.each([
    ["not only", "User uses Canva and Figma", "User uses not only Canva but also Figma"],
    ["not just", "User wants short captions", "User wants not just short captions but emojis too"],
    ["not merely", "User writes reports", "User writes not merely reports but proposals"],
    ["whether or not", "User wants the weekly report", "User wants the weekly report whether or not anything changed"],
    ["a contrast after a comma", "User prefers email", "User prefers email, not phone calls"],
    ["nothing special", "User finds the default template fine", "User finds nothing special in the default template"],
    ["a noun phrase with no", "User prefers code-first tools", "User prefers no-code tools"],
    ["a hyphenated not-", "User works at a charity", "User works at a not-for-profit"],
    ["words that merely contain not", "User keeps notes in Notion", "User keeps a notebook and a knot guide"],
  ])("10. %s is not a negation: no conflict", (_label, a, b) => {
    expect(hasNegationConflict(a, b)).toBe(false);
    expect(hasNegationConflict(b, a)).toBe(false);
  });

  it("14. deterministic: the same pair always gives the same answer, in either order", () => {
    const answers = Array.from({ length: 5 }, () =>
      JSON.stringify([hasNegationConflict(REPORT, NOT_REPORT), hasNegationConflict(NOT_REPORT, REPORT), hasNegationConflict(REPORT, REPORT)])
    );
    expect(new Set(answers)).toEqual(new Set([JSON.stringify([true, true, false])]));
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("isolation — the evidence contract is pure core logic", () => {
  const source = readFileSync(new URL("../src/learning-evidence.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports nothing", () => {
    expect(code).not.toMatch(/\bfrom\s+["']/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it("names no database, HTTP, execution, policy, approval, S5/S6, agent, filesystem or model dependency", () => {
    for (const forbidden of [
      "prisma",
      "Prisma",
      "@jarvis/",
      "express",
      "node:",
      "ToolExecutor",
      "ToolRegistry",
      "agent-policy",
      "write-intent",
      "approval",
      "Approval",
      "orchestrator",
      "execution-outcome",
      "ExecutionOutcome",
      "feedback",
      "objective",
      "OpenAI",
      "anthropic",
      "readFile",
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
          if (path === "packages/core/src/learning-evidence.ts") continue;
          if (/learning-evidence|resolveLearningEvidence/.test(readFileSync(file, "utf8"))) consumers.push(path);
        }
      }
    }
    expect(consumers.sort()).toEqual(["packages/core/src/index.ts", "packages/memory/src/memory-extraction-service.ts"]);
  });

  it("is not reachable from planning, policy, execution, approvals, S5 or S6 — evidence can never authorize anything", () => {
    for (const file of [
      "../../agents/src/orchestrator.ts",
      "../../agents/src/agent-router.ts",
      "../../agents/src/agent-policy.ts",
      "../../agents/src/write-intent-gate.ts",
      "../../agents/src/pending-action-service.ts",
      "../../tools/src/executor.ts",
      "../../security/src/tool-approval.ts",
      "../src/execution-outcome.ts",
      "../src/objective-evaluation.ts",
      "../src/objective-extraction.ts",
      "../../../apps/api/src/services/container.ts",
      "../../../apps/api/src/routes/chat.ts",
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text, file).not.toContain("learning-evidence");
      expect(text, file).not.toContain("resolveLearningEvidence");
    }
  });

  it("the memory write path reads no S5 or S6 signal: MemoryExtractionService imports neither", () => {
    const text = readFileSync(new URL("../../memory/src/memory-extraction-service.ts", import.meta.url), "utf8");
    for (const forbidden of ["execution-outcome", "ExecutionOutcome", "objective-evaluation", "ObjectiveEvaluation", "objective-extraction", "feedback"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});
