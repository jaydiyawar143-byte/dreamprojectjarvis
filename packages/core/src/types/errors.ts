import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "AUTHENTICATION_REQUIRED",
  "AUTHORIZATION_FAILED",
  "INVALID_REQUEST",
  "AGENT_NOT_FOUND",
  "AGENT_ERROR",
  "TOOL_NOT_FOUND",
  "TOOL_EXECUTION_FAILED",
  "APPROVAL_REQUIRED",
  "APPROVAL_REJECTED",
  "CONVERSATION_NOT_FOUND",
  "MEMORY_ERROR",
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
  TOOL_NOT_FOUND: 404,
  TOOL_EXECUTION_FAILED: 500,
  APPROVAL_REQUIRED: 428,
  APPROVAL_REJECTED: 403,
  CONVERSATION_NOT_FOUND: 404,
  MEMORY_ERROR: 500,
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
