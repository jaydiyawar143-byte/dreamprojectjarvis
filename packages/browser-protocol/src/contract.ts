// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the versioned, validated wire contract.
//
// The payloads are NOT redefined here. A browser action's payload is exactly
// the Phase 19.1 `ComputerControlRequest` minus its `action` discriminator, and
// the service validates it with the same `parseComputerControlRequest` the
// tools use. That is deliberate: a second schema for the same action is how
// two surfaces drift until one of them accepts something the other refuses.
//
// The envelope adds only what a network boundary needs: a version, a request
// id for correlation, an operation, the caller's server-resolved subject, and
// the id of the session it acts on.
// ---------------------------------------------------------------------------

import {
  BROWSER_ACTION_TOOL_IDS,
  BROWSER_CONTROL_ACTION_IDS,
  parseComputerControlRequest,
  type BrowserControlActionId,
  type BrowserControlRequest,
} from "@jarvis/core";
import { z } from "zod";

import {
  BrowserServiceError,
  BROWSER_SERVICE_ERROR_MESSAGES,
  isBrowserServiceErrorCode,
  type BrowserServiceErrorCode,
} from "./errors.js";
import { BROWSER_PROTOCOL_VERSION, type BrowserProtocolVersion } from "./version.js";

/** Operations that open and close a session, beside the ten browser actions. */
export const BROWSER_SERVICE_SESSION_OPERATIONS = Object.freeze([
  "session.open",
  "session.close",
] as const);

export const BROWSER_SERVICE_OPERATIONS = Object.freeze([
  ...BROWSER_SERVICE_SESSION_OPERATIONS,
  ...BROWSER_CONTROL_ACTION_IDS,
] as const);

export type BrowserServiceSessionOperation = (typeof BROWSER_SERVICE_SESSION_OPERATIONS)[number];
export type BrowserServiceOperation = BrowserServiceSessionOperation | BrowserControlActionId;

const OPERATION_SET: ReadonlySet<string> = new Set<string>(BROWSER_SERVICE_OPERATIONS);
const SESSION_OPERATION_SET: ReadonlySet<string> = new Set<string>(BROWSER_SERVICE_SESSION_OPERATIONS);
const CONTROL_OPERATION_SET: ReadonlySet<string> = new Set<string>(BROWSER_CONTROL_ACTION_IDS);

export function isBrowserServiceOperation(value: unknown): value is BrowserServiceOperation {
  return typeof value === "string" && OPERATION_SET.has(value);
}

/**
 * The operations that act on a page (Stage 19.2 audit, H2): core's approval-
 * gated browser actions, the one list. A failure after one of these was sent
 * may have reached the site. The reads and the session operations change
 * nothing outside JARVIS.
 */
const WRITE_OPERATION_SET: ReadonlySet<string> = new Set<string>(BROWSER_ACTION_TOOL_IDS);

export function isBrowserServiceWriteOperation(value: unknown): boolean {
  return typeof value === "string" && WRITE_OPERATION_SET.has(value);
}

export function isBrowserControlOperation(value: unknown): value is BrowserControlActionId {
  return typeof value === "string" && CONTROL_OPERATION_SET.has(value);
}

/**
 * The caller's subject, as the API resolved it server-side.
 *
 * `organizationId` is not a preference a caller expresses; it is the owning
 * Organization the API's shared-connection reader returned. The service binds
 * it to a session at open and refuses every later request whose claim differs.
 * See `BrowserSessionRegistry` for why that is what makes a body-supplied id
 * harmless.
 */
export interface BrowserServiceSubject {
  userId: string;
  organizationId: string;
}

export interface BrowserServiceRequest {
  version: BrowserProtocolVersion;
  requestId: string;
  operation: BrowserServiceOperation;
  sessionId?: string;
  subject: BrowserServiceSubject;
  /** Present only for a browser action; validated by the Phase 19.1 parser. */
  control?: BrowserControlRequest;
}

export type BrowserServiceEnvelopeParse =
  | { ok: true; value: BrowserServiceRequest }
  | { ok: false; code: BrowserServiceErrorCode };

const SubjectSchema = z
  .object({
    userId: z.string().min(1).max(200),
    organizationId: z.string().min(1).max(200),
  })
  .strict();

const EnvelopeSchema = z
  .object({
    version: z.string(),
    requestId: z.string().uuid(),
    operation: z.string().min(1).max(64),
    sessionId: z.string().uuid().optional(),
    subject: SubjectSchema,
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyPayload(payload: Record<string, unknown> | undefined): boolean {
  return payload === undefined || Object.keys(payload).length === 0;
}

/**
 * Parse one request envelope, telling its failures apart.
 *
 * An unsupported version is checked before the operation, and an unknown
 * operation before the payload, so a newer caller gets a stable answer rather
 * than a generic schema failure it cannot act on.
 */
export function parseBrowserServiceRequest(input: unknown): BrowserServiceEnvelopeParse {
  if (!isPlainObject(input)) return { ok: false, code: "INVALID_REQUEST" };

  if (input.version !== BROWSER_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: typeof input.version === "string" ? "UNSUPPORTED_VERSION" : "INVALID_REQUEST",
    };
  }

  if (typeof input.operation !== "string" || !isBrowserServiceOperation(input.operation)) {
    return {
      ok: false,
      code: typeof input.operation === "string" ? "UNKNOWN_OPERATION" : "INVALID_REQUEST",
    };
  }

  const parsed = EnvelopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID_REQUEST" };
  const envelope = parsed.data;
  const operation = envelope.operation;
  if (!isBrowserServiceOperation(operation)) return { ok: false, code: "UNKNOWN_OPERATION" };

  if (SESSION_OPERATION_SET.has(operation)) {
    if (!isEmptyPayload(envelope.payload)) return { ok: false, code: "INVALID_REQUEST" };
    if (operation === "session.open" && envelope.sessionId !== undefined) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    if (operation === "session.close" && envelope.sessionId === undefined) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    return {
      ok: true,
      value: {
        version: BROWSER_PROTOCOL_VERSION,
        requestId: envelope.requestId,
        operation,
        ...(envelope.sessionId === undefined ? {} : { sessionId: envelope.sessionId }),
        subject: envelope.subject,
      },
    };
  }

  if (!isBrowserControlOperation(operation)) return { ok: false, code: "UNKNOWN_OPERATION" };
  if (envelope.sessionId === undefined) return { ok: false, code: "INVALID_REQUEST" };
  if (!isPlainObject(envelope.payload)) return { ok: false, code: "INVALID_REQUEST" };
  // The action is the operation. A payload that names its own action is a
  // request trying to be two things, not a valid request for one.
  if (Object.prototype.hasOwnProperty.call(envelope.payload, "action")) {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const control = parseComputerControlRequest({
    ...envelope.payload,
    action: operation,
  });
  if (!control.ok) return { ok: false, code: "INVALID_REQUEST" };

  return {
    ok: true,
    value: {
      version: BROWSER_PROTOCOL_VERSION,
      requestId: envelope.requestId,
      operation,
      sessionId: envelope.sessionId,
      subject: envelope.subject,
      // `parseComputerControlRequest` validated against the Phase 19.1 union;
      // the operation is one of the ten browser actions, so the request is a
      // browser request. The cast names that, it does not widen it.
      control: control.value as BrowserControlRequest,
    },
  };
}

// ---------------------------------------------------------------------------
// Session results
// ---------------------------------------------------------------------------

export const BrowserServiceSessionOpenedSchema = z
  .object({
    sessionId: z.string().uuid(),
    expiresAt: z.number().int().positive(),
    ttlMs: z.number().int().positive(),
  })
  .strict();

export const BrowserServiceSessionClosedSchema = z.object({ closed: z.literal(true) }).strict();

export type BrowserServiceSessionOpened = z.infer<typeof BrowserServiceSessionOpenedSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface BrowserServiceSuccessEnvelope {
  version: BrowserProtocolVersion;
  requestId: string;
  ok: true;
  result: unknown;
}

export interface BrowserServiceFailureEnvelope {
  version: BrowserProtocolVersion;
  requestId: string | null;
  ok: false;
  error: { code: BrowserServiceErrorCode; message: string };
}

export type BrowserServiceResponse =
  | BrowserServiceSuccessEnvelope
  | BrowserServiceFailureEnvelope;

export function successEnvelope(
  requestId: string,
  result: unknown
): BrowserServiceSuccessEnvelope {
  return { version: BROWSER_PROTOCOL_VERSION, requestId, ok: true, result };
}

export function failureEnvelope(
  requestId: string | null,
  code: BrowserServiceErrorCode
): BrowserServiceFailureEnvelope {
  return {
    version: BROWSER_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message: BROWSER_SERVICE_ERROR_MESSAGES[code] },
  };
}

const SuccessSchema = z
  .object({
    version: z.string(),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

const FailureSchema = z
  .object({
    version: z.string(),
    requestId: z.string().uuid().nullable(),
    ok: z.literal(false),
    error: z
      .object({
        code: z.string(),
        message: z.string().max(300),
      })
      .strict(),
  })
  .strict();

export type ParsedBrowserServiceResponse =
  | { ok: true; requestId: string; result: unknown }
  | { ok: false; requestId: string | null; code: BrowserServiceErrorCode };

/**
 * Parse a response, using only the code the peer sent.
 *
 * The sentence is NOT taken from the wire. It is looked up locally from the
 * code, so a compromised or buggy browser service cannot put its own text in
 * front of a person or a model through an error.
 */
export function parseBrowserServiceResponse(input: unknown): ParsedBrowserServiceResponse {
  if (!isPlainObject(input)) return { ok: false, requestId: null, code: "PROVIDER_ERROR" };
  if (typeof input.version !== "string") {
    return { ok: false, requestId: null, code: "PROVIDER_ERROR" };
  }
  if (input.version !== BROWSER_PROTOCOL_VERSION) {
    return { ok: false, requestId: null, code: "UNSUPPORTED_VERSION" };
  }

  if (input.ok === true) {
    const parsed = SuccessSchema.safeParse(input);
    if (!parsed.success) return { ok: false, requestId: null, code: "PROVIDER_ERROR" };
    return { ok: true, requestId: parsed.data.requestId, result: parsed.data.result };
  }

  const parsed = FailureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, requestId: null, code: "PROVIDER_ERROR" };
  if (!isBrowserServiceErrorCode(parsed.data.error.code)) {
    return { ok: false, requestId: parsed.data.requestId, code: "PROVIDER_ERROR" };
  }
  return { ok: false, requestId: parsed.data.requestId, code: parsed.data.error.code };
}

/** The typed refusal a caller raises from a parsed failure. */
export function errorFromCode(code: BrowserServiceErrorCode): BrowserServiceError {
  return new BrowserServiceError(code);
}
