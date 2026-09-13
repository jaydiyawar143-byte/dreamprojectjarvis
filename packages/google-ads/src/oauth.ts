import { createHash, randomBytes } from "node:crypto";
import {
  GOOGLE_OAUTH_AUTH_HOST,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_OAUTH_REVOKE_URL,
  GOOGLE_USERINFO_URL,
  REQUIRED_SCOPES,
  GOOGLE_ADS_SCOPE,
  ACCOUNT_IDENTITY_SCOPES,
  grantCovers,
  type GoogleConfig,
} from "./config.js";
import { classifyGoogleError, type ClassifiedGoogleError } from "./error-handler.js";

// ---------------------------------------------------------------------------
// Google OAuth 2.0 authorization-code flow with PKCE (Sprint 5.2)
// ---------------------------------------------------------------------------
// Two protections, both required:
//
//   state         — random, single-use, bound to the initiating user. Defends
//                   against CSRF: an attacker cannot make a victim's browser
//                   complete a callback that links the ATTACKER's Google
//                   account to the victim's JARVIS account.
//   PKCE (S256)   — code_verifier never leaves the server; only its SHA-256
//                   hash goes to Google. An intercepted authorization code is
//                   useless without the verifier.
//
// PKCE is used even though this is a confidential client with a secret: it
// costs nothing and removes code interception as a class of attack.
// ---------------------------------------------------------------------------

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** RFC 7636 verifier: 43-128 chars of unreserved characters. */
export function createPkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function createState(): string {
  return randomBytes(32).toString("base64url");
}

export interface AuthUrlInput {
  config: GoogleConfig;
  state: string;
  codeChallenge: string;
  /** Overrides the default read-only scope set. Used by tests only. */
  scopes?: readonly string[];
}

/**
 * Builds the consent URL.
 *
 * access_type=offline + prompt=consent is what makes Google return a refresh
 * token. Without prompt=consent a repeat authorization returns only an access
 * token, and the stored refresh token would silently go stale.
 */
export function buildAuthUrl({ config, state, codeChallenge, scopes }: AuthUrlInput): string {
  const url = new URL(`https://${GOOGLE_OAUTH_AUTH_HOST}/o/oauth2/v2/auth`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (scopes ?? REQUIRED_SCOPES).join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

export class GoogleOAuthError extends Error {
  override readonly name = "GoogleOAuthError";
  readonly classified: ClassifiedGoogleError;

  constructor(classified: ClassifiedGoogleError) {
    super(classified.message);
    this.classified = classified;
  }
}

/** Minimal fetch surface, so tests inject a double instead of hitting Google. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{ status: number; text(): Promise<string> }>;

async function postForm(
  url: string,
  form: Record<string, string>,
  timeoutMs: number,
  fetchImpl: FetchLike
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/**
 * Exchanges an authorization code for tokens.
 *
 * Rejects a grant that did not include a refresh token: without one the
 * connection would work until the first hour elapsed and then break in a way
 * that looks like a bug rather than a missing grant.
 */
export async function exchangeCode(
  config: GoogleConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
): Promise<GoogleTokenSet> {
  const { status, body } = await postForm(
    GOOGLE_OAUTH_TOKEN_URL,
    {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    },
    config.timeoutMs,
    fetchImpl
  );

  if (status < 200 || status >= 300) {
    throw new GoogleOAuthError(classifyGoogleError(status, body));
  }

  const token = body as TokenResponse;
  if (!token.access_token) {
    throw new GoogleOAuthError(
      classifyGoogleError(502, { error: "invalid_response", error_description: "no access token" })
    );
  }
  if (!token.refresh_token) {
    throw new GoogleOAuthError({
      code: "AUTHENTICATION_REQUIRED",
      retryable: false,
      message:
        "Google did not return a refresh token. Re-authorize with prompt=consent and offline access.",
    });
  }

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000),
    scopes: token.scope ? token.scope.split(" ").filter(Boolean) : [],
  };
}

/** Exchanges a refresh token for a fresh access token. */
export async function refreshAccessToken(
  config: GoogleConfig,
  refreshToken: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
): Promise<{ accessToken: string; expiresAt: Date }> {
  const { status, body } = await postForm(
    GOOGLE_OAUTH_TOKEN_URL,
    {
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    },
    config.timeoutMs,
    fetchImpl
  );

  if (status < 200 || status >= 300) {
    throw new GoogleOAuthError(classifyGoogleError(status, body));
  }

  const token = body as TokenResponse;
  if (!token.access_token) {
    throw new GoogleOAuthError(
      classifyGoogleError(502, { error: "invalid_response", error_description: "no access token" })
    );
  }
  return {
    accessToken: token.access_token,
    expiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000),
  };
}

/** Best-effort revocation at Google. Local revocation must not depend on it. */
export async function revokeToken(
  config: GoogleConfig,
  token: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
): Promise<boolean> {
  try {
    const { status } = await postForm(
      GOOGLE_OAUTH_REVOKE_URL,
      { token },
      config.timeoutMs,
      fetchImpl
    );
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

/** Reads the connected account email so the UI can name the connection. */
/**
 * What account identification learned, without carrying the profile around.
 *
 * `email` is returned because the connection row needs it to name the account.
 * `subjectPresent` is a boolean because the OpenID `sub` is only ever needed as
 * evidence that a real identity came back — never as a value to store or log.
 */
export interface UserInfoResult {
  email: string;
  subjectPresent: boolean;
}

export async function fetchUserInfo(
  config: GoogleConfig,
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
): Promise<UserInfoResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(GOOGLE_USERINFO_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GoogleOAuthError(classifyGoogleError(response.status, body));
    }
    const profile = body as { email?: string; sub?: string };
    const email = profile.email;
    if (!email) {
      throw new GoogleOAuthError(
        classifyGoogleError(502, { error: "invalid_response", error_description: "no email" })
      );
    }
    // PRESENCE ONLY for the subject. The OpenID `sub` is a stable per-user
    // identifier and is not stored or logged anywhere — the caller needs to
    // know it arrived, not what it is. `email` is returned because the
    // connection row genuinely needs it to name the account.
    return { email, subjectPresent: typeof profile.sub === "string" && profile.sub.length > 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Verifies Google granted everything the Ads calls need. */
/**
 * The floor for storing ANY Google connection: can we name the account?
 *
 * WHY THIS IS SEPARATE FROM `hasRequiredScopes`. That one requires the ADS
 * scope, which was correct when "Google" meant Google Ads and nothing else.
 * Google is now multi-service, and the shared OAuth callback used the Ads
 * predicate for every connection — so connecting Gmail, Drive and Calendar
 * through the Integration Center produced a grant of
 * `openid email profile gmail.readonly drive.readonly calendar.readonly`,
 * which the callback rejected with "Google did not grant the Google Ads scope
 * required for this integration". A complete, correct Workspace consent was
 * refused for lacking a scope it had never asked for.
 *
 * The failure was worse than a bad message. The callback consumes the
 * single-use state BEFORE this check, so the rejection burned it: the user's
 * next click produced "Invalid or already-used authorization state", which
 * points at replay protection and says nothing about scopes. The real cause was
 * two steps upstream and invisible.
 *
 * Identity is the right floor because it is the one thing every flow requests
 * and the one thing the connection row genuinely cannot do without — it is what
 * names the account for display and revocation. Everything else is gated per
 * service at the point of use (`resolveGoogleAccess`, `hasWriteAccess`,
 * `servicesFromGrantedScopes`), which reads GRANTED scopes and reports
 * `permission_missing` with a remedy. So a Workspace-only connection stored
 * here cannot silently attempt an Ads call; it is refused by the layer that
 * knows what it is refusing.
 */
export function hasIdentityScopes(granted: readonly string[]): boolean {
  // `grantCovers`, not `includes`: Google returns `email` as
  // `https://www.googleapis.com/auth/userinfo.email`, so a literal comparison
  // is false against every real consent.
  return grantCovers(granted, ACCOUNT_IDENTITY_SCOPES);
}

/** Ads-specific: identity PLUS the adwords scope. Used by Ads callers only. */
export function hasRequiredScopes(granted: readonly string[]): boolean {
  // Same canonicalization fix as `hasIdentityScopes`. The old body compared
  // literals and carried a no-op special case for `openid` (which does come
  // back verbatim) while silently failing on `email`, which does not — so the
  // Ads path had this defect too, and would have refused a valid Ads consent.
  return grantCovers(granted, [GOOGLE_ADS_SCOPE, ...ACCOUNT_IDENTITY_SCOPES]);
}
