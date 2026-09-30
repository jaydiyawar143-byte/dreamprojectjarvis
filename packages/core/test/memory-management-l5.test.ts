// S7.2 L5 — the memory-management contract.
//
// What a user can say about their memories, the one safe way a memory is
// shown to them, what each command needs before anything is deleted, and the
// user's learning controls (pause, per-message veto) — read fail-closed.
// Pure: type-only imports, no clock, no I/O.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryRecord } from "../src/types/memory.js";
import {
  DESTRUCTIVE_MEMORY_TOOL_IDS,
  MEMORY_COMMAND_KINDS,
  MEMORY_CONFIRMATION,
  MEMORY_STRICT_CONFIRMATION,
  MEMORY_TOOL_IDS,
  MEMORY_VETO_LIMIT,
  isDestructiveMemoryTool,
  isLearningBlocked,
  isStrictMemoryConfirmation,
  memoryToolConfirmation,
  parseMemoryLearningControl,
  serializeMemoryLearningControl,
  toMemoryView,
  withLearningPaused,
  withVetoedSource,
} from "../src/memory-management.js";

const CREATED = new Date("2026-09-01T10:00:00.000Z");
const CHANGED = new Date("2026-09-02T11:00:00.000Z");
const EXPIRES = new Date("2026-12-01T10:00:00.000Z");

function record(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    userId: "user-1",
    type: "PREFERENCE",
    content: "User prefers short captions",
    importance: 0.8,
    confidence: 0.8,
    accessCount: 0,
    sourceType: "USER",
    sourceConversationId: "conv-secret",
    sourceMessageId: "msg-secret",
    metadata: {
      embedding: [0.1, 0.2, 0.3],
      sourceTraceId: "trace-secret",
      modelConfidence: 0.93,
      evidence: {
        v: 1,
        count: 3,
        conversations: 2,
        firstSeenAt: "2026-09-01T10:00:00.000Z",
        lastSeenAt: "2026-09-02T11:00:00.000Z",
        sources: [{ messageId: "msg-secret", conversationId: "conv-secret", traceId: "trace-secret", kind: "DIRECT", at: "2026-09-01T10:00:00.000Z" }],
        revisions: 1,
        lastRevisedAt: "2026-09-02T11:00:00.000Z",
        previousSourceMessageIds: ["msg-older-secret"],
      },
    },
    createdAt: CREATED,
    updatedAt: CHANGED,
    expiresAt: EXPIRES,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Commands and confirmation
// ---------------------------------------------------------------------------

describe("L5 — command kinds and what each needs before anything is deleted", () => {
  it("names every command, including pause and resume", () => {
    expect([...MEMORY_COMMAND_KINDS]).toEqual(["LIST", "FORGET", "FORGET_ALL", "CORRECT", "REPLACE", "VETO", "LEARNING_PAUSE", "LEARNING_RESUME", "NONE"]);
  });

  it("nothing that deletes goes without confirmation; forgetting everything needs the strict kind", () => {
    expect(MEMORY_CONFIRMATION).toEqual({
      LIST: "NONE",
      FORGET: "EXPLICIT",
      FORGET_ALL: "STRICT",
      CORRECT: "EXPLICIT",
      REPLACE: "NONE",
      VETO: "EXPLICIT",
      LEARNING_PAUSE: "NONE",
      LEARNING_RESUME: "NONE",
      NONE: "NONE",
    });
    expect(Object.isFrozen(MEMORY_CONFIRMATION)).toBe(true);
  });

  it("the destructive tools are exactly forget and forget_all; listing is not destructive", () => {
    expect(MEMORY_TOOL_IDS).toEqual({ list: "memory.list", forget: "memory.forget", forgetAll: "memory.forget_all" });
    expect([...DESTRUCTIVE_MEMORY_TOOL_IDS]).toEqual(["memory.forget", "memory.forget_all"]);
    expect(isDestructiveMemoryTool("memory.forget")).toBe(true);
    expect(isDestructiveMemoryTool("memory.forget_all")).toBe(true);
    expect(isDestructiveMemoryTool("memory.list")).toBe(false);
    expect(isDestructiveMemoryTool("meta.campaign.pause")).toBe(false);
    expect(memoryToolConfirmation("memory.forget")).toBe("EXPLICIT");
    expect(memoryToolConfirmation("memory.forget_all")).toBe("STRICT");
    expect(memoryToolConfirmation("memory.list")).toBe("NONE");
    expect(memoryToolConfirmation("meta.campaign.pause")).toBe("NONE");
  });

  it.each([
    ["yes, forget all", true],
    ["Yes, forget all.", true],
    ["  YES   FORGET ALL!  ", true],
    ["yes", false],
    ["great", false],
    ["sounds good", false],
    ["yes forget all of them", false],
    ["forget all", false],
    ["", false],
  ])("a STRICT action is confirmed in writing only by the exact phrase: %j → %s", (text, expected) => {
    expect(isStrictMemoryConfirmation(text)).toBe(expected);
  });

  it("the strict phrase is the one the contract names", () => {
    expect(isStrictMemoryConfirmation(MEMORY_STRICT_CONFIRMATION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The safe view
// ---------------------------------------------------------------------------

describe("L5 — a memory is shown to its owner only through the safe view", () => {
  it("carries what the user needs and nothing internal", () => {
    expect(toMemoryView(record())).toEqual({
      id: "mem-1",
      type: "PREFERENCE",
      content: "User prefers short captions",
      createdAt: "2026-09-01T10:00:00.000Z",
      changedAt: "2026-09-02T11:00:00.000Z",
      expiresAt: "2026-12-01T10:00:00.000Z",
      evidenceCount: 3,
      firstSeenAt: "2026-09-01T10:00:00.000Z",
      lastSeenAt: "2026-09-02T11:00:00.000Z",
      revisions: 1,
      legacy: false,
    });
  });

  it("never exposes metadata, source or conversation ids, trace ids, vectors or confidence", () => {
    const text = JSON.stringify(toMemoryView(record()));
    for (const forbidden of ["secret", "embedding", "metadata", "confidence", "modelConfidence", "sources", "0.93", "0.1", "userId", "user-1", "importance"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("includes the summary only when there is one", () => {
    expect(toMemoryView(record({ summary: "Short captions" })).summary).toBe("Short captions");
    expect(toMemoryView(record())).not.toHaveProperty("summary");
  });

  it.each([
    ["no evidence at all (before L4)", record({ metadata: { embedding: [0.1] } })],
    ["the old sourceType convention", record({ sourceType: "conversation" })],
    ["no sourceType", record({ sourceType: undefined })],
    ["malformed evidence", record({ metadata: { evidence: { v: 2, count: "many" } } })],
    ["no metadata", record({ metadata: undefined })],
  ])("is marked legacy with %s — shown, never hidden", (_label, memory) => {
    const view = toMemoryView(memory);
    expect(view.legacy).toBe(true);
    expect(view.content).toBe(memory.content);
  });

  it("a legacy memory with no evidence reports zero statements and no dates, instead of inventing them", () => {
    const view = toMemoryView(record({ metadata: undefined, sourceType: "conversation" }));
    expect(view).toMatchObject({ evidenceCount: 0, revisions: 0, legacy: true });
    expect(view).not.toHaveProperty("firstSeenAt");
    expect(view).not.toHaveProperty("lastSeenAt");
  });

  it("an L4-era USER memory is not legacy", () => {
    expect(toMemoryView(record()).legacy).toBe(false);
  });

  it("no expiry, no expiresAt", () => {
    expect(toMemoryView(record({ expiresAt: undefined }))).not.toHaveProperty("expiresAt");
  });
});

// ---------------------------------------------------------------------------
// Learning controls
// ---------------------------------------------------------------------------

describe("L5 — the user's learning controls, read fail-closed", () => {
  it("absent means the defaults: learning on, no vetoes", () => {
    expect(parseMemoryLearningControl(null)).toEqual({ learningPaused: false, vetoedSourceMessageIds: [] });
    expect(parseMemoryLearningControl(undefined)).toEqual({ learningPaused: false, vetoedSourceMessageIds: [] });
  });

  it("a stored document round-trips", () => {
    const control = { learningPaused: true, vetoedSourceMessageIds: ["m-1", "m-2"] };
    expect(parseMemoryLearningControl(serializeMemoryLearningControl(control))).toEqual(control);
    expect(serializeMemoryLearningControl(control)).toEqual({ v: 1, learningPaused: true, vetoedSourceMessageIds: ["m-1", "m-2"] });
  });

  it.each([
    ["a string", "paused"],
    ["an unknown version", { v: 2, learningPaused: false, vetoedSourceMessageIds: [] }],
    ["a non-boolean pause", { v: 1, learningPaused: "no", vetoedSourceMessageIds: [] }],
    ["vetoes that are not ids", { v: 1, learningPaused: false, vetoedSourceMessageIds: [1, ""] }],
  ])("present but unreadable (%s) means paused: when the user's own setting cannot be read, nothing is learned", (_label, doc) => {
    expect(parseMemoryLearningControl(doc).learningPaused).toBe(true);
  });

  it("pause and resume change only the pause", () => {
    const control = { learningPaused: false, vetoedSourceMessageIds: ["m-1"] };
    expect(withLearningPaused(control, true)).toEqual({ learningPaused: true, vetoedSourceMessageIds: ["m-1"] });
    expect(withLearningPaused(withLearningPaused(control, true), false)).toEqual(control);
    expect(control.learningPaused).toBe(false);
  });

  it("a veto is recorded once, and only the newest MEMORY_VETO_LIMIT are kept", () => {
    const once = withVetoedSource({ learningPaused: false, vetoedSourceMessageIds: [] }, "m-1");
    expect(withVetoedSource(once, "m-1")).toEqual(once);
    let control = { learningPaused: false, vetoedSourceMessageIds: [] as string[] };
    for (let i = 0; i < MEMORY_VETO_LIMIT + 5; i++) control = withVetoedSource(control, `m-${i}`);
    expect(control.vetoedSourceMessageIds).toHaveLength(MEMORY_VETO_LIMIT);
    expect(control.vetoedSourceMessageIds[0]).toBe("m-5");
    expect(control.vetoedSourceMessageIds.at(-1)).toBe(`m-${MEMORY_VETO_LIMIT + 4}`);
  });

  it("learning is blocked when paused, or for a vetoed source message", () => {
    const control = { learningPaused: false, vetoedSourceMessageIds: ["m-vetoed"] };
    expect(isLearningBlocked(control, "m-vetoed")).toBe(true);
    expect(isLearningBlocked(control, "m-other")).toBe(false);
    expect(isLearningBlocked(control, undefined)).toBe(false);
    expect(isLearningBlocked({ ...control, learningPaused: true }, "m-other")).toBe(true);
    expect(isLearningBlocked({ ...control, learningPaused: true }, undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("isolation — the memory-management contract is pure core logic", () => {
  const source = readFileSync(new URL("../src/memory-management.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports types only", () => {
    const imports = code.match(/^\s*import\b.*$/gm) ?? [];
    for (const line of imports) expect(line, line).toMatch(/^\s*import type\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it("reads no clock, randomness, environment, network, database or filesystem", () => {
    for (const forbidden of ["Date.now", "new Date", "Math.random", "process.env", "fetch(", "prisma", "Prisma", "@jarvis/", "node:", "readFile"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("does not read or change the L1–L4 learning contracts", () => {
    for (const forbidden of ["learning-candidate", "learning-provenance", "learning-validation", "learning-evidence", "resolveLearningEvidence"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("is not imported by S5 or S6", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    for (const group of ["apps", "packages"]) {
      for (const pkg of readdirSync(join(root, group))) {
        const src = join(root, group, pkg, "src");
        if (!existsSync(src)) continue;
        for (const entry of readdirSync(src, { recursive: true }) as string[]) {
          if (!/(execution-outcome|objective-evaluation|objective-extraction)[\w-]*\.ts$/.test(entry)) continue;
          const file = join(src, entry);
          if (!statSync(file).isFile()) continue;
          const text = readFileSync(file, "utf8");
          expect(text, relative(root, file).split(sep).join("/")).not.toMatch(/memory-management|MemoryManagement|memory\.forget/);
        }
      }
    }
  });
});
