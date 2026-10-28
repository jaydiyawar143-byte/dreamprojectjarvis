// ---------------------------------------------------------------------------
// Phase 18, Stage 18.2 — the Automation Library's shared request rules, its
// chain contract and the voice policy.
//
// The API router and the JARVIS tools validate with these same functions, so
// an equivalent request is accepted or refused identically on both — these
// tests pin the rules once. Named `automation-library*` so CI's core slice
// runs them.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  AUTOMATION_LIBRARY_TOOL_IDS,
  InputModeSchema,
  JarvisRequestSchema,
  LIBRARY_CHAIN_MAX_PAGES,
  LIBRARY_CHAIN_MAX_RUNS,
  LIBRARY_CHAIN_STOP_MESSAGES,
  LIBRARY_FAILURE_MESSAGES,
  LIBRARY_LIST_LIMIT_MAX,
  LIBRARY_MAX_PAGES_PER_RUN,
  LIBRARY_MAX_PAGES_PER_SCAN,
  LIBRARY_RETRYABLE_FAILURES,
  SessionContextSchema,
  VOICE_APPROVAL_POLICY,
  VOICE_CONFIRMATION_REFUSED_MESSAGE,
  VOICE_REFUSED_TOOLS,
  VOICE_TOOL_REFUSED_CODE,
  deriveLibraryState,
  isRetryableLibraryFailure,
  namesLibraryServerScope,
  validateLibraryEntryQuery,
  validateLibrarySyncOptions,
  voiceConfirmationRefusal,
  voiceToolRefusal,
  type LibraryFailureCode,
} from "../src/index.js";

describe("the catalog query — one rule for the URL and the tool", () => {
  it("defaults, trims and bounds", () => {
    expect(validateLibraryEntryQuery({})).toEqual({ page: 1, limit: 50 });
    expect(validateLibraryEntryQuery({ page: "2", limit: "20", search: "  Invoice ", active: "true", presence: "missing" })).toEqual({
      page: 2,
      limit: 20,
      search: "Invoice",
      active: true,
      presence: "missing",
    });
    // A tool's typed values reach the same answer as a URL's strings.
    expect(validateLibraryEntryQuery({ page: 2, limit: 20, search: "Invoice", active: true, presence: "missing" })).toEqual(
      validateLibraryEntryQuery({ page: "2", limit: "20", search: "Invoice", active: "true", presence: "missing" })
    );
    expect(validateLibraryEntryQuery({ search: "   " })).toEqual({ page: 1, limit: 50 });
  });

  it("refuses what is out of bounds or not a value", () => {
    for (const bad of [
      { page: 0 },
      { page: "1.5" },
      { page: 100_001 },
      { limit: LIBRARY_LIST_LIMIT_MAX + 1 },
      { limit: "ten" },
      { search: "x".repeat(101) },
      { search: 5 },
      { active: "yes" },
      { presence: "gone" },
      { presence: ["all"] },
      { page: { $gt: 1 } },
    ]) {
      expect(validateLibraryEntryQuery(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the sync options", () => {
  it("accepts booleans and a bounded key, and nothing else", () => {
    expect(validateLibrarySyncOptions({})).toEqual({ restart: false, continueUntilComplete: false });
    expect(validateLibrarySyncOptions({ continueUntilComplete: true, idempotencyKey: "0b5c6f1e-aa27-4f3e-9a3b-1d2c3e4f5a6b" })).toEqual({
      restart: false,
      continueUntilComplete: true,
      idempotencyKey: "0b5c6f1e-aa27-4f3e-9a3b-1d2c3e4f5a6b",
    });
    for (const bad of [
      { restart: "maybe" },
      { continueUntilComplete: 1 },
      { idempotencyKey: "short" },
      { idempotencyKey: "x".repeat(65) },
      { idempotencyKey: "has space in it" },
      { idempotencyKey: 12345678 },
    ]) {
      expect(validateLibrarySyncOptions(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("what only the server decides", () => {
  it("is refused under any spelling", () => {
    for (const key of ["tenantId", "tenant_id", "organizationId", "ORG-ID", "baseUrl", "url", "cursor", "scanId", "instanceKey", "userId", "apiKey", "credential", "token"]) {
      expect(namesLibraryServerScope({ [key]: "x" }), key).toBe(true);
    }
    expect(namesLibraryServerScope({ search: "x", page: 1, continueUntilComplete: true, idempotencyKey: "abcdefgh" })).toBe(false);
    expect(namesLibraryServerScope(null)).toBe(false);
    expect(namesLibraryServerScope("tenantId")).toBe(false);
  });
});

describe("a chain's hard limits and its words", () => {
  it("keeps every chain inside the scan's own bound", () => {
    expect(LIBRARY_CHAIN_MAX_PAGES).toBeLessThanOrEqual(LIBRARY_CHAIN_MAX_RUNS * LIBRARY_MAX_PAGES_PER_RUN);
    expect(LIBRARY_CHAIN_MAX_PAGES).toBeLessThanOrEqual(LIBRARY_MAX_PAGES_PER_SCAN);
  });

  it("retries only what is transient — never a refusal, a rejected cursor or a lost lease", () => {
    expect([...LIBRARY_RETRYABLE_FAILURES].sort()).toEqual(
      ["PERSISTENCE_FAILED", "PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"].sort()
    );
    const never: LibraryFailureCode[] = [
      "PROVIDER_AUTH_FAILED",
      "PROVIDER_REJECTED_REQUEST",
      "PROVIDER_RESPONSE_INVALID",
      "CURSOR_REJECTED",
      "CURSOR_CYCLE",
      "SCAN_TOO_LONG",
      "LEASE_LOST",
      "INTERRUPTED",
    ];
    for (const code of never) expect(isRetryableLibraryFailure(code), code).toBe(false);
    expect(isRetryableLibraryFailure(null)).toBe(false);
  });

  it("says why a chain stopped in fixed sentences that never claim completion", () => {
    for (const [code, message] of Object.entries(LIBRARY_CHAIN_STOP_MESSAGES)) {
      expect(message.length, code).toBeGreaterThan(10);
      expect(message, code).not.toMatch(/\bcomplete[sd]?\b(?! scan)|finished the scan|is up to date/i);
      expect(message, code).not.toMatch(/https?:|token|password|secret/i);
    }
    for (const message of Object.values(LIBRARY_FAILURE_MESSAGES)) expect(message).not.toMatch(/https?:/i);
  });

  it("shows a live chain as running, between its runs too", () => {
    const between = { leaseHeld: false, latestRunStatus: "PARTIAL" as const, scanOpen: true, lastCompleteAt: null };
    expect(deriveLibraryState(between)).toBe("partial");
    expect(deriveLibraryState({ ...between, chainActive: true })).toBe("running");
    expect(deriveLibraryState({ ...between, chainActive: false })).toBe("partial");
  });
});

describe("what speech may not start", () => {
  it("refuses the library sync for a spoken turn, and only for one", () => {
    expect(voiceToolRefusal(AUTOMATION_LIBRARY_TOOL_IDS.sync, "voice")).toMatch(/cannot be started or continued by voice/);
    expect(voiceToolRefusal(AUTOMATION_LIBRARY_TOOL_IDS.sync, "text")).toBeNull();
    expect(voiceToolRefusal(AUTOMATION_LIBRARY_TOOL_IDS.sync, undefined)).toBeNull();
    // The reads stay available to voice.
    expect(voiceToolRefusal(AUTOMATION_LIBRARY_TOOL_IDS.search, "voice")).toBeNull();
    expect(voiceToolRefusal(AUTOMATION_LIBRARY_TOOL_IDS.status, "voice")).toBeNull();
    // An inherited name is not a listed tool.
    expect(voiceToolRefusal("constructor", "voice")).toBeNull();
    // Phase 19.1 adds sensitive browser/desktop actions to the same list; this
    // test owns the library's entry, so it asserts presence rather than the
    // whole evolving list.
    expect(Object.keys(VOICE_REFUSED_TOOLS)).toContain(AUTOMATION_LIBRARY_TOOL_IDS.sync);
    expect(VOICE_TOOL_REFUSED_CODE).toBe("VOICE_NOT_ALLOWED");
  });

  it("never lets a spoken turn confirm — the locked VOICE_APPROVAL_POLICY, enforced (Phase 18.3A)", () => {
    expect(VOICE_APPROVAL_POLICY.canConfirmPendingActions).toBe(false);
    expect(voiceConfirmationRefusal("voice")).toBe(VOICE_CONFIRMATION_REFUSED_MESSAGE);
    expect(voiceConfirmationRefusal("text")).toBeNull();
    expect(voiceConfirmationRefusal(undefined)).toBeNull();
    // The sentence names no action, id or parameter, and points to the screen.
    expect(VOICE_CONFIRMATION_REFUSED_MESSAGE).toMatch(/on screen/);
    expect(VOICE_CONFIRMATION_REFUSED_MESSAGE).not.toMatch(/\d|https?:|token/i);
  });

  it("carries the input mode on the request and the session, and nothing else", () => {
    expect(InputModeSchema.options).toEqual(["text", "voice"]);
    expect(JarvisRequestSchema.parse({ message: "hi", inputMode: "voice" }).inputMode).toBe("voice");
    expect(JarvisRequestSchema.safeParse({ message: "hi", inputMode: "shout" }).success).toBe(false);
    expect(JarvisRequestSchema.parse({ message: "hi" }).inputMode).toBeUndefined();
    const session = SessionContextSchema.parse({
      auth: { userId: "u", role: "owner", email: "u@test.local" },
      traceId: "6f1c1b8e-2a4f-4c3a-9d55-6a1f2e3b4c5d",
      inputMode: "voice",
    });
    expect(session.inputMode).toBe("voice");
  });
});
