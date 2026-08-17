import { JarvisError } from "@jarvis/core";

const RETRYABLE_ERROR_TYPES = new Set([
  "rate_limit",
  "timeout",
  "connection",
  "server",
]);

const BASE_DELAY_MS = 1000;
const MAX_JITTER_MS = 1000;

export function classifyOpenAIError(error: unknown): {
  code: "AUTHENTICATION_REQUIRED" | "AUTHORIZATION_FAILED" | "INVALID_REQUEST" | "RATE_LIMITED" | "INTERNAL_ERROR";
  retryable: boolean;
  message: string;
} {
  const err = error as {
    status?: number;
    code?: string;
    type?: string;
    message?: string;
    error?: { type?: string; message?: string };
  };

  const status = err.status ?? 0;
  const openaiType = err.error?.type ?? err.type ?? "";
  const rawMessage = err.error?.message ?? err.message ?? "Unknown AI provider error";

  const safeMessage = sanitizeErrorMessage(rawMessage);

  if (status === 401 || openaiType === "authentication_error") {
    return { code: "AUTHENTICATION_REQUIRED", retryable: false, message: safeMessage };
  }

  if (status === 403 || openaiType === "permission_error") {
    return { code: "AUTHORIZATION_FAILED", retryable: false, message: safeMessage };
  }

  if (status === 400 || openaiType === "invalid_request_error") {
    return { code: "INVALID_REQUEST", retryable: false, message: safeMessage };
  }

  if (status === 429 || openaiType === "rate_limit") {
    return { code: "RATE_LIMITED", retryable: true, message: safeMessage };
  }

  if (
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    openaiType === "timeout" ||
    openaiType === "server_error" ||
    openaiType === "api_connection_error"
  ) {
    return { code: "INTERNAL_ERROR", retryable: true, message: safeMessage };
  }

  if (RETRYABLE_ERROR_TYPES.has(openaiType)) {
    return { code: "INTERNAL_ERROR", retryable: true, message: safeMessage };
  }

  return { code: "INTERNAL_ERROR", retryable: false, message: safeMessage };
}

export function calculateRetryDelay(attempt: number): number {
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * MAX_JITTER_MS;
  return exponentialDelay + jitter;
}

export function toJarvisError(error: unknown): JarvisError {
  const classified = classifyOpenAIError(error);
  return new JarvisError(classified.code, classified.message);
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]+/g, "[REDACTED]")
    .replace(/api[_-]?key[:\s]*[^\s,]+/gi, "api_key: [REDACTED]")
    .replace(/bearer\s+[^\s,]+/gi, "Bearer [REDACTED]");
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  signal?: AbortSignal | null
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new JarvisError("INTERNAL_ERROR", "Request was aborted");
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const classified = classifyOpenAIError(error);

      if (!classified.retryable || attempt >= maxRetries) {
        throw toJarvisError(error);
      }

      const delay = calculateRetryDelay(attempt);

      await new Promise<void>((resolve, reject) => {
        const timer: ReturnType<typeof setTimeout> = setTimeout(resolve, delay);
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new JarvisError("INTERNAL_ERROR", "Request was aborted"));
            },
            { once: true }
          );
        }
      });
    }
  }

  throw toJarvisError(lastError);
}
