// ---------------------------------------------------------------------------
// Audit F1 (Phase 14) — a controls document is ABSENT, VALID or MALFORMED.
//
// Learning has always read a malformed document as a pause. Recall needs to
// tell the two apart: a valid pause leaves recall on, but a malformed document
// is one whose vetoes cannot be trusted, so nothing may be recalled from it.
// `isMalformedMemoryLearningControl` is that distinction, in one place.
//
// Pure: type-only imports, no clock, no I/O.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  isMalformedMemoryLearningControl,
  parseMemoryLearningControl,
  serializeMemoryLearningControl,
} from "../src/memory-management.js";

describe("Audit F1 — absent, valid or malformed controls", () => {
  it("an absent document is not malformed: the user simply has no settings yet", () => {
    expect(isMalformedMemoryLearningControl(null)).toBe(false);
    expect(isMalformedMemoryLearningControl(undefined)).toBe(false);
  });

  it.each([
    ["learning on, no vetoes", { learningPaused: false, vetoedSourceMessageIds: [] }],
    ["a valid pause", { learningPaused: true, vetoedSourceMessageIds: [] }],
    ["vetoes", { learningPaused: false, vetoedSourceMessageIds: ["msg-1", "msg-2"] }],
  ])("a valid document is not malformed (%s)", (_label, control) => {
    expect(isMalformedMemoryLearningControl(serializeMemoryLearningControl(control))).toBe(false);
  });

  it.each([
    ["what the store returns for text that is not JSON", {}],
    ["no version", { learningPaused: false, vetoedSourceMessageIds: [] }],
    ["an unknown version", { v: 2, learningPaused: false, vetoedSourceMessageIds: [] }],
    ["a missing pause", { v: 1, vetoedSourceMessageIds: [] }],
    ["a pause that is not a boolean", { v: 1, learningPaused: "yes", vetoedSourceMessageIds: ["msg-1"] }],
    ["missing vetoes", { v: 1, learningPaused: false }],
    ["vetoes that are not a list", { v: 1, learningPaused: false, vetoedSourceMessageIds: "msg-1" }],
    ["a blank veto", { v: 1, learningPaused: false, vetoedSourceMessageIds: ["msg-1", ""] }],
    ["a veto that is not text", { v: 1, learningPaused: false, vetoedSourceMessageIds: [7] }],
    ["a string", "paused"],
    ["a number", 42],
    ["a boolean", true],
    ["a list", []],
  ])("a present document that cannot be trusted is malformed (%s)", (_label, doc) => {
    expect(isMalformedMemoryLearningControl(doc)).toBe(true);
  });

  it("learning is unchanged: every malformed document still reads as paused, and a valid one as written", () => {
    for (const doc of [{}, { v: 1 }, { v: 1, learningPaused: "yes", vetoedSourceMessageIds: ["msg-1"] }, "paused"]) {
      expect(parseMemoryLearningControl(doc).learningPaused).toBe(true);
    }
    expect(parseMemoryLearningControl({ v: 1, learningPaused: false, vetoedSourceMessageIds: ["msg-1"] })).toEqual({
      learningPaused: false,
      vetoedSourceMessageIds: ["msg-1"],
    });
  });
});
