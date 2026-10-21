// ---------------------------------------------------------------------------
// Phase 18, Stage 18.3B — the sanitized inspection of one catalog entry, and
// the proposal's parameter contract. Named `automation-library*` so CI's core
// slice runs it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  LIBRARY_INSPECTION_LIMITS,
  SHARED_CONNECTION_TOOLS,
  AUTOMATION_LIBRARY_TOOL_IDS,
  inspectLibraryEntry,
  isLibraryEntryId,
  libraryEntryRef,
  libraryIntegrationCategory,
  libraryTriggerKind,
  sharedConnectionOfTool,
  validateLibraryAllowlistParams,
  withoutLinks,
  type LibraryEntryRecord,
} from "../src/index.js";

function entry(over: Partial<LibraryEntryRecord> = {}): LibraryEntryRecord {
  return {
    externalId: "wf-1",
    name: "Invoice sync",
    active: true,
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
    versionId: "v-1",
    tags: ["finance"],
    nodeTypes: ["n8n-nodes-base.webhook", "n8n-nodes-base.slack", "n8n-nodes-base.postgres"],
    nodeCount: 5,
    fingerprint: "f".repeat(64),
    source: "rest",
    presence: "present",
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-20T00:00:00.000Z",
    contentChangedAt: "2026-10-01T00:00:00.000Z",
    missingSince: null,
    removedAt: null,
    ...over,
  };
}

const INSPECTION_KEYS = [
  "entryId", "name", "active", "presence", "versionId", "observedAt", "trigger", "nodeTypes", "integrations", "inputs", "stale", "limitations",
].sort();

describe("inspectLibraryEntry — an explicit allowlist of fields", () => {
  it("derives the trigger and integrations from node types, and nothing else", () => {
    const view = inspectLibraryEntry(entry());
    expect(Object.keys(view).sort()).toEqual(INSPECTION_KEYS);
    expect(view.trigger).toEqual({ status: "derived", kinds: [{ kind: "webhook", nodeType: "n8n-nodes-base.webhook" }] });
    expect(view.integrations).toEqual({
      status: "derived",
      categories: [
        { category: "database", nodeTypes: ["n8n-nodes-base.postgres"] },
        { category: "http", nodeTypes: ["n8n-nodes-base.webhook"] },
        { category: "messaging", nodeTypes: ["n8n-nodes-base.slack"] },
      ],
      unrecognized: [],
    });
    expect(view.inputs).toEqual({ available: false, reason: LIBRARY_INSPECTION_LIMITS.inputs });
    expect(view.limitations).toContain(LIBRARY_INSPECTION_LIMITS.noParameters);
    expect(view.limitations).toContain(LIBRARY_INSPECTION_LIMITS.disabledUnknown);
    // Tags, the fingerprint and the timestamps of n8n are not part of it.
    expect(JSON.stringify(view)).not.toContain("finance");
    expect(JSON.stringify(view)).not.toContain("ffff");
  });

  it("takes links out of a name, and re-validates every stored node type — dropping, never echoing, a bad one", () => {
    const view = inspectLibraryEntry(
      entry({
        name: "Sync https://evil.example/x?token=abc and ftp://files.example and www.evil.example/path",
        nodeTypes: ["n8n-nodes-base.webhook", "<script>alert(1)</script>", "n8n-nodes-base.httpRequest?token=abc", "community.thing"],
      })
    );
    expect(view.name).toBe("Sync [link removed] and [link removed] and [link removed]");
    expect(view.nodeTypes).toEqual({ status: "partial", items: ["community.thing", "n8n-nodes-base.webhook"], count: 5 });
    expect(view.integrations.unrecognized).toEqual(["community.thing"]);
    expect(view.limitations).toContain(LIBRARY_INSPECTION_LIMITS.partialNodeTypes);
    const text = JSON.stringify(view);
    for (const leak of ["evil.example", "token=abc", "<script>", "files.example"]) expect(text, leak).not.toContain(leak);
  });

  it("reports what the listing did not carry, instead of guessing it", () => {
    const view = inspectLibraryEntry(entry({ nodeTypes: null, nodeCount: null, versionId: "bad version!" }));
    expect(view.trigger).toEqual({ status: "unavailable", kinds: [] });
    expect(view.integrations).toEqual({ status: "unavailable", categories: [], unrecognized: [] });
    expect(view.nodeTypes).toEqual({ status: "unavailable", items: [], count: null });
    expect(view.versionId).toBeNull();
    expect(view.limitations).toEqual(
      expect.arrayContaining([LIBRARY_INSPECTION_LIMITS.noNodeTypes, LIBRARY_INSPECTION_LIMITS.noVersion, LIBRARY_INSPECTION_LIMITS.inputs])
    );
  });

  it("says when no trigger was recognized, and marks a missing or removed entry stale", () => {
    expect(inspectLibraryEntry(entry({ nodeTypes: ["n8n-nodes-base.set"] })).trigger).toEqual({ status: "none_found", kinds: [] });
    expect(inspectLibraryEntry(entry({ presence: "missing" })).stale).toEqual({ stale: true, reason: LIBRARY_INSPECTION_LIMITS.missing });
    expect(inspectLibraryEntry(entry({ presence: "removed" })).stale).toEqual({ stale: true, reason: LIBRARY_INSPECTION_LIMITS.removed });
    expect(inspectLibraryEntry(entry()).stale).toEqual({ stale: false, reason: null });
  });

  it("classifies triggers and integrations from curated tables, never by guesswork", () => {
    expect(libraryTriggerKind("n8n-nodes-base.scheduleTrigger")).toBe("schedule");
    expect(libraryTriggerKind("n8n-nodes-base.slackTrigger")).toBe("app_event");
    expect(libraryTriggerKind("@n8n/n8n-nodes-langchain.chatTrigger")).toBe("chat");
    expect(libraryTriggerKind("n8n-nodes-base.slack")).toBeNull();
    expect(libraryIntegrationCategory("n8n-nodes-base.slackTrigger")).toBe("messaging");
    expect(libraryIntegrationCategory("@n8n/n8n-nodes-langchain.agent")).toBe("ai");
    expect(libraryIntegrationCategory("community.slack")).toBeNull();
    expect(libraryIntegrationCategory("nodot")).toBeNull();
    expect(withoutLinks("see https://x.example")).toBe("see [link removed]");
  });
});

describe("the proposal's contract", () => {
  it("binds exactly an entry and its version — nothing else, and nothing the server decides", () => {
    expect(validateLibraryAllowlistParams({ entryId: "wf-1", versionId: "v-1" })).toEqual({ entryId: "wf-1", versionId: "v-1" });
    for (const bad of [
      { entryId: "wf-1" },
      { entryId: "wf-1", versionId: "v-1", tenantId: "org" },
      { entryId: "../x", versionId: "v-1" },
      { entryId: "wf-1", versionId: "v 1" },
      { entryId: "wf-1", versionId: 1 },
      null,
      [],
    ]) {
      expect(validateLibraryAllowlistParams(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(isLibraryEntryId("wf-1")).toBe(true);
    expect(isLibraryEntryId("wf/1")).toBe(false);
    expect(libraryEntryRef("inst", "wf-1")).toBe("inst:wf-1");
  });

  it("makes the change an Organization's write through the n8n connection — approved by someone else", () => {
    expect(SHARED_CONNECTION_TOOLS[AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd]).toEqual({ integration: "n8n", access: "write" });
    expect(sharedConnectionOfTool(AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd)).toMatchObject({ connector: { providerId: "n8n", connector: "rest" }, access: "write" });
    // Inspecting and proposing are not writes through the connection.
    expect(sharedConnectionOfTool(AUTOMATION_LIBRARY_TOOL_IDS.inspect)).toBeNull();
    expect(sharedConnectionOfTool(AUTOMATION_LIBRARY_TOOL_IDS.propose)).toBeNull();
  });
});
