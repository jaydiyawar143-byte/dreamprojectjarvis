import { ToolResultSchema, type ToolResult } from "@jarvis/core";

const MAX_RESULT_SIZE_BYTES = 100_000;
const MAX_STRING_LENGTH = 50_000;
const TRUNCATION_SUFFIX = "\n[...truncated]";

const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /api[_-]?key[:\s]*[^\s,;]+/gi,
  /bearer\s+[^\s,;]+/gi,
  /password[:\s]*[^\s,;]+/gi,
  /token[:\s]*[^\s,;]+/gi,
  /secret[:\s]*[^\s,;]+/gi,
];

export interface SanitizeOptions {
  maxResultSizeBytes?: number;
  maxStringLength?: number;
  redactSecrets?: boolean;
}

export interface SanitizedToolResult {
  result: ToolResult;
  truncated: boolean;
  redacted: boolean;
  originalSizeBytes: number;
  sanitizedSizeBytes: number;
}

export function sanitizeToolResult(
  result: ToolResult,
  options: SanitizeOptions = {}
): SanitizedToolResult {
  const maxBytes = options.maxResultSizeBytes ?? MAX_RESULT_SIZE_BYTES;
  const maxStrLen = options.maxStringLength ?? MAX_STRING_LENGTH;
  const redactSecrets = options.redactSecrets ?? true;

  const originalJson = JSON.stringify(result);
  const originalSize = Buffer.byteLength(originalJson, "utf-8");

  let sanitized = redactSecrets ? redactSecretsFromResult(result) : result;
  let truncated = false;
  let redacted = redactSecrets && JSON.stringify(sanitized) !== originalJson;

  sanitized = truncateResult(sanitized, maxStrLen, maxBytes, (trunc: boolean) => {
    truncated = trunc;
  });

  const sanitizedJson = JSON.stringify(sanitized);
  const sanitizedSize = Buffer.byteLength(sanitizedJson, "utf-8");

  if (sanitizedSize > maxBytes) {
    const errorResult: ToolResult = {
      success: false,
      error: "Result too large to return safely",
      metadata: { originalSizeBytes: originalSize, maxAllowedBytes: maxBytes },
    };
    return {
      result: errorResult,
      truncated: true,
      redacted,
      originalSizeBytes: originalSize,
      sanitizedSizeBytes: Buffer.byteLength(JSON.stringify(errorResult), "utf-8"),
    };
  }

  return {
    result: sanitized,
    truncated,
    redacted,
    originalSizeBytes: originalSize,
    sanitizedSizeBytes: sanitizedSize,
  };
}

export function wrapToolResult(result: ToolResult): string {
  const payload = JSON.stringify(result);
  return `<tool_result>\n${payload}\n</tool_result>`;
}

export function validateToolResultSchema(result: unknown): ToolResult {
  return ToolResultSchema.parse(result);
}

function redactString(value: string): { value: string; changed: boolean } {
  let changed = false;
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    const cloned = new RegExp(pattern.source, pattern.flags);
    const before = result;
    result = result.replace(cloned, "[REDACTED]");
    if (result !== before) changed = true;
  }
  return { value: result, changed };
}

function redactValue(val: unknown): { value: unknown; changed: boolean } {
  if (typeof val === "string") {
    const { value, changed } = redactString(val);
    return { value, changed };
  }
  if (Array.isArray(val)) {
    let changed = false;
    const result = val.map((item) => {
      const { value, changed: itemChanged } = redactValue(item);
      if (itemChanged) changed = true;
      return value;
    });
    return { value: result, changed };
  }
  if (val !== null && typeof val === "object") {
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const { value, changed: itemChanged } = redactValue(v);
      if (itemChanged) changed = true;
      result[k] = value;
    }
    return { value: result, changed };
  }
  return { value: val, changed: false };
}

function redactSecretsFromResult(result: ToolResult): ToolResult {
  const { value, changed } = redactValue(result);
  if (!changed) return result;
  return value as ToolResult;
}

function truncateResult(
  result: ToolResult,
  maxStrLen: number,
  _maxBytes: number,
  onTruncated: (truncated: boolean) => void
): ToolResult {
  let truncated = false;

  const truncateString = (s: string): string => {
    if (s.length > maxStrLen) {
      truncated = true;
      return s.slice(0, maxStrLen) + TRUNCATION_SUFFIX;
    }
    return s;
  };

  const processValue = (val: unknown): unknown => {
    if (typeof val === "string") return truncateString(val);
    if (Array.isArray(val)) return val.map(processValue);
    if (val !== null && typeof val === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = processValue(v);
      }
      return out;
    }
    return val;
  };

  const truncatedResult: ToolResult = {
    ...result,
    data: result.data !== undefined ? processValue(result.data) : undefined,
    error: result.error !== undefined ? truncateString(result.error) : undefined,
  };

  onTruncated(truncated);
  return truncatedResult;
}

export function sanitizeOutputForModel(result: ToolResult): string {
  const sanitized = sanitizeToolResult(result);
  return wrapToolResult(sanitized.result);
}
