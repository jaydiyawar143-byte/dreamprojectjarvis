// ---------------------------------------------------------------------------
// Google integration health — read-only, and read-only by construction.
//
// WHAT THIS ANSWERS. "Is Google working?" is four questions wearing one coat:
// is the OAuth client configured at all, is an account connected, is its token
// still usable, and does the grant actually cover the things JARVIS is being
// asked to do. Collapsing those into one boolean is what let a fully healthy
// connection sit behind a Gmail draft that could never succeed — the account
// was fine, the token was fine, and one scope was missing.
//
// SAFETY IS STRUCTURAL, NOT PROMISED. This module has no write client. It can
// reach exactly two things: the stored connection (a database read) and
// `resolveAccess`, whose worst side effect is exchanging a refresh token for a
// fresh access token. No Gmail draft, no Drive file, no Calendar event, no Ads
// mutation is reachable from here because nothing that could perform one is
// wired in. That is a stronger guarantee than a rule saying "do not write".
//
// SCOPE PRESENCE IS NOT PROOF OF ANYTHING HAVING HAPPENED. A granted scope means
// an action is PERMITTED, never that it succeeded — the verification layer owns
// that distinction and this module must not blur it. `connected` here means
// "the authorization is usable and covers what we checked", nothing more.
// ---------------------------------------------------------------------------

import {
  GOOGLE_SERVICES,
  canonicalIdentityHeld,
  type IntegrationHealthSnapshot,
  type MissingPermission,
} from "@jarvis/core";
import type { IGoogleConnectionRepository } from "@jarvis/core";

/** Services this build can actually act on, in the order a user meets them. */
const CHECKED_SERVICES = ["gmail", "drive", "calendar"] as const;

export interface GoogleHealthDeps {
  /** Null when the server has no OAuth client configured. */
  isConfigured: () => boolean;
  connections: IGoogleConnectionRepository | null;
  /**
   * Proves the stored authorization is still usable.
   *
   * Injected rather than imported so the check cannot reach anything wider
   * than "can we obtain a token" — and so tests can drive every branch without
   * a network.
   */
  probeToken: (userId: string) => Promise<
    | { ok: true }
    | { ok: false; status: "not_connected" | "needs_reauth" | "permission_missing"; message: string }
  >;
  now?: () => Date;
}

function snapshot(
  partial: Omit<IntegrationHealthSnapshot, "integrationId" | "checkedAt">,
  startedAt: number,
  now: Date
): IntegrationHealthSnapshot {
  return {
    integrationId: "google",
    checkedAt: now.toISOString(),
    durationMs: Date.now() - startedAt,
    ...partial,
  };
}

/**
 * Which of the checked services the granted scopes do NOT cover.
 *
 * Read scope OR write scope counts as coverage: a connection holding only
 * `gmail.compose` can still draft and send, and reporting that as a missing
 * permission would send the user to grant something they already have.
 */
export function missingServicePermissions(granted: readonly string[]): MissingPermission[] {
  const held = new Set(granted);
  const missing: MissingPermission[] = [];

  for (const id of CHECKED_SERVICES) {
    const spec = GOOGLE_SERVICES.find((s) => s.id === id);
    if (!spec || !spec.implemented) continue;

    const covered =
      spec.readScopes.some((s) => held.has(s)) || spec.writeScopes.some((s) => held.has(s));
    if (!covered) missing.push({ service: spec.id, label: spec.label });
  }

  return missing;
}

/**
 * Run the Google health check.
 *
 * Ordered so each answer rules out the ones beneath it, and so the most
 * actionable cause always wins: a server with no OAuth client cannot have a
 * scope problem, and a revoked token cannot be diagnosed as a missing scope.
 */
export async function checkGoogleHealth(
  userId: string,
  deps: GoogleHealthDeps
): Promise<IntegrationHealthSnapshot> {
  const startedAt = Date.now();
  const now = (deps.now ?? (() => new Date()))();
  const snap = (p: Omit<IntegrationHealthSnapshot, "integrationId" | "checkedAt">) =>
    snapshot(p, startedAt, now);

  // 1. Server configuration. Nothing below this can be true without it.
  if (!deps.isConfigured() || !deps.connections) {
    return snap({
      status: "configuration_missing",
      summary:
        "Google OAuth is not configured on this server. Set the Google client id, secret and redirect URI, then restart.",
      errorCode: "GOOGLE_OAUTH_NOT_CONFIGURED",
    });
  }

  // 2. Is an account connected for THIS user? Connections are per-user, so
  //    another user's connection is correctly invisible here.
  let connection;
  try {
    connection = await deps.connections.findByUser(userId);
  } catch {
    return snap({
      status: "error",
      summary: "The stored Google connection could not be read.",
      errorCode: "HEALTH_CHECK_FAILED",
    });
  }

  if (!connection || connection.revokedAt) {
    return snap({
      status: "not_configured",
      summary: "No Google account is connected. Connect one in Integrations.",
      errorCode: "GOOGLE_NOT_CONNECTED",
    });
  }

  // 3. Identity. Without it the row cannot name the account it belongs to,
  //    which is the one thing every other answer is reported against.
  if (!canonicalIdentityHeld(connection.scopes)) {
    return snap({
      status: "needs_reauth",
      summary:
        "The Google connection is missing the basic account permissions needed to identify it. Reconnect Google.",
      errorCode: "GOOGLE_IDENTITY_INCOMPLETE",
      account: connection.googleAccountEmail,
    });
  }

  // 4. Is the authorization still usable? This is the only step that talks to
  //    Google, and the most it can do is refresh a token.
  let probe;
  try {
    probe = await deps.probeToken(userId);
  } catch {
    // A thrown probe is a provider or network problem, NOT a verdict about the
    // user's grant. Saying "reconnect" here would send them to redo consent
    // over what may be a thirty-second outage.
    return snap({
      status: "error",
      summary: "Google could not be reached to verify the connection. Try again shortly.",
      errorCode: "GOOGLE_UNREACHABLE",
      account: connection.googleAccountEmail,
    });
  }

  if (!probe.ok) {
    if (probe.status === "needs_reauth") {
      return snap({
        status: "needs_reauth",
        summary: "Your Google authorization has expired or been revoked. Reconnect Google.",
        errorCode: "GOOGLE_REAUTH_REQUIRED",
        account: connection.googleAccountEmail,
      });
    }
    if (probe.status === "not_connected") {
      return snap({
        status: "not_configured",
        summary: "No Google account is connected. Connect one in Integrations.",
        errorCode: "GOOGLE_NOT_CONNECTED",
        account: connection.googleAccountEmail,
      });
    }
    // permission_missing from the probe falls through to the scope report
    // below, which can name WHICH permission rather than just that one is gone.
  }

  // 5. Coverage. The token works; does the grant reach what JARVIS does?
  const missing = missingServicePermissions(connection.scopes);

  if (missing.length > 0) {
    const names = missing.map((m) => m.label).join(", ");
    return snap({
      status: "permission_missing",
      summary: `Google is connected and working, but ${names} access has not been granted. Grant it in Integrations.`,
      errorCode: "GOOGLE_PERMISSION_MISSING",
      missingPermissions: missing,
      account: connection.googleAccountEmail,
    });
  }

  return snap({
    status: "connected",
    summary: "Google is connected and the authorization is valid.",
    account: connection.googleAccountEmail,
  });
}
