// ---------------------------------------------------------------------------
// Sprint 5.2 — Google OAuth connection API
//
//   GET    /api/v1/google/status       is Google configured / connected?
//   POST   /api/v1/google/connect      begin consent, returns the Google URL
//   GET    /api/v1/google/callback     consent redirect target
//   POST   /api/v1/google/disconnect   revoke at Google and locally
//
// Security:
//  - Every route except the callback requires a bearer token and is scoped to
//    req.auth.userId. A user can only ever act on their OWN connection; no
//    route accepts a userId parameter.
//  - The callback is reached by a browser redirect and therefore cannot carry
//    the bearer token. It is authenticated by the single-use `state` row
//    instead, which was created against the initiating user and is consumed
//    atomically — a replayed code finds no state and is rejected.
//  - The redirect URI is read from server configuration, never from the
//    request, so a caller cannot point the authorization code at another host.
//  - Responses carry booleans, the connected account email, and granted scope
//    names. No access token, refresh token, client secret, developer token or
//    authorization code is ever serialised to the client.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import type { IGoogleConnectionRepository, IOAuthStateRepository } from "@jarvis/core";
import {
  createGoogleConfig,
  isGoogleConfigured,
  createPkcePair,
  createState,
  buildAuthUrl,
  exchangeCode,
  revokeToken,
  fetchUserInfo,
  hasRequiredScopes,
  GoogleOAuthError,
  type GoogleConfig,
} from "@jarvis/google-ads";

/** Consent must be completed promptly; a stale state is not honoured. */
const STATE_TTL_MS = 10 * 60 * 1000;

export interface GoogleAuthDeps {
  connections: IGoogleConnectionRepository;
  oauthStates: IOAuthStateRepository;
  /** Injected in tests. Absent means "read from the environment". */
  config?: GoogleConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    success: false,
    error: { code, message },
    timestamp: new Date().toISOString(),
  });
}

export function createGoogleAuthRouter(container: Container, deps: GoogleAuthDeps): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const now = deps.now ?? (() => new Date());

  /** Resolves config lazily so an unconfigured deployment still serves /status. */
  const resolveConfig = (): GoogleConfig | null => {
    if (deps.config) return deps.config;
    if (!isGoogleConfigured()) return null;
    try {
      return createGoogleConfig();
    } catch {
      return null;
    }
  };

  // -------------------------------------------------------------------------
  // GET /status
  // -------------------------------------------------------------------------
  router.get("/status", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const configured = resolveConfig() !== null;
    const connection = await deps.connections.findByUser(req.auth.userId);

    // Booleans and non-secret identifiers only.
    ok(res, {
      configured,
      connected: connection !== null,
      account: connection
        ? {
            email: connection.googleAccountEmail,
            scopes: connection.scopes,
            connectedAt: connection.connectedAt.toISOString(),
            expiresAt: connection.expiresAt.toISOString(),
          }
        : null,
    });
  });

  // -------------------------------------------------------------------------
  // POST /connect
  // -------------------------------------------------------------------------
  router.post("/connect", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const config = resolveConfig();
    if (!config) {
      return fail(
        res,
        503,
        "INTEGRATION_NOT_CONFIGURED",
        "Google integration is not configured on this server"
      );
    }

    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = createState();

    await deps.oauthStates.create({
      state,
      userId: req.auth.userId,
      codeVerifier,
      redirectUri: config.redirectUri,
      expiresAt: new Date(now().getTime() + STATE_TTL_MS),
    });

    // The URL contains client_id and the PKCE CHALLENGE (a hash), never the
    // verifier or the client secret, so it is safe to hand to the browser.
    ok(res, { authUrl: buildAuthUrl({ config, state, codeChallenge }) });
  });

  // -------------------------------------------------------------------------
  // GET /callback
  // -------------------------------------------------------------------------
  router.get("/callback", async (req: AuthenticatedRequest, res: Response) => {
    const config = resolveConfig();
    if (!config) {
      return fail(
        res,
        503,
        "INTEGRATION_NOT_CONFIGURED",
        "Google integration is not configured on this server"
      );
    }

    // A user who declines consent comes back with ?error=access_denied.
    if (typeof req.query.error === "string") {
      return fail(res, 400, "INVALID_REQUEST", "Google authorization was not granted");
    }

    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state) {
      return fail(res, 400, "INVALID_REQUEST", "Missing authorization code or state");
    }

    // Single-use consumption. This both authenticates the callback and blocks
    // replay: the second attempt with the same code finds no row.
    const stateRecord = await deps.oauthStates.consume(state);
    if (!stateRecord) {
      return fail(res, 400, "INVALID_REQUEST", "Invalid or already-used authorization state");
    }
    if (stateRecord.expiresAt.getTime() < now().getTime()) {
      return fail(res, 400, "INVALID_REQUEST", "Authorization state has expired");
    }

    try {
      const tokens = await exchangeCode(
        config,
        code,
        stateRecord.codeVerifier,
        deps.fetchImpl as never
      );

      // Google may grant fewer scopes than requested; refuse a partial grant
      // rather than storing a connection whose Ads calls will 403 later.
      if (!hasRequiredScopes(tokens.scopes)) {
        return fail(
          res,
          403,
          "AUTHORIZATION_FAILED",
          "Google did not grant the Google Ads scope required for this integration"
        );
      }

      const { email } = await fetchUserInfo(config, tokens.accessToken, deps.fetchImpl as never);

      await deps.connections.save({
        userId: stateRecord.userId,
        googleAccountEmail: email,
        scopes: tokens.scopes,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      });

      ok(res, { connected: true, account: { email, scopes: tokens.scopes } });
    } catch (err) {
      if (err instanceof GoogleOAuthError) {
        const status = err.classified.code === "AUTHENTICATION_REQUIRED" ? 401 : 502;
        // classified.message is already redacted by the error handler.
        return fail(res, status, err.classified.code, err.classified.message);
      }
      return fail(res, 502, "INTERNAL_ERROR", "Failed to complete Google authorization");
    }
  });

  // -------------------------------------------------------------------------
  // POST /disconnect
  // -------------------------------------------------------------------------
  router.post("/disconnect", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const credentials = await deps.connections.getCredentials(req.auth.userId);
    if (!credentials) {
      return ok(res, { disconnected: false, reason: "No active Google connection" });
    }

    const config = resolveConfig();
    let revokedAtGoogle = false;
    if (config) {
      // Best effort. Local revocation must happen even if Google is
      // unreachable, otherwise a network blip leaves the user unable to
      // disconnect a credential they have asked us to stop holding.
      revokedAtGoogle = await revokeToken(
        config,
        credentials.refreshToken,
        deps.fetchImpl as never
      );
    }
    await deps.connections.revoke(req.auth.userId);

    ok(res, { disconnected: true, revokedAtGoogle });
  });

  return router;
}
