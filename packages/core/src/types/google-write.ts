// ---------------------------------------------------------------------------
// Google write actions — Phase 13 contract.
//
// THE PLAN IS THE APPROVAL. A write is never described twice: the
// `GoogleWritePlan` a user sees is hashed, stored on the approval row, and
// re-checked at execution. If the plan the user approved is not byte-identical
// to the plan being executed, the execution is refused. That is why every field
// a user needs to judge the action lives on the plan itself — target, content,
// who gets notified, whether it is reversible — rather than being re-derived at
// execution time from arguments that could have changed.
//
// RISK IS DECLARED, NOT INFERRED. `sendDraft`, `deleteEvent`, `moveFile` and
// `renameFile` are marked `requiresStrongConfirmation` because each is either
// irreversible or visible to other people. The UI and the tools both read this
// flag rather than each deciding for themselves which actions are scary.
//
// NOTHING HERE IS EXECUTABLE. Types and static tables only, so the browser, the
// tool package and the API can all speak this vocabulary without any of them
// gaining the ability to perform a write.
// ---------------------------------------------------------------------------

import type { GoogleTaskSource, GoogleTaskStatus } from "./google-workspace.js";

// ---------------------------------------------------------------------------
// Action identity
// ---------------------------------------------------------------------------

/**
 * The closed set of write actions in this phase.
 *
 * Checked at the service boundary before any credential is resolved, so an
 * action name outside this list cannot reach a provider endpoint. Adding one is
 * a code change that goes through review — which is the point.
 */
export const GOOGLE_WRITE_ACTIONS = [
  "gmail.createDraft",
  "gmail.updateDraft",
  "gmail.sendDraft",
  "drive.createFolder",
  "drive.uploadFile",
  "drive.moveFile",
  "drive.renameFile",
  "calendar.createEvent",
  "calendar.updateEvent",
  "calendar.deleteEvent",
] as const;

export type GoogleWriteAction = (typeof GOOGLE_WRITE_ACTIONS)[number];

export function isGoogleWriteAction(value: unknown): value is GoogleWriteAction {
  return typeof value === "string" && (GOOGLE_WRITE_ACTIONS as readonly string[]).includes(value);
}

/** Which Google service each write needs a granted WRITE scope for. */
export const WRITE_ACTION_SERVICE: Record<GoogleWriteAction, "gmail" | "drive" | "calendar"> = {
  "gmail.createDraft": "gmail",
  "gmail.updateDraft": "gmail",
  "gmail.sendDraft": "gmail",
  "drive.createFolder": "drive",
  "drive.uploadFile": "drive",
  "drive.moveFile": "drive",
  "drive.renameFile": "drive",
  "calendar.createEvent": "calendar",
  "calendar.updateEvent": "calendar",
  "calendar.deleteEvent": "calendar",
};

/**
 * How dangerous each action is, and why.
 *
 * `irreversible` means this system cannot undo it. `outwardFacing` means other
 * people find out — which for a calendar event means Google emails them, and
 * is the reason calendar writes are not the mild operations they look like.
 */
export interface WriteRiskProfile {
  level: "LOW" | "MEDIUM" | "HIGH";
  irreversible: boolean;
  outwardFacing: boolean;
  /** Requires the stronger confirmation gesture in the UI and by voice. */
  requiresStrongConfirmation: boolean;
  /** One sentence a user reads before deciding. */
  consequence: string;
}

export const WRITE_RISK: Record<GoogleWriteAction, WriteRiskProfile> = {
  // Drafts live in the user's own mailbox. Nobody else sees them and they can
  // be edited or discarded, so this is the one genuinely low-risk group.
  "gmail.createDraft": {
    level: "LOW",
    irreversible: false,
    outwardFacing: false,
    requiresStrongConfirmation: false,
    consequence: "Creates a draft in your mailbox. Nothing is sent to anyone.",
  },
  "gmail.updateDraft": {
    level: "LOW",
    irreversible: false,
    outwardFacing: false,
    requiresStrongConfirmation: false,
    consequence: "Replaces the contents of an existing draft. Nothing is sent.",
  },
  "gmail.sendDraft": {
    level: "HIGH",
    irreversible: true,
    outwardFacing: true,
    requiresStrongConfirmation: true,
    consequence: "Sends the email. This cannot be undone or recalled.",
  },

  "drive.createFolder": {
    level: "LOW",
    irreversible: false,
    outwardFacing: false,
    requiresStrongConfirmation: false,
    consequence: "Creates a new empty folder. Nothing existing is changed.",
  },
  "drive.uploadFile": {
    level: "MEDIUM",
    irreversible: false,
    outwardFacing: false,
    requiresStrongConfirmation: false,
    consequence: "Creates a new file in Drive. It cannot overwrite an existing file.",
  },
  // Moving and renaming are reversible in principle, but a colleague looking
  // for the file will not find it where they expect — so they are treated as
  // changes other people notice.
  "drive.moveFile": {
    level: "MEDIUM",
    irreversible: false,
    outwardFacing: true,
    requiresStrongConfirmation: true,
    consequence: "Moves the file. Anyone who had it bookmarked by location will not find it there.",
  },
  "drive.renameFile": {
    level: "MEDIUM",
    irreversible: false,
    outwardFacing: true,
    requiresStrongConfirmation: true,
    consequence: "Renames the file for everyone who can see it.",
  },

  "calendar.createEvent": {
    level: "MEDIUM",
    irreversible: false,
    outwardFacing: true,
    requiresStrongConfirmation: false,
    consequence: "Creates the event. If it has attendees, Google emails them an invitation.",
  },
  "calendar.updateEvent": {
    level: "MEDIUM",
    irreversible: false,
    outwardFacing: true,
    requiresStrongConfirmation: false,
    consequence: "Changes the event. If it has attendees, Google emails them the update.",
  },
  "calendar.deleteEvent": {
    level: "HIGH",
    irreversible: true,
    outwardFacing: true,
    requiresStrongConfirmation: true,
    consequence:
      "Deletes the event permanently. Attendees are emailed that it was cancelled. This cannot be undone.",
  },
};

/** Actions the UI and voice path must gate behind the stronger gesture. */
export const STRONG_CONFIRMATION_ACTIONS: readonly GoogleWriteAction[] =
  GOOGLE_WRITE_ACTIONS.filter((a) => WRITE_RISK[a].requiresStrongConfirmation);

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * One line of the change, as the user reads it.
 *
 * `before` is null for a create. Rendering a diff rather than a blob is what
 * lets someone approve an update without having to remember what it said.
 */
export interface PlanField {
  label: string;
  before: string | null;
  after: string;
}

/**
 * What will happen, in full, before anything happens.
 *
 * This object is hashed and stored on the approval. Every field the user needs
 * in order to decide must be here — if a consequence is not on the plan, the
 * user did not approve it.
 */
export interface GoogleWritePlan {
  action: GoogleWriteAction;
  source: GoogleTaskSource;

  /** What is being changed, named the way the user would name it. */
  target: {
    kind: "draft" | "message" | "folder" | "file" | "event";
    /** Provider id, when the target already exists. Null for a create. */
    id: string | null;
    /** Human label — a subject, a filename, an event title. */
    label: string;
    /** Where it lives, when that is meaningful. */
    location?: string;
  };

  /** Who will be emailed as a direct result. Empty when nobody will be. */
  recipients: string[];

  /** Field-by-field description of the change. */
  fields: PlanField[];

  /** The OAuth scopes this action needs. Shown so consent is legible. */
  requiredScopes: string[];

  risk: WriteRiskProfile;

  /**
   * Stable hash over the action and its normalized parameters.
   *
   * The approval carries this. At execution the hash is recomputed from the
   * parameters actually being used, and a mismatch refuses the write — so an
   * approval cannot be replayed against different content.
   */
  payloadHash: string;

  /**
   * The normalized parameters this write will use.
   *
   * Carried on the plan because the plan is what was APPROVED, so it is also
   * the only legitimate source of what to execute — reading parameters from
   * the execute request would make the payload hash meaningless, since there
   * would be a channel by which different content could reach the provider.
   *
   * This is an execution payload, not an audit record: it lives on the
   * approval row for as long as the approval does, and the audit trail
   * deliberately records only counts and outcomes.
   */
  params: Record<string, unknown>;

  /** Correlates plan, approval, execution and audit rows. */
  requestId: string;

  /** When the plan stops being approvable. */
  expiresAt: string;

  /**
   * Idempotency key for the eventual write.
   *
   * Derived from the action and the payload hash, so two identical planned
   * sends collapse onto one journal entry and cannot both execute.
   */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Whether the write actually took effect, checked rather than assumed. */
export type WriteVerification =
  /** Re-read from the provider and the expected fields matched. */
  | "verified"
  /**
   * The write succeeded but a re-read found something different.
   *
   * DELIBERATELY NOT A FAILURE. The write happened — the provider said so and
   * returned a resource id. What failed is our confirmation of it, and those
   * are different facts with different remedies: a failed execution may be
   * retried, a failed verification must be looked at by a person. Collapsing
   * them would invite a retry of a write that already took effect.
   */
  | "verification_failed"
  /**
   * The provider reported success and no re-read was attempted.
   *
   * Never described to a user as "verified": it means we are taking the
   * provider's word for it.
   */
  | "provider_reported"
  /**
   * A re-read was not possible with the scopes this connection holds.
   *
   * The honest case for Gmail send: `gmail.compose` can send but cannot read
   * the mailbox, so confirming the sent message needs `gmail.readonly`, which
   * this phase does not require. Reported rather than silently downgraded to
   * `provider_reported`, because "we could not check" and "we did not check"
   * are different things.
   */
  | "verification_unavailable"
  /**
   * The call may or may not have been applied — a timeout or a 5xx.
   *
   * NEVER automatically retried. This is the state that exists so a duplicate
   * email is impossible: the user is told, and decides.
   */
  | "indeterminate"
  /** The write did not happen. */
  | "failed";

export interface GoogleWriteResult<T = unknown> {
  success: boolean;
  source: GoogleTaskSource;
  action: GoogleWriteAction;
  status: GoogleTaskStatus;
  verification: WriteVerification;
  data: T | null;
  message?: string;
  requiredAction?: string;
  requestId: string;
  /** The audit row id, so a user can cite what happened. */
  auditRef?: string;
  /** True only when a retry is genuinely safe. */
  retrySafe: boolean;
}

/** What a plan request returns when approval is needed — which is always. */
export interface GoogleWritePlanResult {
  success: boolean;
  status: "approval_required" | "invalid" | "not_connected" | "needs_reauth" | "permission_missing";
  plan: GoogleWritePlan | null;
  /** The durable approval row to approve. Null when planning failed. */
  approvalId: string | null;
  message: string;
  requiredAction?: string;
  requestId: string;
}
