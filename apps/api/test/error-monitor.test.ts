// Phase 13 — the error-monitoring boundary.
//
// Application code reports to `ErrorMonitor`. Where a report goes is a sink:
// the local one writes a structured log line, and a hosted service would be
// another sink behind the same interface. Three properties matter more than
// the plumbing, and each has a case below:
//
//   1. nothing secret reaches a sink — it is redacted first;
//   2. a sink that is down, slow or broken never breaks the request that
//      reported to it;
//   3. with no service configured, the local sink still records the error.
import { describe, it, expect, vi } from "vitest";
import {
  createErrorMonitor,
  logMonitorSink,
  noopMonitorSink,
  type MonitorEvent,
  type MonitorSink,
} from "../src/services/observability/error-monitor.js";
import { createOperationalLog } from "../src/services/observability/operational-log.js";

const FIXED = new Date("2026-10-06T08:00:00.000Z");

function recordingSink() {
  const events: MonitorEvent[] = [];
  const sink: MonitorSink = { send: (event) => void events.push(event) };
  return { sink, events };
}

describe("reporting to the monitor", () => {
  it("captures an exception with its name, message, stack and context", () => {
    const { sink, events } = recordingSink();
    const monitor = createErrorMonitor(sink, { now: () => FIXED });

    const error = new TypeError("store is not reachable");
    monitor.captureException(error, {
      context: { component: "confirmations", operation: "consume", traceId: "trace-1" },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "exception",
      severity: "error",
      errorName: "TypeError",
      message: "store is not reachable",
      context: { component: "confirmations", operation: "consume", traceId: "trace-1" },
      timestamp: "2026-10-06T08:00:00.000Z",
    });
    expect(events[0]!.stack).toContain("TypeError: store is not reachable");
  });

  it("captures a message at the severity it was given", () => {
    const { sink, events } = recordingSink();
    const monitor = createErrorMonitor(sink, { now: () => FIXED });

    monitor.captureMessage("shutdown left executions for recovery", {
      severity: "warning",
      context: { leftForRecovery: 2 },
    });

    expect(events[0]).toEqual({
      kind: "message",
      severity: "warning",
      message: "shutdown left executions for recovery",
      context: { leftForRecovery: 2 },
      timestamp: "2026-10-06T08:00:00.000Z",
    });
  });

  it("accepts something that is not an Error", () => {
    const { sink, events } = recordingSink();
    const monitor = createErrorMonitor(sink);

    monitor.captureException("a string was thrown", { severity: "fatal" });
    monitor.captureException({ code: "E_ODD" });

    expect(events[0]).toMatchObject({ kind: "exception", severity: "fatal", message: "a string was thrown" });
    expect(events[1]).toMatchObject({ kind: "exception", severity: "error" });
    expect(events[1]!.message).toContain("E_ODD");
  });
});

describe("nothing secret reaches a sink", () => {
  it("redacts the message, the stack and the context before sending", () => {
    const { sink, events } = recordingSink();
    const monitor = createErrorMonitor(sink);

    const error = new Error("provider refused key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx");
    error.stack = "Error: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n    at x (y.ts:1:1)";
    monitor.captureException(error, {
      context: {
        confirmationToken: "V2hhdGV2ZXJUaGlzVG9rZW5Jc0l0TXVzdE5vdExlYWs",
        request: { headers: { authorization: "Bearer zyxwvutsrqponmlkjihgfedcba987654" } },
        password: "hunter2-hunter2",
      },
    });

    const sent = JSON.stringify(events[0]);
    for (const secret of [
      "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx",
      "abcdefghijklmnopqrstuvwxyz0123456789",
      "V2hhdGV2ZXJUaGlzVG9rZW5Jc0l0TXVzdE5vdExlYWs",
      "zyxwvutsrqponmlkjihgfedcba987654",
      "hunter2-hunter2",
    ]) {
      expect(sent, secret).not.toContain(secret);
    }
    // Still a usable report.
    expect(events[0]!.message).toContain("provider refused key");
  });

  it("redacts a database password out of a driver's error before it leaves", () => {
    const { sink, events } = recordingSink();
    const monitor = createErrorMonitor(sink);

    monitor.captureException(
      new Error("Can't reach postgresql://jarvis_app:S3cr3t-Pa55@db.internal:5432/jarvis"),
      { context: { url: "postgresql://jarvis_app:S3cr3t-Pa55@db.internal:5432/jarvis" } }
    );

    const sent = JSON.stringify(events[0]);
    expect(sent).not.toContain("S3cr3t-Pa55");
    expect(events[0]!.message).toBe("Can't reach postgresql://[REDACTED]@db.internal:5432/jarvis");
  });
});

describe("a broken sink never breaks the caller", () => {
  it("swallows a sink that throws, and says so", () => {
    const onSinkFailure = vi.fn();
    const monitor = createErrorMonitor(
      {
        send: () => {
          throw new Error("monitoring service is down");
        },
      },
      { onSinkFailure }
    );

    expect(() => monitor.captureException(new Error("boom"))).not.toThrow();
    expect(() => monitor.captureMessage("still fine")).not.toThrow();
    expect(onSinkFailure).toHaveBeenCalledTimes(2);
    expect(onSinkFailure).toHaveBeenCalledWith("monitoring service is down");
  });

  it("swallows a sink whose promise rejects", async () => {
    const onSinkFailure = vi.fn();
    const monitor = createErrorMonitor(
      { send: () => Promise.reject(new Error("timeout talking to the service")) },
      { onSinkFailure }
    );

    monitor.captureException(new Error("boom"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(onSinkFailure).toHaveBeenCalledWith("timeout talking to the service");
  });

  it("does not wait for a slow sink", () => {
    let release: () => void = () => undefined;
    const monitor = createErrorMonitor({
      send: () => new Promise<void>((resolve) => (release = resolve)),
    });

    // Returns at once; the pending send is not awaited by the caller.
    expect(monitor.captureException(new Error("boom"))).toBeUndefined();
    release();
  });
});

describe("the sinks that ship", () => {
  it("the local sink writes one structured line per report, at a matching level", () => {
    const lines: string[] = [];
    const log = createOperationalLog({
      service: "jarvis-api",
      write: (line) => lines.push(line),
      now: () => FIXED,
    });
    const monitor = createErrorMonitor(logMonitorSink(log), { now: () => FIXED });

    monitor.captureException(new Error("boom"), { context: { traceId: "trace-9" } });
    monitor.captureMessage("heads up", { severity: "warning" });
    monitor.captureMessage("for the record", { severity: "info" });
    monitor.captureException(new Error("fatal one"), { severity: "fatal" });

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.map((line) => [line.level, line.event, line.severity])).toEqual([
      ["error", "monitor_exception", "error"],
      ["warn", "monitor_message", "warning"],
      ["info", "monitor_message", "info"],
      ["error", "monitor_exception", "fatal"],
    ]);
    expect(parsed[0]).toMatchObject({ component: "monitor", message: "boom", errorName: "Error", traceId: "trace-9" });
    expect(String(parsed[0]!.stack)).toContain("Error: boom");
  });

  it("the local sink attributes the line to the component that reported", () => {
    const lines: string[] = [];
    const log = createOperationalLog({ service: "jarvis-api", write: (line) => lines.push(line) });
    const monitor = createErrorMonitor(logMonitorSink(log));

    monitor.captureException(new Error("store down"), {
      context: { component: "confirmations", operation: "issue" },
    });

    expect(JSON.parse(lines[0]!)).toMatchObject({
      component: "confirmations",
      operation: "issue",
      event: "monitor_exception",
    });
  });

  it("the no-op sink accepts everything and does nothing", () => {
    const monitor = createErrorMonitor(noopMonitorSink);
    expect(() => {
      monitor.captureException(new Error("boom"));
      monitor.captureMessage("hello");
    }).not.toThrow();
  });
});
