// ---------------------------------------------------------------------------
// Phase 19, Stage 19.6 — the desktop agent's durable state.
//
// The one store of pairing codes, devices, grants, commands and request
// nonces. Nothing about them lives in a process: a second API instance, or a
// restarted one, sees exactly what this one did. Every change that two callers
// could race is ONE conditional write, or one transaction that first locks the
// device row — never a read checked in memory and then written:
//
//   • a code is redeemed by an UPDATE that only an unconsumed, unexpired code
//     matches: of two redemptions, one wins;
//   • a nonce is spent by an INSERT that only one caller can make;
//   • a grant starts, and a command is issued, under the device's row lock, so
//     a device has at most one active grant and a command only ever joins one;
//   • a command is delivered, and answered, by an UPDATE from the one state it
//     may leave — so it is delivered at most once and answered at most once.
//
// It stores no secret and no value: code hashes, public keys, consent hashes,
// parameter hashes. A command's parameters are a sealed payload, deleted when
// the command is delivered or expires.
// ---------------------------------------------------------------------------

import { sanitizeDesktopLabel } from "@jarvis/core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

export type DesktopDeviceState = "pending" | "active" | "revoked";
export type DesktopGrantState = "active" | "ended";
export type DesktopCommandState = "issued" | "delivered" | "succeeded" | "not_executed" | "unknown" | "expired";

export interface DesktopDeviceRecord {
  id: string;
  userId: string;
  tenantId: string;
  publicKey: string;
  fingerprint: string;
  displayName: string;
  userLabel: string;
  organizationLabel: string;
  agentVersion: string;
  windowsBuild: number;
  status: DesktopDeviceState;
  createdAt: Date;
  confirmedAt: Date | null;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
}

export interface DesktopGrantRecord {
  id: string;
  deviceId: string;
  agentInstanceId: string;
  scope: string[];
  durationMinutes: number;
  consentTextVersion: string;
  consentTextSha256: string;
  status: DesktopGrantState;
  grantedAt: Date;
  expiresAt: Date;
  lastContactAt: Date;
  endedAt: Date | null;
  endReason: string | null;
}

export interface DesktopCommandRecord {
  id: string;
  deviceId: string;
  grantId: string;
  action: string;
  paramsHash: string;
  requiresHello: boolean;
  approvalId: string | null;
  executionId: string | null;
  status: DesktopCommandState;
  issuedAt: Date;
  expiresAt: Date;
  deliveredAt: Date | null;
  completedAt: Date | null;
  resultCode: string | null;
}

/** A command that left its last open state in a sweep or a revocation, for the journal. */
export interface DesktopCommandTransition {
  id: string;
  executionId: string | null;
}

export interface NewDesktopDevice {
  publicKey: string;
  fingerprint: string;
  displayName: string;
  agentVersion: string;
  windowsBuild: number;
}

const DEVICE_STATUS = { PENDING: "pending", ACTIVE: "active", REVOKED: "revoked" } as const;
const GRANT_STATUS = { ACTIVE: "active", ENDED: "ended" } as const;
const COMMAND_STATUS = {
  ISSUED: "issued",
  DELIVERED: "delivered",
  SUCCEEDED: "succeeded",
  NOT_EXECUTED: "not_executed",
  UNKNOWN: "unknown",
  EXPIRED: "expired",
} as const;

type DeviceRow = Prisma.DesktopDeviceGetPayload<object>;
type GrantRow = Prisma.DesktopGrantGetPayload<object>;
type CommandRow = Prisma.DesktopCommandGetPayload<object>;

function toDevice(row: DeviceRow): DesktopDeviceRecord {
  return {
    id: row.id,
    userId: row.userId,
    tenantId: row.tenantId,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    displayName: row.displayName,
    userLabel: row.userLabel,
    organizationLabel: row.organizationLabel,
    agentVersion: row.agentVersion,
    windowsBuild: row.windowsBuild,
    status: DEVICE_STATUS[row.status],
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    revokedAt: row.revokedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function toGrant(row: GrantRow): DesktopGrantRecord {
  return {
    id: row.id,
    deviceId: row.deviceId,
    agentInstanceId: row.agentInstanceId,
    scope: [...row.scope],
    durationMinutes: row.durationMinutes,
    consentTextVersion: row.consentTextVersion,
    consentTextSha256: row.consentTextSha256,
    status: GRANT_STATUS[row.status],
    grantedAt: row.grantedAt,
    expiresAt: row.expiresAt,
    lastContactAt: row.lastContactAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
  };
}

function toCommand(row: CommandRow): DesktopCommandRecord {
  return {
    id: row.id,
    deviceId: row.deviceId,
    grantId: row.grantId,
    action: row.action,
    paramsHash: row.paramsHash,
    requiresHello: row.requiresHello,
    approvalId: row.approvalId,
    executionId: row.executionId,
    status: COMMAND_STATUS[row.status],
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    deliveredAt: row.deliveredAt,
    completedAt: row.completedAt,
    resultCode: row.resultCode,
  };
}

/** Thrown inside a transaction to roll it back with a reason; never escapes this module. */
class Refusal<R extends string> extends Error {
  constructor(public readonly reason: R) {
    super(reason);
  }
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

export class PrismaDesktopRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  async createPairingCode(input: { codeHash: string; userId: string; tenantId: string; expiresAt: Date }): Promise<{ id: string; expiresAt: Date }> {
    const row = await this.prisma.desktopPairingCode.create({ data: input, select: { id: true, expiresAt: true } });
    return row;
  }

  /**
   * One redemption attempt from a source, inside a window, or a refusal. The
   * count and the new row are one step under an advisory lock on the source,
   * so attempts that arrive together cannot pass the limit between them.
   */
  async reservePairingAttempt(input: { sourceHash: string; limit: number; windowMs: number; now: Date }): Promise<boolean> {
    const since = new Date(input.now.getTime() - input.windowMs);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`desktop-pair:${input.sourceHash}`}, 0))`;
      const count = await tx.desktopPairingAttempt.count({ where: { sourceHash: input.sourceHash, createdAt: { gte: since } } });
      if (count >= input.limit) return false;
      await tx.desktopPairingAttempt.create({ data: { sourceHash: input.sourceHash, createdAt: input.now } });
      return true;
    });
  }

  /**
   * Redeems a code for a new device — once. The code is consumed by one
   * conditional UPDATE that only an unconsumed, unexpired code matches; the
   * device is created, PENDING, for the code's user and Organization, in the
   * same transaction. A key already paired refuses, and rolls the code back.
   */
  async redeemPairingCode(input: {
    codeHash: string;
    now: Date;
    device: NewDesktopDevice;
  }): Promise<{ ok: true; device: DesktopDeviceRecord } | { ok: false; reason: "INVALID" | "KEY_IN_USE" }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const consumed = await tx.$queryRaw<Array<{ id: string; user_id: string; tenant_id: string }>>`
          UPDATE "DesktopPairingCode" SET "consumed_at" = ${input.now}
          WHERE "code_hash" = ${input.codeHash} AND "consumed_at" IS NULL AND "expires_at" > ${input.now}
          RETURNING "id", "user_id", "tenant_id"`;
        const code = consumed[0];
        if (!code) throw new Refusal("INVALID");
        if (await tx.desktopDevice.findUnique({ where: { fingerprint: input.device.fingerprint }, select: { id: true } })) {
          throw new Refusal("KEY_IN_USE");
        }
        const [user, tenant] = await Promise.all([
          tx.user.findUnique({ where: { id: code.user_id }, select: { name: true } }),
          tx.tenant.findUnique({ where: { id: code.tenant_id }, select: { name: true } }),
        ]);
        const device = await tx.desktopDevice.create({
          data: {
            ...input.device,
            userId: code.user_id,
            tenantId: code.tenant_id,
            userLabel: sanitizeDesktopLabel(user?.name),
            organizationLabel: sanitizeDesktopLabel(tenant?.name),
            status: "PENDING",
            createdAt: input.now,
          },
        });
        await tx.desktopPairingCode.update({ where: { id: code.id }, data: { deviceId: device.id } });
        return { ok: true as const, device: toDevice(device) };
      });
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, reason: error.reason as "INVALID" | "KEY_IN_USE" };
      if (isUniqueViolation(error)) return { ok: false, reason: "KEY_IN_USE" };
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  async findDevice(id: string): Promise<DesktopDeviceRecord | null> {
    const row = await this.prisma.desktopDevice.findUnique({ where: { id } });
    return row ? toDevice(row) : null;
  }

  /** The devices a person may see: their own, and every device of the Organizations they administer. */
  async listDevices(input: { userId: string; adminTenantIds: readonly string[] }): Promise<DesktopDeviceRecord[]> {
    const rows = await this.prisma.desktopDevice.findMany({
      where: { OR: [{ userId: input.userId }, ...(input.adminTenantIds.length > 0 ? [{ tenantId: { in: [...input.adminTenantIds] } }] : [])] },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map(toDevice);
  }

  /** PENDING → ACTIVE, only for the device's own user, only for the fingerprint they were shown. */
  async confirmDevice(input: { deviceId: string; userId: string; fingerprint: string; now: Date }): Promise<boolean> {
    const result = await this.prisma.desktopDevice.updateMany({
      where: { id: input.deviceId, userId: input.userId, fingerprint: input.fingerprint, status: "PENDING" },
      data: { status: "ACTIVE", confirmedAt: input.now },
    });
    return result.count === 1;
  }

  /**
   * Revokes a device, once, and in the same transaction ends its grant and
   * expires every command not yet delivered (its sealed payload goes with it).
   * A command already delivered stays DELIVERED: its answer will be refused,
   * and the sweep records it UNKNOWN.
   */
  async revokeDevice(input: { deviceId: string; revokedById: string; now: Date }): Promise<{ revoked: boolean; expired: DesktopCommandTransition[] }> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.desktopDevice.updateMany({
        where: { id: input.deviceId, status: { in: ["PENDING", "ACTIVE"] } },
        data: { status: "REVOKED", revokedAt: input.now, revokedById: input.revokedById },
      });
      if (changed.count !== 1) return { revoked: false, expired: [] };
      await tx.desktopGrant.updateMany({
        where: { deviceId: input.deviceId, status: "ACTIVE" },
        data: { status: "ENDED", endedAt: input.now, endReason: "revoked" },
      });
      const expired = await this.expireIssued(tx, input.deviceId, input.now, "DEVICE_REVOKED");
      return { revoked: true, expired };
    });
  }

  async touchDevice(input: { deviceId: string; now: Date; agentVersion: string; windowsBuild: number }): Promise<void> {
    await this.prisma.desktopDevice.updateMany({
      where: { id: input.deviceId },
      data: { lastSeenAt: input.now, agentVersion: input.agentVersion, windowsBuild: input.windowsBuild },
    });
  }

  // -------------------------------------------------------------------------
  // Replay protection
  // -------------------------------------------------------------------------

  /** Spends a nonce: true for the one caller whose INSERT made it, false for every other, on any instance. */
  async consumeNonce(input: { scope: string; nonceHash: string; expiresAt: Date }): Promise<boolean> {
    const result = await this.prisma.desktopRequestNonce.createMany({ data: [input], skipDuplicates: true });
    return result.count === 1;
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  /** Locks the device row for the rest of the transaction; null when it does not exist. */
  private async lockDevice(tx: Prisma.TransactionClient, deviceId: string): Promise<DeviceRow | null> {
    await tx.$queryRaw`SELECT "id" FROM "DesktopDevice" WHERE "id" = ${deviceId} FOR UPDATE`;
    return tx.desktopDevice.findUnique({ where: { id: deviceId } });
  }

  /** ISSUED → EXPIRED for one device, payloads deleted; the commands that moved, for the journal. */
  private async expireIssued(tx: Prisma.TransactionClient, deviceId: string, now: Date, code: string): Promise<DesktopCommandTransition[]> {
    const rows = await tx.$queryRaw<Array<{ id: string; execution_id: string | null }>>`
      UPDATE "DesktopCommand" SET "status" = 'EXPIRED', "completed_at" = ${now}, "result_code" = ${code}
      WHERE "device_id" = ${deviceId} AND "status" = 'ISSUED'
      RETURNING "id", "execution_id"`;
    if (rows.length > 0) await tx.desktopCommandPayload.deleteMany({ where: { commandId: { in: rows.map((r) => r.id) } } });
    return rows.map((r) => ({ id: r.id, executionId: r.execution_id }));
  }

  /**
   * Starts a grant, under the device's lock: only for an ACTIVE device, and
   * only when no other grant is active — unless this consent extends the
   * active one (`replacesGrantId`), which then ends.
   */
  async startGrant(input: {
    deviceId: string;
    grant: Omit<DesktopGrantRecord, "deviceId" | "status" | "endedAt" | "endReason">;
    replacesGrantId: string | null;
  }): Promise<{ ok: true; grant: DesktopGrantRecord } | { ok: false; reason: "DEVICE_INACTIVE" | "CONFLICT" }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const device = await this.lockDevice(tx, input.deviceId);
        if (!device || device.status !== "ACTIVE") throw new Refusal("DEVICE_INACTIVE");
        const active = await tx.desktopGrant.findFirst({ where: { deviceId: input.deviceId, status: "ACTIVE" } });
        if (active) {
          if (active.id !== input.replacesGrantId) throw new Refusal("CONFLICT");
          await tx.desktopGrant.update({
            where: { id: active.id },
            data: { status: "ENDED", endedAt: input.grant.grantedAt, endReason: "extended" },
          });
        }
        const row = await tx.desktopGrant.create({ data: { ...input.grant, deviceId: input.deviceId, status: "ACTIVE" } });
        return { ok: true as const, grant: toGrant(row) };
      });
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, reason: error.reason as "DEVICE_INACTIVE" | "CONFLICT" };
      if (isUniqueViolation(error)) return { ok: false, reason: "CONFLICT" };
      throw error;
    }
  }

  /**
   * What a poll does to the grant, under the device's lock. The active grant
   * ends if another agent process asks (a restart), if it expired, or if the
   * agent was silent past the reconnect grace. Otherwise its last contact is
   * now. And if the agent was silent at all — longer than a held poll — no
   * command issued meanwhile survives: reconnection replays nothing.
   */
  async pollGrant(input: {
    deviceId: string;
    agentInstanceId: string;
    now: Date;
    graceMs: number;
    gapMs: number;
  }): Promise<{ grant: DesktopGrantRecord | null; ended: { id: string; reason: string } | null; expired: DesktopCommandTransition[] }> {
    return this.prisma.$transaction(async (tx) => {
      const device = await this.lockDevice(tx, input.deviceId);
      if (!device) return { grant: null, ended: null, expired: [] };
      const active = await tx.desktopGrant.findFirst({ where: { deviceId: input.deviceId, status: "ACTIVE" } });
      if (!active) return { grant: null, ended: null, expired: [] };

      const silentMs = input.now.getTime() - active.lastContactAt.getTime();
      const reason =
        active.agentInstanceId !== input.agentInstanceId
          ? "restart"
          : active.expiresAt <= input.now
            ? "expired"
            : silentMs > input.graceMs
              ? "disconnected"
              : null;
      if (reason) {
        const ended = await tx.desktopGrant.update({
          where: { id: active.id },
          data: { status: "ENDED", endedAt: input.now, endReason: reason },
        });
        const expired = await this.expireIssued(tx, input.deviceId, input.now, "GRANT_ENDED");
        return { grant: toGrant(ended), ended: { id: active.id, reason }, expired };
      }
      const expired = silentMs > input.gapMs ? await this.expireIssued(tx, input.deviceId, input.now, "RECONNECTED") : [];
      const touched = await tx.desktopGrant.update({ where: { id: active.id }, data: { lastContactAt: input.now } });
      return { grant: toGrant(touched), ended: null, expired };
    });
  }

  /**
   * Records contact with the agent on an active, unexpired grant — a held
   * poll's answer going out, or the agent's answer to a command coming in. It
   * never revives an ended grant.
   */
  async touchGrant(input: { deviceId: string; grantId: string; now: Date }): Promise<boolean> {
    const changed = await this.prisma.desktopGrant.updateMany({
      where: { id: input.grantId, deviceId: input.deviceId, status: "ACTIVE", expiresAt: { gt: input.now } },
      data: { lastContactAt: input.now },
    });
    return changed.count === 1;
  }

  /** Ends the device's active grant (only `grantId`, when named). Undelivered commands expire with it. */
  async endGrant(input: {
    deviceId: string;
    grantId: string | null;
    reason: string;
    now: Date;
  }): Promise<{ ended: boolean; expired: DesktopCommandTransition[] }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockDevice(tx, input.deviceId);
      const changed = await tx.desktopGrant.updateMany({
        where: { deviceId: input.deviceId, status: "ACTIVE", ...(input.grantId ? { id: input.grantId } : {}) },
        data: { status: "ENDED", endedAt: input.now, endReason: input.reason },
      });
      if (changed.count === 0) return { ended: false, expired: [] };
      return { ended: true, expired: await this.expireIssued(tx, input.deviceId, input.now, "GRANT_ENDED") };
    });
  }

  async activeGrant(deviceId: string): Promise<DesktopGrantRecord | null> {
    const row = await this.prisma.desktopGrant.findFirst({ where: { deviceId, status: "ACTIVE" } });
    return row ? toGrant(row) : null;
  }

  async findGrant(id: string): Promise<DesktopGrantRecord | null> {
    const row = await this.prisma.desktopGrant.findUnique({ where: { id } });
    return row ? toGrant(row) : null;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Issues one command, under the device's lock: only for an ACTIVE device
   * whose active grant is this one, unexpired, in contact within the grace,
   * and allows this action. The sealed parameters are stored in the same step.
   */
  async issueCommand(input: {
    deviceId: string;
    grantId: string;
    action: string;
    paramsHash: string;
    requiresHello: boolean;
    approvalId: string | null;
    executionId: string | null;
    expiresAt: Date;
    sealed: string;
    now: Date;
    graceMs: number;
  }): Promise<{ ok: true; command: DesktopCommandRecord } | { ok: false; reason: "DEVICE_INACTIVE" | "GRANT_INACTIVE" | "OUT_OF_SCOPE" }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const device = await this.lockDevice(tx, input.deviceId);
        if (!device || device.status !== "ACTIVE") throw new Refusal("DEVICE_INACTIVE");
        const grant = await tx.desktopGrant.findUnique({ where: { id: input.grantId } });
        if (
          !grant ||
          grant.deviceId !== input.deviceId ||
          grant.status !== "ACTIVE" ||
          grant.expiresAt <= input.now ||
          input.now.getTime() - grant.lastContactAt.getTime() > input.graceMs
        ) {
          throw new Refusal("GRANT_INACTIVE");
        }
        if (!grant.scope.includes(input.action)) throw new Refusal("OUT_OF_SCOPE");
        const row = await tx.desktopCommand.create({
          data: {
            deviceId: input.deviceId,
            grantId: input.grantId,
            action: input.action,
            paramsHash: input.paramsHash,
            requiresHello: input.requiresHello,
            approvalId: input.approvalId,
            executionId: input.executionId,
            status: "ISSUED",
            issuedAt: input.now,
            expiresAt: input.expiresAt,
            payload: { create: { sealed: input.sealed, expiresAt: input.expiresAt } },
          },
        });
        return { ok: true as const, command: toCommand(row) };
      });
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, reason: error.reason as "DEVICE_INACTIVE" | "GRANT_INACTIVE" | "OUT_OF_SCOPE" };
      throw error;
    }
  }

  /**
   * Hands the device its oldest deliverable command, once: ISSUED → DELIVERED
   * by one conditional UPDATE, and the sealed payload is read and deleted in
   * the same transaction. Only while its grant is still the device's active,
   * unexpired grant; otherwise the command expires instead.
   */
  async claimNextCommand(input: { deviceId: string; now: Date }): Promise<{ command: DesktopCommandRecord; sealed: string } | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = await this.prisma.desktopCommand.findFirst({
        where: { deviceId: input.deviceId, status: "ISSUED", expiresAt: { gt: input.now } },
        orderBy: { issuedAt: "asc" },
        select: { id: true },
      });
      if (!next) return null;
      const claimed = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "DesktopCommand" c SET "status" = 'DELIVERED', "delivered_at" = ${input.now}
          FROM "DesktopGrant" g
          WHERE c."id" = ${next.id} AND c."status" = 'ISSUED' AND c."expires_at" > ${input.now}
            AND g."id" = c."grant_id" AND g."status" = 'ACTIVE' AND g."expires_at" > ${input.now}
          RETURNING c."id"`;
        if (rows.length !== 1) return null;
        const payload = await tx.desktopCommandPayload.findUnique({ where: { commandId: next.id } });
        await tx.desktopCommandPayload.deleteMany({ where: { commandId: next.id } });
        const command = await tx.desktopCommand.findUniqueOrThrow({ where: { id: next.id } });
        return payload ? { command: toCommand(command), sealed: payload.sealed } : null;
      });
      if (claimed) return claimed;
    }
    return null;
  }

  /** DELIVERED → the agent's answer, once. Null when the command is not this device's, or already answered. */
  async completeCommand(input: {
    commandId: string;
    deviceId: string;
    status: "SUCCEEDED" | "NOT_EXECUTED" | "UNKNOWN";
    resultCode: string | null;
    now: Date;
  }): Promise<DesktopCommandRecord | null> {
    const changed = await this.prisma.desktopCommand.updateMany({
      where: { id: input.commandId, deviceId: input.deviceId, status: "DELIVERED" },
      data: { status: input.status, completedAt: input.now, resultCode: input.resultCode },
    });
    if (changed.count !== 1) return null;
    return this.findCommand(input.commandId);
  }

  async findCommand(id: string): Promise<DesktopCommandRecord | null> {
    const row = await this.prisma.desktopCommand.findUnique({ where: { id } });
    return row ? toCommand(row) : null;
  }

  async listCommands(deviceId: string, limit = 20): Promise<DesktopCommandRecord[]> {
    const rows = await this.prisma.desktopCommand.findMany({ where: { deviceId }, orderBy: { issuedAt: "desc" }, take: limit });
    return rows.map(toCommand);
  }

  /**
   * Closes what can no longer finish. A command never delivered in time is
   * EXPIRED — nothing reached the device. A command delivered and not answered
   * within `resultGraceMs` after its expiry is UNKNOWN — it may have acted —
   * and is never sent again. Expired payloads are deleted. Safe on every
   * instance at once: each row moves once.
   */
  async sweepCommands(input: { now: Date; resultGraceMs: number }): Promise<{ expired: DesktopCommandTransition[]; unknown: DesktopCommandTransition[] }> {
    const unanswered = new Date(input.now.getTime() - input.resultGraceMs);
    const expired = await this.prisma.$queryRaw<Array<{ id: string; execution_id: string | null }>>`
      UPDATE "DesktopCommand" SET "status" = 'EXPIRED', "completed_at" = ${input.now}, "result_code" = 'NOT_DELIVERED'
      WHERE "status" = 'ISSUED' AND "expires_at" <= ${input.now}
      RETURNING "id", "execution_id"`;
    const unknown = await this.prisma.$queryRaw<Array<{ id: string; execution_id: string | null }>>`
      UPDATE "DesktopCommand" SET "status" = 'UNKNOWN', "completed_at" = ${input.now}, "result_code" = 'NO_RESULT'
      WHERE "status" = 'DELIVERED' AND "expires_at" <= ${unanswered}
      RETURNING "id", "execution_id"`;
    await this.prisma.desktopCommandPayload.deleteMany({ where: { expiresAt: { lte: input.now } } });
    const map = (rows: Array<{ id: string; execution_id: string | null }>) => rows.map((r) => ({ id: r.id, executionId: r.execution_id }));
    return { expired: map(expired), unknown: map(unknown) };
  }

  /** Deletes what has no further use: spent nonces past their window, old codes and attempts. */
  async purge(input: { now: Date; codeRetentionMs: number; attemptRetentionMs: number }): Promise<void> {
    await this.prisma.desktopRequestNonce.deleteMany({ where: { expiresAt: { lte: input.now } } });
    await this.prisma.desktopPairingCode.deleteMany({ where: { expiresAt: { lte: new Date(input.now.getTime() - input.codeRetentionMs) } } });
    await this.prisma.desktopPairingAttempt.deleteMany({ where: { createdAt: { lte: new Date(input.now.getTime() - input.attemptRetentionMs) } } });
  }
}
