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
import { asyncHandler } from "../middleware/error-handler.js";
import type { Container } from "../services/container.js";
import type { IGoogleConnectionRepository, IOAuthStateRepository } from "@jarvis/core";
import {
  createGoogleOAuthConfig,
  isGoogleOAuthConfigured,
  googleOAuthPresence,
  createPkcePair,
  createState,
  buildAuthUrl,
  exchangeCode,
  revokeToken,
  fetchUserInfo,
  grantCovers,
  ACCOUNT_IDENTITY_SCOPES,
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
  /**
   * Called after a connection is stored or updated, so cached health can be
   * invalidated. Optional: the OAuth flow must not depend on health existing.
   */
  onConnectionChanged?: (userId: string) => void;
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

  /**
   * Resolves config lazily so an unconfigured deployment still serves /status.
   *
   * OAUTH PREDICATE, NOT THE ADS ONE. This used to call `isGoogleConfigured()`,
   * which additionally requires `GOOGLE_ADS_DEVELOPER_TOKEN` — a variable that
   * only the Ads API needs and that nothing in this router touches (nothing
   * here reads `developerToken` at all). The effect was that a deployment with
   * a perfectly good OAuth client reported `configured: false` on /status and
   * refused /connect, while the error text told the user to set the three
   * variables they had already set. There was no way to act on that message.
   *
   * `build-write-service.ts` and the Workspace wiring in `container.ts` already
   * made this correction for the same reason; the connection API itself was
   * left behind. Gmail, Drive and Calendar need no developer token, and neither
   * does the token exchange, which reads only clientId, clientSecret and
   * redirectUri.
   *
   * An Ads-specific caller still goes through `createGoogleConfig`, which
   * demands a real developer token, so nothing here weakens the Ads path.
   */
  const resolveConfig = (): GoogleConfig | null => {
    if (deps.config) return deps.config;
    if (!isGoogleOAuthConfigured()) return null;
    try {
      return createGoogleOAuthConfig();
    } catch {
      return null;
    }
  };

  // -------------------------------------------------------------------------
  // GET /status
  // -------------------------------------------------------------------------
  router.get("/status", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const configured = resolveConfig() !== null;
    const connection = await deps.connections.findByUser(req.auth.userId);

    // Booleans and non-secret identifiers only.
    ok(res, {
      configured,
      // Which OAuth variables the RUNNING PROCESS received. Booleans only —
      // never a value, a length or a fragment. This is here because
      // `configured: false` alone cannot distinguish "nothing is set" from
      // "one of the three is missing" from "the process started before the
      // file was saved", and those have completely different remedies.
      ...googleOAuthPresence(),
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
  }));

  // -------------------------------------------------------------------------
  // POST /connect
  // -------------------------------------------------------------------------
  router.post("/connect", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
  }));

  // -------------------------------------------------------------------------
  // GET /callback
  // -------------------------------------------------------------------------
  router.get("/callback", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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

      // IDENTITY IS THE FLOOR — not the Ads scope.
      //
      // This used to call `hasRequiredScopes`, which demands `adwords`. One
      // callback serves every Google connection, so a Workspace consent
      // (openid email profile gmail.readonly drive.readonly calendar.readonly)
      // was rejected with "Google did not grant the Google Ads scope" — a
      // complete, correct grant refused for lacking a scope it was never asked
      // for. Since the single-use state is consumed ABOVE this line, the
      // rejection also burned it, so the user's next attempt reported "Invalid
      // or already-used authorization state" and pointed at replay protection
      // instead of at scopes.
      //
      // Identity is what the connection row cannot do without: it names the
      // account for display and revocation. Everything else is gated per
      // service where it is used — `resolveGoogleAccess` checks GRANTED scopes
      // and returns `permission_missing` with a remedy, and `hasWriteAccess`
      // does the same for writes. So a Workspace-only connection stored here
      // cannot quietly attempt an Ads call; it is refused by the layer that can
      // explain why.
      // Callback diagnostics. Booleans and scope NAMES only — never the code,
      // the tokens, or any profile field. Emitted BEFORE the gate so a refusal
      // is explainable: "which of these five was false" is the whole question
      // when a consent that looked fine is rejected.
      const identityScopesRequested = grantCovers(tokens.scopes, ACCOUNT_IDENTITY_SCOPES);
      const diagnostics = {
        level: "info",
        event: "google_callback_identity",
        identityScopesRequested,
        accessTokenReceived: typeof tokens.accessToken === "string" && tokens.accessToken.length > 0,
        // Scope NAMES are not secrets and are the single most useful field
        // here: it is how you see that Google returned `userinfo.email` where
        // the code was looking for `email`.
        grantedScopeCount: tokens.scopes.length,
      };

      if (!identityScopesRequested) {
        console.log(JSON.stringify({
          ...diagnostics,
          level: "warn",
          identityResponseReceived: false,
          googleSubjectPresent: false,
          emailPresent: false,
          refusedBecause: "granted scopes do not cover openid + email",
          grantedScopes: tokens.scopes,
        }));
        return fail(
          res,
          403,
          "AUTHORIZATION_FAILED",
          // Names what is missing instead of restating the category, so the
          // remedy is visible from the message alone.
          `Google did not grant the account permissions needed to identify the connection. Required: ${ACCOUNT_IDENTITY_SCOPES.join(", ")}. Granted: ${tokens.scopes.join(", ") || "nothing"}.`
        );
      }

      const { email, subjectPresent } = await fetchUserInfo(
        config,
        tokens.accessToken,
        deps.fetchImpl as never
      );

      console.log(JSON.stringify({
        ...diagnostics,
        identityResponseReceived: true,
        googleSubjectPresent: subjectPresent,
        emailPresent: email.length > 0,
      }));

      // ---------------------------------------------------------------------
      // INCREMENTAL CONSENT: union the scopes, do not replace them.
      //
      // The upgrade URL asks only for what is being ADDED — a Gmail upgrade
      // sends `openid email profile gmail.readonly gmail.compose` and does not
      // re-list `adwords`. Google carries the earlier grant forward because
      // `include_granted_scopes=true` is set, so the token really does still
      // cover Ads; but the token RESPONSE is not guaranteed to enumerate every
      // previously granted scope. Writing `tokens.scopes` straight over the
      // stored row therefore risks erasing `adwords` from our record while the
      // token itself still holds it — and the capability layer reads the
      // record, so Ads would silently disappear from the UI immediately after
      // a successful Gmail upgrade.
      //
      // Merging is only ever additive for the SAME Google account, which is why
      // it is guarded on the email matching. Connecting a different account
      // starts from that account's own grant rather than inheriting the
      // previous one's.
      //
      // The trade-off, stated honestly: if a scope is later revoked out-of-band
      // at Google, the merged record over-claims until the next consent. That
      // failure is self-correcting at the point of use — the provider returns
      // 403/401 and `resolveGoogleAccess` reports needs_reauth or
      // permission_missing — whereas under-claiming would break working
      // functionality with no signal at all.
      const existing = await deps.connections.findByUser(stateRecord.userId);
      const mergedScopes =
        existing && existing.googleAccountEmail === email && !existing.revokedAt
          ? [...new Set([...existing.scopes, ...tokens.scopes])]
          : tokens.scopes;

      await deps.connections.save({
        userId: stateRecord.userId,
        googleAccountEmail: email,
        scopes: mergedScopes,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      });

      // Scope names only — no token, no code, no profile field.
      console.log(JSON.stringify({
        level: "info",
        event: "google_connection_stored",
        scopesGranted: tokens.scopes.length,
        scopesStored: mergedScopes.length,
        scopesCarriedForward: mergedScopes.length - tokens.scopes.length,
        upgrade: Boolean(existing && existing.googleAccountEmail === email),
      }));

      // The grant just changed, so any cached health verdict is now stale —
      // most importantly the `permission_missing` one this consent may have
      // just resolved. Dropped rather than re-checked inline: the user is mid
      // redirect and must not wait on a provider round trip.
      deps.onConnectionChanged?.(stateRecord.userId);

      ok(res, { connected: true, account: { email, scopes: mergedScopes } });
    } catch (err) {
      if (err instanceof GoogleOAuthError) {
        const status = err.classified.code === "AUTHENTICATION_REQUIRED" ? 401 : 502;
        // classified.message is already redacted by the error handler.
        return fail(res, status, err.classified.code, err.classified.message);
      }
      return fail(res, 502, "INTERNAL_ERROR", "Failed to complete Google authorization");
    }
  }));

  // -------------------------------------------------------------------------
  // POST /disconnect
  // -------------------------------------------------------------------------
  router.post("/disconnect", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
  }));

  return router;
}
