// ---------------------------------------------------------------------------
// Phase 13 — the structured operational log line.
//
// This API already writes one JSON object per line, `{ level, event, ... }`.
// This is that same line with the three things it lacked: WHEN it was written,
// WHICH service and component wrote it, and redaction applied before anything
// leaves the process. It is not a logging framework: no transports, no levels
// to configure, no context magic. Existing lines keep working; the places that
// matter operationally — startup, shutdown, a failed request, a confirmation —
// write through this one.
//
// REDACTION IS THE AUDIT SYSTEM'S, not a second rule. `redactAuditParams`
// removes a credential by key name and by value shape at any depth, and it is
// already pinned by tests. A log is the easiest place to leak a secret, so the
// same rule guards both.
//
// IT NEVER THROWS. A log call sits inside error handlers and shutdown code; a
// field that cannot be serialised, or a closed stdout, must not turn a
// reported problem into a second, unreported one.
// ---------------------------------------------------------------------------

import { redactAuditParams } from "@jarvis/security";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface OperationalLog {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** The same sink, with every line stamped with this component. */
  child(component: string): OperationalLog;
}

export interface OperationalLogOptions {
  /** Which deployable wrote the line, e.g. `jarvis-api`. */
  service: string;
  component?: string;
  /** Which instance, when more than one runs. Usually the hostname. */
  instance?: string;
  /** Where a finished line goes. Standard output unless overridden. */
  write?: (line: string) => void;
  now?: () => Date;
}

/** What a caller's field may not overwrite: who wrote the line, and when. */
const RESERVED = new Set(["timestamp", "level", "service", "component", "instance", "event"]);

/**
 * `scheme://user:password@host` — the userinfo part of a URL.
 *
 * The audit redactor matches tokens by shape and credentials by key name; a
 * password inside a connection string is neither, and a database driver's
 * error text is the commonest way one reaches a log. Kept here rather than
 * added to the shared `redactSecrets`, which also sanitises tool output and
 * memory candidates and should not change behaviour for them.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"\\]+:[^\s/@"\\]+@/gi;

/**
 * `?key=…`, `&code=…`, `&client_secret=…` — a credential as a URL parameter.
 *
 * The Google Maps provider sends its server key as `key=`, and an OAuth
 * callback carries its one-time `code=`. Neither has a shape the audit redactor
 * knows. Only directly after `?` or `&`, so "status code=42" is left alone.
 */
const QUERY_CREDENTIALS = /([?&](?:key|code|client_secret)=)[^&\s"\\]+/gi;

/**
 * Everything that leaves the process for an operator or a monitor goes
 * through this: the audit redactor, then the credentials a URL can carry.
 *
 * Works on the serialised form, so it reaches a string at any depth. Throws on
 * a value JSON cannot represent; both callers treat that as "send nothing".
 */
export function redactOperationalRecord(record: Record<string, unknown>): Record<string, unknown> {
  const serialised = JSON.stringify(redactAuditParams(record))
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(QUERY_CREDENTIALS, "$1[REDACTED]");
  return JSON.parse(serialised) as Record<string, unknown>;
}

export function createOperationalLog(options: OperationalLogOptions): OperationalLog {
  const write = options.write ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    const head: Record<string, unknown> = {
      timestamp: now().toISOString(),
      level,
      service: options.service,
      ...(options.component ? { component: options.component } : {}),
      ...(options.instance ? { instance: options.instance } : {}),
      event,
    };

    let line: string;
    try {
      const safe = redactOperationalRecord(fields ?? {});
      for (const key of RESERVED) delete safe[key];
      line = JSON.stringify({ ...head, ...safe });
    } catch {
      // A BigInt, a getter that throws. Say that a line was lost, and which.
      line = JSON.stringify({
        ...head,
        level: "error",
        event: "log_line_unserialisable",
        originalEvent: event,
      });
    }

    try {
      write(line);
    } catch {
      // Nowhere left to report it.
    }
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (component) => createOperationalLog({ ...options, component }),
  };
}

/**
 * Writes a `{ level, event, ...fields }` record through the log.
 *
 * That record is the shape this API's injectable loggers already take, so a
 * component that builds one can be pointed here without changing what it
 * builds.
 */
export function writeRecord(log: OperationalLog, record: Record<string, unknown>): void {
  const { level, event, ...fields } = record;
  const method = level === "debug" || level === "warn" || level === "error" ? level : "info";
  log[method](typeof event === "string" ? event : "unnamed_event", fields);
}
