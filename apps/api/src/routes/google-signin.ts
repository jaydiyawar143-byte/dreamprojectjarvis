// ---------------------------------------------------------------------------
// UI V2 — "Continue with Google" (OpenID Connect, authorization code + PKCE).
//
// This is IDENTITY, and is separate from routes/google-auth.ts, which links an
// already-authenticated JARVIS user to a Google Ads account. The distinction is
// load-bearing: everything here runs for a browser with NO session, so none of
// it can require one.
//
// WHY STATE LIVES IN A COOKIE, NOT THE OAuthState TABLE. That table's `user_id`
// is a NOT NULL foreign key to User — it was built for connecting an account to
// a signed-in user. During sign-in there is no user yet, so there is no row to
// write. A signed, HttpOnly, short-lived cookie carries the CSRF state and the
// PKCE verifier instead, which is a standard construction and needs no schema
// change to a table other flows depend on.
//
// WHY THE ID TOKEN SIGNATURE IS NOT CHECKED AGAINST GOOGLE'S JWKS. The token is
// not accepted from the browser. It is fetched by this server, over TLS, from
// Google's token endpoint, authenticated with the client secret. OpenID Connect
// Core §3.1.3.7 explicitly permits TLS server validation in place of signature
// checking for exactly this case. The claims that carry meaning — iss, aud, exp
// and email_verified — are still validated below, because TLS proves who sent
// the token, not what it says.
//
// The browser never receives a token in a URL. The session is established as
// the same HttpOnly refresh cookie the password flow uses, and the redirect
// carries only a status.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Request, Response } from "express";
import { createHmac, randomBytes, createHash, timingSafeEqual } from "crypto";
import type { AuthManager } from "@jarvis/security";
import type { GoogleSignInConfig } from "@jarvis/config";
import { setRefreshCookie, readCookie } from "../lib/auth-cookies.js";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** Identity only. No Ads, Drive or Gmail scope is requested here. */
const SCOPES = ["openid", "email", "profile"].join(" ");

const STATE_COOKIE = "jarvis_oauth_state";
/** Long enough for a consent screen, short enough to bound a stolen cookie. */
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  /** Random CSRF value echoed by Google in the `state` query parameter. */
  nonce: string;
  /** PKCE code_verifier. Never leaves this server except as its S256 hash. */
  verifier: string;
  /** Milliseconds since epoch after which this state is refused. */
  expiresAt: number;
  /** Where to send the browser afterwards. Same-origin path only. */
  next: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Signs the state payload with the server's JWT secret.
 *
 * The cookie is HttpOnly, so a browser cannot read it — but signing means a
 * tampered cookie is also rejected rather than parsed, which keeps the PKCE
 * verifier honest even if a subdomain could write cookies.
 */
function sealState(payload: StatePayload, secret: string): string {
  const body = base64url(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function openState(sealed: string | null, secret: string): StatePayload | null {
  if (!sealed) return null;
  const dot = sealed.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = sealed.slice(0, dot);
  const presented = sealed.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    if (typeof parsed?.nonce !== "string" || typeof parsed?.verifier !== "string") return null;
    if (typeof parsed.expiresAt !== "number" || Date.now() > parsed.expiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Restricts the post-login destination to a path on our own app.
 *
 * Without this, `?next=https://evil.example` would turn the callback into an
 * open redirect that borrows the trust of a real login.
 */
function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "/dashboard";
  // Must be a single-slash-rooted path: "//host" is protocol-relative and would
  // leave the site.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

/** Decodes a JWT payload WITHOUT verifying — see the file header for why. */
function decodeIdTokenClaims(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function createGoogleSignInRouter(
  authService: AuthManager,
  config: GoogleSignInConfig,
  jwtSecret: string
): Router {
  const router = Router();

  /** Sends the browser back to the app with a machine-readable reason. */
  function fail(res: Response, next: string, reason: string): void {
    const url = new URL(config.webOrigin);
    url.pathname = "/login";
    url.searchParams.set("error", reason);
    if (next !== "/dashboard") url.searchParams.set("next", next);
    res.redirect(302, url.toString());
  }

  // -------------------------------------------------------------------------
  // GET /status — is this channel available?
  //
  // Unauthenticated on purpose: the login screen must ask before anyone has a
  // session. It reveals only that the button will work, never the client id.
  //
  // This route existing at all IS the answer. When the credentials are absent
  // the whole router is unmounted and this 404s, so the web app cannot show a
  // Google button the server could not honour — the single source of truth is
  // the server's own configuration rather than a second flag that can drift.
  // -------------------------------------------------------------------------
  router.get("/status", (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: { enabled: true },
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // GET /start — begin the flow.
  // -------------------------------------------------------------------------
  router.get("/start", (req: Request, res: Response) => {
    const next = safeNext(req.query.next);

    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const sealed = sealState({ nonce, verifier, expiresAt: Date.now() + STATE_TTL_MS, next }, jwtSecret);

    res.cookie(STATE_COOKIE, sealed, {
      httpOnly: true,
      sameSite: "lax", // Must survive Google's top-level redirect back to us.
      secure: config.redirectUri.startsWith("https://"),
      maxAge: STATE_TTL_MS,
      path: "/api/v1/auth/google",
    });

    const authorize = new URL(GOOGLE_AUTH_ENDPOINT);
    authorize.searchParams.set("client_id", config.clientId);
    authorize.searchParams.set("redirect_uri", config.redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", SCOPES);
    authorize.searchParams.set("state", nonce);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    // Ask for an account choice rather than silently reusing one, so a shared
    // machine does not sign the previous person back in.
    authorize.searchParams.set("prompt", "select_account");

    res.redirect(302, authorize.toString());
  });

  // -------------------------------------------------------------------------
  // GET /callback — Google returns here.
  // -------------------------------------------------------------------------
  router.get("/callback", async (req: Request, res: Response) => {
    const sealed = readCookie(req, STATE_COOKIE);
    const state = openState(sealed, jwtSecret);

    // The state cookie is single-use: clear it before any outcome so a replay
    // of this URL cannot re-run the exchange.
    res.clearCookie(STATE_COOKIE, { httpOnly: true, path: "/api/v1/auth/google" });

    const next = state ? safeNext(state.next) : "/dashboard";

    // The user pressed "cancel" on the consent screen. Not an error; they are
    // simply returned to the login page.
    if (typeof req.query.error === "string") {
      fail(res, next, req.query.error === "access_denied" ? "google_cancelled" : "google_failed");
      return;
    }

    if (!state) {
      // Expired, tampered with, or the cookie never arrived.
      fail(res, next, "google_state_invalid");
      return;
    }

    const returnedState = typeof req.query.state === "string" ? req.query.state : "";
    const a = Buffer.from(returnedState);
    const b = Buffer.from(state.nonce);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      fail(res, next, "google_state_invalid");
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) {
      fail(res, next, "google_failed");
      return;
    }

    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: "authorization_code",
          code_verifier: state.verifier,
        }),
      });

      if (!tokenRes.ok) {
        // The body can contain the client secret echoed back in an error
        // description, so it is deliberately not logged or forwarded.
        fail(res, next, "google_failed");
        return;
      }

      const tokens = (await tokenRes.json()) as { id_token?: string };
      if (!tokens.id_token) {
        fail(res, next, "google_failed");
        return;
      }

      const claims = decodeIdTokenClaims(tokens.id_token);
      if (!claims) {
        fail(res, next, "google_failed");
        return;
      }

      // Claim validation. TLS proved Google sent this; these prove what it says
      // is about the right client, is current, and is a confirmed address.
      const iss = typeof claims.iss === "string" ? claims.iss : "";
      const aud = typeof claims.aud === "string" ? claims.aud : "";
      const exp = typeof claims.exp === "number" ? claims.exp : 0;
      const email = typeof claims.email === "string" ? claims.email : "";
      const emailVerified = claims.email_verified === true || claims.email_verified === "true";

      if (!GOOGLE_ISSUERS.has(iss) || aud !== config.clientId || exp * 1000 <= Date.now()) {
        fail(res, next, "google_failed");
        return;
      }

      // An unverified address must never be linked: account linking is by
      // email, so accepting one would let anyone who can name an address claim
      // the JARVIS account that owns it.
      if (!email || !emailVerified) {
        fail(res, next, "google_email_unverified");
        return;
      }

      const name = typeof claims.name === "string" ? claims.name : undefined;

      const result = await authService.loginWithVerifiedIdentity(
        { email, ...(name ? { name } : {}) },
        { userAgent: req.headers["user-agent"], ipAddress: req.ip }
      );

      // Same session mechanism as the password flow: an HttpOnly refresh
      // cookie. No token is ever placed in the redirect URL, where it would
      // land in history and in the Referer header.
      setRefreshCookie(res, result.tokens.refreshToken, { remember: true });

      const done = new URL(config.webOrigin);
      done.pathname = "/auth/google";
      done.searchParams.set("status", result.created ? "created" : "linked");
      done.searchParams.set("next", next);
      res.redirect(302, done.toString());
    } catch {
      fail(res, next, "google_failed");
    }
  });

  return router;
}
