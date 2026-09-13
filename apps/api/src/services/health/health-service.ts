// ---------------------------------------------------------------------------
// Automatic integration health, cached.
//
// THE PROBLEM. Health was only ever known after someone pressed "Test
// Connection". After a restart every integration sat at UNVERIFIED — which the
// UI shows as "Not checked" — so the honest answer to "is Google working?" was
// "nobody has asked recently", and the way to find out was to click through
// every card. Meanwhile a Gmail draft could fail for a reason the system could
// have known at boot.
//
// So checks run once at startup and are re-run at the moments something could
// actually have changed: an OAuth connect, reconnect or scope upgrade, a
// credential edit, a manual test, or an explicit request. Nothing polls on a
// timer — a timer would spend provider quota to re-learn something that only
// changes when the user does something, and a stale snapshot that says WHEN it
// was taken is more honest than a fresh one that costs a request per minute.
//
// READ-ONLY, ENFORCED BY WIRING. A checker is a function that receives only
// what it needs to read. This service holds no write client and no tool
// registry, so there is no path from a health check to a Gmail draft, a Drive
// file, a Calendar event or an Ads mutation.
//
// FAILURE TO CHECK IS NOT FAILURE OF THE INTEGRATION. A checker that throws
// yields an `error` snapshot for that integration and nothing else — one
// provider being unreachable must never take down startup or hide the others.
// ---------------------------------------------------------------------------

import type { IntegrationHealthSnapshot } from "@jarvis/core";

/** What triggered a check. Recorded so a stale snapshot can explain itself. */
export type HealthCheckReason =
  | "startup"
  | "on_demand"
  | "oauth_connect"
  | "oauth_reconnect"
  | "permission_upgrade"
  | "credentials_updated"
  | "manual_test";

/** A read-only probe for one integration. */
export type IntegrationHealthChecker = (
  userId: string
) => Promise<IntegrationHealthSnapshot>;

export interface HealthServiceDeps {
  checkers: Readonly<Record<string, IntegrationHealthChecker>>;
  now?: () => Date;
  /** Structured logging sink. Booleans, ids and statuses only. */
  log?: (line: Record<string, unknown>) => void;
}

const DEFAULT_LOG = (line: Record<string, unknown>) => {
  console.log(JSON.stringify(line));
};

export class IntegrationHealthService {
  /**
   * Keyed by `${userId}:${integrationId}`.
   *
   * Per-user because health IS per-user: the same server can have one user with
   * Gmail granted and another with nothing connected, and a shared cache would
   * show one of them the other's answer.
   */
  private readonly cache = new Map<string, IntegrationHealthSnapshot>();

  private readonly checkers: Readonly<Record<string, IntegrationHealthChecker>>;
  private readonly now: () => Date;
  private readonly log: (line: Record<string, unknown>) => void;

  /** In-flight checks, so concurrent callers share one provider round trip. */
  private readonly inFlight = new Map<string, Promise<IntegrationHealthSnapshot>>();

  constructor(deps: HealthServiceDeps) {
    this.checkers = deps.checkers;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? DEFAULT_LOG;
  }

  /** Integration ids this service can check. */
  get integrationIds(): string[] {
    return Object.keys(this.checkers);
  }

  private key(userId: string, integrationId: string): string {
    return `${userId}:${integrationId}`;
  }

  /** The last known snapshot, without running anything. */
  get(userId: string, integrationId: string): IntegrationHealthSnapshot | null {
    return this.cache.get(this.key(userId, integrationId)) ?? null;
  }

  /** Every cached snapshot for one user. */
  all(userId: string): IntegrationHealthSnapshot[] {
    return this.integrationIds
      .map((id) => this.get(userId, id))
      .filter((s): s is IntegrationHealthSnapshot => s !== null);
  }

  /**
   * Run one check and cache it.
   *
   * Concurrent callers for the same user and integration share the in-flight
   * promise: a page load that renders six cards must not become six identical
   * provider round trips.
   */
  async check(
    userId: string,
    integrationId: string,
    reason: HealthCheckReason
  ): Promise<IntegrationHealthSnapshot> {
    const checker = this.checkers[integrationId];
    if (!checker) {
      const snapshot: IntegrationHealthSnapshot = {
        integrationId,
        status: "not_configured",
        summary: "This integration has no health check on this deployment.",
        checkedAt: this.now().toISOString(),
      };
      this.cache.set(this.key(userId, integrationId), snapshot);
      return snapshot;
    }

    const key = this.key(userId, integrationId);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const run = (async (): Promise<IntegrationHealthSnapshot> => {
      try {
        const snapshot = await checker(userId);
        this.cache.set(key, snapshot);
        this.logSnapshot(snapshot, reason);
        return snapshot;
      } catch {
        // A checker that throws is a broken CHECK, not proof the integration is
        // broken — but it is still the most honest thing we can report, so it
        // is cached as `error` rather than leaving a stale success in place.
        const snapshot: IntegrationHealthSnapshot = {
          integrationId,
          status: "error",
          summary: "The health check could not be completed.",
          checkedAt: this.now().toISOString(),
          errorCode: "HEALTH_CHECK_FAILED",
        };
        this.cache.set(key, snapshot);
        this.logSnapshot(snapshot, reason);
        return snapshot;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, run);
    return run;
  }

  /**
   * Check everything for one user.
   *
   * `allSettled`, so one unreachable provider cannot prevent the others from
   * being learned — the whole point of running these automatically.
   */
  async checkAll(
    userId: string,
    reason: HealthCheckReason
  ): Promise<IntegrationHealthSnapshot[]> {
    const results = await Promise.allSettled(
      this.integrationIds.map((id) => this.check(userId, id, reason))
    );

    return results
      .filter(
        (r): r is PromiseFulfilledResult<IntegrationHealthSnapshot> => r.status === "fulfilled"
      )
      .map((r) => r.value);
  }

  /**
   * Invalidate after something that could have changed the answer.
   *
   * Drops the cache entry rather than re-checking inline: the caller is usually
   * finishing an OAuth redirect, and holding that response open for a provider
   * round trip would be paid for by the user watching a blank page. The next
   * read re-checks.
   */
  invalidate(userId: string, integrationId: string, reason: HealthCheckReason): void {
    this.cache.delete(this.key(userId, integrationId));
    this.log({
      level: "info",
      event: "integration_health_invalidated",
      integrationId,
      reason,
    });
  }

  private logSnapshot(snapshot: IntegrationHealthSnapshot, reason: HealthCheckReason): void {
    this.log({
      level: snapshot.status === "connected" ? "info" : "warn",
      event: "integration_health_check",
      integrationId: snapshot.integrationId,
      status: snapshot.status,
      reason,
      ...(snapshot.errorCode ? { errorCode: snapshot.errorCode } : {}),
      // Service NAMES only — never scope strings, never a token.
      ...(snapshot.missingPermissions
        ? { missingPermissions: snapshot.missingPermissions.map((m) => m.service) }
        : {}),
      ...(snapshot.durationMs !== undefined ? { durationMs: snapshot.durationMs } : {}),
    });
  }
}
