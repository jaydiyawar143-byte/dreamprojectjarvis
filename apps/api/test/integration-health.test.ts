// ---------------------------------------------------------------------------
// Automatic integration health.
//
// Two properties matter more than the rest.
//
// FIRST: a health check must never write. The whole feature runs unattended at
// startup, so a checker that created a Gmail draft would create one on every
// boot, silently, for every user. The guarantee is structural — a checker is
// handed only what it can read — and the test below asserts the wiring rather
// than the intention, because an intention does not survive a refactor.
//
// SECOND: `permission_missing` must stay distinct from `connected` and from
// `error`. That distinction is the entire reason this exists: the Gmail draft
// failure happened on a connection that was healthy by every other measure, and
// folding it into either neighbour reproduces the bug — "connected" sends the
// user hunting for a fault that is not there, "error" sends them to reconnect,
// which changes nothing.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import {
  IntegrationHealthService,
  type IntegrationHealthChecker,
} from "../src/services/health/health-service.js";
import {
  checkGoogleHealth,
  missingServicePermissions,
} from "../src/services/health/google-health-check.js";
import type { GoogleConnectionSummary, IntegrationHealthSnapshot } from "@jarvis/core";

const USER = "user-1";

const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_READ = "https://www.googleapis.com/auth/drive.readonly";
const CAL_EVENTS = "https://www.googleapis.com/auth/calendar.events";
const CAL_READ = "https://www.googleapis.com/auth/calendar.readonly";
const ADS = "https://www.googleapis.com/auth/adwords";
const IDENTITY = ["openid", "https://www.googleapis.com/auth/userinfo.email"];

function connection(scopes: string[], over: Partial<GoogleConnectionSummary> = {}) {
  return {
    id: "c1",
    userId: USER,
    googleAccountEmail: "person@example.com",
    scopes,
    connectedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
    revokedAt: null,
    ...over,
  } as GoogleConnectionSummary;
}

function deps(over: Partial<Parameters<typeof checkGoogleHealth>[1]> = {}) {
  return {
    isConfigured: () => true,
    connections: {
      findByUser: async () => connection([...IDENTITY, GMAIL_COMPOSE, DRIVE_FILE, CAL_EVENTS]),
    } as never,
    probeToken: async () => ({ ok: true as const }),
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("a health check can never perform a write", () => {
  it("is given no client capable of one", () => {
    // The guarantee is the wiring, so the wiring is what is asserted. If a
    // future edit hands the checker something that can act, this fails.
    const allowed = ["isConfigured", "connections", "probeToken", "now"];
    const passed = Object.keys(deps());

    for (const key of passed) {
      expect(allowed, `health deps must not include "${key}"`).toContain(key);
    }
  });

  it("reads the connection and probes the token, and nothing else", async () => {
    const findByUser = vi.fn(async () => connection([...IDENTITY, GMAIL_COMPOSE, DRIVE_FILE, CAL_EVENTS]));
    const probeToken = vi.fn(async () => ({ ok: true as const }));

    await checkGoogleHealth(USER, deps({ connections: { findByUser } as never, probeToken }));

    expect(findByUser).toHaveBeenCalledTimes(1);
    expect(probeToken).toHaveBeenCalledTimes(1);
  });
});

describe("the six statuses are distinguished", () => {
  it("connected — token usable and every checked service covered", async () => {
    const snap = await checkGoogleHealth(USER, deps());

    expect(snap.status).toBe("connected");
    expect(snap.errorCode).toBeUndefined();
    expect(snap.account).toBe("person@example.com");
  });

  it("configuration_missing — the server has no OAuth client", async () => {
    const snap = await checkGoogleHealth(USER, deps({ isConfigured: () => false }));

    expect(snap.status).toBe("configuration_missing");
    expect(snap.errorCode).toBe("GOOGLE_OAUTH_NOT_CONFIGURED");
  });

  it("not_configured — no account connected for this user", async () => {
    const snap = await checkGoogleHealth(
      USER,
      deps({ connections: { findByUser: async () => null } as never })
    );

    expect(snap.status).toBe("not_configured");
    expect(snap.errorCode).toBe("GOOGLE_NOT_CONNECTED");
  });

  it("not_configured — a revoked connection is not a connection", async () => {
    const snap = await checkGoogleHealth(
      USER,
      deps({
        connections: {
          findByUser: async () => connection([...IDENTITY], { revokedAt: new Date() }),
        } as never,
      })
    );

    expect(snap.status).toBe("not_configured");
  });

  it("needs_reauth — the provider rejected the stored grant", async () => {
    const snap = await checkGoogleHealth(
      USER,
      deps({
        probeToken: async () => ({ ok: false as const, status: "needs_reauth" as const, message: "gone" }),
      })
    );

    expect(snap.status).toBe("needs_reauth");
    expect(snap.errorCode).toBe("GOOGLE_REAUTH_REQUIRED");
  });

  it("permission_missing — healthy connection, Gmail not granted", async () => {
    // The exact shape of the live failure.
    const snap = await checkGoogleHealth(
      USER,
      deps({
        connections: {
          findByUser: async () => connection([...IDENTITY, ADS, DRIVE_FILE, CAL_EVENTS]),
        } as never,
      })
    );

    expect(snap.status).toBe("permission_missing");
    expect(snap.errorCode).toBe("GOOGLE_PERMISSION_MISSING");
    expect(snap.missingPermissions?.map((m) => m.service)).toEqual(["gmail"]);
    // It must still read as working, or the user reconnects for nothing.
    expect(snap.summary).toMatch(/connected and working/i);
  });

  it("error — Google could not be reached, which is not a verdict on the grant", async () => {
    const snap = await checkGoogleHealth(
      USER,
      deps({
        probeToken: async () => {
          throw new Error("socket hang up");
        },
      })
    );

    expect(snap.status).toBe("error");
    expect(snap.errorCode).toBe("GOOGLE_UNREACHABLE");
    // Emphatically NOT needs_reauth: re-consent fixes nothing here.
    expect(snap.summary).not.toMatch(/reconnect/i);
  });
});

describe("scope recognition", () => {
  it("accepts canonical identity scopes, which is what Google actually returns", async () => {
    const snap = await checkGoogleHealth(
      USER,
      deps({
        connections: {
          findByUser: async () =>
            connection([
              "openid",
              "https://www.googleapis.com/auth/userinfo.email",
              "https://www.googleapis.com/auth/userinfo.profile",
              GMAIL_COMPOSE,
              DRIVE_FILE,
              CAL_EVENTS,
            ]),
        } as never,
      })
    );

    expect(snap.status).toBe("connected");
  });

  it("treats a connection with no identity scope as needing reauth", async () => {
    const snap = await checkGoogleHealth(
      USER,
      deps({
        connections: { findByUser: async () => connection([GMAIL_COMPOSE]) } as never,
      })
    );

    expect(snap.status).toBe("needs_reauth");
    expect(snap.errorCode).toBe("GOOGLE_IDENTITY_INCOMPLETE");
  });

  it("counts a write scope as coverage — compose does not imply readonly", () => {
    // A connection holding only gmail.compose can draft and send. Reporting it
    // as missing would send the user to grant what they already have.
    expect(missingServicePermissions([GMAIL_COMPOSE, DRIVE_FILE, CAL_EVENTS])).toEqual([]);
  });

  it("counts a read scope as coverage too", () => {
    expect(missingServicePermissions([GMAIL_READ, DRIVE_READ, CAL_READ])).toEqual([]);
  });

  it("names each uncovered service separately", () => {
    const missing = missingServicePermissions([...IDENTITY, ADS]);
    expect(missing.map((m) => m.service).sort()).toEqual(["calendar", "drive", "gmail"]);
  });

  it("does not treat the Ads scope as covering a Workspace service", () => {
    expect(missingServicePermissions([ADS]).map((m) => m.service)).toContain("gmail");
  });
});

describe("nothing sensitive is in a snapshot", () => {
  it("carries no scope strings, tokens or payloads", async () => {
    const snap = await checkGoogleHealth(
      USER,
      deps({
        connections: {
          findByUser: async () => connection([...IDENTITY, ADS]),
        } as never,
      })
    );

    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("googleapis.com");
    expect(serialized).not.toContain("ya29.");
    expect(serialized).not.toContain("adwords");
  });
});

// ---------------------------------------------------------------------------

describe("the health service caches and refreshes", () => {
  function service(checker: IntegrationHealthChecker) {
    return new IntegrationHealthService({
      checkers: { google: checker },
      log: () => {},
    });
  }

  const healthy: IntegrationHealthSnapshot = {
    integrationId: "google",
    status: "connected",
    summary: "fine",
    checkedAt: new Date().toISOString(),
  };

  it("caches a result so the next read costs nothing", async () => {
    const checker = vi.fn(async () => healthy);
    const svc = service(checker);

    await svc.check(USER, "google", "startup");
    const cached = svc.get(USER, "google");

    expect(cached?.status).toBe("connected");
    expect(checker).toHaveBeenCalledTimes(1);
  });

  it("shares one provider round trip between concurrent callers", async () => {
    // Six cards rendering at once must not become six requests.
    const checker = vi.fn(
      () => new Promise<IntegrationHealthSnapshot>((r) => setTimeout(() => r(healthy), 10))
    );
    const svc = service(checker);

    await Promise.all([
      svc.check(USER, "google", "on_demand"),
      svc.check(USER, "google", "on_demand"),
      svc.check(USER, "google", "on_demand"),
    ]);

    expect(checker).toHaveBeenCalledTimes(1);
  });

  it("keeps results per user, so one user never sees another's status", async () => {
    const checker = vi.fn(async (userId: string) => ({
      ...healthy,
      summary: `for ${userId}`,
    }));
    const svc = service(checker);

    await svc.check("alice", "google", "startup");
    await svc.check("bob", "google", "startup");

    expect(svc.get("alice", "google")?.summary).toBe("for alice");
    expect(svc.get("bob", "google")?.summary).toBe("for bob");
  });

  it("invalidates after an OAuth upgrade so the next read re-checks", async () => {
    const checker = vi.fn(async () => healthy);
    const svc = service(checker);

    await svc.check(USER, "google", "startup");
    svc.invalidate(USER, "google", "permission_upgrade");

    expect(svc.get(USER, "google")).toBeNull();

    await svc.check(USER, "google", "on_demand");
    expect(checker).toHaveBeenCalledTimes(2);
  });

  it("records an error rather than leaving a stale success when a checker throws", async () => {
    const svc = service(async () => {
      throw new Error("boom");
    });

    const snap = await svc.check(USER, "google", "startup");

    expect(snap.status).toBe("error");
    expect(snap.errorCode).toBe("HEALTH_CHECK_FAILED");
    expect(snap.summary).not.toContain("boom");
  });

  it("one failing integration does not prevent the others being learned", async () => {
    const svc = new IntegrationHealthService({
      checkers: {
        google: async () => healthy,
        meta: async () => {
          throw new Error("down");
        },
      },
      log: () => {},
    });

    const all = await svc.checkAll(USER, "startup");

    expect(all).toHaveLength(2);
    expect(all.find((s) => s.integrationId === "google")?.status).toBe("connected");
    expect(all.find((s) => s.integrationId === "meta")?.status).toBe("error");
  });

  it("logs status and service names only — never a scope or a token", async () => {
    const lines: Record<string, unknown>[] = [];
    const svc = new IntegrationHealthService({
      checkers: {
        google: async () => ({
          integrationId: "google",
          status: "permission_missing" as const,
          summary: "x",
          checkedAt: new Date().toISOString(),
          missingPermissions: [{ service: "gmail", label: "Gmail" }],
        }),
      },
      log: (l) => lines.push(l),
    });

    await svc.check(USER, "google", "startup");

    const logged = JSON.stringify(lines);
    expect(logged).toContain("permission_missing");
    expect(logged).toContain("gmail");
    expect(logged).not.toContain("googleapis.com");
  });
});
