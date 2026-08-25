import type { AuditEntry, AuditQueryFilters, IAuditRepository } from "@jarvis/core";

const SENSITIVE_PARAM_KEYS = new Set([
  "access_token", "accessToken", "token", "secret", "password", "apiKey", "api_key",
]);

function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (SENSITIVE_PARAM_KEYS.has(key)) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "string" && /^act_\d+/.test(value)) {
      redacted[key] = value;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export class AuditLogger {
  constructor(private repository: IAuditRepository) {}

  async log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void> {
    const fullEntry = await this.repository.create(entry);

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
      structured.parameters = redactParams(fullEntry.parameters as Record<string, unknown>);
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
