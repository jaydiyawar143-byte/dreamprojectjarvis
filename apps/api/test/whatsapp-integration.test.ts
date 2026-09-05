import { describe, it, expect, vi } from "vitest";
import type { Router } from "express";
import {
  createWhatsAppConfig,
  signPayload,
  type WhatsAppConfig,
} from "@jarvis/whatsapp";
import {
  WhatsAppSendMessageTool,
  MockWhatsAppProvider,
} from "@jarvis/tools";
import { ToolApprovalService, PermissionService } from "@jarvis/security";
import type {
  IWhatsAppRepository,
  WhatsAppInboundMessage,
  WhatsAppMessageRecord,
  WhatsAppStatusUpdate,
  RecordInboundResult,
  ITool,
} from "@jarvis/core";
import { createWhatsAppRouter } from "../src/routes/whatsapp.js";

// ---------------------------------------------------------------------------
// Sprint 5.3 — WhatsApp webhook API tests
//
// No real WhatsApp credentials, no network, no database. Signatures are
// computed with a synthetic app secret, so these run identically anywhere.
// ---------------------------------------------------------------------------

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";
const PHONE_NUMBER_ID = "109876543210";
const TOKEN_A = "token-user-1";
const TOKEN_B = "token-user-2";

const config: WhatsAppConfig = createWhatsAppConfig({
  phoneNumberId: PHONE_NUMBER_ID,
  accessToken: "EAAtest",
  appSecret: APP_SECRET,
  verifyToken: VERIFY_TOKEN,
  maxEventAgeMs: 300_000,
});

// A fixed "now" keeps the freshness window deterministic.
const NOW = new Date("2026-09-05T12:00:00Z");
const FRESH_TS = String(Math.floor(NOW.getTime() / 1000) - 30);
const STALE_TS = String(Math.floor(NOW.getTime() / 1000) - 3600);

// ---------------------------------------------------------------------------
// In-memory repository enforcing the same constraints as the Prisma one
// ---------------------------------------------------------------------------

class MemoryWhatsAppRepo implements IWhatsAppRepository {
  claims = new Map<string, string>([[PHONE_NUMBER_ID, "user-1"]]);
  rows: WhatsAppMessageRecord[] = [];
  private seq = 0;

  async findUserForPhoneNumber(phoneNumberId: string): Promise<string | null> {
    return this.claims.get(phoneNumberId) ?? null;
  }

  async recordInbound(input: {
    userId: string;
    message: WhatsAppInboundMessage;
  }): Promise<RecordInboundResult> {
    // Mirrors the unique constraint on provider_message_id.
    if (this.rows.some((r) => r.providerMessageId === input.message.providerMessageId)) {
      return { recorded: false, duplicate: true, messageId: null };
    }
    const row: WhatsAppMessageRecord = {
      id: `row-${++this.seq}`,
      userId: input.userId,
      providerMessageId: input.message.providerMessageId,
      waId: input.message.from,
      phoneNumberId: input.message.phoneNumberId,
      direction: "INBOUND",
      type: input.message.type,
      body: input.message.body,
      status: null,
      providerTimestamp: input.message.timestamp,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return { recorded: true, duplicate: false, messageId: row.id };
  }

  async recordOutbound(input: {
    userId: string;
    providerMessageId: string;
    waId: string;
    phoneNumberId: string;
    body: string;
  }): Promise<WhatsAppMessageRecord> {
    const row: WhatsAppMessageRecord = {
      id: `row-${++this.seq}`,
      ...input,
      direction: "OUTBOUND",
      type: "TEXT",
      status: "sent",
      providerTimestamp: new Date(),
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async applyStatus(update: WhatsAppStatusUpdate): Promise<boolean> {
    const row = this.rows.find((r) => r.providerMessageId === update.providerMessageId);
    if (!row) return false;
    row.status = update.status;
    return true;
  }

  async listForUser(
    userId: string,
    options?: { waId?: string; limit?: number }
  ): Promise<WhatsAppMessageRecord[]> {
    return this.rows
      .filter((r) => r.userId === userId && (!options?.waId || r.waId === options.waId))
      .slice(0, options?.limit ?? 50);
  }
}

// ---------------------------------------------------------------------------
// Router harness — mirrors dashboard-api.test.ts, no supertest dependency
// ---------------------------------------------------------------------------

interface TestResponse {
  status: number;
  body: any;
}

async function call(
  router: Router,
  method: string,
  path: string,
  options: { token?: string; rawBody?: Buffer; signature?: string } = {}
): Promise<TestResponse> {
  const parsed = new URL(path, "http://test");
  const pathname = parsed.pathname;

  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.signature) headers["x-hub-signature-256"] = options.signature;

  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) { this._status = code; return this; },
    json(body: unknown) { this._body = body; return this; },
    type() { return this; },
    send(body: unknown) { this._body = body; return this; },
  };

  const stack =
    ((router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (...args: any[]) => unknown }>;
        };
      }>;
    }).stack) ?? [];

  for (const layer of stack) {
    if (!layer.route) continue;
    if (!layer.route.methods[method.toLowerCase()]) continue;
    if (!pathname.match(new RegExp("^" + layer.route.path.replace(/:[^/]+/g, "([^/]+)") + "$"))) {
      continue;
    }

    const req = {
      method,
      url: pathname + parsed.search,
      originalUrl: pathname + parsed.search,
      path: pathname,
      params: {},
      query: Object.fromEntries(parsed.searchParams),
      headers,
      // The route reads req.body as a raw Buffer; express.raw() would have
      // placed it there. Supplying it directly keeps the harness dependency-free
      // while preserving the byte-exactness the signature check depends on.
      body: options.rawBody,
      get(header: string) { return headers[header.toLowerCase()]; },
    };

    const chain = layer.route.stack;
    const responded = () => (res as unknown as { _body: unknown })._body !== null;
    const runAt = (i: number): unknown => {
      if (responded()) return undefined;
      const entry = chain[i];
      if (!entry) return undefined;
      // Skip the express.raw() layer: the harness already supplied req.body.
      if (entry.handle.length >= 3) {
        const isBodyParser = entry.handle.name === "jsonParser" || entry.handle.name === "rawParser";
        if (isBodyParser) return runAt(i + 1);
        return new Promise<void>((resolveStep) => {
          entry.handle(req, res, () => resolveStep());
          if (responded()) resolveStep();
        }).then(() => runAt(i + 1));
      }
      return entry.handle(req, res);
    };

    await runAt(0);
    return {
      status: (res as unknown as { _status: number })._status,
      body: (res as unknown as { _body: unknown })._body,
    };
  }
  return { status: 404, body: { success: false, error: { code: "NO_ROUTE" } } };
}

function makeHarness() {
  const repo = new MemoryWhatsAppRepo();
  const tokenService = {
    verifyAccessToken: (token: string) => {
      if (token === TOKEN_A) return { userId: "user-1", role: "member", email: "a@test.local" };
      if (token === TOKEN_B) return { userId: "user-2", role: "member", email: "b@test.local" };
      return null;
    },
  };
  const router = createWhatsAppRouter({ tokenService } as never, {
    repo,
    config,
    now: () => NOW,
  });
  return { router, repo };
}

/** Builds a signed inbound webhook POST. */
function inboundPayload(opts: {
  messageId?: string;
  timestamp?: string;
  phoneNumberId?: string;
  text?: string;
} = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: opts.phoneNumberId ?? PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Alice" }, wa_id: "15550101234" }],
              messages: [
                {
                  from: "15550101234",
                  id: opts.messageId ?? "wamid.IN1",
                  timestamp: opts.timestamp ?? FRESH_TS,
                  type: "text",
                  text: { body: opts.text ?? "Hello JARVIS" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function signed(payload: unknown, secret = APP_SECRET) {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return { rawBody, signature: signPayload(rawBody, secret) };
}

describe("Sprint 5.3 — GET /webhook verification", () => {
  it("echoes the challenge for the correct verify token", async () => {
    const h = makeHarness();
    const res = await call(
      h.router,
      "GET",
      `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe("1158201444");
  });

  it("REJECTS a wrong verify token with an opaque 403", async () => {
    const h = makeHarness();
    const res = await call(
      h.router,
      "GET",
      "/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1158201444"
    );
    expect(res.status).toBe(403);
    // The challenge must not be echoed to an unverified caller.
    expect(JSON.stringify(res.body)).not.toContain("1158201444");
  });

  it("rejects a missing token", async () => {
    const h = makeHarness();
    expect((await call(h.router, "GET", "/webhook?hub.mode=subscribe")).status).toBe(403);
  });

  it("never leaks the expected token in the response", async () => {
    const h = makeHarness();
    const res = await call(h.router, "GET", "/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y");
    expect(JSON.stringify(res.body)).not.toContain(VERIFY_TOKEN);
  });
});

describe("Sprint 5.3 — POST /webhook inbound", () => {
  it("accepts and records a valid signed message", async () => {
    const h = makeHarness();
    const { rawBody, signature } = signed(inboundPayload());

    const res = await call(h.router, "POST", "/webhook", { rawBody, signature });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ processed: 1, duplicates: 0, skipped: 0 });
    expect(h.repo.rows).toHaveLength(1);
    expect(h.repo.rows[0]).toMatchObject({
      userId: "user-1",
      providerMessageId: "wamid.IN1",
      direction: "INBOUND",
      body: "Hello JARVIS",
    });
  });

  describe("signature enforcement", () => {
    it("REJECTS a payload signed with the wrong secret", async () => {
      const h = makeHarness();
      const { rawBody, signature } = signed(inboundPayload(), "attacker-secret");

      const res = await call(h.router, "POST", "/webhook", { rawBody, signature });

      expect(res.status).toBe(401);
      expect(h.repo.rows).toHaveLength(0);
    });

    it("REJECTS an unsigned payload", async () => {
      const h = makeHarness();
      const rawBody = Buffer.from(JSON.stringify(inboundPayload()), "utf8");

      const res = await call(h.router, "POST", "/webhook", { rawBody });

      expect(res.status).toBe(401);
      expect(h.repo.rows).toHaveLength(0);
    });

    it("REJECTS a tampered body under a captured signature", async () => {
      const h = makeHarness();
      const { signature } = signed(inboundPayload({ text: "original" }));
      const tampered = Buffer.from(JSON.stringify(inboundPayload({ text: "injected" })), "utf8");

      const res = await call(h.router, "POST", "/webhook", { rawBody: tampered, signature });

      expect(res.status).toBe(401);
      expect(h.repo.rows).toHaveLength(0);
    });

    it("does not explain WHY a signature failed", async () => {
      const h = makeHarness();
      const { rawBody } = signed(inboundPayload());
      const res = await call(h.router, "POST", "/webhook", { rawBody, signature: "sha256=deadbeef" });

      const blob = JSON.stringify(res.body);
      expect(blob).not.toMatch(/MALFORMED|MISMATCH|MISSING_HEADER/);
      expect(res.body.error.message).toBe("Invalid signature");
    });
  });

  describe("replay and duplicate suppression", () => {
    it("processes a redelivered message ONCE", async () => {
      const h = makeHarness();
      const { rawBody, signature } = signed(inboundPayload({ messageId: "wamid.DUP" }));

      const first = await call(h.router, "POST", "/webhook", { rawBody, signature });
      const second = await call(h.router, "POST", "/webhook", { rawBody, signature });

      expect(first.body.data.processed).toBe(1);
      // Meta retries until it sees a 200, so a redelivery must be a 200 no-op.
      expect(second.status).toBe(200);
      expect(second.body.data).toMatchObject({ processed: 0, duplicates: 1 });
      expect(h.repo.rows).toHaveLength(1);
    });

    it("REJECTS a replayed old event even with a valid signature", async () => {
      const h = makeHarness();
      const { rawBody, signature } = signed(inboundPayload({ timestamp: STALE_TS }));

      const res = await call(h.router, "POST", "/webhook", { rawBody, signature });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ processed: 0, skipped: 1 });
      expect(h.repo.rows).toHaveLength(0);
    });

    it("treats distinct message ids as distinct messages", async () => {
      const h = makeHarness();
      for (const id of ["wamid.A", "wamid.B"]) {
        const { rawBody, signature } = signed(inboundPayload({ messageId: id }));
        await call(h.router, "POST", "/webhook", { rawBody, signature });
      }
      expect(h.repo.rows).toHaveLength(2);
    });
  });

  describe("tenant isolation", () => {
    it("DROPS a message for an unclaimed phone number", async () => {
      const h = makeHarness();
      const { rawBody, signature } = signed(inboundPayload({ phoneNumberId: "999999999999" }));

      const res = await call(h.router, "POST", "/webhook", { rawBody, signature });

      // Signed but unowned: recorded against nobody rather than a guessed user.
      expect(res.status).toBe(200);
      expect(res.body.data.skipped).toBe(1);
      expect(h.repo.rows).toHaveLength(0);
    });

    it("attributes a message to the claiming user only", async () => {
      const h = makeHarness();
      h.repo.claims.set(PHONE_NUMBER_ID, "user-2");
      const { rawBody, signature } = signed(inboundPayload());

      await call(h.router, "POST", "/webhook", { rawBody, signature });
      expect(h.repo.rows[0].userId).toBe("user-2");
    });
  });

  describe("malformed input", () => {
    it("answers 200 for a signed but unparseable body", async () => {
      const h = makeHarness();
      const rawBody = Buffer.from("not json at all", "utf8");
      const res = await call(h.router, "POST", "/webhook", {
        rawBody,
        signature: signPayload(rawBody, APP_SECRET),
      });
      // Non-200 would trigger permanent redelivery of a body that can never parse.
      expect(res.status).toBe(200);
      expect(h.repo.rows).toHaveLength(0);
    });

    it("ignores a non-WhatsApp webhook object", async () => {
      const h = makeHarness();
      const { rawBody, signature } = signed({ object: "instagram", entry: [] });
      const res = await call(h.router, "POST", "/webhook", { rawBody, signature });
      expect(res.status).toBe(200);
      expect(h.repo.rows).toHaveLength(0);
    });

    it("applies delivery statuses to existing outbound rows", async () => {
      const h = makeHarness();
      await h.repo.recordOutbound({
        userId: "user-1",
        providerMessageId: "wamid.OUT1",
        waId: "15550101234",
        phoneNumberId: PHONE_NUMBER_ID,
        body: "hi",
      });

      const { rawBody, signature } = signed({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: PHONE_NUMBER_ID },
                  statuses: [
                    { id: "wamid.OUT1", status: "delivered", timestamp: FRESH_TS, recipient_id: "15550101234" },
                  ],
                },
              },
            ],
          },
        ],
      });
      await call(h.router, "POST", "/webhook", { rawBody, signature });

      expect(h.repo.rows.find((r) => r.providerMessageId === "wamid.OUT1")?.status).toBe("delivered");
    });
  });

  it("never echoes message content in the response", async () => {
    const h = makeHarness();
    const { rawBody, signature } = signed(inboundPayload({ text: "SENSITIVE CONTENT" }));
    const res = await call(h.router, "POST", "/webhook", { rawBody, signature });
    expect(JSON.stringify(res.body)).not.toContain("SENSITIVE CONTENT");
  });
});

describe("Sprint 5.3 — GET /messages authorization", () => {
  async function seeded() {
    const h = makeHarness();
    const { rawBody, signature } = signed(inboundPayload());
    await call(h.router, "POST", "/webhook", { rawBody, signature });
    return h;
  }

  it("requires a bearer token", async () => {
    const h = await seeded();
    const res = await call(h.router, "GET", "/messages");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid token", async () => {
    const h = await seeded();
    expect((await call(h.router, "GET", "/messages", { token: "bogus" })).status).toBe(401);
  });

  it("returns the caller's own messages", async () => {
    const h = await seeded();
    const res = await call(h.router, "GET", "/messages", { token: TOKEN_A });
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.messages[0].body).toBe("Hello JARVIS");
  });

  it("does NOT return another user's messages", async () => {
    const h = await seeded();
    const res = await call(h.router, "GET", "/messages", { token: TOKEN_B });
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(0);
  });

  it("ignores a userId supplied in the query string", async () => {
    // Tenant scope comes from the verified token, never from user input.
    const h = await seeded();
    const res = await call(h.router, "GET", "/messages?userId=user-1", { token: TOKEN_B });
    expect(res.body.data.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Approval boundary — verified against the REAL ToolApprovalService
// ---------------------------------------------------------------------------

describe("Sprint 5.3 — approval boundary", () => {
  function makeApprovalService() {
    const approvalRepo = {
      create: vi.fn(async (data: any) => ({
        id: "appr-1",
        ...data,
        status: "pending",
        expiresAt: new Date(Date.now() + 600000),
      })),
      findById: vi.fn(async () => null),
      findExistingForTool: vi.fn(async () => null),
      update: vi.fn(async () => undefined),
    };
    const auditRepo = { create: vi.fn(async () => ({ id: "a1" })), query: vi.fn(async () => []) };
    return {
      service: new ToolApprovalService(
        approvalRepo as never,
        auditRepo as never,
        new PermissionService() as never
      ),
      approvalRepo,
    };
  }

  const sendTool = (): ITool =>
    new WhatsAppSendMessageTool(
      new MockWhatsAppProvider(),
      { async isAuthorized() { return true; } },
      PHONE_NUMBER_ID
    ) as unknown as ITool;

  const params = { to: "15550101234", body: "hello" };

  it("REQUIRES approval before an outbound send may execute", async () => {
    const { service, approvalRepo } = makeApprovalService();

    const check = await service.checkPreExecution(sendTool(), params, {
      userId: "user-1",
      role: "admin",
      traceId: "t-1",
    });

    // EXTERNAL_SIDE_EFFECT is gated by the existing RISK_REQUIRES_APPROVAL
    // table — no WhatsApp-specific code and no bypass.
    expect(check.requiresApproval).toBe(true);
    expect(check.allowed).toBe(false);
    expect(approvalRepo.create).toHaveBeenCalled();
  });

  it("denies a viewer who lacks write permission", async () => {
    const { service } = makeApprovalService();
    const check = await service.checkPreExecution(sendTool(), params, {
      userId: "user-1",
      role: "viewer",
      traceId: "t-2",
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/permission/i);
  });

  it("rejects a send with missing parameters before any approval is raised", async () => {
    const { service, approvalRepo } = makeApprovalService();
    const check = await service.checkPreExecution(sendTool(), {}, {
      userId: "user-1",
      role: "admin",
      traceId: "t-3",
    });
    expect(check.allowed).toBe(false);
    expect(approvalRepo.create).not.toHaveBeenCalled();
  });
});
