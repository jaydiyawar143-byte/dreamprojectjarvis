// ---------------------------------------------------------------------------
// Phase 19.7 — restricted application launch and controlled typing: the
// contract.
//
// The owner reversed D5 and added one action. These pin what that allows and,
// more to the point, what it does not: an application is a fixed id and never
// a path; the words of a chat request are the owner's own or nothing happens;
// text is exactly what was asked for, and never a secret.
//
// Named `computer-control*`, the slice CI runs for this package.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  DESKTOP_AGENT_CURRENT_VERSION,
  DESKTOP_COMMAND_ACTIONS,
  DESKTOP_COMMAND_FORMAT_VERSION,
  DESKTOP_CONSENT_TEXT_VERSION,
  DESKTOP_NOT_EXECUTED_CODES,
  DESKTOP_COMMAND_TTL_MS,
  DESKTOP_TYPE_FOCUS_WAIT_MS,
  DesktopCommandEnvelopeSchema,
  DesktopCommandRequestSchema,
  DesktopGrantRequestSchema,
  canonicalDesktopScope,
  desktopActionRequiresHello,
  desktopApprovalParams,
  desktopCommandCanonical,
  desktopCommandParams,
  desktopParamsCanonical,
  isTypeableText,
  parseDesktopMessage,
  renderDesktopConsentText,
} from "../src/desktop-agent.js";
import {
  COMPUTER_CONTROL_VOICE_REFUSED_TOOLS,
  DESKTOP_APP_IDS,
  DESKTOP_APP_LABELS,
  computerControlActionPolicy,
  computerControlApprovalRecord,
  computerControlApprovalSummary,
  computerControlValueFreeParams,
  parseComputerControlRequest,
  sealsApprovalParams,
} from "../src/computer-control.js";
import {
  DESKTOP_CHAT_EXECUTION_TIMEOUT_MS,
  DESKTOP_CHAT_REFUSALS,
  DESKTOP_CHAT_TOOL_IDS,
  DESKTOP_RESULT_WAIT_MS,
  desktopChatReport,
  desktopOwnerAuthorization,
  isDesktopChatTool,
  isSensitiveDesktopText,
} from "../src/desktop-chat.js";

const DEVICE = "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c";

describe("Phase 19.7 — the application allowlist", () => {
  it("is the owner's five applications, as fixed ids", () => {
    expect([...DESKTOP_APP_IDS]).toEqual(["notepad", "calculator", "edge", "chrome", "explorer"]);
    for (const id of DESKTOP_APP_IDS) expect(id).toMatch(/^[a-z]+$/);
    expect(DESKTOP_APP_LABELS).toEqual({
      notepad: "Notepad",
      calculator: "Calculator",
      edge: "Microsoft Edge",
      chrome: "Google Chrome",
      explorer: "File Explorer",
    });
  });

  it("adds exactly one action, and nothing that runs anything else", () => {
    expect([...DESKTOP_COMMAND_ACTIONS]).toEqual(["desktop.input.click", "desktop.input.key", "desktop.input.type", "desktop.app.launch"]);
    const forbidden = /screen|capture|shell|powershell|exec|process|file|clipboard|registry|script|elevat/i;
    for (const action of DESKTOP_COMMAND_ACTIONS) expect(action).not.toMatch(forbidden);
  });

  it.each(DESKTOP_APP_IDS)("accepts %s", (app) => {
    expect(parseDesktopMessage(DesktopCommandRequestSchema, { action: "desktop.app.launch", app })).toEqual({ action: "desktop.app.launch", app });
  });

  it.each([
    ["an unknown application", "calc.exe"],
    ["a program that is not on the list", "regedit"],
    ["an absolute path", "C:\\Windows\\System32\\cmd.exe"],
    ["a relative path", "..\\..\\cmd.exe"],
    ["a forward-slash path", "/Windows/System32/notepad.exe"],
    ["a command line", "notepad.exe C:\\secret.txt"],
    ["a shell", "powershell"],
    ["a url", "https://example.com"],
    ["a different case", "Notepad"],
    ["a trailing space", "notepad "],
    ["nothing", ""],
    ["a prototype name", "__proto__"],
  ])("refuses %s", (_name, app) => {
    expect(parseDesktopMessage(DesktopCommandRequestSchema, { action: "desktop.app.launch", app })).toBeNull();
    expect(parseComputerControlRequest({ action: "desktop.app.launch", app }).ok).toBe(false);
  });

  it("refuses anything a launch might carry besides its id", () => {
    for (const extra of [{ args: "/c calc" }, { path: "C:\\x.exe" }, { command: "calc" }, { cwd: "C:\\" }, { env: {} }]) {
      expect(parseDesktopMessage(DesktopCommandRequestSchema, { action: "desktop.app.launch", app: "notepad", ...extra })).toBeNull();
      expect(parseComputerControlRequest({ action: "desktop.app.launch", app: "notepad", ...extra }).ok).toBe(false);
    }
  });

  it("is refused in a signed envelope when the id is unknown", () => {
    const envelope = {
      commandId: "11111111-1111-4111-8111-111111111111",
      deviceId: DEVICE,
      grantId: "33333333-3333-4333-8333-333333333333",
      action: "desktop.app.launch",
      issuedAt: 1,
      expiresAt: 2,
      requiresHello: false,
      signature: "A".repeat(86),
    };
    expect(parseDesktopMessage(DesktopCommandEnvelopeSchema, { ...envelope, params: { app: "notepad" } })).not.toBeNull();
    expect(parseDesktopMessage(DesktopCommandEnvelopeSchema, { ...envelope, params: { app: "cmd" } })).toBeNull();
    expect(parseDesktopMessage(DesktopCommandEnvelopeSchema, { ...envelope, params: { app: "notepad", args: "x" } })).toBeNull();
  });
});

describe("Phase 19.7 — the protocol", () => {
  it("names a new agent release and a new consent", () => {
    expect(DESKTOP_AGENT_CURRENT_VERSION).toBe("1.1.0");
    expect(DESKTOP_CONSENT_TEXT_VERSION).toBe("desktop-consent/2");
    expect(DESKTOP_COMMAND_FORMAT_VERSION).toBe("jarvis-desktop-command/2");
  });

  it("signs a new command format, so a v1 agent can never verify a launch", () => {
    const params = desktopCommandParams({ action: "desktop.app.launch", app: "notepad" });
    expect(desktopParamsCanonical(params)).toBe("app=notepad");
    const canonical = desktopCommandCanonical({
      commandId: "c",
      deviceId: "d",
      grantId: "g",
      params,
      issuedAt: 1,
      expiresAt: 2,
      requiresHello: false,
    });
    expect(canonical).toBe("jarvis-desktop-command/2\nc\nd\ng\ndesktop.app.launch\napp=notepad\n1\n2\n0");
  });

  it("needs Windows Hello for typing and not for opening an application", () => {
    expect(desktopActionRequiresHello("desktop.app.launch")).toBe(false);
    expect(desktopActionRequiresHello("desktop.input.type")).toBe(true);
  });

  it("binds an approval to the device and the application", () => {
    expect(desktopApprovalParams(desktopCommandParams({ action: "desktop.app.launch", app: "chrome" }), DEVICE)).toEqual({ deviceId: DEVICE, app: "chrome" });
  });

  it("reports a launch that did not happen as not executed", () => {
    expect(DESKTOP_NOT_EXECUTED_CODES).toContain("APP_NOT_INSTALLED");
    expect(DESKTOP_NOT_EXECUTED_CODES).toContain("LAUNCH_FAILED");
  });

  it("lets an older agent's consent reach the check that names the mismatch", () => {
    const request = {
      version: "jarvis-desktop/1",
      agentInstanceId: "0b8f3a52-7d1e-4c55-9f0a-2c6b1e9d4a77",
      grantId: "33333333-3333-4333-8333-333333333333",
      durationMinutes: 15,
      scope: ["desktop.input.click"],
      consentTextSha256: "a".repeat(64),
      replacesGrantId: null,
    };
    expect(parseDesktopMessage(DesktopGrantRequestSchema, { ...request, consentTextVersion: "desktop-consent/1" })).not.toBeNull();
    expect(parseDesktopMessage(DesktopGrantRequestSchema, { ...request, consentTextVersion: "anything" })).toBeNull();
  });
});

describe("Phase 19.7 — the consent wording", () => {
  const all = renderDesktopConsentText({ userLabel: "Ada", organizationLabel: "Org", durationMinutes: 15, scope: [...DESKTOP_COMMAND_ACTIONS] });
  const none = renderDesktopConsentText({ userLabel: "Ada", organizationLabel: "Org", durationMinutes: 15, scope: ["desktop.input.click"] });

  it("discloses each thing the owner listed", () => {
    expect(all).toContain("- open approved applications: Notepad, Calculator, Microsoft Edge, Google Chrome, File Explorer");
    expect(all).toContain("- type approved text, only after you verify each time with Windows Hello");
    expect(all).toContain("You approve every action in JARVIS before it runs, and every typing action also needs Windows Hello.");
    expect(all).toContain("JARVIS cannot see your screen.");
    expect(all).toContain("It cannot run any other program, shell command or script");
  });

  it("states the limits even when only clicking was chosen", () => {
    expect(none).not.toContain("open approved applications");
    expect(none).not.toContain("type approved text");
    expect(none).toContain("You approve every action in JARVIS before it runs, and every typing action also needs Windows Hello.");
    expect(none).toContain("JARVIS cannot see your screen.");
    expect(none).toContain("It cannot run any other program, shell command or script");
  });

  it("no longer says JARVIS cannot run programs: with a launch action that would be false", () => {
    expect(all).not.toContain("run programs or scripts");
  });

  it("keeps a canonical order for a scope with a launch in it", () => {
    expect(canonicalDesktopScope(["desktop.app.launch", "desktop.input.click"])).toEqual(["desktop.input.click", "desktop.app.launch"]);
  });
});

describe("Phase 19.7 — typing", () => {
  it.each([
    ["a newline", "line\nbreak"],
    ["a carriage return", "line\rbreak"],
    ["a tab", "a\tb"],
    ["an escape", "a\u001bb"],
    ["delete", "a\u007fb"],
    ["a line separator", "a\u2028b"],
    ["a right-to-left override", "a\u202eb"],
    ["a zero-width space", "a\u200bb"],
    ["a byte order mark", "a\ufeffb"],
    ["a lone surrogate", "a\ud83db"],
  ])("refuses %s, which the person reviewing could not see", (_name, text) => {
    expect(isTypeableText(text)).toBe(false);
    expect(parseDesktopMessage(DesktopCommandRequestSchema, { action: "desktop.input.type", text })).toBeNull();
  });

  it("leaves Windows Hello most of a command's life after the moment to choose the window", () => {
    expect(DESKTOP_TYPE_FOCUS_WAIT_MS).toBeGreaterThan(0);
    expect(DESKTOP_COMMAND_TTL_MS - DESKTOP_TYPE_FOCUS_WAIT_MS).toBeGreaterThanOrEqual(20_000);
  });

  it("accepts what a person would write", () => {
    expect(isTypeableText("Hello Sirish, JARVIS is online.")).toBe(true);
    expect(isTypeableText("Grüße, 世界 👋 \"quoted\" \\ back")).toBe(true);
  });

  it.each([
    ["a labelled password", "password: hunter2"],
    ["a password in a sentence", "my password is hunter2"],
    ["a passcode", "the passcode is 4417"],
    ["a one-time code", "OTP: 123456"],
    ["a PIN", "my pin is 4417"],
    ["an API key", "sk-abc123def456ghi789jkl012mno345pq"],
    ["a GitHub token", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"],
    ["an AWS key", "AKIAIOSFODNN7EXAMPLE"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123def456"],
    ["a bearer token", "Bearer abcdefghijklmnopqrstuvwxyz012345"],
    ["a private key", "-----BEGIN PRIVATE KEY-----"],
    ["a card number", "4111 1111 1111 1111"],
    ["credentials", "the credentials are admin/admin"],
  ])("recognises %s as something never to type", (_name, text) => {
    expect(isSensitiveDesktopText(text)).toBe(true);
  });

  it.each(["Hello Sirish, JARVIS is online.", "Remember to reset your password tomorrow", "Pin the note to the board", "Meeting at 4111", "1234 5678"])("does not mistake %j for a secret", (text) => {
    expect(isSensitiveDesktopText(text)).toBe(false);
  });
});

describe("Phase 19.7 — the record stays value-free", () => {
  it("seals a launch's approval like every other desktop action", () => {
    expect(sealsApprovalParams("desktop.app.launch")).toBe(true);
  });

  it("needs an approval, and speech may not start one", () => {
    expect(computerControlActionPolicy("desktop.app.launch")).toMatchObject({ access: "write", requiresApproval: true, voice: "refused", surface: "desktop" });
    expect(COMPUTER_CONTROL_VOICE_REFUSED_TOOLS["desktop.app.launch"]).toBeDefined();
  });

  it("describes a launch by the application's name, and says nothing is typed", () => {
    const parsed = parseComputerControlRequest({ action: "desktop.app.launch", app: "edge", deviceId: DEVICE });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const summary = computerControlApprovalSummary(parsed.value);
    expect(summary.actionSummary).toBe("Open Microsoft Edge on the paired Windows desktop.");
    expect(summary.detailLines).toContainEqual({ label: "Application", value: "Microsoft Edge" });
    expect(summary.detailLines).toContainEqual({ label: "Typing", value: "None. Typing is a separate request." });
  });

  it("keeps typed text out of the approval record and the audit projection", () => {
    const params = { deviceId: DEVICE, text: "Hello Sirish, JARVIS is online." };
    expect(JSON.stringify(computerControlApprovalRecord("desktop.input.type", params))).not.toContain("Sirish");
    expect(JSON.stringify(computerControlValueFreeParams("desktop.input.type", params))).not.toContain("Sirish");
  });
});

describe("Phase 19.7 — only the owner's own words authorize a desktop action", () => {
  const launch = (app: string, message: string) => desktopOwnerAuthorization("desktop.app.launch", { app }, message);
  const type = (text: string, message: string) => desktopOwnerAuthorization("desktop.input.type", { text }, message);

  it("holds exactly the two chat tools", () => {
    expect([...DESKTOP_CHAT_TOOL_IDS]).toEqual(["desktop.app.launch", "desktop.input.type"]);
    expect(isDesktopChatTool("desktop.input.click")).toBe(false);
    expect(isDesktopChatTool("desktop.input.key")).toBe(false);
    expect(isDesktopChatTool("desktop.app.launch")).toBe(true);
  });

  it.each([
    ["notepad", "Open Notepad."],
    ["notepad", "Open Notepad on my Windows computer."],
    ["notepad", "Open Notepad and type Hello Sirish, JARVIS is online."],
    ["calculator", "Launch Calculator"],
    ["calculator", "start calc"],
    ["calculator", "open up the calculator app"],
    ["explorer", "please open file explorer"],
    ["chrome", "Can you open Chrome?"],
    ["chrome", "start google chrome"],
    ["edge", "open microsoft edge"],
    ["edge", "Open Edge"],
  ])("lets the owner ask for %s with %j", (app, message) => {
    expect(launch(app, message)).toEqual({ ok: true });
  });

  it.each([
    ["the owner named another application", "chrome", "Open Notepad."],
    ["the owner named no application", "notepad", "Summarize this page for me."],
    ["the owner only mentioned it", "notepad", "What is Notepad?"],
    ["the owner said not to", "notepad", "Do not open Notepad."],
    ["the owner said not to, briefly", "notepad", "don't open notepad"],
    ["the message is empty", "notepad", ""],
    ["a page told the model to", "chrome", "Summarize https://example.com for me"],
  ])("refuses when %s", (_name, app, message) => {
    expect(launch(app, message)).toEqual({ ok: false, code: "NOT_ASKED" });
  });

  it.each([
    ["Hello Sirish, JARVIS is online.", "Type Hello Sirish, JARVIS is online."],
    ["Hello Sirish, JARVIS is online.", "type: Hello Sirish, JARVIS is online."],
    ["Hello", 'Please type "Hello" into Notepad'],
    ["Hello there", "Now type this exactly: Hello there"],
    ["Hello", "In Notepad, type Hello"],
    ["open notepad please", "type open notepad please"],
  ])("lets the owner ask to type %j with %j", (text, message) => {
    expect(type(text, message)).toEqual({ ok: true });
  });

  it.each([
    ["words the owner never wrote", "rm -rf /", "Type Hello"],
    ["a change of case", "HELLO", "Type Hello"],
    ["more than the owner wrote", "Hello and also this", "Type Hello"],
    ["text with no request to type it", "Hello", "Hello there"],
    ["text from before the verb", "Hello", "Hello. Now type World"],
    ["no message", "Hello", ""],
  ])("refuses %s", (_name, text, message) => {
    expect(type(text, message)).toEqual({ ok: false, code: "NOT_ASKED" });
  });

  it("never lets one sentence both open an application and type: typing is its own request", () => {
    expect(type("Hello Sirish, JARVIS is online.", "Open Notepad and type Hello Sirish, JARVIS is online.")).toEqual({ ok: false, code: "TYPE_NEEDS_OWN_REQUEST" });
  });

  it("refuses a parameter it cannot read", () => {
    expect(desktopOwnerAuthorization("desktop.app.launch", { app: 7 }, "Open Notepad.")).toEqual({ ok: false, code: "NOT_ASKED" });
    expect(desktopOwnerAuthorization("desktop.input.type", {}, "Type Hello")).toEqual({ ok: false, code: "NOT_ASKED" });
  });

  it("has a fixed sentence for every refusal, and none of them repeats what was asked", () => {
    for (const message of Object.values(DESKTOP_CHAT_REFUSALS)) {
      expect(message.length).toBeGreaterThan(20);
      expect(message).not.toMatch(/\$\{/);
    }
  });
});

describe("Phase 19.7 — what chat is told happened", () => {
  it("waits no longer than the deadline it runs under", () => {
    expect(DESKTOP_RESULT_WAIT_MS).toBeLessThan(DESKTOP_CHAT_EXECUTION_TIMEOUT_MS);
  });

  it("says a process started, and not that a window appeared", () => {
    const report = desktopChatReport({ action: "desktop.app.launch", app: "notepad", status: "succeeded", resultCode: null });
    expect(report.outcome).toBe("succeeded");
    expect(report.message).toContain("Windows started Notepad.");
    expect(report.message).toContain("cannot see the screen");
    expect(report.message).toContain("Nothing was typed");
  });

  it("says typing happened in the focused window, as far as the computer knows", () => {
    const report = desktopChatReport({ action: "desktop.input.type", status: "succeeded", resultCode: null });
    expect(report.outcome).toBe("succeeded");
    expect(report.message).toContain("focus");
  });

  it.each([
    ["HELLO_FAILED", /Windows Hello/],
    ["HELLO_UNAVAILABLE", /Windows Hello/],
    ["APP_NOT_INSTALLED", /not installed/],
    ["LAUNCH_FAILED", /could not start/],
    ["SESSION_LOCKED", /locked/],
    ["GRANT_INACTIVE", /no longer allowed/],
    ["COMMAND_EXPIRED", /too long/],
    ["NO_TARGET", /window/],
    ["ELEVATED_TARGET", /administrator/],
    ["BUSY", /busy/],
    ["INVALID_COMMAND", /refused/],
  ])("explains %s without claiming success", (code, words) => {
    const report = desktopChatReport({ action: "desktop.input.type", status: "not_executed", resultCode: code });
    expect(report.outcome).toBe("not-executed");
    expect(report.message).toMatch(words);
    expect(report.message).toMatch(/nothing was (done|typed|opened)/);
    expect(report.message).not.toMatch(/\b(success|succeeded|started|completed)\b/i);
  });

  it("says an uncertain outcome is unknown and was not retried", () => {
    const report = desktopChatReport({ action: "desktop.app.launch", app: "notepad", status: "unknown", resultCode: "INTERRUPTED" });
    expect(report.outcome).toBe("unknown");
    expect(report.message).toContain("not retried");
    expect(report.message).toMatch(/check/i);
  });

  it("says a command that never reached the computer did nothing", () => {
    expect(desktopChatReport({ action: "desktop.app.launch", app: "notepad", status: "expired", resultCode: null }).outcome).toBe("not-executed");
  });

  it("never reports success while the computer has not answered", () => {
    for (const status of ["issued", "delivered"] as const) {
      const report = desktopChatReport({ action: "desktop.app.launch", app: "notepad", status, resultCode: null });
      expect(report.outcome).toBe("no-answer");
      expect(report.message).toContain("will not be sent again");
    }
  });
});
