import { z } from "zod";

// ---------------------------------------------------------------------------
// n8n configuration (Sprint 5.4)
// ---------------------------------------------------------------------------
// Mirrors packages/whatsapp/src/config.ts and packages/google-ads/src/config.ts.
// Every value is server-side; nothing here is ever sent to a browser.
//
// TWO SECRETS, OPPOSITE DIRECTIONS — conflating them would let anyone who can
// read one direction forge the other:
//
//   apiKey         JARVIS -> n8n. Sent as X-N8N-API-KEY on the trigger request,
//                  proving to n8n that the caller is us.
//   callbackSecret n8n -> JARVIS. The HMAC key n8n uses to sign result
//                  callbacks, proving to us that the caller is n8n.
//
// The API key must NEVER be accepted as a callback credential: n8n workflows
// are frequently shared and their nodes can leak an outbound key.
// ---------------------------------------------------------------------------

/** Truncation ceiling for anything n8n returns that we persist. */
export const N8N_MAX_SUMMARY_LENGTH = 2000;

/** Callbacks older than this are rejected even when correctly signed. */
export const N8N_DEFAULT_CALLBACK_MAX_AGE_MS = 5 * 60 * 1000;

const n8nConfigSchema = z.object({
  baseUrl: z.string().url("N8N_BASE_URL must be an absolute URL"),
  apiKey: z.string().min(1, "N8N_API_KEY is required"),
  callbackSecret: z.string().min(1, "N8N_CALLBACK_SECRET is required"),
  /**
   * A workflow can legitimately run for a while, but the TRIGGER request must
   * return quickly — results arrive via callback, not by holding the socket.
   */
  timeoutMs: z.coerce.number().positive().max(120000).default(15000),
  callbackMaxAgeMs: z.coerce.number().positive().default(N8N_DEFAULT_CALLBACK_MAX_AGE_MS),
});

export type N8nConfig = z.infer<typeof n8nConfigSchema>;

export interface N8nConfigInput {
  baseUrl?: string;
  apiKey?: string;
  callbackSecret?: string;
  timeoutMs?: number;
  callbackMaxAgeMs?: number;
}

export function createN8nConfig(input: N8nConfigInput = {}): N8nConfig {
  const raw = {
    baseUrl: input.baseUrl ?? process.env.N8N_BASE_URL,
    apiKey: input.apiKey ?? process.env.N8N_API_KEY,
    callbackSecret: input.callbackSecret ?? process.env.N8N_CALLBACK_SECRET,
    timeoutMs: input.timeoutMs ?? process.env.N8N_TIMEOUT_MS,
    callbackMaxAgeMs: input.callbackMaxAgeMs,
  };

  const result = n8nConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([k, v]) => `${k}: ${v?.join(", ")}`)
      .join("; ");
    // Field NAMES only — the values are secrets.
    throw new Error(`n8n configuration error: ${messages}`);
  }
  return result.data;
}

export function isN8nConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.N8N_BASE_URL && env.N8N_API_KEY && env.N8N_CALLBACK_SECRET);
}

/**
 * Validates an n8n webhook path segment.
 *
 * This is a security control, not tidiness. A self-hosted n8n usually sits
 * inside the same network as JARVIS, so a path that can escape the configured
 * base URL turns the trigger into an SSRF primitive. Only a conservative
 * character set is allowed, and traversal, schemes and authority markers are
 * rejected outright.
 */
export function validateWebhookPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;

  // These checks run on the RAW value, BEFORE any normalisation. Stripping
  // leading slashes first would turn "//evil.test/x" into "evil.test/x" and
  // let an authority marker through — the containment must not depend on the
  // order of two rewrites.
  if (trimmed.includes("..")) return null;
  if (trimmed.includes("//")) return null; // "//host" is a protocol-relative authority
  if (trimmed.includes(":")) return null; // "scheme:" would re-target the request

  const normalized = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized.length === 0) return null;
  if (!/^[A-Za-z0-9._~\-/]+$/.test(normalized)) return null;
  return normalized;
}

/**
 * Builds the trigger URL from server config plus a validated path.
 *
 * Constructed via the URL API and then re-checked against the base origin, so
 * even a path that slipped through validation cannot leave the configured host.
 */
export function buildWebhookUrl(config: N8nConfig, webhookPath: string): string {
  const path = validateWebhookPath(webhookPath);
  if (!path) throw new Error("Invalid n8n webhook path");

  const base = config.baseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/webhook/${path}`);
  const baseOrigin = new URL(base).origin;
  if (url.origin !== baseOrigin) {
    throw new Error("Resolved n8n URL escaped the configured base URL");
  }
  return url.toString();
}

/** Bounds anything n8n returns before it reaches the database or a log. */
export function truncateSummary(
  value: unknown,
  max = N8N_MAX_SUMMARY_LENGTH
): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string" || text.length === 0) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}
