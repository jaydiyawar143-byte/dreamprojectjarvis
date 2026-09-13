// ---------------------------------------------------------------------------
// Turning "all the tools failed" into something the user can act on.
//
// THE BUG THIS FIXES. When every tool in a turn fails, the Orchestrator returns
// one fixed sentence — "Data retrieval failed." — with the real cause tucked
// into `details.reason`, which no client reads. So a Gmail draft that failed
// because the request had no recipient, a Google account that was never
// connected, and a genuine provider outage all arrived at the user as the same
// four words. Nothing in that message says what happened or what to do, and the
// one thing that did know was thrown away at the last step.
//
// The message was itself a fix for something worse — it used to say "Meta Ads
// data could not be fetched" on every path, so a failed maps lookup blamed Meta
// — and the lesson taken then was "say less". The right lesson was "say what
// actually happened", which needs the failure to be classified rather than
// described.
//
// WHAT THIS IS NOT. It does not invent detail. It reads the error strings the
// tools already produced, matches the ones whose remedy is known, and passes
// the tool's own sentence through when it is safe to show. Anything it cannot
// classify stays generic — an unrecognised failure must not be dressed up as a
// diagnosis.
//
// SAFETY. The output crosses into the browser, so it carries no stack trace, no
// provider payload, no identifier and no credential. `isSafeToSurface` is the
// gate: a candidate sentence is shown only if it looks like prose written for a
// person. Everything else collapses to the generic message, which is the
// behaviour this file replaces and therefore never a regression.
// ---------------------------------------------------------------------------

/** Safe, stable codes a client may branch on. */
export type SafeFailureCode =
  | "GOOGLE_NOT_CONNECTED"
  | "GMAIL_PERMISSION_MISSING"
  | "GOOGLE_PERMISSION_MISSING"
  | "GOOGLE_REAUTH_REQUIRED"
  | "GOOGLE_API_ERROR"
  | "APPROVAL_REQUIRED"
  | "REQUEST_INCOMPLETE"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "TOOL_EXECUTION_FAILED";

export interface ClassifiedToolFailure {
  code: SafeFailureCode;
  /** One sentence for the user. Never a stack trace, never a payload. */
  message: string;
  /** True when a person can fix this themselves. */
  actionable: boolean;
}

/** The last-resort answer. Identical to the old behaviour. */
const GENERIC: ClassifiedToolFailure = {
  code: "TOOL_EXECUTION_FAILED",
  message: "Data retrieval failed.",
  actionable: false,
};

/**
 * Would this string be safe and useful in a browser?
 *
 * Deliberately conservative. A tool error is usually authored prose, but it can
 * also be a provider body, a stack frame or a serialized object, and none of
 * those belong in front of a user. Rejecting a safe sentence costs a little
 * clarity; letting an unsafe one through costs a leak.
 */
export function isSafeToSurface(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 8 || trimmed.length > 300) return false;

  // Structure means a payload or a trace, not a sentence.
  if (/[{}[\]]/.test(trimmed)) return false;
  // Stack frames: `at Object.execute (`, `at async fn (`, `at /app/x.js:1:2`.
  // A bare `\w+` missed dotted frame names, which is the commonest shape.
  if (/\bat\s+\S+\s*\(/.test(trimmed)) return false;
  if (/:\d+:\d+/.test(trimmed)) return false;
  if (/\n/.test(trimmed)) return false;
  // Anything credential-shaped, even in an error string.
  if (/\b(ya29\.|1\/\/|GOCSPX-|Bearer\s|sk-)/i.test(trimmed)) return false;
  // Long opaque runs: tokens, ids, hashes.
  if (/\b[A-Za-z0-9_-]{32,}\b/.test(trimmed)) return false;
  // A URL may carry a query string with a code in it.
  if (/https?:\/\//i.test(trimmed)) return false;
  return true;
}

interface Rule {
  code: SafeFailureCode;
  actionable: boolean;
  match: RegExp;
  /** Used when the tool's own sentence is not safe to pass through. */
  fallback: string;
}

/**
 * Ordered most specific first — a Gmail permission failure also matches the
 * generic permission rule, and the specific one is the useful answer.
 */
const RULES: Rule[] = [
  {
    code: "GMAIL_PERMISSION_MISSING",
    actionable: true,
    match: /gmail[^.]*\b(permission|scope|access)\b|(permission|scope)[^.]*\bgmail\b/i,
    fallback: "Gmail access has not been granted yet. Grant Gmail access in Integrations, then try again.",
  },
  {
    code: "GOOGLE_REAUTH_REQUIRED",
    actionable: true,
    match: /needs?[_ ]reauth|reauthoriz|re-authoriz|authorization has expired|expired or been revoked/i,
    fallback: "Your Google authorization has expired. Reconnect Google, then try again.",
  },
  {
    code: "GOOGLE_NOT_CONNECTED",
    actionable: true,
    match: /not[_ ]connected|is not connected|no google account is connected|connect your google/i,
    fallback: "Google is not connected. Connect it in Integrations, then try again.",
  },
  {
    code: "GOOGLE_PERMISSION_MISSING",
    actionable: true,
    match: /permission[_ ]missing|does not include .* access|scope was never granted|not granted/i,
    fallback: "A required Google permission has not been granted. Grant it in Integrations, then try again.",
  },
  {
    code: "APPROVAL_REQUIRED",
    actionable: true,
    match: /approval[_ ]required|requires? (your )?approval|must be approved/i,
    fallback: "This needs your approval before it can run. Open Approvals to review it.",
  },
  {
    code: "RATE_LIMITED",
    actionable: true,
    match: /too many .* requests|rate limit|limit is \d+ per minute/i,
    fallback: "Too many requests in a short time. Wait a moment and try again.",
  },
  {
    // Plan validation: a missing recipient, an empty body, a malformed name.
    // The user supplies these, so the tool's own sentence is exactly right.
    code: "REQUEST_INCOMPLETE",
    actionable: true,
    match: /is required|cannot be empty|must be|not a supported|invalid .* format|at least one/i,
    fallback: "Some required details are missing from that request.",
  },
  {
    code: "PROVIDER_UNAVAILABLE",
    actionable: false,
    match: /unavailable|timed? ?out|timeout|econnrefused|socket hang up|network|5\d\d\b/i,
    fallback: "That service is temporarily unavailable. Try again shortly.",
  },
  {
    code: "GOOGLE_API_ERROR",
    actionable: false,
    match: /google api error|googleapis|\bgoogle\b.*\berror\b/i,
    fallback: "Google returned an error for that request.",
  },
];

/**
 * Classify one tool's error text.
 *
 * `toolId` only sharpens the Gmail case: a permission error raised by a Gmail
 * tool is a Gmail permission error even when the sentence does not say so.
 */
export function classifyToolFailure(
  errorText: string | undefined,
  toolId?: string
): ClassifiedToolFailure {
  const text = (errorText ?? "").trim();
  if (!text) return GENERIC;

  const isGmail = Boolean(toolId && /gmail/i.test(toolId));

  for (const rule of RULES) {
    if (!rule.match.test(text)) continue;

    // A generic permission failure from a Gmail tool is a Gmail permission
    // failure; naming the service is what makes the remedy findable.
    const code =
      isGmail && rule.code === "GOOGLE_PERMISSION_MISSING"
        ? "GMAIL_PERMISSION_MISSING"
        : rule.code;

    return {
      code,
      message: isSafeToSurface(text) ? text : rule.fallback,
      actionable: rule.actionable,
    };
  }

  return GENERIC;
}

/**
 * Classify a whole turn's worth of failures.
 *
 * An ACTIONABLE failure wins over an infrastructural one even if it came
 * second: when a turn fails partly because Google is not connected and partly
 * because something timed out, the connection is the thing the user can do
 * something about, and burying it under "temporarily unavailable" sends them to
 * wait for a recovery that will never come.
 */
export function classifyToolFailures(
  failures: ReadonlyArray<{ toolId: string; error?: string; status?: string }>
): ClassifiedToolFailure {
  if (failures.length === 0) return GENERIC;

  const classified = failures.map((f) => classifyToolFailure(f.error ?? f.status, f.toolId));

  return (
    classified.find((c) => c.actionable) ??
    classified.find((c) => c.code !== "TOOL_EXECUTION_FAILED") ??
    GENERIC
  );
}
