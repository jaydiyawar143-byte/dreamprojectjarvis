// ---------------------------------------------------------------------------
// Phase 18, Stage 18.3B — one workflow's webhook trigger target, and nothing
// else.
//
// Putting a library workflow on JARVIS's trigger allow-list (`N8nWorkflow`)
// needs the one thing that table stores: the webhook path n8n serves the
// workflow at. That path is a value of the Webhook node's parameters, so it is
// read — and it is the ONLY parameter value read, together with two enums
// that decide whether JARVIS's trigger could reach it (the HTTP method, and
// whether the webhook demands authentication JARVIS does not send).
//
// THE BOUNDARY IS THIS FUNCTION. n8n answers `GET /api/v1/workflows/{id}` with
// the whole workflow — every node's parameters, credential references,
// settings, static and pinned data. None of it leaves here: the result is
// built from an explicit list of three fields per enabled webhook node, each
// validated, plus the workflow's versionId. A path that is an expression, or
// could leave the configured host, is not a path (`validateWebhookPath`, the
// trigger's own SSRF control). The result is used by the server to write one
// allow-list row and is never returned to a client, logged or audited.
// ---------------------------------------------------------------------------

import { validateWebhookPath } from "./config.js";

export interface N8nWorkflowTriggerTarget {
  /** n8n's versionId for the definition just read, when valid. */
  versionId: string | null;
  /** Every ENABLED webhook node, reduced to these three validated values. */
  webhooks: Array<{
    /** The path segment, or null when absent, an expression, or unsafe. */
    path: string | null;
    /** Upper-case HTTP method, or null when absent or not a method. */
    method: string | null;
    /** n8n's authentication mode, or null when not a known one. Absent means n8n's default, "none". */
    authentication: string | null;
  }>;
}

export const WEBHOOK_NODE_TYPE = "n8n-nodes-base.webhook";
const VERSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const AUTHENTICATION = new Set(["none", "basicAuth", "headerAuth", "jwtAuth"]);
const MAX_WEBHOOKS = 10;

/**
 * The trigger target of one workflow definition, or null when the body is not
 * a workflow. Reads `versionId` and, for each enabled webhook node,
 * `parameters.path`, `parameters.httpMethod` and `parameters.authentication`.
 * Nothing else is read into the result.
 */
export function extractWorkflowTriggerTarget(body: unknown): N8nWorkflowTriggerTarget | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const workflow = body as Record<string, unknown>;
  if (!Array.isArray(workflow.nodes)) return null;

  const versionId = typeof workflow.versionId === "string" && VERSION_ID.test(workflow.versionId) ? workflow.versionId : null;
  const webhooks: N8nWorkflowTriggerTarget["webhooks"] = [];
  for (const node of workflow.nodes) {
    if (webhooks.length >= MAX_WEBHOOKS) break;
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const n = node as Record<string, unknown>;
    if (n.type !== WEBHOOK_NODE_TYPE || n.disabled === true) continue;
    const parameters = n.parameters && typeof n.parameters === "object" && !Array.isArray(n.parameters) ? (n.parameters as Record<string, unknown>) : {};
    const rawMethod = typeof parameters.httpMethod === "string" ? parameters.httpMethod.toUpperCase() : null;
    const rawAuth = parameters.authentication;
    webhooks.push({
      path: validateWebhookPath(parameters.path),
      method: rawMethod && METHODS.has(rawMethod) ? rawMethod : null,
      authentication: rawAuth === undefined ? "none" : typeof rawAuth === "string" && AUTHENTICATION.has(rawAuth) ? rawAuth : null,
    });
  }
  return { versionId, webhooks };
}
