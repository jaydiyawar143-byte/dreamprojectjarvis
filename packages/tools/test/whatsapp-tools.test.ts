import { describe, it, expect } from "vitest";
import type { ToolContext, IWhatsAppRepository } from "@jarvis/core";
import {
  WhatsAppSendMessageTool,
  RepositoryRecipientAuthorizer,
  validateWaId,
  validateMessageBody,
  type WhatsAppRecipientAuthorizer,
} from "../src/tools/whatsapp-tools.js";
import { MockWhatsAppProvider } from "../src/tools/whatsapp-mock.js";

const ctx = (userId = "user-1"): ToolContext =>
  ({ userId, traceId: "trace-1", role: "member" }) as unknown as ToolContext;

const PHONE_NUMBER_ID = "109876543210";

/** Authorizer that allows an explicit set of users. */
function authorizerFor(...allowed: string[]): WhatsAppRecipientAuthorizer {
  return { async isAuthorized(userId) { return allowed.includes(userId); } };
}

/** Minimal repository double recording outbound writes. */
function makeRepo(owner: string | null = "user-1") {
  const outbound: any[] = [];
  const repo: IWhatsAppRepository & { outbound: any[] } = {
    outbound,
    async findUserForPhoneNumber() { return owner; },
    async recordInbound() { return { recorded: true, duplicate: false, messageId: "m1" }; },
    async recordOutbound(input) {
      outbound.push(input);
      return { ...input, id: "row-1", direction: "OUTBOUND", type: "TEXT", status: "sent", providerTimestamp: new Date(), createdAt: new Date() } as any;
    },
    async applyStatus() { return true; },
    async listForUser() { return []; },
  } as any;
  return repo;
}

describe("Sprint 5.3 — WhatsApp send tool", () => {
  describe("validators", () => {
    it.each([
      ["+1 (555) 010-1234", "15550101234"],
      ["15550101234", "15550101234"],
    ])("accepts %s", (input, expected) => {
      expect(validateWaId(input)).toBe(expected);
    });

    it.each([["12345"], [""], ["abc"], [null], [42], ["1".repeat(16)]])("rejects %s", (bad) => {
      expect(validateWaId(bad)).toBeNull();
    });

    it("rejects an empty or oversized body", () => {
      expect(validateMessageBody("")).toBeNull();
      expect(validateMessageBody("   ")).toBeNull();
      expect(validateMessageBody("x".repeat(4097))).toBeNull();
      expect(validateMessageBody("  hi  ")).toBe("hi");
    });
  });

  describe("approval boundary", () => {
    const tool = new WhatsAppSendMessageTool(
      new MockWhatsAppProvider(),
      authorizerFor("user-1"),
      PHONE_NUMBER_ID
    );

    it("is classified EXTERNAL_SIDE_EFFECT and requires approval", () => {
      // Sending is irreversible: there is no unsend. This classification is
      // what makes ToolApprovalService demand a human decision, using the same
      // RISK_REQUIRES_APPROVAL table that gates the Meta write tools.
      expect(tool.risk).toBe("EXTERNAL_SIDE_EFFECT");
      expect(tool.requiresApproval).toBe(true);
      expect(tool.requiredPermissions).toEqual(["read", "write"]);
      expect(tool.category).toBe("communication");
    });

    it("says plainly in its description that it is not reversible", () => {
      // The description reaches the human approving the action.
      expect(tool.description).toMatch(/approval/i);
      expect(tool.description).toMatch(/not reversible/i);
    });
  });

  describe("successful send", () => {
    it("sends and returns the provider message id", async () => {
      const provider = new MockWhatsAppProvider({ messageId: "wamid.SENT1" });
      const tool = new WhatsAppSendMessageTool(provider, authorizerFor("user-1"), PHONE_NUMBER_ID);

      const result = await tool.execute({ to: "15550101234", body: "Hello" }, ctx("user-1"));

      expect(result.success).toBe(true);
      expect((result.data as any).providerMessageId).toBe("wamid.SENT1");
      expect(provider.sent).toEqual([{ to: "15550101234", body: "Hello" }]);
    });

    it("normalises the recipient before sending", async () => {
      const provider = new MockWhatsAppProvider();
      const tool = new WhatsAppSendMessageTool(provider, authorizerFor("user-1"), PHONE_NUMBER_ID);
      await tool.execute({ to: "+1 (555) 010-1234", body: "hi" }, ctx("user-1"));
      expect(provider.sent[0].to).toBe("15550101234");
    });

    it("records the outbound message against the sender", async () => {
      const repo = makeRepo();
      const tool = new WhatsAppSendMessageTool(
        new MockWhatsAppProvider({ messageId: "wamid.X" }),
        authorizerFor("user-1"),
        PHONE_NUMBER_ID,
        repo
      );
      await tool.execute({ to: "15550101234", body: "hi" }, ctx("user-1"));

      expect(repo.outbound).toHaveLength(1);
      expect(repo.outbound[0]).toMatchObject({
        userId: "user-1",
        providerMessageId: "wamid.X",
        waId: "15550101234",
      });
    });

    it("still reports success when recording fails after delivery", async () => {
      // The message HAS gone out. Reporting failure would invite a duplicate
      // send on retry, which is worse than a missing log row.
      const repo = makeRepo();
      repo.recordOutbound = async () => {
        throw new Error("database down");
      };
      const tool = new WhatsAppSendMessageTool(
        new MockWhatsAppProvider(),
        authorizerFor("user-1"),
        PHONE_NUMBER_ID,
        repo
      );
      const result = await tool.execute({ to: "15550101234", body: "hi" }, ctx("user-1"));
      expect(result.success).toBe(true);
    });
  });

  describe("authorization", () => {
    it("DENIES a user who does not own the WhatsApp account", async () => {
      const provider = new MockWhatsAppProvider();
      const tool = new WhatsAppSendMessageTool(provider, authorizerFor("user-1"), PHONE_NUMBER_ID);

      const result = await tool.execute({ to: "15550101234", body: "hi" }, ctx("user-2"));

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Not authorized/);
      // The critical assertion: nothing was sent.
      expect(provider.sent).toHaveLength(0);
    });

    it("checks authorization BEFORE contacting the provider", async () => {
      const provider = new MockWhatsAppProvider();
      const tool = new WhatsAppSendMessageTool(provider, authorizerFor(), PHONE_NUMBER_ID);
      await tool.execute({ to: "15550101234", body: "hi" }, ctx("user-1"));
      expect(provider.sent).toHaveLength(0);
    });

    it("rejects invalid input before authorization or sending", async () => {
      const provider = new MockWhatsAppProvider();
      const tool = new WhatsAppSendMessageTool(provider, authorizerFor("user-1"), PHONE_NUMBER_ID);

      expect((await tool.execute({ to: "abc", body: "hi" }, ctx())).success).toBe(false);
      expect((await tool.execute({ to: "15550101234", body: "" }, ctx())).success).toBe(false);
      expect(provider.sent).toHaveLength(0);
    });

    describe("RepositoryRecipientAuthorizer", () => {
      it("authorizes only the user who claimed the phone number", async () => {
        const auth = new RepositoryRecipientAuthorizer(makeRepo("user-1"), PHONE_NUMBER_ID);
        expect(await auth.isAuthorized("user-1", "15550101234")).toBe(true);
        expect(await auth.isAuthorized("user-2", "15550101234")).toBe(false);
      });

      it("denies everyone when the number is unclaimed", async () => {
        const auth = new RepositoryRecipientAuthorizer(makeRepo(null), PHONE_NUMBER_ID);
        expect(await auth.isAuthorized("user-1", "15550101234")).toBe(false);
      });
    });
  });

  describe("provider failures", () => {
    it("returns a failure result rather than throwing", async () => {
      const tool = new WhatsAppSendMessageTool(
        new MockWhatsAppProvider({ throwOnSend: new Error("Rate limit hit") }),
        authorizerFor("user-1"),
        PHONE_NUMBER_ID
      );
      const result = await tool.execute({ to: "15550101234", body: "hi" }, ctx("user-1"));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/rate limit/i);
    });

    it("does not record an outbound row when the send failed", async () => {
      const repo = makeRepo();
      const tool = new WhatsAppSendMessageTool(
        new MockWhatsAppProvider({ throwOnSend: new Error("Undeliverable") }),
        authorizerFor("user-1"),
        PHONE_NUMBER_ID,
        repo
      );
      await tool.execute({ to: "15550101234", body: "hi" }, ctx("user-1"));
      expect(repo.outbound).toHaveLength(0);
    });
  });

  describe("result hygiene", () => {
    it("never carries credential material", async () => {
      const tool = new WhatsAppSendMessageTool(
        new MockWhatsAppProvider(),
        authorizerFor("user-1"),
        PHONE_NUMBER_ID
      );
      const result = await tool.execute({ to: "15550101234", body: "hi" }, ctx("user-1"));
      const blob = JSON.stringify(result);
      for (const forbidden of ["accessToken", "access_token", "appSecret", "app_secret", "verifyToken", "EAA"]) {
        expect(blob).not.toContain(forbidden);
      }
    });
  });
});
