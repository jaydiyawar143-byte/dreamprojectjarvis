import { z } from "zod";

// ---------------------------------------------------------------------------
// OmniRoute configuration
// ---------------------------------------------------------------------------
// OmniRoute is a self-hosted AI gateway: one OpenAI-compatible `/v1` endpoint
// in front of many model providers. JARVIS talks to it with an ENDPOINT key
// created on the gateway's own Endpoints page — never with a provider's key,
// which stays inside the gateway.
//
// Mirrors packages/n8n/src/config.ts. Every value is server-side; nothing here
// is ever sent to a browser.
//
//   baseUrl  The OpenAI-compatible base, e.g. http://localhost:20128/v1. A bare
//            origin is completed with `/v1`, the gateway's only API mount. It
//            is shown on the integration card, so it may not carry a username,
//            a password, a query or a fragment: the card would display them.
//   apiKey   Sent as a Bearer token. Never echoed, logged or displayed.
// ---------------------------------------------------------------------------

/** Ceiling for one request to the gateway. A model list answers in well under this. */
export const OMNIROUTE_DEFAULT_TIMEOUT_MS = 8000;

/** OmniRoute's API mount, appended when the configured URL names only an origin. */
export const OMNIROUTE_API_PATH = "/v1";

const omniRouteConfigSchema = z.object({
  baseUrl: z
    .string()
    .url("OMNIROUTE_BASE_URL must be an absolute URL")
    .superRefine((value, ctx) => {
      // Zod runs this even after `.url()` has failed, so an unparseable value
      // must not reach `new URL` here — that would throw past `safeParse`.
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OMNIROUTE_BASE_URL must use http or https" });
      }
      if (url.username || url.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OMNIROUTE_BASE_URL must not embed credentials; put the key in OMNIROUTE_API_KEY",
        });
      }
      if (url.search || url.hash) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OMNIROUTE_BASE_URL must not carry a query or fragment" });
      }
    })
    .transform(normalizeBaseUrl),
  apiKey: z.string().trim().min(1, "OMNIROUTE_API_KEY is required"),
  timeoutMs: z.coerce.number().int().positive().max(60000).default(OMNIROUTE_DEFAULT_TIMEOUT_MS),
});

export type OmniRouteConfig = z.infer<typeof omniRouteConfigSchema>;

export interface OmniRouteConfigInput {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Trailing slashes removed, and `/v1` added to a bare origin.
 *
 * Only a bare origin is completed. A URL that names a path is taken as the
 * operator wrote it — a gateway behind a reverse proxy may well be mounted at
 * `/ai/v1` — and a wrong path shows up as a 404 from the connection test
 * rather than being silently rewritten into a different one.
 */
function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "" ? OMNIROUTE_API_PATH : path}`;
}

export function createOmniRouteConfig(
  input: OmniRouteConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): OmniRouteConfig {
  const raw = {
    baseUrl: input.baseUrl ?? env.OMNIROUTE_BASE_URL?.trim(),
    apiKey: input.apiKey ?? env.OMNIROUTE_API_KEY,
    timeoutMs: input.timeoutMs,
  };

  const result = omniRouteConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([k, v]) => `${k}: ${v?.join(", ")}`)
      .join("; ");
    // Field NAMES and rules only — the key is a secret, and a URL that failed
    // the credentials rule is one.
    throw new Error(`OmniRoute configuration error: ${messages}`);
  }
  return result.data;
}

/** Whether both variables are present. Says nothing about whether they are usable. */
export function isOmniRouteConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OMNIROUTE_BASE_URL?.trim() && env.OMNIROUTE_API_KEY?.trim());
}
