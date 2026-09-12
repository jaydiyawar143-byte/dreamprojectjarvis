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
