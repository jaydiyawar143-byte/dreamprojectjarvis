// ---------------------------------------------------------------------------
// @jarvis/google-workspace — real, read-only Gmail, Drive and Calendar access.
//
// Phase 12. Every export here issues GETs against Google and normalizes the
// result; none of them can write. Token resolution reuses the OAuth primitives
// in `@jarvis/google-ads` and the encrypted vault behind
// `IGoogleConnectionRepository` — this package adds no second OAuth flow and no
// second place a token is stored.
// ---------------------------------------------------------------------------

export { resolveAccess, type AccessOutcome, type AccessDeps } from "./access.js";
export {
  callGoogle,
  buildUrl,
  DEFAULT_TIMEOUT_MS,
  type GoogleCallOutcome,
  type GoogleCallOptions,
} from "./http.js";
export { GmailService, type GmailServiceDeps } from "./gmail.js";
export {
  GoogleDriveService,
  buildSearchQuery,
  type DriveServiceDeps,
} from "./drive.js";
export { GoogleCalendarService, type CalendarServiceDeps } from "./calendar.js";

// ---------------------------------------------------------------------------
// Phase 13 — approval-gated WRITES.
//
// Separate modules from the read services on purpose: `callGoogle` is GET-only
// and `callGoogleWrite` is the entire mutating surface of this package, so
// `grep callGoogleWrite` enumerates every way it can change anything.
//
// No delete of mail or files, no permission changes, no content overwrite.
// ---------------------------------------------------------------------------

export {
  callGoogleWrite,
  DEFAULT_WRITE_TIMEOUT_MS,
  type GoogleWriteOutcome,
  type GoogleWriteOptions,
  type WriteMethod,
} from "./http-write.js";

export {
  GmailWriteService,
  validateDraft,
  buildMimeMessage,
  type DraftInput,
  type GmailDraftResult,
  type GmailSendResult,
  type GmailWriteDeps,
} from "./gmail-write.js";

export {
  DriveWriteService,
  validateName,
  validateFileId,
  MAX_UPLOAD_BYTES,
  type DriveWriteResult,
  type DriveWriteDeps,
} from "./drive-write.js";

export {
  CalendarWriteService,
  validateEvent,
  type EventInput,
  type CalendarWriteResult,
  type SendUpdates,
  type CalendarWriteDeps,
} from "./calendar-write.js";
