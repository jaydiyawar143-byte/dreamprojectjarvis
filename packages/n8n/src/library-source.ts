// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — the n8n side of an Automation Library sync.
//
// One page of the instance's workflow list, as the library's page source
// (`LibraryPageSource` in @jarvis/core). It is the existing cursor listing —
// `listWorkflows` on the read-only API surface, n8n's own cursor contract, the
// key in a header and the URL built from server config — and nothing else: no
// traversal (the sync engine bounds and checkpoints that), no write, no retry.
//
// THE PROVIDER'S WORDS STOP HERE. A failure crosses as its classification —
// code and HTTP status — and never as its message, which can echo request
// detail. The library names the failure itself, in fixed sentences.
// ---------------------------------------------------------------------------

import type { LibraryPageSource, LibraryTriggerTargetSource } from "@jarvis/core";
import type { N8nApiProvider } from "./provider.js";

export function createN8nLibraryPageSource(api: Pick<N8nApiProvider, "listWorkflows">): LibraryPageSource {
  return {
    async fetchPage({ cursor, limit }) {
      const result = await api.listWorkflows({ limit, ...(cursor ? { cursor } : {}) });
      if (!result.ok) {
        return {
          ok: false,
          error: {
            code: result.error.code,
            ...(result.error.httpStatus !== undefined ? { httpStatus: result.error.httpStatus } : {}),
          },
        };
      }
      return { ok: true, workflows: result.data.workflows, nextCursor: result.data.nextCursor };
    },
  };
}

/**
 * Stage 18.3B — the live read an approved allow-list change makes: one
 * workflow's webhook trigger target (`getWorkflowTriggerTarget`), with the
 * same error discipline as the page source — a code and a status, never n8n's
 * words. Used by the server only; what it returns is never sent to a client.
 */
export function createN8nLibraryTriggerTargetSource(
  api: Pick<N8nApiProvider, "getWorkflowTriggerTarget">
): LibraryTriggerTargetSource {
  return {
    async fetchTriggerTarget(entryId) {
      const result = await api.getWorkflowTriggerTarget(entryId);
      if (!result.ok) {
        return {
          ok: false,
          error: {
            code: result.error.code,
            ...(result.error.httpStatus !== undefined ? { httpStatus: result.error.httpStatus } : {}),
          },
        };
      }
      return { ok: true, target: { versionId: result.data.versionId, webhooks: result.data.webhooks.map((w) => ({ ...w })) } };
    },
  };
}
