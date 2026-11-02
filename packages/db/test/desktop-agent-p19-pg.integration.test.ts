// ---------------------------------------------------------------------------
// Phase 19, Stage 19.6 — the desktop agent's durable state, on PostgreSQL.
//
// Every guarantee the store makes is about two callers at once — two API
// instances, or two requests — so each is driven from two connection pools:
// a code redeemed once, a nonce spent once, a command delivered once and
// answered once, a device with at most one active grant. And what a revocation,
// an expiry, a restart or a disconnect leaves behind, read from the rows.
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

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

type Client = InstanceType<(typeof import("@prisma/client"))["PrismaClient"]>;
type RepoModule = typeof import("../src/repositories/desktop-repository.js");

let prisma: Client | null = null;
let second: Client | null = null;
let mod: RepoModule | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  const Prisma = await import("@prisma/client");
  mod = await import("../src/repositories/desktop-repository.js");
  prisma = new Prisma.PrismaClient();
  second = new Prisma.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    await second.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const userIds: string[] = [];
const tenantIds: string[] = [];
const ids = { owner: "", other: "" };
const orgs = { a: "", b: "" };

const repo = (client = prisma!) => new mod!.PrismaDesktopRepository(client);
const now = () => new Date();
const later = (ms: number) => new Date(Date.now() + ms);

let seq = 0;
const newDevice = () => ({
  publicKey: `pk-${STAMP}-${seq}`,
  fingerprint: `${STAMP}-${seq++}`.padEnd(64, "0").slice(0, 64),
  displayName: "WORKSTATION",
  agentVersion: "1.0.0",
  windowsBuild: 26100,
});

async function code(tenantId = orgs.a, userId = ids.owner, ttlMs = 600_000) {
  const codeHash = `hash-${STAMP}-${seq++}`;
  await repo().createPairingCode({ codeHash, userId, tenantId, expiresAt: later(ttlMs) });
  return codeHash;
}

/** A paired, confirmed device of `orgs.a`'s owner. */
async function activeDevice() {
  const redeemed = await repo().redeemPairingCode({ codeHash: await code(), now: now(), device: newDevice() });
  if (!redeemed.ok) throw new Error("fixture");
  await repo().confirmDevice({ deviceId: redeemed.device.id, userId: ids.owner, fingerprint: redeemed.device.fingerprint, now: now() });
  return redeemed.device;
}

const grantFields = (overrides: Partial<{ id: string; agentInstanceId: string; scope: string[]; expiresAt: Date; lastContactAt: Date }> = {}) => ({
  id: overrides.id ?? randomUUID(),
  agentInstanceId: overrides.agentInstanceId ?? "instance-1",
  scope: overrides.scope ?? ["desktop.input.click", "desktop.input.type"],
  durationMinutes: 15,
  consentTextVersion: "desktop-consent/1",
  consentTextSha256: "c".repeat(64),
  grantedAt: now(),
  expiresAt: overrides.expiresAt ?? later(15 * 60_000),
  lastContactAt: overrides.lastContactAt ?? now(),
});

async function issued(deviceId: string, grantId: string, overrides: Partial<{ action: string; expiresAt: Date }> = {}) {
  const result = await repo().issueCommand({
    deviceId,
    grantId,
    action: overrides.action ?? "desktop.input.click",
    paramsHash: "p".repeat(64),
    requiresHello: false,
    approvalId: null,
    executionId: null,
    expiresAt: overrides.expiresAt ?? later(30_000),
    sealed: "SEALED-OPAQUE",
    now: now(),
    graceMs: 30_000,
  });
  if (!result.ok) throw new Error(`fixture: ${result.reason}`);
  return result.command;
}

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) throw new Error("These tests need a separate PostgreSQL test database, and none could be reached.");
  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const user = await prisma!.user.create({
      data: { email: `p196-${name}-${STAMP}@jarvis-test.local`, name: `Ada\n${name}`, password: "x", role: "OWNER" },
    });
    ids[name] = user.id;
    userIds.push(user.id);
  }
  for (const name of Object.keys(orgs) as Array<keyof typeof orgs>) {
    const tenant = await prisma!.tenant.create({ data: { name: `Org ${name} ${STAMP}` } });
    orgs[name] = tenant.id;
    tenantIds.push(tenant.id);
  }
});

afterAll(async () => {
  if (prisma) {
    await prisma.desktopDevice.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await prisma.desktopPairingCode.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
    await prisma.desktopRequestNonce.deleteMany({ where: { scope: { startsWith: `scope-${STAMP}` } } }).catch(() => undefined);
    await prisma.desktopPairingAttempt.deleteMany({ where: { sourceHash: { startsWith: `src-${STAMP}` } } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  if (second) await second.$disconnect();
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.6 — desktop pairing on PostgreSQL", () => {
  it("redeems a code exactly once when two instances redeem it together", async () => {
    const codeHash = await code();
    const results = await Promise.all([
      repo().redeemPairingCode({ codeHash, now: now(), device: newDevice() }),
      repo(second!).redeemPairingCode({ codeHash, now: now(), device: newDevice() }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "INVALID" }]);
  });

  it("refuses an expired code and a used one", async () => {
    const expired = `hash-${STAMP}-expired`;
    await repo().createPairingCode({ codeHash: expired, userId: ids.owner, tenantId: orgs.a, expiresAt: new Date(Date.now() - 1) });
    expect(await repo().redeemPairingCode({ codeHash: expired, now: now(), device: newDevice() })).toEqual({ ok: false, reason: "INVALID" });

    const used = await code();
    expect((await repo().redeemPairingCode({ codeHash: used, now: now(), device: newDevice() })).ok).toBe(true);
    expect(await repo().redeemPairingCode({ codeHash: used, now: now(), device: newDevice() })).toEqual({ ok: false, reason: "INVALID" });
  });

  it("gives the device to the code's user and Organization, pending, with printable labels", async () => {
    const result = await repo().redeemPairingCode({ codeHash: await code(orgs.b), now: now(), device: newDevice() });
    if (!result.ok) throw new Error("expected a device");
    expect(result.device).toMatchObject({ userId: ids.owner, tenantId: orgs.b, status: "pending", userLabel: "Ada owner" });
    expect(result.device.organizationLabel).toBe(`Org b ${STAMP}`);
  });

  it("refuses a key already paired, and leaves that code unspent", async () => {
    const device = newDevice();
    expect((await repo().redeemPairingCode({ codeHash: await code(), now: now(), device })).ok).toBe(true);
    const codeHash = await code();
    expect(await repo().redeemPairingCode({ codeHash, now: now(), device })).toEqual({ ok: false, reason: "KEY_IN_USE" });
    expect((await prisma!.desktopPairingCode.findUnique({ where: { codeHash } }))?.consumedAt).toBeNull();
  });

  it("activates a device only for its own user, only for its fingerprint, only once", async () => {
    const result = await repo().redeemPairingCode({ codeHash: await code(), now: now(), device: newDevice() });
    if (!result.ok) throw new Error("expected a device");
    const { id, fingerprint } = result.device;
    expect(await repo().confirmDevice({ deviceId: id, userId: ids.other, fingerprint, now: now() })).toBe(false);
    expect(await repo().confirmDevice({ deviceId: id, userId: ids.owner, fingerprint: "f".repeat(64), now: now() })).toBe(false);
    expect(await repo().confirmDevice({ deviceId: id, userId: ids.owner, fingerprint, now: now() })).toBe(true);
    expect(await repo().confirmDevice({ deviceId: id, userId: ids.owner, fingerprint, now: now() })).toBe(false);
    expect((await repo().findDevice(id))?.status).toBe("active");
  });

  it("holds redemption attempts from one source to the limit, however many arrive at once", async () => {
    const sourceHash = `src-${STAMP}-burst`;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_v, i) =>
        repo(i % 2 ? second! : prisma!).reservePairingAttempt({ sourceHash, limit: 5, windowMs: 60_000, now: now() })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("shows a person their own devices and their administered Organizations' — no others", async () => {
    const mine = await activeDevice();
    const other = await repo().redeemPairingCode({ codeHash: await code(orgs.b, ids.other), now: now(), device: newDevice() });
    if (!other.ok) throw new Error("fixture");
    const asOwner = (await repo().listDevices({ userId: ids.owner, adminTenantIds: [] })).map((d) => d.id);
    expect(asOwner).toContain(mine.id);
    expect(asOwner).not.toContain(other.device.id);
    const asAdminOfB = (await repo().listDevices({ userId: ids.owner, adminTenantIds: [orgs.b] })).map((d) => d.id);
    expect(asAdminOfB).toContain(other.device.id);
  });
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.6 — replay protection on PostgreSQL", () => {
  it("spends a nonce once across two instances, and keeps scopes apart", async () => {
    const entry = { scope: `scope-${STAMP}-1`, nonceHash: "n".repeat(64), expiresAt: later(120_000) };
    const results = await Promise.all([repo().consumeNonce(entry), repo(second!).consumeNonce(entry)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await repo().consumeNonce({ ...entry, scope: `scope-${STAMP}-2` })).toBe(true);
    expect(await repo().consumeNonce(entry)).toBe(false);
  });
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.6 — grants on PostgreSQL", () => {
  it("refuses consent on a pending device", async () => {
    const pending = await repo().redeemPairingCode({ codeHash: await code(), now: now(), device: newDevice() });
    if (!pending.ok) throw new Error("fixture");
    expect(await repo().startGrant({ deviceId: pending.device.id, grant: grantFields(), replacesGrantId: null })).toEqual({ ok: false, reason: "DEVICE_INACTIVE" });
  });

  it("keeps one active grant per device, even when two arrive together", async () => {
    const device = await activeDevice();
    const results = await Promise.all([
      repo().startGrant({ deviceId: device.id, grant: grantFields(), replacesGrantId: null }),
      repo(second!).startGrant({ deviceId: device.id, grant: grantFields(), replacesGrantId: null }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "CONFLICT" }]);
  });

  it("extends only by fresh consent that names the grant it replaces", async () => {
    const device = await activeDevice();
    const first = await repo().startGrant({ deviceId: device.id, grant: grantFields(), replacesGrantId: null });
    if (!first.ok) throw new Error("fixture");
    expect((await repo().startGrant({ deviceId: device.id, grant: grantFields(), replacesGrantId: randomUUID() })).ok).toBe(false);
    const extended = await repo().startGrant({ deviceId: device.id, grant: grantFields(), replacesGrantId: first.grant.id });
    expect(extended.ok).toBe(true);
    expect(await repo().findGrant(first.grant.id)).toMatchObject({ status: "ended", endReason: "extended" });
  });

  it.each([
    ["another agent process: a restart", { agentInstanceId: "instance-1" }, "instance-2", "restart"],
    ["past its expiry", { expiresAt: new Date(Date.now() - 1) }, "instance-1", "expired"],
    ["silent past the 30-second grace", { lastContactAt: new Date(Date.now() - 31_000) }, "instance-1", "disconnected"],
  ])("ends the grant on a poll from %s, and expires its undelivered commands", async (_label, overrides, pollInstance, reason) => {
    const device = await activeDevice();
    const started = await repo().startGrant({ deviceId: device.id, grant: grantFields(), replacesGrantId: null });
    if (!started.ok) throw new Error("fixture");
    const command = await issued(device.id, started.grant.id);
    await prisma!.desktopGrant.update({ where: { id: started.grant.id }, data: overrides });
    const polled = await repo().pollGrant({ deviceId: device.id, agentInstanceId: pollInstance, now: now(), graceMs: 30_000, gapMs: 25_000 });
    expect(polled.ended).toEqual({ id: started.grant.id, reason });
    expect(polled.expired.map((c) => c.id)).toEqual([command.id]);
    expect((await repo().findCommand(command.id))?.status).toBe("expired");
  });

  it("keeps a grant through a short reconnection, but never a command issued before it", async () => {
    const device = await activeDevice();
    const started = await repo().startGrant({ deviceId: device.id, grant: grantFields(), replacesGrantId: null });
    if (!started.ok) throw new Error("fixture");
    const command = await issued(device.id, started.grant.id);
    await prisma!.desktopGrant.update({ where: { id: started.grant.id }, data: { lastContactAt: new Date(Date.now() - 27_000) } });
    const polled = await repo().pollGrant({ deviceId: device.id, agentInstanceId: "instance-1", now: now(), graceMs: 30_000, gapMs: 25_000 });
    expect(polled.ended).toBeNull();
    expect(polled.grant?.status).toBe("active");
    expect(polled.expired.map((c) => c.id)).toEqual([command.id]);
    expect(await repo().claimNextCommand({ deviceId: device.id, now: now() })).toBeNull();
  });

  it("records contact only on the device's own active grant, and never revives an ended one", async () => {
    const device = await activeDevice();
    const other = await activeDevice();
    const started = await repo().startGrant({ deviceId: device.id, grant: grantFields(), replacesGrantId: null });
    if (!started.ok) throw new Error("fixture");
    expect(await repo().touchGrant({ deviceId: other.id, grantId: started.grant.id, now: now() })).toBe(false);
    expect(await repo().touchGrant({ deviceId: device.id, grantId: started.grant.id, now: now() })).toBe(true);
    await repo().endGrant({ deviceId: device.id, grantId: started.grant.id, reason: "user", now: now() });
    expect(await repo().touchGrant({ deviceId: device.id, grantId: started.grant.id, now: now() })).toBe(false);
    expect((await repo().findGrant(started.grant.id))?.status).toBe("ended");
  });
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 19.6 — commands on PostgreSQL", () => {
  async function deviceWithGrant(scope?: string[]) {
    const device = await activeDevice();
    const started = await repo().startGrant({ deviceId: device.id, grant: grantFields(scope ? { scope } : {}), replacesGrantId: null });
    if (!started.ok) throw new Error("fixture");
    return { device, grant: started.grant };
  }

  it("issues only inside the grant's scope, and only while it is active", async () => {
    const { device, grant } = await deviceWithGrant(["desktop.input.click"]);
    const base = { deviceId: device.id, grantId: grant.id, paramsHash: "p".repeat(64), requiresHello: false, approvalId: null, executionId: null, expiresAt: later(30_000), sealed: "S", now: now(), graceMs: 30_000 };
    expect(await repo().issueCommand({ ...base, action: "desktop.input.type" })).toEqual({ ok: false, reason: "OUT_OF_SCOPE" });
    await repo().endGrant({ deviceId: device.id, grantId: grant.id, reason: "user", now: now() });
    expect(await repo().issueCommand({ ...base, action: "desktop.input.click" })).toEqual({ ok: false, reason: "GRANT_INACTIVE" });
  });

  it("delivers a command once across two instances, and deletes its sealed payload as it does", async () => {
    const { device, grant } = await deviceWithGrant();
    const command = await issued(device.id, grant.id);
    const claims = await Promise.all([
      repo().claimNextCommand({ deviceId: device.id, now: now() }),
      repo(second!).claimNextCommand({ deviceId: device.id, now: now() }),
    ]);
    const won = claims.filter(Boolean);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ command: { id: command.id, status: "delivered" }, sealed: "SEALED-OPAQUE" });
    expect(await prisma!.desktopCommandPayload.findUnique({ where: { commandId: command.id } })).toBeNull();
    expect(await repo().claimNextCommand({ deviceId: device.id, now: now() })).toBeNull();
  });

  it("never delivers an expired command, or one whose grant has ended", async () => {
    const { device, grant } = await deviceWithGrant();
    await issued(device.id, grant.id, { expiresAt: new Date(Date.now() + 5) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await repo().claimNextCommand({ deviceId: device.id, now: now() })).toBeNull();

    const other = await deviceWithGrant();
    const command = await issued(other.device.id, other.grant.id);
    await prisma!.desktopGrant.update({ where: { id: other.grant.id }, data: { status: "ENDED" } });
    expect(await repo().claimNextCommand({ deviceId: other.device.id, now: now() })).toBeNull();
    expect((await repo().findCommand(command.id))?.status).toBe("issued");
  });

  it("takes one answer, from the device the command was for", async () => {
    const { device, grant } = await deviceWithGrant();
    const command = await issued(device.id, grant.id);
    await repo().claimNextCommand({ deviceId: device.id, now: now() });
    expect(await repo().completeCommand({ commandId: command.id, deviceId: randomUUID(), status: "SUCCEEDED", resultCode: null, now: now() })).toBeNull();
    const answers = await Promise.all([
      repo().completeCommand({ commandId: command.id, deviceId: device.id, status: "SUCCEEDED", resultCode: null, now: now() }),
      repo(second!).completeCommand({ commandId: command.id, deviceId: device.id, status: "NOT_EXECUTED", resultCode: "HELLO_FAILED", now: now() }),
    ]);
    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it("revokes once: the grant ends, undelivered commands expire with their payloads, a delivered one waits for the sweep", async () => {
    const { device, grant } = await deviceWithGrant();
    const delivered = await issued(device.id, grant.id);
    await repo().claimNextCommand({ deviceId: device.id, now: now() });
    const waiting = await issued(device.id, grant.id);
    const result = await repo().revokeDevice({ deviceId: device.id, revokedById: ids.owner, now: now() });
    expect(result.revoked).toBe(true);
    expect(result.expired.map((c) => c.id)).toEqual([waiting.id]);
    expect(await prisma!.desktopCommandPayload.findUnique({ where: { commandId: waiting.id } })).toBeNull();
    expect((await repo().findGrant(grant.id))?.endReason).toBe("revoked");
    expect((await repo().findCommand(delivered.id))?.status).toBe("delivered");
    expect((await repo().revokeDevice({ deviceId: device.id, revokedById: ids.owner, now: now() })).revoked).toBe(false);
    expect(await repo().issueCommand({ deviceId: device.id, grantId: grant.id, action: "desktop.input.click", paramsHash: "p", requiresHello: false, approvalId: null, executionId: null, expiresAt: later(30_000), sealed: "S", now: now(), graceMs: 30_000 })).toEqual({ ok: false, reason: "DEVICE_INACTIVE" });
  });

  it("sweeps: never delivered is EXPIRED, delivered and unanswered is UNKNOWN — once", async () => {
    const { device, grant } = await deviceWithGrant();
    const neverDelivered = await issued(device.id, grant.id, { expiresAt: new Date(Date.now() + 50) });
    const unanswered = await issued(device.id, grant.id, { expiresAt: new Date(Date.now() + 200) });
    await prisma!.desktopCommand.update({ where: { id: unanswered.id }, data: { status: "DELIVERED", deliveredAt: now() } });
    await new Promise((resolve) => setTimeout(resolve, 260));
    const swept = await repo().sweepCommands({ now: now(), resultGraceMs: 0 });
    expect(swept.expired.map((c) => c.id)).toContain(neverDelivered.id);
    expect(swept.unknown.map((c) => c.id)).toContain(unanswered.id);
    expect((await repo().findCommand(unanswered.id))?.status).toBe("unknown");
    const again = await repo().sweepCommands({ now: now(), resultGraceMs: 0 });
    expect(again.unknown.map((c) => c.id)).not.toContain(unanswered.id);
    expect(await repo().completeCommand({ commandId: unanswered.id, deviceId: device.id, status: "SUCCEEDED", resultCode: null, now: now() })).toBeNull();
  });
});
