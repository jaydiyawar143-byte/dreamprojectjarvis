// ---------------------------------------------------------------------------
// Resolving a usable access token, and deciding what to say when there isn't one.
//
// NO NEW OAUTH OR TOKEN STORAGE LIVES HERE. The refresh exchange is
// `refreshAccessToken` from `@jarvis/google-ads` — the one implementation of
// Google's OAuth in this repository — and the tokens come from and go back to
// `IGoogleConnectionRepository`, the one encrypted vault. This module only
// decides WHEN to refresh and HOW to describe a failure.
//
// WHY IT RETURNS INSTEAD OF THROWING. The Ads provider does the same refresh
// and throws a `JarvisError` on failure, which suits a path where any failure
// is a failure. Phase 12 needs the distinction preserved all the way to the
// user: "you never connected" and "the provider has revoked your grant" and
// "you connected but without Calendar" are three different sentences with three
// different remedies, and only one of them is worth a retry. So the outcome is
// a discriminated union, and the caller maps it onto the task envelope.
//
// SCOPE IS CHECKED AGAINST WHAT WAS GRANTED. `findByUser().scopes` is Google's
// own record of what the consent screen actually gave, which can be narrower
// than what was requested. Checking the request would make the system claim
// access it does not have and then fail with a 403 nobody can explain.
//
// THE TOKEN NEVER LEAVES THIS MODULE'S CALLERS. It is returned to a service
// that puts it in an Authorization header. It is never logged, never returned
// from an API route, and there is no field for it on any type in
// `@jarvis/core`'s Google Workspace contract.
// ---------------------------------------------------------------------------

import {
  refreshAccessToken,
  GoogleOAuthError,
  type FetchLike,
  type GoogleConfig,
} from "@jarvis/google-ads";
import { getGoogleService, type IGoogleConnectionRepository } from "@jarvis/core";

/**
 * Refresh this far before expiry.
 *
 * A token that expires during the call is indistinguishable from a revoked one
 * at the point of failure, so the window is wide enough that a slow provider
 * call cannot straddle it.
 */
const REFRESH_SKEW_MS = 60_000;

export type AccessOutcome =
  | { ok: true; accessToken: string; grantedScopes: string[] }
  | {
      ok: false;
      status: "not_connected" | "needs_reauth" | "permission_missing";
      message: string;
      requiredAction: string;
    };

export interface AccessDeps {
  connections: IGoogleConnectionRepository;
  config: GoogleConfig;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

/**
 * Resolves a token that is valid for `service`, refreshing if needed.
 *
 * The order is deliberate and is the whole contract:
 *
 *   1. connected at all?      -> not_connected
 *   2. scope actually granted -> permission_missing   (checked BEFORE refresh,
 *                                because spending a refresh on a call that
 *                                cannot succeed is pure waste and produces a
 *                                confusing 403 instead of a clear answer)
 *   3. token fresh?           -> use it
 *   4. refresh succeeded?     -> use the new one
 *   5. refresh refused        -> needs_reauth
 */
export async function resolveAccess(
  userId: string,
  service: "gmail" | "drive" | "calendar",
  deps: AccessDeps,
  /**
   * Which scopes to require, overriding the service's READ scopes.
   *
   * Phase 13 passes its write scopes here. Without the override this function
   * would demand the read scope for a write, which is simply wrong:
   * `gmail.compose` permits creating and sending drafts and does NOT include
   * `gmail.readonly`, so a correctly-scoped write connection would be refused.
   * Least privilege cuts both ways — a write must not require read either.
   */
  requiredScopes?: readonly string[]
): Promise<AccessOutcome> {
  const now = deps.now ?? (() => new Date());

  const summary = await deps.connections.findByUser(userId);
  if (!summary) {
    return {
      ok: false,
      status: "not_connected",
      message: "No Google account is connected.",
      requiredAction: "Connect your Google account, then try again.",
    };
  }

  const spec = getGoogleService(service);
  if (!spec) {
    return {
      ok: false,
      status: "permission_missing",
      message: `Unknown Google service "${service}".`,
      requiredAction: "This is a configuration error; no user action will fix it.",
    };
  }

  // GRANTED, not requested. Google may hand back fewer scopes than were asked
  // for, and a connection that omitted this service is a real and common state.
  const granted = new Set(summary.scopes);
  const needed = requiredScopes ?? spec.readScopes;
  const missing = needed.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    return {
      ok: false,
      status: "permission_missing",
      message: `Your Google connection does not include ${spec.label} access.`,
      // Explicit about what happens: this system never silently widens a grant.
      requiredAction: `Reconnect Google and include ${spec.label} when asked, to grant read access.`,
    };
  }

  const credentials = await deps.connections.getCredentials(userId);
  if (!credentials) {
    // A summary without credentials means the connection was revoked between
    // the two reads, or the row is half-written. Either way it is not usable.
    return {
      ok: false,
      status: "needs_reauth",
      message: "The stored Google credentials could not be read.",
      requiredAction: "Reconnect your Google account.",
    };
  }

  const fresh = credentials.expiresAt.getTime() - now().getTime() > REFRESH_SKEW_MS;
  if (fresh) {
    return { ok: true, accessToken: credentials.accessToken, grantedScopes: summary.scopes };
  }

  try {
    const refreshed = await refreshAccessToken(
      deps.config,
      credentials.refreshToken,
      deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    );
    await deps.connections.updateAccessToken(userId, refreshed.accessToken, refreshed.expiresAt);
    return { ok: true, accessToken: refreshed.accessToken, grantedScopes: summary.scopes };
  } catch (error) {
    // A refused refresh means the grant is gone at Google's end. Retrying is
    // guaranteed to fail, so this must NOT be reported as a provider error —
    // that would send the UI and the model into a retry loop over something
    // only the user can fix.
    const refused =
      error instanceof GoogleOAuthError && error.classified.code === "AUTHENTICATION_REQUIRED";

    return {
      ok: false,
      status: "needs_reauth",
      message: refused
        ? "Google refused the stored authorization; the grant no longer exists."
        : "The Google authorization could not be refreshed.",
      requiredAction: "Reconnect your Google account to authorize again.",
    };
  }
}
