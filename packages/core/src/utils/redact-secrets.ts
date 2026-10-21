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

/**
 * Phase 18.4 — detection only, for text a person or a model asks JARVIS to
 * STORE (a workflow draft): such text is refused, never stored redacted.
 * The redaction patterns above, plus credential shapes that have no place in
 * a sentence. `redactSecrets` itself is unchanged.
 */
const DETECT_ONLY_PATTERNS: readonly RegExp[] = [
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Fa-f0-9]{40,}\b/, // long hex secrets
  /\b(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{32,}={0,2}/, // long mixed tokens
];

/** Whether the text carries something shaped like a secret. */
export function containsSecret(text: string): boolean {
  if (SECRET_PATTERNS.some(([pattern]) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text))) return true;
  return DETECT_ONLY_PATTERNS.some((pattern) => pattern.test(text));
}

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
