// ---------------------------------------------------------------------------
// Gmail writes — Phase 13. Drafts only, plus sending a draft.
//
// THREE ACTIONS, AND THE SPLIT IS THE SAFETY PROPERTY.
//
//   createDraft / updateDraft  — write to the user's OWN mailbox. Nothing
//                                leaves it. Reversible: a draft can be edited
//                                or deleted, and nobody else has seen it.
//   sendDraft                  — IRREVERSIBLE and OUTWARD-FACING. A sent email
//                                cannot be recalled.
//
// Creating a draft is therefore a fundamentally different act from sending one,
// and they are separate methods with separate scopes and separate risk levels
// rather than a `send: boolean` flag. A flag would mean one approval could be
// re-read as the other.
//
// THERE IS NO `send(to, subject, body)`. Sending takes a DRAFT ID and nothing
// else. The content was written, shown and approved as a draft; send cannot
// substitute different content, because it has no parameter for any.
//
// CONTENT IS DATA, NEVER INSTRUCTIONS. Every header value is sanitized before
// it reaches the MIME body: CR and LF are stripped from headers, because a
// newline in a subject is header injection and lets a caller add a Bcc.
// ---------------------------------------------------------------------------

import { callGoogleWrite, type GoogleWriteOutcome } from "./http-write.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Bound on what one draft may carry. Generous for prose, hostile to abuse. */
const MAX_BODY_CHARS = 100_000;
const MAX_SUBJECT_CHARS = 500;
const MAX_RECIPIENTS = 25;

export interface DraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

export interface GmailDraftResult {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
}

export interface GmailSendResult {
  messageId: string;
  threadId: string | null;
  /** Recipients as Gmail accepted them. Echoed back for verification. */
  labelIds: string[];
}

// ---------------------------------------------------------------------------
// Validation and MIME construction
// ---------------------------------------------------------------------------

/**
 * Strips CR/LF from a header value.
 *
 * This is header injection defence, not tidiness. A newline inside a subject
 * or a recipient lets the caller append arbitrary headers — `Bcc:` most
 * obviously — and send the mail somewhere the approved plan never showed. So
 * it is removed from every header value without exception.
 */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * A deliberately conservative address check.
 *
 * Not RFC 5322 — that grammar admits constructs no user types and no provider
 * needs here. The purpose is to reject anything that could carry a header
 * break or a second address, and to fail loudly rather than silently mail the
 * wrong person.
 */
const ADDRESS = /^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+\.[^\s@<>,;:"\\]{2,}$/;

export interface ValidationFailure {
  ok: false;
  field: string;
  message: string;
}

export function validateDraft(input: DraftInput): ValidationFailure | { ok: true } {
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];

  if (input.to.length === 0) {
    return { ok: false, field: "to", message: "At least one recipient is required." };
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return {
      ok: false,
      field: "to",
      message: `At most ${MAX_RECIPIENTS} recipients are allowed in one message.`,
    };
  }

  for (const address of recipients) {
    if (!ADDRESS.test(address.trim())) {
      // The address IS echoed here: the user needs to see which one was
      // rejected, and an email address they themselves typed is not a secret.
      return {
        ok: false,
        field: "to",
        message: `"${address.slice(0, 80)}" is not a valid email address.`,
      };
    }
  }

  if (input.subject.length > MAX_SUBJECT_CHARS) {
    return { ok: false, field: "subject", message: "The subject is too long." };
  }
  if (input.body.length > MAX_BODY_CHARS) {
    return { ok: false, field: "body", message: "The message body is too long." };
  }

  return { ok: true };
}

/**
 * Builds an RFC 2822 message, base64url encoded as Gmail requires.
 *
 * Plain text only. This phase does not send HTML mail: an HTML body would need
 * escaping decisions on content a model may have written, and a text/plain
 * message cannot carry a payload that renders as anything but text.
 */
export function buildMimeMessage(input: DraftInput): string {
  const headers: string[] = [
    `To: ${input.to.map(sanitizeHeader).join(", ")}`,
    ...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.map(sanitizeHeader).join(", ")}`] : []),
    ...(input.bcc && input.bcc.length > 0
      ? [`Bcc: ${input.bcc.map(sanitizeHeader).join(", ")}`]
      : []),
    `Subject: ${sanitizeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];

  // The body is NOT header-sanitized: newlines in prose are correct. It sits
  // after the blank line, where it cannot be read as a header.
  const raw = `${headers.join("\r\n")}\r\n\r\n${input.body}`;
  return Buffer.from(raw, "utf-8").toString("base64url");
}

// ---------------------------------------------------------------------------

export interface GmailWriteDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GmailWriteService {
  constructor(private readonly deps: GmailWriteDeps = {}) {}

  private call<T>(
    url: string,
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    accessToken: string,
    body?: unknown,
    signal?: AbortSignal
  ) {
    return callGoogleWrite<T>({
      url,
      method,
      accessToken,
      ...(body !== undefined ? { body } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Creates a draft in the user's own mailbox.
   *
   * Nothing is sent. This is the step whose content the user reviews, and the
   * draft id it returns is the only thing `sendDraft` will accept.
   */
  async createDraft(
    accessToken: string,
    input: DraftInput,
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<GmailDraftResult>> {
    const valid = validateDraft(input);
    if (!valid.ok) {
      return { ok: false, status: "provider_error", message: valid.message };
    }

    const outcome = await this.call<{
      id?: string;
      message?: { id?: string; threadId?: string };
    }>(
      `${GMAIL_API}/drafts`,
      "POST",
      accessToken,
      { message: { raw: buildMimeMessage(input) } },
      signal
    );

    if (!outcome.ok) return outcome;
    return {
      ok: true,
      body: {
        draftId: outcome.body.id ?? "",
        messageId: outcome.body.message?.id ?? null,
        threadId: outcome.body.message?.threadId ?? null,
      },
    };
  }

  /**
   * Replaces a draft's content.
   *
   * Gmail's update is a full replacement, not a patch, so the caller supplies
   * the complete message. That is also the honest shape for an approval: the
   * plan shows exactly what the draft will contain afterwards, not a delta the
   * user has to apply in their head.
   */
  async updateDraft(
    accessToken: string,
    draftId: string,
    input: DraftInput,
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<GmailDraftResult>> {
    if (!draftId.trim()) {
      return { ok: false, status: "provider_error", message: "A draft id is required." };
    }

    const valid = validateDraft(input);
    if (!valid.ok) {
      return { ok: false, status: "provider_error", message: valid.message };
    }

    const outcome = await this.call<{
      id?: string;
      message?: { id?: string; threadId?: string };
    }>(
      `${GMAIL_API}/drafts/${encodeURIComponent(draftId)}`,
      "PUT",
      accessToken,
      { message: { raw: buildMimeMessage(input) } },
      signal
    );

    if (!outcome.ok) return outcome;
    return {
      ok: true,
      body: {
        draftId: outcome.body.id ?? draftId,
        messageId: outcome.body.message?.id ?? null,
        threadId: outcome.body.message?.threadId ?? null,
      },
    };
  }

  /**
   * Sends an existing draft. IRREVERSIBLE.
   *
   * Takes a draft id and NOTHING ELSE. There is no recipient parameter, no
   * subject and no body, so this call cannot send content other than the draft
   * the user reviewed — which is the property that makes a send approval
   * meaningful rather than a rubber stamp on a payload that could change.
   */
  async sendDraft(
    accessToken: string,
    draftId: string,
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<GmailSendResult>> {
    if (!draftId.trim()) {
      return { ok: false, status: "provider_error", message: "A draft id is required." };
    }

    const outcome = await this.call<{ id?: string; threadId?: string; labelIds?: string[] }>(
      `${GMAIL_API}/drafts/send`,
      "POST",
      accessToken,
      { id: draftId },
      signal
    );

    if (!outcome.ok) return outcome;
    return {
      ok: true,
      body: {
        messageId: outcome.body.id ?? "",
        threadId: outcome.body.threadId ?? null,
        labelIds: outcome.body.labelIds ?? [],
      },
    };
  }
}
