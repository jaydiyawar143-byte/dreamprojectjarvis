import type {
  WhatsAppWebhookEvent,
  WhatsAppInboundMessage,
  WhatsAppStatusUpdate,
  WhatsAppMessageType,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// Webhook payload parsing (Sprint 5.3)
// ---------------------------------------------------------------------------
// Mirrors packages/meta-graph/src/response-validator.ts: the wire format is
// treated as untrusted and normalised once, here, so no route or repository
// has to reason about Meta's deeply nested envelope:
//
//   { entry: [ { changes: [ { value: { messages, statuses, contacts } } ] } ] }
//
// Parsing is deliberately TOTAL — a malformed entry is skipped rather than
// throwing. Meta retries any non-200 response, so throwing on one bad message
// would put the whole batch into a permanent redelivery loop.
// ---------------------------------------------------------------------------

const KNOWN_TYPES: Record<string, WhatsAppMessageType> = {
  text: "TEXT",
  image: "IMAGE",
  audio: "AUDIO",
  video: "VIDEO",
  document: "DOCUMENT",
  location: "LOCATION",
  contacts: "CONTACTS",
  sticker: "STICKER",
  button: "BUTTON",
  interactive: "INTERACTIVE",
};

function toType(raw: unknown): WhatsAppMessageType {
  if (typeof raw !== "string") return "UNSUPPORTED";
  return KNOWN_TYPES[raw] ?? "UNSUPPORTED";
}

/**
 * Cloud API sends timestamps as SECONDS in a string. Treating that value as
 * milliseconds dates every message to 1970 and would silently defeat the
 * freshness window, so the conversion is explicit and validated.
 */
export function parseTimestamp(raw: unknown, fallback: Date = new Date()): Date {
  const seconds = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  return new Date(seconds * 1000);
}

/** Extracts the human-readable body for the types that carry one. */
function extractBody(message: Record<string, any>, type: WhatsAppMessageType): string | null {
  switch (type) {
    case "TEXT":
      return typeof message.text?.body === "string" ? message.text.body : null;
    case "BUTTON":
      return typeof message.button?.text === "string" ? message.button.text : null;
    case "INTERACTIVE": {
      const i = message.interactive ?? {};
      return (
        (typeof i.button_reply?.title === "string" && i.button_reply.title) ||
        (typeof i.list_reply?.title === "string" && i.list_reply.title) ||
        null
      );
    }
    case "IMAGE":
    case "VIDEO":
    case "DOCUMENT":
      // Media captions are the only text these carry.
      return typeof message[type.toLowerCase()]?.caption === "string"
        ? message[type.toLowerCase()].caption
        : null;
    default:
      return null;
  }
}

export function parseWebhookPayload(payload: unknown): WhatsAppWebhookEvent {
  const messages: WhatsAppInboundMessage[] = [];
  const statuses: WhatsAppStatusUpdate[] = [];

  const root = (payload ?? {}) as Record<string, any>;
  // Only the WhatsApp product is handled; other Meta webhook objects are ignored.
  if (root.object !== undefined && root.object !== "whatsapp_business_account") {
    return { messages, statuses };
  }

  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (!value || typeof value !== "object") continue;

      const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
      if (typeof phoneNumberId !== "string" || phoneNumberId.length === 0) continue;

      // contacts[] carries the profile name, keyed by wa_id.
      const names = new Map<string, string>();
      if (Array.isArray(value.contacts)) {
        for (const contact of value.contacts) {
          if (typeof contact?.wa_id === "string" && typeof contact?.profile?.name === "string") {
            names.set(contact.wa_id, contact.profile.name);
          }
        }
      }

      if (Array.isArray(value.messages)) {
        for (const raw of value.messages) {
          const providerMessageId = raw?.id;
          const from = raw?.from;
          // Without an id there is no deduplication key, so the message cannot
          // be processed safely; without a sender it cannot be attributed.
          if (typeof providerMessageId !== "string" || providerMessageId.length === 0) continue;
          if (typeof from !== "string" || from.length === 0) continue;

          const type = toType(raw.type);
          messages.push({
            providerMessageId,
            from,
            phoneNumberId,
            type,
            body: extractBody(raw, type),
            timestamp: parseTimestamp(raw.timestamp),
            contactName: names.get(from) ?? null,
          });
        }
      }

      if (Array.isArray(value.statuses)) {
        for (const raw of value.statuses) {
          if (typeof raw?.id !== "string" || typeof raw?.status !== "string") continue;
          statuses.push({
            providerMessageId: raw.id,
            status: raw.status,
            timestamp: parseTimestamp(raw.timestamp),
            recipientId: typeof raw.recipient_id === "string" ? raw.recipient_id : "",
          });
        }
      }
    }
  }

  return { messages, statuses };
}

/**
 * Freshness check backing replay protection. A valid signature proves the
 * payload came from Meta, not that it is recent — a captured body could
 * otherwise be replayed indefinitely.
 */
export function isFresh(timestamp: Date, maxAgeMs: number, now: Date = new Date()): boolean {
  const age = now.getTime() - timestamp.getTime();
  // Small negative ages are normal clock skew between Meta and this host.
  return age <= maxAgeMs && age >= -60_000;
}
