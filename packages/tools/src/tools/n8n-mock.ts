import { createHash } from "node:crypto";
import type { N8nTriggerResult } from "@jarvis/core";
import type { N8nTriggerProvider, N8nTriggerOptions, N8nKeyDeriver } from "./n8n-tools.js";

// ---------------------------------------------------------------------------
// MockN8nProvider (Sprint 5.4)
// ---------------------------------------------------------------------------
// Mirrors meta-ads-mock.ts, google-ads-mock.ts and whatsapp-mock.ts: tests need
// no live n8n instance, no base URL, no API key, and no network.
//
// throwOnTrigger reproduces provider failures. The thrown error may carry a
// `classified` field so tests can exercise the sideEffectPossible branch, which
// is the difference between "safe to report failed" and "may have run".
// ---------------------------------------------------------------------------

export interface MockN8nProviderConfig {
  throwOnTrigger?: Error;
  delayMs?: number;
  remoteExecutionId?: string | null;
  responseSummary?: string | null;
}

export class MockN8nProvider implements N8nTriggerProvider {
  readonly triggered: {
    webhookPath: string;
    payload: Record<string, unknown>;
    correlation: { executionId: string; traceId: string };
  }[] = [];

  constructor(private config: MockN8nProviderConfig = {}) {}

  async triggerWorkflow(
    webhookPath: string,
    payload: Record<string, unknown>,
    correlation: { executionId: string; traceId: string },
    options?: N8nTriggerOptions
  ): Promise<N8nTriggerResult> {
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
    if (this.config.throwOnTrigger) throw this.config.throwOnTrigger;

    this.triggered.push({ webhookPath, payload, correlation });
    return {
      remoteExecutionId: this.config.remoteExecutionId ?? "n8n-exec-1",
      responseSummary: this.config.responseSummary ?? null,
    };
  }
}

/**
 * Real hashing, so idempotency behaviour under test matches production. Only
 * the transport is faked.
 */
export const mockKeyDeriver: N8nKeyDeriver = {
  hashPayload(payload: unknown): string {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
    return createHash("sha256").update(text, "utf8").digest("hex");
  },
  buildIdempotencyKey(userId: string, workflowId: string, payloadHash: string): string {
    return `n8n:${userId}:${workflowId}:${payloadHash}`;
  },
};
