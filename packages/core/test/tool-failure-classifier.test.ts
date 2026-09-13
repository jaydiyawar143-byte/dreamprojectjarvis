// ---------------------------------------------------------------------------
// "Data retrieval failed." — the four words that hid every cause.
//
// When every tool in a turn failed, the Orchestrator returned one fixed
// sentence and put the real cause in `details.reason`, which no client reads.
// A Gmail draft rejected for having no recipient, a Google account that was
// never connected, and a genuine provider outage all reached the user
// identically, and none of the three suggested what to do.
//
// These tests pin both halves of the fix, and the second half matters more than
// the first: the classifier must never become a way for a provider payload, a
// stack frame or a token-shaped string to reach the browser. When it cannot
// recognise a failure it must fall back to exactly the old generic message —
// so an unclassified failure is never worse than it was.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  classifyToolFailure,
  classifyToolFailures,
  isSafeToSurface,
} from "../src/tool-failure-classifier.js";

describe("the real cause reaches the user", () => {
  it("reports a missing recipient as an incomplete request, not a retrieval failure", () => {
    // The exact live failure: gmail.createDraft plan validation.
    const out = classifyToolFailure(
      "At least one recipient is required.",
      "google.plan.gmail.createDraft"
    );

    expect(out.code).toBe("REQUEST_INCOMPLETE");
    expect(out.message).toBe("At least one recipient is required.");
    expect(out.actionable).toBe(true);
    expect(out.message).not.toBe("Data retrieval failed.");
  });

  it("reports an empty body as an incomplete request", () => {
    const out = classifyToolFailure("The message body cannot be empty.", "google.plan.gmail.createDraft");
    expect(out.code).toBe("REQUEST_INCOMPLETE");
  });

  it("names Google as not connected", () => {
    const out = classifyToolFailure("Google is not connected. Connect your Google account.");
    expect(out.code).toBe("GOOGLE_NOT_CONNECTED");
    expect(out.actionable).toBe(true);
  });

  it("names a Gmail permission gap specifically, so the remedy is findable", () => {
    const out = classifyToolFailure(
      "Your Google connection does not include Gmail access.",
      "google.plan.gmail.createDraft"
    );
    expect(out.code).toBe("GMAIL_PERMISSION_MISSING");
  });

  it("promotes a generic permission failure from a Gmail tool to the Gmail code", () => {
    const out = classifyToolFailure("The scope was never granted.", "gmail.listUnread");
    expect(out.code).toBe("GMAIL_PERMISSION_MISSING");
  });

  it("does not promote a permission failure from a non-Gmail tool", () => {
    const out = classifyToolFailure("The scope was never granted.", "drive.searchFiles");
    expect(out.code).toBe("GOOGLE_PERMISSION_MISSING");
  });

  it("reports an expired grant as needing reauthorization", () => {
    const out = classifyToolFailure("Google authorization has expired or been revoked by the provider.");
    expect(out.code).toBe("GOOGLE_REAUTH_REQUIRED");
  });

  it("reports the write throttle as rate limiting", () => {
    const out = classifyToolFailure("Too many write requests. The limit is 20 per minute.");
    expect(out.code).toBe("RATE_LIMITED");
    expect(out.actionable).toBe(true);
  });

  it("reports an approval requirement as such", () => {
    const out = classifyToolFailure("This action requires your approval before it can run.");
    expect(out.code).toBe("APPROVAL_REQUIRED");
  });

  it("reports a timeout as a provider problem, not a user problem", () => {
    const out = classifyToolFailure("The request timed out");
    expect(out.code).toBe("PROVIDER_UNAVAILABLE");
    expect(out.actionable).toBe(false);
  });
});

describe("nothing unsafe is ever surfaced", () => {
  const unsafe: Array<[string, string]> = [
    ["a stack frame", "Error: boom at Object.execute (/app/src/tool.js:42:11)"],
    ["a JSON payload", 'Google API error: {"error":{"code":403,"message":"denied"}}'],
    ["an access token", "Request failed with token ya29.a0AfB_byC3xyz not authorized"],
    ["a refresh token", "Stored 1//04dXm-refresh-value could not be used"],
    ["a client secret", "Bad credentials GOCSPX-abcdefghijklmnop rejected"],
    ["a bearer header", "Upstream rejected Bearer abcdefghijklmnopqrstuvwxyz012345"],
    ["a long opaque id", "Failed for cmtl3vinw0006ssv0el0pa3b3xyzabc987654 unexpectedly"],
    ["a URL with a query", "Redirected to https://accounts.google.com/o/oauth2?code=4/abc"],
    ["a multi-line dump", "Failed to fetch\n  cause: ECONNRESET\n  at fetch"],
  ];

  for (const [what, text] of unsafe) {
    it(`refuses to pass through ${what}`, () => {
      expect(isSafeToSurface(text)).toBe(false);
    });
  }

  it("substitutes a safe fallback rather than an unsafe provider string", () => {
    const out = classifyToolFailure('Google API error: {"error":{"code":503}}');

    // Classified — but the message is the written fallback, not the payload.
    expect(out.message).not.toContain("{");
    expect(out.message).not.toContain("503");
    expect(isSafeToSurface(out.message)).toBe(true);
  });

  it("keeps an ordinary authored sentence", () => {
    expect(isSafeToSurface("At least one recipient is required.")).toBe(true);
  });
});

describe("an unrecognised failure is never made worse", () => {
  it("falls back to the exact previous behaviour", () => {
    const out = classifyToolFailure("zork encountered a grue");

    expect(out.code).toBe("TOOL_EXECUTION_FAILED");
    expect(out.message).toBe("Data retrieval failed.");
    expect(out.actionable).toBe(false);
  });

  it("falls back for empty input", () => {
    expect(classifyToolFailure(undefined).message).toBe("Data retrieval failed.");
    expect(classifyToolFailures([]).message).toBe("Data retrieval failed.");
  });
});

describe("across several failures, the fixable one wins", () => {
  it("prefers an actionable cause over an infrastructural one, whatever the order", () => {
    // Waiting for a recovery that will never come is the failure mode here.
    const out = classifyToolFailures([
      { toolId: "maps.search", error: "The request timed out" },
      { toolId: "google.plan.gmail.createDraft", error: "Google is not connected." },
    ]);

    expect(out.code).toBe("GOOGLE_NOT_CONNECTED");
    expect(out.actionable).toBe(true);
  });

  it("uses an infrastructural cause when nothing is actionable", () => {
    const out = classifyToolFailures([
      { toolId: "maps.search", error: "upstream unavailable" },
      { toolId: "meta.insights", error: "socket hang up" },
    ]);

    expect(out.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("classifies from status when no error string was recorded", () => {
    const out = classifyToolFailures([
      { toolId: "google.plan.gmail.createDraft", status: "permission_missing" },
    ]);

    expect(out.code).toBe("GMAIL_PERMISSION_MISSING");
  });
});
