// ---------------------------------------------------------------------------
// JARVIS tools for real Gmail, Drive and Calendar reads — Phase 12.
//
// Nine tools, all READ_ONLY, all translations. Each turns a sentence into a
// `GoogleTaskInput` and hands it to `GoogleWorkspaceTaskPort`, which the API
// implements over the SAME `GoogleWorkspaceTaskService` the dashboard panels
// call. There is no provider logic, no URL, no scope and no token in this file.
//
// STATUS IS NOT FLATTENED INTO SUCCESS/FAILURE. The envelope's `status` carries
// remedies that differ:
//
//   not_connected      -> "connect Google"        (retrying never helps)
//   needs_reauth       -> "reconnect Google"      (retrying never helps)
//   permission_missing -> "reconnect WITH Gmail"  (retrying never helps)
//   provider_error     -> a retry might work
//
// Collapsing those into "it failed" is how an assistant ends up telling someone
// to try again forever on a revoked grant. So each tool returns the remedy as
// the failure text, and the model is told not to invent one.
//
// A FAILED READ IS NEVER A SUCCESSFUL ONE. These tools return `failure()` when
// the provider did not return data — there is no branch that reports an empty
// result as though the call worked when it did not. An empty INBOX, on the
// other hand, is a successful read of nothing, and is reported as success.
// ---------------------------------------------------------------------------

import { BaseTool } from "../base-tool.js";
import type { ToolContext, ToolResult } from "@jarvis/core";
import type {
  CalendarEvent,
  CalendarListResult,
  DriveFile,
  DriveListResult,
  GmailListResult,
  GmailMessageDetail,
  GmailThread,
  GoogleTaskResult,
} from "@jarvis/core";

/**
 * The seam to the backend service.
 *
 * One method, taking the already-typed action and params. As with the
 * integration tools, a narrow port is what makes "the tool does what the panel
 * does" the only thing it CAN do.
 */
export interface GoogleWorkspaceTaskPort {
  executeTask<T>(
    input: { action: string; params?: Record<string, unknown> },
    context: { userId: string; source: "jarvis"; traceId?: string; signal?: AbortSignal }
  ): Promise<GoogleTaskResult<T>>;
}

/** Shared behaviour: call, then translate the envelope honestly. */
abstract class GoogleTaskTool extends BaseTool {
  constructor(
    protected readonly port: GoogleWorkspaceTaskPort,
    id: string,
    name: string,
    description: string,
    parameters: ConstructorParameters<typeof BaseTool>[4]
  ) {
    // Every one READ_ONLY with ["read"], so ToolApprovalService auto-approves:
    // reading your own mail needs no second person's consent, and requiring one
    // would make the feature unusable without making it safer.
    super(id, name, description, "integration", parameters, false, ["read"], "READ_ONLY");
  }

  protected async run<T>(
    action: string,
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const result = await this.port.executeTask<T>(
      { action, params },
      {
        userId: context.userId,
        source: "jarvis",
        ...(context.traceId ? { traceId: context.traceId } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      }
    );

    if (!result.success) {
      const remedy = result.requiredAction ? ` ${result.requiredAction}` : "";
      const text = `${result.message ?? "The Google request failed."}${remedy}`;

      // AN ACTIONABLE STATE IS AN ANSWER, NOT A RETRIEVAL FAILURE.
      //
      // "You have not connected Google" is the correct answer to "show my
      // unread emails" — the user needs to hear it and act on it. Returning it
      // as a failed ToolResult trips the Orchestrator's all-tools-failed guard,
      // and the user gets "Data retrieval failed" instead of the one sentence
      // that would let them fix it. Caught on a live run.
      //
      // So the three states only a HUMAN can resolve come back as a successful
      // lookup carrying bad news, and the model is told what to say. A genuine
      // provider failure stays a failure, because there a retry is the right
      // suggestion and the guard is right to fire.
      const actionable =
        result.status === "not_connected" ||
        result.status === "needs_reauth" ||
        result.status === "permission_missing";

      if (actionable) {
        return this.success(
          {
            available: false,
            status: result.status,
            reason: result.message,
            requiredAction: result.requiredAction,
          },
          {
            message: text,
            source: result.source,
            status: result.status,
            rule: "Tell the user this is not available yet and state the requiredAction verbatim. Do NOT retry, and do NOT invent data.",
          }
        );
      }

      return this.failure(text);
    }

    return this.success(result.data, {
      message: result.message,
      source: result.source,
      status: result.status,
      requestId: result.requestId,
    });
  }
}

const LIMIT_PARAM = {
  name: "limit",
  type: "number",
  description: "How many results to return. Default 10, maximum 25.",
  required: false,
} as const;

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export class ListUnreadGmailTool extends GoogleTaskTool {
  constructor(port: GoogleWorkspaceTaskPort) {
    super(
      port,
      "gmail.listUnread",
      "List unread Gmail",
      [
        "Reads the user's UNREAD inbox messages from Gmail and returns sender, subject, a short snippet and received time.",
        "USE THIS for 'unread emails dikhao', 'meri unread Gmail emails summarize karo', 'latest unread emails', 'do I have new mail'.",
        "Returns metadata and Gmail's own snippet — NOT full message bodies. To read one message in full, use gmail.getMessage with its id.",
        "An empty list means the inbox has no unread mail; report that plainly rather than implying an error.",
      ].join(" "),
      [LIMIT_PARAM]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.run<GmailListResult>("gmail.listUnread", { limit: params.limit }, context);
  }
}

export class SearchGmailTool extends GoogleTaskTool {
  constructor(port: GoogleWorkspaceTaskPort) {
    super(
      port,
      "gmail.search",
      "Search Gmail",
      [
        "Searches the user's Gmail using Gmail's own query syntax and returns matching message summaries.",
        "USE THIS for 'find emails from X', 'invoice wale emails dhoondo', 'search my mail for Y'.",
        "Gmail query syntax is supported: from:, to:, subject:, has:attachment, newer_than:7d, is:unread, in:inbox.",
        "Translate the user's request into a Gmail query — for example 'emails from Priya last week' becomes 'from:Priya newer_than:7d'.",
      ].join(" "),
      [
        {
          name: "query",
          type: "string",
          description:
            "Gmail search query, e.g. 'from:priya has:attachment newer_than:7d'. Required.",
          required: true,
        },
        LIMIT_PARAM,
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (!query) {
      return this.failure("What should I search your mail for? Give me a sender, subject or keyword.");
    }
    return this.run<GmailListResult>("gmail.search", { query, limit: params.limit }, context);
  }
}

export class GetGmailMessageTool extends GoogleTaskTool {
  constructor(port: GoogleWorkspaceTaskPort) {
    super(
      port,
      "gmail.getMessage",
      "Read one Gmail message",
      [
        "Reads ONE Gmail message in full, including its plain-text body and attachment names.",
        "USE THIS when the user asks to open, read or summarize a specific message you already have an id for.",
        "You must obtain the message id from gmail.listUnread or gmail.search first — never guess an id.",
      ].join(" "),
      [
        {
          name: "messageId",
          type: "string",
          description: "Gmail message id, taken from a previous list or search result.",
          required: true,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const messageId = typeof params.messageId === "string" ? params.messageId.trim() : "";
    if (!messageId) {
      return this.failure(
        "I need the message id. List or search the mail first, then open a specific message."
      );
    }
    return this.run<GmailMessageDetail>("gmail.getMessage", { messageId }, context);
  }
}

export class GetGmailThreadTool extends GoogleTaskTool {
  constructor(port: GoogleWorkspaceTaskPort) {
    super(
      port,
      "gmail.getThread",
      "Read a Gmail thread",
      [
        "Reads a whole Gmail conversation thread and returns every message's sender, subject, snippet and time.",
        "USE THIS for 'show me the whole conversation', 'is thread ka context do'.",
        "Returns summaries, not full bodies. Obtain the thread id from a list or search result first.",
      ].join(" "),
      [
        {
          name: "threadId",
          type: "string",
          description: "Gmail thread id, taken from a previous list or search result.",
          required: true,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
    if (!threadId) {
      return this.failure("I need the thread id. List or search the mail first.");
    }
    return this.run<GmailThread>("gmail.getThread", { threadId }, context);
  }
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

export class SearchDriveFilesTool extends GoogleTaskTool {
  constructor(port: GoogleWorkspaceTaskPort) {
    super(
      port,
      "drive.searchFiles",
      "Search Google Drive",
      [
        "Searches the user's Google Drive by name and file kind, returning file name, kind, owner, modified time and a link.",
        "USE THIS for 'Drive mein presentation dhoondo', 'find my budget spreadsheet', 'search Drive for the contract'.",
        "Pass the user's phrase directly — words like 'presentation', 'spreadsheet', 'doc' and 'pdf' are understood as file-kind filters automatically.",
        "Returns METADATA only. File contents are never downloaded in this version.",
      ].join(" "),
      [
        {
          name: "query",
          type: "string",
          description:
            "What to look for, in plain words — e.g. 'Q3 presentation', 'budget spreadsheet'. Required.",
          required: true,
        },
        LIMIT_PARAM,
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (!query) {
      return this.failure("What should I look for in Drive? A name or a file kind is enough.");
    }
    return this.run<DriveListResult>("drive.searchFiles", { query, limit: params.limit }, context);
  }
}

export class ListRecentDriveFilesTool extends GoogleTaskTool {
  constructor(port: GoogleWorkspaceTaskPort) {
    super(
      port,
      "drive.listRecentFiles",
      "List recent Drive files",
      [
        "Lists the user's most recently modified Google Drive files, newest first. Folders are excluded.",
        "USE THIS for 'Drive ki recent files dikhao', 'what have I worked on recently', 'show my latest documents'.",
        "Returns metadata only, never file contents.",
      ].join(" "),
      [LIMIT_PARAM]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.run<DriveListResult>("drive.listRecentFiles", { limit: params.limit }, context);
  }
}

export class GetDriveFileMetadataTool extends GoogleTaskTool {
  constructor(port: GoogleWorkspaceTaskPort) {
    super(
      port,
      "drive.getFileMetadata",
      "Get Drive file details",
      [
        "Reads ONE Drive file's details: name, kind, size, owners, created and modified times, and its link.",
        "USE THIS when the user asks about a specific file you already have an id for.",
        "Obtain the file id from drive.searchFiles or drive.listRecentFiles first — never guess an id.",
        "This does NOT download or read the file's contents.",
      ].join(" "),
      [
        {
          name: "fileId",
          type: "string",
          description: "Drive file id, taken from a previous search or recent-files result.",
          required: true,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const fileId = typeof params.fileId === "string" ? params.fileId.trim() : "";
    if (!fileId) {
      return this.failure("I need the file id. Search Drive first, then ask about a specific file.");
    }
    return this.run<DriveFile>("drive.getFileMetadata", { fileId }, context);
  }
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export class ListUpcomingCalendarEventsTool extends GoogleTaskTool {
  constructor(port: GoogleWorkspaceTaskPort) {
    super(
      port,
      "calendar.listUpcomingEvents",
      "List upcoming calendar events",
      [
        "Reads the user's upcoming Google Calendar events in a time window, with start and end times, location and attendees.",
        "USE THIS for 'meri next meetings batao', 'kal ka calendar dikhao', 'what's on my calendar', 'aaj kya hai'.",
        "For 'tomorrow' / 'kal', pass fromIso as tomorrow's date at 00:00 and windowDays 1. For 'today' / 'aaj', pass today's date and windowDays 1. For 'this week', windowDays 7.",
        "Recurring meetings are already expanded into individual occurrences; cancelled ones are excluded.",
      ].join(" "),
      [
        LIMIT_PARAM,
        {
          name: "windowDays",
          type: "number",
          description: "How many days ahead to look. Default 7, maximum 90. Use 1 for a single day.",
          required: false,
        },
        {
          name: "fromIso",
          type: "string",
          description:
            "ISO 8601 start of the window. Omit for 'from now'. Set it for a specific day such as tomorrow.",
          required: false,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.run<CalendarListResult>(
      "calendar.listUpcomingEvents",
      { limit: params.limit, windowDays: params.windowDays, fromIso: params.fromIso },
      context
    );
  }
}

export class GetCalendarEventTool extends GoogleTaskTool {
  constructor(port: GoogleWorkspaceTaskPort) {
    super(
      port,
      "calendar.getEvent",
      "Get calendar event details",
      [
        "Reads ONE Google Calendar event in full: description, location, organizer and attendee responses.",
        "USE THIS when the user asks about a specific meeting you already have an id for.",
        "Obtain the event id from calendar.listUpcomingEvents first — never guess an id.",
      ].join(" "),
      [
        {
          name: "eventId",
          type: "string",
          description: "Calendar event id, taken from a previous upcoming-events result.",
          required: true,
        },
        {
          name: "calendarId",
          type: "string",
          description: "Calendar the event belongs to. Defaults to the primary calendar.",
          required: false,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const eventId = typeof params.eventId === "string" ? params.eventId.trim() : "";
    if (!eventId) {
      return this.failure("I need the event id. List your upcoming events first.");
    }
    return this.run<CalendarEvent>(
      "calendar.getEvent",
      { eventId, calendarId: params.calendarId },
      context
    );
  }
}

// ---------------------------------------------------------------------------

export function createGoogleWorkspaceTools(port: GoogleWorkspaceTaskPort): BaseTool[] {
  return [
    new ListUnreadGmailTool(port),
    new SearchGmailTool(port),
    new GetGmailMessageTool(port),
    new GetGmailThreadTool(port),
    new SearchDriveFilesTool(port),
    new ListRecentDriveFilesTool(port),
    new GetDriveFileMetadataTool(port),
    new ListUpcomingCalendarEventsTool(port),
    new GetCalendarEventTool(port),
  ];
}

/** Registry ids, so the agent policy and tests name them without drift. */
export const GOOGLE_WORKSPACE_TOOL_IDS = [
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
