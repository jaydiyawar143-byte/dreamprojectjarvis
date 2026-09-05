import type { PrismaClient } from "@prisma/client";
import type {
  IWhatsAppRepository,
  WhatsAppInboundMessage,
  WhatsAppMessageRecord,
  WhatsAppStatusUpdate,
  RecordInboundResult,
  WhatsAppDirection,
  WhatsAppMessageType,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// PrismaWhatsAppRepository (Sprint 5.3)
// ---------------------------------------------------------------------------
// Two invariants live here:
//
//  1. TENANT ISOLATION. The webhook is unauthenticated, so ownership cannot
//     come from a session. findUserForPhoneNumber resolves it from the
//     WhatsAppAccount claim table; an unclaimed number yields null and the
//     route drops the event rather than attributing it to a guessed user.
//     Every read is filtered by userId, so a valid id belonging to another
//     tenant simply is not found.
//
//  2. DEDUPLICATION IS THE DATABASE'S JOB. recordInbound relies on the unique
//     constraint on provider_message_id rather than a read-then-write check,
//     which would race under Meta's concurrent redelivery.
// ---------------------------------------------------------------------------

/** Prisma unique-constraint violation. */
const UNIQUE_VIOLATION = "P2025";
const UNIQUE_CONSTRAINT = "P2002";

function toRecord(row: {
  id: string;
  userId: string;
  providerMessageId: string;
  waId: string;
  phoneNumberId: string;
  direction: string;
  type: string;
  body: string | null;
  status: string | null;
  providerTimestamp: Date;
  createdAt: Date;
}): WhatsAppMessageRecord {
  return {
    id: row.id,
    userId: row.userId,
    providerMessageId: row.providerMessageId,
    waId: row.waId,
    phoneNumberId: row.phoneNumberId,
    direction: row.direction as WhatsAppDirection,
    type: row.type as WhatsAppMessageType,
    body: row.body,
    status: row.status,
    providerTimestamp: row.providerTimestamp,
    createdAt: row.createdAt,
  };
}

export class PrismaWhatsAppRepository implements IWhatsAppRepository {
  constructor(private prisma: PrismaClient) {}

  async findUserForPhoneNumber(phoneNumberId: string): Promise<string | null> {
    const account = await this.prisma.whatsAppAccount.findUnique({
      where: { phoneNumberId },
    });
    if (!account || !account.isActive) return null;
    return account.userId;
  }

  async recordInbound(input: {
    userId: string;
    message: WhatsAppInboundMessage;
  }): Promise<RecordInboundResult> {
    const { userId, message } = input;
    try {
      const row = await this.prisma.whatsAppMessage.create({
        data: {
          userId,
          providerMessageId: message.providerMessageId,
          waId: message.from,
          phoneNumberId: message.phoneNumberId,
          direction: "INBOUND",
          type: message.type,
          body: message.body,
          providerTimestamp: message.timestamp,
        },
      });
      return { recorded: true, duplicate: false, messageId: row.id };
    } catch (err) {
      // A redelivered webhook is the EXPECTED path here, not an error: Meta
      // retries until it sees a 200. Report it so the caller can skip
      // downstream side effects and still answer 200.
      if ((err as { code?: string }).code === UNIQUE_CONSTRAINT) {
        return { recorded: false, duplicate: true, messageId: null };
      }
      throw err;
    }
  }

  async recordOutbound(input: {
    userId: string;
    providerMessageId: string;
    waId: string;
    phoneNumberId: string;
    body: string;
  }): Promise<WhatsAppMessageRecord> {
    const row = await this.prisma.whatsAppMessage.create({
      data: {
        userId: input.userId,
        providerMessageId: input.providerMessageId,
        waId: input.waId,
        phoneNumberId: input.phoneNumberId,
        direction: "OUTBOUND",
        type: "TEXT",
        body: input.body,
        status: "sent",
        providerTimestamp: new Date(),
      },
    });
    return toRecord(row);
  }

  async applyStatus(update: WhatsAppStatusUpdate): Promise<boolean> {
    try {
      await this.prisma.whatsAppMessage.update({
        where: { providerMessageId: update.providerMessageId },
        data: { status: update.status },
      });
      return true;
    } catch (err) {
      // A status for a message this instance never sent (or has pruned) is not
      // an error worth failing the webhook over.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) return false;
      throw err;
    }
  }

  async listForUser(
    userId: string,
    options?: { waId?: string; limit?: number }
  ): Promise<WhatsAppMessageRecord[]> {
    const rows = await this.prisma.whatsAppMessage.findMany({
      // userId is always part of the filter — never optional, never overridable.
      where: { userId, ...(options?.waId ? { waId: options.waId } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(options?.limit ?? 50, 1), 200),
    });
    return rows.map(toRecord);
  }
}
