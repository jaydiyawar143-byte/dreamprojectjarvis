// ---------------------------------------------------------------------------
// Phase 19.7 — the two desktop tools, through the real executor.
//
// They forward to one port and hold nothing else. These pin that a tool never
// runs on its own say-so (no approval, no executor grant, no device, a spoken
// turn), and that what it reports is what the computer answered: only the
// computer's own "succeeded" is a success.
//
// The port is a stand-in, and nothing here reaches a computer. Named
// `computer-control*`, the slice CI runs for this package.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_APP_IDS,
  VOICE_REFUSED_TOOLS,
  computeParamsHash,
  type Approval,
  type AuditLogger,
  type DesktopChatReport,
  type IApprovalManager,
  type IPermissionChecker,
  type Role,
  type ToolContext,
} from "@jarvis/core";

import { ToolExecutor } from "../src/executor.js";
import { DesktopAppLaunchTool, DesktopTypeTextTool, createDesktopTools } from "../src/tools/desktop-tools.js";

const DEVICE = "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c";
const USER = "owner-1";
const allowAll: IPermissionChecker = { hasPermission: () => true };
const audit = { log: async () => undefined } as unknown as AuditLogger;

const STARTED: DesktopChatReport = { outcome: "succeeded", code: null, message: "Windows started Notepad." };

function port(report: DesktopChatReport = STARTED) {
  return { runApproved: vi.fn(async () => report) };
}

function approved(toolId: string, params: Record<string, unknown>): Approval {
  return {
    id: "apr-desktop-1",
    userId: USER,
    toolId,
    action: "execute",
    params,
    paramsHash: computeParamsHash(params),
    status: "approved",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function executor(tool: DesktopAppLaunchTool | DesktopTypeTextTool, approval: Approval | null) {
  const approvals: IApprovalManager = {
    requestApproval: vi.fn(async (data) => ({ ...approved(tool.id, data.params), id: "apr-new", status: "pending" as const })),
    findExistingForTool: vi.fn(async () => approval),
    findApprovalsForTool: vi.fn(async () => (approval ? [approval] : [])),
  };
  return {
    approvals,
    run: new ToolExecutor({ get: (id: string) => (id === tool.id ? tool : undefined) }, allowAll, approvals, audit, {
      accessGate: { check: async () => ({ allowed: true }) },
    }),
  };
}

const request = (toolId: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  toolId,
  params,
  userId: USER,
  role: "owner" as Role,
  traceId: "trace-1",
  approvalId: "apr-desktop-1",
  ...extra,
});

const LAUNCH = { deviceId: DEVICE, app: "notepad" };
const TYPE = { deviceId: DEVICE, text: "Hello Sirish, JARVIS is online." };

describe("Phase 19.7 — what the tools are", () => {
  it("are two, with no parameter for a path, a device or an argument", () => {
    const tools = createDesktopTools(port());
    expect(tools.map((t) => t.id)).toEqual(["desktop.app.launch", "desktop.input.type"]);
    expect(tools[0]!.parameters.map((p) => p.name)).toEqual(["app"]);
    expect(tools[1]!.parameters.map((p) => p.name)).toEqual(["text"]);
    for (const id of DESKTOP_APP_IDS) expect(tools[0]!.parameters[0]!.description).toContain(id);
  });

  it("need an approval, and are refused to a spoken turn", () => {
    for (const tool of createDesktopTools(port())) {
      expect(tool.requiresApproval).toBe(true);
      expect(tool.risk).toBe("EXTERNAL_SIDE_EFFECT");
      expect(VOICE_REFUSED_TOOLS[tool.id]).toBeDefined();
    }
  });

  it("hold no provider logic: one port, and no signing, store or HTTP of their own", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/tools/desktop-tools.ts"), "utf8");
    const code = source.split("\n").filter((line) => !line.startsWith("//")).join("\n");
    expect(code).not.toMatch(/\bfetch\(|https?:|node:|prisma|signDesktop|createSign/i);
  });
});

describe("Phase 19.7 — validation at the tool's edge", () => {
  const launch = new DesktopAppLaunchTool(port());
  const type = new DesktopTypeTextTool(port());

  it.each(DESKTOP_APP_IDS)("accepts %s with the server's device", (app) => {
    expect(launch.validate({ deviceId: DEVICE, app })).toBe(true);
  });

  it.each([
    ["no device: it never went through the proposal", { app: "notepad" }],
    ["an unknown id", { deviceId: DEVICE, app: "cmd" }],
    ["a path", { deviceId: DEVICE, app: "C:\\Windows\\System32\\cmd.exe" }],
    ["an argument", { deviceId: DEVICE, app: "notepad", args: "x" }],
    ["no application", { deviceId: DEVICE }],
  ])("refuses a launch with %s", (_name, params) => {
    expect(launch.validate(params)).toBe(false);
  });

  it("refuses typing with no device, or no text", () => {
    expect(type.validate({ text: "Hello" })).toBe(false);
    expect(type.validate({ deviceId: DEVICE })).toBe(false);
    expect(type.validate({ deviceId: DEVICE, text: "Hello" })).toBe(true);
  });
});

describe("Phase 19.7 — a tool runs only through the executor, on an approval", () => {
  it("does nothing when called directly, however good the context looks", async () => {
    const fake = port();
    const tool = new DesktopAppLaunchTool(fake);
    const context: ToolContext = { userId: USER, approvalId: "apr-desktop-1" };
    const result = await tool.execute(LAUNCH, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("nothing was done");
    expect(fake.runApproved).not.toHaveBeenCalled();
  });

  it("asks for an approval and runs nothing when none exists", async () => {
    const fake = port();
    const tool = new DesktopAppLaunchTool(fake);
    const { run, approvals } = executor(tool, null);
    const result = await run.execute(request(tool.id, LAUNCH, { approvalId: undefined }));
    expect(result.status).toBe("approval_pending");
    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(fake.runApproved).not.toHaveBeenCalled();
  });

  it("runs once on an approved approval, naming it, the user and the exact parameters", async () => {
    const fake = port();
    const tool = new DesktopAppLaunchTool(fake);
    const result = await executor(tool, approved(tool.id, LAUNCH)).run.execute(request(tool.id, LAUNCH));
    expect(result.status).toBe("completed");
    expect(fake.runApproved).toHaveBeenCalledTimes(1);
    expect(fake.runApproved).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, action: "desktop.app.launch", params: LAUNCH, approvalId: "apr-desktop-1" }));
  });

  it("passes the executor's deadline on, so a wait stops when the execution does", async () => {
    const fake = port();
    const tool = new DesktopAppLaunchTool(fake);
    await executor(tool, approved(tool.id, LAUNCH)).run.execute(request(tool.id, LAUNCH));
    expect((fake.runApproved.mock.calls[0] as unknown as [{ signal?: AbortSignal }])[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("is refused to a spoken turn before it runs, with an approval sitting ready", async () => {
    const fake = port();
    const tool = new DesktopTypeTextTool(fake);
    const result = await executor(tool, approved(tool.id, TYPE)).run.execute(request(tool.id, TYPE, { inputMode: "voice" }));
    expect(result.status).toBe("permission_denied");
    expect(fake.runApproved).not.toHaveBeenCalled();
  });
});

describe("Phase 19.7 — only the computer's own answer is a success", () => {
  const run = async (report: DesktopChatReport) => {
    const tool = new DesktopAppLaunchTool(port(report));
    return executor(tool, approved(tool.id, LAUNCH)).run.execute(request(tool.id, LAUNCH));
  };

  it("reports success with the computer's words", async () => {
    const result = await run(STARTED);
    expect(result.result).toMatchObject({ success: true, data: { outcome: "succeeded", message: "Windows started Notepad." } });
  });

  it.each([
    ["not-executed", "LAUNCH_FAILED", "Windows could not start that application, so nothing was opened."],
    ["unknown", "INTERRUPTED", "The outcome of the action is unknown; it was not retried."],
    ["no-answer", null, "The computer has not answered yet."],
    ["not-sent", "GRANT_REQUIRED", "Control has ended. Nothing was sent."],
  ] as const)("does not call %s a success", async (outcome, code, message) => {
    const result = await run({ outcome, code, message });
    expect(result.result?.success).toBe(false);
    expect(result.result?.error).toBe(message);
    expect(result.result?.data).toMatchObject({ outcome, message });
  });
});
