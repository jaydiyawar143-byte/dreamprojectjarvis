// ---------------------------------------------------------------------------
// Audit F1 (Phase 14) — MemoryManagementService reads the user's controls two
// ways, one for each consumer:
//
//   learningControl()  for LEARNING. Absent: the defaults. Valid: as written.
//                      Malformed: a pause. Unreadable store: throws.
//   recallControl()    for RECALL. The same, except that a malformed document
//                      THROWS — the orchestrator then recalls nothing. A valid
//                      pause is not an error: recall goes on.
//
// The audit found that a corrupt document read as an ordinary pause, so recall
// went on with every veto gone. These tests pin the difference.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { IMemoryStore, MemoryListRequest } from "@jarvis/core";
import { MemoryManagementService, type MemoryControlStore } from "../src/memory-management-service.js";

const emptyStore = {
  async list(_request: MemoryListRequest) {
    return { memories: [], total: 0, hasMore: false };
  },
} as unknown as IMemoryStore;

function service(control: MemoryControlStore) {
  return new MemoryManagementService({ store: emptyStore, control, audit: { log: async () => undefined } });
}

const stored = (doc: Record<string, unknown> | null): MemoryControlStore => ({ get: async () => doc, put: async () => undefined });

describe("Audit F1 — the controls, as learning and as recall read them", () => {
  it("absent: the defaults for both — learning on, recall on, no vetoes", async () => {
    const memory = service(stored(null));
    expect(await memory.learningControl("user-1")).toEqual({ learningPaused: false, vetoedSourceMessageIds: [] });
    expect(await memory.recallControl("user-1")).toEqual({ learningPaused: false, vetoedSourceMessageIds: [] });
    expect((await memory.status("user-1")).controlsReadable).toBe(true);
  });

  it("a valid pause stops learning only: recall reads it without error, vetoes intact", async () => {
    const memory = service(stored({ v: 1, learningPaused: true, vetoedSourceMessageIds: ["msg-vetoed"] }));
    expect(await memory.learningControl("user-1")).toEqual({ learningPaused: true, vetoedSourceMessageIds: ["msg-vetoed"] });
    expect(await memory.recallControl("user-1")).toEqual({ learningPaused: true, vetoedSourceMessageIds: ["msg-vetoed"] });
    const status = await memory.status("user-1");
    expect(status).toMatchObject({ learningPaused: true, controlsReadable: true, vetoedSources: 1 });
  });

  it.each([
    ["text that is not JSON (the store hands back {})", {}],
    ["a pause that is not a boolean, vetoes and all", { v: 1, learningPaused: "yes", vetoedSourceMessageIds: ["msg-vetoed"] }],
    ["an unknown version", { v: 2, learningPaused: false, vetoedSourceMessageIds: [] }],
    ["missing fields", { v: 1 }],
  ])("a corrupt document (%s): learning reads as paused, and recall is REFUSED", async (_label, doc) => {
    const memory = service(stored(doc));
    expect((await memory.learningControl("user-1")).learningPaused).toBe(true);
    await expect(memory.recallControl("user-1")).rejects.toThrow(/could not be read/);
    expect(await memory.status("user-1")).toMatchObject({ learningPaused: true, controlsReadable: false });
  });

  it("a store that cannot be read: both refuse", async () => {
    const memory = service({
      get: async () => {
        throw new Error("settings table unreachable");
      },
      put: async () => undefined,
    });
    await expect(memory.learningControl("user-1")).rejects.toThrow();
    await expect(memory.recallControl("user-1")).rejects.toThrow();
  });
});
