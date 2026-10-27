// ---------------------------------------------------------------------------
// Sprint 9.8 — secrets must not reach the audit TABLE.
//
// Before this sprint, `AuditLogger.log` called `repository.create(entry)` on
// the raw entry and only redacted the console projection afterwards. Anything
// sensitive in `parameters` was therefore written verbatim into a long-lived,
// widely-readable, exportable table.
//
// These tests assert on what the REPOSITORY received, because that is the copy
// that persists.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { AuditEntry, IAuditRepository } from "@jarvis/core";

import { AuditLogger, redactAuditParams } from "../src/audit.js";

class RecordingRepository implements IAuditRepository {
  readonly created: Array<Omit<AuditEntry, "id" | "timestamp">> = [];

  async create(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry> {
    this.created.push(entry);
    return { ...entry, id: `audit-${this.created.length}`, timestamp: new Date() };
  }
  async query(): Promise<AuditEntry[]> {
    return [];
  }
}

let repository: RecordingRepository;
let logger: AuditLogger;

beforeEach(() => {
  repository = new RecordingRepository();
  logger = new AuditLogger(repository);
  // The logger writes a structured line; keep the test output readable.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const base = {
  userId: "user-1",
  action: "tool.execute",
  result: "success" as const,
};

/** Everything the repository was handed, as one searchable string. */
const persisted = () => JSON.stringify(repository.created);

describe("Sprint 9.8 — redaction happens before persistence", () => {
  it.each([
    ["access_token", "access_token"],
    ["accessToken", "accessToken"],
    ["refresh_token", "refresh_token"],
    ["password", "password"],
    ["apiKey", "apiKey"],
    ["client_secret", "client_secret"],
    ["authorization", "authorization"],
    ["cookie", "cookie"],
    ["code_verifier", "code_verifier"],
  ])("REDACTS a top-level %s before the row is written", async (_label, key) => {
    await logger.log({ ...base, parameters: { [key]: "super-secret-value" } });

    expect(repository.created).toHaveLength(1);
    expect(persisted()).not.toContain("super-secret-value");
    expect(repository.created[0]!.parameters).toEqual({ [key]: "[REDACTED]" });
  });

  it("REDACTS a secret nested inside an object", async () => {
    // The old implementation only looked at the top level, so anything one
    // level down was persisted in full.
    await logger.log({
      ...base,
      parameters: {
        request: { headers: { authorization: "Bearer super-secret-value" } },
      },
    });

    expect(persisted()).not.toContain("super-secret-value");
  });

  it("REDACTS a secret nested inside an array", async () => {
    await logger.log({
      ...base,
      parameters: { steps: [{ ok: true }, { password: "super-secret-value" }] },
    });

    expect(persisted()).not.toContain("super-secret-value");
  });

  it("REDACTS metadata as well as parameters", async () => {
    await logger.log({
      ...base,
      metadata: { executionId: "exec-1", token: "super-secret-value" },
    });

    expect(persisted()).not.toContain("super-secret-value");
    expect((repository.created[0]!.metadata as Record<string, unknown>).executionId).toBe(
      "exec-1"
    );
  });
});

describe("Sprint 9.8 — value-shaped secrets under innocent key names", () => {
  it.each([
    ["an OpenAI key", "sk-abcdefghijklmnopqrstuvwxyz012345"],
    ["a bearer header", "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def"],
    ["a JWT", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig"],
  ])("REDACTS %s even when the field is called 'note'", async (_label, secret) => {
    await logger.log({ ...base, parameters: { note: secret } });

    const written = JSON.stringify(repository.created[0]!.parameters);
    expect(written).not.toContain(secret);
  });
});

describe("Sprint 9.8 — redaction does not destroy the audit trail", () => {
  it("keeps the fields an investigator actually needs", async () => {
    await logger.log({
      ...base,
      toolId: "meta.campaign.pause",
      traceId: "trace-9",
      parameters: { accountId: "act_12345", campaignId: "c-1", token: "secret" },
    });

    const row = repository.created[0]!;
    expect(row.userId).toBe("user-1");
    expect(row.toolId).toBe("meta.campaign.pause");
    expect(row.traceId).toBe("trace-9");
    expect(row.action).toBe("tool.execute");
    expect(row.result).toBe("success");

    const params = row.parameters as Record<string, unknown>;
    expect(params.accountId).toBe("act_12345");
    expect(params.campaignId).toBe("c-1");
    expect(params.token).toBe("[REDACTED]");
  });

  it("leaves an entry with no parameters untouched", async () => {
    await logger.log({ ...base });
    expect(repository.created[0]!.parameters).toBeUndefined();
  });
});

describe("Sprint 9.8 — the redactor itself", () => {
  it("is pure and does not mutate its input", () => {
    const input = { password: "secret", nested: { token: "secret" } };
    const output = redactAuditParams(input);

    expect(input.password).toBe("secret");
    expect(input.nested.token).toBe("secret");
    expect(output.password).toBe("[REDACTED]");
  });

  it("terminates on a deeply nested structure", () => {
    let deep: Record<string, unknown> = { password: "secret" };
    for (let i = 0; i < 50; i++) deep = { level: deep };

    expect(() => redactAuditParams(deep)).not.toThrow();
  });

  it("preserves primitives it has no reason to touch", () => {
    const output = redactAuditParams({ count: 42, ok: true, missing: null });
    expect(output).toEqual({ count: 42, ok: true, missing: null });
  });

  // Phase 13 — a write-confirmation token is a credential for one external
  // action. It has no recognisable shape, so only its name can catch it.
  it("removes a write-confirmation token by its name", () => {
    const token = "V2hhdGV2ZXJUaGlzVG9rZW5Jc0l0TXVzdE5vdExlYWs";
    const output = redactAuditParams({ body: { confirmationToken: token } });

    expect(JSON.stringify(output)).not.toContain(token);
    expect(output).toEqual({ body: { confirmationToken: "[REDACTED]" } });
  });
});

// ---------------------------------------------------------------------------
// Phase 19.1 (audit C2) — browser free text has no secret SHAPE. A typed
// password, a card number, a submitted field value and a cookie all look like
// ordinary strings, so key/shape redaction alone wrote them into the trail.
// The real path is asserted here: AuditLogger.log, the copy the repository
// receives, and the console line derived from it.
// ---------------------------------------------------------------------------
describe("Phase 19.1 — a browser action is audited as an allowlisted projection", () => {
  const typed = "hunter2-typed-into-a-page";
  const card = "4111111111111111";

  it("keeps no typed text or submitted field value in the durable row", async () => {
    await logger.log({
      ...base,
      toolId: "browser.type",
      parameters: {
        url: "https://example.com/login?token=abc",
        selector: 'input[name="password"]',
        text: typed,
      },
    });

    const row = repository.created[0]!;
    expect(persisted()).not.toContain(typed);
    expect(persisted()).not.toContain("example.com/login");
    expect(row.parameters).toMatchObject({ action: "browser.type" });
    expect((row.parameters as Record<string, unknown>).text).toBeUndefined();
    expect((row.parameters as Record<string, unknown>).url).toBeUndefined();
  });

  it("keeps no nested submitted values, cookie or header", async () => {
    await logger.log({
      ...base,
      toolId: "browser.submit",
      parameters: {
        url: "https://example.com/checkout",
        selector: "#pay",
        fields: { "#card": card, "#name": typed },
        cookies: [{ name: "session", value: "cookie-value" }],
        headers: { authorization: "Bearer header-value" },
      },
    });

    expect(persisted()).not.toContain(card);
    expect(persisted()).not.toContain(typed);
    expect(persisted()).not.toContain("cookie-value");
    expect(persisted()).not.toContain("header-value");
  });

  it("records an invalid browser request as refused, never its payload", async () => {
    await logger.log({
      ...base,
      toolId: "browser.type",
      parameters: { url: "not-a-url", text: typed },
    });

    const row = repository.created[0]!;
    expect(persisted()).not.toContain(typed);
    expect(row.parameters).toMatchObject({ action: "browser.type", refused: true });
    expect((row.parameters as Record<string, unknown>).reason).toEqual(expect.any(String));
  });

  it("writes the same projection to the console line", async () => {
    await logger.log({
      ...base,
      toolId: "browser.type",
      parameters: { url: "https://example.com/", selector: "#q", text: typed },
    });

    const calls = vi.mocked(console.log).mock.calls;
    const line = String(calls[calls.length - 1]?.[0] ?? "");
    expect(line).toContain("browser.type");
    expect(line).not.toContain(typed);
  });
});
