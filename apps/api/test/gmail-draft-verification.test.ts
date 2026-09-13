// ---------------------------------------------------------------------------
// Gmail draft re-read verification.
//
// Until now every draft came back `verification_unavailable`, because the phase
// requested no Gmail read scope and said so honestly. Connections now hold
// `gmail.readonly`, so the draft can actually be confirmed against what the
// user approved rather than taken on the provider's word.
//
// The distinction these protect is the one with consequences: "we could not
// look" and "we looked and it disagreed" must never collapse into each other.
// The first is the normal state on a compose-only connection. The second means
// something exists in the mailbox that is not what was approved — and the user
// has to be told, because no retry fixes it.
//
// NOTHING FROM THE MESSAGE MAY ESCAPE. A verification detail is shown on screen
// and written to logs, so the body is compared by DIGEST and the recipients by
// count. The last block asserts that.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { verifyWrite, type VerifyDeps } from "../src/services/google/verify-write.js";
import type { GoogleWritePlan } from "@jarvis/core";

const TOKEN = "access-token-not-a-real-one";
const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE_ONLY = ["https://www.googleapis.com/auth/gmail.compose"];

const APPROVED_BODY = "Hello there,\nThe numbers are attached.";

function draftPlan(over: Record<string, unknown> = {}): GoogleWritePlan {
  return {
    params: {
      to: ["Person <Person@Example.com>"],
      subject: "Quarterly update",
      body: APPROVED_BODY,
      ...over,
    },
    requestId: "req-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: "idem-1",
  } as unknown as GoogleWritePlan;
}

/** A Gmail READ double returning one draft. */
function gmailReturning(over: Record<string, unknown> = {}) {
  const getDraft = vi.fn(async () => ({
    ok: true as const,
    body: {
      draftId: "draft-1",
      messageId: "msg-1",
      to: ["person@example.com"],
      subject: "Quarterly update",
      body: APPROVED_BODY,
      labels: ["DRAFT"],
      ...over,
    },
  }));
  return { getDraft };
}

function gmailFailing(message = "403 forbidden") {
  const getDraft = vi.fn(async () => ({ ok: false as const, message }));
  return { getDraft };
}

function deps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    driveRead: { getFileMetadata: async () => ({ ok: false, message: "unused" }) } as never,
    calendarRead: { getEvent: async () => ({ ok: false, message: "unused" }) } as never,
    ...over,
  } as VerifyDeps;
}

// ---------------------------------------------------------------------------

describe("verified only when the re-read matches", () => {
  it("verifies a draft whose recipients, subject and body all match", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({ gmailRead: gmailReturning() as never })
    );

    expect(out.verification).toBe("verified");
  });

  it("ignores display names and case in recipients", async () => {
    // Gmail reformats "Person <Person@Example.com>". Not a discrepancy.
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({ gmailRead: gmailReturning({ to: ["PERSON@example.com"] }) as never })
    );

    expect(out.verification).toBe("verified");
  });

  it("ignores CRLF and trailing whitespace in the body", async () => {
    // Gmail re-wraps and pads. A draft differing only in line endings is the
    // same draft, and calling that a mismatch would cry wolf on every send.
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({
        gmailRead: gmailReturning({
          body: "Hello there,\r\nThe numbers are attached.   \n",
        }) as never,
      })
    );

    expect(out.verification).toBe("verified");
  });

  it("verifies an update the same way", async () => {
    const out = await verifyWrite(
      "gmail.updateDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({ gmailRead: gmailReturning() as never })
    );

    expect(out.verification).toBe("verified");
  });
});

describe("a mismatch is a failure, not an outage", () => {
  it("fails when the recipients differ", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({ gmailRead: gmailReturning({ to: ["someone.else@example.com"] }) as never })
    );

    expect(out.verification).toBe("verification_failed");
    // The count is safe to state; the addresses are not.
    expect(out.detail ?? "").not.toContain("example.com");
  });

  it("fails when the subject differs", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({ gmailRead: gmailReturning({ subject: "Something else entirely" }) as never })
    );

    expect(out.verification).toBe("verification_failed");
  });

  it("fails when the body differs, quoting neither version", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({ gmailRead: gmailReturning({ body: "Completely different text." }) as never })
    );

    expect(out.verification).toBe("verification_failed");
    expect(out.detail ?? "").not.toContain("Completely different");
    expect(out.detail ?? "").not.toContain("numbers are attached");
  });

  it("fails when a different draft comes back", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({ gmailRead: gmailReturning({ draftId: "draft-999" }) as never })
    );

    expect(out.verification).toBe("verification_failed");
  });

  it("fails loudly when the message was SENT rather than left as a draft", async () => {
    // The one that would matter most: creating a draft must never dispatch
    // mail, and if it somehow did the user has to hear about it immediately.
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({ gmailRead: gmailReturning({ labels: ["SENT"] }) as never })
    );

    expect(out.verification).toBe("verification_failed");
    expect(out.detail).toMatch(/sent/i);
  });

  it("fails when no draft id was returned at all", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      {},
      [GMAIL_READ],
      deps({ gmailRead: gmailReturning() as never })
    );

    expect(out.verification).toBe("verification_failed");
  });
});

describe("unavailable only when we genuinely could not look", () => {
  it("reports unavailable on a compose-only connection, without calling Gmail", async () => {
    const gmailRead = gmailReturning();

    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      COMPOSE_ONLY,
      deps({ gmailRead: gmailRead as never })
    );

    expect(out.verification).toBe("verification_unavailable");
    expect(out.detail).toContain("gmail.readonly");
    // Spending a request to earn a 403 that means the same thing is waste.
    expect(gmailRead.getDraft).not.toHaveBeenCalled();
  });

  it("reports unavailable when the re-read itself fails", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({ gmailRead: gmailFailing("rate limited") as never })
    );

    // Nothing disagreed — we could not look.
    expect(out.verification).toBe("verification_unavailable");
    expect(out.verification).not.toBe("verification_failed");
  });

  it("reports unavailable when no Gmail read client is configured", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({})
    );

    expect(out.verification).toBe("verification_unavailable");
  });

  it("never fails the write when the reader throws", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({
        gmailRead: {
          getDraft: async () => {
            throw new Error("socket hang up");
          },
        } as never,
      })
    );

    // The draft stands. Only the check did not happen.
    expect(out.verification).toBe("verification_unavailable");
  });
});

describe("verification never leaks the message", () => {
  it("puts no body text, recipient or token in the detail", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      draftPlan(),
      { draftId: "draft-1" },
      [GMAIL_READ],
      deps({
        gmailRead: gmailReturning({ body: "Secret internal numbers: 4,200." }) as never,
      })
    );

    const detail = out.detail ?? "";
    expect(detail).not.toContain("Secret internal numbers");
    expect(detail).not.toContain("4,200");
    expect(detail).not.toContain("person@example.com");
    expect(detail).not.toContain(TOKEN);
  });

  it("reads only — the verifier is given no client that can write or send", () => {
    // Structural: `gmailRead` is a GmailService (read). The write client lives
    // on the service and is never passed here, so no edit to this file can
    // "verify" by sending.
    const passed = Object.keys(deps({ gmailRead: gmailReturning() as never }));
    expect(passed.sort()).toEqual(["calendarRead", "driveRead", "gmailRead"]);
  });
});
