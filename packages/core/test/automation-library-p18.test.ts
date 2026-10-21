// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — the Automation Library's pure rules.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  LIBRARY_FAILURE_MESSAGES,
  classifyLibraryFetchFailure,
  dedupeLibraryPage,
  deriveLibraryState,
  libraryCursorHash,
  libraryEntryPresence,
  libraryFingerprint,
  libraryInstanceKey,
  normalizeLibrarySearch,
  normalizeLibraryWorkflow,
  type LibraryRemoteWorkflow,
} from "../src/index.js";

const workflow = (over: Partial<LibraryRemoteWorkflow> = {}): LibraryRemoteWorkflow => ({
  id: "wf-1",
  name: "Daily  report",
  active: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-02-01T10:00:00+02:00",
  versionId: "8f2c1d",
  tags: ["Sales", "ops", "Sales"],
  nodeTypes: ["n8n-nodes-base.slack", "n8n-nodes-base.webhook", "n8n-nodes-base.slack"],
  nodeCount: 3,
  ...over,
});

describe("normalizeLibraryWorkflow", () => {
  it("keeps bounded listing metadata, in a canonical form", () => {
    const record = normalizeLibraryWorkflow(workflow())!;
    expect(record).toMatchObject({
      externalId: "wf-1",
      name: "Daily report",
      active: true,
      remoteCreatedAt: "2026-01-01T00:00:00.000Z",
      remoteUpdatedAt: "2026-02-01T08:00:00.000Z",
      versionId: "8f2c1d",
      tags: ["Sales", "ops"],
      nodeTypes: ["n8n-nodes-base.slack", "n8n-nodes-base.webhook"],
      nodeCount: 3,
    });
    expect(record.searchText).toBe("daily report sales ops n8n-nodes-base.slack n8n-nodes-base.webhook");
    expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("says unknown — never none — for metadata the listing did not carry", () => {
    const record = normalizeLibraryWorkflow({ id: "wf-2", name: "x", active: false })!;
    expect(record).toMatchObject({ tags: null, nodeTypes: null, nodeCount: null, versionId: null, remoteCreatedAt: null });
  });

  it("refuses a row it cannot address, and bounds everything else", () => {
    for (const id of ["", "  ", "a/b", "../x", "x".repeat(129), "a b"]) {
      expect(normalizeLibraryWorkflow(workflow({ id })), id).toBeNull();
    }
    const odd = normalizeLibraryWorkflow(
      workflow({ name: `${"n".repeat(400)}\u0000`, createdAt: "not a date", versionId: "bad id!", nodeCount: -1, nodeTypes: ["ok.type", "bad type", 7 as never] })
    )!;
    expect(odd.name).toHaveLength(256);
    expect(odd.remoteCreatedAt).toBeNull();
    expect(odd.versionId).toBeNull();
    expect(odd.nodeCount).toBeNull();
    expect(odd.nodeTypes).toEqual(["ok.type"]);
  });

  it("keeps nothing but the allowed fields, whatever the source sent", () => {
    const leaky = { ...workflow(), parameters: { apiKey: "SECRET" }, credentials: { x: "SECRET" }, staticData: "SECRET" } as never;
    expect(JSON.stringify(normalizeLibraryWorkflow(leaky))).not.toContain("SECRET");
  });
});

describe("the fingerprint", () => {
  it("is stable, and changes with every stored field", () => {
    const a = normalizeLibraryWorkflow(workflow())!;
    expect(normalizeLibraryWorkflow(workflow())!.fingerprint).toBe(a.fingerprint);
    // Order of tags and node types does not matter: they are stored sorted.
    expect(normalizeLibraryWorkflow(workflow({ tags: ["ops", "Sales"] }))!.fingerprint).toBe(a.fingerprint);
    for (const change of [{ name: "Other" }, { active: false }, { versionId: "9" }, { updatedAt: "2026-03-01T00:00:00Z" }, { tags: ["x"] }, { nodeCount: 4 }]) {
      expect(normalizeLibraryWorkflow(workflow(change))!.fingerprint, JSON.stringify(change)).not.toBe(a.fingerprint);
    }
    const { searchText: _s, fingerprint, ...fields } = a;
    expect(libraryFingerprint(fields)).toBe(fingerprint);
  });
});

describe("dedupeLibraryPage", () => {
  it("keeps one record per id — the last one — in first-seen order", () => {
    const first = normalizeLibraryWorkflow(workflow({ id: "a", name: "first" }))!;
    const b = normalizeLibraryWorkflow(workflow({ id: "b" }))!;
    const second = normalizeLibraryWorkflow(workflow({ id: "a", name: "second" }))!;
    expect(dedupeLibraryPage([first, b, second]).map((r) => [r.externalId, r.name])).toEqual([
      ["a", "second"],
      ["b", "Daily report"],
    ]);
  });
});

describe("cursors and instances", () => {
  it("remembers a cursor as a hash, never the cursor", () => {
    const hash = libraryCursorHash("eyJsaW1pdCI6MTAsIm9mZnNldCI6MTB9");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("eyJ");
    expect(libraryCursorHash("a")).not.toBe(libraryCursorHash("b"));
  });

  it("names an instance by a hash of its address — credentials, query and case never count", () => {
    const key = libraryInstanceKey("https://n8n.example.test/")!;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(libraryInstanceKey("https://N8N.example.test")).toBe(key);
    expect(libraryInstanceKey("https://user:SECRET@n8n.example.test/?x=1#y")).toBe(key);
    expect(libraryInstanceKey("https://other.example.test")).not.toBe(key);
    expect(libraryInstanceKey("https://n8n.example.test/sub")).not.toBe(key);
    for (const bad of ["", "not a url", "ftp://n8n.example.test", "javascript:alert(1)"]) expect(libraryInstanceKey(bad)).toBeNull();
  });
});

describe("classifyLibraryFetchFailure", () => {
  it("names each failure from its classification alone", () => {
    expect(classifyLibraryFetchFailure({ code: "AUTHENTICATION_REQUIRED", httpStatus: 401 }, { cursorSent: true })).toBe("PROVIDER_AUTH_FAILED");
    expect(classifyLibraryFetchFailure({ code: "AUTHORIZATION_FAILED", httpStatus: 403 }, { cursorSent: false })).toBe("PROVIDER_AUTH_FAILED");
    expect(classifyLibraryFetchFailure({ code: "RATE_LIMITED", httpStatus: 429 }, { cursorSent: false })).toBe("PROVIDER_RATE_LIMITED");
    expect(classifyLibraryFetchFailure({ code: "TOOL_TIMEOUT" }, { cursorSent: true })).toBe("PROVIDER_TIMEOUT");
    expect(classifyLibraryFetchFailure({ code: "NETWORK_ERROR" }, { cursorSent: true })).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyLibraryFetchFailure({ code: "WORKFLOW_FAILED", httpStatus: 500 }, { cursorSent: true })).toBe("PROVIDER_UNAVAILABLE");
  });

  it("tells a refused cursor from a refused request and from an unreadable answer", () => {
    expect(classifyLibraryFetchFailure({ code: "INVALID_REQUEST", httpStatus: 400 }, { cursorSent: true })).toBe("CURSOR_REJECTED");
    expect(classifyLibraryFetchFailure({ code: "INVALID_REQUEST", httpStatus: 422 }, { cursorSent: true })).toBe("CURSOR_REJECTED");
    expect(classifyLibraryFetchFailure({ code: "INVALID_REQUEST", httpStatus: 400 }, { cursorSent: false })).toBe("PROVIDER_REJECTED_REQUEST");
    expect(classifyLibraryFetchFailure({ code: "INVALID_REQUEST", httpStatus: 404 }, { cursorSent: true })).toBe("PROVIDER_REJECTED_REQUEST");
    expect(classifyLibraryFetchFailure({ code: "INVALID_REQUEST" }, { cursorSent: true })).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("has a fixed sentence for every code — no address, no placeholder to fill with the provider's words", () => {
    for (const message of Object.values(LIBRARY_FAILURE_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/https?:|\{|\}|\$|%s/i);
    }
  });
});

describe("state and presence", () => {
  it("is running only with a live lease, complete only with no scan open and a complete scan on record", () => {
    const base = { leaseHeld: false, latestRunStatus: null, scanOpen: false, lastCompleteAt: null } as const;
    expect(deriveLibraryState(base)).toBe("never_synced");
    expect(deriveLibraryState({ ...base, leaseHeld: true, latestRunStatus: "RUNNING" })).toBe("running");
    expect(deriveLibraryState({ ...base, latestRunStatus: "RUNNING" })).toBe("failed");
    expect(deriveLibraryState({ ...base, latestRunStatus: "FAILED", lastCompleteAt: "x" })).toBe("failed");
    expect(deriveLibraryState({ ...base, latestRunStatus: "PARTIAL", scanOpen: true, lastCompleteAt: "x" })).toBe("partial");
    expect(deriveLibraryState({ ...base, latestRunStatus: "COMPLETE", lastCompleteAt: "x" })).toBe("complete");
    expect(deriveLibraryState({ ...base, latestRunStatus: "PARTIAL" })).toBe("partial");
  });

  it("reads an entry's presence from its misses and its removal", () => {
    expect(libraryEntryPresence({ missedScans: 0, removedAt: null })).toBe("present");
    expect(libraryEntryPresence({ missedScans: 1, removedAt: null })).toBe("missing");
    expect(libraryEntryPresence({ missedScans: 2, removedAt: new Date() })).toBe("removed");
  });

  it("compares search text the same way on both sides", () => {
    expect(normalizeLibrarySearch("  ＳＬＡＣＫ   Bot ")).toBe("slack bot");
  });
});
