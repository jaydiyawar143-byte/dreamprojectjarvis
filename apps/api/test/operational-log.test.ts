// Phase 13 — the structured operational log line.
//
// One JSON object per line, in the `{ level, event, ... }` shape this API
// already writes, with the three things those lines lacked: a timestamp, the
// service that wrote it, and redaction applied before anything leaves the
// process. A log is the easiest place to leak a credential, so the redaction
// cases below are the point of the file.
import { describe, it, expect } from "vitest";
import { createOperationalLog } from "../src/services/observability/operational-log.js";

const FIXED = new Date("2026-10-06T08:00:00.000Z");

function capture(options: { component?: string; instance?: string } = {}) {
  const lines: string[] = [];
  const log = createOperationalLog({
    service: "jarvis-api",
    ...options,
    write: (line) => lines.push(line),
    now: () => FIXED,
  });
  return { log, lines, last: () => JSON.parse(lines.at(-1)!) as Record<string, unknown> };
}

describe("an operational log line", () => {
  it("is one JSON object carrying when, how serious, who and what", () => {
    const { log, lines, last } = capture();
    log.info("api_started", { port: 3001 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(last()).toEqual({
      timestamp: "2026-10-06T08:00:00.000Z",
      level: "info",
      service: "jarvis-api",
      event: "api_started",
      port: 3001,
    });
  });

  it("names the severity it was written at", () => {
    const { log, lines } = capture();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });

  it("carries the component and the instance it came from", () => {
    const { log, last } = capture({ instance: "api-2" });
    log.child("confirmations").warn("confirmation_refused", { reason: "expired" });

    expect(last()).toMatchObject({
      service: "jarvis-api",
      component: "confirmations",
      instance: "api-2",
      event: "confirmation_refused",
      reason: "expired",
    });
  });

  it("does not let a field overwrite who wrote the line or when", () => {
    const { log, last } = capture({ component: "shutdown" });
    log.info("real_event", {
      timestamp: "1999-01-01T00:00:00.000Z",
      level: "debug",
      service: "someone-else",
      component: "forged",
      event: "forged_event",
    });

    expect(last()).toMatchObject({
      timestamp: "2026-10-06T08:00:00.000Z",
      level: "info",
      service: "jarvis-api",
      component: "shutdown",
      event: "real_event",
    });
  });
});

describe("secrets never reach a log line", () => {
  it("removes a credential stored under a credential's name, at any depth", () => {
    const { log, lines } = capture();
    log.info("request", {
      authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345",
      confirmationToken: "V2hhdGV2ZXJUaGlzVG9rZW5Jc0l0TXVzdE5vdExlYWs",
      nested: { password: "hunter2-hunter2", list: [{ apiKey: "key-123456789" }] },
    });

    const line = lines[0]!;
    for (const secret of [
      "abcdefghijklmnopqrstuvwxyz012345",
      "V2hhdGV2ZXJUaGlzVG9rZW5Jc0l0TXVzdE5vdExlYWs",
      "hunter2-hunter2",
      "key-123456789",
    ]) {
      expect(line, secret).not.toContain(secret);
    }
    expect(line).toContain("[REDACTED]");
  });

  it("removes a credential that arrived under an innocent name", () => {
    const { log, lines } = capture();
    log.error("request_failed", {
      message: "upstream said: invalid key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx",
      stack: "Error: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n    at call (file.ts:1:1)",
      note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart",
    });

    const line = lines[0]!;
    expect(line).not.toContain("sk-proj-AbCdEfGhIjKlMnOpQrStUvWx");
    expect(line).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    // The line is still useful: what failed is still there.
    expect(line).toContain("upstream said");
  });

  it("removes the password from a connection URL in a driver's error text", () => {
    const { log, lines, last } = capture();
    log.error("request_failed", {
      message: "Can't reach postgresql://jarvis_app:S3cr3t-Pa55@db.internal:5432/jarvis?schema=public",
      nested: { url: "amqp://worker:hunter2@queue:5672" },
    });

    expect(lines[0]).not.toContain("S3cr3t-Pa55");
    expect(lines[0]).not.toContain("hunter2");
    expect(lines[0]).not.toContain("jarvis_app");
    // Where it was trying to reach is still there; only who-and-password went.
    expect(last().message).toBe(
      "Can't reach postgresql://[REDACTED]@db.internal:5432/jarvis?schema=public"
    );
  });

  it("removes a key or an authorization code carried in a URL's query string", () => {
    const { log, lines, last } = capture();
    log.error("request_failed", {
      message:
        "GET https://maps.googleapis.com/maps/api/geocode/json?address=Pune&key=FAKE-MAPS-KEY-0123456789 failed",
      stack: "Error: at https://example.test/callback?state=abc&code=FAKE/AUTH-CODE-123&scope=email",
    });

    expect(lines[0]).not.toContain("FAKE-MAPS-KEY-0123456789");
    expect(lines[0]).not.toContain("FAKE/AUTH-CODE-123");
    // What was being asked is still there; only the credential went.
    expect(last().message).toBe(
      "GET https://maps.googleapis.com/maps/api/geocode/json?address=Pune&key=[REDACTED] failed"
    );
  });

  it("does not touch a word that merely ends in `key` or `code`", () => {
    const { log, last } = capture();
    log.info("note", { message: "status code=42, monkey=banana, page?keyword=budget" });
    expect(last().message).toBe("status code=42, monkey=banana, page?keyword=budget");
  });

  it("does not mistake a host and port for a credential", () => {
    const { log, last } = capture();
    log.info("api_started", { url: "http://localhost:3101/api/v1", at: "12:30:00" });
    expect(last()).toMatchObject({ url: "http://localhost:3101/api/v1", at: "12:30:00" });
  });

  it("leaves ordinary operational fields alone", () => {
    const { log, last } = capture();
    log.info("drain_finished", { executionsCompleted: 2, timedOut: false, durationMs: 41 });
    expect(last()).toMatchObject({ executionsCompleted: 2, timedOut: false, durationMs: 41 });
  });
});

describe("logging can never take the process down", () => {
  it("still writes a line when a field cannot be serialised", () => {
    const { log, lines, last } = capture();
    expect(() => log.info("odd_field", { big: 10n })).not.toThrow();

    expect(lines).toHaveLength(1);
    expect(last()).toMatchObject({
      level: "error",
      event: "log_line_unserialisable",
      originalEvent: "odd_field",
    });
  });

  it("survives a circular structure", () => {
    const { log, lines } = capture();
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(() => log.info("circular", { loop })).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it("swallows a sink that throws", () => {
    const log = createOperationalLog({
      service: "jarvis-api",
      write: () => {
        throw new Error("stdout closed");
      },
    });
    expect(() => log.error("anything", { a: 1 })).not.toThrow();
  });
});
