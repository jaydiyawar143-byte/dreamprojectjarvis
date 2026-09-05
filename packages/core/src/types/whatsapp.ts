// ---------------------------------------------------------------------------
// WhatsApp Business Cloud API domain types (Sprint 5.3)
// ---------------------------------------------------------------------------
// Provider is Meta's WhatsApp Business Cloud API — the platform the existing
// config already implies (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN are
// Cloud API concepts, and the pre-existing stub named the WhatsApp Business
// API). It shares a host with the Meta Graph API but is a SEPARATE integration:
// nothing here touches @jarvis/meta-graph or the Meta Ads tools.
// ---------------------------------------------------------------------------

/** Message direction relative to JARVIS. */
export type WhatsAppDirection = "INBOUND" | "OUTBOUND";

/**
 * Message kinds Sprint 5.3 handles. Anything else arrives as UNSUPPORTED and is
 * recorded rather than dropped, so an unhandled type is visible instead of
 * silently lost.
 */
export type WhatsAppMessageType =
  | "TEXT"
  | "IMAGE"
  | "AUDIO"
  | "VIDEO"
  | "DOCUMENT"
  | "LOCATION"
  | "CONTACTS"
  | "STICKER"
  | "BUTTON"
  | "INTERACTIVE"
  | "UNSUPPORTED";

export interface WhatsAppInboundMessage {
  /** Provider message id (wamid.*). The deduplication key. */
  providerMessageId: string;
  /** Sender phone number in E.164 without "+", as Meta reports it. */
  from: string;
  /** Business phone number id that received the message. */
  phoneNumberId: string;
  type: WhatsAppMessageType;
  /** Text body when the type carries one; null for media-only messages. */
  body: string | null;
  /** Provider-reported send time. */
  timestamp: Date;
  /** Profile name, when the sender shares it. */
  contactName: string | null;
}

/** A delivery-status callback (sent/delivered/read/failed) for an outbound message. */
export interface WhatsAppStatusUpdate {
  providerMessageId: string;
  status: string;
  timestamp: Date;
  recipientId: string;
}

export interface WhatsAppWebhookEvent {
  messages: WhatsAppInboundMessage[];
  statuses: WhatsAppStatusUpdate[];
}

export interface WhatsAppSendResult {
  providerMessageId: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface WhatsAppMessageRecord {
  id: string;
  userId: string;
  providerMessageId: string;
  waId: string;
  phoneNumberId: string;
  direction: WhatsAppDirection;
  type: WhatsAppMessageType;
  body: string | null;
  status: string | null;
  providerTimestamp: Date;
  createdAt: Date;
}

/**
 * Result of recording an inbound message.
 *
 * `duplicate` is the replay guard: the unique constraint on providerMessageId
 * makes a redelivered webhook a no-op rather than a second conversation turn.
 * Meta retries aggressively, so this is a normal path, not an error path.
 */
export interface RecordInboundResult {
  recorded: boolean;
  duplicate: boolean;
  messageId: string | null;
}

export interface IWhatsAppRepository {
  /**
   * Resolves which JARVIS user owns a business phone number. Returns null when
   * the number is not claimed, so an unrelated webhook cannot write rows
   * attributed to an arbitrary user.
   */
  findUserForPhoneNumber(phoneNumberId: string): Promise<string | null>;

  /** Idempotent. A repeated providerMessageId reports duplicate: true. */
  recordInbound(input: {
    userId: string;
    message: WhatsAppInboundMessage;
  }): Promise<RecordInboundResult>;

  /** Records an outbound send after the provider accepted it. */
  recordOutbound(input: {
    userId: string;
    providerMessageId: string;
    waId: string;
    phoneNumberId: string;
    body: string;
  }): Promise<WhatsAppMessageRecord>;

  /** Applies a delivery-status callback to an existing outbound row. */
  applyStatus(update: WhatsAppStatusUpdate): Promise<boolean>;

  /** Tenant-scoped history. Never returns another user's messages. */
  listForUser(
    userId: string,
    options?: { waId?: string; limit?: number }
  ): Promise<WhatsAppMessageRecord[]>;
}
