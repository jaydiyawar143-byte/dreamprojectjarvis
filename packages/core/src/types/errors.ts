import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "AUTHENTICATION_REQUIRED",
  "AUTHORIZATION_FAILED",
  "INVALID_REQUEST",
  "AGENT_NOT_FOUND",
  "AGENT_ERROR",
  "AI_PROVIDER_NOT_CONFIGURED",
  "AI_PROVIDER_AUTH_FAILED",
  "AI_PROVIDER_UNAVAILABLE",
  "CONTEXT_LENGTH_EXCEEDED",
  "TOOL_NOT_FOUND",
  "TOOL_EXECUTION_FAILED",
  "TOOL_PLAN_INVALID",
  "TOOL_UNAVAILABLE",
  "TOOL_TIMEOUT",
  "TOOL_RATE_LIMITED",
  "APPROVAL_REQUIRED",
  "APPROVAL_REJECTED",
  "APPROVAL_EXPIRED",
  "CONVERSATION_NOT_FOUND",
  "MEMORY_ERROR",
  "MEMORY_EMBEDDING_FAILED",
  "MEMORY_EXTRACTION_FAILED",
  "DOCUMENT_UNSUPPORTED_FORMAT",
  "DOCUMENT_TOO_LARGE",
  "DOCUMENT_INVALID",
  "DOCUMENT_EMPTY",
  "DOCUMENT_CORRUPTED",
  "DOCUMENT_EXTRACTION_FAILED",
  "DOCUMENT_EMBEDDING_FAILED",
  "KNOWLEDGE_RETRIEVAL_FAILED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  AUTHENTICATION_REQUIRED: 401,
  AUTHORIZATION_FAILED: 403,
  INVALID_REQUEST: 400,
  AGENT_NOT_FOUND: 404,
  AGENT_ERROR: 500,
  // R-21 — the server has no key for the model provider. A deployment state,
  // not a failed request: the fix is configuration and a restart.
  AI_PROVIDER_NOT_CONFIGURED: 503,
  // R-29 — the provider rejected the SERVER's key. Configuration, like the one
  // above, and deliberately not 401: a 401 tells the browser the user's own
  // session expired, and it refreshes and resends.
  AI_PROVIDER_AUTH_FAILED: 503,
  // R-27 — the adapter's circuit is open and the provider was not called.
  AI_PROVIDER_UNAVAILABLE: 503,
  // R-25 — this conversation no longer fits the model's context window.
  CONTEXT_LENGTH_EXCEEDED: 413,
  TOOL_NOT_FOUND: 404,
  TOOL_EXECUTION_FAILED: 500,
  TOOL_PLAN_INVALID: 400,
  TOOL_UNAVAILABLE: 503,
  TOOL_TIMEOUT: 504,
  TOOL_RATE_LIMITED: 429,
  APPROVAL_REQUIRED: 428,
  APPROVAL_REJECTED: 403,
  APPROVAL_EXPIRED: 408,
  CONVERSATION_NOT_FOUND: 404,
  MEMORY_ERROR: 500,
  MEMORY_EMBEDDING_FAILED: 500,
  MEMORY_EXTRACTION_FAILED: 500,
  DOCUMENT_UNSUPPORTED_FORMAT: 415,
  DOCUMENT_TOO_LARGE: 413,
  DOCUMENT_INVALID: 400,
  DOCUMENT_EMPTY: 422,
  DOCUMENT_CORRUPTED: 422,
  DOCUMENT_EXTRACTION_FAILED: 500,
  DOCUMENT_EMBEDDING_FAILED: 500,
  KNOWLEDGE_RETRIEVAL_FAILED: 500,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class JarvisError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    statusCode?: number,
  ) {
    super(message);
    this.name = "JarvisError";
    this.code = code;
    this.statusCode = statusCode ?? ERROR_STATUS_MAP[code];
    this.details = details;
  }
}
