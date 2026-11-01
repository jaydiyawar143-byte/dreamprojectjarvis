// ---------------------------------------------------------------------------
// Phase 19.6 — which Organizations a person may pair a computer with, over HTTP.
//
// The real router and the real service, with the stores faked, so no database
// is needed; the real repository's read is proven against PostgreSQL in
// desktop-agent-p19-pg. `listMemberships` is the one read of memberships by
// user alone (docs/phases/phase-19.md, §18.9). What is pinned is that it shows
// a person their own Organizations and narrows a list, and that it decides
// nothing:
//
//   • the answer is an id and a name, of Organizations the caller administers;
//   • pairing names its Organization, is never inferred from the list, and is
//     decided by reading both ids at that moment;
//   • a list that has gone out of date can pair nothing and reach no device;
//   • an outsider cannot tell a real Organization from an invented one.
//
// The source pins that hold the read to one caller are in
// tenant-admin-cli-p17.test.ts.
//
// The same fakes, signing as an agent does, pin the operators' view of a
// refused device: one `desktop.agent.refused` for a request whose signature
// verified against that device's key, and none for anyone else.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import {
  DESKTOP_AGENT_CURRENT_VERSION,
  DESKTOP_AGENT_HEADERS,
  DESKTOP_CONSENT_TEXT_VERSION,
  DESKTOP_PAIRING_DEVICE,
  DESKTOP_PROTOCOL_VERSION,
  desktopConsentTextSha256,
  desktopRequestCanonical,
  desktopResponseCanonical,
  renderDesktopConsentText,
  sha256Hex,
  signDesktopCanonical,
  verifyDesktopCanonical,
  type TenantRole,
} from "@jarvis/core";
import { createDesktopRouter } from "../src/routes/desktop.js";
import { loadDesktopAgentConfig } from "../src/services/desktop/config.js";
import { DesktopControlService, type DesktopAgentRoute } from "../src/services/desktop/desktop-control-service.js";
import { createOperationalLog } from "../src/services/observability/index.js";

const ORG = "org-one";
const ORG_TWO = "org-two";
const DEVICE = "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c";
const COMMAND = "6c8a1f2e-9b3d-4e5f-8a7b-1c2d3e4f5a6b";
const REFUSED_DETAIL = "connection refused: db.internal:5432";

const http = globalThis.fetch.bind(globalThis);

const tokenService = {
  verifyAccessToken: (token: string) => {
    const userId = token.replace(/^tok-/, "");
    return userId ? { userId, role: "owner", email: `${userId}@test.local` } : null;
  },
};

const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const loaded = loadDesktopAgentConfig({
  DESKTOP_AGENT_ENABLED: "true",
  DESKTOP_AGENT_COMMAND_SIGNING_KEY: signing.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  DESKTOP_AGENT_MIN_WINDOWS_BUILD: "26100",
} as NodeJS.ProcessEnv);
if (!loaded.enabled) throw new Error(loaded.reason);

interface MembershipRow {
  userId: string;
  tenantId: string;
  tenantName: string;
  role: TenantRole;
}

let rows: MembershipRow[];
/** What the list read answers when it has fallen behind `rows`, the memberships as they are now. */
let staleList: MembershipRow[] | null;
let listFails: boolean;
let findFails: boolean;
let server: Server;
let base = "";
let service: DesktopControlService;

const device = (overrides: Record<string, unknown> = {}) => ({
  id: DEVICE,
  userId: "owner-1",
  tenantId: ORG,
  publicKey: "public",
  fingerprint: "ab".repeat(32),
  displayName: "WORKSTATION",
  userLabel: "Owner",
  organizationLabel: "Org One",
  agentVersion: "1.0.0",
  windowsBuild: 26100,
  status: "active",
  createdAt: new Date("2026-10-30T10:00:00Z"),
  confirmedAt: new Date("2026-10-30T10:01:00Z"),
  revokedAt: null,
  lastSeenAt: null,
  ...overrides,
});

const command = {
  id: COMMAND,
  deviceId: DEVICE,
  action: "desktop.input.click",
  status: "succeeded",
  requiresHello: false,
  issuedAt: new Date("2026-10-30T10:02:00Z"),
  expiresAt: new Date("2026-10-30T10:02:30Z"),
  completedAt: new Date("2026-10-30T10:02:01Z"),
  resultCode: null,
};

const memberships = {
  findMembership: vi.fn(async (userId: string, tenantId: string) => {
    if (findFails) throw new Error(REFUSED_DETAIL);
    const row = rows.find((r) => r.userId === userId && r.tenantId === tenantId);
    return row ? { role: row.role } : null;
  }),
  listMemberships: vi.fn(async (userId: string) => {
    if (listFails) throw new Error(REFUSED_DETAIL);
    return (staleList ?? rows).filter((r) => r.userId === userId).map(({ tenantId, tenantName, role }) => ({ tenantId, tenantName, role }));
  }),
};

const store = {
  createPairingCode: vi.fn(async () => undefined),
  listDevices: vi.fn(async () => []),
  findDevice: vi.fn(async () => device() as never),
  activeGrant: vi.fn(async () => null),
  confirmDevice: vi.fn(async () => true),
  revokeDevice: vi.fn(async () => ({ revoked: true, expired: [] })),
  endGrant: vi.fn(async () => ({ ended: true, expired: [] })),
  findCommand: vi.fn(async () => command as never),
  listCommands: vi.fn(async () => [command] as never),
  consumeNonce: vi.fn(async () => true),
  touchDevice: vi.fn(async () => undefined),
  touchGrant: vi.fn(async () => undefined),
  pollGrant: vi.fn(async () => ({ grant: null, ended: null, expired: [] })),
  completeCommand: vi.fn(async () => null),
  reservePairingAttempt: vi.fn(async () => true),
  redeemPairingCode: vi.fn(async () => ({ ok: false, reason: "INVALID" })),
};
const slots = { reserve: vi.fn(async () => ({ allowed: true })) };
const audit = { log: vi.fn(async () => undefined) };
const approvals = { create: vi.fn(), findById: vi.fn(), decideApproval: vi.fn(), consumeForExecution: vi.fn() };

const deps = () => ({
  store: store as never,
  memberships,
  approvals: approvals as never,
  journal: { begin: vi.fn(), markSucceeded: vi.fn(), markFailed: vi.fn(), markUnknown: vi.fn() } as never,
  sealer: {} as never,
  audit,
  slots,
  config: loaded.config,
});

beforeAll(() => {
  const app = express();
  app.use(express.json());
  // A router per request, so each test's service is the one served.
  app.use("/desktop", (req, res, next) => createDesktopRouter({ tokenService } as never, service)(req, res, next));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  vi.clearAllMocks();
  store.findDevice.mockReset();
  store.findDevice.mockResolvedValue(device() as never);
  rows = [
    { userId: "owner-1", tenantId: ORG, tenantName: "Org One", role: "owner" },
    { userId: "owner-1", tenantId: ORG_TWO, tenantName: "Org Two", role: "admin" },
    { userId: "admin-2", tenantId: ORG, tenantName: "Org One", role: "admin" },
    { userId: "member-3", tenantId: ORG, tenantName: "Org One", role: "member" },
    { userId: "viewer-4", tenantId: ORG, tenantName: "Org One", role: "viewer" },
    { userId: "mixed-5", tenantId: ORG, tenantName: "Org One", role: "member" },
    { userId: "mixed-5", tenantId: ORG_TWO, tenantName: "Org Two", role: "admin" },
  ];
  staleList = null;
  listFails = false;
  findFails = false;
  service = new DesktopControlService(deps());
});

async function call(userId: string | null, method: string, path: string, body?: unknown) {
  const res = await http(`${base}/desktop${path}`, {
    method,
    headers: { "content-type": "application/json", ...(userId ? { authorization: `Bearer tok-${userId}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as { success: boolean; data?: any; error?: { code: string; message: string } } };
}

const expectNothingSpent = () => {
  expect(slots.reserve).not.toHaveBeenCalled();
  expect(store.createPairingCode).not.toHaveBeenCalled();
};

describe("Phase 19.6 — the Organizations a person administers", () => {
  it("lists the caller's Owner and Admin Organizations, as an id and a name and nothing else", async () => {
    const res = await call("owner-1", "GET", "/organizations");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: ORG, name: "Org One" },
      { id: ORG_TWO, name: "Org Two" },
    ]);
  });

  it("leaves out a membership that is not Owner or Admin, and everyone else's", async () => {
    expect((await call("mixed-5", "GET", "/organizations")).body.data).toEqual([{ id: ORG_TWO, name: "Org Two" }]);
    expect((await call("member-3", "GET", "/organizations")).body.data).toEqual([]);
    expect((await call("viewer-4", "GET", "/organizations")).body.data).toEqual([]);
  });

  it("answers an empty list, not a refusal, to someone who administers nothing", async () => {
    const res = await call("nobody-9", "GET", "/organizations");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("cleans a name the way a device's Organization label is cleaned", async () => {
    rows = [{ userId: "owner-1", tenantId: ORG, tenantName: "  Org\u0000 One\n", role: "owner" }];
    expect((await call("owner-1", "GET", "/organizations")).body.data).toEqual([{ id: ORG, name: "Org One" }]);
  });

  it("refuses without a session, and reads nothing", async () => {
    const res = await call(null, "GET", "/organizations");
    expect(res.status).toBe(401);
    expect(memberships.listMemberships).not.toHaveBeenCalled();
  });

  it("says it is unavailable when the read fails, and nothing of why", async () => {
    listFails = true;
    const res = await call("owner-1", "GET", "/organizations");
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe("UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toContain(REFUSED_DETAIL);
  });
});

describe("Phase 19.6 — pairing names its Organization", () => {
  it("creates the code for the Organization named, and audits only its id", async () => {
    const res = await call("owner-1", "POST", "/pairings", { organizationId: ORG_TWO });
    expect(res.status).toBe(200);
    expect(res.body.data.organizationId).toBe(ORG_TWO);
    expect(store.createPairingCode).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner-1", tenantId: ORG_TWO }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "desktop.pairing.create", parameters: { organizationId: ORG_TWO } }));
  });

  it("never guesses: naming none is refused, even for someone with exactly one Organization", async () => {
    const res = await call("admin-2", "POST", "/pairings", {});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("ORGANIZATION_REQUIRED");
    expect(memberships.listMemberships).not.toHaveBeenCalled();
    expectNothingSpent();
  });

  it.each([[""], [42], [["org-one"]], [{ id: "org-one" }]])("refuses %j as an Organization, spending nothing", async (organizationId) => {
    const res = await call("owner-1", "POST", "/pairings", { organizationId });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_REQUEST");
    expectNothingSpent();
  });

  it("decides without the list at all", async () => {
    listFails = true;
    expect((await call("owner-1", "POST", "/pairings", { organizationId: ORG })).status).toBe(200);
    expect(memberships.listMemberships).not.toHaveBeenCalled();
    expect(memberships.findMembership).toHaveBeenCalledWith("owner-1", ORG);
  });

  it("cannot be opened by a list that has gone out of date", async () => {
    staleList = rows;
    rows = rows.map((r) => (r.userId === "admin-2" ? { ...r, role: "member" as const } : r));
    expect((await call("admin-2", "GET", "/organizations")).body.data).toEqual([{ id: ORG, name: "Org One" }]);

    const res = await call("admin-2", "POST", "/pairings", { organizationId: ORG });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("NOT_AUTHORIZED");
    expectNothingSpent();
  });

  it.each([["member-3"], ["viewer-4"]])("is refused to %s, who belongs but does not administer", async (userId) => {
    const res = await call(userId, "POST", "/pairings", { organizationId: ORG });
    expect(res.status).toBe(403);
    expectNothingSpent();
  });

  it("answers an outsider the same for a real Organization and an invented one", async () => {
    const real = await call("nobody-9", "POST", "/pairings", { organizationId: ORG });
    const invented = await call("nobody-9", "POST", "/pairings", { organizationId: "org-does-not-exist" });
    expect(real.status).toBe(403);
    expect(invented.status).toBe(real.status);
    expect(invented.body.error).toEqual(real.body.error);
    expectNothingSpent();
  });

  it("refuses when the membership cannot be read, and creates nothing", async () => {
    findFails = true;
    const res = await call("owner-1", "POST", "/pairings", { organizationId: ORG });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain(REFUSED_DETAIL);
    expectNothingSpent();
  });
});

describe("Phase 19.6 — what the list shows is checked again before anything happens", () => {
  /** admin-2 stays on the list, and is gone from the Organization. */
  const removeAdminBehindTheList = () => {
    staleList = rows;
    rows = rows.filter((r) => r.userId !== "admin-2");
  };

  it("lets a list narrow what is shown, to Organizations administered", async () => {
    await call("mixed-5", "GET", "/devices");
    expect(store.listDevices).toHaveBeenCalledWith({ userId: "mixed-5", adminTenantIds: [ORG_TWO] });
  });

  it("does not let an out-of-date list revoke someone else's computer", async () => {
    removeAdminBehindTheList();
    expect((await call("admin-2", "POST", `/devices/${DEVICE}/revoke`)).status).toBe(404);
    expect(store.revokeDevice).not.toHaveBeenCalled();
  });

  it("does not let an out-of-date list end someone else's session", async () => {
    removeAdminBehindTheList();
    expect((await call("admin-2", "POST", `/devices/${DEVICE}/session/end`)).status).toBe(404);
    expect(store.endGrant).not.toHaveBeenCalled();
  });

  it("refuses to confirm a computer for someone who no longer administers its Organization", async () => {
    store.findDevice.mockResolvedValueOnce(device({ userId: "admin-2", status: "pending" }) as never);
    removeAdminBehindTheList();
    expect((await call("admin-2", "POST", `/devices/${DEVICE}/confirm`, { fingerprint: "ANY" })).status).toBe(403);
    expect(store.confirmDevice).not.toHaveBeenCalled();
  });

  it("refuses a command for someone who no longer administers the computer's Organization", async () => {
    store.findDevice.mockResolvedValueOnce(device({ userId: "admin-2" }) as never);
    removeAdminBehindTheList();
    const res = await call("admin-2", "POST", `/devices/${DEVICE}/commands`, { action: "desktop.input.key", key: "enter" });
    expect(res.status).toBe(403);
    expect(approvals.create).not.toHaveBeenCalled();
  });

  it("stops showing a computer's commands to someone who no longer administers its Organization", async () => {
    store.findDevice.mockResolvedValue(device({ userId: "admin-2" }) as never);
    removeAdminBehindTheList();
    expect((await call("admin-2", "GET", `/devices/${DEVICE}/commands`)).status).toBe(403);
    expect((await call("admin-2", "GET", `/commands/${COMMAND}`)).status).toBe(403);
    expect(store.listCommands).not.toHaveBeenCalled();
  });

  it("still shows a computer's commands to its user while they administer its Organization", async () => {
    expect((await call("owner-1", "GET", `/devices/${DEVICE}/commands`)).body.data).toHaveLength(1);
    expect((await call("owner-1", "GET", `/commands/${COMMAND}`)).body.data.id).toBe(COMMAND);
  });

  it("leaves a person able to stop their own computer after they leave the Organization", async () => {
    store.findDevice.mockResolvedValueOnce(device({ userId: "admin-2" }) as never);
    rows = rows.filter((r) => r.userId !== "admin-2");
    expect((await call("admin-2", "POST", `/devices/${DEVICE}/revoke`)).status).toBe(200);
    expect(store.revokeDevice).toHaveBeenCalledWith(expect.objectContaining({ deviceId: DEVICE, revokedById: "admin-2" }));
  });
});

describe("Phase 19.6 — what the operators see of a refused device", () => {
  const deviceKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const strangerKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const DEVICE_KEY = deviceKey.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  /** The first 16 hex characters of SHA-256(DEVICE), derived outside this code. The agent's AgentLog test pins the same value. */
  const DEVICE_HASH = "8caefa6b4fa9a023";
  const NOW = "2026-11-01T10:00:00.000Z";
  const INSTANCE = "0b9c6a52-3c1d-4f7e-9a4b-7d2e1f6c8a90";
  const GRANT = "5e1a7c34-8d2f-4b6a-9c3e-2f7d1a6b4c80";
  const PAIRING_CODE = "not-a-pairing-code-but-still-secret";
  const POLL = { version: DESKTOP_PROTOCOL_VERSION, agentInstanceId: INSTANCE, agentVersion: DESKTOP_AGENT_CURRENT_VERSION, windowsBuild: 26100, grantId: null };
  const RESULT = { version: DESKTOP_PROTOCOL_VERSION, outcome: "succeeded" };
  const PAIR = {
    version: DESKTOP_PROTOCOL_VERSION,
    pairingCode: PAIRING_CODE,
    publicKey: DEVICE_KEY,
    deviceName: "WORKSTATION",
    agentVersion: DESKTOP_AGENT_CURRENT_VERSION,
    windowsBuild: 26100,
    architecture: "x64",
  };
  const GRANT_REQUEST = {
    version: DESKTOP_PROTOCOL_VERSION,
    agentInstanceId: INSTANCE,
    grantId: GRANT,
    durationMinutes: 15,
    scope: ["desktop.input.click"],
    consentTextVersion: DESKTOP_CONSENT_TEXT_VERSION,
    consentTextSha256: "a".repeat(64),
    replacesGrantId: null,
  };

  let lines: string[];
  let logged: DesktopControlService;

  beforeEach(() => {
    lines = [];
    store.findDevice.mockResolvedValue(device({ publicKey: DEVICE_KEY }) as never);
    logged = new DesktopControlService({
      ...deps(),
      agentLog: createOperationalLog({ service: "jarvis-api", component: "desktop-agent", write: (line) => lines.push(line), now: () => new Date(NOW) }),
    });
  });

  const refusals = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "desktop.agent.refused");

  /** One request, signed as an agent signs it. */
  async function send(
    route: DesktopAgentRoute,
    body: unknown,
    opts: { signWith?: KeyObject; timestamp?: number; version?: string; to?: DesktopControlService } = {}
  ) {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const path = `/api/v1/desktop-agent/${route === "result" ? `commands/${COMMAND}/result` : route}`;
    const parts = {
      method: "POST",
      path,
      timestamp: String(opts.timestamp ?? Date.now()),
      nonce: randomBytes(18).toString("base64url"),
      device: route === "pair" ? DESKTOP_PAIRING_DEVICE : DEVICE,
      bodySha256: sha256Hex(raw),
    };
    const signature = signDesktopCanonical(opts.signWith ?? deviceKey.privateKey, desktopRequestCanonical(parts));
    const res = await (opts.to ?? logged).handleAgent(route, {
      method: "POST",
      path,
      headers: {
        [DESKTOP_AGENT_HEADERS.version]: opts.version ?? DESKTOP_PROTOCOL_VERSION,
        [DESKTOP_AGENT_HEADERS.device]: parts.device,
        [DESKTOP_AGENT_HEADERS.timestamp]: parts.timestamp,
        [DESKTOP_AGENT_HEADERS.nonce]: parts.nonce,
        [DESKTOP_AGENT_HEADERS.bodySha256]: parts.bodySha256,
        [DESKTOP_AGENT_HEADERS.signature]: signature,
      },
      rawBody: raw,
      source: "203.0.113.7",
      ...(route === "result" ? { commandId: COMMAND } : {}),
    });
    return { ...res, sent: { nonce: parts.nonce, bodySha256: parts.bodySha256, signature } };
  }

  it("reports a revoked device once, by its hash, and it is still told so in a signed answer", async () => {
    store.findDevice.mockResolvedValue(device({ publicKey: DEVICE_KEY, status: "revoked" }) as never);
    const res = await send("poll", POLL);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ version: DESKTOP_PROTOCOL_VERSION, error: { code: "DEVICE_REVOKED" } });
    const canonical = desktopResponseCanonical({ requestNonce: res.sent.nonce, status: 403, bodySha256: sha256Hex(Buffer.from(JSON.stringify(res.body), "utf8")) });
    expect(verifyDesktopCanonical(loaded.config.serverPublicKey, canonical, res.headers[DESKTOP_AGENT_HEADERS.responseSignature])).toBe(true);

    expect(refusals()).toEqual([
      {
        timestamp: NOW,
        level: "warn",
        service: "jarvis-api",
        component: "desktop-agent",
        event: "desktop.agent.refused",
        route: "poll",
        status: 403,
        code: "DEVICE_REVOKED",
        deviceIdHash: DEVICE_HASH,
      },
    ]);
  });

  it.each<[string, DesktopAgentRoute, unknown, Record<string, unknown>, boolean, number, string]>([
    ["a revoked device's consent", "grants", GRANT_REQUEST, { status: "revoked" }, true, 403, "DEVICE_REVOKED"],
    ["a revoked device's result", "result", RESULT, { status: "revoked" }, true, 403, "DEVICE_REVOKED"],
    ["a revoked device ending a session", "session/end", { version: DESKTOP_PROTOCOL_VERSION }, { status: "revoked" }, true, 403, "DEVICE_REVOKED"],
    ["a body of the wrong shape", "poll", { version: DESKTOP_PROTOCOL_VERSION }, {}, true, 400, "INVALID_REQUEST"],
    ["a user who lost the Organization", "poll", POLL, {}, false, 403, "NOT_AUTHORIZED"],
    ["an agent too old to serve", "poll", { ...POLL, agentVersion: "0.0.1" }, {}, true, 403, "AGENT_VERSION_UNSUPPORTED"],
    ["a Windows too old to serve", "poll", { ...POLL, windowsBuild: 22000 }, {}, true, 403, "WINDOWS_VERSION_UNSUPPORTED"],
    ["consent from a device not yet confirmed", "grants", GRANT_REQUEST, { status: "pending" }, true, 403, "DEVICE_PENDING"],
    // A hash that is right for the text, so only the version can refuse it.
    [
      "consent to wording older than this release",
      "grants",
      {
        ...GRANT_REQUEST,
        consentTextVersion: "desktop-consent/1",
        consentTextSha256: desktopConsentTextSha256(renderDesktopConsentText({ userLabel: "Owner", organizationLabel: "Org One", durationMinutes: 15, scope: ["desktop.input.click"] })),
      },
      {},
      true,
      400,
      "CONSENT_MISMATCH",
    ],
    ["a result from a device not yet confirmed", "result", RESULT, { status: "pending" }, true, 403, "DEVICE_PENDING"],
    ["a result for a command already answered", "result", RESULT, {}, true, 409, "CONFLICT"],
  ])("reports exactly one event for %s", async (_name, route, body, overrides, member, status, code) => {
    store.findDevice.mockResolvedValue(device({ publicKey: DEVICE_KEY, ...overrides }) as never);
    if (!member) rows = rows.filter((r) => r.userId !== "owner-1");

    const res = await send(route, body);

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ version: DESKTOP_PROTOCOL_VERSION, error: { code } });
    expect(refusals()).toEqual([expect.objectContaining({ route, status, code, deviceIdHash: DEVICE_HASH })]);
  });

  it("reports a replayed request: the signature verified, the device's key did sign it", async () => {
    store.consumeNonce.mockResolvedValueOnce(false);
    const res = await send("poll", POLL);
    expect(res.status).toBe(401);
    expect(refusals()).toEqual([expect.objectContaining({ route: "poll", status: 401, code: "REPLAY_DETECTED", deviceIdHash: DEVICE_HASH })]);
  });

  it.each([
    ["spending the nonce", () => store.consumeNonce.mockRejectedValueOnce(new Error(REFUSED_DETAIL))],
    ["serving the poll", () => store.touchDevice.mockRejectedValueOnce(new Error(REFUSED_DETAIL))],
  ])("reports a verified device the store failed while %s, and nothing of why", async (_name, fail) => {
    fail();
    const res = await send("poll", POLL);
    expect(res.status).toBe(503);
    expect(refusals()).toEqual([expect.objectContaining({ route: "poll", status: 503, code: "UNAVAILABLE", deviceIdHash: DEVICE_HASH })]);
    expect(lines.join("\n")).not.toContain(REFUSED_DETAIL);
  });

  it.each<[string, () => void, Parameters<typeof send>[2], number, string]>([
    ["a signature from another key", () => undefined, { signWith: strangerKey.privateKey }, 401, "UNAUTHENTICATED"],
    [
      "a signature from another key, naming a revoked device",
      () => store.findDevice.mockResolvedValue(device({ publicKey: DEVICE_KEY, status: "revoked" }) as never),
      { signWith: strangerKey.privateKey },
      401,
      "UNAUTHENTICATED",
    ],
    ["an unknown device", () => store.findDevice.mockResolvedValue(null as never), {}, 401, "UNAUTHENTICATED"],
    ["a request out of time", () => undefined, { timestamp: Date.now() - 60 * 60_000 }, 401, "REQUEST_EXPIRED"],
    ["another protocol version", () => undefined, { version: "jarvis-desktop/0" }, 400, "UNSUPPORTED_VERSION"],
    ["a store that failed before the signature was checked", () => store.findDevice.mockRejectedValue(new Error(REFUSED_DETAIL)), {}, 503, "UNAVAILABLE"],
  ])("reports nothing for %s", async (_name, arrange, opts, status, code) => {
    arrange();
    const res = await send("poll", POLL, opts);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ version: DESKTOP_PROTOCOL_VERSION, error: { code } });
    expect(lines).toEqual([]);
  });

  it("reports nothing for a pairing: its key is the requester's own, so its signature proves no device", async () => {
    const res = await send("pair", PAIR);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ version: DESKTOP_PROTOCOL_VERSION, error: { code: "PAIRING_CODE_INVALID" } });
    expect(lines).toEqual([]);
  });

  it("reports nothing for a request it served", async () => {
    expect((await send("poll", POLL)).status).toBe(200);
    store.findDevice.mockResolvedValue(device({ publicKey: DEVICE_KEY, status: "pending" }) as never);
    expect((await send("poll", POLL)).status).toBe(200);
    expect(lines).toEqual([]);
  });

  it("keeps out the id, the command, the nonce, the signature, the keys and the body", async () => {
    store.findDevice.mockResolvedValue(device({ publicKey: DEVICE_KEY, status: "revoked" }) as never);
    const res = await send("result", RESULT);
    const written = lines.join("\n");

    expect(refusals()).toHaveLength(1);
    for (const never of [DEVICE, COMMAND, res.sent.nonce, res.sent.bodySha256, res.sent.signature, DEVICE_KEY, "203.0.113.7", "desktop-agent/commands", "succeeded"]) {
      expect(written).not.toContain(never);
    }
  });

  it("answers the same with no log to report to", async () => {
    store.findDevice.mockResolvedValue(device({ publicKey: DEVICE_KEY, status: "revoked" }) as never);
    const withLog = await send("poll", POLL);
    const withoutLog = await send("poll", POLL, { to: service });
    expect(withoutLog.status).toBe(withLog.status);
    expect(withoutLog.body).toEqual(withLog.body);
    expect(Object.keys(withoutLog.headers).sort()).toEqual(Object.keys(withLog.headers).sort());
  });
});
