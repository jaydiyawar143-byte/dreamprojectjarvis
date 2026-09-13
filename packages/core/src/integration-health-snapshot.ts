// ---------------------------------------------------------------------------
// Cached integration health: what was true the last time we actually checked.
//
// WHY A SECOND VOCABULARY. `IntegrationHealth` already exists and stays — it is
// the UI's display state and it is derived from configuration. What it cannot
// express is the distinction that caused the Gmail failure: a connection can be
// completely healthy, its token fresh and its account verified, and still be
// unable to draft an email because one scope was never granted. Folded into
// CONNECTED, that reads as "everything works" and the user goes looking for a
// bug. Folded into ERROR, it reads as "something is broken" and they try a
// reconnect that changes nothing.
//
// `permission_missing` is the state that was missing, and it is the only one
// here whose remedy is a single specific click.
//
// EVERYTHING IN A SNAPSHOT IS SAFE TO SHOW. No token, no refresh token, no
// authorization code, no raw provider body, no profile data. `summary` is one
// authored sentence; `missingPermissions` carries service NAMES, never scope
// strings, because the UI shows people what they cannot do, not what OAuth
// calls it.
//
// A SNAPSHOT IS EVIDENCE, NOT A PROMISE. `checkedAt` is part of the contract:
// "connected, checked 40 minutes ago" is a different claim from "connected",
// and a UI that hides the timestamp invites the user to trust a stale result.
// ---------------------------------------------------------------------------

/**
 * The six states a health check can conclude.
 *
 * Deliberately lower-case and distinct from `IntegrationHealth`: this is the
 * result of a CHECK, not a rendering of configuration, and keeping the two
 * vocabularies apart stops a derived value being mistaken for a verified one.
 */
export type IntegrationHealthStatus =
  /** A real read against the provider succeeded. */
  | "connected"
  /** The stored authorization is expired or rejected. Re-consent required. */
  | "needs_reauth"
  /** Connected and working, but a scope needed for some action is absent. */
  | "permission_missing"
  /** Set up partially — required settings are missing. */
  | "configuration_missing"
  /** The check ran and something unexpected went wrong. */
  | "error"
  /** Never set up on this deployment or by this user. */
  | "not_configured";

/** Statuses an operator should act on. */
export const HEALTH_NEEDS_ATTENTION: readonly IntegrationHealthStatus[] = [
  "needs_reauth",
  "permission_missing",
  "configuration_missing",
  "error",
];

/**
 * A capability the connection cannot currently exercise.
 *
 * `service` is what the upgrade flow takes, so the UI can wire a button
 * straight to it without translating anything.
 */
export interface MissingPermission {
  /** Service id the upgrade flow understands — "gmail", "drive", "calendar". */
  service: string;
  /** What the user cannot do, in their words. Never a scope string. */
  label: string;
}

export interface IntegrationHealthSnapshot {
  integrationId: string;
  status: IntegrationHealthStatus;
  /** One authored sentence. Safe for the browser. */
  summary: string;
  /** ISO timestamp of the check that produced this. */
  checkedAt: string;
  /** Stable code for a client to branch on. Absent when healthy. */
  errorCode?: string;
  /** Present only for `permission_missing`. */
  missingPermissions?: MissingPermission[];
  /**
   * The connected account, when naming it is already safe and intended.
   * An email the user themselves connected and already sees in the UI.
   */
  account?: string;
  /** How long the check took. Useful for spotting a slow provider. */
  durationMs?: number;
}

/** True when the snapshot says the integration is usable right now. */
export function isHealthy(snapshot: IntegrationHealthSnapshot): boolean {
  return snapshot.status === "connected";
}

/**
 * Whether a snapshot is old enough that it should not be presented as current.
 *
 * The UI still shows a stale snapshot — "connected, checked an hour ago" is
 * more useful than nothing — but it should say so rather than implying it just
 * checked.
 */
export function isStale(
  snapshot: IntegrationHealthSnapshot,
  maxAgeMs: number,
  now: Date = new Date()
): boolean {
  const checked = Date.parse(snapshot.checkedAt);
  if (Number.isNaN(checked)) return true;
  return now.getTime() - checked > maxAgeMs;
}

/** Human label for each status. One place, so the words cannot drift. */
export const HEALTH_STATUS_LABEL: Readonly<Record<IntegrationHealthStatus, string>> =
  Object.freeze({
    connected: "Connected",
    needs_reauth: "Needs reauth",
    permission_missing: "Permission missing",
    configuration_missing: "Configuration missing",
    error: "Error",
    not_configured: "Not configured",
  });
