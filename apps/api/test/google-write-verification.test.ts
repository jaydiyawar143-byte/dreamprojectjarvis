// ---------------------------------------------------------------------------
// Post-write verification: is the word "verified" earned?
//
// `verify-write.ts` had no tests. It is the component that decides whether the
// user is told "done and confirmed" or "done, we could not check" — and the
// difference is not cosmetic. A UI that says "verified" on the provider's word
// alone trains the user to trust a claim nobody checked, and the one time it
// matters is the one time the write silently did not land.
//
// Four distinctions are pinned here, and the last two are the ones that are
// easy to collapse under pressure:
//
//   verified                 re-read, and it matched
//   provider_reported        no re-read attempted (no resource id came back)
//   verification_unavailable a re-read was not possible with these scopes
//   verification_failed      re-read happened and DISAGREED
//
// `verification_failed` is NOT an execution failure. The write happened. A
// caller that merges the two invites a retry of a change that already took
// effect — for `gmail.sendDraft` that is a second email to a real person.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { verifyWrite, type VerifyDeps } from "../src/services/google/verify-write.js";
import type { GoogleWritePlan } from "@jarvis/core";

const TOKEN = "access-token-not-a-real-one";
const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";

function plan(params: Record<string, unknown>): GoogleWritePlan {
  return {
    params,
    requestId: "req-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: "idem-1",
  } as unknown as GoogleWritePlan;
}

/** Drive/Calendar read doubles. Only the two methods the verifier calls. */
function deps(overrides?: {
  file?: unknown;
  event?: unknown;
  onGetFile?: () => unknown;
  onGetEvent?: () => unknown;
}): VerifyDeps {
  return {
    driveRead: {
      getFileMetadata: vi.fn(async () => {
        if (overrides?.onGetFile) return overrides.onGetFile();
        return overrides?.file ?? { ok: true, body: { name: "Q4 Reports", parents: [], trashed: false } };
      }),
    },
    calendarRead: {
      getEvent: vi.fn(async () => {
        if (overrides?.onGetEvent) return overrides.onGetEvent();
        return overrides?.event ?? { ok: true, body: { summary: "Standup", status: "confirmed" } };
      }),
    },
  } as unknown as VerifyDeps;
}

// ---------------------------------------------------------------------------

describe("Drive — a re-read is possible, so verified must be earned", () => {
  it("verifies a created folder whose name matches the approved plan", async () => {
    const out = await verifyWrite(
      "drive.createFolder",
      TOKEN,
      plan({ name: "Q4 Reports" }),
      { id: "file-1" },
      [],
      deps()
    );

    expect(out.verification).toBe("verified");
  });

  it("compares against the PLAN, not against the write's own response", async () => {
    // The provider says it made "Something Else"; the user approved "Q4
    // Reports". Comparing the response to itself would confirm nothing.
    const out = await verifyWrite(
      "drive.createFolder",
      TOKEN,
      plan({ name: "Q4 Reports" }),
      { id: "file-1" },
      [],
      deps({ file: { ok: true, body: { name: "Something Else", parents: [], trashed: false } } })
    );

    expect(out.verification).toBe("verification_failed");
    expect(out.detail).toContain("Q4 Reports");
  });

  it("fails verification when the created file is in the trash", async () => {
    const out = await verifyWrite(
      "drive.createFolder",
      TOKEN,
      plan({ name: "Q4 Reports" }),
      { id: "file-1" },
      [],
      deps({ file: { ok: true, body: { name: "Q4 Reports", parents: [], trashed: true } } })
    );

    expect(out.verification).toBe("verification_failed");
    expect(out.detail).toContain("trash");
  });

  it("fails verification when a moved file is not in the destination", async () => {
    const out = await verifyWrite(
      "drive.moveFile",
      TOKEN,
      plan({ fileId: "file-1", addParentId: "folder-target" }),
      { id: "file-1" },
      [],
      deps({ file: { ok: true, body: { name: "", parents: ["folder-other"], trashed: false } } })
    );

    expect(out.verification).toBe("verification_failed");
  });

  it("reports provider_reported — never verified — when no resource id came back", async () => {
    const out = await verifyWrite(
      "drive.createFolder",
      TOKEN,
      plan({ name: "Q4 Reports" }),
      {},
      [],
      deps()
    );

    expect(out.verification).toBe("provider_reported");
  });

  it("reports verification_unavailable when the re-read itself fails", async () => {
    // Distinct from `verification_failed`: nothing disagreed, we could not look.
    const out = await verifyWrite(
      "drive.createFolder",
      TOKEN,
      plan({ name: "Q4 Reports" }),
      { id: "file-1" },
      [],
      deps({ file: { ok: false, message: "rate limited" } })
    );

    expect(out.verification).toBe("verification_unavailable");
  });
});

describe("Calendar — presence for a create, absence for a delete", () => {
  it("verifies a created event whose title matches", async () => {
    const out = await verifyWrite(
      "calendar.createEvent",
      TOKEN,
      plan({ summary: "Standup" }),
      { id: "evt-1" },
      [],
      deps()
    );

    expect(out.verification).toBe("verified");
  });

  it("fails verification when the event came back cancelled", async () => {
    const out = await verifyWrite(
      "calendar.createEvent",
      TOKEN,
      plan({ summary: "Standup" }),
      { id: "evt-1" },
      [],
      deps({ event: { ok: true, body: { summary: "Standup", status: "cancelled" } } })
    );

    expect(out.verification).toBe("verification_failed");
  });

  it("treats a deleted event that is GONE as verified — absence is the goal", async () => {
    const out = await verifyWrite(
      "calendar.deleteEvent",
      TOKEN,
      plan({ eventId: "evt-1" }),
      {},
      [],
      deps({ event: { ok: false, message: "404 not found" } })
    );

    expect(out.verification).toBe("verified");
  });

  it("fails verification when a deleted event is still there", async () => {
    const out = await verifyWrite(
      "calendar.deleteEvent",
      TOKEN,
      plan({ eventId: "evt-1" }),
      {},
      [],
      deps({ event: { ok: true, body: { summary: "Standup", status: "confirmed" } } })
    );

    expect(out.verification).toBe("verification_failed");
  });
});

describe("Gmail — honest about what these scopes cannot confirm", () => {
  it("does not claim a draft is verified, because gmail.compose cannot read it back", async () => {
    const out = await verifyWrite(
      "gmail.createDraft",
      TOKEN,
      plan({ subject: "Hello" }),
      { draftId: "draft-1" },
      ["https://www.googleapis.com/auth/gmail.compose"],
      deps()
    );

    expect(out.verification).toBe("verification_unavailable");
    expect(out.detail).toContain("gmail.readonly");
  });

  it("fails verification when a draft write returned no draft id", async () => {
    const out = await verifyWrite("gmail.createDraft", TOKEN, plan({}), {}, [], deps());

    expect(out.verification).toBe("verification_failed");
  });

  it("verifies a send when Gmail itself reports the SENT label", async () => {
    const out = await verifyWrite(
      "gmail.sendDraft",
      TOKEN,
      plan({ draftId: "draft-1" }),
      { messageId: "msg-1", labelIds: ["SENT", "INBOX"] },
      [],
      deps()
    );

    expect(out.verification).toBe("verified");
  });

  it("does not claim a send is verified on a message id alone", async () => {
    const out = await verifyWrite(
      "gmail.sendDraft",
      TOKEN,
      plan({ draftId: "draft-1" }),
      { messageId: "msg-1" },
      [],
      deps()
    );

    expect(out.verification).toBe("verification_unavailable");
  });

  it("says WHY confirmation was impossible, differently per scope", async () => {
    const withRead = await verifyWrite(
      "gmail.sendDraft",
      TOKEN,
      plan({}),
      { messageId: "msg-1" },
      [GMAIL_READ],
      deps()
    );
    const withoutRead = await verifyWrite(
      "gmail.sendDraft",
      TOKEN,
      plan({}),
      { messageId: "msg-1" },
      [],
      deps()
    );

    expect(withRead.detail).toContain("no SENT label");
    expect(withoutRead.detail).toContain("gmail.readonly");
  });

  it("treats a send with no message id as a failed verification", async () => {
    const out = await verifyWrite("gmail.sendDraft", TOKEN, plan({}), {}, [], deps());

    expect(out.verification).toBe("verification_failed");
  });
});

describe("verification can never take the write down with it", () => {
  it("returns verification_unavailable when the verifier throws", async () => {
    const out = await verifyWrite(
      "drive.createFolder",
      TOKEN,
      plan({ name: "Q4" }),
      { id: "file-1" },
      [],
      deps({
        onGetFile: () => {
          throw new Error("socket hang up");
        },
      })
    );

    // Not "failed": the write stands, only the check did not happen.
    expect(out.verification).toBe("verification_unavailable");
  });

  it("never returns the execution-failure value from a verification path", async () => {
    // `failed` means the write did not happen, which verification is not
    // entitled to conclude — it runs only after a successful write.
    const outcomes = await Promise.all([
      verifyWrite("drive.createFolder", TOKEN, plan({ name: "A" }), { id: "f" }, [], deps()),
      verifyWrite("drive.createFolder", TOKEN, plan({ name: "A" }), {}, [], deps()),
      verifyWrite("gmail.createDraft", TOKEN, plan({}), { draftId: "d" }, [], deps()),
      verifyWrite(
        "drive.createFolder",
        TOKEN,
        plan({ name: "A" }),
        { id: "f" },
        [],
        deps({ file: { ok: false, message: "boom" } })
      ),
    ]);

    for (const out of outcomes) {
      expect(out.verification).not.toBe("failed");
      expect(out.verification).not.toBe("indeterminate");
    }
  });

  it("never leaks the access token into the detail shown to a user", async () => {
    const out = await verifyWrite(
      "drive.createFolder",
      TOKEN,
      plan({ name: "Q4 Reports" }),
      { id: "file-1" },
      [],
      deps({ file: { ok: true, body: { name: "Other", parents: [], trashed: false } } })
    );

    expect(out.detail ?? "").not.toContain(TOKEN);
  });
});
