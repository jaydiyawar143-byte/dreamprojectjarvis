import type { WhatsAppSendResult } from "@jarvis/core";
import type { WhatsAppSendProvider, WhatsAppSendOptions } from "./whatsapp-tools.js";

// ---------------------------------------------------------------------------
// MockWhatsAppProvider (Sprint 5.3)
// ---------------------------------------------------------------------------
// Mirrors meta-ads-mock.ts and google-ads-mock.ts: tests never need a real
// phone number id, access token, app secret, or network. `throwOnSend`
// reproduces provider failures (auth, rate limit, permanent send rejection)
// and `delayMs` exercises timeout/cancellation.
// ---------------------------------------------------------------------------

export interface MockWhatsAppProviderConfig {
  /** Error to throw instead of sending. */
  throwOnSend?: Error;
  delayMs?: number;
  /** Overrides the generated provider message id. */
  messageId?: string;
}

export class MockWhatsAppProvider implements WhatsAppSendProvider {
  readonly sent: { to: string; body: string }[] = [];
  private counter = 0;

  constructor(private config: MockWhatsAppProviderConfig = {}) {}

  async sendText(
    to: string,
    body: string,
    options?: WhatsAppSendOptions
  ): Promise<WhatsAppSendResult> {
    if (this.config.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.config.delayMs);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        });
      });
    }
    if (options?.signal?.aborted) throw new Error("Aborted");
    if (this.config.throwOnSend) throw this.config.throwOnSend;

    this.sent.push({ to, body });
    return {
      providerMessageId: this.config.messageId ?? `wamid.MOCK${++this.counter}`,
      to,
    };
  }
}
