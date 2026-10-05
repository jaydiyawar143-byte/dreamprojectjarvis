// ---------------------------------------------------------------------------
// S8.2 — the seam between live MCP data and the reviewed S8.1 contract.
//
// Pure and deterministic: live data in, a verdict out. Live metadata is
// untrusted, so it is fingerprinted and compared, never passed on. What leaves
// a verification is the manifest's own entries; what leaves a failure is a
// fixed sentence. The fingerprint, the failure vocabulary and the call types
// are core's (S8.1, S8.3) — one implementation, shared with the tool adapter.
// ---------------------------------------------------------------------------

import {
  mcpFailure,
  mcpToolFingerprint,
  type McpCallResult,
  type McpContent,
  type McpDrift,
  type McpDriftKind,
  type McpFailure,
  type McpFingerprintFields,
  type McpServerManifest,
  type McpToolManifestEntry,
} from "@jarvis/core";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

type Obj = Record<string, unknown>;

const isRecord = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A short, printable string — no control characters. */
function isPlain(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  for (const char of value) {
    const c = char.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface McpServerInfo {
  name: string;
  version: string;
}

/** The live serverInfo as a plain name and version, or null. Nothing else is kept. */
export function normalizeServerInfo(live: unknown): McpServerInfo | null {
  if (!isRecord(live) || !isPlain(live.name) || !isPlain(live.version)) return null;
  return { name: live.name, version: live.version };
}

/** The S8.1 fingerprint of a live tool, or null when it is not a named object. */
export function liveToolFingerprint(live: unknown): string | null {
  if (!isRecord(live) || typeof live.name !== "string") return null;
  try {
    return mcpToolFingerprint(live as unknown as McpFingerprintFields);
  } catch {
    return null;
  }
}

export interface McpLiveTool {
  name: string;
  fingerprint: string;
}

/** A live listing reduced to names and fingerprints; anything unusable becomes null. */
export function normalizeToolListing(live: readonly unknown[]): (McpLiveTool | null)[] {
  return live.map((tool) => {
    const fingerprint = liveToolFingerprint(tool);
    return fingerprint === null ? null : { name: (tool as { name: string }).name, fingerprint };
  });
}

export type McpVerification =
  | { ok: true; tools: readonly McpToolManifestEntry[] }
  | { ok: false; drift: readonly McpDrift[] };

/** S8.1's tool-name rule: only a name like this is ever repeated in a report. */
const PLAIN_TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;

const named = (kind: McpDriftKind, name: string): McpDrift =>
  PLAIN_TOOL_NAME.test(name) ? { kind, tool: name } : { kind };

/**
 * Compare a live server with its review. Any difference fails: another name
 * or version, a reviewed tool missing or changed, a tool nobody reviewed, a
 * tool listed twice. On success, the result is the manifest's own enabled
 * entries — never the live listing.
 */
export function verifyServer(
  server: McpServerManifest,
  liveInfo: unknown,
  liveTools: readonly unknown[]
): McpVerification {
  const drift: McpDrift[] = [];
  const info = normalizeServerInfo(liveInfo);
  const expected = server.expectedServerInfo;
  if (info?.name !== expected.name || info.version !== expected.version) {
    drift.push({ kind: "SERVER_INFO_MISMATCH" });
  }

  const live = new Map<string, string>();
  for (const tool of normalizeToolListing(liveTools)) {
    if (tool === null) drift.push({ kind: "INVALID_TOOL" });
    else if (live.has(tool.name)) drift.push(named("DUPLICATE_TOOL", tool.name));
    else live.set(tool.name, tool.fingerprint);
  }

  for (const reviewed of server.tools) {
    const fingerprint = live.get(reviewed.name);
    if (fingerprint === undefined) drift.push({ kind: "MISSING_TOOL", tool: reviewed.name });
    else if (fingerprint !== reviewed.fingerprint) drift.push({ kind: "FINGERPRINT_MISMATCH", tool: reviewed.name });
  }

  const reviewedNames = new Set(server.tools.map((t) => t.name));
  for (const name of live.keys()) {
    if (!reviewedNames.has(name)) drift.push(named("UNEXPECTED_TOOL", name));
  }

  return drift.length > 0 ? { ok: false, drift } : { ok: true, tools: server.tools.filter((t) => t.enabled) };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

const mediaType = (value: unknown): string =>
  typeof value === "string" && value.length <= 100 && MEDIA_TYPE.test(value) ? value : "application/octet-stream";

/** Decoded size of base64 data, without decoding it. */
const decodedBytes = (data: unknown): number =>
  typeof data === "string"
    ? Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
    : 0;

function normalizeContent(block: unknown): McpContent {
  if (!isRecord(block)) return { type: "unsupported", omitted: true };
  const type = block.type;
  if (type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
  if (type === "image" || type === "audio") {
    return { type, mimeType: mediaType(block.mimeType), bytes: decodedBytes(block.data), omitted: true };
  }
  if (type === "resource" || type === "resource_link") return { type, omitted: true };
  return { type: "unsupported", omitted: true };
}

/**
 * A tools/call result as JARVIS may carry it: text kept, binary and resources
 * described but omitted, structured content passed on as data. A tool-level
 * error is REMOTE_ERROR, without the server's text.
 */
export function normalizeCallResult(result: unknown): McpCallResult {
  if (!isRecord(result) || result.isError === true) return { ok: false, failure: mcpFailure("REMOTE_ERROR") };
  const blocks = result.content ?? [];
  if (!Array.isArray(blocks)) return { ok: false, failure: mcpFailure("REMOTE_ERROR") };
  const content = blocks.map(normalizeContent);
  return isRecord(result.structuredContent)
    ? { ok: true, content, structuredContent: result.structuredContent }
    : { ok: true, content };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A thrown error as a failure code — never its text. Cancellation is decided
 * by the caller from its own signal: the SDK reports an abort and a timeout
 * with the same error code.
 */
export function failureFromError(error: unknown, phase: "connect" | "call"): McpFailure {
  // An operating-system error from spawning or piping: errno codes are strings.
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") {
    return mcpFailure("SERVER_UNAVAILABLE");
  }
  if (phase === "connect") return mcpFailure("INITIALIZATION_FAILED");
  if (error instanceof McpError) {
    switch (error.code) {
      case ErrorCode.ConnectionClosed:
        return mcpFailure("SERVER_UNAVAILABLE");
      case ErrorCode.RequestTimeout:
        return mcpFailure("TIMEOUT");
      case ErrorCode.MethodNotFound:
        return mcpFailure("TOOL_NOT_FOUND");
      case ErrorCode.InvalidParams:
        return mcpFailure("INVALID_ARGUMENTS");
      default:
        return mcpFailure("REMOTE_ERROR");
    }
  }
  // A reply that fails the SDK's own schema. The pinned SDK validates with zod
  // v4, whose error is named `$ZodError` (S8.6 found the bare name never matched).
  if (error instanceof Error && /^\$?ZodError$/.test(error.name)) return mcpFailure("REMOTE_ERROR");
  if (error instanceof Error && error.message === "Not connected") return mcpFailure("SERVER_UNAVAILABLE");
  return mcpFailure("UNKNOWN");
}
