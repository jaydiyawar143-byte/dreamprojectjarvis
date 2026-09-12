// ---------------------------------------------------------------------------
// Google Workspace read-only task contract — Phase 12.
//
// THE ENVELOPE IS THE POINT. Every Gmail, Drive and Calendar action returns the
// same `GoogleTaskResult`, and its `status` is a closed union. That is what lets
// one backend service serve both the dashboard and JARVIS without either having
// to interpret a provider's own error shape: "the token expired" is
// `needs_reauth` on both paths, and neither can mistake it for `provider_error`
// and tell the user to try again.
//
// READ-ONLY, STRUCTURALLY. There is no type in this file that describes sending
// a message, deleting a file or creating an event. A future edit cannot add a
// write action without first adding a type for it, in a file whose header says
// not to — which is a weaker control than a permission check, but it is the one
// that survives someone copying a service file as a template.
//
// NOTHING HERE CARRIES A TOKEN. The normalized shapes hold what a person needs
// to read a result — subjects, senders, filenames, times. There is no field for
// an access token, a refresh token or a raw provider payload, so no response
// built from these types can leak one.
// ---------------------------------------------------------------------------

/** Which provider answered. Always reported, never inferred by the caller. */
export type GoogleTaskSource = "gmail" | "drive" | "calendar";

/**
 * The outcome of a task, as a closed set.
 *
 * Each value implies a DIFFERENT remedy, which is the reason they are not
 * collapsed into a boolean:
 *
 *   ok                 — nothing to do.
 *   not_connected      — the user must connect Google. Retrying cannot help.
 *   needs_reauth       — the grant existed and the provider has refused it.
 *                        Only re-consent fixes this; a retry loops forever.
 *   permission_missing — connected, but this scope was never granted. The user
 *                        must re-consent WITH the service selected.
 *   provider_error     — Google failed or was unreachable. A retry may help.
 */
export type GoogleTaskStatus =
  | "ok"
  | "not_connected"
  | "needs_reauth"
  | "permission_missing"
  | "provider_error";

/** Statuses a retry could plausibly resolve. Everything else needs a human. */
export const RETRYABLE_TASK_STATUSES: readonly GoogleTaskStatus[] = ["provider_error"];

export function isRetryableStatus(status: GoogleTaskStatus): boolean {
  return RETRYABLE_TASK_STATUSES.includes(status);
}

/**
 * The response every Google task returns, on every path.
 *
 * `success` and `status` are deliberately both present: `success` is what a
 * caller branches on, `status` is what it explains. A discriminated union on
 * `success` would make `status` unreachable on the happy path, and the UI wants
 * to say "connected and empty" differently from "connected with results".
 */
export interface GoogleTaskResult<T> {
  success: boolean;
  source: GoogleTaskSource;
  status: GoogleTaskStatus;
  /** Present only when `success`. */
  data: T | null;
  /** Safe for display. Never a raw provider body, never credential material. */
  message?: string;
  /** What the user must do, when anything can be done. */
  requiredAction?: string;
  /** Correlates this call with its audit row and server log line. */
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

/**
 * One message, normalized.
 *
 * `snippet` is Google's own short preview — a sentence or so. The full body is
 * only present on `getMessage`, never on a list, because a list of fifty full
 * message bodies is a great deal of private content to move and cache for a
 * view that shows subjects.
 */
export interface GmailMessageSummary {
  id: string;
  threadId: string;
  /** Display name and address as the provider reported them. */
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  /** ISO 8601. */
  receivedAt: string;
  unread: boolean;
  hasAttachments: boolean;
  labels: string[];
}

/** A single message with its body. Returned only by `getMessage`. */
export interface GmailMessageDetail extends GmailMessageSummary {
  /**
   * Plain-text body, decoded. HTML parts are preferred only when no text part
   * exists, and are stripped to text — rendering provider HTML in the dashboard
   * would be an injection surface for anyone who can email the user.
   */
  body: string;
  /** Names and sizes only. This phase does not download attachment content. */
  attachments: Array<{ filename: string; mimeType: string; sizeBytes: number }>;
}

export interface GmailThread {
  id: string;
  subject: string;
  messageCount: number;
  messages: GmailMessageSummary[];
}

export interface GmailListResult {
  messages: GmailMessageSummary[];
  /** Total matching the query where Google reports it; null when it does not. */
  estimatedTotal: number | null;
  nextPageToken: string | null;
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

export interface DriveFile {
  id: string;
  name: string;
  /** Raw Google MIME type, e.g. application/vnd.google-apps.presentation. */
  mimeType: string;
  /** Plain-English kind derived from the MIME type: "Presentation", "PDF", … */
  kind: string;
  /** ISO 8601. */
  modifiedAt: string;
  createdAt: string | null;
  sizeBytes: number | null;
  owners: string[];
  /** Google's own link. Opening it requires the viewer's own Google session. */
  webViewLink: string | null;
  shared: boolean;
  trashed: boolean;
  /**
   * Containing folder ids.
   *
   * Added in Phase 13: verifying a move means checking the file is actually in
   * the destination, which cannot be done without knowing its parents.
   */
  parents: string[];
}

export interface DriveListResult {
  files: DriveFile[];
  nextPageToken: string | null;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  /** ISO 8601. For an all-day event this is the date at local midnight. */
  start: string;
  end: string;
  allDay: boolean;
  status: string;
  organizer: string | null;
  attendees: Array<{ email: string; responseStatus: string; optional: boolean }>;
  /** Google's own link to the event. */
  htmlLink: string | null;
  calendarId: string;
}

export interface CalendarListResult {
  events: CalendarEvent[];
  /** The window actually queried, so a caller can say what it looked at. */
  from: string;
  to: string;
  nextPageToken: string | null;
}

// ---------------------------------------------------------------------------
// Action identifiers
// ---------------------------------------------------------------------------

/**
 * Every Google task this phase implements. All reads.
 *
 * Closed on purpose, and checked at the service boundary: an action name that
 * is not in this list is refused before any token is resolved, so a caller
 * cannot reach a provider endpoint the system did not intend to expose.
 */
export const GOOGLE_TASK_ACTIONS = [
  "gmail.listUnread",
  "gmail.search",
  "gmail.getMessage",
  "gmail.getThread",
  "drive.searchFiles",
  "drive.listRecentFiles",
  "drive.getFileMetadata",
  "calendar.listUpcomingEvents",
  "calendar.getEvent",
] as const;

export type GoogleTaskAction = (typeof GOOGLE_TASK_ACTIONS)[number];

export function isGoogleTaskAction(value: unknown): value is GoogleTaskAction {
  return typeof value === "string" && (GOOGLE_TASK_ACTIONS as readonly string[]).includes(value);
}

/** Which Google service each action needs a granted scope for. */
export const ACTION_SERVICE: Record<GoogleTaskAction, "gmail" | "drive" | "calendar"> = {
  "gmail.listUnread": "gmail",
  "gmail.search": "gmail",
  "gmail.getMessage": "gmail",
  "gmail.getThread": "gmail",
  "drive.searchFiles": "drive",
  "drive.listRecentFiles": "drive",
  "drive.getFileMetadata": "drive",
  "calendar.listUpcomingEvents": "calendar",
  "calendar.getEvent": "calendar",
};
