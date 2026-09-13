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
import { createHash } from "node:crypto";
import type {
  GmailService,
  GoogleCalendarService,
  GoogleDriveService,
} from "@jarvis/google-workspace";

/**
 * A stable digest of a message body.
 *
 * The body is compared but never carried: a verification detail is shown to the
 * user and written to logs, and neither is a place for the contents of their
 * email. Whitespace is normalized first because Gmail re-wraps lines and
 * appends a trailing newline, and a draft that differs only in line breaks is
 * the same draft.
 */
function bodyDigest(text: string): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** `Name <a@b.com>` and ` A@B.com ` are the same recipient. */
function normalizeAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled ? angled[1]! : value).trim().toLowerCase();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

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
  /**
   * Gmail READ client, for confirming a draft.
   *
   * Optional so a deployment without one degrades to
   * `verification_unavailable` rather than failing a write that succeeded.
   */
  gmailRead?: GmailService;
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
  /** A string-array param, e.g. the approved `to` list. */
  const arr = (key: string): string[] =>
    Array.isArray(params[key]) ? (params[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
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
      //
      // Re-read with `gmail.readonly` and compare against the APPROVED plan.
      // Previously this always returned `verification_unavailable`, because the
      // phase did not request a read scope; connections now hold one, so the
      // draft can actually be confirmed rather than taken on trust.
      //
      // The read scope is checked FIRST. A connection with only `gmail.compose`
      // can create the draft perfectly well and simply cannot read it back —
      // that is `verification_unavailable`, not a failure, and calling the API
      // anyway would spend a request to earn a 403 that means the same thing.
      case "gmail.createDraft":
      case "gmail.updateDraft": {
        const draftId = String(body.draftId ?? "");
        if (!draftId) {
          // A draft write that produced no id did not produce a draft.
          return { verification: "verification_failed", detail: "no draft id was returned" };
        }

        if (!grantedScopes.includes(GMAIL_READ_SCOPE)) {
          return {
            verification: "verification_unavailable",
            detail:
              "the draft was created, but confirming it needs gmail.readonly, which this connection has not granted",
          };
        }

        if (!deps.gmailRead) {
          return {
            verification: "verification_unavailable",
            detail: "no Gmail read client is configured on this server",
          };
        }

        const reread = await deps.gmailRead.getDraft(accessToken, draftId, signal);
        if (!reread.ok) {
          // Could not look — distinct from looked and disagreed.
          return {
            verification: "verification_unavailable",
            detail: `the draft could not be re-read: ${reread.message}`,
          };
        }

        // Identity first: a different draft id means we read something else.
        if (reread.body.draftId && reread.body.draftId !== draftId) {
          return {
            verification: "verification_failed",
            detail: "the draft that came back has a different id",
          };
        }

        // Recipients. Compared as a SET of normalized addresses: Gmail
        // reformats "A <a@x>" and may reorder, and neither is a discrepancy.
        const expectedTo = arr("to").map(normalizeAddress).filter(Boolean).sort();
        const actualTo = reread.body.to.map(normalizeAddress).filter(Boolean).sort();
        if (expectedTo.length > 0 && !sameSet(expectedTo, actualTo)) {
          // The count is safe to state; the addresses are not.
          return {
            verification: "verification_failed",
            detail: `the draft's recipients do not match the ${expectedTo.length} approved`,
          };
        }

        const expectedSubject = str("subject");
        if (expectedSubject && reread.body.subject !== expectedSubject) {
          return {
            verification: "verification_failed",
            // The subject was approved by the user and is already shown to
            // them in the plan, so echoing it back reveals nothing new.
            detail: `expected the subject "${expectedSubject}" but found something else`,
          };
        }

        // BODY BY HASH, never by value. The comparison needs to be exact; the
        // detail must never carry a fragment of the message.
        const expectedBody = str("body");
        if (expectedBody && bodyDigest(expectedBody) !== bodyDigest(reread.body.body)) {
          return {
            verification: "verification_failed",
            detail: "the draft's body does not match what was approved",
          };
        }

        // A draft that is already SENT is not a draft. This is the one that
        // would matter most: it would mean a create somehow dispatched mail.
        if (reread.body.labels.includes("SENT")) {
          return {
            verification: "verification_failed",
            detail: "the message was sent rather than left as a draft",
          };
        }

        return { verification: "verified", detail: "the draft was read back and matches" };
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
