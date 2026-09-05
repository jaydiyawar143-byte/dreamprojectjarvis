import { z } from "zod";

// ---------------------------------------------------------------------------
// Google Ads / OAuth configuration (Sprint 5.2)
// ---------------------------------------------------------------------------
// Mirrors packages/meta-graph/src/config.ts. Values come from the server
// environment only — never from a request — so a caller cannot redirect the
// OAuth code or point the client at a different host.
// ---------------------------------------------------------------------------

export const GOOGLE_OAUTH_AUTH_HOST = "accounts.google.com";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_ADS_API_HOST = "googleads.googleapis.com";
export const GOOGLE_ADS_DEFAULT_API_VERSION = "v18";

// ---------------------------------------------------------------------------
// Scopes — Sprint 5.2 is READ-ONLY.
// ---------------------------------------------------------------------------
// `adwords` is the only Google Ads scope Google publishes; it is not separable
// into read and write. Read-only behaviour is therefore enforced on OUR side:
// the provider exposes no mutating method and every tool is RiskLevel
// READ_ONLY. openid/email identify which Google account was connected so the
// connection can be shown and revoked; they grant no data access.
// ---------------------------------------------------------------------------

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"] as const;
export const REQUIRED_SCOPES: readonly string[] = [GOOGLE_ADS_SCOPE, ...GOOGLE_IDENTITY_SCOPES];

const googleConfigSchema = z.object({
  clientId: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  clientSecret: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  redirectUri: z.string().url("GOOGLE_REDIRECT_URI must be an absolute URL"),
  developerToken: z.string().min(1, "GOOGLE_ADS_DEVELOPER_TOKEN is required"),
  loginCustomerId: z.string().regex(/^\d{10}$/).optional(),
  apiVersion: z.string().min(1).default(GOOGLE_ADS_DEFAULT_API_VERSION),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.coerce.number().positive().default(30000),
});

export type GoogleConfig = z.infer<typeof googleConfigSchema>;

export interface GoogleConfigInput {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  developerToken?: string;
  loginCustomerId?: string;
  apiVersion?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createGoogleConfig(input: GoogleConfigInput = {}): GoogleConfig {
  const raw = {
    clientId: input.clientId ?? process.env.GOOGLE_CLIENT_ID,
    clientSecret: input.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: input.redirectUri ?? process.env.GOOGLE_REDIRECT_URI,
    developerToken: input.developerToken ?? process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    loginCustomerId: input.loginCustomerId ?? process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    apiVersion: input.apiVersion,
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
  };

  const result = googleConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([k, v]) => `${k}: ${v?.join(", ")}`)
      .join("; ");
    // Field NAMES only — never the values, which are secrets.
    throw new Error(`Google configuration error: ${messages}`);
  }
  return result.data;
}

/** True when the environment carries enough config to attempt a connection. */
export function isGoogleConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.GOOGLE_REDIRECT_URI &&
      env.GOOGLE_ADS_DEVELOPER_TOKEN
  );
}

/** Strips dashes and validates the 10-digit Google Ads customer id. */
export function normalizeCustomerId(customerId: string): string {
  const stripped = customerId.trim().replace(/-/g, "");
  if (!/^\d{10}$/.test(stripped)) {
    throw new Error(
      `Invalid Google Ads customer ID format: expected 10 digits, optionally dashed`
    );
  }
  return stripped;
}

export function buildAdsBaseUrl(config: GoogleConfig): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return `https://${GOOGLE_ADS_API_HOST}/${config.apiVersion}`;
}
