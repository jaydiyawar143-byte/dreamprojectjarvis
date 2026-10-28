// ---------------------------------------------------------------------------
// Phase 19.1 fix — marketing publish pending action parameter projection
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { MARKETING_TOOL_IDS } from "@jarvis/core";
import { clientPendingAction } from "../src/services/client-views.js";

const basePending = (overrides: Record<string, unknown> = {}) => ({
  id: "pa-1",
  conversationId: "c-1",
  userId: "user-1",
  toolId: MARKETING_TOOL_IDS.contentPublish,
  action: "Publish content",
  riskLevel: "HIGH",
  state: "PENDING",
  approvalId: "ap-1",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  summary: "Publish post",
  params: {},
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("clientPendingAction - marketing content publish preview", () => {
  it("preserves the six permitted string fields", () => {
    const pending = basePending({
      params: {
        contentId: "content-123",
        targetId: "page-456",
        targetName: "My Page",
        message: "Hello world",
        link: "https://example.com",
        earlierAttempt: "attempt-1",
      },
    });
    const projected = clientPendingAction(pending as any);
    expect(projected.params).toEqual({
      contentId: "content-123",
      targetId: "page-456",
      targetName: "My Page",
      message: "Hello world",
      link: "https://example.com",
      earlierAttempt: "attempt-1",
    });
  });

  it("drops all extra keys", () => {
    const pending = basePending({
      params: {
        contentId: "content-123",
        targetId: "page-456",
        targetName: "My Page",
        message: "Hello",
        link: "https://example.com",
        earlierAttempt: "attempt-1",
        secret: "hunter2",
        token: "abc123",
        userId: "u-1",
      },
    });
    const projected = clientPendingAction(pending as any);
    expect(projected.params).toEqual({
      contentId: "content-123",
      targetId: "page-456",
      targetName: "My Page",
      message: "Hello",
      link: "https://example.com",
      earlierAttempt: "attempt-1",
    });
  });

  it("excludes non-string values", () => {
    const pending = basePending({
      params: {
        contentId: "content-123",
        targetId: 123,
        targetName: null,
        message: "Hello",
        link: undefined,
        earlierAttempt: ["attempt"],
      },
    });
    const projected = clientPendingAction(pending as any);
    expect(projected.params).toEqual({
      contentId: "content-123",
      message: "Hello",
    });
  });

  it("keeps other tools' existing projection behavior", () => {
    const pending = {
      ...basePending({ toolId: "memory.correct", action: "Correct memory" }),
      params: { memoryId: "m-1", text: "secret-text-that-should-not-be-exposed" },
    };
    const projected = clientPendingAction(pending as any);
    expect((projected.params as any).memoryId).toBe("m-1");
    expect(Object.keys(projected.params)).toContain("memoryId");
  });

  it("browser and desktop actions remain redacted", () => {
    const browser = basePending({ toolId: "browser.type", action: "Type" });
    (browser as any).params = { text: "hunter2", selector: "#input" };
    const projectedBrowser = clientPendingAction(browser as any);
    expect(projectedBrowser.params).toEqual({});

    const desktop = basePending({ toolId: "computer.click", action: "Click" });
    (desktop as any).params = { x: 100, y: 200 };
    const projectedDesktop = clientPendingAction(desktop as any);
    expect(projectedDesktop.params).toEqual({});
  });
});
