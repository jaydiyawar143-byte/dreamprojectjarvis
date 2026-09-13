// ---------------------------------------------------------------------------
// The scope boundary, pinned exhaustively.
//
// The existing progressive-permissions tests in integration-write-security
// check this for Gmail. That is the case someone thinks to check; the risk is
// the service nobody thought about — a Sheets or Docs write scope reaching the
// initial consent screen because a catalogue entry was edited without anyone
// re-reading `scopesForConnect`.
//
// So these iterate the WHOLE catalogue rather than naming services, and assert
// the exact upgrade set for the three actions this phase can actually perform.
// A new service added with a write scope is caught here automatically.
//
// WHY THE INITIAL CONNECTION MATTERS SO MUCH. The consent screen is the only
// moment the user sees what they are granting. A write scope smuggled in there
// is a permission obtained without a decision, and no later approval gate
// compensates for it — the approval system governs what JARVIS DOES with a
// grant, not whether the grant should have been asked for.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  GOOGLE_SERVICES,
  GOOGLE_IDENTITY_SCOPES,
  scopesForConnect,
  scopesForWriteUpgrade,
  hasWriteAccess,
} from "@jarvis/core";

/** Exactly the write scopes this phase's ten tools need. Nothing else. */
const PHASE_WRITE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

const EVERY_WRITE_SCOPE = GOOGLE_SERVICES.flatMap((s) => s.writeScopes);

describe("an initial connection can never request a write scope", () => {
  it("omits every write scope in the catalogue, for every service combination", () => {
    // Every service at once — the widest request the function can be asked for.
    const all = scopesForConnect(GOOGLE_SERVICES.map((s) => s.id));

    for (const writeScope of EVERY_WRITE_SCOPE) {
      expect(all, `${writeScope} must never be requested at connect`).not.toContain(writeScope);
    }
  });

  it("omits write scopes for each service asked for on its own", () => {
    for (const service of GOOGLE_SERVICES) {
      const scopes = scopesForConnect([service.id]);
      for (const writeScope of service.writeScopes) {
        expect(scopes, `${service.id}: ${writeScope}`).not.toContain(writeScope);
      }
    }
  });

  it("always includes identity, which names the account without granting data access", () => {
    const scopes = scopesForConnect([]);
    for (const identity of GOOGLE_IDENTITY_SCOPES) {
      expect(scopes).toContain(identity);
    }
    expect(scopes).toHaveLength(GOOGLE_IDENTITY_SCOPES.length);
  });

  it("has no parameter by which a caller could ask for write access", () => {
    // Containment by construction rather than by discipline: the catalogue is
    // the allowlist and only `readScopes` is read from it.
    const fabricated = scopesForConnect([
      "gmail",
      "drive",
      "calendar",
      // A caller trying to name a scope directly gets nothing.
      "https://www.googleapis.com/auth/gmail.compose",
    ]);
    expect(fabricated).not.toContain("https://www.googleapis.com/auth/gmail.compose");
  });
});

describe("the write upgrade grants exactly the three scopes this phase performs", () => {
  it("requests gmail.compose, drive.file and calendar.events and no other write scope", () => {
    const upgraded = scopesForWriteUpgrade(["gmail", "drive", "calendar"]);

    for (const scope of PHASE_WRITE_SCOPES) {
      expect(upgraded).toContain(scope);
    }

    // Nothing broader. `drive` (full), `spreadsheets`, `documents` and
    // `youtube.upload` all exist in the catalogue and must stay out.
    const unexpected = EVERY_WRITE_SCOPE.filter(
      (s) => !PHASE_WRITE_SCOPES.includes(s as (typeof PHASE_WRITE_SCOPES)[number])
    );
    for (const scope of unexpected) {
      expect(upgraded, `${scope} is outside this phase`).not.toContain(scope);
    }
  });

  it("upgrades one service without dragging the others along", () => {
    const gmailOnly = scopesForWriteUpgrade(["gmail"]);

    expect(gmailOnly).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(gmailOnly).not.toContain("https://www.googleapis.com/auth/drive.file");
    expect(gmailOnly).not.toContain("https://www.googleapis.com/auth/calendar.events");
  });

  it("keeps the read scope, so an upgrade is never a downgrade", () => {
    const upgraded = scopesForWriteUpgrade(["drive"]);
    expect(upgraded).toContain("https://www.googleapis.com/auth/drive.readonly");
  });

  it("drops an unknown service rather than forwarding it to Google", () => {
    const scopes = scopesForWriteUpgrade(["gmail", "not-a-service"]);
    expect(scopes.some((s) => s.includes("not-a-service"))).toBe(false);
  });
});

describe("write access is judged on what Google granted, not what was asked", () => {
  it("reports no write access when only the read scope came back", () => {
    // The real partial-grant case: the user unticked the write permission.
    expect(hasWriteAccess("gmail", ["https://www.googleapis.com/auth/gmail.readonly"])).toBe(false);
  });

  it("reports write access only with the exact write scope", () => {
    expect(
      hasWriteAccess("gmail", [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ])
    ).toBe(true);
  });

  it("does not accept a neighbouring service's write scope", () => {
    expect(hasWriteAccess("drive", ["https://www.googleapis.com/auth/calendar.events"])).toBe(false);
  });

  it("reports no write access for a service this build cannot write to", () => {
    // `ads` is read-only in this system; there is no write scope to grant.
    expect(hasWriteAccess("ads", ["https://www.googleapis.com/auth/adwords"])).toBe(false);
  });
});
