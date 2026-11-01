// ---------------------------------------------------------------------------
// Phase 19, Stage 19.6 — DesktopControlService: the one authority over the
// Windows desktop agent.
//
// Every person-facing route and every agent route ends here, so a check made
// here is made for every path (the integration rule). It decides nothing from
// a request body about who or which Organization: the person is the
// authenticated account, a device's user and Organization come from its row,
// and membership is read fresh for every operation, by both ids. A pairing
// names its Organization and is held to that same read. The one read by user
// alone (`adminMemberships`, §18.9 of the Phase 19 record) only shows a person
// their Organizations and narrows a list of devices; it decides nothing. A
// person can always stop their own computer, whatever their role has become.
//
//   Person (web UI, or chat for 19.7)   Agent (signed, outbound only)
//   create a pairing code  (Owner/Admin) redeem it with a fresh key → PENDING
//   confirm the fingerprint (own device) poll — held up to 20 s, one command
//   revoke (own device, or Owner/Admin)  report consent at the device → grant
//   end the session                      end the session
//   ask for a command → an approval      answer a command, once
//   confirm it → issued, signed, 30 s
//
// Reused, not rebuilt: the approval store (single-use consumption; a desktop
// approval's parameters are sealed by 19.5), the execution journal (a lost
// answer is UNKNOWN and is never sent again), the audit trail (value-free), the
// atomic rate limiter, the sealer.
//
// Stage 19.7 — the owner reversed D5. Chat reaches this service through the one
// port (`DesktopChatPort`), for two actions only: opening an approved
// application and typing approved text. A model proposes; `propose` holds the
// proposal to the owner's own words, finds the device and the grant, and creates
// nothing; a person approves; `runApproved` spends that approval through the
// same `confirmCommand` the page uses, and reports what the computer answered.
// ---------------------------------------------------------------------------

import {
  APPROVAL_TTL_MS,
  BLOCKED_STATUSES,
  DESKTOP_AGENT_HEADERS,
  DESKTOP_CHAT_REFUSALS,
  DESKTOP_CLOCK_SKEW_MS,
  DESKTOP_COMMAND_TTL_MS,
  DESKTOP_CONSENT_TEXT_VERSION,
  DESKTOP_PAIRING_CODE_TTL_MS,
  DESKTOP_PAIRING_DEVICE,
  DESKTOP_POLL_HOLD_MS,
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_RECONNECT_GRACE_MS,
  DESKTOP_RESULT_WAIT_MS,
  DesktopCommandRequestSchema,
  DesktopCommandResultSchema,
  DesktopGrantRequestSchema,
  DesktopPairRequestSchema,
  DesktopPollRequestSchema,
  DesktopSessionEndRequestSchema,
  canonicalDesktopScope,
  compareDesktopAgentVersions,
  computeParamsHash,
  computerControlApprovalSummary,
  desktopActionRequiresHello,
  desktopApprovalParams,
  desktopChatReport,
  desktopCommandCanonical,
  desktopCommandParams,
  desktopConsentTextSha256,
  desktopFingerprintDisplay,
  desktopKeyFingerprint,
  desktopOwnerAuthorization,
  desktopRequestCanonical,
  desktopRequestPartsAreWellFormed,
  desktopResponseCanonical,
  generateDesktopPairingCode,
  hashDesktopPairingCode,
  isDesktopCommandAction,
  isSensitiveDesktopText,
  isDesktopTimestampFresh,
  isP256PublicKey,
  normalizeDesktopPairingCode,
  parseComputerControlRequest,
  parseDesktopMessage,
  renderDesktopConsentText,
  sanitizeDesktopLabel,
  sha256Hex,
  signDesktopCanonical,
  verifyDesktopCanonical,
  type Approval,
  type ApprovalConsumptionInput,
  type ApprovalConsumptionResult,
  type ApprovalParamsSealer,
  type AuditEntry,
  type DesktopAppId,
  type DesktopChatPort,
  type DesktopChatProposal,
  type DesktopChatRefusalCode,
  type DesktopChatReport,
  type DesktopChatToolId,
  type DesktopCommandAction,
  type DesktopCommandEnvelope,
  type DesktopCommandParams,
  type DesktopErrorCode,
  type ExecutionJournalPort,
  type TenantRole,
} from "@jarvis/core";
import type {
  DesktopCommandRecord,
  DesktopCommandTransition,
  DesktopDeviceRecord,
  DesktopGrantRecord,
  PrismaDesktopRepository,
} from "@jarvis/db";

import type { OperationalLog } from "../observability/index.js";
import type { DesktopAgentConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Ports and options
// ---------------------------------------------------------------------------

export type DesktopStorePort = Pick<
  PrismaDesktopRepository,
  | "createPairingCode"
  | "reservePairingAttempt"
  | "redeemPairingCode"
  | "findDevice"
  | "listDevices"
  | "confirmDevice"
  | "revokeDevice"
  | "touchGrant"
  | "touchDevice"
  | "consumeNonce"
  | "startGrant"
  | "pollGrant"
  | "endGrant"
  | "activeGrant"
  | "issueCommand"
  | "claimNextCommand"
  | "completeCommand"
  | "findCommand"
  | "listCommands"
  | "sweepCommands"
  | "purge"
>;

export interface DesktopMembershipPort {
  findMembership(userId: string, tenantId: string): Promise<{ role: TenantRole } | null>;
  /** Shows and narrows, never decides: a decision about one Organization reads `findMembership`. */
  listMemberships(userId: string): Promise<Array<{ tenantId: string; tenantName: string; role: TenantRole }>>;
}

export interface DesktopApprovalPort {
  create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval>;
  findById(id: string): Promise<Approval | null>;
  decideApproval(
    id: string,
    deciderId: string,
    decision: "approve" | "reject",
    options?: { fromPendingOnly?: boolean }
  ): Promise<{ outcome: string }>;
  consumeForExecution(input: ApprovalConsumptionInput): Promise<ApprovalConsumptionResult>;
}

export interface DesktopSlotPort {
  reserve(userId: string, bucket: string, limit: number, windowMs: number): Promise<{ allowed: boolean; reason?: "LIMIT" | "UNAVAILABLE" }>;
}

export interface DesktopAuditPort {
  log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void>;
}

export interface DesktopControlServiceDeps {
  store: DesktopStorePort;
  memberships: DesktopMembershipPort;
  approvals: DesktopApprovalPort;
  journal: Pick<ExecutionJournalPort, "begin" | "markSucceeded" | "markFailed" | "markUnknown">;
  sealer: ApprovalParamsSealer;
  audit: DesktopAuditPort;
  slots: DesktopSlotPort;
  config: DesktopAgentConfig;
  now?: () => Date;
  /** How long a poll is held open when nothing is waiting. */
  pollHoldMs?: number;
  /** How often a held poll looks for a command. */
  pollIntervalMs?: number;
  /** While shutting down, a held poll returns at once. */
  isShuttingDown?: () => boolean;
  /** Pairing codes one person may create per window; the default is the policy. */
  pairingCodeLimit?: { limit: number; windowMs: number };
  /** Where a refusal of an authenticated device is reported. Nothing depends on it. */
  agentLog?: Pick<OperationalLog, "warn">;
  /** How long chat waits for a computer's answer; the default is the protocol's. */
  resultWaitMs?: number;
  /** How often that wait looks. */
  resultPollMs?: number;
}

/** Who may pair, and who besides a device's own user may revoke it (D7). */
const ADMIN_ROLES: ReadonlySet<TenantRole> = new Set<TenantRole>(["owner", "admin"]);

/** Pairing codes one person may create, per window. */
const PAIRING_CODE_LIMIT = { limit: 5, windowMs: 10 * 60_000 };
/** Redemption attempts from one source address, per window. */
const PAIRING_ATTEMPT_LIMIT = { limit: 10, windowMs: 10 * 60_000 };
/** How long after a command's expiry its answer is still awaited before it is UNKNOWN. */
const RESULT_GRACE_MS = DESKTOP_COMMAND_TTL_MS;
/** Silence longer than a held poll and its margin: a disconnection, after which nothing waiting is delivered. */
const RECONNECT_GAP_MS = DESKTOP_POLL_HOLD_MS + 5_000;
const MAX_AGENT_BODY_BYTES = 64 * 1024;
/** How often chat looks for a command's answer. */
const RESULT_POLL_MS = 500;
/** A command's states that no answer can change. */
const FINAL_COMMAND_STATES: ReadonlySet<string> = new Set(["succeeded", "not_executed", "unknown", "expired"]);

// ---------------------------------------------------------------------------
// Errors and views
// ---------------------------------------------------------------------------

export type DesktopPersonErrorCode =
  | "INVALID_REQUEST"
  | "NOT_AUTHORIZED"
  | "NOT_FOUND"
  | "ORGANIZATION_REQUIRED"
  | "RATE_LIMITED"
  | "DEVICE_NOT_ACTIVE"
  | "FINGERPRINT_MISMATCH"
  | "GRANT_REQUIRED"
  | "APPROVAL_INVALID"
  | "TEXT_TOO_LONG"
  | "TEXT_SENSITIVE"
  | "UNAVAILABLE";

const PERSON_STATUS: Readonly<Record<DesktopPersonErrorCode, number>> = {
  INVALID_REQUEST: 400,
  NOT_AUTHORIZED: 403,
  NOT_FOUND: 404,
  ORGANIZATION_REQUIRED: 400,
  RATE_LIMITED: 429,
  DEVICE_NOT_ACTIVE: 409,
  FINGERPRINT_MISMATCH: 409,
  GRANT_REQUIRED: 409,
  APPROVAL_INVALID: 409,
  TEXT_TOO_LONG: 400,
  TEXT_SENSITIVE: 400,
  UNAVAILABLE: 503,
};

const PERSON_MESSAGE: Readonly<Record<DesktopPersonErrorCode, string>> = {
  INVALID_REQUEST: "The request is not valid.",
  NOT_AUTHORIZED: "You are not allowed to do this.",
  NOT_FOUND: "Not found.",
  ORGANIZATION_REQUIRED: "Choose the Organization to pair this computer with.",
  RATE_LIMITED: "Too many pairing codes; wait a few minutes.",
  DEVICE_NOT_ACTIVE: "This computer is not paired and confirmed.",
  FINGERPRINT_MISMATCH: "The fingerprint does not match this computer's key. Do not confirm it.",
  GRANT_REQUIRED: "Control has not been allowed on that computer, or it has ended. Allow it there first.",
  APPROVAL_INVALID: "That approval cannot be used for this command.",
  TEXT_TOO_LONG: "That text is longer than this server allows to be typed in one action.",
  TEXT_SENSITIVE: "That looks like a password, a code or a credential. JARVIS never types those.",
  UNAVAILABLE: "Desktop control is not available right now; nothing was done.",
};

export class DesktopControlError extends Error {
  readonly status: number;
  constructor(readonly code: DesktopPersonErrorCode) {
    super(PERSON_MESSAGE[code]);
    this.status = PERSON_STATUS[code];
  }
}

export interface DesktopDeviceView {
  id: string;
  displayName: string;
  userLabel: string;
  organizationLabel: string;
  status: "pending" | "active" | "revoked";
  agentVersion: string;
  windowsBuild: number;
  fingerprint: string;
  createdAt: string;
  confirmedAt: string | null;
  lastSeenAt: string | null;
  mine: boolean;
  canRevoke: boolean;
  grant: { scope: string[]; durationMinutes: number; expiresAt: string } | null;
}

/** An Organization a person may pair a computer with. An id and a name, and nothing else. */
export interface DesktopOrganizationView {
  id: string;
  name: string;
}

export interface DesktopCommandView {
  id: string;
  action: string;
  status: DesktopCommandRecord["status"];
  requiresHello: boolean;
  issuedAt: string;
  expiresAt: string;
  completedAt: string | null;
  resultCode: string | null;
}

function deviceView(device: DesktopDeviceRecord, grant: DesktopGrantRecord | null, mine: boolean, canRevoke: boolean): DesktopDeviceView {
  return {
    id: device.id,
    displayName: device.displayName,
    userLabel: device.userLabel,
    organizationLabel: device.organizationLabel,
    status: device.status,
    agentVersion: device.agentVersion,
    windowsBuild: device.windowsBuild,
    fingerprint: desktopFingerprintDisplay(device.fingerprint),
    createdAt: device.createdAt.toISOString(),
    confirmedAt: device.confirmedAt?.toISOString() ?? null,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    mine,
    canRevoke: canRevoke && device.status !== "revoked",
    grant: grant ? { scope: grant.scope, durationMinutes: grant.durationMinutes, expiresAt: grant.expiresAt.toISOString() } : null,
  };
}

function commandView(command: DesktopCommandRecord): DesktopCommandView {
  return {
    id: command.id,
    action: command.action,
    status: command.status,
    requiresHello: command.requiresHello,
    issuedAt: command.issuedAt.toISOString(),
    expiresAt: command.expiresAt.toISOString(),
    completedAt: command.completedAt?.toISOString() ?? null,
    resultCode: command.resultCode,
  };
}

// ---------------------------------------------------------------------------
// Agent-facing request and response
// ---------------------------------------------------------------------------

export type DesktopAgentRoute = "pair" | "poll" | "grants" | "session/end" | "result";

export interface DesktopAgentRequest {
  method: string;
  /** The path as called, without its query. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  /** Where the request came from; hashed, for the pairing rate limit only. */
  source: string;
  /** The command a result answers. */
  commandId?: string;
}

export interface DesktopAgentResponse {
  status: number;
  body: unknown;
  /** Headers proving the body came from this server, for this request. */
  headers: Record<string, string>;
  /** On a refusal, its code, for this service's own log. Never sent. */
  refusal?: DesktopErrorCode;
}

class AgentRefusal extends Error {
  constructor(readonly status: number, readonly code: DesktopErrorCode) {
    super(code);
  }
}

/** The device a request's signature proved, once it has. */
interface ProvenAgent {
  deviceId?: string;
}

const header = (headers: DesktopAgentRequest["headers"], name: string): string => {
  const value = headers[name];
  return typeof value === "string" ? value : "";
};

/** A device in a log line: the first 16 hex characters of its id's SHA-256, as the agent logs it. */
const deviceIdHash = (deviceId: string): string => sha256Hex(deviceId).slice(0, 16);

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class DesktopControlService implements DesktopChatPort {
  private readonly now: () => Date;
  private readonly pollHoldMs: number;
  private readonly pollIntervalMs: number;
  private readonly pairingCodeLimit: { limit: number; windowMs: number };

  constructor(private readonly deps: DesktopControlServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.pollHoldMs = deps.pollHoldMs ?? DESKTOP_POLL_HOLD_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? 1_000;
    this.pairingCodeLimit = deps.pairingCodeLimit ?? PAIRING_CODE_LIMIT;
  }

  // -------------------------------------------------------------------------
  // Shared checks
  // -------------------------------------------------------------------------

  /** What this person administers, read now. This shows and narrows; it never decides. */
  private async adminMemberships(userId: string) {
    const memberships = await this.deps.memberships.listMemberships(userId);
    return memberships.filter((m) => ADMIN_ROLES.has(m.role));
  }

  private async adminTenantIds(userId: string): Promise<string[]> {
    return (await this.adminMemberships(userId)).map((m) => m.tenantId);
  }

  /** The device's own user still holds Owner/Admin in the device's Organization — read now. */
  private async ownerStillAuthorized(device: DesktopDeviceRecord): Promise<boolean> {
    try {
      const membership = await this.deps.memberships.findMembership(device.userId, device.tenantId);
      return membership !== null && ADMIN_ROLES.has(membership.role);
    } catch {
      return false;
    }
  }

  private async audit(userId: string, action: string, result: AuditEntry["result"], parameters: Record<string, unknown>): Promise<void> {
    await this.deps.audit.log({ userId, action, result, parameters });
  }

  /** Records, for each command that left its last open state, what the journal must say. */
  private async journalTransitions(transitions: DesktopCommandTransition[], outcome: "FAILED" | "UNKNOWN", code: string): Promise<void> {
    for (const { executionId } of transitions) {
      if (!executionId) continue;
      if (outcome === "FAILED") {
        await this.deps.journal.markFailed(executionId, { code, message: "The command did not reach the computer before it ended." }).catch(() => null);
      } else {
        await this.deps.journal.markUnknown(executionId, { code, message: "The command reached the computer and no answer came back." }).catch(() => null);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Person-facing — the web UI
  // -------------------------------------------------------------------------

  /**
   * The Organizations this person may pair a computer with, for the page's
   * chooser. Being shown one decides nothing: `createPairingCode` reads the
   * membership again, for the Organization it is given.
   */
  async listOrganizations(userId: string): Promise<DesktopOrganizationView[]> {
    const memberships = await this.adminMemberships(userId);
    return memberships.map((m) => ({ id: m.tenantId, name: sanitizeDesktopLabel(m.tenantName) }));
  }

  /**
   * A pairing code for a computer of the caller's, in the Organization they
   * name, which they own or administer now (D7). Never inferred: a device
   * belongs to its Organization for good, so the person chooses. Shown once —
   * with the id of the server's command key, which the computer shows after
   * pairing, so the person can see it pinned this server's key.
   */
  async createPairingCode(userId: string, input: { organizationId?: unknown }): Promise<{ code: string; expiresAt: string; organizationId: string; serverKeyId: string }> {
    const { organizationId } = input;
    if (organizationId === undefined || organizationId === null) throw new DesktopControlError("ORGANIZATION_REQUIRED");
    if (typeof organizationId !== "string" || organizationId.length === 0) throw new DesktopControlError("INVALID_REQUEST");
    const membership = await this.deps.memberships.findMembership(userId, organizationId);
    if (!membership || !ADMIN_ROLES.has(membership.role)) throw new DesktopControlError("NOT_AUTHORIZED");

    const slot = await this.deps.slots.reserve(userId, "pairing_code", this.pairingCodeLimit.limit, this.pairingCodeLimit.windowMs);
    if (!slot.allowed) throw new DesktopControlError(slot.reason === "UNAVAILABLE" ? "UNAVAILABLE" : "RATE_LIMITED");

    const code = generateDesktopPairingCode();
    const expiresAt = new Date(this.now().getTime() + DESKTOP_PAIRING_CODE_TTL_MS);
    await this.deps.store.createPairingCode({ codeHash: hashDesktopPairingCode(normalizeDesktopPairingCode(code)!), userId, tenantId: organizationId, expiresAt });
    await this.audit(userId, "desktop.pairing.create", "success", { organizationId });
    return { code, expiresAt: expiresAt.toISOString(), organizationId, serverKeyId: this.deps.config.serverKeyId };
  }

  async listDevices(userId: string): Promise<DesktopDeviceView[]> {
    const admin = await this.adminTenantIds(userId);
    const devices = await this.deps.store.listDevices({ userId, adminTenantIds: admin });
    return Promise.all(
      devices.map(async (device) => {
        const grant = device.status === "active" ? await this.deps.store.activeGrant(device.id) : null;
        const mine = device.userId === userId;
        return deviceView(device, grant, mine, mine || admin.includes(device.tenantId));
      })
    );
  }

  /** The device's own user confirms the fingerprint they compared on the computer. */
  async confirmDevice(userId: string, deviceId: string, input: { fingerprint?: unknown }): Promise<DesktopDeviceView> {
    const device = await this.deps.store.findDevice(deviceId);
    if (!device || device.userId !== userId) throw new DesktopControlError("NOT_FOUND");
    if (device.status !== "pending") throw new DesktopControlError("DEVICE_NOT_ACTIVE");
    if (!(await this.ownerStillAuthorized(device))) throw new DesktopControlError("NOT_AUTHORIZED");
    const shown = typeof input.fingerprint === "string" ? input.fingerprint.trim().toUpperCase() : "";
    if (shown !== desktopFingerprintDisplay(device.fingerprint)) {
      await this.audit(userId, "desktop.device.confirm", "rejected", { deviceId, reason: "FINGERPRINT_MISMATCH" });
      throw new DesktopControlError("FINGERPRINT_MISMATCH");
    }
    if (!(await this.deps.store.confirmDevice({ deviceId, userId, fingerprint: device.fingerprint, now: this.now() }))) {
      throw new DesktopControlError("DEVICE_NOT_ACTIVE");
    }
    await this.audit(userId, "desktop.device.confirm", "success", { deviceId });
    return deviceView({ ...device, status: "active" }, null, true, true);
  }

  /** May this person stop this device: its own user, or an Owner/Admin of its Organization now (D7). */
  private async mayStop(userId: string, device: DesktopDeviceRecord): Promise<boolean> {
    if (device.userId === userId) return true;
    const membership = await this.deps.memberships.findMembership(userId, device.tenantId).catch(() => null);
    return membership !== null && ADMIN_ROLES.has(membership.role);
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    const device = await this.deps.store.findDevice(deviceId);
    if (!device || !(await this.mayStop(userId, device))) throw new DesktopControlError("NOT_FOUND");
    const result = await this.deps.store.revokeDevice({ deviceId, revokedById: userId, now: this.now() });
    await this.journalTransitions(result.expired, "FAILED", "DEVICE_REVOKED");
    await this.audit(userId, "desktop.device.revoke", "success", { deviceId, changed: result.revoked });
  }

  async endSession(userId: string, deviceId: string): Promise<void> {
    const device = await this.deps.store.findDevice(deviceId);
    if (!device || !(await this.mayStop(userId, device))) throw new DesktopControlError("NOT_FOUND");
    const result = await this.deps.store.endGrant({ deviceId, grantId: null, reason: "web", now: this.now() });
    await this.journalTransitions(result.expired, "FAILED", "GRANT_ENDED");
    await this.audit(userId, "desktop.session.end", "success", { deviceId, ended: result.ended });
  }

  /** The device, if it is the caller's own, active, still authorized, with control allowed for `action`. */
  private async controllableDevice(userId: string, deviceId: string, action: DesktopCommandAction) {
    const device = await this.deps.store.findDevice(deviceId);
    if (!device || device.userId !== userId) throw new DesktopControlError("NOT_FOUND");
    if (device.status !== "active") throw new DesktopControlError("DEVICE_NOT_ACTIVE");
    if (!(await this.ownerStillAuthorized(device))) throw new DesktopControlError("NOT_AUTHORIZED");
    const grant = await this.deps.store.activeGrant(deviceId);
    const now = this.now();
    if (
      !grant ||
      grant.expiresAt <= now ||
      now.getTime() - grant.lastContactAt.getTime() > DESKTOP_RECONNECT_GRACE_MS ||
      !grant.scope.includes(action)
    ) {
      throw new DesktopControlError("GRANT_REQUIRED");
    }
    return { device, grant };
  }

  /**
   * A person asks for one command. It becomes an approval — the existing kind,
   * bound to the device and the exact parameters, its values sealed (19.5) —
   * that they confirm before anything is sent. Nothing reaches the computer here.
   */
  async requestCommand(userId: string, deviceId: string, body: unknown): Promise<{
    approvalId: string;
    action: DesktopCommandAction;
    summary: string;
    detailLines: Array<{ label: string; value: string }>;
    requiresHello: boolean;
    expiresAt: string;
  }> {
    const request = parseDesktopMessage(DesktopCommandRequestSchema, body);
    if (!request) throw new DesktopControlError("INVALID_REQUEST");
    await this.controllableDevice(userId, deviceId, request.action);

    const params = desktopCommandParams(request);
    const refused = this.textRefusal(params);
    if (refused) throw new DesktopControlError(refused);
    const approvalParams = desktopApprovalParams(params, deviceId);
    const parsed = parseComputerControlRequest({ ...approvalParams, action: params.action });
    if (!parsed.ok) throw new DesktopControlError("INVALID_REQUEST");
    const summary = computerControlApprovalSummary(parsed.value);

    const approval = await this.deps.approvals.create({
      userId,
      toolId: params.action,
      action: "execute",
      params: approvalParams,
      paramsHash: computeParamsHash(approvalParams),
      riskLevel: "EXTERNAL_SIDE_EFFECT",
      expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS).toISOString(),
    });
    await this.audit(userId, "desktop.command.request", "pending", { deviceId, action: params.action, approvalId: approval.id });
    return {
      approvalId: approval.id,
      action: params.action,
      summary: summary.actionSummary,
      detailLines: [...summary.detailLines],
      requiresHello: desktopActionRequiresHello(params.action),
      expiresAt: approval.expiresAt,
    };
  }

  /**
   * The person confirms: their approval is decided (if it still waits), spent
   * once with the journal's claim, and the command is issued — sealed, signed
   * on delivery, valid for 30 seconds. Typing additionally waits for Windows
   * Hello on the computer itself (D1); no click in this web UI can stand in.
   */
  async confirmCommand(userId: string, deviceId: string, approvalId: string): Promise<DesktopCommandView> {
    const approval = await this.deps.approvals.findById(approvalId);
    if (!approval || approval.userId !== userId || !isDesktopCommandAction(approval.toolId)) throw new DesktopControlError("NOT_FOUND");
    if (approval.params.deviceId !== deviceId) throw new DesktopControlError("APPROVAL_INVALID");
    const action = approval.toolId;
    const { grant } = await this.controllableDevice(userId, deviceId, action);

    const { deviceId: _bound, ...rest } = approval.params;
    const request = parseDesktopMessage(DesktopCommandRequestSchema, { action, ...rest });
    if (!request) throw new DesktopControlError("APPROVAL_INVALID");
    const params = desktopCommandParams(request);
    const paramsHash = computeParamsHash(desktopApprovalParams(params, deviceId));
    if (approval.paramsHash !== paramsHash) throw new DesktopControlError("APPROVAL_INVALID");
    // Every way to a command passes here, so the rule holds whichever asked.
    const refused = this.textRefusal(params);
    if (refused) throw new DesktopControlError(refused);

    if (approval.status === "pending") {
      const decided = await this.deps.approvals.decideApproval(approvalId, userId, "approve", { fromPendingOnly: true });
      if (decided.outcome !== "approved") throw new DesktopControlError("APPROVAL_INVALID");
    } else if (approval.status !== "approved") {
      throw new DesktopControlError("APPROVAL_INVALID");
    }

    const record = await this.deps.journal.begin({
      userId,
      toolId: action,
      idempotencyKey: `desktop:${approvalId}`,
      paramsHash,
      provider: "desktop",
      approvalId,
    });
    if (BLOCKED_STATUSES.has(record.status) || record.status === "SUCCEEDED" || record.status === "FAILED") {
      throw new DesktopControlError("APPROVAL_INVALID");
    }
    const consumed = await this.deps.approvals.consumeForExecution({
      approvalId,
      userId,
      toolId: action,
      paramsHash,
      executionId: record.executionId,
    });
    if (!consumed.ok) throw new DesktopControlError("APPROVAL_INVALID");

    const now = this.now();
    const issued = await this.deps.store.issueCommand({
      deviceId,
      grantId: grant.id,
      action,
      paramsHash,
      requiresHello: desktopActionRequiresHello(action),
      approvalId,
      executionId: record.executionId,
      expiresAt: new Date(now.getTime() + DESKTOP_COMMAND_TTL_MS),
      sealed: this.deps.sealer.seal(JSON.stringify(params)),
      now,
      graceMs: DESKTOP_RECONNECT_GRACE_MS,
    });
    if (!issued.ok) {
      await this.deps.journal.markFailed(record.executionId, { code: "NOT_ISSUED", message: "The command was not issued." }).catch(() => null);
      await this.audit(userId, "desktop.command.issue", "rejected", { deviceId, action, reason: issued.reason });
      throw new DesktopControlError(issued.reason === "DEVICE_INACTIVE" ? "DEVICE_NOT_ACTIVE" : "GRANT_REQUIRED");
    }
    await this.audit(userId, "desktop.command.issue", "success", {
      deviceId,
      action,
      commandId: issued.command.id,
      requiresHello: issued.command.requiresHello,
      origin: approval.conversationId ? "chat" : "page",
      ...(params.action === "desktop.app.launch" ? { app: params.app } : {}),
    });
    return commandView(issued.command);
  }

  /** Why this text may not be typed here, or null. The same answer for the page and for chat. */
  private textRefusal(params: DesktopCommandParams): "TEXT_TOO_LONG" | "TEXT_SENSITIVE" | null {
    if (params.action !== "desktop.input.type") return null;
    if (params.text.length > this.deps.config.typeMaxLength) return "TEXT_TOO_LONG";
    return isSensitiveDesktopText(params.text) ? "TEXT_SENSITIVE" : null;
  }

  // -------------------------------------------------------------------------
  // Chat (Stage 19.7) — a model proposes, the owner's words and a person decide
  // -------------------------------------------------------------------------

  /**
   * Everything that must hold before a person is asked, and the exact
   * parameters their approval will be bound to. The device comes from the
   * account, never from a model. Creates nothing and sends nothing.
   */
  async propose(input: {
    userId: string;
    action: DesktopChatToolId;
    params: Record<string, unknown>;
    ownerMessage: string;
  }): Promise<DesktopChatProposal> {
    const refuse = (code: DesktopChatRefusalCode): DesktopChatProposal => ({ ok: false, code, message: DESKTOP_CHAT_REFUSALS[code] });
    // Only the field this action has: anything else a model sent, a device id
    // among them, is not carried forward.
    const field = input.action === "desktop.app.launch" ? { app: input.params.app } : { text: input.params.text };
    const request = parseDesktopMessage(DesktopCommandRequestSchema, { action: input.action, ...field });
    if (!request) return refuse(input.action === "desktop.app.launch" ? "UNKNOWN_APP" : "INVALID_TEXT");

    const owner = desktopOwnerAuthorization(input.action, field, input.ownerMessage);
    if (!owner.ok) return refuse(owner.code);

    const params = desktopCommandParams(request);
    const refused = this.textRefusal(params);
    if (refused) return refuse(refused);

    try {
      const own = (await this.deps.store.listDevices({ userId: input.userId, adminTenantIds: [] })).filter(
        (device) => device.userId === input.userId && device.status === "active"
      );
      if (own.length === 0) return refuse("NO_DEVICE");

      const ready: Array<{ device: DesktopDeviceRecord; grant: DesktopGrantRecord }> = [];
      for (const device of own) {
        try {
          ready.push(await this.controllableDevice(input.userId, device.id, input.action));
        } catch (error) {
          if (!(error instanceof DesktopControlError)) throw error;
        }
      }
      if (ready.length === 0) return refuse("NO_GRANT");
      if (ready.length > 1) return refuse("SEVERAL_DEVICES");

      const { device, grant } = ready[0]!;
      const approvalParams = desktopApprovalParams(params, device.id);
      const paramsHash = computeParamsHash(approvalParams);
      // An uncertain command may have run: the same words do not go out again
      // under this consent. A person who has looked can still use the page.
      const earlier = await this.deps.store.listCommands(device.id);
      if (earlier.some((command) => command.grantId === grant.id && command.paramsHash === paramsHash && command.status === "unknown")) {
        return refuse("ALREADY_UNKNOWN");
      }
      return { ok: true, params: approvalParams };
    } catch {
      return refuse("UNAVAILABLE");
    }
  }

  /**
   * Runs an action a person has approved: the same confirmation the page
   * uses, then a bounded wait for the computer's answer. Nothing is sent twice:
   * the approval is spent once, and a wait that runs out says so and stops.
   */
  async runApproved(input: {
    userId: string;
    action: DesktopChatToolId;
    params: Record<string, unknown>;
    approvalId: string;
    signal?: AbortSignal;
  }): Promise<DesktopChatReport> {
    const deviceId = input.params.deviceId;
    if (typeof deviceId !== "string") {
      return { outcome: "not-sent", code: "INVALID_REQUEST", message: "That action does not name a computer, so nothing was sent." };
    }
    let issued: DesktopCommandView;
    try {
      issued = await this.confirmCommand(input.userId, deviceId, input.approvalId);
    } catch (error) {
      if (!(error instanceof DesktopControlError)) throw error;
      return { outcome: "not-sent", code: error.code, message: `${error.message} Nothing was sent.` };
    }
    const settled = await this.awaitCommand(input.userId, issued, input.signal);
    const app = input.action === "desktop.app.launch" ? (input.params.app as DesktopAppId) : undefined;
    return desktopChatReport({ action: input.action, ...(app ? { app } : {}), status: settled.status, resultCode: settled.resultCode });
  }

  /** The command as it stands when it settles, when the wait runs out, or when the caller stops waiting. */
  private async awaitCommand(userId: string, issued: DesktopCommandView, signal?: AbortSignal): Promise<DesktopCommandView> {
    const deadline = Date.now() + (this.deps.resultWaitMs ?? DESKTOP_RESULT_WAIT_MS);
    let latest = issued;
    while (!FINAL_COMMAND_STATES.has(latest.status) && Date.now() < deadline && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, this.deps.resultPollMs ?? RESULT_POLL_MS));
      try {
        latest = await this.getCommand(userId, issued.id);
      } catch {
        // A failed read says nothing about the computer; the wait goes on.
      }
    }
    return latest;
  }

  async getCommand(userId: string, commandId: string): Promise<DesktopCommandView> {
    const command = await this.deps.store.findCommand(commandId);
    const device = command ? await this.deps.store.findDevice(command.deviceId) : null;
    if (!command || !device || device.userId !== userId) throw new DesktopControlError("NOT_FOUND");
    if (!(await this.ownerStillAuthorized(device))) throw new DesktopControlError("NOT_AUTHORIZED");
    return commandView(command);
  }

  async listCommands(userId: string, deviceId: string): Promise<DesktopCommandView[]> {
    const device = await this.deps.store.findDevice(deviceId);
    if (!device || device.userId !== userId) throw new DesktopControlError("NOT_FOUND");
    if (!(await this.ownerStillAuthorized(device))) throw new DesktopControlError("NOT_AUTHORIZED");
    return (await this.deps.store.listCommands(deviceId)).map(commandView);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Closes what can no longer finish: EXPIRED for never delivered, UNKNOWN for never answered. Never resends. */
  async sweep(): Promise<{ expired: number; unknown: number }> {
    const now = this.now();
    const swept = await this.deps.store.sweepCommands({ now, resultGraceMs: RESULT_GRACE_MS });
    await this.journalTransitions(swept.expired, "FAILED", "NOT_DELIVERED");
    await this.journalTransitions(swept.unknown, "UNKNOWN", "AMBIGUOUS_OUTCOME");
    await this.deps.store.purge({ now, codeRetentionMs: 24 * 60 * 60_000, attemptRetentionMs: 60 * 60_000 });
    return { expired: swept.expired.length, unknown: swept.unknown.length };
  }

  // -------------------------------------------------------------------------
  // Agent-facing — signed, outbound-only
  // -------------------------------------------------------------------------

  /** Signs a response body for the request it answers (its nonce): the agent acts on nothing unsigned. */
  private respond(nonce: string, status: number, body: unknown): DesktopAgentResponse {
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    const canonical = desktopResponseCanonical({ requestNonce: nonce || "-", status, bodySha256: sha256Hex(bytes) });
    return {
      status,
      body,
      headers: {
        [DESKTOP_AGENT_HEADERS.responseSignature]: signDesktopCanonical(this.deps.config.signingKey, canonical),
        [DESKTOP_AGENT_HEADERS.responseKey]: this.deps.config.serverKeyId,
      },
    };
  }

  private refuse(nonce: string, status: number, code: DesktopErrorCode): DesktopAgentResponse {
    return { ...this.respond(nonce, status, { version: DESKTOP_PROTOCOL_VERSION, error: { code } }), refusal: code };
  }

  /**
   * Authenticates one agent request. Cheap checks first; the device's key
   * verifies the signature over the exact bytes; the nonce is spent LAST, in
   * PostgreSQL, so a forged request spends nothing and a replay — on any
   * instance — is refused. `proven` names the device from the moment its own
   * key has verified the signature, so a refusal after that point is that
   * device's. A pairing's key is the requester's own: it proves no device.
   */
  private async authenticate(
    route: DesktopAgentRoute,
    req: DesktopAgentRequest,
    proven: ProvenAgent
  ): Promise<{ device: DesktopDeviceRecord | null; body: unknown; nonce: string }> {
    const nonce = header(req.headers, DESKTOP_AGENT_HEADERS.nonce);
    if (header(req.headers, DESKTOP_AGENT_HEADERS.version) !== DESKTOP_PROTOCOL_VERSION) throw new AgentRefusal(400, "UNSUPPORTED_VERSION");
    const parts = {
      method: req.method.toUpperCase(),
      path: req.path,
      timestamp: header(req.headers, DESKTOP_AGENT_HEADERS.timestamp),
      nonce,
      device: header(req.headers, DESKTOP_AGENT_HEADERS.device),
      bodySha256: header(req.headers, DESKTOP_AGENT_HEADERS.bodySha256),
    };
    if (!desktopRequestPartsAreWellFormed(parts)) throw new AgentRefusal(401, "UNAUTHENTICATED");
    // The signed path is the route that answers: a signature made for one
    // route is never accepted by another.
    const expectedPath =
      route === "result"
        ? /^[0-9a-f-]{36}$/.test(req.commandId ?? "")
          ? `/api/v1/desktop-agent/commands/${req.commandId}/result`
          : null
        : `/api/v1/desktop-agent/${route}`;
    if (parts.path !== expectedPath) throw new AgentRefusal(401, "UNAUTHENTICATED");
    if (!isDesktopTimestampFresh(parts.timestamp, this.now().getTime())) throw new AgentRefusal(401, "REQUEST_EXPIRED");
    if (req.rawBody.length > MAX_AGENT_BODY_BYTES || sha256Hex(req.rawBody) !== parts.bodySha256) throw new AgentRefusal(401, "UNAUTHENTICATED");
    let body: unknown;
    try {
      body = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      throw new AgentRefusal(400, "INVALID_REQUEST");
    }

    let publicKey: string;
    let scope: string;
    let device: DesktopDeviceRecord | null = null;
    if (route === "pair") {
      const key = (body as { publicKey?: unknown } | null)?.publicKey;
      if (parts.device !== DESKTOP_PAIRING_DEVICE || !isP256PublicKey(key)) throw new AgentRefusal(401, "UNAUTHENTICATED");
      publicKey = key;
      scope = `pair:${desktopKeyFingerprint(key)}`;
    } else {
      if (parts.device === DESKTOP_PAIRING_DEVICE) throw new AgentRefusal(401, "UNAUTHENTICATED");
      device = await this.deps.store.findDevice(parts.device);
      if (!device) throw new AgentRefusal(401, "UNAUTHENTICATED");
      publicKey = device.publicKey;
      scope = device.id;
    }
    const signature = header(req.headers, DESKTOP_AGENT_HEADERS.signature);
    if (!verifyDesktopCanonical(publicKey, desktopRequestCanonical(parts), signature)) throw new AgentRefusal(401, "UNAUTHENTICATED");
    if (device) proven.deviceId = device.id;

    const spent = await this.deps.store.consumeNonce({
      scope,
      nonceHash: sha256Hex(nonce),
      expiresAt: new Date(Number(parts.timestamp) + DESKTOP_CLOCK_SKEW_MS * 2),
    });
    if (!spent) throw new AgentRefusal(401, "REPLAY_DETECTED");
    // Revoked: told so, in a signed answer, so the agent wipes its key.
    if (device?.status === "revoked") throw new AgentRefusal(403, "DEVICE_REVOKED");
    return { device, body, nonce };
  }

  /** The agent's version and Windows build are at or above what this deployment accepts (U6). */
  private versionRefusal(agentVersion: string, windowsBuild: number): DesktopErrorCode | null {
    const comparison = compareDesktopAgentVersions(agentVersion, this.deps.config.minAgentVersion);
    if (comparison === null || comparison < 0) return "AGENT_VERSION_UNSUPPORTED";
    if (windowsBuild < this.deps.config.minWindowsBuild) return "WINDOWS_VERSION_UNSUPPORTED";
    return null;
  }

  /** The one way in, so one request reports at most one refusal, however it was refused. */
  async handleAgent(route: DesktopAgentRoute, req: DesktopAgentRequest): Promise<DesktopAgentResponse> {
    const proven: ProvenAgent = {};
    const response = await this.answerAgent(route, req, proven);
    if (response.refusal && proven.deviceId) {
      this.deps.agentLog?.warn("desktop.agent.refused", { route, status: response.status, code: response.refusal, deviceIdHash: deviceIdHash(proven.deviceId) });
    }
    return response;
  }

  private async answerAgent(route: DesktopAgentRoute, req: DesktopAgentRequest, proven: ProvenAgent): Promise<DesktopAgentResponse> {
    const nonce = header(req.headers, DESKTOP_AGENT_HEADERS.nonce);
    try {
      const { device, body } = await this.authenticate(route, req, proven);
      switch (route) {
        case "pair":
          return await this.pair(nonce, body, req.source);
        case "poll":
          return await this.poll(nonce, device!, body);
        case "grants":
          return await this.startGrant(nonce, device!, body);
        case "session/end":
          return await this.agentEndSession(nonce, device!, body);
        case "result":
          return await this.result(nonce, device!, req.commandId ?? "", body);
      }
    } catch (error) {
      if (error instanceof AgentRefusal) return this.refuse(nonce, error.status, error.code);
      return this.refuse(nonce, 503, "UNAVAILABLE");
    }
  }

  private async pair(nonce: string, body: unknown, source: string): Promise<DesktopAgentResponse> {
    const request = parseDesktopMessage(DesktopPairRequestSchema, body);
    if (!request) return this.refuse(nonce, 400, "INVALID_REQUEST");
    if (request.architecture !== "x64") return this.refuse(nonce, 403, "WINDOWS_VERSION_UNSUPPORTED");
    const unsupported = this.versionRefusal(request.agentVersion, request.windowsBuild);
    if (unsupported) return this.refuse(nonce, 403, unsupported);

    const now = this.now();
    const allowed = await this.deps.store.reservePairingAttempt({ sourceHash: sha256Hex(`desktop-pair-source:${source}`), ...PAIRING_ATTEMPT_LIMIT, now });
    if (!allowed) return this.refuse(nonce, 429, "RATE_LIMITED");

    const normalized = normalizeDesktopPairingCode(request.pairingCode);
    if (!normalized) return this.refuse(nonce, 403, "PAIRING_CODE_INVALID");
    const redeemed = await this.deps.store.redeemPairingCode({
      codeHash: hashDesktopPairingCode(normalized),
      now,
      device: {
        publicKey: request.publicKey,
        fingerprint: desktopKeyFingerprint(request.publicKey),
        displayName: sanitizeDesktopLabel(request.deviceName, 64),
        agentVersion: request.agentVersion,
        windowsBuild: request.windowsBuild,
      },
    });
    if (!redeemed.ok) return this.refuse(nonce, redeemed.reason === "KEY_IN_USE" ? 409 : 403, redeemed.reason === "KEY_IN_USE" ? "CONFLICT" : "PAIRING_CODE_INVALID");

    const { device } = redeemed;
    // The person who made the code must still be allowed to pair (D7), read now.
    if (!(await this.ownerStillAuthorized(device))) {
      await this.deps.store.revokeDevice({ deviceId: device.id, revokedById: device.userId, now });
      await this.audit(device.userId, "desktop.device.pair", "rejected", { deviceId: device.id, reason: "NOT_AUTHORIZED" });
      return this.refuse(nonce, 403, "NOT_AUTHORIZED");
    }
    await this.audit(device.userId, "desktop.device.pair", "success", { deviceId: device.id, windowsBuild: device.windowsBuild, agentVersion: device.agentVersion });
    return this.respond(nonce, 200, {
      version: DESKTOP_PROTOCOL_VERSION,
      deviceId: device.id,
      fingerprint: device.fingerprint,
      status: "pending",
      serverKeyId: this.deps.config.serverKeyId,
      serverPublicKey: this.deps.config.serverPublicKey,
      userLabel: device.userLabel,
      organizationLabel: device.organizationLabel,
    });
  }

  /** Ends the device's grant for a reason the server decided, and records it. */
  private async endForReason(device: DesktopDeviceRecord, reason: string): Promise<void> {
    const ended = await this.deps.store.endGrant({ deviceId: device.id, grantId: null, reason, now: this.now() });
    await this.journalTransitions(ended.expired, "FAILED", "GRANT_ENDED");
    if (ended.ended) await this.audit(device.userId, "desktop.session.end", "success", { deviceId: device.id, reason });
  }

  private async poll(nonce: string, device: DesktopDeviceRecord, body: unknown): Promise<DesktopAgentResponse> {
    const request = parseDesktopMessage(DesktopPollRequestSchema, body);
    if (!request) return this.refuse(nonce, 400, "INVALID_REQUEST");
    if (device.status === "pending") {
      return this.respond(nonce, 200, { version: DESKTOP_PROTOCOL_VERSION, device: { status: "pending" }, grant: null, command: null });
    }
    if (!(await this.ownerStillAuthorized(device))) {
      await this.endForReason(device, "membership");
      return this.refuse(nonce, 403, "NOT_AUTHORIZED");
    }
    const unsupported = this.versionRefusal(request.agentVersion, request.windowsBuild);
    if (unsupported) {
      await this.endForReason(device, "unsupported");
      return this.refuse(nonce, 403, unsupported);
    }
    await this.deps.store.touchDevice({ deviceId: device.id, now: this.now(), agentVersion: request.agentVersion, windowsBuild: request.windowsBuild });

    const polled = await this.deps.store.pollGrant({
      deviceId: device.id,
      agentInstanceId: request.agentInstanceId,
      now: this.now(),
      graceMs: DESKTOP_RECONNECT_GRACE_MS,
      gapMs: RECONNECT_GAP_MS,
    });
    await this.journalTransitions(polled.expired, "FAILED", polled.ended ? "GRANT_ENDED" : "RECONNECTED");
    if (polled.ended) await this.audit(device.userId, "desktop.session.end", "success", { deviceId: device.id, reason: polled.ended.reason });

    let grant = polled.grant && polled.grant.status === "active" ? polled.grant : null;
    // The agent and the server must agree on which grant is active; when they
    // do not, the server's ends — control never continues on a guess.
    if (grant && request.grantId !== grant.id) {
      await this.endForReason(device, "mismatch");
      grant = null;
    }
    const grantState = grant
      ? { grantId: grant.id, status: "active" as const, expiresAt: grant.expiresAt.getTime() }
      : request.grantId
        ? { grantId: request.grantId, status: "ended" as const, expiresAt: 0 }
        : null;

    let command: DesktopCommandEnvelope | null = null;
    if (grant) {
      const deadline = Date.now() + this.pollHoldMs;
      for (;;) {
        command = await this.deliverNext(device, grant);
        if (command || Date.now() >= deadline || this.deps.isShuttingDown?.()) break;
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
      // The answer leaves now: the reconnect grace counts from here, not from
      // when the poll began, so a command delivered late in the hold has its
      // full time to run.
      await this.deps.store.touchGrant({ deviceId: device.id, grantId: grant.id, now: this.now() });
    }
    return this.respond(nonce, 200, { version: DESKTOP_PROTOCOL_VERSION, device: { status: "active" }, grant: grantState, command });
  }

  /** Claims and signs the device's next command, or null. A payload that does not hold together is never sent. */
  private async deliverNext(device: DesktopDeviceRecord, grant: DesktopGrantRecord): Promise<DesktopCommandEnvelope | null> {
    const claimed = await this.deps.store.claimNextCommand({ deviceId: device.id, now: this.now() });
    if (!claimed) return null;
    const { command } = claimed;
    let params: DesktopCommandParams | null = null;
    try {
      const value = JSON.parse(this.deps.sealer.unseal(claimed.sealed)) as Record<string, unknown>;
      const request = parseDesktopMessage(DesktopCommandRequestSchema, value);
      if (request && request.action === command.action) {
        const candidate = desktopCommandParams(request);
        if (computeParamsHash(desktopApprovalParams(candidate, device.id)) === command.paramsHash) params = candidate;
      }
    } catch {
      params = null;
    }
    if (!params || command.grantId !== grant.id) {
      // Delivered to nobody: it is known not to have run.
      const done = await this.deps.store.completeCommand({ commandId: command.id, deviceId: device.id, status: "NOT_EXECUTED", resultCode: "INVALID_COMMAND", now: this.now() });
      if (done?.executionId) await this.deps.journal.markFailed(done.executionId, { code: "INVALID_COMMAND" }).catch(() => null);
      return null;
    }
    const issuedAt = command.issuedAt.getTime();
    const expiresAt = command.expiresAt.getTime();
    const signature = signDesktopCanonical(
      this.deps.config.signingKey,
      desktopCommandCanonical({ commandId: command.id, deviceId: device.id, grantId: grant.id, params, issuedAt, expiresAt, requiresHello: command.requiresHello })
    );
    const { action: _action, ...rest } = params;
    return {
      commandId: command.id,
      deviceId: device.id,
      grantId: grant.id,
      action: params.action,
      params: rest,
      issuedAt,
      expiresAt,
      requiresHello: command.requiresHello,
      signature,
    } as DesktopCommandEnvelope;
  }

  private async startGrant(nonce: string, device: DesktopDeviceRecord, body: unknown): Promise<DesktopAgentResponse> {
    const request = parseDesktopMessage(DesktopGrantRequestSchema, body);
    if (!request) return this.refuse(nonce, 400, "INVALID_REQUEST");
    if (device.status !== "active") return this.refuse(nonce, 403, "DEVICE_PENDING");
    if (!(await this.ownerStillAuthorized(device))) return this.refuse(nonce, 403, "NOT_AUTHORIZED");
    const scope = canonicalDesktopScope(request.scope);
    if (!scope) return this.refuse(nonce, 400, "GRANT_INVALID");
    // Older wording promised less than this release can do, so it is not
    // consent to it. The agent tells the person to update.
    if (request.consentTextVersion !== DESKTOP_CONSENT_TEXT_VERSION) {
      await this.audit(device.userId, "desktop.grant.start", "rejected", { deviceId: device.id, reason: "CONSENT_VERSION" });
      return this.refuse(nonce, 400, "CONSENT_MISMATCH");
    }
    // The text the person saw, rendered here from the same version and the
    // same labels: a hash that differs means they saw something else.
    const expected = desktopConsentTextSha256(
      renderDesktopConsentText({ userLabel: device.userLabel, organizationLabel: device.organizationLabel, durationMinutes: request.durationMinutes, scope })
    );
    if (expected !== request.consentTextSha256) {
      await this.audit(device.userId, "desktop.grant.start", "rejected", { deviceId: device.id, reason: "CONSENT_MISMATCH" });
      return this.refuse(nonce, 400, "CONSENT_MISMATCH");
    }
    const now = this.now();
    const started = await this.deps.store.startGrant({
      deviceId: device.id,
      grant: {
        id: request.grantId,
        agentInstanceId: request.agentInstanceId,
        scope,
        durationMinutes: request.durationMinutes,
        consentTextVersion: request.consentTextVersion,
        consentTextSha256: request.consentTextSha256,
        grantedAt: now,
        expiresAt: new Date(now.getTime() + request.durationMinutes * 60_000),
        lastContactAt: now,
      },
      replacesGrantId: request.replacesGrantId,
    });
    if (!started.ok) return this.refuse(nonce, 409, started.reason === "DEVICE_INACTIVE" ? "DEVICE_PENDING" : "GRANT_CONFLICT");
    await this.audit(device.userId, "desktop.grant.start", "success", {
      deviceId: device.id,
      grantId: started.grant.id,
      scope,
      durationMinutes: request.durationMinutes,
      consentTextVersion: request.consentTextVersion,
      consentTextSha256: request.consentTextSha256,
      extended: request.replacesGrantId !== null,
    });
    return this.respond(nonce, 200, {
      version: DESKTOP_PROTOCOL_VERSION,
      grant: { grantId: started.grant.id, status: "active", expiresAt: started.grant.expiresAt.getTime() },
    });
  }

  private async agentEndSession(nonce: string, device: DesktopDeviceRecord, body: unknown): Promise<DesktopAgentResponse> {
    const request = parseDesktopMessage(DesktopSessionEndRequestSchema, body);
    if (!request) return this.refuse(nonce, 400, "INVALID_REQUEST");
    const ended = await this.deps.store.endGrant({ deviceId: device.id, grantId: request.grantId, reason: request.reason, now: this.now() });
    await this.journalTransitions(ended.expired, "FAILED", "GRANT_ENDED");
    await this.audit(device.userId, "desktop.session.end", "success", { deviceId: device.id, grantId: request.grantId, reason: request.reason, ended: ended.ended });
    return this.respond(nonce, 200, { version: DESKTOP_PROTOCOL_VERSION, ok: true });
  }

  /** One answer per command, from its device, while the device and its user still may act. */
  private async result(nonce: string, device: DesktopDeviceRecord, commandId: string, body: unknown): Promise<DesktopAgentResponse> {
    const result = parseDesktopMessage(DesktopCommandResultSchema, body);
    if (!result) return this.refuse(nonce, 400, "INVALID_REQUEST");
    if (device.status !== "active") return this.refuse(nonce, 403, "DEVICE_PENDING");
    if (!(await this.ownerStillAuthorized(device))) return this.refuse(nonce, 403, "NOT_AUTHORIZED");
    const status = result.outcome === "succeeded" ? "SUCCEEDED" : result.outcome === "not-executed" ? "NOT_EXECUTED" : "UNKNOWN";
    const code = result.outcome === "not-executed" ? result.code : result.outcome === "uncertain" ? "INTERRUPTED" : null;
    const done = await this.deps.store.completeCommand({ commandId, deviceId: device.id, status, resultCode: code, now: this.now() });
    if (!done) return this.refuse(nonce, 409, "CONFLICT");
    // An answer is contact: a command that took most of its time (Windows
    // Hello, say) does not cost the grant its reconnect grace.
    await this.deps.store.touchGrant({ deviceId: device.id, grantId: done.grantId, now: this.now() });
    if (done.executionId) {
      if (status === "SUCCEEDED") await this.deps.journal.markSucceeded(done.executionId).catch(() => null);
      else if (status === "NOT_EXECUTED") await this.deps.journal.markFailed(done.executionId, { code: code! }).catch(() => null);
      else await this.deps.journal.markUnknown(done.executionId, { code: "AMBIGUOUS_OUTCOME", message: "The computer was interrupted while acting." }).catch(() => null);
    }
    await this.audit(device.userId, "desktop.command.result", status === "SUCCEEDED" ? "success" : "failure", {
      deviceId: device.id,
      commandId,
      action: done.action,
      outcome: result.outcome,
      ...(code ? { code } : {}),
    });
    return this.respond(nonce, 200, { version: DESKTOP_PROTOCOL_VERSION, ok: true });
  }
}

