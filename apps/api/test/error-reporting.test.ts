// Phase 13 — where an unexpected error is reported from.
//
// Three places in the API meet an error nobody planned for: the HTTP error
// handler, the process-level handlers, and shutdown. Each already logged it.
// Each now also tells the monitor, and writes its line through the operational
// log — which is what puts a timestamp on it and takes the secrets out.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JarvisError, ShutdownLifecycle } from "@jarvis/core";
import { errorHandler, installProcessErrorHandlers } from "../src/middleware/error-handler.js";
import {
  createErrorMonitor,
  type MonitorEvent,
} from "../src/services/observability/error-monitor.js";
import { createShutdownController } from "../src/shutdown.js";

function recordingMonitor() {
  const events: MonitorEvent[] = [];
  return { events, monitor: createErrorMonitor({ send: (event) => void events.push(event) }) };
}

function fakeReq(overrides: Record<string, unknown> = {}) {
  return { traceId: "trace-13", method: "POST", path: "/api/v1/chat", ...overrides };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the HTTP error handler reports what it could not handle", () => {
  const silent = () => undefined;

  it("tells the monitor about an unexpected failure, with the request it came from", () => {
    const { events, monitor } = recordingMonitor();
    const res = fakeRes();

    errorHandler({ log: silent, monitor })(
      new TypeError("cannot read properties of undefined"),
      fakeReq() as never,
      res as never,
      vi.fn()
    );

    expect(res.statusCode).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "exception",
      severity: "error",
      errorName: "TypeError",
      context: {
        component: "http",
        traceId: "trace-13",
        method: "POST",
        path: "/api/v1/chat",
        status: 500,
        code: "INTERNAL_ERROR",
      },
    });
  });

  it("tells the monitor about a known failure that is still the server's fault", () => {
    const { events, monitor } = recordingMonitor();
    errorHandler({ log: silent, monitor })(
      new JarvisError("AI_PROVIDER_UNAVAILABLE", "No provider is usable"),
      fakeReq() as never,
      fakeRes() as never,
      vi.fn()
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.context).toMatchObject({ status: 503, code: "AI_PROVIDER_UNAVAILABLE" });
  });

  it("does not tell the monitor about a request the caller got wrong", () => {
    const { events, monitor } = recordingMonitor();
    errorHandler({ log: silent, monitor })(
      new JarvisError("INVALID_REQUEST", "message is required"),
      fakeReq() as never,
      fakeRes() as never,
      vi.fn()
    );
    expect(events).toHaveLength(0);
  });

  it("never sends the monitor a secret from the error", () => {
    const { events, monitor } = recordingMonitor();
    errorHandler({ log: silent, monitor })(
      new Error("Can't reach postgresql://jarvis_app:S3cr3t-Pa55@db.internal:5432/jarvis"),
      fakeReq() as never,
      fakeRes() as never,
      vi.fn()
    );
    expect(JSON.stringify(events)).not.toContain("S3cr3t-Pa55");
  });

  it("by default writes a structured, redacted line — not the raw error", () => {
    const written: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void written.push(String(line)));

    errorHandler()(
      new Error("Can't reach postgresql://jarvis_app:S3cr3t-Pa55@db.internal:5432/jarvis"),
      fakeReq() as never,
      fakeRes() as never,
      vi.fn()
    );

    const failed = written
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === "request_failed");
    expect(failed).toMatchObject({
      level: "error",
      service: "jarvis-api",
      component: "http",
      traceId: "trace-13",
      status: 500,
      code: "INTERNAL_ERROR",
    });
    expect(typeof failed!.timestamp).toBe("string");
    expect(written.join("\n")).not.toContain("S3cr3t-Pa55");
  });
});

describe("the process-level handlers report what escaped everything else", () => {
  function install() {
    const target = new EventEmitter();
    const lines: Record<string, unknown>[] = [];
    const { events, monitor } = recordingMonitor();
    installProcessErrorHandlers({
      log: (line) => lines.push(line),
      monitor,
      target: target as unknown as NodeJS.Process,
    });
    return { target, lines, events };
  }

  it("logs and reports an unhandled rejection", () => {
    const { target, lines, events } = install();
    target.emit("unhandledRejection", new Error("promise nobody awaited"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "error", event: "unhandled_rejection" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      severity: "fatal",
      message: "promise nobody awaited",
      context: { component: "process", origin: "unhandled_rejection" },
    });
  });

  it("logs and reports an uncaught exception", () => {
    const { target, lines, events } = install();
    target.emit("uncaughtException", new RangeError("stack blew up"));

    expect(lines[0]).toMatchObject({ level: "error", event: "uncaught_exception" });
    expect(events[0]).toMatchObject({
      severity: "fatal",
      errorName: "RangeError",
      context: { component: "process", origin: "uncaught_exception" },
    });
  });

  it("does not end the process — only shutdown does that", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { target } = install();
    target.emit("unhandledRejection", "a rejected string");
    target.emit("uncaughtException", new Error("x"));
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("shutdown reports a failed release", () => {
  it("tells the caller's hook when the database could not be disconnected", async () => {
    const failures: Array<{ stage: string; message: string }> = [];
    const controller = createShutdownController({
      lifecycle: new ShutdownLifecycle(),
      disconnectDatabase: async () => {
        throw new Error("connection already closed");
      },
      graceMs: 50,
      log: () => undefined,
      onError: (error, stage) =>
        failures.push({ stage, message: error instanceof Error ? error.message : String(error) }),
    });

    await controller.beginShutdown("SIGTERM");

    expect(failures).toEqual([{ stage: "release_resources", message: "connection already closed" }]);
  });

  it("is not derailed by a hook that throws", async () => {
    const lifecycle = new ShutdownLifecycle();
    const controller = createShutdownController({
      lifecycle,
      disconnectDatabase: async () => {
        throw new Error("connection already closed");
      },
      graceMs: 50,
      log: () => undefined,
      onError: () => {
        throw new Error("the monitor is down too");
      },
    });

    await expect(controller.beginShutdown("SIGTERM")).resolves.toBeUndefined();
    expect(lifecycle.getState()).toBe("STOPPED");
  });
});
