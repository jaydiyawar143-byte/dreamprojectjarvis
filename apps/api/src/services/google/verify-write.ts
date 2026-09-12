// ---------------------------------------------------------------------------
// Post-write verification — did the change actually land?
//
// "The provider returned 200" and "the change is there" are different claims,
// and only the second deserves the word `verified`. So after a successful write
// the resource is READ BACK and compared against what the plan promised.
//
// VERIFICATION FAILURE IS NOT EXECUTION FAILURE. The write happened; our
// confirmation of it did not. Those have different remedies — a failed
// execution may sometimes be retried, a failed verification must be looked at
// by a person — so they stay separate facts and are never merged.
//
// COMPARISON IS AGAINST THE PLAN, NOT THE RESPONSE. Comparing the write's own
// response to itself would confirm nothing. The point is to confirm the user's
// APPROVED INTENT, so the expected values come from `plan.params`.
//
// WHAT CANNOT BE CHECKED SAYS SO. Gmail is the honest hard case:
// `gmail.compose` can create and send but cannot read the mailbox, so
// confirming a draft or a delivered message needs `gmail.readonly`, which this
// phase deliberately does not require. That returns
// `verification_unavailable` rather than being quietly downgraded to
// `provider_reported` — "we could not check" and "we did not check" are
// different things, and only one of them suggests adding a scope.
//
// A THROWN VERIFIER NEVER FAILS THE WRITE. The write stands; the check did not
// happen. Any exception becomes `verification_unavailable`.
// ---------------------------------------------------------------------------

import type {
  GoogleWriteAction,
  GoogleWritePlan,
  WriteVerification,
} from "@jarvis/core";
import type { GoogleCalendarService, GoogleDriveService } from "@jarvis/google-workspace";

const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export interface VerifyDeps {
  /**
   * READ clients, separate instances from the write services.
   *
   * Verification is a read, and handing the verifier a write client would let a
   * future edit "verify" by writing again.
   */
  driveRead: GoogleDriveService;
  calendarRead: GoogleCalendarService;
}

export interface VerifyOutcome {
  verification: WriteVerification;
  /** Why, in one sentence. Shown to the user; never carries content or a token. */
  detail?: string;
}

export async function verifyWrite(
  action: GoogleWriteAction,
  accessToken: string,
  plan: GoogleWritePlan,
  providerResult: unknown,
  grantedScopes: readonly string[],
  deps: VerifyDeps,
  signal?: AbortSignal
): Promise<VerifyOutcome> {
  const params = plan.params ?? {};
  const str = (key: string): string =>
    typeof params[key] === "string" ? (params[key] as string) : "";
  const body = (providerResult ?? {}) as Record<string, unknown>;

  try {
    switch (action) {
      // --- Drive -----------------------------------------------------------
      // `drive.file` grants read access to files this application created, so
      // a re-read works on exactly the files this phase is able to write. No
      // additional scope is needed.
      case "drive.createFolder":
      case "drive.uploadFile":
      case "drive.moveFile":
      case "drive.renameFile": {
        const fileId = String(body.id ?? str("fileId") ?? "");
        if (!fileId) {
          return { verification: "provider_reported", detail: "no resource id was returned" };
        }

        const reread = await deps.driveRead.getFileMetadata(accessToken, fileId, signal);
        if (!reread.ok) {
          return {
            verification: "verification_unavailable",
            detail: `the file could not be re-read: ${reread.message}`,
          };
        }

        const expectedName = action === "drive.renameFile" ? str("newName") : str("name");
        if (expectedName && reread.body.name !== expectedName) {
          return {
            verification: "verification_failed",
            detail: `expected the name "${expectedName}" but found "${reread.body.name}"`,
          };
        }

        if (action === "drive.moveFile") {
          const destination = str("addParentId");
          if (destination && !reread.body.parents.includes(destination)) {
            return {
              verification: "verification_failed",
              detail: "the file is not in the destination folder",
            };
          }
        }

        if (reread.body.trashed) {
          return { verification: "verification_failed", detail: "the file is in the trash" };
        }

        return { verification: "verified" };
      }

      // --- Calendar create / update ----------------------------------------
      // `calendar.events` covers reading events as well as changing them.
      case "calendar.createEvent":
      case "calendar.updateEvent": {
        const eventId = String(body.id ?? str("eventId") ?? "");
        if (!eventId) {
          return { verification: "provider_reported", detail: "no resource id was returned" };
        }

        const reread = await deps.calendarRead.getEvent(
          accessToken,
          eventId,
          str("calendarId") || "primary",
          signal
        );
        if (!reread.ok) {
          return {
            verification: "verification_unavailable",
            detail: `the event could not be re-read: ${reread.message}`,
          };
        }

        const expectedSummary = str("summary");
        if (expectedSummary && reread.body.summary !== expectedSummary) {
          return {
            verification: "verification_failed",
            detail: `expected the title "${expectedSummary}" but found "${reread.body.summary}"`,
          };
        }
        if (reread.body.status === "cancelled") {
          return { verification: "verification_failed", detail: "the event is cancelled" };
        }

        return { verification: "verified" };
      }

      // --- Calendar delete --------------------------------------------------
      // ABSENCE is the expected state here, which inverts the check: a
      // successful re-read is the failure case.
      case "calendar.deleteEvent": {
        const reread = await deps.calendarRead.getEvent(
          accessToken,
          str("eventId"),
          str("calendarId") || "primary",
          signal
        );

        if (!reread.ok) {
          return { verification: "verified", detail: "the event is gone" };
        }
        if (reread.body.status === "cancelled") {
          return { verification: "verified", detail: "the event is marked cancelled" };
        }

        return {
          verification: "verification_failed",
          detail: "the event still exists and is not cancelled",
        };
      }

      // --- Gmail drafts -----------------------------------------------------
      case "gmail.createDraft":
      case "gmail.updateDraft": {
        const draftId = String(body.draftId ?? "");
        if (!draftId) {
          return { verification: "verification_failed", detail: "no draft id was returned" };
        }
        return {
          verification: "verification_unavailable",
          detail:
            "the draft id was returned, but confirming it needs gmail.readonly, which this phase does not request",
        };
      }

      // --- Gmail send -------------------------------------------------------
      case "gmail.sendDraft": {
        const messageId = String(body.messageId ?? "");
        if (!messageId) {
          // A send that produced no message did not send.
          return { verification: "verification_failed", detail: "no message id was returned" };
        }

        // The strongest check available without reading the mailbox: Gmail
        // returns the resulting message's labels, and a genuinely sent message
        // carries SENT.
        const labels = Array.isArray(body.labelIds) ? (body.labelIds as string[]) : [];
        if (labels.includes("SENT")) {
          return { verification: "verified", detail: "Gmail reported the message as SENT" };
        }

        return {
          verification: "verification_unavailable",
          detail: grantedScopes.includes(GMAIL_READ_SCOPE)
            ? "a message id was returned but no SENT label was present"
            : "confirming delivery needs gmail.readonly, which this phase does not request",
        };
      }
    }
  } catch {
    // The write stands. Only the check failed.
    return {
      verification: "verification_unavailable",
      detail: "the re-read could not be completed",
    };
  }
}
