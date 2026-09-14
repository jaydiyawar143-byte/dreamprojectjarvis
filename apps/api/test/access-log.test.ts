import { describe, it, expect } from "vitest";
import { redactUrlForLog } from "../src/middleware/access-log.js";

describe("redactUrlForLog", () => {
  it("removes the OAuth code and state from a callback URL", () => {
    expect(
      redactUrlForLog("/api/v1/google/callback?code=4/0AbCdEf&state=s3cr3t&scope=email")
    ).toBe("/api/v1/google/callback?code=REDACTED&state=REDACTED&scope=email");
  });

  it("removes the WhatsApp verify token but keeps the challenge", () => {
    expect(
      redactUrlForLog(
        "/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=123"
      )
    ).toBe(
      "/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=REDACTED&hub.challenge=123"
    );
  });

  it("matches keys case-insensitively and when percent-encoded", () => {
    expect(redactUrlForLog("/x?Access_Token=t&%63ode=c")).toBe(
      "/x?Access_Token=REDACTED&%63ode=REDACTED"
    );
  });

  it("leaves URLs without sensitive keys untouched", () => {
    expect(redactUrlForLog("/api/v1/approvals?status=pending&limit=20")).toBe(
      "/api/v1/approvals?status=pending&limit=20"
    );
    expect(redactUrlForLog("/api/v1/health")).toBe("/api/v1/health");
  });

  it("redacts inside an absolute referrer URL", () => {
    expect(redactUrlForLog("http://localhost:3000/auth/google?code=abc")).toBe(
      "http://localhost:3000/auth/google?code=REDACTED"
    );
  });

  it("prints a dash when there is no value", () => {
    expect(redactUrlForLog(undefined)).toBe("-");
  });
});
