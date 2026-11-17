import { N8nSandboxError, malformedSandboxResponseError } from "./sandbox-error.js";

// ---------------------------------------------------------------------------
// n8n Sandbox Service execution events (NDJSON)
// ---------------------------------------------------------------------------
// The wire format is fixed by the Sandbox Service API:
//
//   {"seq":0,"type":"started","exec_id":"<uuid>"}
//   {"seq":1,"type":"stdout","data":"hello\n"}
//   {"seq":2,"type":"stderr","data":"warning: ..."}
//   {"seq":3,"type":"exit","exit_code":0,"success":true,
//    "execution_time_ms":42,"timed_out":false,"killed":false}
//   {"type":"error","error":"..."}
//
// `error` is terminal exactly like `exit`. A stream that ends without either is
// NOT an empty success: the execution outlives the stream, and the caller must
// treat the result as incomplete.
// ---------------------------------------------------------------------------

export interface N8nSandboxStartedEvent {
  seq: number | null;
  type: "started";
  execId: string;
}

export interface N8nSandboxOutputEvent {
  seq: number | null;
  type: "stdout" | "stderr";
  data: string;
}

export interface N8nSandboxExitEvent {
  seq: number | null;
  type: "exit";
  exitCode: number;
  success: boolean;
  executionTimeMs: number;
  timedOut: boolean;
  killed: boolean;
}

export interface N8nSandboxErrorEvent {
  seq: number | null;
  type: "error";
  error: string;
}

export type N8nSandboxEvent =
  | N8nSandboxStartedEvent
  | N8nSandboxOutputEvent
  | N8nSandboxExitEvent
  | N8nSandboxErrorEvent;

/** A single NDJSON line can carry a chunk of output; bound one line's memory. */
export const N8N_SANDBOX_MAX_NDJSON_LINE_LENGTH = 2 * 1024 * 1024;

// The reason is kept for the caller's own debugging only; the message stays a
// fixed sentence so a malformed body never becomes the text of an error.
function malformed(_reason: string): N8nSandboxError {
  return malformedSandboxResponseError();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sequence(raw: Record<string, unknown>): number | null {
  const value = raw.seq;
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw malformed("invalid seq");
  }
  return value;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parses one complete NDJSON line.
 *
 * Unknown extra fields are ignored; a missing or invalid field that the client
 * needs is a malformed response, not a guessed default. The two terminal events
 * are the only ones whose fields decide whether a command succeeded, so they
 * are validated strictly.
 */
export function parseN8nSandboxEvent(line: string): N8nSandboxEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    throw malformed("not JSON");
  }

  const raw = record(decoded);
  if (!raw) throw malformed("not an object");

  const seq = sequence(raw);
  const type = raw.type;

  if (type === "started") {
    const execId = nonEmptyString(raw.exec_id);
    if (!execId || execId.length > 128) throw malformed("started without exec_id");
    return { seq, type, execId };
  }

  if (type === "stdout" || type === "stderr") {
    if (typeof raw.data !== "string") throw malformed(`${type} without data`);
    return { seq, type, data: raw.data };
  }

  if (type === "exit") {
    if (typeof raw.exit_code !== "number" || !Number.isInteger(raw.exit_code)) {
      throw malformed("exit without exit_code");
    }
    const exitCode = raw.exit_code;
    return {
      seq,
      type,
      exitCode,
      success: typeof raw.success === "boolean" ? raw.success : exitCode === 0,
      executionTimeMs:
        typeof raw.execution_time_ms === "number" && Number.isFinite(raw.execution_time_ms)
          ? raw.execution_time_ms
          : 0,
      timedOut: raw.timed_out === true,
      killed: raw.killed === true,
    };
  }

  if (type === "error") {
    const error = nonEmptyString(raw.error);
    return {
      seq,
      type,
      error: error ?? "The sandbox reported an error",
    };
  }

  throw malformed("unknown event type");
}

export interface N8nSandboxNdjsonDecoder {
  /** Returns complete, non-empty lines. A trailing partial line is buffered. */
  push(chunk: string): string[];
  /** Returns the last line when the stream ended without a final newline. */
  flush(): string[];
}

/**
 * An incremental line decoder.
 *
 * `fetch` delivers text in arbitrary chunks; a JSON object can be split across
 * two of them. This buffers the trailing partial line. A buffer that grows past
 * the line ceiling fails rather than waiting for an unbounded allocation.
 */
export function createN8nSandboxNdjsonDecoder(
  maxLineLength = N8N_SANDBOX_MAX_NDJSON_LINE_LENGTH
): N8nSandboxNdjsonDecoder {
  let buffered = "";

  function take(line: string, lines: string[]): void {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized.trim().length > 0) lines.push(normalized);
  }

  return {
    push(chunk: string): string[] {
      buffered += chunk;
      const lines: string[] = [];

      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        take(buffered.slice(0, newline), lines);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }

      if (buffered.length > maxLineLength) {
        throw new N8nSandboxError(
          "MALFORMED_RESPONSE",
          "The sandbox execution stream contains an over-long line"
        );
      }
      return lines;
    },

    flush(): string[] {
      const lines: string[] = [];
      if (buffered.length > 0) take(buffered, lines);
      buffered = "";
      return lines;
    },
  };
}

/** True when an event ends the execution, and narrows to the terminal types. */
export function isTerminalSandboxEvent(
  event: N8nSandboxEvent
): event is N8nSandboxExitEvent | N8nSandboxErrorEvent {
  return event.type === "exit" || event.type === "error";
}
