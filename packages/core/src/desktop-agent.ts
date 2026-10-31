// ---------------------------------------------------------------------------
// Phase 19, Stage 19.6 — the Windows desktop agent protocol.
//
// CONTRACT ONLY, plus the pure cryptography both ends need. Nothing here opens
// a socket, reads a file or touches a database. It fixes, for the API and for
// the .NET agent alike:
//
//   • the owner-approved timings (U5, D6): a 10-minute pairing code, a
//     30-second command, a 60-second clock skew, a 15-minute default grant of
//     at most 60 minutes, a 30-second reconnect grace;
//   • pairing codes — 160 random bits, shown once, stored only as a hash;
//   • device identity — an ECDSA P-256 public key, never a private one, and
//     the fingerprint a person compares on both screens;
//   • three signed strings: an agent's request (device key), a command and a
//     response (the server's command key). Each is a fixed list of ASCII
//     fields, so the .NET agent derives exactly the same bytes; shared test
//     vectors pin that (`apps/desktop-agent/contract`);
//   • the versioned consent wording, rendered identically on both sides so the
//     server can check the hash the agent reports against the text it would
//     itself show;
//   • every message, as a strict schema: an unknown field, an unknown action,
//     an oversized value or another protocol version is refused.
//
// The v1 command set is the 19.1 vocabulary (`computer-control.ts`) without
// screen reading, which the owner excluded (D4): click, key, and typing, which
// needs an in-app approval AND Windows Hello on the device for each command
// (D1). Ending a session is a state change, not a command. There is no shell,
// script, process, file, clipboard, registry or elevation command, and no way
// to express one.
//
// Written with `zod/v4` (bundled with the repo's zod 3.25) because it exports
// JSON Schema, which the .NET agent's contract tests read.
// ---------------------------------------------------------------------------

import { KeyObject, createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { z } from "zod/v4";

import { DESKTOP_COORDINATE_MAX, DESKTOP_KEY_NAMES, type DesktopKeyName } from "./computer-control.js";
import { BROWSER_INPUT_TEXT_MAX_LENGTH } from "./types/browser.js";

// ---------------------------------------------------------------------------
// Owner-approved values (U5, D6)
// ---------------------------------------------------------------------------

export const DESKTOP_PROTOCOL_VERSION = "jarvis-desktop/1" as const;
/** The agent release this server was built with; the default minimum it accepts. */
export const DESKTOP_AGENT_CURRENT_VERSION = "1.0.0";

export const DESKTOP_PAIRING_CODE_TTL_MS = 10 * 60_000;
export const DESKTOP_COMMAND_TTL_MS = 30_000;
export const DESKTOP_CLOCK_SKEW_MS = 60_000;
export const DESKTOP_GRANT_DEFAULT_MINUTES = 15;
export const DESKTOP_GRANT_MAX_MINUTES = 60;
export const DESKTOP_RECONNECT_GRACE_MS = 30_000;
/** How long the server holds a poll open. Below the grace, so a held poll is never a disconnect. */
export const DESKTOP_POLL_HOLD_MS = 20_000;
/** Windows 11's first build. A deployment's minimum (`DESKTOP_AGENT_MIN_WINDOWS_BUILD`) is never below it. */
export const DESKTOP_WINDOWS_11_FIRST_BUILD = 22_000;

// ---------------------------------------------------------------------------
// The v1 command set (D1, D4, D5)
// ---------------------------------------------------------------------------

export const DESKTOP_COMMAND_ACTIONS = Object.freeze([
  "desktop.input.click",
  "desktop.input.key",
  "desktop.input.type",
] as const);
export type DesktopCommandAction = (typeof DESKTOP_COMMAND_ACTIONS)[number];

const COMMAND_ACTION_SET: ReadonlySet<string> = new Set<string>(DESKTOP_COMMAND_ACTIONS);
export function isDesktopCommandAction(value: unknown): value is DesktopCommandAction {
  return typeof value === "string" && COMMAND_ACTION_SET.has(value);
}

/** D1 — the actions that need Windows Hello on the device, for each command, on top of the in-app approval. */
export function desktopActionRequiresHello(action: DesktopCommandAction): boolean {
  return action === "desktop.input.type";
}

/** What a grant may allow: a non-empty subset of the command set, in this order. */
export const DESKTOP_GRANT_SCOPES = DESKTOP_COMMAND_ACTIONS;
export type DesktopGrantScope = DesktopCommandAction;

/** The longest text one command may type. */
export const DESKTOP_TYPE_TEXT_MAX_LENGTH = BROWSER_INPUT_TEXT_MAX_LENGTH;

/** No lone surrogate: text that UTF-8 can carry exactly, as typing and hashing need. */
function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Text a command may type: not empty, within the bound, and no control
 * characters. A newline or a tab would press Enter or Tab inside "typing";
 * those are keys, and a key is its own command with its own approval.
 */
export function isTypeableText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > DESKTOP_TYPE_TEXT_MAX_LENGTH) return false;
  if (!isWellFormedUtf16(value)) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------

/** Crockford base32: no I, L, O or U, so a code survives being read aloud or retyped. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 20 bytes: 160 random bits, above the 128 the brief requires, as 32 characters. */
const PAIRING_CODE_BYTES = 20;
const PAIRING_CODE_LENGTH = 32;

/** A new pairing code, formatted for display as eight groups of four. */
export function generateDesktopPairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_BYTES);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join("-");
}

/**
 * A code as typed, made canonical — or null when it cannot be one. Case,
 * spaces and hyphens are forgiven, and the letters Crockford reads as digits
 * (I, L → 1; O → 0) are mapped.
 */
export function normalizeDesktopPairingCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (compact.length !== PAIRING_CODE_LENGTH) return null;
  for (const character of compact) if (!CROCKFORD.includes(character)) return null;
  return compact;
}

/** The only form a pairing code is stored in. */
export function hashDesktopPairingCode(normalized: string): string {
  return createHash("sha256").update(`jarvis-desktop-pairing/1\n${normalized}`, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Keys, fingerprints and signatures — ECDSA P-256, SHA-256, IEEE P1363
// ---------------------------------------------------------------------------

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
/** A P-256 SubjectPublicKeyInfo is 91 bytes; base64 of it is 124 characters. */
const SPKI_BASE64_MAX = 200;

/**
 * A device or server public key: base64 SubjectPublicKeyInfo of an ECDSA
 * P-256 key, and nothing else — no RSA, no other curve, no private key.
 */
export function isP256PublicKey(spkiBase64: unknown): spkiBase64 is string {
  if (typeof spkiBase64 !== "string" || spkiBase64.length > SPKI_BASE64_MAX || !BASE64_PATTERN.test(spkiBase64)) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

/** SHA-256 of the key's DER bytes, as 64 lowercase hex characters. Unique per device. */
export function desktopKeyFingerprint(spkiBase64: string): string {
  return createHash("sha256").update(Buffer.from(spkiBase64, "base64")).digest("hex");
}

/**
 * What a person compares on the agent and in the web UI: the fingerprint's
 * first 96 bits, as six groups of four, e.g. `3F2A-9C01-…`.
 */
export function desktopFingerprintDisplay(fingerprint: string): string {
  return fingerprint.slice(0, 24).toUpperCase().match(/.{4}/g)!.join("-");
}

/** The server's command key's id: the first 16 hex characters of its fingerprint. */
export function desktopServerKeyId(spkiBase64: string): string {
  return desktopKeyFingerprint(spkiBase64).slice(0, 16);
}

/** Signs a canonical string. The signature is IEEE P1363 (r‖s, 64 bytes), base64url — .NET's default. */
export function signDesktopCanonical(privateKey: KeyObject | Parameters<typeof createPrivateKey>[0], canonical: string): string {
  return sign("sha256", Buffer.from(canonical, "utf8"), {
    key: privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

/** Verifies a canonical string's signature. Anything malformed is a mismatch, never an error. */
export function verifyDesktopCanonical(spkiBase64: string, canonical: string, signature: unknown): boolean {
  if (typeof signature !== "string" || signature.length !== 86 || !BASE64URL_PATTERN.test(signature)) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false;
    return verify("sha256", Buffer.from(canonical, "utf8"), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Signed agent requests
// ---------------------------------------------------------------------------

/** Lower-case, as Node delivers them. */
export const DESKTOP_AGENT_HEADERS = Object.freeze({
  version: "x-jarvis-desktop-version",
  device: "x-jarvis-device",
  timestamp: "x-jarvis-timestamp",
  nonce: "x-jarvis-nonce",
  bodySha256: "x-jarvis-content-sha256",
  signature: "x-jarvis-signature",
  responseSignature: "x-jarvis-response-signature",
  responseKey: "x-jarvis-response-key",
});

/** The device field of a pairing request, which is signed by a key that has no device yet. */
export const DESKTOP_PAIRING_DEVICE = "pairing";

const TIMESTAMP_PATTERN = /^[0-9]{1,15}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATH_PATTERN = /^\/api\/v1\/desktop-agent\/[a-z0-9/-]{1,120}$/;

export interface DesktopRequestParts {
  method: string;
  /** The request path the agent called, without a query. */
  path: string;
  timestamp: string;
  nonce: string;
  /** The device id, or `pairing` for the one request a device makes before it has one. */
  device: string;
  bodySha256: string;
}

export function desktopRequestCanonical(parts: DesktopRequestParts): string {
  return [
    "jarvis-desktop-request/1",
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.device,
    parts.bodySha256,
  ].join("\n");
}

/** Shape checks on a request's signed fields, before any key or store is touched. */
export function desktopRequestPartsAreWellFormed(parts: DesktopRequestParts): boolean {
  return (
    parts.method === "POST" &&
    PATH_PATTERN.test(parts.path) &&
    TIMESTAMP_PATTERN.test(parts.timestamp) &&
    NONCE_PATTERN.test(parts.nonce) &&
    (parts.device === DESKTOP_PAIRING_DEVICE || UUID_PATTERN.test(parts.device)) &&
    SHA256_HEX_PATTERN.test(parts.bodySha256)
  );
}

export function isDesktopTimestampFresh(timestamp: string, now: number, skewMs = DESKTOP_CLOCK_SKEW_MS): boolean {
  if (!TIMESTAMP_PATTERN.test(timestamp)) return false;
  return Math.abs(now - Number(timestamp)) <= skewMs;
}

// ---------------------------------------------------------------------------
// Signed responses — every answer to an agent, bound to the request it answers
// ---------------------------------------------------------------------------

export function desktopResponseCanonical(parts: { requestNonce: string; status: number; bodySha256: string }): string {
  return ["jarvis-desktop-response/1", parts.requestNonce, String(parts.status), parts.bodySha256].join("\n");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const DESKTOP_MOUSE_BUTTONS = Object.freeze(["left", "right", "middle"] as const);
export type DesktopMouseButton = (typeof DESKTOP_MOUSE_BUTTONS)[number];

export type DesktopCommandParams =
  | { action: "desktop.input.click"; x: number; y: number; button: DesktopMouseButton }
  | { action: "desktop.input.key"; key: DesktopKeyName }
  | { action: "desktop.input.type"; text: string };

/**
 * One command's parameters, as one ASCII line: integers in decimal, names as
 * themselves, typed text as base64url of its UTF-8. Nothing here needs JSON
 * escaping to agree between TypeScript and .NET.
 */
export function desktopParamsCanonical(params: DesktopCommandParams): string {
  switch (params.action) {
    case "desktop.input.click":
      return `x=${params.x}&y=${params.y}&button=${params.button}`;
    case "desktop.input.key":
      return `key=${params.key}`;
    case "desktop.input.type":
      return `text=${Buffer.from(params.text, "utf8").toString("base64url")}`;
  }
}

export interface DesktopCommandParts {
  commandId: string;
  deviceId: string;
  grantId: string;
  params: DesktopCommandParams;
  issuedAt: number;
  expiresAt: number;
  requiresHello: boolean;
}

export function desktopCommandCanonical(parts: DesktopCommandParts): string {
  return [
    "jarvis-desktop-command/1",
    parts.commandId,
    parts.deviceId,
    parts.grantId,
    parts.params.action,
    desktopParamsCanonical(parts.params),
    String(parts.issuedAt),
    String(parts.expiresAt),
    parts.requiresHello ? "1" : "0",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Consent (U5c) — versioned wording, rendered identically on both sides
// ---------------------------------------------------------------------------

export const DESKTOP_CONSENT_TEXT_VERSION = "desktop-consent/1" as const;
/** The kill switch. The agent honours it only from a physical keyboard. */
export const DESKTOP_KILL_SWITCH = "Ctrl+Alt+Shift+F12";

const SCOPE_LINES: Readonly<Record<DesktopGrantScope, string>> = Object.freeze({
  "desktop.input.click": "- click at positions on this screen",
  "desktop.input.key": "- press Enter, Tab, Escape, Backspace, Delete and the arrow keys",
  "desktop.input.type": "- type text, only after you verify each time with Windows Hello",
});

/** A grant's scope in the one order it is shown and signed in; null when it is not a valid scope. */
export function canonicalDesktopScope(scope: readonly string[]): DesktopGrantScope[] | null {
  if (scope.length === 0 || new Set(scope).size !== scope.length) return null;
  if (!scope.every((s) => isDesktopCommandAction(s))) return null;
  return DESKTOP_GRANT_SCOPES.filter((s) => scope.includes(s));
}

/**
 * The exact consent text for one grant. Deterministic: no clock time, no
 * locale, LF line breaks, no trailing newline. The labels are the ones the
 * server sent the agent at pairing, already sanitized (`sanitizeDesktopLabel`).
 */
export function renderDesktopConsentText(input: {
  userLabel: string;
  organizationLabel: string;
  durationMinutes: number;
  scope: readonly DesktopGrantScope[];
}): string {
  const minutes = `${input.durationMinutes} minute${input.durationMinutes === 1 ? "" : "s"}`;
  return [
    "Allow JARVIS to control this computer?",
    "",
    `Requested by: ${input.userLabel}`,
    `Organization: ${input.organizationLabel}`,
    `Duration: ${minutes}, starting when you choose Allow.`,
    "",
    "JARVIS may:",
    ...DESKTOP_GRANT_SCOPES.filter((s) => input.scope.includes(s)).map((s) => SCOPE_LINES[s]),
    "",
    "JARVIS cannot see your screen, run programs or scripts, open, read or change files, use the clipboard, change settings, or act in windows that run as administrator.",
    "",
    `Control ends after ${minutes}, when you lock this computer, sign out or restart, or when you press ${DESKTOP_KILL_SWITCH}.`,
  ].join("\n");
}

export function desktopConsentTextSha256(text: string): string {
  return sha256Hex(Buffer.from(text, "utf8"));
}

/**
 * A name shown on a consent screen or a device list: printable, single-line,
 * bounded, and never empty. Applied by the server; the agent shows what the
 * server sent, as sent.
 */
export function sanitizeDesktopLabel(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : "";
  const cleaned = Array.from(text, (character) => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = Array.from(cleaned).slice(0, max).join("").trim();
  return bounded.length > 0 && isWellFormedUtf16(bounded) ? bounded : "Unknown";
}

/** `major.minor.patch`, compared numerically. Null when either is not one. */
export function compareDesktopAgentVersions(a: string, b: string): number | null {
  const parse = (v: string) => (/^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/.test(v) ? v.split(".").map(Number) : null);
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const DESKTOP_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "UNAUTHENTICATED",
  "REQUEST_EXPIRED",
  "REPLAY_DETECTED",
  "PAIRING_CODE_INVALID",
  "RATE_LIMITED",
  "DEVICE_PENDING",
  "DEVICE_REVOKED",
  "NOT_AUTHORIZED",
  "AGENT_VERSION_UNSUPPORTED",
  "WINDOWS_VERSION_UNSUPPORTED",
  "GRANT_INVALID",
  "GRANT_CONFLICT",
  "CONSENT_MISMATCH",
  "NOT_FOUND",
  "CONFLICT",
  "UNAVAILABLE",
] as const);
export type DesktopErrorCode = (typeof DESKTOP_ERROR_CODES)[number];

/** Why an agent did not act. Each means: nothing was typed, clicked or pressed. */
export const DESKTOP_NOT_EXECUTED_CODES = Object.freeze([
  "HELLO_UNAVAILABLE",
  "HELLO_FAILED",
  "ELEVATED_TARGET",
  "NO_TARGET",
  "OUT_OF_BOUNDS",
  "SESSION_LOCKED",
  "GRANT_INACTIVE",
  "COMMAND_EXPIRED",
  "INVALID_COMMAND",
  "BUSY",
] as const);
export type DesktopNotExecutedCode = (typeof DESKTOP_NOT_EXECUTED_CODES)[number];

export const DESKTOP_SESSION_END_REASONS = Object.freeze([
  "user",
  "kill-switch",
  "lock",
  "sign-out",
  "shutdown",
  "expired",
  "disconnected",
] as const);
export type DesktopSessionEndReason = (typeof DESKTOP_SESSION_END_REASONS)[number];

const Version = z.literal(DESKTOP_PROTOCOL_VERSION);
const Uuid = z.string().regex(UUID_PATTERN);
const Sha256Hex = z.string().regex(SHA256_HEX_PATTERN);
const AgentVersion = z.string().regex(/^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/);
const PublicKey = z.string().min(1).max(SPKI_BASE64_MAX).regex(BASE64_PATTERN);
const Label = z.string().min(1).max(80);
const Coordinate = z.number().int().min(0).max(DESKTOP_COORDINATE_MAX);
const DurationMinutes = z.number().int().min(1).max(DESKTOP_GRANT_MAX_MINUTES);

export const DesktopPairRequestSchema = z.strictObject({
  version: Version,
  pairingCode: z.string().min(1).max(64),
  publicKey: PublicKey,
  deviceName: z.string().min(1).max(256),
  agentVersion: AgentVersion,
  windowsBuild: z.number().int().min(0).max(1_000_000),
  architecture: z.enum(["x64", "arm64", "x86"]),
});

export const DesktopPairResponseSchema = z.strictObject({
  version: Version,
  deviceId: Uuid,
  fingerprint: Sha256Hex,
  status: z.literal("pending"),
  serverKeyId: z.string().regex(/^[0-9a-f]{16}$/),
  serverPublicKey: PublicKey,
  userLabel: Label,
  organizationLabel: Label,
});

export const DesktopPollRequestSchema = z.strictObject({
  version: Version,
  agentInstanceId: Uuid,
  agentVersion: AgentVersion,
  windowsBuild: z.number().int().min(0).max(1_000_000),
  /** The grant the agent believes is active, or null. */
  grantId: Uuid.nullable(),
});

const ClickParams = z.strictObject({ x: Coordinate, y: Coordinate, button: z.enum(DESKTOP_MOUSE_BUTTONS) });
const KeyParams = z.strictObject({ key: z.enum(DESKTOP_KEY_NAMES) });
const TypeParams = z.strictObject({ text: z.string().min(1).max(DESKTOP_TYPE_TEXT_MAX_LENGTH) });

const commandFields = {
  commandId: Uuid,
  deviceId: Uuid,
  grantId: Uuid,
  issuedAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
  requiresHello: z.boolean(),
  /** The server's signature over `desktopCommandCanonical`, by its command key. */
  signature: z.string().length(86).regex(BASE64URL_PATTERN),
};

export const DesktopCommandEnvelopeSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...commandFields, action: z.literal("desktop.input.click"), params: ClickParams }),
  z.strictObject({ ...commandFields, action: z.literal("desktop.input.key"), params: KeyParams }),
  z.strictObject({ ...commandFields, action: z.literal("desktop.input.type"), params: TypeParams }),
]);

const DeviceState = z.strictObject({ status: z.enum(["pending", "active"]) });
const GrantState = z.strictObject({
  grantId: Uuid,
  status: z.enum(["active", "ended"]),
  expiresAt: z.number().int().min(0),
});

export const DesktopPollResponseSchema = z.strictObject({
  version: Version,
  device: DeviceState,
  grant: GrantState.nullable(),
  command: DesktopCommandEnvelopeSchema.nullable(),
});

export const DesktopGrantRequestSchema = z.strictObject({
  version: Version,
  agentInstanceId: Uuid,
  grantId: Uuid,
  durationMinutes: DurationMinutes,
  scope: z.array(z.enum(DESKTOP_GRANT_SCOPES)).min(1).max(DESKTOP_GRANT_SCOPES.length),
  consentTextVersion: z.literal(DESKTOP_CONSENT_TEXT_VERSION),
  consentTextSha256: Sha256Hex,
  /** Set when this consent extends a grant that is still active: fresh consent ends it and starts this one. */
  replacesGrantId: Uuid.nullable(),
});

export const DesktopGrantResponseSchema = z.strictObject({
  version: Version,
  grant: GrantState,
});

export const DesktopSessionEndRequestSchema = z.strictObject({
  version: Version,
  agentInstanceId: Uuid,
  grantId: Uuid,
  reason: z.enum(DESKTOP_SESSION_END_REASONS),
});

export const DesktopCommandResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ version: Version, outcome: z.literal("succeeded") }),
  z.strictObject({ version: Version, outcome: z.literal("not-executed"), code: z.enum(DESKTOP_NOT_EXECUTED_CODES) }),
  /** The agent started injecting and was interrupted: it cannot say what reached the window. */
  z.strictObject({ version: Version, outcome: z.literal("uncertain") }),
]);

export const DesktopAckResponseSchema = z.strictObject({ version: Version, ok: z.literal(true) });

export const DesktopErrorResponseSchema = z.strictObject({
  version: Version,
  error: z.strictObject({ code: z.enum(DESKTOP_ERROR_CODES) }),
});

export type DesktopPairRequest = z.infer<typeof DesktopPairRequestSchema>;
export type DesktopPairResponse = z.infer<typeof DesktopPairResponseSchema>;
export type DesktopPollRequest = z.infer<typeof DesktopPollRequestSchema>;
export type DesktopPollResponse = z.infer<typeof DesktopPollResponseSchema>;
export type DesktopCommandEnvelope = z.infer<typeof DesktopCommandEnvelopeSchema>;
export type DesktopGrantRequest = z.infer<typeof DesktopGrantRequestSchema>;
export type DesktopGrantResponse = z.infer<typeof DesktopGrantResponseSchema>;
export type DesktopSessionEndRequest = z.infer<typeof DesktopSessionEndRequestSchema>;
export type DesktopCommandResult = z.infer<typeof DesktopCommandResultSchema>;
export type DesktopErrorResponse = z.infer<typeof DesktopErrorResponseSchema>;

/** Every agent-facing message, by name: what the JSON Schema export covers. */
export const DESKTOP_AGENT_MESSAGE_SCHEMAS = Object.freeze({
  PairRequest: DesktopPairRequestSchema,
  PairResponse: DesktopPairResponseSchema,
  PollRequest: DesktopPollRequestSchema,
  PollResponse: DesktopPollResponseSchema,
  CommandEnvelope: DesktopCommandEnvelopeSchema,
  GrantRequest: DesktopGrantRequestSchema,
  GrantResponse: DesktopGrantResponseSchema,
  SessionEndRequest: DesktopSessionEndRequestSchema,
  CommandResult: DesktopCommandResultSchema,
  AckResponse: DesktopAckResponseSchema,
  ErrorResponse: DesktopErrorResponseSchema,
});

/** The JSON Schema of every agent-facing message, for the .NET agent's contract tests. */
export function desktopAgentJsonSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(DESKTOP_AGENT_MESSAGE_SCHEMAS).map(([name, schema]) => [name, z.toJSONSchema(schema, { target: "draft-2020-12" })])
  );
}

/** Parses an agent message; null when it is not exactly one. */
export function parseDesktopMessage<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// What a person may ask for (D5) — through the web UI only
// ---------------------------------------------------------------------------

export const DesktopCommandRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("desktop.input.click"), x: Coordinate, y: Coordinate, button: z.enum(DESKTOP_MOUSE_BUTTONS).optional() }),
  z.strictObject({ action: z.literal("desktop.input.key"), key: z.enum(DESKTOP_KEY_NAMES) }),
  z.strictObject({ action: z.literal("desktop.input.type"), text: z.string().refine(isTypeableText) }),
]);
export type DesktopCommandRequest = z.infer<typeof DesktopCommandRequestSchema>;

/** A person's request as the command it becomes: a click's button made explicit. */
export function desktopCommandParams(request: DesktopCommandRequest): DesktopCommandParams {
  switch (request.action) {
    case "desktop.input.click":
      return { action: request.action, x: request.x, y: request.y, button: request.button ?? "left" };
    case "desktop.input.key":
      return { action: request.action, key: request.key };
    case "desktop.input.type":
      return { action: request.action, text: request.text };
  }
}

/**
 * The parameters an approval for a command is bound to: the device, and the
 * command's own parameters without its action. The device is in the hash, so
 * the approval can be spent on that device only.
 */
export function desktopApprovalParams(params: DesktopCommandParams, deviceId: string): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return { deviceId, ...rest };
}
