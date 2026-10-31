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
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import type { TenantRole } from "@jarvis/core";
import { createDesktopRouter } from "../src/routes/desktop.js";
import { loadDesktopAgentConfig } from "../src/services/desktop/config.js";
import { DesktopControlService } from "../src/services/desktop/desktop-control-service.js";

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
};
const slots = { reserve: vi.fn(async () => ({ allowed: true })) };
const audit = { log: vi.fn(async () => undefined) };
const approvals = { create: vi.fn(), findById: vi.fn(), decideApproval: vi.fn(), consumeForExecution: vi.fn() };

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
  service = new DesktopControlService({
    store: store as never,
    memberships,
    approvals: approvals as never,
    journal: { begin: vi.fn(), markSucceeded: vi.fn(), markFailed: vi.fn(), markUnknown: vi.fn() } as never,
    sealer: {} as never,
    audit,
    slots,
    config: loaded.config,
  });
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
