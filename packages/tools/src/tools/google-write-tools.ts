// ---------------------------------------------------------------------------
// JARVIS write tools — Phase 13. TEN PLANNERS, ZERO EXECUTORS.
//
// THE SPLIT IS THE WHOLE DESIGN. Every tool in this file calls `plan()` and
// nothing else. None of them can perform a Google write, because the port they
// hold exposes only `plan` — there is no `execute` method on it at all. So a
// model cannot send an email by choosing the right tool, however it is
// prompted: the capability is absent from its reachable surface, not merely
// discouraged.
//
// Execution happens in exactly one place: a human approving the resulting
// approval row, and `GoogleWriteService.execute()` consuming it. That path is
// reachable from the REST layer and from nowhere a model can call.
//
// EACH TOOL RETURNS A PENDING APPROVAL, and says so. It reports success —
// planning genuinely succeeded — carrying the approval id, the risk level and
// the fact that nothing has happened yet. Returning a failure would trip the
// Orchestrator's all-tools-failed guard and the user would be told the request
// broke, when in fact it is waiting for them.
//
// RISK TRAVELS WITH THE RESULT so the model can say the right thing: a draft is
// "created, nothing sent", a send is "this cannot be undone".
// ---------------------------------------------------------------------------

import { BaseTool } from "../base-tool.js";
import type { ToolContext, ToolResult } from "@jarvis/core";
import { WRITE_RISK, type GoogleWritePlanResult } from "@jarvis/core";

/**
 * The seam to the write service — PLANNING ONLY.
 *
 * Deliberately has no `execute`. The tools cannot reach execution because the
 * port does not describe it, which is a stronger guarantee than a policy that
 * says they should not.
 */
export interface GoogleWritePlanPort {
  plan(
    action: string,
    params: Record<string, unknown>,
    context: { userId: string; source: "jarvis"; traceId?: string; voice?: boolean; conversationId?: string | null }
  ): Promise<GoogleWritePlanResult>;
}

/** Shared behaviour: validate, plan, and describe what is now waiting. */
abstract class GoogleWritePlanTool extends BaseTool {
  constructor(
    protected readonly port: GoogleWritePlanPort,
    /** The backend action id. Also this tool's own id, so they cannot drift. */
    protected readonly action: string,
    name: string,
    description: string,
    parameters: ConstructorParameters<typeof BaseTool>[4]
  ) {
    // LOW_IMPACT, not EXTERNAL_SIDE_EFFECT: planning writes nothing outside
    // JARVIS. It creates a pending approval row and stops.
    //
    // `requiresApproval: false` looks surprising on a write tool and is
    // correct: the approval this phase requires is the one the PLAN creates,
    // approved by a human in the Approvals UI. Setting it true here would put
    // an approval in front of *describing* the action, which would mean two
    // approvals for one write and neither of them showing the content.
    super(
      `google.plan.${action}`,
      name,
      description,
      "integration",
      parameters,
      false,
      ["read", "write"],
      "LOW_IMPACT"
    );
  }

  protected async planIt(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const result = await this.port.plan(this.action, params, {
      userId: context.userId,
      source: "jarvis",
      ...(context.traceId ? { traceId: context.traceId } : {}),
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    });

    if (!result.success || !result.plan) {
      // Not connected / no write scope / invalid are ANSWERS the user can act
      // on, so they come back as a successful lookup carrying the remedy —
      // the same rule the Phase 12 read tools follow, and for the same reason:
      // a failed ToolResult here produces "data retrieval failed" instead of
      // "connect your Google account".
      const actionable =
        result.status === "not_connected" ||
        result.status === "needs_reauth" ||
        result.status === "permission_missing" ||
        // `invalid` was named in the comment above but left out of the
        // condition, so the one case the comment calls out by example — "a bad
        // address, a missing field" — took the failure path it was written to
        // avoid. "At least one recipient is required." became "Data retrieval
        // failed.", and the user was shown an outage where they should have
        // been asked a question.
        //
        // Every `invalid` is something a person resolves: a missing recipient
        // or empty body (they supply it), the plan throttle (they wait), an
        // unsupported action (they ask for something else). None is retryable
        // by the system, which is exactly what makes a failed ToolResult the
        // wrong shape for it.
        result.status === "invalid";

      const text = `${result.message}${result.requiredAction ? ` ${result.requiredAction}` : ""}`;

      if (actionable) {
        return this.success(
          {
            planned: false,
            status: result.status,
            reason: result.message,
            requiredAction: result.requiredAction,
          },
          {
            message: text,
            rule: "Tell the user this is not available yet and state the requiredAction verbatim. Do NOT retry and do NOT claim anything was done.",
          }
        );
      }

      // Anything left is a genuine provider or internal failure, where a retry
      // is the right suggestion and the all-tools-failed guard is right to
      // fire. The Orchestrator now classifies it into a safe code rather than
      // flattening it to one sentence.
      return this.failure(text);
    }

    const plan = result.plan;
    const risk = WRITE_RISK[plan.action];

    return this.success(
      {
        // The headline fact: nothing has happened.
        executed: false,
        awaitingApproval: true,
        approvalId: result.approvalId,
        action: plan.action,
        target: plan.target,
        recipients: plan.recipients,
        fields: plan.fields,
        risk: {
          level: risk.level,
          irreversible: risk.irreversible,
          outwardFacing: risk.outwardFacing,
          requiresStrongConfirmation: risk.requiresStrongConfirmation,
          consequence: risk.consequence,
        },
        requiredScopes: plan.requiredScopes,
        expiresAt: plan.expiresAt,
        requestId: plan.requestId,
      },
      {
        message: `Prepared but NOT yet done. ${risk.consequence} Approve it on the Approvals page to proceed.`,
        rule:
          "Nothing has been sent, created, changed or deleted. Describe what WILL happen, state the consequence, and tell the user it is waiting for their approval. Never say it is done. You cannot approve it yourself.",
        awaitingApproval: true,
        approvalId: result.approvalId,
        riskLevel: risk.level,
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Shared parameter fragments
// ---------------------------------------------------------------------------

const RECIPIENTS = [
  {
    name: "to",
    type: "array",
    description: "Recipient email addresses. Required. Ask the user rather than guessing one.",
    required: true,
  },
  {
    name: "cc",
    type: "array",
    description: "Optional Cc recipients.",
    required: false,
  },
  {
    name: "subject",
    type: "string",
    description: "The email subject line.",
    required: true,
  },
  {
    name: "body",
    type: "string",
    description: "The plain-text message body. Write it out in full; it is shown to the user for approval.",
    required: true,
  },
] as const;

const EVENT_PARAMS = [
  { name: "summary", type: "string", description: "Event title.", required: true },
  {
    name: "start",
    type: "string",
    description: "ISO 8601 start, e.g. 2026-10-01T09:00:00+05:30. Use a bare YYYY-MM-DD for an all-day event.",
    required: true,
  },
  { name: "end", type: "string", description: "ISO 8601 end. Must be after start.", required: true },
  { name: "allDay", type: "boolean", description: "True for an all-day event.", required: false },
  { name: "location", type: "string", description: "Optional location.", required: false },
  { name: "description", type: "string", description: "Optional description.", required: false },
  {
    name: "attendees",
    type: "array",
    description:
      "Attendee email addresses. IMPORTANT: Google emails every attendee an invitation, so confirm the list with the user before planning.",
    required: false,
  },
  {
    name: "sendUpdates",
    type: "string",
    description:
      "Whether Google notifies attendees: 'all' or 'none'. Defaults to 'all'. Use 'none' only when the user explicitly asks for a silent change.",
    required: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export class CreateGmailDraftTool extends GoogleWritePlanTool {
  constructor(port: GoogleWritePlanPort) {
    super(
      port,
      "gmail.createDraft",
      "Create a Gmail draft",
      [
        "PREPARES a Gmail draft for the user's approval. Creates NOTHING until they approve it, and never sends.",
        "USE THIS for 'draft an email to X', 'Priya ko email likho', 'prepare a reply'.",
        "Write the full subject and body — the user reads them before approving.",
        "After calling this, tell the user the draft is prepared and waiting for approval. Do NOT say it was created or sent.",
      ].join(" "),
      [...RECIPIENTS]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.planIt(params, context);
  }
}

export class UpdateGmailDraftTool extends GoogleWritePlanTool {
  constructor(port: GoogleWritePlanPort) {
    super(
      port,
      "gmail.updateDraft",
      "Update a Gmail draft",
      [
        "PREPARES a replacement for an existing Gmail draft, for the user's approval. Changes nothing until approved, and never sends.",
        "Gmail replaces a draft wholesale, so supply the COMPLETE subject, body and recipients — not just the part being changed.",
        "You need the draft id from a previous draft or a Gmail search.",
      ].join(" "),
      [
        { name: "draftId", type: "string", description: "The draft to replace.", required: true },
        ...RECIPIENTS,
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.planIt(params, context);
  }
}

/**
 * Requests a send. Cannot send.
 *
 * Named `request_send_gmail_draft` for the model precisely because it does not
 * send: the tool creates an approval describing the send, and a human sending
 * it is a separate act this tool cannot perform.
 */
export class RequestSendGmailDraftTool extends GoogleWritePlanTool {
  constructor(port: GoogleWritePlanPort) {
    super(
      port,
      "gmail.sendDraft",
      "Request approval to send a Gmail draft",
      [
        "REQUESTS APPROVAL to send an existing draft. This tool CANNOT send the email — it only asks the user to approve sending it.",
        "Sending is IRREVERSIBLE and cannot be recalled, so it always requires explicit human approval.",
        "Supply the recipients, subject and a body preview when you have them, so the approval shows the user what will go out.",
        "After calling this, say that approval is required to send, and state that it cannot be undone. NEVER say the email was sent.",
      ].join(" "),
      [
        { name: "draftId", type: "string", description: "The draft to send.", required: true },
        { name: "to", type: "array", description: "Recipients, for display on the approval.", required: false },
        { name: "subject", type: "string", description: "Subject, for display on the approval.", required: false },
        {
          name: "bodyPreview",
          type: "string",
          description: "A preview of the body, for display on the approval.",
          required: false,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.planIt(params, context);
  }
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

export class CreateDriveFolderTool extends GoogleWritePlanTool {
  constructor(port: GoogleWritePlanPort) {
    super(
      port,
      "drive.createFolder",
      "Create a Drive folder",
      [
        "PREPARES a new Drive folder for approval. Creates nothing until approved.",
        "USE THIS for 'make a folder called X', 'Drive mein folder banao'.",
      ].join(" "),
      [
        { name: "name", type: "string", description: "Folder name. Cannot contain / or \\.", required: true },
        {
          name: "parentId",
          type: "string",
          description: "Parent folder id. Omit for the root of My Drive.",
          required: false,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.planIt(params, context);
  }
}

export class UploadDriveFileTool extends GoogleWritePlanTool {
  constructor(port: GoogleWritePlanPort) {
    super(
      port,
      "drive.uploadFile",
      "Upload a file to Drive",
      [
        "PREPARES a NEW Drive file with text content, for approval. Uploads nothing until approved.",
        "This can only CREATE a file — it cannot overwrite an existing one.",
        "Supply the content as text. Binary is not supported through this tool.",
      ].join(" "),
      [
        { name: "name", type: "string", description: "File name.", required: true },
        {
          name: "content",
          type: "string",
          description: "The file's text content. Shown to the user for approval.",
          required: true,
        },
        {
          name: "mimeType",
          type: "string",
          description: "MIME type, e.g. text/plain or text/csv. Defaults to text/plain.",
          required: false,
        },
        { name: "parentId", type: "string", description: "Destination folder id.", required: false },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.planIt(params, context);
  }
}

export class MoveDriveFileTool extends GoogleWritePlanTool {
  constructor(port: GoogleWritePlanPort) {
    super(
      port,
      "drive.moveFile",
      "Move a Drive file",
      [
        "PREPARES a move of a Drive file to another folder, for approval. Moves nothing until approved.",
        "Requires the file id and the destination folder id, both from a Drive search — never guess an id.",
        "Anyone who had the file bookmarked by location will no longer find it there, so this needs explicit approval.",
      ].join(" "),
      [
        { name: "fileId", type: "string", description: "The file to move.", required: true },
        { name: "addParentId", type: "string", description: "Destination folder id.", required: true },
        {
          name: "removeParentIds",
          type: "array",
          description:
            "The file's current parent folder ids, which will be removed. Get them from the file's metadata.",
          required: false,
        },
        { name: "name", type: "string", description: "The file's name, for display.", required: false },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.planIt(params, context);
  }
}

export class RenameDriveFileTool extends GoogleWritePlanTool {
  constructor(port: GoogleWritePlanPort) {
    super(
      port,
      "drive.renameFile",
      "Rename a Drive file",
      [
        "PREPARES a rename of a Drive file, for approval. Renames nothing until approved.",
        "The name changes for everyone who can see the file, so this needs explicit approval.",
      ].join(" "),
      [
        { name: "fileId", type: "string", description: "The file to rename.", required: true },
        { name: "newName", type: "string", description: "The new name.", required: true },
        {
          name: "currentName",
          type: "string",
          description: "The current name, so the approval can show the change.",
          required: false,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.planIt(params, context);
  }
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export class CreateCalendarEventTool extends GoogleWritePlanTool {
  constructor(port: GoogleWritePlanPort) {
    super(
      port,
      "calendar.createEvent",
      "Create a calendar event",
      [
        "PREPARES a new calendar event for approval. Creates nothing until approved.",
        "IMPORTANT: if the event has attendees, approving it makes Google EMAIL them an invitation. Confirm the attendee list with the user before planning.",
        "USE THIS for 'schedule a meeting', 'kal 3 baje meeting lagao'.",
      ].join(" "),
      [...EVENT_PARAMS]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.planIt(params, context);
  }
}

export class UpdateCalendarEventTool extends GoogleWritePlanTool {
  constructor(port: GoogleWritePlanPort) {
    super(
      port,
      "calendar.updateEvent",
      "Update a calendar event",
      [
        "PREPARES a change to an existing calendar event, for approval. Changes nothing until approved.",
        "IMPORTANT: approving it makes Google email every attendee about the change.",
        "Supply the complete intended state of the event — title, start, end — not only the changed field.",
        "You need the event id from a previous calendar listing.",
      ].join(" "),
      [
        { name: "eventId", type: "string", description: "The event to change.", required: true },
        { name: "calendarId", type: "string", description: "Calendar id. Defaults to primary.", required: false },
        ...EVENT_PARAMS,
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.planIt(params, context);
  }
}

export class DeleteCalendarEventTool extends GoogleWritePlanTool {
  constructor(port: GoogleWritePlanPort) {
    super(
      port,
      "calendar.deleteEvent",
      "Request approval to delete a calendar event",
      [
        "REQUESTS APPROVAL to delete a calendar event. This tool CANNOT delete it — it only asks the user to approve the deletion.",
        "Deletion is IRREVERSIBLE, and Google emails every attendee that the event was cancelled.",
        "Always include the event's title and start time so the approval shows the user exactly which meeting is being cancelled.",
        "NEVER say the event was deleted. Say approval is required and that it cannot be undone.",
      ].join(" "),
      [
        { name: "eventId", type: "string", description: "The event to delete.", required: true },
        { name: "calendarId", type: "string", description: "Calendar id. Defaults to primary.", required: false },
        { name: "summary", type: "string", description: "The event title, for display.", required: false },
        { name: "start", type: "string", description: "The event start, for display.", required: false },
        {
          name: "attendees",
          type: "array",
          description: "Attendees who will be told it was cancelled, for display.",
          required: false,
        },
        {
          name: "sendUpdates",
          type: "string",
          description: "'all' to notify attendees of the cancellation, 'none' to delete silently. Defaults to 'all'.",
          required: false,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.planIt(params, context);
  }
}

// ---------------------------------------------------------------------------

export function createGoogleWriteTools(port: GoogleWritePlanPort): BaseTool[] {
  return [
    new CreateGmailDraftTool(port),
    new UpdateGmailDraftTool(port),
    new RequestSendGmailDraftTool(port),
    new CreateDriveFolderTool(port),
    new UploadDriveFileTool(port),
    new MoveDriveFileTool(port),
    new RenameDriveFileTool(port),
    new CreateCalendarEventTool(port),
    new UpdateCalendarEventTool(port),
    new DeleteCalendarEventTool(port),
  ];
}

/**
 * Registry ids — every one prefixed `google.plan.`.
 *
 * The prefix is not decoration: it is how the agent policy, the capability
 * registry and a reader of an audit log can all tell at a glance that these
 * tools plan rather than execute.
 */
export const GOOGLE_WRITE_TOOL_IDS = [
  "google.plan.gmail.createDraft",
  "google.plan.gmail.updateDraft",
  "google.plan.gmail.sendDraft",
  "google.plan.drive.createFolder",
  "google.plan.drive.uploadFile",
  "google.plan.drive.moveFile",
  "google.plan.drive.renameFile",
  "google.plan.calendar.createEvent",
  "google.plan.calendar.updateEvent",
  "google.plan.calendar.deleteEvent",
] as const;
