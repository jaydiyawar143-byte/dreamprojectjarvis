import { z } from "zod";

// ---------------------------------------------------------------------------
// WhatsApp Business Cloud API configuration (Sprint 5.3)
// ---------------------------------------------------------------------------
// Mirrors packages/meta-graph/src/config.ts and packages/google-ads/src/config.ts.
// Every value comes from the server environment, never from a request.
//
// Four secrets, with genuinely different jobs — conflating them is a common and
// dangerous mistake:
//
//   accessToken  — authenticates US to Meta on outbound sends.
//   appSecret    — verifies META to US: the HMAC key for X-Hub-Signature-256.
//   verifyToken  — a shared string echoed once during webhook registration.
//   phoneNumberId — which business number we send from.
//
// The verify token is NOT a signature key: it appears in a query string during
// setup and proves nothing about later requests. Only appSecret authenticates
// webhook payloads.
// ---------------------------------------------------------------------------

export const WHATSAPP_API_HOST = "graph.facebook.com";
export const WHATSAPP_DEFAULT_API_VERSION = "v21.0";

/** Cloud API rejects longer text bodies; fail locally rather than round-trip. */
export const WHATSAPP_MAX_TEXT_LENGTH = 4096;

const whatsappConfigSchema = z.object({
  phoneNumberId: z.string().min(1, "WHATSAPP_PHONE_NUMBER_ID is required"),
  accessToken: z.string().min(1, "WHATSAPP_ACCESS_TOKEN is required"),
  appSecret: z.string().min(1, "WHATSAPP_APP_SECRET is required"),
  verifyToken: z.string().min(1, "WHATSAPP_VERIFY_TOKEN is required"),
  apiVersion: z.string().min(1).default(WHATSAPP_DEFAULT_API_VERSION),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.coerce.number().positive().default(30000),
  /**
   * Webhooks older than this are rejected even when the signature is valid.
   * A signature proves authenticity, not freshness — without a window, a
   * captured payload stays replayable forever.
   */
  maxEventAgeMs: z.coerce.number().positive().default(5 * 60 * 1000),
});

export type WhatsAppConfig = z.infer<typeof whatsappConfigSchema>;

export interface WhatsAppConfigInput {
  phoneNumberId?: string;
  accessToken?: string;
  appSecret?: string;
  verifyToken?: string;
  apiVersion?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxEventAgeMs?: number;
}

export function createWhatsAppConfig(input: WhatsAppConfigInput = {}): WhatsAppConfig {
  const raw = {
    phoneNumberId: input.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: input.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN,
    appSecret: input.appSecret ?? process.env.WHATSAPP_APP_SECRET,
    verifyToken: input.verifyToken ?? process.env.WHATSAPP_VERIFY_TOKEN,
    apiVersion: input.apiVersion ?? process.env.WHATSAPP_API_VERSION,
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    maxEventAgeMs: input.maxEventAgeMs,
  };

  const result = whatsappConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([k, v]) => `${k}: ${v?.join(", ")}`)
      .join("; ");
    // Field NAMES only. The values are secrets and must not reach a log.
    throw new Error(`WhatsApp configuration error: ${messages}`);
  }
  return result.data;
}

/** True when the environment carries every secret the integration needs. */
export function isWhatsAppConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.WHATSAPP_PHONE_NUMBER_ID &&
      env.WHATSAPP_ACCESS_TOKEN &&
      env.WHATSAPP_APP_SECRET &&
      env.WHATSAPP_VERIFY_TOKEN
  );
}

/**
 * Normalises a recipient to Cloud API form: digits only, no "+", no separators.
 * Returns null rather than throwing so callers can report a validation failure.
 */
export function normalizePhoneNumber(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.trim().replace(/^\+/, "").replace(/[\s\-().]/g, "");
  // E.164 allows up to 15 digits; a country code makes 8 a sane lower bound.
  if (!/^\d{8,15}$/.test(digits)) return null;
  return digits;
}

export function buildBaseUrl(config: WhatsAppConfig): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return `https://${WHATSAPP_API_HOST}/${config.apiVersion}`;
}
