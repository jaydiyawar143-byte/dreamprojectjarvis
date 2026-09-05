import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { WhatsAppInboundMessage } from "@jarvis/core";
import { PrismaWhatsAppRepository } from "../src/repositories/whatsapp-repository.js";

// ---------------------------------------------------------------------------
// Sprint 5.3 — WhatsApp persistence against real PostgreSQL.
//
// The point of running this against a real database rather than a fake: the
// deduplication guarantee IS a unique constraint, so it can only be proven by
// the database rejecting the second insert.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

let userA: string | null = null;
let userB: string | null = null;
const PHONE_A = `wa-phone-a-${Date.now()}`;
const PHONE_B = `wa-phone-b-${Date.now()}`;

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `sprint53-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@jarvis-test.local`,
      name: `Sprint 5.3 ${label}`,
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  return user.id;
}

beforeAll(async () => {
  if (!dbUp) return;
  userA = await makeUser("a");
  userB = await makeUser("b");
  await prisma.whatsAppAccount.create({
    data: { userId: userA, phoneNumberId: PHONE_A, displayName: "A" },
  });
  await prisma.whatsAppAccount.create({
    data: { userId: userB, phoneNumberId: PHONE_B, displayName: "B" },
  });
});

afterAll(async () => {
  // FK cascade removes WhatsAppAccount and WhatsAppMessage rows with the user.
  for (const id of [userA, userB]) {
    if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

const inbound = (overrides: Partial<WhatsAppInboundMessage> = {}): WhatsAppInboundMessage => ({
  providerMessageId: `wamid.${Math.random().toString(36).slice(2)}`,
  from: "15550101234",
  phoneNumberId: PHONE_A,
  type: "TEXT",
  body: "Hello",
  timestamp: new Date(),
  contactName: "Alice",
  ...overrides,
});

describe.skipIf(!dbUp)("Sprint 5.3 — PrismaWhatsAppRepository", () => {
  const repo = () => new PrismaWhatsAppRepository(prisma);

  beforeEach(async () => {
    await prisma.whatsAppMessage.deleteMany({ where: { userId: { in: [userA!, userB!] } } });
  });

  describe("tenant resolution", () => {
    it("resolves a claimed phone number to its owner", async () => {
      expect(await repo().findUserForPhoneNumber(PHONE_A)).toBe(userA);
      expect(await repo().findUserForPhoneNumber(PHONE_B)).toBe(userB);
    });

    it("returns null for an unclaimed number", async () => {
      expect(await repo().findUserForPhoneNumber("never-claimed-999")).toBeNull();
    });

    it("returns null for a deactivated account", async () => {
      await prisma.whatsAppAccount.update({
        where: { phoneNumberId: PHONE_B },
        data: { isActive: false },
      });
      expect(await repo().findUserForPhoneNumber(PHONE_B)).toBeNull();
      await prisma.whatsAppAccount.update({
        where: { phoneNumberId: PHONE_B },
        data: { isActive: true },
      });
    });
  });

  describe("inbound deduplication", () => {
    it("records a new message", async () => {
      const result = await repo().recordInbound({ userId: userA!, message: inbound() });
      expect(result).toMatchObject({ recorded: true, duplicate: false });
      expect(result.messageId).not.toBeNull();
    });

    it("reports a redelivered message as a duplicate, not an error", async () => {
      const message = inbound();
      const first = await repo().recordInbound({ userId: userA!, message });
      const second = await repo().recordInbound({ userId: userA!, message });

      expect(first.recorded).toBe(true);
      expect(second).toMatchObject({ recorded: false, duplicate: true, messageId: null });

      const rows = await prisma.whatsAppMessage.findMany({
        where: { providerMessageId: message.providerMessageId },
      });
      expect(rows).toHaveLength(1);
    });

    it("suppresses duplicates under CONCURRENT delivery", async () => {
      // Meta can redeliver in parallel. A read-then-write check would race here;
      // the unique constraint is what makes this safe.
      const message = inbound();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => repo().recordInbound({ userId: userA!, message }))
      );

      expect(results.filter((r) => r.recorded)).toHaveLength(1);
      expect(results.filter((r) => r.duplicate)).toHaveLength(4);

      const rows = await prisma.whatsAppMessage.findMany({
        where: { providerMessageId: message.providerMessageId },
      });
      expect(rows).toHaveLength(1);
    });

    it("deduplicates globally, so one wamid cannot be claimed by two tenants", async () => {
      const message = inbound();
      const first = await repo().recordInbound({ userId: userA!, message });
      const second = await repo().recordInbound({ userId: userB!, message });

      expect(first.recorded).toBe(true);
      expect(second.duplicate).toBe(true);
    });

    it("persists the message shape faithfully", async () => {
      const message = inbound({ type: "IMAGE", body: "a caption" });
      await repo().recordInbound({ userId: userA!, message });

      const row = await prisma.whatsAppMessage.findUniqueOrThrow({
        where: { providerMessageId: message.providerMessageId },
      });
      expect(row).toMatchObject({
        userId: userA,
        direction: "INBOUND",
        type: "IMAGE",
        body: "a caption",
        waId: "15550101234",
      });
    });
  });

  describe("outbound and status", () => {
    it("records an outbound message as sent", async () => {
      const record = await repo().recordOutbound({
        userId: userA!,
        providerMessageId: "wamid.OUT-A",
        waId: "15550101234",
        phoneNumberId: PHONE_A,
        body: "Hi there",
      });
      expect(record).toMatchObject({ direction: "OUTBOUND", status: "sent", body: "Hi there" });
    });

    it("applies a delivery status", async () => {
      await repo().recordOutbound({
        userId: userA!,
        providerMessageId: "wamid.OUT-B",
        waId: "15550101234",
        phoneNumberId: PHONE_A,
        body: "Hi",
      });
      expect(
        await repo().applyStatus({
          providerMessageId: "wamid.OUT-B",
          status: "delivered",
          timestamp: new Date(),
          recipientId: "15550101234",
        })
      ).toBe(true);

      const row = await prisma.whatsAppMessage.findUniqueOrThrow({
        where: { providerMessageId: "wamid.OUT-B" },
      });
      expect(row.status).toBe("delivered");
    });

    it("reports false for a status on an unknown message rather than throwing", async () => {
      expect(
        await repo().applyStatus({
          providerMessageId: "wamid.NEVER-SENT",
          status: "read",
          timestamp: new Date(),
          recipientId: "1",
        })
      ).toBe(false);
    });
  });

  describe("tenant isolation on read", () => {
    beforeEach(async () => {
      await repo().recordInbound({ userId: userA!, message: inbound({ body: "for A" }) });
      await repo().recordInbound({
        userId: userB!,
        message: inbound({ phoneNumberId: PHONE_B, from: "15559990000", body: "for B" }),
      });
    });

    it("returns only the caller's messages", async () => {
      const forA = await repo().listForUser(userA!);
      expect(forA).toHaveLength(1);
      expect(forA[0].body).toBe("for A");

      const forB = await repo().listForUser(userB!);
      expect(forB).toHaveLength(1);
      expect(forB[0].body).toBe("for B");
    });

    it("filters by conversation without crossing tenants", async () => {
      // user-B's waId, requested by user-A, must yield nothing.
      expect(await repo().listForUser(userA!, { waId: "15559990000" })).toHaveLength(0);
    });

    it("clamps the limit to a sane range", async () => {
      expect(await repo().listForUser(userA!, { limit: 100000 })).toHaveLength(1);
      expect(await repo().listForUser(userA!, { limit: -5 })).toHaveLength(1);
    });
  });
});
