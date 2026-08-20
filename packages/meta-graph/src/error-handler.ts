import { JarvisError } from "@jarvis/core";

export interface MetaApiError {
  message: string;
  type: string;
  code: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

export interface MetaErrorResponse {
  error: MetaApiError;
}

export type MetaErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHORIZATION_FAILED"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "TOOL_TIMEOUT"
  | "INTERNAL_ERROR";

export interface ClassifiedMetaError {
  code: MetaErrorCode;
  retryable: boolean;
  message: string;
  fbtraceId?: string;
  metaType?: string;
  metaCode?: number;
}

const RETRYABLE_TYPES = new Set(["OAuthException", "API_EC_TOO_MANY_CALLS", "temporarily_unavailable"]);

export function classifyMetaError(
  status: number,
  body: MetaErrorResponse | string | unknown
): ClassifiedMetaError {
  let message = "Unknown Meta API error";
  let metaType = "";
  let metaCode = 0;
  let fbtraceId: string | undefined;

  if (body && typeof body === "object" && "error" in body) {
    const err = (body as MetaErrorResponse).error;
    message = err.message || message;
    metaType = err.type || "";
    metaCode = err.code || 0;
    fbtraceId = err.fbtrace_id;
  } else if (typeof body === "string") {
    message = body;
  }

  const safeMessage = redactSensitiveInfo(message);

  if (status === 401 || metaType === "OAuthException" && metaCode === 190) {
    return { code: "AUTHENTICATION_REQUIRED", retryable: false, message: safeMessage, fbtraceId, metaType, metaCode };
  }
  if (status === 403 || metaCode === 200 || metaCode === 10 || metaCode === 190) {
    return { code: "AUTHORIZATION_FAILED", retryable: false, message: safeMessage, fbtraceId, metaType, metaCode };
  }
  if (status === 400 || metaCode === 100 || metaCode === 148 || metaCode === 147) {
    return { code: "INVALID_REQUEST", retryable: false, message: safeMessage, fbtraceId, metaType, metaCode };
  }
  if (status === 404 || metaCode === 803) {
    return { code: "INVALID_REQUEST", retryable: false, message: safeMessage, fbtraceId, metaType, metaCode };
  }
  if (status === 429 || metaCode === 32 || metaType === "API_EC_TOO_MANY_CALLS") {
    return { code: "RATE_LIMITED", retryable: true, message: safeMessage, fbtraceId, metaType, metaCode };
  }
  if (status === 408 || status === 504) {
    return { code: "TOOL_TIMEOUT", retryable: true, message: safeMessage, fbtraceId, metaType, metaCode };
  }
  if (status >= 500 || RETRYABLE_TYPES.has(metaType)) {
    return { code: "INTERNAL_ERROR", retryable: true, message: safeMessage, fbtraceId, metaType, metaCode };
  }

  return { code: "INTERNAL_ERROR", retryable: false, message: safeMessage, fbtraceId, metaType, metaCode };
}

export function toJarvisError(classified: ClassifiedMetaError): JarvisError {
  return new JarvisError(classified.code, classified.message);
}

function redactSensitiveInfo(message: string): string {
  return message
    .replace(/EAA[A-Za-z0-9]+/g, "[REDACTED_TOKEN]")
    .replace(/access_token[:\s]*[^\s,]+/gi, "access_token: [REDACTED]")
    .replace(/bearer\s+[^\s,]+/gi, "Bearer [REDACTED]");
}
