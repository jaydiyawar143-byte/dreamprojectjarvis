import type { WhatsAppSendResult } from "@jarvis/core";
import {
  createWhatsAppHttpClient,
  isSuccessResponse,
  extractError,
  type WhatsAppHttpClient,
} from "./client.js";
import {
  normalizePhoneNumber,
  WHATSAPP_MAX_TEXT_LENGTH,
  type WhatsAppConfig,
} from "./config.js";
import { toJarvisError } from "./error-handler.js";

// ---------------------------------------------------------------------------
// WhatsAppCloudProvider (Sprint 5.3)
// ---------------------------------------------------------------------------
// The ONLY boundary to the WhatsApp Cloud API, following the contract stated in
// packages/tools/src/tools/meta-ads-provider.ts: implementations must NEVER
// expose credentials to their callers.
//
// Outbound surface is intentionally small — one text send. Templates and media
// are out of scope for 5.3; adding them must not widen the credential surface,
// only add methods here.
//
// Nothing in this class decides WHETHER a send is allowed. Authorization and
// human approval happen in the tool layer above, so this provider stays a
// transport and cannot be used to bypass the approval boundary.
// ---------------------------------------------------------------------------

export interface WhatsAppProviderCallOptions {
  signal?: AbortSignal;
}

export interface WhatsAppSendProvider {
  sendText(
    to: string,
    body: string,
    options?: WhatsAppProviderCallOptions
  ): Promise<WhatsAppSendResult>;
}

export interface WhatsAppCloudProviderConfig {
  config: WhatsAppConfig;
  httpClient?: WhatsAppHttpClient;
}

export class WhatsAppCloudProvider implements WhatsAppSendProvider {
  private readonly config: WhatsAppConfig;
  private readonly http: WhatsAppHttpClient;

  constructor(opts: WhatsAppCloudProviderConfig) {
    this.config = opts.config;
    this.http = opts.httpClient ?? createWhatsAppHttpClient(opts.config);
  }

  async sendText(
    to: string,
    body: string,
    options?: WhatsAppProviderCallOptions
  ): Promise<WhatsAppSendResult> {
    const recipient = normalizePhoneNumber(to);
    if (!recipient) {
      throw toJarvisError({
        code: "INVALID_REQUEST",
        retryable: false,
        message: "Invalid WhatsApp recipient number",
      });
    }
    if (typeof body !== "string" || body.trim().length === 0) {
      throw toJarvisError({
        code: "INVALID_REQUEST",
        retryable: false,
        message: "WhatsApp message body cannot be empty",
      });
    }
    if (body.length > WHATSAPP_MAX_TEXT_LENGTH) {
      throw toJarvisError({
        code: "INVALID_REQUEST",
        retryable: false,
        message: `WhatsApp message body exceeds ${WHATSAPP_MAX_TEXT_LENGTH} characters`,
      });
    }

    const response = await this.http.request({
      method: "POST",
      path: `${this.config.phoneNumberId}/messages`,
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        // preview_url stays false: link previews make the Cloud API fetch
        // arbitrary URLs from message text, which is an SSRF-shaped surface.
        text: { preview_url: false, body },
      },
      signal: options?.signal,
    });

    if (!isSuccessResponse(response)) {
      throw toJarvisError(extractError(response));
    }

    const payload = response.body as { messages?: { id?: string }[] };
    const providerMessageId = payload?.messages?.[0]?.id;
    if (typeof providerMessageId !== "string" || providerMessageId.length === 0) {
      // A 200 with no message id means we cannot record or deduplicate the
      // send. Surfacing it is safer than inventing an id.
      throw toJarvisError({
        code: "INTERNAL_ERROR",
        retryable: false,
        message: "WhatsApp API accepted the message but returned no message id",
      });
    }

    return { providerMessageId, to: recipient };
  }
}

export function createWhatsAppProvider(
  opts: WhatsAppCloudProviderConfig
): WhatsAppCloudProvider {
  return new WhatsAppCloudProvider(opts);
}
