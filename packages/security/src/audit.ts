import type { AuditEntry, AuditQueryFilters, IAuditRepository } from "@jarvis/core";
import { computerControlValueFreeParams, redactSecrets } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Sprint 9.8 — redaction happens BEFORE persistence, not after.
//
// Previously `repository.create(entry)` ran on the raw entry and only the
// console projection was redacted, so a token that reached these parameters was
// written verbatim into the AuditLog table and stayed there. The audit trail is
// long-lived, widely readable and exported; it is the last place a credential
// should come to rest.
//
// Two passes, because they catch different things:
//
//   BY KEY    — a field literally called `password` or `access_token`, at any
//               depth. Nested objects are walked; the old version only looked
//               at the top level.
//   BY SHAPE  — `redactSecrets` from @jarvis/core, which matches the VALUE:
//               `sk-...`, Meta's `EAA...`, bearer headers, JWTs. This is what
//               catches a token that arrived under an innocent key name.
// ---------------------------------------------------------------------------

const SENSITIVE_PARAM_KEYS = new Set([
  "access_token",
  "accessToken",
  "token",
  "refresh_token",
  "refreshToken",
  "id_token",
  "idToken",
  "secret",
  "clientSecret",
  "client_secret",
  "password",
  "passwordHash",
  "apiKey",
  "api_key",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  "sessionToken",
  // Phase 13 — the write-confirmation token: no recognisable shape, so by name.
  "confirmationToken",
  "codeVerifier",
  "code_verifier",
  "privateKey",
  "private_key",
]);

const REDACTED = "[REDACTED]";

/** Depth cap, so a self-referential or pathological structure cannot spin. */
const MAX_DEPTH = 6;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (typeof value === "string") {
    // Value-shaped secrets, e.g. a bearer token stored under `note`.
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    return redactRecord(value as Record<string, unknown>, depth + 1);
  }
  return value;
}

function redactRecord(
  input: Record<string, unknown>,
  depth = 0
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_PARAM_KEYS.has(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactValue(value, depth);
  }
  return out;
}

/**
 * Phase 19.1 — the tool-aware pass for browser and desktop actions.
 *
 * The generic passes above know a credential's NAME and SHAPE, but a browser
 * request carries free text under ordinary names (`text`, or a `fields` map's
 * values) and no token pattern. Key/shape redaction therefore used to write
 * what a person typed, and every submitted field value, into the audit trail.
 *
 * For an action in the Phase 19 contract the audit row keeps an ALLOWLISTED
 * projection instead: the action, its fixed summary sentence, the normalized
 * origin and sanitized field names/counts. The request is parsed first; an
 * invalid one is recorded as refused with only its code, never its payload.
 * The projection is then passed through the generic redaction as a final net.
 *
 * Phase 19.5 — the projection is core's `computerControlValueFreeParams`, the
 * same one an approval record keeps, so the two cannot drift apart.
 */
function auditParametersForTool(
  toolId: string | undefined,
  params: Record<string, unknown>
): Record<string, unknown> {
  const projection = toolId ? computerControlValueFreeParams(toolId, params) : null;
  if (!projection) return redactRecord(params);
  return "refused" in projection ? projection : redactRecord(projection);
}

/**
 * Exported for the security tests; the redaction rule should be assertable.
 *
 * Phase 19.1 — every audit writer goes through this, the `AuditLogger` and the
 * `ToolApprovalService` alike. It fails CLOSED: if the projection itself
 * throws, the row records that the parameters were withheld, never the
 * parameters.
 */
export function redactAuditParams(
  params: Record<string, unknown>,
  toolId?: string
): Record<string, unknown> {
  try {
    return auditParametersForTool(toolId, params);
  } catch {
    return {
      ...(toolId ? { action: toolId } : {}),
      redacted: true,
      reason: "REDACTION_FAILED",
    };
  }
}

export class AuditLogger {
  constructor(private repository: IAuditRepository) {}

  async log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void> {
    // Redact FIRST. Everything downstream — the durable row and the console
    // line — is derived from the safe copy.
    const safeEntry: Omit<AuditEntry, "id" | "timestamp"> = {
      ...entry,
      ...(entry.parameters
        ? {
            parameters: redactAuditParams(
              entry.parameters as Record<string, unknown>,
              entry.toolId
            ),
          }
        : {}),
      ...(entry.metadata
        ? { metadata: redactAuditParams(entry.metadata as Record<string, unknown>) }
        : {}),
    };

    const fullEntry = await this.repository.create(safeEntry);

    const structured: Record<string, unknown> = {
      level: "info",
      event: fullEntry.action,
      result: fullEntry.result,
      id: fullEntry.id,
      userId: fullEntry.userId,
      traceId: fullEntry.traceId,
    };

    if (fullEntry.toolId) {
      structured.toolId = fullEntry.toolId;
    }
    if (fullEntry.parameters) {
      structured.parameters = fullEntry.parameters;
    }
    if (fullEntry.metadata) {
      const meta = fullEntry.metadata as Record<string, unknown>;
      if (meta.executionId) structured.executionId = meta.executionId;
      if (meta.durationMs) structured.durationMs = meta.durationMs;
      if (meta.error) structured.error = meta.error;
    }

    console.log(JSON.stringify(structured));
  }

  async query(filters: AuditQueryFilters): Promise<AuditEntry[]> {
    return this.repository.query(filters);
  }
}
