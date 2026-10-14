// ---------------------------------------------------------------------------
// The browser-safe marketing entry point — Phase 15.
//
// Imported by the web app as `@jarvis/core/marketing`, NEVER as
// `@jarvis/core`, for the reason `./surface` gives: the package barrel reaches
// modules that import `node:crypto`, which a browser build cannot resolve.
//
// Everything re-exported here is pure data and pure functions — the marketing
// vocabulary and view types, the content lifecycle and calendar, and the
// report's own number formatting — so the screen shows a channel, a status and
// a figure with exactly the words and rounding the API and a report use.
// ---------------------------------------------------------------------------

export * from "./types/marketing.js";
export * from "./marketing-content.js";
export { REPORT_SOURCE_STATUS_LABELS, formatReportChange, formatReportValue, reportFileName, reportPublicationLabel } from "./marketing-report.js";
