// ---------------------------------------------------------------------------
// UI V2 — refresh token transport for browser sessions.
//
// The refresh token is a 7-day bearer credential. Handing it to page JavaScript
// means any XSS on the app reads it and holds a week of access; an HttpOnly
// cookie is unreadable from script, so the same XSS can act only while the tab
// is open and only through the API.
//
// This is ADDITIVE. Programmatic clients (the skill driver, the API tests) keep
// posting `refreshToken` in the body and keep receiving it in the response.
// Only a caller that explicitly opts in — a browser sending X-Auth-Mode: cookie
// — gets the cookie treatment, and for that caller the token is omitted from
// the response body entirely. Two transports, one token model.
//
// WHY THE COOKIE NAME IS CONFIGURABLE. Cookies are scoped by host and ignore
// the port, so http://localhost:3001 (local stack) and http://localhost:3101
// (docker stack) would otherwise overwrite each other's session — logging into
// one would silently invalidate the other, since the two run separate
// databases. AUTH_COOKIE_NAME gives each deployment its own jar.
// ---------------------------------------------------------------------------

import type { Request, Response } from "express";

/** Opt-in header. Its presence is what selects cookie transport. */
export const AUTH_MODE_HEADER = "x-auth-mode";
export const COOKIE_AUTH_MODE = "cookie";

/** Mirrors REFRESH_TOKEN_EXPIRY_DAYS in @jarvis/security's TokenService. */
const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function refreshCookieName(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTH_COOKIE_NAME || "jarvis_rt";
}

/** True when the caller asked to be treated as a browser session. */
export function wantsCookieAuth(req: Request): boolean {
  const header = req.headers[AUTH_MODE_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value.toLowerCase() === COOKIE_AUTH_MODE;
}

// A single-cookie parser, so the API gains no new dependency for one header.
// Values are percent-encoded by the browser; only our own cookie is read.
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return null;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed value is treated as absent rather than throwing: a bad
      // cookie must fail closed into "not authenticated", not into a 500.
      return null;
    }
  }
  return null;
}

/**
 * Whether to mark the cookie Secure.
 *
 * A Secure cookie is dropped outright by the browser over plain http, which
 * would make the production image unusable when it is deliberately run locally
 * — the case JARVIS_ALLOW_LOCAL_ORIGIN already exists to describe.
 */
function useSecure(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV !== "production") return false;
  return env.JARVIS_ALLOW_LOCAL_ORIGIN !== "true";
}

/**
 * Stores the refresh token.
 *
 * `remember` false issues a SESSION cookie (no Max-Age), which the browser
 * drops when it closes — the honest reading of an unticked "remember me".
 * `remember` true pins it to the token's own 7-day lifetime; outliving the
 * token it carries would only produce a confusing failed refresh.
 *
 * SameSite=Lax is sufficient here: ports are not part of a "site", so the web
 * origin and the API are same-site in every supported layout. It still refuses
 * the cookie to a genuinely cross-site attacker page.
 */
export function setRefreshCookie(
  res: Response,
  token: string,
  opts: { remember: boolean; env?: NodeJS.ProcessEnv } = { remember: true }
): void {
  const env = opts.env ?? process.env;
  res.cookie(refreshCookieName(env), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecure(env),
    path: "/api/v1/auth",
    ...(opts.remember ? { maxAge: REFRESH_TOKEN_MAX_AGE_MS } : {}),
  });
}

/**
 * Removes the refresh cookie.
 *
 * The attributes must match those used to set it or the browser keeps the
 * original and logout silently does nothing.
 */
export function clearRefreshCookie(res: Response, env: NodeJS.ProcessEnv = process.env): void {
  res.clearCookie(refreshCookieName(env), {
    httpOnly: true,
    sameSite: "lax",
    secure: useSecure(env),
    path: "/api/v1/auth",
  });
}

/**
 * The refresh token for this request, cookie first.
 *
 * Cookie precedence matters: a browser that has opted into cookie transport
 * has no token in its body, and a stale body value must never win over the
 * live cookie.
 */
export function readRefreshToken(req: Request, bodyToken?: unknown): string | null {
  const cookie = readCookie(req, refreshCookieName());
  if (cookie) return cookie;
  return typeof bodyToken === "string" && bodyToken.length > 0 ? bodyToken : null;
}
