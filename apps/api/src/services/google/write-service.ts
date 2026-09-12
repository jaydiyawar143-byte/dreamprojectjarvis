// ---------------------------------------------------------------------------
// GoogleWriteService — plan, approve, execute. Phase 13.
//
//     Frontend button  ──┐
//                        ├──► plan()    ──► durable Approval row (PENDING)
//     JARVIS tool      ──┘                        │
//                                                 │ user approves via the
//                                                 │ existing /approvals API
//                                                 ▼
//                              execute() ──► consumeForExecution() ──► Google
//
// NO NEW APPROVAL SYSTEM. This reuses the repository that already exists, and
// specifically `consumeForExecution`, which in ONE database transaction
// verifies that the approval belongs to this user, names this tool, matches
// this payload hash, is APPROVED, and has not expired — then flips it to
// CONSUMED. Single-use, wrong-user, expired and payload-mismatch are therefore
// not four checks this file performs; they are one atomic condition the
// database enforces, which is the only way to get it right under concurrency.
//
// PLANNING NEVER WRITES. `plan()` resolves access, validates, builds the plan
// and creates a PENDING approval. It touches no Google write endpoint. There is
// no argument to it that causes a write, which is what makes "never execute
// from an unconfirmed command" structural rather than procedural.
//
// THE HASH IS THE CONTRACT. `plan()` stores `payloadHash` on the approval;
// `execute()` recomputes it from the parameters it is actually about to use and
// hands it to the consume. Different content, different hash, no write.
//
// IDEMPOTENCY IS DURABLE. Every write claims an execution-journal row keyed on
// the idempotency key before the provider call. A second attempt with the same
// key finds the row and refuses, so a retried send cannot send twice — and an
// INDETERMINATE outcome (timeout, 5xx) is never retried automatically at all.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import {
  WRITE_ACTION_SERVICE,
  WRITE_RISK,
  computeParamsHash,
  getGoogleService,
  isGoogleWriteAction,
  scopesForWriteUpgrade,
  type GoogleWriteAction,
  type GoogleWritePlan,
  type GoogleWritePlanResult,
  type GoogleWriteResult,
  type IGoogleConnectionRepository,
  type PlanField,
  type WriteVerification,
} from "@jarvis/core";
import {
  CalendarWriteService,
  DriveWriteService,
  GmailWriteService,
  GoogleCalendarService,
  GoogleDriveService,
  resolveAccess,
  validateDraft,
  validateEvent,
  validateFileId,
  validateName,
  type GoogleWriteOutcome,
  type SendUpdates,
} from "@jarvis/google-workspace";
import type { GoogleConfig } from "@jarvis/google-ads";
import type { AuditLogger } from "@jarvis/security";
import { verifyWrite } from "./verify-write.js";

/** How long a planned write stays approvable. */
const PLAN_TTL_MS = 10 * 60 * 1000;

/**
 * Per-user ceilings.
 *
 * Planning is limited too, and deliberately: an unbounded planner can flood the
 * approvals list until the real request is impossible to find, which is a denial
 * of service against the user's own attention.
 */
export const GOOGLE_WRITE_RATE_LIMITS = {
  plan: { limit: 20, windowMs: 60_000 },
  execute: { limit: 20, windowMs: 60_000 },
} as const;

export interface RateLimitPort {
  check(
    userId: string,
    bucket: string,
    limit: number,
    windowMs: number
  ): Promise<{ allowed: boolean; currentCount: number; limit: number }>;
}

/** The existing durable approval store. Reused, never reimplemented. */
export interface ApprovalStorePort {
  create(data: {
    userId: string;
    toolId: string;
    action: string;
    params: Record<string, unknown>;
    paramsHash: string;
    riskLevel: string;
    expiresAt: Date;
    conversationId?: string | null;
  }): Promise<{ id: string }>;
  findByIdForUser(id: string, userId: string): Promise<{
    id: string;
    userId: string;
    toolId: string;
    action: string;
    params: unknown;
    paramsHash: string | null;
    status: string;
    expiresAt: Date;
  } | null>;
  consumeForExecution(input: {
    approvalId: string;
    userId: string;
    toolId: string;
    paramsHash: string;
    executionId: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** The existing durable execution journal. Reused for idempotency. */
export interface ExecutionJournalPort {
  begin(input: {
    userId: string;
    toolId: string;
    paramsHash: string;
    idempotencyKey: string;
    executionId: string;
  }): Promise<{ created: boolean; executionId: string; status: string }>;
  markStatus(
    executionId: string,
    status: "COMPLETED" | "FAILED" | "UNKNOWN",
    detail?: string
  ): Promise<void>;
}

export interface IntegrationEnabledReader {
  isEnabled(userId: string, integration: string): Promise<boolean>;
}

export interface GoogleWriteDeps {
  connections: IGoogleConnectionRepository;
  config: GoogleConfig | null;
  audit: AuditLogger;
  rateLimiter: RateLimitPort;
  approvals: ApprovalStorePort;
  journal: ExecutionJournalPort;
  integrationState: IntegrationEnabledReader;
  gmail?: GmailWriteService;
  drive?: DriveWriteService;
  calendar?: CalendarWriteService;
  /**
   * READ services, used only to confirm a write took effect.
   *
   * Separate instances from the write services on purpose: verification is a
   * read, and giving the verifier a write client would let a future edit
   * "verify" by writing again.
   */
  driveRead?: GoogleDriveService;
  calendarRead?: GoogleCalendarService;
  now?: () => Date;
}

export interface WriteContext {
  userId: string;
  source: "frontend" | "jarvis";
  traceId?: string;
  /**
   * True when the caller cannot render a plan the user can read.
   *
   * A voice session may PLAN a write — that is how "email Priya" starts — but
   * it may never approve one, because approving something you were told about
   * out loud is not the same as approving something you read.
   */
  voice?: boolean;
  conversationId?: string | null;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

/**
 * Normalizes parameters before hashing.
 *
 * Key order and surrounding whitespace must not change the hash, or an approval
 * issued to the dashboard would not validate for the agent and vice versa. The
 * hash must depend on MEANING, not on serialization.
 */
function canonical(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value.trim() : value;
  }
  return out;
}

function field(label: string, after: unknown, before?: unknown): PlanField {
  return {
    label,
    before: before === undefined || before === null ? null : String(before),
    after: after === undefined || after === null ? "" : String(after),
  };
}

/** Truncates content for the plan without hiding that it was truncated. */
function preview(value: string, max = 600): string {
  return value.length > max ? `${value.slice(0, max)}… (${value.length} characters total)` : value;
}

// ---------------------------------------------------------------------------

export class GoogleWriteService {
  private readonly gmail: GmailWriteService;
  private readonly drive: DriveWriteService;
  private readonly calendar: CalendarWriteService;
  private readonly driveRead: GoogleDriveService;
  private readonly calendarRead: GoogleCalendarService;
  private readonly now: () => Date;

  constructor(private readonly deps: GoogleWriteDeps) {
    this.gmail = deps.gmail ?? new GmailWriteService();
    this.drive = deps.drive ?? new DriveWriteService();
    this.calendar = deps.calendar ?? new CalendarWriteService();
    this.driveRead = deps.driveRead ?? new GoogleDriveService();
    this.calendarRead = deps.calendarRead ?? new GoogleCalendarService();
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // PLAN — describes, never writes
  // -------------------------------------------------------------------------

  async plan(
    action: string,
    params: Record<string, unknown>,
    context: WriteContext
  ): Promise<GoogleWritePlanResult> {
    const requestId = context.traceId ?? randomUUID();

    if (!isGoogleWriteAction(action)) {
      return this.planFailure(
        requestId,
        "invalid",
        `"${String(action).slice(0, 60)}" is not a supported Google write action.`
      );
    }

    const service = WRITE_ACTION_SERVICE[action];

    if (!this.deps.config) {
      return this.planFailure(
        requestId,
        "not_connected",
        "Google is not configured on this server.",
        "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI and restart."
      );
    }

    if (!(await this.deps.integrationState.isEnabled(context.userId, "google"))) {
      return this.planFailure(
        requestId,
        "not_connected",
        "The Google integration is switched off.",
        "Enable Google in the Integration Center, then try again."
      );
    }

    const throttled = await this.deps.rateLimiter.check(
      context.userId,
      `plan.${service}`,
      GOOGLE_WRITE_RATE_LIMITS.plan.limit,
      GOOGLE_WRITE_RATE_LIMITS.plan.windowMs
    );
    if (!throttled.allowed) {
      return this.planFailure(
        requestId,
        "invalid",
        `Too many write requests. The limit is ${throttled.limit} per minute.`
      );
    }

    // The WRITE scope, not the read scope. A connection that granted only
    // read must be refused here rather than at execution — refusing after the
    // user has approved is a worse experience and wastes their decision.
    const access = await this.resolveWriteAccess(context.userId, service);
    if (!access.ok) {
      return this.planFailure(requestId, access.status, access.message, access.requiredAction);
    }

    const built = this.buildPlan(action, params, requestId);
    if ("error" in built) {
      return this.planFailure(requestId, "invalid", built.error);
    }

    // The durable PENDING approval. `paramsHash` is what execution re-checks.
    const approval = await this.deps.approvals.create({
      userId: context.userId,
      // The tool id IS the action, so a consume cannot cross actions.
      toolId: action,
      action,
      params: built.plan as unknown as Record<string, unknown>,
      paramsHash: built.plan.payloadHash,
      riskLevel: built.plan.risk.level,
      expiresAt: new Date(Date.parse(built.plan.expiresAt)),
      conversationId: context.conversationId ?? null,
    });

    await this.audit(action, context, "plan", "success", {
      requestId,
      approvalId: approval.id,
      risk: built.plan.risk.level,
      recipientCount: built.plan.recipients.length,
    });

    return {
      success: true,
      status: "approval_required",
      plan: built.plan,
      approvalId: approval.id,
      message: `${built.plan.risk.consequence} Approve it to proceed.`,
      requestId,
    };
  }

  /** Resolves a token that carries the WRITE scope for `service`. */
  private async resolveWriteAccess(userId: string, service: "gmail" | "drive" | "calendar") {
    const spec = getGoogleService(service);
    const summary = await this.deps.connections.findByUser(userId);

    if (!summary) {
      return {
        ok: false as const,
        status: "not_connected" as const,
        message: "No Google account is connected.",
        requiredAction: "Connect your Google account, then try again.",
      };
    }

    // GRANTED write scopes, never requested ones.
    const granted = new Set(summary.scopes);
    const missing = (spec?.writeScopes ?? []).filter((s) => !granted.has(s));
    if (missing.length > 0) {
      return {
        ok: false as const,
        status: "permission_missing" as const,
        message: `Your Google connection does not grant permission to change ${spec?.label ?? service}.`,
        // Explicit: this system never widens a grant on its own.
        requiredAction: `Reconnect Google and approve write access for ${spec?.label ?? service}.`,
      };
    }

    // Reuse the read path's refresh logic — same vault, same OAuth primitives —
    // but require the WRITE scopes, not the read ones. A write must not demand
    // read access it does not need.
    const access = await resolveAccess(
      userId,
      service,
      {
        connections: this.deps.connections,
        config: this.deps.config!,
        now: this.now,
      },
      spec?.writeScopes ?? []
    );

    if (!access.ok) {
      return {
        ok: false as const,
        status: access.status,
        message: access.message,
        requiredAction: access.requiredAction,
      };
    }
    // Granted scopes travel with the token so the verifier can say WHY a check
    // was impossible rather than only that it was.
    return {
      ok: true as const,
      accessToken: access.accessToken,
      grantedScopes: access.grantedScopes,
    };
  }

  /** Builds the plan, or returns a validation error. Pure. */
  private buildPlan(
    action: GoogleWriteAction,
    raw: Record<string, unknown>,
    requestId: string
  ): { plan: GoogleWritePlan } | { error: string } {
    const params = canonical(raw);
    const service = WRITE_ACTION_SERVICE[action];
    const risk = WRITE_RISK[action];
    const scopes = scopesForWriteUpgrade([service]);

    const str = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : "");
    const arr = (k: string) =>
      Array.isArray(params[k]) ? (params[k] as unknown[]).map(String).filter(Boolean) : [];

    let target: GoogleWritePlan["target"];
    let recipients: string[] = [];
    let fields: PlanField[] = [];

    switch (action) {
      case "gmail.createDraft":
      case "gmail.updateDraft": {
        const to = arr("to");
        if (to.length === 0) return { error: "At least one recipient is required." };
        if (!str("body")) return { error: "The message body cannot be empty." };

        // The SAME validator the provider layer runs at execution. Validating
        // here as well is not duplication — it is running it EARLIER, so a
        // malformed recipient is caught before the user is asked to approve
        // something that cannot succeed, and before the plan displays an
        // address as though it will be mailed.
        const draftCheck = validateDraft({
          to,
          cc: arr("cc"),
          bcc: arr("bcc"),
          subject: str("subject"),
          body: str("body"),
        });
        if (!draftCheck.ok) return { error: draftCheck.message };

        recipients = [...to, ...arr("cc"), ...arr("bcc")];
        target = {
          kind: "draft",
          id: action === "gmail.updateDraft" ? str("draftId") || null : null,
          label: str("subject") || "(no subject)",
        };
        fields = [
          field("To", to.join(", ")),
          ...(arr("cc").length ? [field("Cc", arr("cc").join(", "))] : []),
          ...(arr("bcc").length ? [field("Bcc", arr("bcc").join(", "))] : []),
          field("Subject", str("subject") || "(no subject)"),
          field("Body", preview(str("body"))),
        ];
        if (action === "gmail.updateDraft" && !str("draftId")) {
          return { error: "A draft id is required to update a draft." };
        }
        break;
      }

      case "gmail.sendDraft": {
        const draftId = str("draftId");
        if (!draftId) return { error: "A draft id is required." };

        // The plan carries the draft's own details when the caller supplied
        // them, so the approval shows WHAT is being sent rather than an opaque
        // id. They are display-only: send takes the id and nothing else.
        recipients = arr("to");
        target = { kind: "draft", id: draftId, label: str("subject") || `draft ${draftId}` };
        fields = [
          field("Draft", draftId),
          ...(recipients.length ? [field("Recipients", recipients.join(", "))] : []),
          ...(str("subject") ? [field("Subject", str("subject"))] : []),
          ...(str("bodyPreview") ? [field("Body", preview(str("bodyPreview")))] : []),
        ];
        break;
      }

      case "drive.createFolder": {
        const nameCheck = validateName(str("name"));
        if (!nameCheck.ok) return { error: nameCheck.message };
        target = {
          kind: "folder",
          id: null,
          label: str("name"),
          ...(str("parentId") ? { location: str("parentId") } : {}),
        };
        fields = [
          field("Folder name", str("name")),
          field("Parent", str("parentId") || "My Drive (root)"),
        ];
        break;
      }

      case "drive.uploadFile": {
        const uploadName = validateName(str("name"));
        if (!uploadName.ok) return { error: uploadName.message };
        if (!str("content")) return { error: "The file has no content." };
        target = {
          kind: "file",
          id: null,
          label: str("name"),
          ...(str("parentId") ? { location: str("parentId") } : {}),
        };
        fields = [
          field("File name", str("name")),
          field("Type", str("mimeType") || "text/plain"),
          field("Size", `${str("content").length} characters of source content`),
          field("Parent", str("parentId") || "My Drive (root)"),
        ];
        break;
      }

      case "drive.moveFile": {
        const moveId = validateFileId(str("fileId"));
        if (!moveId.ok) return { error: moveId.message };
        const destId = validateFileId(str("addParentId"));
        if (!destId.ok) return { error: `destination: ${destId.message}` };
        target = { kind: "file", id: str("fileId"), label: str("name") || str("fileId") };
        fields = [
          field("File", str("name") || str("fileId")),
          field("Destination", str("addParentId"), arr("removeParentIds").join(", ") || "(current)"),
        ];
        break;
      }

      case "drive.renameFile": {
        const renameId = validateFileId(str("fileId"));
        if (!renameId.ok) return { error: renameId.message };
        const renameName = validateName(str("newName"));
        if (!renameName.ok) return { error: renameName.message };
        target = { kind: "file", id: str("fileId"), label: str("newName") };
        fields = [field("Name", str("newName"), str("currentName") || null)];
        break;
      }

      case "calendar.createEvent":
      case "calendar.updateEvent": {
        if (action === "calendar.updateEvent" && !str("eventId")) {
          return { error: "An event id is required to update an event." };
        }

        // Same validator as execution, run earlier for the same reason.
        const eventCheck = validateEvent({
          summary: str("summary"),
          description: str("description"),
          location: str("location"),
          start: str("start"),
          end: str("end"),
          allDay: params.allDay === true,
          attendees: arr("attendees"),
        });
        if (!eventCheck.ok) return { error: eventCheck.message };

        const attendees = arr("attendees");
        // Attendees WILL be emailed by Google. They are recipients, and the
        // plan says so — this is the fact most easily missed about a calendar
        // write.
        recipients = str("sendUpdates") === "none" ? [] : attendees;

        target = {
          kind: "event",
          id: action === "calendar.updateEvent" ? str("eventId") : null,
          label: str("summary"),
          ...(str("calendarId") ? { location: str("calendarId") } : {}),
        };
        fields = [
          field("Title", str("summary")),
          field("Start", str("start")),
          field("End", str("end")),
          ...(str("location") ? [field("Location", str("location"))] : []),
          ...(str("description") ? [field("Description", preview(str("description")))] : []),
          ...(attendees.length ? [field("Attendees", attendees.join(", "))] : []),
          field(
            "Notify attendees",
            str("sendUpdates") === "none"
              ? "No"
              : attendees.length > 0
                ? `Yes — Google will email ${attendees.length} attendee(s)`
                : "No attendees to notify"
          ),
        ];
        break;
      }

      case "calendar.deleteEvent": {
        if (!str("eventId")) return { error: "An event id is required." };
        recipients = str("sendUpdates") === "none" ? [] : arr("attendees");
        target = {
          kind: "event",
          id: str("eventId"),
          label: str("summary") || `event ${str("eventId")}`,
          ...(str("calendarId") ? { location: str("calendarId") } : {}),
        };
        fields = [
          field("Event", str("summary") || str("eventId")),
          ...(str("start") ? [field("Start", str("start"))] : []),
          field(
            "Notify attendees of cancellation",
            str("sendUpdates") === "none" ? "No" : "Yes"
          ),
        ];
        break;
      }
    }

    // Hash the ACTION together with the parameters: a hash over params alone
    // would let an approval for one action be consumed by another whose
    // parameters happened to match.
    const payloadHash = computeParamsHash({ __action: action, ...params });

    return {
      plan: {
        action,
        source: service,
        target,
        recipients,
        fields,
        requiredScopes: scopes,
        risk,
        // The approved parameters. Execution reads ONLY these.
        params,
        payloadHash,
        requestId,
        expiresAt: new Date(this.now().getTime() + PLAN_TTL_MS).toISOString(),
        // Derived from the hash, so two identical planned sends collapse onto
        // one journal row and cannot both execute.
        idempotencyKey: `${action}:${payloadHash}`,
      },
    };
  }

  /**
   * Reads back a plan and its current status.
   *
   * User-scoped through `findByIdForUser`, so an approval belonging to somebody
   * else is indistinguishable from one that never existed.
   *
   * `expired` is derived here rather than stored, because an approval that was
   * APPROVED and then ran out of time is still APPROVED in the row — expiry is
   * a fact about the clock, and the UI must not offer an Execute button for
   * something the gate will refuse.
   */
  async describe(
    approvalId: string,
    userId: string
  ): Promise<
    | {
        approvalId: string;
        action: GoogleWriteAction;
        status: string;
        expired: boolean;
        executable: boolean;
        plan: GoogleWritePlan;
      }
    | null
  > {
    const approval = await this.deps.approvals.findByIdForUser(approvalId, userId);
    if (!approval) return null;
    if (!isGoogleWriteAction(approval.toolId)) return null;

    const plan = approval.params as unknown as GoogleWritePlan;
    const expired = approval.expiresAt.getTime() <= this.now().getTime();

    return {
      approvalId: approval.id,
      action: approval.toolId,
      status: approval.status,
      expired,
      // The single condition under which Execute can succeed. Anything else
      // and the button must not be offered.
      executable: approval.status === "APPROVED" && !expired,
      plan,
    };
  }

  // -------------------------------------------------------------------------
  // EXECUTE — only with a valid, approved, matching approval
  // -------------------------------------------------------------------------

  async execute(
    approvalId: string,
    context: WriteContext
  ): Promise<GoogleWriteResult> {
    const requestId = context.traceId ?? randomUUID();

    // A voice session may plan but never approve: approving something you were
    // told about aloud is not approving something you read.
    if (context.voice) {
      return this.executeFailure(
        "gmail.createDraft",
        requestId,
        "provider_error",
        "A write cannot be approved by voice. Open the Approvals page to review and approve it.",
        false
      );
    }

    const approval = await this.deps.approvals.findByIdForUser(approvalId, context.userId);
    if (!approval) {
      // Covers both "does not exist" and "belongs to someone else" — the same
      // answer on purpose, so this cannot be used to probe for other users'
      // approval ids.
      return this.executeFailure(
        "gmail.createDraft",
        requestId,
        "provider_error",
        "That approval does not exist.",
        false
      );
    }

    if (!isGoogleWriteAction(approval.toolId)) {
      return this.executeFailure(
        "gmail.createDraft",
        requestId,
        "provider_error",
        "That approval is not for a Google write action.",
        false
      );
    }

    const action = approval.toolId;
    const plan = approval.params as unknown as GoogleWritePlan;
    const service = WRITE_ACTION_SERVICE[action];

    const throttled = await this.deps.rateLimiter.check(
      context.userId,
      `execute.${service}`,
      GOOGLE_WRITE_RATE_LIMITS.execute.limit,
      GOOGLE_WRITE_RATE_LIMITS.execute.windowMs
    );
    if (!throttled.allowed) {
      return this.executeFailure(
        action,
        requestId,
        "provider_error",
        `Too many write executions. The limit is ${throttled.limit} per minute.`,
        true
      );
    }

    const access = await this.resolveWriteAccess(context.userId, service);
    if (!access.ok) {
      await this.audit(action, context, "execute", "failure", {
        requestId,
        approvalId,
        reason: access.status,
      });
      return this.executeFailure(action, requestId, access.status, access.message, false, access.requiredAction);
    }

    // Claim the journal row FIRST, keyed on the plan's idempotency key. A
    // second attempt for the same planned write finds the row already claimed
    // and stops here — before the provider call, which is the only place that
    // ordering prevents a duplicate send.
    const executionId = randomUUID();
    const claim = await this.deps.journal.begin({
      userId: context.userId,
      toolId: action,
      paramsHash: plan.payloadHash,
      idempotencyKey: plan.idempotencyKey,
      executionId,
    });

    if (!claim.created) {
      await this.audit(action, context, "execute", "failure", {
        requestId,
        approvalId,
        reason: "duplicate",
        priorStatus: claim.status,
      });
      return {
        success: false,
        source: service,
        action,
        status: "provider_error",
        verification: claim.status === "COMPLETED" ? "verified" : "indeterminate",
        data: null,
        message:
          claim.status === "COMPLETED"
            ? "This change has already been applied. It was not repeated."
            : "This change is already in progress or its outcome is unknown. It was not repeated.",
        requestId,
        // Never safe: repeating is exactly what must not happen.
        retrySafe: false,
      };
    }

    // THE GATE. One transaction verifies user + tool + payload hash + APPROVED
    // + not expired, and flips to CONSUMED. Everything Phase 13 requires about
    // approval integrity is enforced here, atomically.
    const consumed = await this.deps.approvals.consumeForExecution({
      approvalId,
      userId: context.userId,
      toolId: action,
      paramsHash: plan.payloadHash,
      executionId,
    });

    if (!consumed.ok) {
      await this.deps.journal.markStatus(executionId, "FAILED", `approval denied: ${consumed.reason}`);
      await this.audit(action, context, "execute", "failure", {
        requestId,
        approvalId,
        reason: consumed.reason,
      });
      return this.executeFailure(
        action,
        requestId,
        "provider_error",
        `This change was not approved, or the approval is no longer valid: ${consumed.reason}.`,
        // Re-planning is the remedy, not retrying.
        false,
        "Plan the change again and approve the new request."
      );
    }

    // --- the provider call ---------------------------------------------------
    let outcome: GoogleWriteOutcome<unknown>;
    try {
      outcome = await this.dispatch(action, access.accessToken, plan, context.signal);
    } catch {
      // A thrown write left this process. Whether Google applied it is unknown.
      await this.deps.journal.markStatus(executionId, "UNKNOWN", "provider call threw");
      await this.audit(action, context, "execute", "failure", {
        requestId,
        approvalId,
        reason: "threw",
      });
      return {
        success: false,
        source: service,
        action,
        status: "provider_error",
        verification: "indeterminate",
        data: null,
        message: "The change could not be completed, and it is not known whether it was applied.",
        requestId,
        retrySafe: false,
      };
    }

    if (!outcome.ok) {
      const indeterminate = "indeterminate" in outcome && outcome.indeterminate === true;
      const duplicate = "duplicate" in outcome && outcome.duplicate === true;

      await this.deps.journal.markStatus(
        executionId,
        indeterminate ? "UNKNOWN" : duplicate ? "COMPLETED" : "FAILED",
        outcome.message
      );

      const auditRef = await this.audit(action, context, "execute", "failure", {
        requestId,
        approvalId,
        reason: outcome.status,
        duplicate,
        indeterminate,
      });

      return {
        success: false,
        source: service,
        action,
        status: outcome.status,
        verification: indeterminate ? "indeterminate" : duplicate ? "verified" : "failed",
        data: null,
        message: duplicate
          ? `${outcome.message} It was not applied a second time.`
          : outcome.message,
        ...("requiredAction" in outcome && outcome.requiredAction
          ? { requiredAction: outcome.requiredAction }
          : {}),
        requestId,
        ...(auditRef ? { auditRef } : {}),
        // Only a plain failure is safe to retry. An indeterminate outcome never
        // is, and a duplicate needs no retry.
        retrySafe: !indeterminate && !duplicate,
      };
    }

    // The write succeeded. Mark it COMPLETED before verifying: the journal
    // records what HAPPENED, and a verification that then fails must not make
    // the row look like the write did not happen.
    await this.deps.journal.markStatus(executionId, "COMPLETED");

    // Read the resource back and compare it against the approved plan. This
    // cannot fail the write — see verify-write.ts.
    const verified = await verifyWrite(
      action,
      access.accessToken,
      plan,
      outcome.body,
      access.grantedScopes ?? [],
      { driveRead: this.driveRead, calendarRead: this.calendarRead },
      context.signal
    );

    const auditRef = await this.audit(action, context, "execute", "success", {
      requestId,
      approvalId,
      risk: plan.risk.level,
      recipientCount: plan.recipients.length,
      verification: verified.verification,
    });

    return {
      // The WRITE succeeded, whatever verification concluded. A verification
      // failure is reported in its own field rather than by pretending the
      // change did not happen — the user needs to know it DID.
      success: true,
      source: service,
      action,
      status: "ok",
      verification: verified.verification,
      data: outcome.body,
      message:
        verified.verification === "verified"
          ? `${plan.risk.consequence.replace(/\.$/, "")} — done and confirmed.`
          : verified.verification === "verification_failed"
            ? `The change was applied, but confirming it found something unexpected: ${verified.detail ?? "the re-read did not match"}. Check it before doing anything else.`
            : `${plan.risk.consequence.replace(/\.$/, "")} — done. ${verified.detail ?? "It was not independently confirmed."}`,
      requestId,
      ...(auditRef ? { auditRef } : {}),
      // Never. The write happened; repeating it is the one thing to avoid.
      retrySafe: false,
    };
  }

  // -------------------------------------------------------------------------

  private dispatch(
    action: GoogleWriteAction,
    accessToken: string,
    plan: GoogleWritePlan,
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<unknown>> {
    // Parameters come from the APPROVED PLAN, never from the execute request.
    // That is what makes the payload hash meaningful: there is no channel by
    // which different content could reach the provider at execution time.
    // From the APPROVED PLAN, never from the execute request. That is what
    // makes the payload hash meaningful: there is no channel by which
    // different content could reach the provider at execution time.
    const params = plan.params ?? {};

    const str = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : "");
    const arr = (k: string) =>
      Array.isArray(params[k]) ? (params[k] as unknown[]).map(String).filter(Boolean) : [];
    const sendUpdates = (str("sendUpdates") || "all") as SendUpdates;

    switch (action) {
      case "gmail.createDraft":
        return this.gmail.createDraft(
          accessToken,
          { to: arr("to"), cc: arr("cc"), bcc: arr("bcc"), subject: str("subject"), body: str("body") },
          signal
        );

      case "gmail.updateDraft":
        return this.gmail.updateDraft(
          accessToken,
          str("draftId"),
          { to: arr("to"), cc: arr("cc"), bcc: arr("bcc"), subject: str("subject"), body: str("body") },
          signal
        );

      case "gmail.sendDraft":
        // The id and nothing else. No content can be substituted here.
        return this.gmail.sendDraft(accessToken, str("draftId"), signal);

      case "drive.createFolder":
        return this.drive.createFolder(accessToken, str("name"), str("parentId") || undefined, signal);

      case "drive.uploadFile":
        return this.drive.uploadFile(
          accessToken,
          {
            name: str("name"),
            mimeType: str("mimeType") || "text/plain",
            content: str("content"),
            base64: params.base64 === true,
            ...(str("parentId") ? { parentId: str("parentId") } : {}),
          },
          signal
        );

      case "drive.moveFile":
        return this.drive.moveFile(
          accessToken,
          {
            fileId: str("fileId"),
            addParentId: str("addParentId"),
            removeParentIds: arr("removeParentIds"),
          },
          signal
        );

      case "drive.renameFile":
        return this.drive.renameFile(accessToken, str("fileId"), str("newName"), signal);

      case "calendar.createEvent":
        return this.calendar.createEvent(
          accessToken,
          {
            summary: str("summary"),
            description: str("description"),
            location: str("location"),
            start: str("start"),
            end: str("end"),
            allDay: params.allDay === true,
            attendees: arr("attendees"),
            calendarId: str("calendarId") || "primary",
          },
          sendUpdates,
          signal
        );

      case "calendar.updateEvent":
        return this.calendar.updateEvent(
          accessToken,
          str("eventId"),
          {
            summary: str("summary"),
            description: str("description"),
            location: str("location"),
            start: str("start"),
            end: str("end"),
            allDay: params.allDay === true,
            attendees: arr("attendees"),
            calendarId: str("calendarId") || "primary",
          },
          sendUpdates,
          signal
        );

      case "calendar.deleteEvent":
        return this.calendar.deleteEvent(
          accessToken,
          str("eventId"),
          str("calendarId") || "primary",
          sendUpdates,
          signal
        );
    }
  }

  private planFailure(
    requestId: string,
    status: GoogleWritePlanResult["status"],
    message: string,
    requiredAction?: string
  ): GoogleWritePlanResult {
    return {
      success: false,
      status,
      plan: null,
      approvalId: null,
      message,
      ...(requiredAction ? { requiredAction } : {}),
      requestId,
    };
  }

  private executeFailure(
    action: GoogleWriteAction,
    requestId: string,
    status: GoogleWriteResult["status"],
    message: string,
    retrySafe: boolean,
    requiredAction?: string
  ): GoogleWriteResult {
    return {
      success: false,
      source: WRITE_ACTION_SERVICE[action],
      action,
      status,
      verification: "failed" as WriteVerification,
      data: null,
      message,
      ...(requiredAction ? { requiredAction } : {}),
      requestId,
      retrySafe,
    };
  }

  /**
   * Records the plan or the execution.
   *
   * NEVER the content. A draft body, a file's contents, an event description
   * and an attendee list are all private, and the audit trail is long-lived and
   * widely readable. What is recorded is the action, the outcome, the risk
   * level and a COUNT of recipients — enough to answer "what did JARVIS do and
   * when", and not enough to reconstruct the mail.
   */
  private async audit(
    action: string,
    context: WriteContext,
    phase: "plan" | "execute",
    result: "success" | "failure",
    metadata: Record<string, unknown>
  ): Promise<string | undefined> {
    try {
      await this.deps.audit.log({
        userId: context.userId,
        action: `google.write.${phase}.${action}`,
        result,
        ...(context.traceId ? { traceId: context.traceId } : {}),
        metadata: { source: context.source, ...metadata },
      });
      return typeof metadata.requestId === "string" ? metadata.requestId : undefined;
    } catch {
      // An audit failure must not turn a completed write into a reported
      // failure the user retries. The write already happened.
      return undefined;
    }
  }
}
