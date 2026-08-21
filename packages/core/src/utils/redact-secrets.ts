// ---------------------------------------------------------------------------
// Secret redaction for persisted error/diagnostic text
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-(?:proj|ant|org)?[a-zA-Z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bEAA[a-zA-Z0-9_-]{10,}/g, "[REDACTED]"],
  [/Bearer\s+[a-zA-Z0-9._-]{20,}/gi, "Bearer [REDACTED]"],
  [/\beyJ[a-zA-Z0-9._-]{20,}/g, "[REDACTED_JWT]"],
  [/(?:password|passwd|pwd)\s*[:=]\s*\S+/gi, "password=[REDACTED]"],
  [/(?:api[_-]?key|apikey)\s*[:=]\s*\S+/gi, "api_key=[REDACTED]"],
  [/(?:access[_-]?token|jwt|token)\s*[:=]\s*\S+/gi, "token=[REDACTED]"],
];

const MAX_PERSISTED_LENGTH = 1000;

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  if (redacted.length > MAX_PERSISTED_LENGTH) {
    redacted = `${redacted.slice(0, MAX_PERSISTED_LENGTH)}…[truncated]`;
  }
  return redacted;
}
