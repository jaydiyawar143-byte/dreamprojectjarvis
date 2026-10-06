// ---------------------------------------------------------------------------
// Phase 13 — the error-monitoring boundary.
//
// Application code reports here and nowhere else:
//
//     monitor.captureException(error, { context: { component, traceId } })
//
// WHERE a report goes is a sink. Two ship: `logMonitorSink`, which writes a
// structured log line and needs no service, account or network, and
// `noopMonitorSink`. A hosted error tracker is a third sink behind the same
// interface, added at the composition root — nothing that reports would change,
// and no vendor is named in this repository.
//
// THREE RULES, enforced here so that no sink has to remember them:
//
//   REDACTED FIRST. The event a sink receives has already been through the
//   audit system's redactor, by key name and by value shape, and has had the
//   credentials stripped from any connection URL. A sink — which may be a third
//   party — never sees a token, a password or a header.
//
//   NEVER THROWS, NEVER WAITS. A sink that is down, slow or broken cannot fail
//   or delay the request that reported to it. A rejected or pending send is not
//   awaited.
//
//   NOT A DEPENDENCY. Nothing reads from a sink, and the application behaves
//   identically with the no-op one.
// ---------------------------------------------------------------------------

import { redactOperationalRecord, type OperationalLog } from "./operational-log.js";

export type MonitorSeverity = "info" | "warning" | "error" | "fatal";

/** What a sink is given. Already redacted. */
export interface MonitorEvent {
  kind: "exception" | "message";
  severity: MonitorSeverity;
  message: string;
  errorName?: string;
  stack?: string;
  /** Caller-supplied metadata: component, operation, trace id. Never a payload. */
  context: Record<string, unknown>;
  timestamp: string;
}

export interface MonitorSink {
  send(event: MonitorEvent): void | Promise<void>;
}

export interface CaptureOptions {
  severity?: MonitorSeverity;
  context?: Record<string, unknown>;
}

export interface ErrorMonitor {
  captureException(error: unknown, options?: CaptureOptions): void;
  captureMessage(message: string, options?: CaptureOptions): void;
}

export interface ErrorMonitorOptions {
  now?: () => Date;
  /** Told when a sink failed, with the reason. Must not throw. */
  onSinkFailure?: (reason: string) => void;
}

function describeThrown(error: unknown): Pick<MonitorEvent, "message" | "errorName" | "stack"> {
  if (error instanceof Error) {
    return {
      message: error.message,
      errorName: error.name,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

export function createErrorMonitor(
  sink: MonitorSink,
  options: ErrorMonitorOptions = {}
): ErrorMonitor {
  const now = options.now ?? (() => new Date());

  const sinkFailed = (error: unknown): void => {
    try {
      options.onSinkFailure?.(error instanceof Error ? error.message : String(error));
    } catch {
      // The failure reporter failed too. There is nothing further to tell.
    }
  };

  const deliver = (event: MonitorEvent): void => {
    try {
      const safe = redactOperationalRecord(event as unknown as Record<string, unknown>);
      const sent = sink.send(safe as unknown as MonitorEvent);
      // Deliberately not awaited: a slow sink must not hold the caller.
      if (sent && typeof (sent as Promise<void>).then === "function") {
        (sent as Promise<void>).then(undefined, sinkFailed);
      }
    } catch (error) {
      sinkFailed(error);
    }
  };

  return {
    captureException(error, capture = {}) {
      deliver({
        kind: "exception",
        severity: capture.severity ?? "error",
        ...describeThrown(error),
        context: capture.context ?? {},
        timestamp: now().toISOString(),
      });
    },
    captureMessage(message, capture = {}) {
      deliver({
        kind: "message",
        severity: capture.severity ?? "info",
        message,
        context: capture.context ?? {},
        timestamp: now().toISOString(),
      });
    },
  };
}

/**
 * The local sink: one structured log line per report.
 *
 * This is what runs when no monitoring service is configured, and it is enough
 * to alert on — any log-based monitor can match `monitor_exception`.
 */
export function logMonitorSink(log: OperationalLog): MonitorSink {
  return {
    send(event) {
      const level =
        event.severity === "info" ? "info" : event.severity === "warning" ? "warn" : "error";
      // The line is attributed to whoever reported, when they said who they are.
      const component =
        typeof event.context.component === "string" ? event.context.component : "monitor";

      log.child(component)[level](
        event.kind === "exception" ? "monitor_exception" : "monitor_message",
        {
          ...event.context,
          severity: event.severity,
          message: event.message,
          ...(event.errorName ? { errorName: event.errorName } : {}),
          ...(event.stack ? { stack: event.stack } : {}),
        }
      );
    },
  };
}

/** For a deployment, or a test, that wants reports to go nowhere. */
export const noopMonitorSink: MonitorSink = { send: () => undefined };
