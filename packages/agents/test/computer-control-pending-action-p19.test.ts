// ---------------------------------------------------------------------------
// Phase 19, Stage 19.5 — what a chat says when a browser or desktop action
// waits for confirmation (F4, "meaningful approval summaries").
//
// The pending-action message is the sentence a person confirms in the chat;
// it rides the conversation as the card's summary and is stored with the
// message. For a browser or desktop action it names the action, the site, the
// field and how many characters — the same value-free summary the Approvals
// page shows — and never what was typed, selected or submitted, a path, a
// query or an artifact id.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { Approval, ITool } from "@jarvis/core";

import { PendingActionService } from "../src/pending-action-service.js";

function service(toolNames: Record<string, string> = {}) {
  const rows = new Map<string, Approval>();
  let seq = 0;
  const approvalRepo = {
    async create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval> {
      const row: Approval = { ...data, id: `apr-${++seq}`, status: "pending", createdAt: new Date().toISOString() };
      rows.set(row.id, row);
      return row;
    },
    findById: async (id: string) => rows.get(id) ?? null,
    updateStatus: async () => null,
    findPendingByConversationId: async () => null,
    updateParams: async () => null,
    decideApproval: async () => ({ outcome: "rejected" }),
  };
  const toolRegistry = {
    get: (id: string) => (toolNames[id] ? ({ id, name: toolNames[id] } as unknown as ITool) : undefined),
    getAll: () => [],
  };
  return new PendingActionService({ approvalRepo, toolRegistry });
}

async function messageFor(toolId: string, params: Record<string, unknown>, name = "Browser action") {
  const { message } = await service({ [toolId]: name }).createPendingAction({
    conversationId: "conv-1",
    userId: "user-1",
    toolId,
    action: toolId,
    params,
    riskLevel: "EXTERNAL_SIDE_EFFECT",
  });
  return message;
}

const SECRETS = ["hunter2-TYPED", "token=abc", "/login", "4111111111111111", "Wish-Option", "9b2d6a4e"];

describe("Phase 19.5 — a browser or desktop action's chat confirmation", () => {
  it("names the action, the site, the field and the character count", async () => {
    const message = await messageFor(
      "browser.type",
      { url: "https://shop.example/login?token=abc", selector: "#password", text: "hunter2-TYPED" },
      "Type Into Field"
    );
    expect(message).toContain("Type into a field on https://shop.example.");
    expect(message).toContain("Site: https://shop.example");
    expect(message).toContain("Field: #password");
    expect(message).toContain("Characters: 13");
    for (const secret of SECRETS) expect(message).not.toContain(secret);
  });

  it("names a form's fields and says it may not be reversible, never their values", async () => {
    const message = await messageFor("browser.submit", {
      url: "https://shop.example/checkout?token=abc",
      selector: "button[type=submit]",
      fields: { "#card": "4111111111111111", 'input[name="plan"]': "Wish-Option" },
    });
    expect(message).toContain("Fill and submit a form on https://shop.example.");
    expect(message).toContain("Fields: #card, input[name=…]");
    expect(message).toContain("Reversible: No");
    for (const secret of SECRETS) expect(message).not.toContain(secret);
  });

  it.each([
    ["browser.select", { url: "https://shop.example/login", selector: "#plan", value: "Wish-Option" }],
    ["browser.upload", { url: "https://shop.example/login", selector: "#file", downloadId: "9b2d6a4e-1f3c-4d5e-8a7b-0c1d2e3f4a5b" }],
    ["desktop.input.type", { text: "hunter2-TYPED" }],
  ])("holds no value for %s", async (toolId, params) => {
    const message = await messageFor(toolId, params);
    expect(message.split("\n").length).toBeGreaterThan(3);
    for (const secret of SECRETS) expect(message).not.toContain(secret);
  });

  it("says plainly when the request cannot be verified, and echoes nothing", async () => {
    const message = await messageFor("browser.type", { url: "file:///C:/secret.txt", selector: "#password", text: "hunter2-TYPED" });
    expect(message).toContain("could not be verified");
    expect(message).not.toContain("hunter2-TYPED");
    expect(message).not.toContain("secret.txt");
  });

  it("leaves every other tool's message as it was", async () => {
    const message = await messageFor("meta.campaign.pause", { campaignId: "100000001", status: "PAUSED" }, "Pause Campaign");
    expect(message).toContain("Campaign ID: 100000001");
    expect(message).toContain("Status: PAUSED");
  });
});
