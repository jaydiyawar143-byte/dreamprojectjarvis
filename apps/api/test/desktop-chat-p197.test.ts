// ---------------------------------------------------------------------------
// Phase 19.7 — the desktop service's rules for an application and for typing.
//
// The real service, with its stores in memory, so no database is needed: these
// are the decisions, and desktop-chat-e2e-p197-pg runs them on PostgreSQL with
// a signing agent. Every rule here holds for the Computer Control page and for
// chat alike, because both arrive at the same methods.
// ---------------------------------------------------------------------------

import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_CHAT_REFUSALS,
  DESKTOP_TYPE_TEXT_DEFAULT_MAX_LENGTH,
  DESKTOP_TYPE_TEXT_MAX_LENGTH,
  computeParamsHash,
} from "@jarvis/core";

import { loadDesktopAgentConfig } from "../src/services/desktop/config.js";
import { DesktopControlError, DesktopControlService } from "../src/services/desktop/desktop-control-service.js";

const OWNER = "owner-1";
const ORG = "org-one";
const DEVICE = "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c";
const OTHER_DEVICE = "9f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c";
const NOW = new Date("2026-11-01T10:00:00Z");
const DB_DETAIL = "connection refused: db.internal:5432";

const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const baseEnv = {
  DESKTOP_AGENT_ENABLED: "true",
  DESKTOP_AGENT_COMMAND_SIGNING_KEY: signing.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  DESKTOP_AGENT_MIN_WINDOWS_BUILD: "26100",
} as NodeJS.ProcessEnv;

function config(extra: Record<string, string> = {}) {
  const loaded = loadDesktopAgentConfig({ ...baseEnv, ...extra } as NodeJS.ProcessEnv);
  if (!loaded.enabled) throw new Error(loaded.reason);
  return loaded.config;
}

const device = (overrides: Record<string, unknown> = {}) => ({ id: DEVICE, userId: OWNER, tenantId: ORG, status: "active", ...overrides });
const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "grant-1",
  deviceId: DEVICE,
  scope: ["desktop.input.click", "desktop.input.key", "desktop.input.type", "desktop.app.launch"],
  durationMinutes: 15,
  expiresAt: new Date(NOW.getTime() + 600_000),
  lastContactAt: NOW,
  status: "active",
  ...overrides,
});

let devices: ReturnType<typeof device>[];
let grants: Map<string, ReturnType<typeof grant>>;
let commands: Array<Record<string, unknown>>;
let memberRole: string | null;

const store = {
  listDevices: vi.fn(async () => devices),
  findDevice: vi.fn(async (id: string) => devices.find((d) => d.id === id) ?? null),
  activeGrant: vi.fn(async (id: string) => grants.get(id) ?? null),
  listCommands: vi.fn(async () => commands),
  findCommand: vi.fn(async (id: string) => commands.find((c) => c.id === id) ?? null),
  issueCommand: vi.fn(async (input: Record<string, unknown>) => {
    const command = {
      id: `cmd-${commands.length + 1}`,
      deviceId: input.deviceId,
      grantId: input.grantId,
      action: input.action,
      paramsHash: input.paramsHash,
      requiresHello: input.requiresHello,
      status: "issued",
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 30_000),
      completedAt: null,
      resultCode: null,
    };
    commands.push(command);
    return { ok: true, command };
  }),
};

const memberships = { findMembership: vi.fn(async () => (memberRole ? { role: memberRole } : null)), listMemberships: vi.fn(async () => []) };
const audit = { log: vi.fn(async () => undefined) };

const approvalRows = new Map<string, Record<string, unknown>>();
const approvals = {
  create: vi.fn(async (data: Record<string, unknown>) => {
    const row = { ...data, id: `apr-${approvalRows.size + 1}`, status: "pending" };
    approvalRows.set(row.id, row);
    return row;
  }),
  findById: vi.fn(async (id: string) => approvalRows.get(id) ?? null),
  decideApproval: vi.fn(async (id: string) => {
    approvalRows.get(id)!.status = "approved";
    return { outcome: "approved" };
  }),
  consumeForExecution: vi.fn(async () => ({ ok: true })),
};
const journal = {
  begin: vi.fn(async () => ({ executionId: "exec-1", status: "IN_PROGRESS" })),
  markSucceeded: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => undefined),
  markUnknown: vi.fn(async () => undefined),
};
const sealer = { seal: vi.fn((value: string) => `sealed:${value}`), unseal: vi.fn((value: string) => value.replace(/^sealed:/, "")) };

function service(extra: Record<string, string> = {}, deps: Record<string, unknown> = {}) {
  return new DesktopControlService({
    store: store as never,
    memberships: memberships as never,
    approvals: approvals as never,
    journal: journal as never,
    sealer: sealer as never,
    audit: audit as never,
    slots: { reserve: vi.fn(async () => ({ allowed: true })) } as never,
    config: config(extra),
    now: () => NOW,
    resultWaitMs: 40,
    resultPollMs: 5,
    ...deps,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  devices = [device()];
  grants = new Map([[DEVICE, grant()]]);
  commands = [];
  memberRole = "owner";
  approvalRows.clear();
});

const launch = (app: unknown, ownerMessage = "Open Notepad.", svc = service()) =>
  svc.propose({ userId: OWNER, action: "desktop.app.launch", params: { app }, ownerMessage });
const type = (text: unknown, ownerMessage = `Type ${String(text)}`, svc = service()) =>
  svc.propose({ userId: OWNER, action: "desktop.input.type", params: { text }, ownerMessage });

const refusal = (code: keyof typeof DESKTOP_CHAT_REFUSALS) => ({ ok: false, code, message: DESKTOP_CHAT_REFUSALS[code] });

describe("Phase 19.7 — a proposal", () => {
  it("binds the approval to the computer the server found", async () => {
    expect(await launch("notepad")).toEqual({ ok: true, params: { deviceId: DEVICE, app: "notepad" } });
  });

  it("takes no device from a model, and nothing else it sent", async () => {
    const proposal = await service().propose({
      userId: OWNER,
      action: "desktop.app.launch",
      params: { app: "notepad", deviceId: OTHER_DEVICE, args: "/c calc" },
      ownerMessage: "Open Notepad.",
    });
    expect(proposal).toEqual({ ok: true, params: { deviceId: DEVICE, app: "notepad" } });
  });

  it.each(["cmd", "calc.exe", "C:\\Windows\\System32\\cmd.exe", "..\\cmd", "Notepad", "", 7, null])("refuses %j as an application, reading nothing", async (app) => {
    expect(await launch(app)).toEqual(refusal("UNKNOWN_APP"));
    expect(store.listDevices).not.toHaveBeenCalled();
  });

  it("refuses what the owner did not ask for before it reads any device", async () => {
    expect(await launch("chrome", "Open Notepad.")).toEqual(refusal("NOT_ASKED"));
    expect(store.listDevices).not.toHaveBeenCalled();
  });

  it("creates nothing, whatever it answers", async () => {
    await launch("notepad");
    await launch("chrome");
    expect(approvals.create).not.toHaveBeenCalled();
    expect(store.issueCommand).not.toHaveBeenCalled();
  });
});

describe("Phase 19.7 — which computer", () => {
  it("says so when no computer is paired", async () => {
    devices = [];
    expect(await launch("notepad")).toEqual(refusal("NO_DEVICE"));
  });

  it.each(["pending", "revoked"])("does not use a device that is %s", async (status) => {
    devices = [device({ status })];
    expect(await launch("notepad")).toEqual(refusal("NO_DEVICE"));
  });

  it("does not use a colleague's device that the caller only administers", async () => {
    devices = [device({ userId: "someone-else" })];
    expect(await launch("notepad")).toEqual(refusal("NO_DEVICE"));
  });

  it("asks for no administered devices at all", async () => {
    await launch("notepad");
    expect(store.listDevices).toHaveBeenCalledWith({ userId: OWNER, adminTenantIds: [] });
  });

  it("refuses to guess between two computers that both allow control", async () => {
    devices = [device(), device({ id: OTHER_DEVICE })];
    grants.set(OTHER_DEVICE, grant({ deviceId: OTHER_DEVICE }));
    expect(await launch("notepad")).toEqual(refusal("SEVERAL_DEVICES"));
  });

  it("uses the one that allows control when only one does", async () => {
    devices = [device({ id: OTHER_DEVICE }), device()];
    expect(await launch("notepad")).toEqual({ ok: true, params: { deviceId: DEVICE, app: "notepad" } });
  });
});

describe("Phase 19.7 — consent and the grant", () => {
  it.each([
    ["no grant", () => grants.clear()],
    ["an expired grant", () => grants.set(DEVICE, grant({ expiresAt: new Date(NOW.getTime() - 1) }))],
    ["a computer silent past the grace", () => grants.set(DEVICE, grant({ lastContactAt: new Date(NOW.getTime() - 31_000) }))],
    ["a grant that does not cover a launch", () => grants.set(DEVICE, grant({ scope: ["desktop.input.click", "desktop.input.key"] }))],
  ])("refuses with %s", async (_name, arrange) => {
    arrange();
    expect(await launch("notepad")).toEqual(refusal("NO_GRANT"));
  });

  it("holds typing to its own scope", async () => {
    grants.set(DEVICE, grant({ scope: ["desktop.app.launch"] }));
    expect(await type("Hello")).toEqual(refusal("NO_GRANT"));
  });

  it("refuses someone who has left the Organization", async () => {
    memberRole = null;
    expect(await launch("notepad")).toEqual(refusal("NO_GRANT"));
  });
});

describe("Phase 19.7 — an uncertain command is not sent again", () => {
  const hash = computeParamsHash({ deviceId: DEVICE, app: "notepad" });

  it("refuses the same action while its outcome is unknown", async () => {
    commands = [{ id: "c", grantId: "grant-1", paramsHash: hash, status: "unknown" }];
    expect(await launch("notepad")).toEqual(refusal("ALREADY_UNKNOWN"));
  });

  it("does not hold a different action to it", async () => {
    commands = [{ id: "c", grantId: "grant-1", paramsHash: computeParamsHash({ deviceId: DEVICE, app: "calculator" }), status: "unknown" }];
    expect((await launch("notepad")).ok).toBe(true);
  });

  it("does not hold fresh consent to it", async () => {
    commands = [{ id: "c", grantId: "an-earlier-grant", paramsHash: hash, status: "unknown" }];
    expect((await launch("notepad")).ok).toBe(true);
  });

  it.each(["succeeded", "not_executed", "expired"])("lets the owner ask again after %s", async (status) => {
    commands = [{ id: "c", grantId: "grant-1", paramsHash: hash, status }];
    expect((await launch("notepad")).ok).toBe(true);
  });
});

describe("Phase 19.7 — when the stores cannot answer", () => {
  it("refuses, and repeats nothing of why", async () => {
    store.listDevices.mockRejectedValueOnce(new Error(DB_DETAIL));
    const proposal = await launch("notepad");
    expect(proposal).toEqual(refusal("UNAVAILABLE"));
    expect(JSON.stringify(proposal)).not.toContain("db.internal");
  });

  it("refuses when the list of commands cannot be read: an unknown command might be hiding there", async () => {
    store.listCommands.mockRejectedValueOnce(new Error(DB_DETAIL));
    expect(await launch("notepad")).toEqual(refusal("UNAVAILABLE"));
  });
});

describe("Phase 19.7 — text", () => {
  it.each(["line\nbreak", "tab\there", "bell\u0007", "hidden\u200bspace", "over\u202eride"])("refuses %j, which cannot be typed or read", async (text) => {
    expect(await type(text)).toEqual(refusal("INVALID_TEXT"));
  });

  it("refuses text over this deployment's limit", async () => {
    const svc = service({ DESKTOP_TYPE_MAX_LENGTH: "5" });
    expect(await type("Hello", undefined, svc)).toMatchObject({ ok: true });
    expect(await type("Hello!", undefined, svc)).toEqual(refusal("TEXT_TOO_LONG"));
  });

  it.each([
    "password: hunter2",
    "my password is hunter2",
    "sk-abc123def456ghi789jkl012mno345pq",
    "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    "4111 1111 1111 1111",
  ])("never types %j, and does not repeat it", async (text) => {
    const proposal = await type(text);
    expect(proposal).toEqual(refusal("TEXT_SENSITIVE"));
    expect(JSON.stringify(proposal)).not.toContain(text);
  });

  it("accepts the owner's sentence", async () => {
    const text = "Hello Sirish, JARVIS is online.";
    expect(await type(text)).toEqual({ ok: true, params: { deviceId: DEVICE, text } });
  });
});

describe("Phase 19.7 — the same rules on the Computer Control page", () => {
  const code = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      if (error instanceof DesktopControlError) return error.code;
      throw error;
    }
    return "no refusal";
  };

  it("asks for a launch by id", async () => {
    const asked = await service().requestCommand(OWNER, DEVICE, { action: "desktop.app.launch", app: "chrome" });
    expect(asked).toMatchObject({ action: "desktop.app.launch", summary: "Open Google Chrome on the paired Windows desktop.", requiresHello: false });
    expect(approvals.create).toHaveBeenCalledWith(expect.objectContaining({ toolId: "desktop.app.launch", params: { deviceId: DEVICE, app: "chrome" } }));
  });

  it.each(["cmd", "C:\\Windows\\System32\\cmd.exe", "notepad.exe"])("refuses %j", async (app) => {
    expect(await code(service().requestCommand(OWNER, DEVICE, { action: "desktop.app.launch", app }))).toBe("INVALID_REQUEST");
  });

  it("refuses a launch the grant does not cover", async () => {
    grants.set(DEVICE, grant({ scope: ["desktop.input.click"] }));
    expect(await code(service().requestCommand(OWNER, DEVICE, { action: "desktop.app.launch", app: "notepad" }))).toBe("GRANT_REQUIRED");
  });

  it("refuses sensitive text and text over the limit", async () => {
    expect(await code(service().requestCommand(OWNER, DEVICE, { action: "desktop.input.type", text: "password: hunter2" }))).toBe("TEXT_SENSITIVE");
    expect(await code(service({ DESKTOP_TYPE_MAX_LENGTH: "3" }).requestCommand(OWNER, DEVICE, { action: "desktop.input.type", text: "Hello" }))).toBe("TEXT_TOO_LONG");
  });

  it("holds an approval to the rule at the moment it is spent, however it was made", async () => {
    const params = { deviceId: DEVICE, text: "password: hunter2" };
    approvalRows.set("apr-9", { id: "apr-9", userId: OWNER, toolId: "desktop.input.type", params, paramsHash: computeParamsHash(params), status: "approved" });
    expect(await code(service().confirmCommand(OWNER, DEVICE, "apr-9"))).toBe("TEXT_SENSITIVE");
    expect(approvals.consumeForExecution).not.toHaveBeenCalled();
    expect(store.issueCommand).not.toHaveBeenCalled();
  });

  it("records which application and where the request came from, and nothing typed", async () => {
    const svc = service();
    const asked = await svc.requestCommand(OWNER, DEVICE, { action: "desktop.app.launch", app: "calculator" });
    await svc.confirmCommand(OWNER, DEVICE, asked.approvalId);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "desktop.command.issue", parameters: expect.objectContaining({ app: "calculator", origin: "page" }) }));
  });
});

describe("Phase 19.7 — running an approved action", () => {
  async function approved(params: Record<string, unknown>, action = "desktop.app.launch", extra: Record<string, unknown> = {}) {
    const row = { id: "apr-7", userId: OWNER, toolId: action, params, paramsHash: computeParamsHash(params), status: "approved", ...extra };
    approvalRows.set(row.id, row);
    return row.id;
  }

  const LAUNCH = { deviceId: DEVICE, app: "notepad" };
  const run = (svc: DesktopControlService, approvalId: string, extra: Record<string, unknown> = {}) =>
    svc.runApproved({ userId: OWNER, action: "desktop.app.launch", params: LAUNCH, approvalId, ...extra });

  /** The computer answers shortly after the command is issued. */
  const answerWith = (status: string, resultCode: string | null = null) => {
    store.issueCommand.mockImplementationOnce((async (input: Record<string, unknown>) => {
      const command = { id: "cmd-1", deviceId: DEVICE, grantId: input.grantId, action: input.action, paramsHash: input.paramsHash, requiresHello: false, status: "issued", issuedAt: NOW, expiresAt: NOW, completedAt: null, resultCode: null as string | null };
      commands.push(command);
      setTimeout(() => Object.assign(command, { status, resultCode }), 10);
      return { ok: true, command: { ...command } };
    }) as never);
  };

  it("reports what the computer answered", async () => {
    answerWith("succeeded");
    const report = await run(service(), await approved(LAUNCH));
    expect(report).toMatchObject({ outcome: "succeeded", code: null });
    expect(report.message).toContain("Windows started Notepad.");
  });

  it("names the origin as chat when the approval came from a conversation", async () => {
    answerWith("succeeded");
    await run(service(), await approved(LAUNCH, "desktop.app.launch", { conversationId: "conv-1" }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "desktop.command.issue", parameters: expect.objectContaining({ origin: "chat", app: "notepad" }) }));
  });

  it("reports a refusal from the computer as nothing done", async () => {
    answerWith("not_executed", "APP_NOT_INSTALLED");
    expect(await run(service(), await approved(LAUNCH))).toMatchObject({ outcome: "not-executed", code: "APP_NOT_INSTALLED" });
  });

  it("reports an uncertain outcome as unknown", async () => {
    answerWith("unknown", "INTERRUPTED");
    expect(await run(service(), await approved(LAUNCH))).toMatchObject({ outcome: "unknown" });
  });

  it("stops waiting and says so, having sent it once", async () => {
    const report = await run(service(), await approved(LAUNCH));
    expect(report.outcome).toBe("no-answer");
    expect(report.message).toContain("will not be sent again");
    expect(store.issueCommand).toHaveBeenCalledTimes(1);
  });

  it("stops waiting the moment the caller does", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const report = await run(service({}, { resultWaitMs: 60_000 }), await approved(LAUNCH), { signal: controller.signal });
    expect(report.outcome).toBe("no-answer");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("keeps waiting through a failed read: it says nothing about the computer", async () => {
    answerWith("succeeded");
    store.findCommand.mockRejectedValueOnce(new Error(DB_DETAIL));
    expect((await run(service(), await approved(LAUNCH))).outcome).toBe("succeeded");
  });

  it("says nothing was sent when control ended before it could be", async () => {
    const approvalId = await approved(LAUNCH);
    grants.clear();
    const report = await run(service(), approvalId);
    expect(report).toMatchObject({ outcome: "not-sent", code: "GRANT_REQUIRED" });
    expect(store.issueCommand).not.toHaveBeenCalled();
  });

  it("sends nothing without a device", async () => {
    const report = await service().runApproved({ userId: OWNER, action: "desktop.app.launch", params: { app: "notepad" }, approvalId: "apr-1" });
    expect(report.outcome).toBe("not-sent");
    expect(approvals.findById).not.toHaveBeenCalled();
  });

  it("sends nothing on another person's approval", async () => {
    const approvalId = await approved(LAUNCH, "desktop.app.launch", { userId: "someone-else" });
    expect((await run(service(), approvalId)).outcome).toBe("not-sent");
    expect(store.issueCommand).not.toHaveBeenCalled();
  });

  it("sends nothing on an approval for another application", async () => {
    const approvalId = await approved({ deviceId: DEVICE, app: "chrome" }, "desktop.app.launch", { paramsHash: computeParamsHash(LAUNCH) });
    expect((await run(service(), approvalId)).outcome).toBe("not-sent");
    expect(store.issueCommand).not.toHaveBeenCalled();
  });

  it("lets a store failure escape: whether it was sent is not something to guess", async () => {
    const approvalId = await approved(LAUNCH);
    store.issueCommand.mockRejectedValueOnce(new Error(DB_DETAIL));
    await expect(run(service(), approvalId)).rejects.toThrow();
  });
});

describe("Phase 19.7 — the configured limit", () => {
  const reason = (value: string) => {
    const loaded = loadDesktopAgentConfig({ ...baseEnv, DESKTOP_TYPE_MAX_LENGTH: value } as NodeJS.ProcessEnv);
    return loaded.enabled ? null : loaded.reason;
  };

  it("defaults below the protocol's bound", () => {
    expect(config().typeMaxLength).toBe(DESKTOP_TYPE_TEXT_DEFAULT_MAX_LENGTH);
    expect(DESKTOP_TYPE_TEXT_DEFAULT_MAX_LENGTH).toBeLessThan(DESKTOP_TYPE_TEXT_MAX_LENGTH);
  });

  it("may be set up to the protocol's bound", () => {
    expect(config({ DESKTOP_TYPE_MAX_LENGTH: String(DESKTOP_TYPE_TEXT_MAX_LENGTH) }).typeMaxLength).toBe(DESKTOP_TYPE_TEXT_MAX_LENGTH);
  });

  it.each(["0", "-1", "1.5", "lots", String(DESKTOP_TYPE_TEXT_MAX_LENGTH + 1)])("keeps desktop control off for %s, and says which setting", (value) => {
    expect(reason(value)).toContain("DESKTOP_TYPE_MAX_LENGTH");
  });
});
