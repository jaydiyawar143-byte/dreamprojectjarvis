// ---------------------------------------------------------------------------
// GoogleWorkspaceTaskService — THE single path for every Google read task.
//
//     Frontend panel  ──┐
//                       ├──► executeTask() ──► access ──► provider ──► audit
//     JARVIS tool     ──┘
//
// Same rule as the integration command service, for the same reason: every
// check that matters — availability, authorization, scope, rate limit, audit —
// lives in ONE method that both callers reach. A second path would be a path on
// which those are absent, silently.
//
// THE ORDER OF CHECKS IS THE CONTRACT.
//
//   1. Is the action one we implement?   -> refuse before touching a token
//   2. Is the integration enabled?       -> DISABLED is a user decision
//   3. Rate limit                        -> counted before a provider is called
//   4. Resolve access (connect/scope/refresh)
//   5. Call the provider
//   6. Audit, whatever happened
//
// Refusing an unknown action FIRST is what stops a caller reaching a Google
// endpoint this system never meant to expose: the action name is matched
// against a closed list before any credential is resolved.
//
// NOTHING SENSITIVE IS AUDITED. The audit row records the action, the outcome
// and counts. It never records a search query (which is the user's own private
// text), a subject line, a filename, an attendee, or any part of a provider
// response. "What happened and when" is auditable without storing the mail.
//
// NO WRITES EXIST HERE. Every branch calls a read method on a service that has
// no write method. A write cannot be added without adding an action id to
// `GOOGLE_TASK_ACTIONS` in @jarvis/core first.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import {
  ACTION_SERVICE,
  isGoogleTaskAction,
  type GoogleTaskAction,
  type GoogleTaskResult,
  type GoogleTaskSource,
  type GoogleTaskStatus,
  type IGoogleConnectionRepository,
} from "@jarvis/core";
import {
  GmailService,
  GoogleCalendarService,
  GoogleDriveService,
  resolveAccess,
  type GoogleCallOutcome,
} from "@jarvis/google-workspace";
import type { GoogleConfig } from "@jarvis/google-ads";
import type { AuditLogger } from "@jarvis/security";

/**
 * Per-user ceilings.
 *
 * Sized for a person reading their own mail and calendar, not for a loop.
 * Gmail listing is the expensive one — each list hydrates up to 25 messages —
 * so it gets the tighter bucket.
 */
export const GOOGLE_TASK_RATE_LIMITS = {
  list: { limit: 30, windowMs: 60_000 },
  detail: { limit: 60, windowMs: 60_000 },
} as const;

export interface RateLimitPort {
  check(
    userId: string,
    bucket: string,
    limit: number,
    windowMs: number
  ): Promise<{ allowed: boolean; currentCount: number; limit: number }>;
}

/** Whether the user has switched the Google integration off. */
export interface IntegrationEnabledReader {
  isEnabled(userId: string, integration: string): Promise<boolean>;
}

export interface GoogleWorkspaceDeps {
  connections: IGoogleConnectionRepository;
  /** Null when the server has no Google OAuth client configured. */
  config: GoogleConfig | null;
  audit: AuditLogger;
  rateLimiter: RateLimitPort;
  integrationState: IntegrationEnabledReader;
  gmail?: GmailService;
  drive?: GoogleDriveService;
  calendar?: GoogleCalendarService;
  now?: () => Date;
}

export interface GoogleTaskInput {
  action: GoogleTaskAction | string;
  params?: Record<string, unknown>;
}

export interface GoogleTaskContext {
  userId: string;
  source: "frontend" | "jarvis";
  traceId?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------

function fail<T>(
  source: GoogleTaskSource,
  status: Exclude<GoogleTaskStatus, "ok">,
  message: string,
  requestId: string,
  requiredAction?: string
): GoogleTaskResult<T> {
  return {
    success: false,
    source,
    status,
    data: null,
    message,
    ...(requiredAction ? { requiredAction } : {}),
    requestId,
  };
}

function succeed<T>(source: GoogleTaskSource, data: T, requestId: string, message?: string): GoogleTaskResult<T> {
  return {
    success: true,
    source,
    status: "ok",
    data,
    ...(message ? { message } : {}),
    requestId,
  };
}

/** Reads a bounded positive integer parameter. */
function intParam(params: Record<string, unknown>, name: string, fallback: number, max = 25): number {
  const raw = Number(params[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), 1), max);
}

function stringParam(params: Record<string, unknown>, name: string): string {
  return typeof params[name] === "string" ? (params[name] as string).trim() : "";
}

// ---------------------------------------------------------------------------

export class GoogleWorkspaceTaskService {
  private readonly gmail: GmailService;
  private readonly drive: GoogleDriveService;
  private readonly calendar: GoogleCalendarService;

  constructor(private readonly deps: GoogleWorkspaceDeps) {
    this.gmail = deps.gmail ?? new GmailService();
    this.drive = deps.drive ?? new GoogleDriveService();
    this.calendar = deps.calendar ?? new GoogleCalendarService();
  }

  /**
   * Runs one Google read task. The only public entry point.
   */
  async executeTask<T = unknown>(
    input: GoogleTaskInput,
    context: GoogleTaskContext
  ): Promise<GoogleTaskResult<T>> {
    const requestId = context.traceId ?? randomUUID();
    const action = input.action;

    // 1. Closed action list, checked before anything else. An unknown action
    //    never reaches a credential, let alone a provider.
    if (!isGoogleTaskAction(action)) {
      const result = fail<T>(
        "gmail",
        "provider_error",
        `"${String(action).slice(0, 60)}" is not a supported Google task.`,
        requestId
      );
      await this.audit(action, "gmail", context, result);
      return result;
    }

    const service = ACTION_SERVICE[action];
    const params = input.params ?? {};

    // 2. Server configured at all?
    if (!this.deps.config) {
      const result = fail<T>(
        service,
        "not_connected",
        "Google is not configured on this server, so no Google account can be connected.",
        requestId,
        "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI and restart."
      );
      await this.audit(action, service, context, result);
      return result;
    }

    // 3. Switched off by the user. Distinct from disconnected: the credential
    //    is still there, and the remedy is to enable rather than reconnect.
    const enabled = await this.deps.integrationState.isEnabled(context.userId, "google");
    if (!enabled) {
      const result = fail<T>(
        service,
        "not_connected",
        "The Google integration is switched off.",
        requestId,
        "Enable Google in the Integration Center, then try again."
      );
      await this.audit(action, service, context, result);
      return result;
    }

    // 4. Rate limit BEFORE the provider call, and audited when it bites.
    const bucket = action.endsWith("getMessage") || action.endsWith("getThread") ||
      action.endsWith("getEvent") || action.endsWith("getFileMetadata")
      ? GOOGLE_TASK_RATE_LIMITS.detail
      : GOOGLE_TASK_RATE_LIMITS.list;

    const decision = await this.deps.rateLimiter.check(
      context.userId,
      service,
      bucket.limit,
      bucket.windowMs
    );
    if (!decision.allowed) {
      const result = fail<T>(
        service,
        "provider_error",
        `Too many Google requests. The limit is ${decision.limit} per minute; try again shortly.`,
        requestId
      );
      await this.audit(action, service, context, result);
      return result;
    }

    // 5. Connection, scope and freshness. Returns a status, never throws.
    const access = await resolveAccess(context.userId, service, {
      connections: this.deps.connections,
      config: this.deps.config,
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });

    if (!access.ok) {
      const result = fail<T>(
        service,
        access.status,
        access.message,
        requestId,
        access.requiredAction
      );
      await this.audit(action, service, context, result);
      return result;
    }

    // 6. The provider call.
    let outcome: GoogleCallOutcome<unknown>;
    try {
      outcome = await this.dispatch(action, access.accessToken, params, context.signal);
    } catch {
      // A thrown provider call is a bug or an unreachable host. The exception
      // text is not forwarded: it can carry a URL, and a Gmail URL carries the
      // user's search query.
      const result = fail<T>(
        service,
        "provider_error",
        "The Google request could not be completed.",
        requestId
      );
      await this.audit(action, service, context, result);
      return result;
    }

    const result: GoogleTaskResult<T> = outcome.ok
      ? succeed<T>(service, outcome.body as T, requestId, this.describe(action, outcome.body))
      : fail<T>(service, outcome.status, outcome.message, requestId, outcome.requiredAction);

    await this.audit(action, service, context, result, outcome.ok ? this.countOf(outcome.body) : undefined);
    return result;
  }

  // -------------------------------------------------------------------------

  private dispatch(
    action: GoogleTaskAction,
    accessToken: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<unknown>> {
    switch (action) {
      case "gmail.listUnread":
        return this.gmail.listUnread(accessToken, intParam(params, "limit", 10), signal);

      case "gmail.search":
        return this.gmail.search(
          accessToken,
          stringParam(params, "query"),
          intParam(params, "limit", 10),
          stringParam(params, "pageToken") || undefined,
          signal
        );

      case "gmail.getMessage":
        return this.gmail.getMessage(accessToken, stringParam(params, "messageId"), signal);

      case "gmail.getThread":
        return this.gmail.getThread(accessToken, stringParam(params, "threadId"), signal);

      case "drive.searchFiles":
        return this.drive.searchFiles(
          accessToken,
          stringParam(params, "query"),
          intParam(params, "limit", 10),
          stringParam(params, "pageToken") || undefined,
          signal
        );

      case "drive.listRecentFiles":
        return this.drive.listRecentFiles(
          accessToken,
          intParam(params, "limit", 10),
          stringParam(params, "pageToken") || undefined,
          signal
        );

      case "drive.getFileMetadata":
        return this.drive.getFileMetadata(accessToken, stringParam(params, "fileId"), signal);

      case "calendar.listUpcomingEvents":
        return this.calendar.listUpcomingEvents(
          accessToken,
          {
            limit: intParam(params, "limit", 10),
            windowDays: intParam(params, "windowDays", 7, 90),
            ...(stringParam(params, "fromIso") ? { fromIso: stringParam(params, "fromIso") } : {}),
            ...(stringParam(params, "calendarId")
              ? { calendarId: stringParam(params, "calendarId") }
              : {}),
          },
          signal
        );

      case "calendar.getEvent":
        return this.calendar.getEvent(
          accessToken,
          stringParam(params, "eventId"),
          stringParam(params, "calendarId") || "primary",
          signal
        );
    }
  }

  /** A sentence a model can relay. Counts and kinds only — never content. */
  private describe(action: GoogleTaskAction, body: unknown): string {
    const count = this.countOf(body);

    switch (action) {
      case "gmail.listUnread":
        return count === 0 ? "No unread messages in the inbox." : `${count} unread message(s).`;
      case "gmail.search":
        return count === 0 ? "No messages matched that search." : `${count} matching message(s).`;
      case "gmail.getMessage":
        return "Message retrieved.";
      case "gmail.getThread":
        return `Thread retrieved with ${count} message(s).`;
      case "drive.searchFiles":
        return count === 0 ? "No files matched that search." : `${count} matching file(s).`;
      case "drive.listRecentFiles":
        return count === 0 ? "No recent files." : `${count} recent file(s).`;
      case "drive.getFileMetadata":
        return "File details retrieved.";
      case "calendar.listUpcomingEvents":
        return count === 0 ? "No events in that window." : `${count} upcoming event(s).`;
      case "calendar.getEvent":
        return "Event retrieved.";
    }
  }

  /** Item count of a list payload, or 1 for a single item. Never content. */
  private countOf(body: unknown): number {
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      for (const key of ["messages", "files", "events"]) {
        if (Array.isArray(record[key])) return (record[key] as unknown[]).length;
      }
    }
    return 1;
  }

  /**
   * Records the call.
   *
   * Deliberately narrow: action, source, status and a COUNT. No query, no
   * subject, no filename, no attendee, no provider body. The audit trail is
   * long-lived and widely readable; "who read their mail and when" is the
   * auditable fact, and the mail itself is not.
   */
  private async audit(
    action: string,
    source: GoogleTaskSource,
    context: GoogleTaskContext,
    result: GoogleTaskResult<unknown>,
    resultCount?: number
  ): Promise<void> {
    try {
      await this.deps.audit.log({
        userId: context.userId,
        action: `google.${action}`,
        result: result.success ? "success" : "failure",
        ...(context.traceId ? { traceId: context.traceId } : {}),
        metadata: {
          service: source,
          source: context.source,
          status: result.status,
          ...(resultCount !== undefined ? { resultCount } : {}),
          requestId: result.requestId,
        },
      });
    } catch {
      // An audit failure must not turn a successful read into an error the
      // caller retries. The read already happened.
    }
  }
}
