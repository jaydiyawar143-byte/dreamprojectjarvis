// ---------------------------------------------------------------------------
// Phase 19, Stage 19.6 — DesktopControlService end to end, on PostgreSQL.
//
// The production pieces together: the desktop store, the tenant memberships,
// the approval store (sealing, single-use consumption), the execution journal,
// the audit trail and the atomic limiter — driven by a TEST AGENT that signs
// every request with its own P-256 key, exactly as the .NET agent does, and
// verifies every answer against the server's pinned command key. A clock the
// test controls stands for time passing. No Windows, no input, no screen.
//
// What it pins, by the brief's lists: pairing, consent, revocation, the
// security checks and the outcomes — including that nothing typed is stored
// anywhere, that a lost answer is UNKNOWN and is never sent again, and that a
// typed command always requires Windows Hello at the device.
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
// ---------------------------------------------------------------------------

import { generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  DESKTOP_AGENT_CURRENT_VERSION,
  DESKTOP_AGENT_HEADERS,
  DESKTOP_CONSENT_TEXT_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  DesktopCommandEnvelopeSchema,
  desktopCommandCanonical,
  desktopConsentTextSha256,
  desktopRequestCanonical,
  desktopResponseCanonical,
  desktopServerKeyId,
  renderDesktopConsentText,
  sha256Hex,
  signDesktopCanonical,
  verifyDesktopCanonical,
  type DesktopGrantScope,
} from "@jarvis/core";
import { AuditLogger, generateKey } from "@jarvis/security";

import { createApprovalParamsSealer } from "../src/services/approval-sealer.js";
import { loadDesktopAgentConfig } from "../src/services/desktop/config.js";
import {
  DesktopControlError,
  DesktopControlService,
  type DesktopAgentRoute,
} from "../src/services/desktop/desktop-control-service.js";
import { createOperationalLog } from "../src/services/observability/index.js";
import { AtomicRateLimiter } from "../src/services/rate-limiter.js";
import { holdSharedConnection, type SharedConnectionLease } from "./helpers/shared-connection-lock.js";

/** A URL that names a port, and not development's or deployment's. No port at all means 5432. */
function isSeparateDatabase(url: string | undefined): boolean {
  try {
    const { port } = new URL(url ?? "");
    return port !== "" && port !== "5432" && port !== "5433";
  } catch {
    return false;
  }
}

const SAFE_TARGET = isSeparateDatabase(process.env.DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Db = typeof import("@jarvis/db");
let db: Db | null = null;
let prisma: InstanceType<Db["PrismaClient"]> | null = null;
let second: InstanceType<Db["PrismaClient"]> | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  prisma = new db.PrismaClient();
  second = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    await second.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// Words, not a token: since Stage 19.7 a token-shaped text is refused before it
// is ever stored, and this is what must not be stored even when it is typed.
const SECRET = `Typed words ${STAMP.replace(/[0-9-]/g, (d) => "abcdefghijk"[Number(d) || 10]!)}`;
const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const ENV = {
  DESKTOP_AGENT_ENABLED: "true",
  DESKTOP_AGENT_COMMAND_SIGNING_KEY: signing.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  DESKTOP_AGENT_MIN_WINDOWS_BUILD: "26100",
} as NodeJS.ProcessEnv;
const ENCRYPTION_KEY = generateKey();

let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);
// `sweep` closes every command in the table, with this file's clock moved on, so
// the two desktop suites take turns: vitest runs files in parallel, and one's sweep
// would expire the other's waiting command.
let lease: SharedConnectionLease | null = null;

const userIds: string[] = [];
const tenantIds: string[] = [];
const ids = { actor: "", owner: "", admin: "", member: "", outsider: "" };
let ORG = "";
let OTHER_ORG = "";

const SERVER_PUBLIC_KEY = signing.publicKey.export({ format: "der", type: "spki" }).toString("base64");

/** What the service tells operators, through the real log. */
const agentLines: string[] = [];
const agentLog = createOperationalLog({ service: "jarvis-api", component: "desktop-agent", write: (line) => agentLines.push(line) });

/** The service as the container builds it; `pairingCodeLimit` is lifted except where the limit is what is tested. */
function service(client = prisma!, opts: { policyLimit?: boolean; holdMs?: number } = {}) {
  const config = loadDesktopAgentConfig(ENV);
  if (!config.enabled) throw new Error(config.reason);
  const sealer = createApprovalParamsSealer({ JARVIS_ENCRYPTION_KEY: ENCRYPTION_KEY } as NodeJS.ProcessEnv)!;
  const auditRepo = new db!.PrismaAuditRepository(client);
  return new DesktopControlService({
    store: new db!.PrismaDesktopRepository(client),
    memberships: new db!.PrismaTenantRepository(client),
    approvals: new db!.PrismaApprovalRepository(client, { sealer }),
    journal: new db!.PrismaToolExecutionRepository(client),
    sealer,
    audit: new AuditLogger(auditRepo),
    slots: new AtomicRateLimiter(auditRepo, "desktop"),
    config: config.config,
    now: clock,
    pollHoldMs: opts.holdMs ?? 0,
    pollIntervalMs: 20,
    agentLog,
    ...(opts.policyLimit ? {} : { pairingCodeLimit: { limit: 10_000, windowMs: 60_000 } }),
  });
}

/** An agent, as the .NET one behaves on the wire: its own key, signed requests, verified answers. */
class TestAgent {
  readonly key: KeyObject;
  readonly publicKey: string;
  deviceId = "";
  instance = randomUUID();
  /** Where its requests come from: its own, unless a test shares one on purpose. */
  source = `test-${randomUUID()}`;
  grantId: string | null = null;
  /** Pinned: the test knows the server's key, as an agent does once it has paired. */
  serverKey: string | null = SERVER_PUBLIC_KEY;
  serverKeyId: string | null = null;
  labels = { userLabel: "", organizationLabel: "" };

  constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.key = pair.privateKey;
    this.publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  }

  async send(
    svc: DesktopControlService,
    route: DesktopAgentRoute,
    body: unknown,
    opts: { commandId?: string; nonce?: string; timestamp?: number; path?: string; rawBody?: Buffer; version?: string; signWith?: KeyObject } = {}
  ): Promise<{ status: number; body: any; verified: boolean }> {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const path = opts.path ?? `/api/v1/desktop-agent/${route === "result" ? `commands/${opts.commandId}/result` : route}`;
    const parts = {
      method: "POST",
      path,
      timestamp: String(opts.timestamp ?? clock().getTime()),
      nonce: opts.nonce ?? randomBytes(18).toString("base64url"),
      device: route === "pair" ? "pairing" : this.deviceId,
      bodySha256: sha256Hex(raw),
    };
    const headers = {
      [DESKTOP_AGENT_HEADERS.version]: opts.version ?? DESKTOP_PROTOCOL_VERSION,
      [DESKTOP_AGENT_HEADERS.device]: parts.device,
      [DESKTOP_AGENT_HEADERS.timestamp]: parts.timestamp,
      [DESKTOP_AGENT_HEADERS.nonce]: parts.nonce,
      [DESKTOP_AGENT_HEADERS.bodySha256]: parts.bodySha256,
      [DESKTOP_AGENT_HEADERS.signature]: signDesktopCanonical(opts.signWith ?? this.key, desktopRequestCanonical(parts)),
    };
    const res = await svc.handleAgent(route, {
      method: "POST",
      path,
      headers,
      rawBody: opts.rawBody ?? raw,
      source: this.source,
      ...(opts.commandId ? { commandId: opts.commandId } : {}),
    });
    const bytes = Buffer.from(JSON.stringify(res.body), "utf8");
    const canonical = desktopResponseCanonical({ requestNonce: parts.nonce, status: res.status, bodySha256: sha256Hex(bytes) });
    const key = this.serverKey ?? "";
    const verified = verifyDesktopCanonical(key, canonical, res.headers[DESKTOP_AGENT_HEADERS.responseSignature]);
    return { status: res.status, body: res.body, verified };
  }

  async pair(svc: DesktopControlService, code: string, overrides: Record<string, unknown> = {}) {
    const res = await this.send(svc, "pair", {
      version: DESKTOP_PROTOCOL_VERSION,
      pairingCode: code,
      publicKey: this.publicKey,
      deviceName: "WORKSTATION\n01",
      agentVersion: DESKTOP_AGENT_CURRENT_VERSION,
      windowsBuild: 26100,
      architecture: "x64",
      ...overrides,
    });
    if (res.status === 200) {
      this.deviceId = res.body.deviceId;
      this.serverKey = res.body.serverPublicKey;
      this.serverKeyId = res.body.serverKeyId;
      this.labels = { userLabel: res.body.userLabel, organizationLabel: res.body.organizationLabel };
    }
    return res;
  }

  poll(svc: DesktopControlService) {
    return this.send(svc, "poll", {
      version: DESKTOP_PROTOCOL_VERSION,
      agentInstanceId: this.instance,
      agentVersion: DESKTOP_AGENT_CURRENT_VERSION,
      windowsBuild: 26100,
      grantId: this.grantId,
    });
  }

  async grant(svc: DesktopControlService, opts: { durationMinutes?: number; scope?: DesktopGrantScope[]; replaces?: string | null; text?: string } = {}) {
    const durationMinutes = opts.durationMinutes ?? 15;
    const scope = opts.scope ?? ["desktop.input.click", "desktop.input.key", "desktop.input.type"];
    const text = opts.text ?? renderDesktopConsentText({ ...this.labels, durationMinutes, scope });
    const grantId = randomUUID();
    const res = await this.send(svc, "grants", {
      version: DESKTOP_PROTOCOL_VERSION,
      agentInstanceId: this.instance,
      grantId,
      durationMinutes,
      scope,
      consentTextVersion: DESKTOP_CONSENT_TEXT_VERSION,
      consentTextSha256: desktopConsentTextSha256(text),
      replacesGrantId: opts.replaces ?? null,
    });
    if (res.status === 200) this.grantId = grantId;
    return res;
  }

  endSession(svc: DesktopControlService, reason: string) {
    return this.send(svc, "session/end", { version: DESKTOP_PROTOCOL_VERSION, agentInstanceId: this.instance, grantId: this.grantId, reason });
  }

  result(svc: DesktopControlService, commandId: string, result: Record<string, unknown>) {
    return this.send(svc, "result", { version: DESKTOP_PROTOCOL_VERSION, ...result }, { commandId });
  }
}

async function errorOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DesktopControlError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A device of `ids.owner`, paired and confirmed, with control allowed. */
async function controlledAgent(svc = service(), scope?: DesktopGrantScope[]) {
  const agent = new TestAgent();
  const { code } = await svc.createPairingCode(ids.owner, { organizationId: ORG });
  expect((await agent.pair(svc, code)).status).toBe(200);
  const devices = await svc.listDevices(ids.owner);
  const view = devices.find((d) => d.id === agent.deviceId)!;
  await svc.confirmDevice(ids.owner, agent.deviceId, { fingerprint: view.fingerprint });
  expect((await agent.grant(svc, scope ? { scope } : {})).status).toBe(200);
  return agent;
}

/** Asks for, approves and issues one command; returns the issued command's id. */
async function issue(svc: DesktopControlService, agent: TestAgent, request: Record<string, unknown>) {
  const asked = await svc.requestCommand(ids.owner, agent.deviceId, request);
  const command = await svc.confirmCommand(ids.owner, agent.deviceId, asked.approvalId);
  return { approvalId: asked.approvalId, command };
}

async function rowsText(): Promise<string> {
  const [approvals, sealed, commands, payloads, audit, journal] = await Promise.all([
    prisma!.approval.findMany({ where: { userId: { in: userIds } } }),
    prisma!.approvalSealedParams.findMany({}),
    prisma!.desktopCommand.findMany({ where: { device: { userId: { in: userIds } } } }),
    prisma!.desktopCommandPayload.findMany({}),
    prisma!.auditLog.findMany({ where: { userId: { in: userIds } } }),
    prisma!.toolExecution.findMany({ where: { userId: { in: userIds } } }),
  ]);
  return JSON.stringify({ approvals, sealed, commands, payloads, audit, journal });
}

const adminRun = async (command: Parameters<Db["runTenantAdminCommand"]>[1]) => {
  const result = await db!.runTenantAdminCommand(prisma!, command, { actorUserId: ids.actor, execute: true });
  if (!result.ok) throw new Error(`${command.verb} refused: ${result.code}`);
  return result;
};

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) throw new Error("These security tests need a separate PostgreSQL test database, and none could be reached.");
  lease = await holdSharedConnection("desktop/commands");
  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const user = await prisma!.user.create({
      data: { email: `p196-api-${name}-${STAMP}@jarvis-test.local`, name: `User ${name}`, password: "x", role: "VIEWER" },
    });
    ids[name] = user.id;
    userIds.push(user.id);
  }
  ORG = String((await adminRun({ verb: "create-tenant", name: `Desk Org ${STAMP}`, ownerUserId: ids.owner })).detail.tenantId);
  OTHER_ORG = String((await adminRun({ verb: "create-tenant", name: `Other ${STAMP}`, ownerUserId: ids.outsider })).detail.tenantId);
  tenantIds.push(ORG, OTHER_ORG);
  await adminRun({ verb: "add-member", tenantId: ORG, userId: ids.admin, role: "admin" });
  await adminRun({ verb: "add-member", tenantId: ORG, userId: ids.member, role: "member" });
});

beforeEach(() => {
  offsetMs = 0;
});

afterAll(async () => {
  if (prisma) {
    await prisma.desktopDevice.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await prisma.desktopPairingCode.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await prisma.approval.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  if (second) await second.$disconnect();
  await lease?.release();
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.6 — pairing (PostgreSQL)", () => {
  it("is for an Owner or Admin of the Organization only, and never for another Organization", async () => {
    const svc = service();
    expect(await errorOf(svc.createPairingCode(ids.member, { organizationId: ORG }))).toBe("NOT_AUTHORIZED");
    expect(await errorOf(svc.createPairingCode(ids.owner, { organizationId: OTHER_ORG }))).toBe("NOT_AUTHORIZED");
    expect((await svc.createPairingCode(ids.admin, { organizationId: ORG })).organizationId).toBe(ORG);
  });

  it("is never inferred: an Organization must be named, even by someone with exactly one", async () => {
    expect(await errorOf(service().createPairingCode(ids.admin, {}))).toBe("ORGANIZATION_REQUIRED");
  });

  it("offers a person the Organizations they administer, read from the real memberships", async () => {
    const svc = service();
    const offered = await svc.listOrganizations(ids.owner);
    expect(offered.map((o) => o.id)).toEqual([ORG]);
    expect(Object.keys(offered[0]!).sort()).toEqual(["id", "name"]);
    expect(await svc.listOrganizations(ids.member)).toEqual([]);
    expect((await svc.listOrganizations(ids.outsider)).map((o) => o.id)).toEqual([OTHER_ORG]);
  });

  it("keeps the code only as a hash, ten minutes long", async () => {
    const svc = service();
    const { code, expiresAt } = await svc.createPairingCode(ids.owner, { organizationId: ORG });
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    const rows = JSON.stringify(await prisma!.desktopPairingCode.findMany({ where: { userId: ids.owner } }));
    expect(rows).not.toContain(code);
    expect(rows).not.toContain(code.replace(/-/g, ""));
  });

  it("names the server key with the code, so the person can compare it with what the computer pinned", async () => {
    const svc = service();
    const { code, serverKeyId } = await svc.createPairingCode(ids.owner, { organizationId: ORG });
    expect(serverKeyId).toBe(desktopServerKeyId(SERVER_PUBLIC_KEY));
    const agent = new TestAgent();
    await agent.pair(svc, code);
    expect(agent.serverKeyId).toBe(serverKeyId);
  });

  it("lets exactly one of two agents redeem the same code at once — across two instances", async () => {
    const { code } = await service().createPairingCode(ids.owner, { organizationId: ORG });
    const [a, b] = [new TestAgent(), new TestAgent()];
    const results = await Promise.all([a.pair(service(), code), b.pair(service(second!), code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(results.every((r) => r.verified)).toBe(true);
  });

  it("refuses a used code and an expired one", async () => {
    const svc = service();
    const { code } = await svc.createPairingCode(ids.owner, { organizationId: ORG });
    expect((await new TestAgent().pair(svc, code)).status).toBe(200);
    expect((await new TestAgent().pair(svc, code)).body.error.code).toBe("PAIRING_CODE_INVALID");
    const expired = await svc.createPairingCode(ids.owner, { organizationId: ORG });
    offsetMs = 10 * 60_000 + 1_000;
    expect((await new TestAgent().pair(svc, expired.code)).body.error.code).toBe("PAIRING_CODE_INVALID");
  });

  it("refuses an unsupported Windows build, architecture or agent version (U6)", async () => {
    const svc = service();
    for (const [overrides, code] of [
      [{ windowsBuild: 22631 }, "WINDOWS_VERSION_UNSUPPORTED"],
      [{ architecture: "arm64" }, "WINDOWS_VERSION_UNSUPPORTED"],
      [{ agentVersion: "0.9.9" }, "AGENT_VERSION_UNSUPPORTED"],
    ] as const) {
      const { code: pairing } = await svc.createPairingCode(ids.owner, { organizationId: ORG });
      expect((await new TestAgent().pair(svc, pairing, overrides)).body.error.code).toBe(code);
    }
  });

  it("leaves the device pending — no grant, no command — until its user confirms the fingerprint", async () => {
    const svc = service();
    const agent = new TestAgent();
    const { code } = await svc.createPairingCode(ids.owner, { organizationId: ORG });
    await agent.pair(svc, code);
    expect((await agent.poll(svc)).body).toMatchObject({ device: { status: "pending" }, command: null });
    expect((await agent.grant(svc)).body.error.code).toBe("DEVICE_PENDING");
    expect(await errorOf(svc.requestCommand(ids.owner, agent.deviceId, { action: "desktop.input.key", key: "enter" }))).toBe("DEVICE_NOT_ACTIVE");

    expect(await errorOf(svc.confirmDevice(ids.owner, agent.deviceId, { fingerprint: "0000-0000-0000-0000-0000-0000" }))).toBe("FINGERPRINT_MISMATCH");
    const view = (await svc.listDevices(ids.owner)).find((d) => d.id === agent.deviceId)!;
    expect(await errorOf(svc.confirmDevice(ids.admin, agent.deviceId, { fingerprint: view.fingerprint }))).toBe("NOT_FOUND");
    expect((await svc.confirmDevice(ids.owner, agent.deviceId, { fingerprint: view.fingerprint })).status).toBe("active");
  });

  it("rate-limits redemption attempts from one source, valid codes or not", async () => {
    const svc = service();
    const source = `burst-${STAMP}`;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const agent = new TestAgent();
      agent.source = source;
      statuses.push((await agent.pair(svc, "0000-0000-0000-0000-0000-0000-0000-0000")).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("rate-limits code creation per person", async () => {
    const svc = service(prisma!, { policyLimit: true });
    const results = await Promise.all(Array.from({ length: 8 }, () => svc.createPairingCode(ids.admin, { organizationId: ORG }).then(() => "ok", (e) => (e as DesktopControlError).code)));
    expect(results.filter((r) => r === "RATE_LIMITED").length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.6 — consent (PostgreSQL)", () => {
  it("no consent: no grant, and no command", async () => {
    const svc = service();
    const agent = new TestAgent();
    const { code } = await svc.createPairingCode(ids.owner, { organizationId: ORG });
    await agent.pair(svc, code);
    const view = (await svc.listDevices(ids.owner)).find((d) => d.id === agent.deviceId)!;
    await svc.confirmDevice(ids.owner, agent.deviceId, { fingerprint: view.fingerprint });
    expect(await errorOf(svc.requestCommand(ids.owner, agent.deviceId, { action: "desktop.input.key", key: "enter" }))).toBe("GRANT_REQUIRED");
  });

  it("records the exact text's hash, and refuses consent to a text the server would not have shown", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const grant = await prisma!.desktopGrant.findUnique({ where: { id: agent.grantId! } });
    expect(grant?.consentTextSha256).toBe(
      desktopConsentTextSha256(renderDesktopConsentText({ ...agent.labels, durationMinutes: 15, scope: ["desktop.input.click", "desktop.input.key", "desktop.input.type"] }))
    );
    agent.grantId = null;
    const forged = await agent.grant(svc, { text: "Allow JARVIS to do anything?", replaces: grant!.id });
    expect(forged.body.error.code).toBe("CONSENT_MISMATCH");
  });

  it("defaults to 15 minutes, allows up to 60, never more", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const grant = await prisma!.desktopGrant.findUnique({ where: { id: agent.grantId! } });
    expect(grant!.durationMinutes).toBe(15);
    expect(grant!.expiresAt.getTime() - grant!.grantedAt.getTime()).toBe(15 * 60_000);
    expect((await agent.grant(svc, { durationMinutes: 61, replaces: agent.grantId })).body.error.code).toBe("INVALID_REQUEST");
    expect((await agent.grant(svc, { durationMinutes: 60, replaces: agent.grantId })).status).toBe(200);
  });

  it("extends only by fresh consent naming the grant it replaces", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const first = agent.grantId;
    expect((await agent.grant(svc)).body.error.code).toBe("GRANT_CONFLICT");
    expect((await agent.grant(svc, { replaces: first })).status).toBe(200);
    expect((await prisma!.desktopGrant.findUnique({ where: { id: first! } }))?.endReason).toBe("extended");
  });

  it("refuses commands once the grant has expired, and the next poll ends it", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    offsetMs = 15 * 60_000 + 1_000;
    expect(await errorOf(svc.requestCommand(ids.owner, agent.deviceId, { action: "desktop.input.key", key: "enter" }))).toBe("GRANT_REQUIRED");
    const polled = await agent.poll(svc);
    expect(polled.body.grant).toMatchObject({ status: "ended" });
  });

  it.each([["lock"], ["sign-out"], ["kill-switch"]])("ends the grant when the computer reports %s", async (reason) => {
    const svc = service();
    const agent = await controlledAgent(svc);
    expect((await agent.endSession(svc, reason)).status).toBe(200);
    expect((await prisma!.desktopGrant.findUnique({ where: { id: agent.grantId! } }))?.endReason).toBe(reason);
    expect(await errorOf(svc.requestCommand(ids.owner, agent.deviceId, { action: "desktop.input.key", key: "enter" }))).toBe("GRANT_REQUIRED");
  });

  it("ends the grant when the agent restarts — another process asks", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    agent.instance = randomUUID();
    const polled = await agent.poll(svc);
    expect(polled.body.grant).toMatchObject({ grantId: agent.grantId, status: "ended" });
    expect((await prisma!.desktopGrant.findUnique({ where: { id: agent.grantId! } }))?.endReason).toBe("restart");
  });

  it("survives a reconnection within 30 seconds, and not beyond", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    offsetMs = 29_000;
    expect((await agent.poll(svc)).body.grant).toMatchObject({ status: "active" });
    offsetMs = 29_000 + 31_000;
    expect((await agent.poll(svc)).body.grant).toMatchObject({ status: "ended" });
    expect((await prisma!.desktopGrant.findUnique({ where: { id: agent.grantId! } }))?.endReason).toBe("disconnected");
  });

  it("refuses a new command 30 seconds after the last contact, with no poll needed to end the grant", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    offsetMs = 29_000;
    const asked = await svc.requestCommand(ids.owner, agent.deviceId, { action: "desktop.input.key", key: "enter" });
    offsetMs = 31_000;
    expect(await errorOf(svc.requestCommand(ids.owner, agent.deviceId, { action: "desktop.input.key", key: "enter" }))).toBe("GRANT_REQUIRED");
    // Nor can one asked for in time be sent now: what the person approved stays unsent.
    expect(await errorOf(svc.confirmCommand(ids.owner, agent.deviceId, asked.approvalId))).toBe("GRANT_REQUIRED");
  });

  it("ends a grant the agent's poll does not name: the two sides must agree", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const started = agent.grantId;
    agent.grantId = null;
    expect((await agent.poll(svc)).body.grant).toBeNull();
    expect((await prisma!.desktopGrant.findUnique({ where: { id: started! } }))?.endReason).toBe("mismatch");
    expect(await errorOf(svc.requestCommand(ids.owner, agent.deviceId, { action: "desktop.input.key", key: "enter" }))).toBe("GRANT_REQUIRED");
  });

  it("counts the answer to a command as contact: a command that takes most of its 30 seconds keeps the grant", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const { command } = await issue(svc, agent, { action: "desktop.input.key", key: "enter" });
    expect((await agent.poll(svc)).body.command?.commandId).toBe(command.id);
    // Windows Hello, say, takes 25 seconds; the answer comes, then the next poll.
    offsetMs = 25_000;
    expect((await agent.result(svc, command.id, { outcome: "succeeded" })).status).toBe(200);
    offsetMs = 50_000;
    expect((await agent.poll(svc)).body.grant).toMatchObject({ grantId: agent.grantId, status: "active" });
  });

  it("counts a delivery at the end of a held poll as contact, not the poll's start", async () => {
    const svc = service(prisma!, { holdMs: 1_500 });
    const agent = await controlledAgent(svc);
    // The poll waits; 20 seconds into it (by the server's clock) a command arrives.
    const held = agent.poll(svc);
    await new Promise((resolve) => setTimeout(resolve, 200));
    offsetMs = 20_000;
    const { command } = await issue(svc, agent, { action: "desktop.input.key", key: "enter" });
    expect((await held).body.command?.commandId).toBe(command.id);
    // 24 seconds after the delivery — 44 after the poll began — the grant holds.
    offsetMs = 44_000;
    expect((await agent.poll(svc)).body.grant).toMatchObject({ grantId: agent.grantId, status: "active" });
  });

  it("replays nothing after a reconnection: a command issued before it is never delivered", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const { command } = await issue(svc, agent, { action: "desktop.input.key", key: "enter" });
    offsetMs = 27_000;
    const polled = await agent.poll(svc);
    expect(polled.body.grant).toMatchObject({ status: "active" });
    expect(polled.body.command).toBeNull();
    expect((await svc.getCommand(ids.owner, command.id)).status).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.6 — revocation (PostgreSQL)", () => {
  it("a revoked device cannot poll, be commanded or answer — told so in a signed answer", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const { command } = await issue(svc, agent, { action: "desktop.input.key", key: "enter" });
    const delivered = await agent.poll(svc);
    expect(delivered.body.command?.commandId).toBe(command.id);
    await svc.revokeDevice(ids.owner, agent.deviceId);
    const polled = await agent.poll(svc);
    expect(polled).toMatchObject({ status: 403, verified: true, body: { error: { code: "DEVICE_REVOKED" } } });
    expect((await agent.result(svc, command.id, { outcome: "succeeded" })).body.error.code).toBe("DEVICE_REVOKED");
    expect(await errorOf(svc.requestCommand(ids.owner, agent.deviceId, { action: "desktop.input.key", key: "enter" }))).toBe("DEVICE_NOT_ACTIVE");
    // Delivered and never answered: UNKNOWN on the sweep, never sent again.
    offsetMs = 61_000;
    await svc.sweep();
    expect((await svc.getCommand(ids.owner, command.id)).status).toBe("unknown");
  });

  it("reports a revoked device's refused request once, by its hash, and writes nothing for a forged one", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    await svc.revokeDevice(ids.owner, agent.deviceId);

    const before = agentLines.length;
    expect((await agent.poll(svc)).body.error.code).toBe("DEVICE_REVOKED");
    const written = agentLines.slice(before);
    expect(written.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: "desktop.agent.refused", route: "poll", status: 403, code: "DEVICE_REVOKED", deviceIdHash: sha256Hex(agent.deviceId).slice(0, 16) }),
    ]);
    expect(written.join("\n")).not.toContain(agent.deviceId);

    const afterRefusal = agentLines.length;
    const stranger = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    expect((await agent.send(svc, "poll", {}, { signWith: stranger })).status).toBe(401);
    expect(agentLines).toHaveLength(afterRefusal);
  });

  it("is for the device's user or an Owner/Admin of its Organization — no one else", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    expect(await errorOf(svc.revokeDevice(ids.member, agent.deviceId))).toBe("NOT_FOUND");
    expect(await errorOf(svc.revokeDevice(ids.outsider, agent.deviceId))).toBe("NOT_FOUND");
    await svc.revokeDevice(ids.admin, agent.deviceId);
    expect((await prisma!.desktopDevice.findUnique({ where: { id: agent.deviceId } }))?.status).toBe("REVOKED");
  });

  it("removing the user from the Organization stops the device at once", async () => {
    const svc = service();
    const user = await prisma!.user.create({ data: { email: `p196-leaver-${STAMP}@jarvis-test.local`, name: "Leaver", password: "x", role: "VIEWER" } });
    userIds.push(user.id);
    await adminRun({ verb: "add-member", tenantId: ORG, userId: user.id, role: "admin" });
    const agent = new TestAgent();
    const { code } = await svc.createPairingCode(user.id, { organizationId: ORG });
    await agent.pair(svc, code);
    const view = (await svc.listDevices(user.id)).find((d) => d.id === agent.deviceId)!;
    await svc.confirmDevice(user.id, agent.deviceId, { fingerprint: view.fingerprint });
    await agent.grant(svc);

    await adminRun({ verb: "set-role", tenantId: ORG, userId: user.id, role: "member" });
    expect((await agent.poll(svc)).body.error.code).toBe("NOT_AUTHORIZED");
    expect((await prisma!.desktopGrant.findUnique({ where: { id: agent.grantId! } }))?.endReason).toBe("membership");
    expect(await errorOf(svc.requestCommand(user.id, agent.deviceId, { action: "desktop.input.key", key: "enter" }))).toBe("NOT_AUTHORIZED");
    await adminRun({ verb: "remove-member", tenantId: ORG, userId: user.id });
    expect((await agent.poll(svc)).body.error.code).toBe("NOT_AUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.6 — request authentication (PostgreSQL)", () => {
  it("refuses a nonce replayed on another API instance", async () => {
    const agent = await controlledAgent();
    const nonce = randomBytes(18).toString("base64url");
    const first = await agent.send(service(), "poll", pollBody(agent), { nonce });
    const replayed = await agent.send(service(second!), "poll", pollBody(agent), { nonce });
    expect(first.status).toBe(200);
    expect(replayed.body.error.code).toBe("REPLAY_DETECTED");
  });

  it.each([
    ["another key's signature", (_a: TestAgent) => ({ signWith: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey }), "UNAUTHENTICATED"],
    ["a body other than the one signed", (a: TestAgent) => ({ rawBody: Buffer.from(JSON.stringify({ ...pollBody(a), grantId: null, x: 1 })) }), "UNAUTHENTICATED"],
    ["another path", () => ({ path: "/api/v1/desktop-agent/grants" }), "UNAUTHENTICATED"],
    ["a stale timestamp", () => ({ timestamp: Date.now() - 61_000 }), "REQUEST_EXPIRED"],
    ["another protocol version", () => ({ version: "jarvis-desktop/2" }), "UNSUPPORTED_VERSION"],
  ])("refuses %s", async (_label, opts, code) => {
    const agent = await controlledAgent();
    const res = await agent.send(service(), "poll", pollBody(agent), opts(agent));
    expect(res.body.error.code).toBe(code);
    expect(res.verified).toBe(true);
  });

  it("keeps one person's devices from another — listing and commanding", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    expect((await svc.listDevices(ids.outsider)).map((d) => d.id)).not.toContain(agent.deviceId);
    expect(await errorOf(svc.requestCommand(ids.admin, agent.deviceId, { action: "desktop.input.key", key: "enter" }))).toBe("NOT_FOUND");
    expect(await errorOf(svc.requestCommand(ids.outsider, agent.deviceId, { action: "desktop.input.key", key: "enter" }))).toBe("NOT_FOUND");
  });

  it.each([
    [{ action: "desktop.screen.read" }],
    [{ action: "desktop.shell", command: "whoami" }],
    [{ action: "desktop.input.key", key: "f4" }],
    [{ action: "desktop.input.type", text: "line\nbreak" }],
    [{ action: "desktop.input.click", x: 1, y: 1, extra: true }],
  ])("refuses a command outside the allowlist or its schema: %j", async (request) => {
    const svc = service();
    const agent = await controlledAgent(svc);
    expect(await errorOf(svc.requestCommand(ids.owner, agent.deviceId, request))).toBe("INVALID_REQUEST");
  });

  it("an approval for one device cannot be spent on another", async () => {
    const svc = service();
    const a = await controlledAgent(svc);
    const b = await controlledAgent(svc);
    const asked = await svc.requestCommand(ids.owner, a.deviceId, { action: "desktop.input.key", key: "enter" });
    expect(await errorOf(svc.confirmCommand(ids.owner, b.deviceId, asked.approvalId))).toBe("APPROVAL_INVALID");
  });

  it("only acts within the grant's scope", async () => {
    const svc = service();
    const agent = await controlledAgent(svc, ["desktop.input.key"]);
    expect(await errorOf(svc.requestCommand(ids.owner, agent.deviceId, { action: "desktop.input.click", x: 1, y: 1 }))).toBe("GRANT_REQUIRED");
  });
});

function pollBody(agent: TestAgent) {
  return { version: DESKTOP_PROTOCOL_VERSION, agentInstanceId: agent.instance, agentVersion: DESKTOP_AGENT_CURRENT_VERSION, windowsBuild: 26100, grantId: agent.grantId };
}

// ---------------------------------------------------------------------------
// Commands and outcomes
// ---------------------------------------------------------------------------

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.6 — commands and outcomes (PostgreSQL)", () => {
  it("delivers a signed command once, records a confirmed result, and the journal agrees", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const { command } = await issue(svc, agent, { action: "desktop.input.click", x: 640, y: 360 });
    const polled = await agent.poll(svc);
    const envelope = DesktopCommandEnvelopeSchema.parse(polled.body.command);
    expect(envelope).toMatchObject({ commandId: command.id, action: "desktop.input.click", params: { x: 640, y: 360, button: "left" }, requiresHello: false });
    expect(envelope.expiresAt - envelope.issuedAt).toBe(30_000);
    const canonical = desktopCommandCanonical({ ...envelope, params: { action: envelope.action, ...envelope.params } as never });
    expect(verifyDesktopCanonical(agent.serverKey!, canonical, envelope.signature)).toBe(true);
    // A tampered command does not verify.
    expect(verifyDesktopCanonical(agent.serverKey!, canonical.replace("x=640", "x=641"), envelope.signature)).toBe(false);
    expect((await agent.poll(svc)).body.command).toBeNull();

    expect((await agent.result(svc, command.id, { outcome: "succeeded" })).status).toBe(200);
    expect((await agent.result(svc, command.id, { outcome: "succeeded" })).body.error.code).toBe("CONFLICT");
    const record = await prisma!.desktopCommand.findUnique({ where: { id: command.id } });
    expect(record?.status).toBe("SUCCEEDED");
    expect((await prisma!.toolExecution.findUnique({ where: { executionId: record!.executionId! } }))?.status).toBe("SUCCEEDED");
  });

  it("types only through Windows Hello at the device — approving in the web UI is not enough — and stores nothing typed", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const asked = await svc.requestCommand(ids.owner, agent.deviceId, { action: "desktop.input.type", text: SECRET });
    expect(asked.requiresHello).toBe(true);
    expect(JSON.stringify(asked)).not.toContain(SECRET);
    // An approval decided in the browser (as an injected click could) still
    // yields a command the device runs only after Windows Hello.
    const decided = await prisma!.approval.findUnique({ where: { id: asked.approvalId } });
    expect(decided?.status).toBe("PENDING");
    const command = await svc.confirmCommand(ids.owner, agent.deviceId, asked.approvalId);
    expect(command.requiresHello).toBe(true);
    const envelope = DesktopCommandEnvelopeSchema.parse((await agent.poll(svc)).body.command);
    expect(envelope).toMatchObject({ action: "desktop.input.type", requiresHello: true, params: { text: SECRET } });
    // The device refuses without Hello; the server records that nothing ran.
    await agent.result(svc, command.id, { outcome: "not-executed", code: "HELLO_UNAVAILABLE" });
    expect((await svc.getCommand(ids.owner, command.id)).status).toBe("not_executed");

    const stored = await rowsText();
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(Buffer.from(SECRET).toString("base64url"));
  });

  it("a lost answer is UNKNOWN — never sent again, never a second run of the same approval", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const { approvalId, command } = await issue(svc, agent, { action: "desktop.input.key", key: "enter" });
    expect((await agent.poll(svc)).body.command?.commandId).toBe(command.id);
    // No answer comes back.
    offsetMs = 61_000;
    expect((await svc.sweep()).unknown).toBeGreaterThanOrEqual(1);
    const record = await prisma!.desktopCommand.findUnique({ where: { id: command.id } });
    expect(record?.status).toBe("UNKNOWN");
    expect((await prisma!.toolExecution.findUnique({ where: { executionId: record!.executionId! } }))?.status).toBe("UNKNOWN");
    // Not on the next poll, not from the same approval, and a late answer changes nothing.
    offsetMs = 0;
    agent.grantId = null;
    expect((await agent.result(svc, command.id, { outcome: "succeeded" })).body.error.code).toBe("CONFLICT");
    expect(await errorOf(svc.confirmCommand(ids.owner, agent.deviceId, approvalId))).not.toBe("");
    expect((await svc.getCommand(ids.owner, command.id)).status).toBe("unknown");
  });

  it("an agent that was interrupted while acting reports uncertainty, which is UNKNOWN too", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const { command } = await issue(svc, agent, { action: "desktop.input.key", key: "enter" });
    await agent.poll(svc);
    await agent.result(svc, command.id, { outcome: "uncertain" });
    expect((await svc.getCommand(ids.owner, command.id)).status).toBe("unknown");
  });

  it("a command never delivered in time expires; nothing reached the computer", async () => {
    const svc = service();
    const agent = await controlledAgent(svc);
    const { command } = await issue(svc, agent, { action: "desktop.input.key", key: "enter" });
    offsetMs = 31_000;
    await svc.sweep();
    const record = await prisma!.desktopCommand.findUnique({ where: { id: command.id } });
    expect(record?.status).toBe("EXPIRED");
    expect((await prisma!.toolExecution.findUnique({ where: { executionId: record!.executionId! } }))?.status).toBe("FAILED");
    expect(await prisma!.desktopCommandPayload.findUnique({ where: { commandId: command.id } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Over real HTTP: the router hands the service the exact bytes and path the
// agent signed, and sends back exactly the bytes the server signed.
// ---------------------------------------------------------------------------

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.6 — the agent router over HTTP (PostgreSQL)", () => {
  it("authenticates the raw body, and answers with the signed bytes — even behind compression", async () => {
    const express = (await import("express")).default;
    const compression = (await import("compression")).default;
    const helmet = (await import("helmet")).default;
    const { createDesktopAgentRouter } = await import("../src/routes/desktop-agent.js");
    const svc = service();
    const app = express();
    app.use(helmet());
    app.use(compression());
    app.use("/api/v1/desktop-agent", createDesktopAgentRouter(svc));
    app.use(express.json());
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      const agent = new TestAgent();
      const { code } = await svc.createPairingCode(ids.owner, { organizationId: ORG });
      const body = JSON.stringify({
        version: DESKTOP_PROTOCOL_VERSION,
        pairingCode: code,
        publicKey: agent.publicKey,
        deviceName: "HTTP-TEST",
        agentVersion: DESKTOP_AGENT_CURRENT_VERSION,
        windowsBuild: 26100,
        architecture: "x64",
      });
      const parts = {
        method: "POST",
        path: "/api/v1/desktop-agent/pair",
        timestamp: String(clock().getTime()),
        nonce: randomBytes(18).toString("base64url"),
        device: "pairing",
        bodySha256: sha256Hex(body),
      };
      const res = await fetch(`http://127.0.0.1:${port}${parts.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept-encoding": "gzip",
          [DESKTOP_AGENT_HEADERS.version]: DESKTOP_PROTOCOL_VERSION,
          [DESKTOP_AGENT_HEADERS.device]: parts.device,
          [DESKTOP_AGENT_HEADERS.timestamp]: parts.timestamp,
          [DESKTOP_AGENT_HEADERS.nonce]: parts.nonce,
          [DESKTOP_AGENT_HEADERS.bodySha256]: parts.bodySha256,
          [DESKTOP_AGENT_HEADERS.signature]: signDesktopCanonical(agent.key, desktopRequestCanonical(parts)),
        },
        body,
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      const canonical = desktopResponseCanonical({ requestNonce: parts.nonce, status: 200, bodySha256: sha256Hex(text) });
      expect(verifyDesktopCanonical(SERVER_PUBLIC_KEY, canonical, res.headers.get(DESKTOP_AGENT_HEADERS.responseSignature))).toBe(true);
      expect(JSON.parse(text)).toMatchObject({ status: "pending", serverPublicKey: SERVER_PUBLIC_KEY });

      // A query string is not part of any route the agent may call: signed with it or not, refused.
      const queriedParts = { ...parts, path: "/api/v1/desktop-agent/pair?x=1", nonce: randomBytes(18).toString("base64url") };
      const queried = await fetch(`http://127.0.0.1:${port}${queriedParts.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [DESKTOP_AGENT_HEADERS.version]: DESKTOP_PROTOCOL_VERSION,
          [DESKTOP_AGENT_HEADERS.device]: queriedParts.device,
          [DESKTOP_AGENT_HEADERS.timestamp]: queriedParts.timestamp,
          [DESKTOP_AGENT_HEADERS.nonce]: queriedParts.nonce,
          [DESKTOP_AGENT_HEADERS.bodySha256]: queriedParts.bodySha256,
          [DESKTOP_AGENT_HEADERS.signature]: signDesktopCanonical(agent.key, desktopRequestCanonical(queriedParts)),
        },
        body,
      });
      expect(queried.status).toBe(401);
      expect(await queried.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    } finally {
      server.close();
    }
  });
});
