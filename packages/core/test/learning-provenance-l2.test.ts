// S7.2 L2 Step 1 — the provenance contract.
//
// Every automatically learned memory must say WHO said it and WHERE: the
// speaker, the conversation, the message and (when known) the trace. A USER
// memory may only come from USER evidence — JARVIS's reply is context, never
// a source.
//
// `resolveUserProvenance` is the one decision: given the extraction model's
// citation for a candidate (which message it came from, and a verbatim quote)
// and the turn's labelled messages, it either returns USER provenance built
// from the SERVICE's own record of that message, or refuses with a reason.
// The model's claim is only a pointer; the role and every id come from the
// service. Pure: no I/O, no clock, no environment.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVENANCE_REJECTIONS,
  PROVENANCE_SOURCE_TYPES,
  resolveUserProvenance,
  type LearningProvenance,
  type ProvenanceSource,
} from "../src/learning-provenance.js";

const USER_MSG: ProvenanceSource = {
  ref: "M1",
  sourceType: "USER",
  statement: "I prefer short captions.",
  sourceConversationId: "conv-1",
  sourceMessageId: "msg-user-1",
  sourceTraceId: "trace-1",
};
const ASSISTANT_MSG: ProvenanceSource = {
  ref: "M2",
  sourceType: "ASSISTANT",
  statement: "Great, I'll remember that you prefer short captions.",
  sourceConversationId: "conv-1",
  sourceTraceId: "trace-1",
};
const SYSTEM_MSG: ProvenanceSource = {
  ref: "M3",
  sourceType: "SYSTEM",
  statement: "The user's default style is short captions.",
  sourceConversationId: "conv-1",
  sourceMessageId: "msg-system-1",
};
const TURN = [USER_MSG, ASSISTANT_MSG, SYSTEM_MSG];

describe("L2 — the provenance contract", () => {
  it("names exactly three source types", () => {
    expect([...PROVENANCE_SOURCE_TYPES]).toEqual(["USER", "ASSISTANT", "SYSTEM"]);
  });

  it("a candidate citing a USER message with a verbatim quote gets that message's provenance", () => {
    expect(resolveUserProvenance({ source: "M1", evidence: "I prefer short captions" }, TURN)).toEqual({
      accepted: true,
      provenance: { sourceType: "USER", sourceConversationId: "conv-1", sourceMessageId: "msg-user-1", sourceTraceId: "trace-1" },
    });
  });

  it("the provenance is plain, serializable data: ids only, never the statement or the quote", () => {
    const result = resolveUserProvenance({ source: "M1", evidence: "short captions" }, TURN);
    if (!result.accepted) throw new Error("expected acceptance");
    const provenance: LearningProvenance = result.provenance;
    expect(JSON.parse(JSON.stringify(provenance))).toEqual(provenance);
    expect(Object.keys(provenance).sort()).toEqual(["sourceConversationId", "sourceMessageId", "sourceTraceId", "sourceType"]);
    expect(JSON.stringify(provenance)).not.toContain("captions");
  });

  it("is deterministic: the same citation and turn always give the same answer", () => {
    const citation = { source: "M1", evidence: "short captions" };
    const first = resolveUserProvenance(citation, TURN);
    for (let i = 0; i < 5; i++) expect(resolveUserProvenance(citation, TURN)).toEqual(first);
  });

  it("the trace is included only where the message has one", () => {
    const noTrace = { ...USER_MSG, sourceTraceId: undefined };
    const result = resolveUserProvenance({ source: "M1", evidence: "short captions" }, [noTrace]);
    expect(result).toEqual({
      accepted: true,
      provenance: { sourceType: "USER", sourceConversationId: "conv-1", sourceMessageId: "msg-user-1" },
    });
    if (result.accepted) expect("sourceTraceId" in result.provenance).toBe(false);
  });

  it("every id comes from the service's record, whatever else the citation carries", () => {
    const forged = { source: "M1", evidence: "short captions", sourceType: "SYSTEM", sourceMessageId: "forged", sourceTraceId: "forged" };
    const result = resolveUserProvenance(forged, TURN);
    expect(result).toEqual({
      accepted: true,
      provenance: { sourceType: "USER", sourceConversationId: "conv-1", sourceMessageId: "msg-user-1", sourceTraceId: "trace-1" },
    });
  });
});

describe("L2 — ASSISTANT and SYSTEM text is never a USER source", () => {
  it("a candidate citing JARVIS's reply is refused", () => {
    expect(resolveUserProvenance({ source: "M2", evidence: "you prefer short captions" }, TURN)).toEqual({
      accepted: false,
      reason: "SOURCE_NOT_USER",
    });
  });

  it("a candidate citing a SYSTEM message is refused", () => {
    expect(resolveUserProvenance({ source: "M3", evidence: "default style is short captions" }, TURN)).toEqual({
      accepted: false,
      reason: "SOURCE_NOT_USER",
    });
  });

  it("citing the user while quoting JARVIS's words is refused: the quote is not in the user's message", () => {
    const turn = [
      { ...USER_MSG, statement: "Thanks, sounds good." },
      { ...ASSISTANT_MSG, statement: "I've decided that your default style is short captions." },
    ];
    expect(resolveUserProvenance({ source: "M1", evidence: "your default style is short captions" }, turn)).toEqual({
      accepted: false,
      reason: "EVIDENCE_NOT_IN_SOURCE",
    });
  });

  it("an explicit endorsement is USER evidence, and its provenance is the endorsing message", () => {
    const turn: ProvenanceSource[] = [
      { ref: "M1", sourceType: "USER", statement: "Yes, make that my default.", sourceConversationId: "conv-9", sourceMessageId: "msg-endorse", sourceTraceId: "trace-9" },
      { ref: "M2", sourceType: "ASSISTANT", statement: "Your default is short captions.", sourceConversationId: "conv-9", sourceTraceId: "trace-9" },
    ];
    expect(resolveUserProvenance({ source: "M1", evidence: "make that my default" }, turn)).toEqual({
      accepted: true,
      provenance: { sourceType: "USER", sourceConversationId: "conv-9", sourceMessageId: "msg-endorse", sourceTraceId: "trace-9" },
    });
  });
});

describe("L2 — missing provenance is refused, never defaulted to USER", () => {
  it.each([
    ["no source", { evidence: "short captions" }],
    ["an empty source", { source: "", evidence: "short captions" }],
    ["a blank source", { source: "   ", evidence: "short captions" }],
    ["a non-string source", { source: 1, evidence: "short captions" }],
    ["a null source", { source: null, evidence: "short captions" }],
  ])("%s → SOURCE_MISSING", (_label, citation) => {
    expect(resolveUserProvenance(citation, TURN)).toEqual({ accepted: false, reason: "SOURCE_MISSING" });
  });

  it.each([
    ["a label that is not in the turn", "M9"],
    ["a message id instead of a label", "msg-user-1"],
    ["a role instead of a label", "USER"],
  ])("%s → SOURCE_UNKNOWN", (_label, source) => {
    expect(resolveUserProvenance({ source, evidence: "short captions" }, TURN)).toEqual({ accepted: false, reason: "SOURCE_UNKNOWN" });
  });

  it("a label that matches two messages is ambiguous → SOURCE_UNKNOWN", () => {
    expect(resolveUserProvenance({ source: "M1", evidence: "short captions" }, [USER_MSG, { ...USER_MSG, sourceMessageId: "other" }])).toEqual({
      accepted: false,
      reason: "SOURCE_UNKNOWN",
    });
  });

  it.each([
    ["no conversation id", { ...USER_MSG, sourceConversationId: undefined }],
    ["no message id", { ...USER_MSG, sourceMessageId: undefined }],
    ["a blank message id", { ...USER_MSG, sourceMessageId: " " }],
  ])("a USER message with %s cannot be traced → SOURCE_IDS_MISSING", (_label, source) => {
    expect(resolveUserProvenance({ source: "M1", evidence: "short captions" }, [source])).toEqual({
      accepted: false,
      reason: "SOURCE_IDS_MISSING",
    });
  });

  it.each([
    ["no evidence", { source: "M1" }],
    ["empty evidence", { source: "M1", evidence: "" }],
    ["punctuation only", { source: "M1", evidence: " \"...\" " }],
    ["non-string evidence", { source: "M1", evidence: ["short captions"] }],
  ])("%s → EVIDENCE_MISSING", (_label, citation) => {
    expect(resolveUserProvenance(citation, TURN)).toEqual({ accepted: false, reason: "EVIDENCE_MISSING" });
  });

  it("a quote the user never wrote → EVIDENCE_NOT_IN_SOURCE", () => {
    expect(resolveUserProvenance({ source: "M1", evidence: "I prefer long captions" }, TURN)).toEqual({
      accepted: false,
      reason: "EVIDENCE_NOT_IN_SOURCE",
    });
  });

  it("the rejection reasons are exactly these, in the order they are checked", () => {
    expect([...PROVENANCE_REJECTIONS]).toEqual([
      "SOURCE_MISSING",
      "SOURCE_UNKNOWN",
      "SOURCE_NOT_USER",
      "SOURCE_IDS_MISSING",
      "EVIDENCE_MISSING",
      "EVIDENCE_NOT_IN_SOURCE",
    ]);
  });

  it("a rejection carries no text and no id", () => {
    const result = resolveUserProvenance({ source: "M2", evidence: "you prefer short captions" }, TURN);
    expect(Object.keys(result).sort()).toEqual(["accepted", "reason"]);
  });
});

describe("L2 — the quote is compared as text, not as bytes", () => {
  it.each([
    ["different case", "i PREFER short CAPTIONS"],
    ["extra whitespace", "I  prefer\n short captions"],
    ["surrounding quotes and a full stop", "\"I prefer short captions.\""],
    ["curly apostrophes", "I’m"],
  ])("%s still matches", (_label, evidence) => {
    const source = { ...USER_MSG, statement: "I'm sure: I prefer short captions." };
    expect(resolveUserProvenance({ source: "M1", evidence }, [source]).accepted).toBe(true);
  });

  it("a bracketed or lower-case label still resolves", () => {
    expect(resolveUserProvenance({ source: "[m1]", evidence: "short captions" }, TURN).accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Isolation — pure core logic, one runtime consumer
// ---------------------------------------------------------------------------

describe("isolation — the provenance contract is pure core logic", () => {
  const source = readFileSync(new URL("../src/learning-provenance.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports nothing", () => {
    expect(code).not.toMatch(/\bfrom\s+["']/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it("names no database, HTTP, execution, policy, agent, orchestrator, filesystem or model dependency", () => {
    for (const forbidden of [
      "prisma",
      "Prisma",
      "@jarvis/",
      "express",
      "node:",
      "axios",
      "ToolExecutor",
      "agent-policy",
      "write-intent",
      "Orchestrator",
      "orchestrator",
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
          if (path === "packages/core/src/learning-provenance.ts") continue;
          const text = readFileSync(file, "utf8");
          if (/learning-provenance|resolveUserProvenance|PROVENANCE_REJECTIONS/.test(text)) consumers.push(path);
        }
      }
    }
    expect(consumers.sort()).toEqual([
      "packages/core/src/index.ts",
      "packages/core/src/learning-validation.ts",
      "packages/memory/src/memory-extraction-service.ts",
    ]);
  });
});
