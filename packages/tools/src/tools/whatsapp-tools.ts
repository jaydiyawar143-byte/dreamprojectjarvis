import { BaseTool } from "../base-tool.js";
import type {
  ToolResult,
  ToolContext,
  WhatsAppSendResult,
  IWhatsAppRepository,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// WhatsApp outbound tool (Sprint 5.3)
// ---------------------------------------------------------------------------
// Sending a WhatsApp message is an IRREVERSIBLE external side effect: once it
// reaches a recipient there is no unsend. It is therefore declared
// EXTERNAL_SIDE_EFFECT with requiresApproval, which the existing
// RISK_REQUIRES_APPROVAL table in ToolApprovalService already gates — the same
// mechanism that gates the Meta write tools, with no WhatsApp-specific
// exemption and no new approval path.
//
// This mirrors the Meta write tools deliberately: risk classification is what
// enforces the boundary, so a future WhatsApp template/media tool inherits the
// gate simply by declaring the same risk level.
// ---------------------------------------------------------------------------

export interface WhatsAppSendOptions {
  signal?: AbortSignal;
}

/** Transport contract. The concrete implementation lives in @jarvis/whatsapp. */
export interface WhatsAppSendProvider {
  sendText(to: string, body: string, options?: WhatsAppSendOptions): Promise<WhatsAppSendResult>;
}

/** Decides which recipients a user may message. */
export interface WhatsAppRecipientAuthorizer {
  /**
   * True when this user owns a WhatsApp business number and may message this
   * recipient. Never trust a client-supplied recipient without this check.
   */
  isAuthorized(userId: string, waId: string): Promise<boolean>;
}

const MAX_BODY_LENGTH = 4096;

/** Digits only, no "+", 8-15 digits. Returns null when unusable. */
export function validateWaId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.trim().replace(/^\+/, "").replace(/[\s\-().]/g, "");
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

export function validateMessageBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BODY_LENGTH) return null;
  return trimmed;
}

/**
 * Authorizer backed by the account claim table: a user may message a recipient
 * only if they own at least one active WhatsApp business number.
 */
export class RepositoryRecipientAuthorizer implements WhatsAppRecipientAuthorizer {
  constructor(
    private repo: IWhatsAppRepository,
    private phoneNumberId: string
  ) {}

  async isAuthorized(userId: string, _waId: string): Promise<boolean> {
    const owner = await this.repo.findUserForPhoneNumber(this.phoneNumberId);
    return owner !== null && owner === userId;
  }
}

// ---------------------------------------------------------------------------
// whatsapp.send
// ---------------------------------------------------------------------------

export class WhatsAppSendMessageTool extends BaseTool {
  private readonly provider: WhatsAppSendProvider;
  private readonly authorizer: WhatsAppRecipientAuthorizer;
  private readonly repo?: IWhatsAppRepository;
  private readonly phoneNumberId: string;

  constructor(
    provider: WhatsAppSendProvider,
    authorizer: WhatsAppRecipientAuthorizer,
    phoneNumberId: string,
    repo?: IWhatsAppRepository
  ) {
    super(
      "whatsapp.send",
      "Send WhatsApp Message",
      "Send a WhatsApp text message to a recipient. Requires human approval. This action is NOT reversible.",
      "communication",
      [
        {
          name: "to",
          type: "string",
          description: "Recipient phone number in E.164 digits (no + or separators)",
          required: true,
        },
        {
          name: "body",
          type: "string",
          description: "Message text, 1-4096 characters",
          required: true,
        },
      ],
      // requiresApproval + EXTERNAL_SIDE_EFFECT: the existing approval service
      // refuses to execute this without a human decision.
      true,
      ["read", "write"],
      "EXTERNAL_SIDE_EFFECT",
      "1.0.0",
      true
    );
    this.provider = provider;
    this.authorizer = authorizer;
    this.repo = repo;
    this.phoneNumberId = phoneNumberId;
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const to = validateWaId(params.to);
    if (!to) return this.failure("Invalid WhatsApp recipient number");

    const body = validateMessageBody(params.body);
    if (!body) {
      return this.failure("Message body must be between 1 and 4096 characters");
    }

    // Server-side authorization. A caller cannot send from a number they do not
    // own, regardless of what the parameters claim.
    const authorized = await this.authorizer.isAuthorized(context.userId, to);
    if (!authorized) {
      return this.failure("Not authorized to send WhatsApp messages from this account");
    }

    let result: WhatsAppSendResult;
    try {
      result = await this.provider.sendText(to, body, { signal: context.signal });
    } catch (err) {
      // Provider errors are already classified and redacted upstream.
      return this.failure(err instanceof Error ? err.message : "WhatsApp send failed");
    }

    // Recording is best effort: the message HAS been delivered by this point, so
    // a logging failure must not be reported as a send failure — that would
    // invite a duplicate send on retry.
    if (this.repo) {
      try {
        await this.repo.recordOutbound({
          userId: context.userId,
          providerMessageId: result.providerMessageId,
          waId: to,
          phoneNumberId: this.phoneNumberId,
          body,
        });
      } catch {
        // Intentionally swallowed; see above.
      }
    }

    return this.success(
      {
        action: "whatsapp_send",
        to,
        providerMessageId: result.providerMessageId,
        length: body.length,
      },
      { toolId: this.id, risk: this.risk, userId: context.userId }
    );
  }
}
