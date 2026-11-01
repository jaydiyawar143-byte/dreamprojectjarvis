// ---------------------------------------------------------------------------
// Phase 19, Stage 19.6 — the desktop agent protocol (M1).
//
// What both ends must agree on, pinned: the owner-approved timings, pairing
// codes, keys and fingerprints, the three signed strings, the consent wording
// and every message's strict shape. And the shared contract the .NET agent is
// tested against — `apps/desktop-agent/contract/` — which this file
// regenerates and compares: JSON Schema of every message, the allowlists and
// limits, and test vectors made with TEST-ONLY keys. And that the check for the
// "no inbound port" exit criterion looks at the agent that is running.
//
// To regenerate the contract after a deliberate protocol change:
//   UPDATE_DESKTOP_CONTRACT=1 pnpm --filter @jarvis/core exec vitest run computer-control-desktop
// CI never regenerates it: a contract that drifted from this code fails here.
//
// Named `computer-control*`, the slice CI runs for this package.
// ---------------------------------------------------------------------------

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  DESKTOP_AGENT_CURRENT_VERSION,
  DESKTOP_CLOCK_SKEW_MS,
  DESKTOP_COMMAND_ACTIONS,
  DESKTOP_COMMAND_FORMAT_VERSION,
  DESKTOP_COMMAND_TTL_MS,
  DESKTOP_CONSENT_TEXT_VERSION,
  DESKTOP_ERROR_CODES,
  DESKTOP_GRANT_DEFAULT_MINUTES,
  DESKTOP_GRANT_MAX_MINUTES,
  DESKTOP_KILL_SWITCH,
  DESKTOP_MOUSE_BUTTONS,
  DESKTOP_NOT_EXECUTED_CODES,
  DESKTOP_PAIRING_CODE_TTL_MS,
  DESKTOP_POLL_HOLD_MS,
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_RECONNECT_GRACE_MS,
  DESKTOP_SESSION_END_REASONS,
  DESKTOP_TYPE_FOCUS_WAIT_MS,
  DESKTOP_TYPE_TEXT_MAX_LENGTH,
  DESKTOP_WINDOWS_11_FIRST_BUILD,
  DesktopCommandEnvelopeSchema,
  DesktopCommandRequestSchema,
  DesktopCommandResultSchema,
  DesktopGrantRequestSchema,
  DesktopPairRequestSchema,
  DesktopPollRequestSchema,
  canonicalDesktopScope,
  compareDesktopAgentVersions,
  desktopActionRequiresHello,
  desktopAgentJsonSchemas,
  desktopCommandCanonical,
  desktopCommandParams,
  desktopConsentTextSha256,
  desktopFingerprintDisplay,
  desktopKeyFingerprint,
  desktopParamsCanonical,
  desktopRequestCanonical,
  desktopRequestPartsAreWellFormed,
  desktopResponseCanonical,
  desktopServerKeyId,
  generateDesktopPairingCode,
  hashDesktopPairingCode,
  isDesktopTimestampFresh,
  isP256PublicKey,
  isTypeableText,
  normalizeDesktopPairingCode,
  parseDesktopMessage,
  renderDesktopConsentText,
  sanitizeDesktopLabel,
  sha256Hex,
  signDesktopCanonical,
  verifyDesktopCanonical,
  type DesktopCommandParams,
  type DesktopCommandParts,
  type DesktopGrantScope,
} from "../src/desktop-agent.js";
import { DESKTOP_APP_IDS, DESKTOP_CONTROL_ACTION_IDS, DESKTOP_KEY_NAMES, DESKTOP_COORDINATE_MAX } from "../src/computer-control.js";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = resolve(here, "../../../apps/desktop-agent/contract");
const UPDATE = process.env.UPDATE_DESKTOP_CONTRACT === "1";

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}
const pkcs8Key = (pkcs8: string) => ({ key: Buffer.from(pkcs8, "base64"), format: "der" as const, type: "pkcs8" as const });

describe("Phase 19.6 — the owner-approved values", () => {
  it("are the ones decided (U5, D6), and the command set is the owner's (D1, D4; 19.7 added the launch)", () => {
    expect(DESKTOP_PROTOCOL_VERSION).toBe("jarvis-desktop/1");
    expect(DESKTOP_PAIRING_CODE_TTL_MS).toBe(10 * 60_000);
    expect(DESKTOP_COMMAND_TTL_MS).toBe(30_000);
    expect(DESKTOP_CLOCK_SKEW_MS).toBe(60_000);
    expect(DESKTOP_GRANT_DEFAULT_MINUTES).toBe(15);
    expect(DESKTOP_GRANT_MAX_MINUTES).toBe(60);
    expect(DESKTOP_RECONNECT_GRACE_MS).toBe(30_000);
    expect(DESKTOP_POLL_HOLD_MS).toBeLessThan(DESKTOP_RECONNECT_GRACE_MS);
    expect([...DESKTOP_COMMAND_ACTIONS]).toEqual(["desktop.input.click", "desktop.input.key", "desktop.input.type", "desktop.app.launch"]);
  });

  it("has no screen reading and no command outside the vocabulary — nothing that executes, or reads", () => {
    for (const action of DESKTOP_COMMAND_ACTIONS) expect(DESKTOP_CONTROL_ACTION_IDS).toContain(action);
    expect(DESKTOP_COMMAND_ACTIONS).not.toContain("desktop.screen.read");
    // "launch" left this list by the owner's decision (Stage 19.7). The one
    // action it allows takes a fixed id, pinned in computer-control-desktop-apps-p197.
    const forbidden = /screen|capture|shell|powershell|exec|process|file|clipboard|registry|script|elevat/i;
    for (const action of DESKTOP_COMMAND_ACTIONS) expect(action).not.toMatch(forbidden);
  });

  it("asks Windows Hello for typing, and only typing", () => {
    expect(DESKTOP_COMMAND_ACTIONS.filter(desktopActionRequiresHello)).toEqual(["desktop.input.type"]);
  });
});

describe("Phase 19.6 — pairing codes", () => {
  it("are 160 random bits as eight groups of four, and never repeat", () => {
    const codes = new Set(Array.from({ length: 200 }, generateDesktopPairingCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("forgive case, spaces and hyphens, and read I, L and O as digits", () => {
    const code = generateDesktopPairingCode();
    const normalized = normalizeDesktopPairingCode(code)!;
    expect(normalized).toHaveLength(32);
    expect(normalizeDesktopPairingCode(` ${code.toLowerCase().replace(/-/g, " ")} `)).toBe(normalized);
    expect(normalizeDesktopPairingCode("IL0O".padEnd(32, "A"))).toBe("1100".padEnd(32, "A"));
  });

  it.each(["", "short", "U".repeat(32), "A".repeat(31), "A".repeat(33), 42, null, "A".repeat(65)])("refuses %j", (input) => {
    expect(normalizeDesktopPairingCode(input)).toBeNull();
  });

  it("are stored as a domain-separated SHA-256, never as themselves", () => {
    const normalized = normalizeDesktopPairingCode(generateDesktopPairingCode())!;
    const hash = hashDesktopPairingCode(normalized);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(sha256Hex(normalized));
    expect(hash).not.toContain(normalized.toLowerCase());
  });
});

describe("Phase 19.6 — keys, fingerprints and signatures", () => {
  it("accepts an ECDSA P-256 public key and nothing else", () => {
    const ec = p256();
    expect(isP256PublicKey(ec.spki)).toBe(true);
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    for (const other of [p384, rsa, ec.pkcs8, "not base64!", "", "AAAA", 7]) expect(isP256PublicKey(other)).toBe(false);
  });

  it("fingerprints the key, and shows its first 96 bits in six groups", () => {
    const { spki } = p256();
    const fingerprint = desktopKeyFingerprint(spki);
    expect(fingerprint).toBe(sha256Hex(Buffer.from(spki, "base64")));
    expect(desktopFingerprintDisplay(fingerprint)).toBe(fingerprint.slice(0, 24).toUpperCase().match(/.{4}/g)!.join("-"));
    expect(desktopServerKeyId(spki)).toBe(fingerprint.slice(0, 16));
  });

  it("verifies its own signatures, and refuses another key, another string, another encoding", () => {
    const key = p256();
    const signature = signDesktopCanonical(pkcs8Key(key.pkcs8), "hello");
    expect(signature).toHaveLength(86);
    expect(verifyDesktopCanonical(key.spki, "hello", signature)).toBe(true);
    expect(verifyDesktopCanonical(key.spki, "hello!", signature)).toBe(false);
    expect(verifyDesktopCanonical(p256().spki, "hello", signature)).toBe(false);
    const flipped = Buffer.from(signature, "base64url");
    flipped[10]! ^= 1;
    expect(verifyDesktopCanonical(key.spki, "hello", flipped.toString("base64url"))).toBe(false);
    for (const bad of [undefined, "", "x".repeat(86), signature + "A", signature.slice(1)]) {
      expect(verifyDesktopCanonical(key.spki, "hello", bad)).toBe(false);
    }
  });
});

describe("Phase 19.6 — the signed strings", () => {
  const requestParts = {
    method: "POST",
    path: "/api/v1/desktop-agent/poll",
    timestamp: "1767225600000",
    nonce: "AbCdEfGhIjKlMnOpQrStUv",
    device: "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c",
    bodySha256: "a".repeat(64),
  };

  it("an agent request is seven fixed lines", () => {
    expect(desktopRequestCanonical(requestParts)).toBe(
      ["jarvis-desktop-request/1", "POST", "/api/v1/desktop-agent/poll", "1767225600000", "AbCdEfGhIjKlMnOpQrStUv", requestParts.device, "a".repeat(64)].join("\n")
    );
    expect(desktopRequestPartsAreWellFormed(requestParts)).toBe(true);
  });

  it.each([
    ["another method", { method: "GET" }],
    ["a path outside the agent routes", { path: "/api/v1/desktop/devices" }],
    ["a query", { path: "/api/v1/desktop-agent/poll?x=1" }],
    ["a short nonce", { nonce: "short" }],
    ["a device that is not a uuid", { device: "../../etc" }],
    ["a body hash that is not one", { bodySha256: "zz" }],
    ["a timestamp that is not a number", { timestamp: "now" }],
  ])("refuses %s before any key is looked at", (_label, override) => {
    expect(desktopRequestPartsAreWellFormed({ ...requestParts, ...override })).toBe(false);
  });

  it("holds a timestamp to the 60-second skew", () => {
    const now = 1_767_225_600_000;
    expect(isDesktopTimestampFresh(String(now - 60_000), now)).toBe(true);
    expect(isDesktopTimestampFresh(String(now + 60_000), now)).toBe(true);
    expect(isDesktopTimestampFresh(String(now - 60_001), now)).toBe(false);
    expect(isDesktopTimestampFresh(String(now + 60_001), now)).toBe(false);
  });

  it("a command names every field it is bound to, with typed text as base64url of its UTF-8", () => {
    const parts: DesktopCommandParts = {
      commandId: "11111111-1111-4111-8111-111111111111",
      deviceId: "22222222-2222-4222-8222-222222222222",
      grantId: "33333333-3333-4333-8333-333333333333",
      params: { action: "desktop.input.type", text: "Grüße 👋" },
      issuedAt: 1000,
      expiresAt: 31000,
      requiresHello: true,
    };
    expect(desktopCommandCanonical(parts)).toBe(
      [
        "jarvis-desktop-command/2",
        parts.commandId,
        parts.deviceId,
        parts.grantId,
        "desktop.input.type",
        `text=${Buffer.from("Grüße 👋", "utf8").toString("base64url")}`,
        "1000",
        "31000",
        "1",
      ].join("\n")
    );
    expect(desktopParamsCanonical({ action: "desktop.input.click", x: 10, y: 20, button: "right" })).toBe("x=10&y=20&button=right");
    expect(desktopParamsCanonical({ action: "desktop.input.key", key: "enter" })).toBe("key=enter");
  });

  it("a response is bound to the request it answers", () => {
    expect(desktopResponseCanonical({ requestNonce: "n".repeat(22), status: 403, bodySha256: "b".repeat(64) })).toBe(
      ["jarvis-desktop-response/1", "n".repeat(22), "403", "b".repeat(64)].join("\n")
    );
  });
});

describe("Phase 19.6 — what may be typed", () => {
  it.each([
    ["ordinary text", "hello world", true],
    ["accents and emoji", "Grüße 👋", true],
    ["empty", "", false],
    ["a newline, which would press Enter", "a\nb", false],
    ["a tab, which would press Tab", "a\tb", false],
    ["a NUL", "a\u0000b", false],
    ["a C1 control", "a\u0085b", false],
    ["a line separator", "a\u2028b", false],
    ["a lone surrogate", "a\ud800b", false],
    ["too long", "x".repeat(DESKTOP_TYPE_TEXT_MAX_LENGTH + 1), false],
  ])("%s", (_label, text, ok) => {
    expect(isTypeableText(text)).toBe(ok);
    expect(DesktopCommandRequestSchema.safeParse({ action: "desktop.input.type", text }).success).toBe(ok);
  });
});

describe("Phase 19.6 — consent wording (U5c)", () => {
  const input = { userLabel: "Ada Lovelace", organizationLabel: "Analytical Engines", durationMinutes: 15, scope: ["desktop.input.click"] as DesktopGrantScope[] };

  it("is deterministic, versioned, and names who, which Organization, how long, what, what never, and how to stop", () => {
    const text = renderDesktopConsentText(input);
    expect(renderDesktopConsentText(input)).toBe(text);
    expect(DESKTOP_CONSENT_TEXT_VERSION).toBe("desktop-consent/2");
    for (const part of ["Ada Lovelace", "Analytical Engines", "15 minutes", "click at positions", "cannot see your screen", "any other program, shell command or script", DESKTOP_KILL_SWITCH, "lock this computer"]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("type approved text");
    expect(text).not.toMatch(/\r|\n$/);
    expect(desktopConsentTextSha256(text)).toBe(sha256Hex(Buffer.from(text, "utf8")));
  });

  it("changes its hash with anything it shows", () => {
    const base = desktopConsentTextSha256(renderDesktopConsentText(input));
    for (const changed of [
      { ...input, durationMinutes: 16 },
      { ...input, userLabel: "Ada" },
      { ...input, organizationLabel: "Engines" },
      { ...input, scope: ["desktop.input.click", "desktop.input.type"] as DesktopGrantScope[] },
    ]) {
      expect(desktopConsentTextSha256(renderDesktopConsentText(changed))).not.toBe(base);
    }
  });

  it("says Windows Hello when typing is in scope, and puts the scope in one order", () => {
    const text = renderDesktopConsentText({ ...input, scope: ["desktop.input.type", "desktop.input.click"] });
    expect(text).toContain("Windows Hello");
    expect(text.indexOf("click at")).toBeLessThan(text.indexOf("type approved text"));
    expect(canonicalDesktopScope(["desktop.input.type", "desktop.input.click"])).toEqual(["desktop.input.click", "desktop.input.type"]);
    for (const bad of [[], ["desktop.input.click", "desktop.input.click"], ["desktop.screen.read"], ["shell"]]) {
      expect(canonicalDesktopScope(bad)).toBeNull();
    }
  });

  it("shows labels printable, on one line and bounded", () => {
    expect(sanitizeDesktopLabel("Ada\nLovelace\u0000\u2028x")).toBe("Ada Lovelace x");
    expect(sanitizeDesktopLabel("   ")).toBe("Unknown");
    expect(sanitizeDesktopLabel(undefined)).toBe("Unknown");
    expect(Array.from(sanitizeDesktopLabel("é".repeat(200)))).toHaveLength(80);
  });
});

describe("Phase 19.6 — every message is exactly one shape", () => {
  const uuid = () => randomUUID();

  it("refuses an unknown field, another version and an unknown action", () => {
    const poll = { version: DESKTOP_PROTOCOL_VERSION, agentInstanceId: uuid(), agentVersion: "1.0.0", windowsBuild: 26100, grantId: null };
    expect(parseDesktopMessage(DesktopPollRequestSchema, poll)).not.toBeNull();
    expect(parseDesktopMessage(DesktopPollRequestSchema, { ...poll, extra: 1 })).toBeNull();
    expect(parseDesktopMessage(DesktopPollRequestSchema, { ...poll, version: "jarvis-desktop/2" })).toBeNull();
    expect(parseDesktopMessage(DesktopPollRequestSchema, { ...poll, agentVersion: "1.0" })).toBeNull();

    const envelope = {
      commandId: uuid(),
      deviceId: uuid(),
      grantId: uuid(),
      issuedAt: 1,
      expiresAt: 2,
      requiresHello: false,
      signature: "A".repeat(86),
      action: "desktop.input.key",
      params: { key: "enter" },
    };
    expect(parseDesktopMessage(DesktopCommandEnvelopeSchema, envelope)).not.toBeNull();
    for (const action of ["desktop.screen.read", "desktop.shell", "powershell", "desktop.session.end"]) {
      expect(parseDesktopMessage(DesktopCommandEnvelopeSchema, { ...envelope, action })).toBeNull();
    }
    expect(parseDesktopMessage(DesktopCommandEnvelopeSchema, { ...envelope, params: { key: "f4" } })).toBeNull();
    expect(parseDesktopMessage(DesktopCommandEnvelopeSchema, { ...envelope, params: { key: "enter", extra: 1 } })).toBeNull();
  });

  it("bounds a grant to 1–60 minutes and a known scope", () => {
    const grant = {
      version: DESKTOP_PROTOCOL_VERSION,
      agentInstanceId: uuid(),
      grantId: uuid(),
      durationMinutes: 15,
      scope: ["desktop.input.click"],
      consentTextVersion: DESKTOP_CONSENT_TEXT_VERSION,
      consentTextSha256: "c".repeat(64),
      replacesGrantId: null,
    };
    expect(parseDesktopMessage(DesktopGrantRequestSchema, grant)).not.toBeNull();
    for (const durationMinutes of [0, 61, 15.5]) expect(parseDesktopMessage(DesktopGrantRequestSchema, { ...grant, durationMinutes })).toBeNull();
    expect(parseDesktopMessage(DesktopGrantRequestSchema, { ...grant, scope: ["desktop.screen.read"] })).toBeNull();
    // Any well-formed version reaches the service, which says CONSENT_MISMATCH (Stage 19.7).
    expect(parseDesktopMessage(DesktopGrantRequestSchema, { ...grant, consentTextVersion: "not-a-version" })).toBeNull();
  });

  it("keeps a click inside the coordinate bound and a key inside the fixed set", () => {
    expect(DesktopCommandRequestSchema.safeParse({ action: "desktop.input.click", x: DESKTOP_COORDINATE_MAX + 1, y: 0 }).success).toBe(false);
    expect(DesktopCommandRequestSchema.safeParse({ action: "desktop.input.click", x: -1, y: 0 }).success).toBe(false);
    expect(DesktopCommandRequestSchema.safeParse({ action: "desktop.input.key", key: "f4" }).success).toBe(false);
    const click = DesktopCommandRequestSchema.parse({ action: "desktop.input.click", x: 5, y: 6 });
    expect(desktopCommandParams(click)).toEqual({ action: "desktop.input.click", x: 5, y: 6, button: "left" });
  });

  it("admits only the three outcomes, and a not-executed one only with its reason", () => {
    expect(parseDesktopMessage(DesktopCommandResultSchema, { version: DESKTOP_PROTOCOL_VERSION, outcome: "succeeded" })).not.toBeNull();
    expect(parseDesktopMessage(DesktopCommandResultSchema, { version: DESKTOP_PROTOCOL_VERSION, outcome: "not-executed", code: "HELLO_FAILED" })).not.toBeNull();
    expect(parseDesktopMessage(DesktopCommandResultSchema, { version: DESKTOP_PROTOCOL_VERSION, outcome: "not-executed" })).toBeNull();
    expect(parseDesktopMessage(DesktopCommandResultSchema, { version: DESKTOP_PROTOCOL_VERSION, outcome: "failed" })).toBeNull();
  });

  it("refuses a pairing from anything but the declared shape", () => {
    const pair = {
      version: DESKTOP_PROTOCOL_VERSION,
      pairingCode: generateDesktopPairingCode(),
      publicKey: p256().spki,
      deviceName: "WORKSTATION",
      agentVersion: DESKTOP_AGENT_CURRENT_VERSION,
      windowsBuild: 26100,
      architecture: "x64",
    };
    expect(parseDesktopMessage(DesktopPairRequestSchema, pair)).not.toBeNull();
    expect(parseDesktopMessage(DesktopPairRequestSchema, { ...pair, privateKey: "x" })).toBeNull();
    expect(parseDesktopMessage(DesktopPairRequestSchema, { ...pair, architecture: "mips" })).toBeNull();
  });

  it("compares agent versions numerically, and refuses anything else", () => {
    expect(compareDesktopAgentVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareDesktopAgentVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareDesktopAgentVersions("0.9.0", "1.0.0")).toBe(-1);
    expect(compareDesktopAgentVersions("1.0", "1.0.0")).toBeNull();
    expect(compareDesktopAgentVersions("01.0.0", "1.0.0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The shared contract the .NET agent is tested against
// ---------------------------------------------------------------------------

function constants() {
  return {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    agentVersion: DESKTOP_AGENT_CURRENT_VERSION,
    commandFormatVersion: DESKTOP_COMMAND_FORMAT_VERSION,
    commandActions: [...DESKTOP_COMMAND_ACTIONS],
    appIds: [...DESKTOP_APP_IDS],
    helloActions: DESKTOP_COMMAND_ACTIONS.filter(desktopActionRequiresHello),
    keyNames: [...DESKTOP_KEY_NAMES],
    mouseButtons: [...DESKTOP_MOUSE_BUTTONS],
    errorCodes: [...DESKTOP_ERROR_CODES],
    notExecutedCodes: [...DESKTOP_NOT_EXECUTED_CODES],
    sessionEndReasons: [...DESKTOP_SESSION_END_REASONS],
    consentTextVersion: DESKTOP_CONSENT_TEXT_VERSION,
    killSwitch: DESKTOP_KILL_SWITCH,
    limits: {
      pairingCodeTtlMs: DESKTOP_PAIRING_CODE_TTL_MS,
      commandTtlMs: DESKTOP_COMMAND_TTL_MS,
      clockSkewMs: DESKTOP_CLOCK_SKEW_MS,
      grantDefaultMinutes: DESKTOP_GRANT_DEFAULT_MINUTES,
      grantMaxMinutes: DESKTOP_GRANT_MAX_MINUTES,
      reconnectGraceMs: DESKTOP_RECONNECT_GRACE_MS,
      pollHoldMs: DESKTOP_POLL_HOLD_MS,
      coordinateMax: DESKTOP_COORDINATE_MAX,
      typeTextMaxLength: DESKTOP_TYPE_TEXT_MAX_LENGTH,
      typeFocusWaitMs: DESKTOP_TYPE_FOCUS_WAIT_MS,
      windows11FirstBuild: DESKTOP_WINDOWS_11_FIRST_BUILD,
    },
  };
}

interface Vectors {
  note: string;
  deviceKey: { pkcs8: string; spki: string; fingerprint: string; display: string };
  serverKey: { pkcs8: string; spki: string; keyId: string };
  requests: Array<{ parts: Parameters<typeof desktopRequestCanonical>[0]; canonical: string; signature: string }>;
  commands: Array<{ parts: DesktopCommandParts; paramsCanonical: string; canonical: string; signature: string }>;
  responses: Array<{ requestNonce: string; status: number; body: string; bodySha256: string; canonical: string; signature: string }>;
  consent: Array<{ userLabel: string; organizationLabel: string; durationMinutes: number; scope: DesktopGrantScope[]; text: string; sha256: string }>;
  pairingCodes: Array<{ input: string; normalized: string; hash: string }>;
}

function freshVectors(): Vectors {
  const device = p256();
  const server = p256();
  const deviceFingerprint = desktopKeyFingerprint(device.spki);
  const deviceId = "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c";
  const requestBody = JSON.stringify({ version: DESKTOP_PROTOCOL_VERSION, agentInstanceId: "0b8f3a52-7d1e-4c55-9f0a-2c6b1e9d4a77", agentVersion: "1.0.0", windowsBuild: 26100, grantId: null });
  const requests = [
    { method: "POST", path: "/api/v1/desktop-agent/poll", timestamp: "1767225600000", nonce: "q1W2e3R4t5Y6u7I8o9P0aS", device: deviceId, bodySha256: sha256Hex(requestBody) },
    { method: "POST", path: "/api/v1/desktop-agent/pair", timestamp: "1767225600001", nonce: "Zx-Cv_Bn12Mq34Wr56Ty78", device: "pairing", bodySha256: sha256Hex("{}") },
  ].map((parts) => {
    const canonical = desktopRequestCanonical(parts);
    return { parts, canonical, signature: signDesktopCanonical(pkcs8Key(device.pkcs8), canonical) };
  });
  const paramsList: DesktopCommandParams[] = [
    { action: "desktop.input.click", x: 1920, y: 1080, button: "left" },
    { action: "desktop.input.key", key: "arrowdown" },
    { action: "desktop.input.type", text: "Grüße, 世界 👋 \"quoted\" \\ back" },
    { action: "desktop.app.launch", app: "notepad" },
  ];
  const commands = paramsList.map((params, i) => {
    const parts: DesktopCommandParts = {
      commandId: `1111111${i}-1111-4111-8111-111111111111`,
      deviceId,
      grantId: "33333333-3333-4333-8333-333333333333",
      params,
      issuedAt: 1_767_225_600_000,
      expiresAt: 1_767_225_630_000,
      requiresHello: params.action === "desktop.input.type",
    };
    const canonical = desktopCommandCanonical(parts);
    return { parts, paramsCanonical: desktopParamsCanonical(params), canonical, signature: signDesktopCanonical(pkcs8Key(server.pkcs8), canonical) };
  });
  const responseBody = JSON.stringify({ version: DESKTOP_PROTOCOL_VERSION, error: { code: "DEVICE_REVOKED" } });
  const responses = [{ requestNonce: "q1W2e3R4t5Y6u7I8o9P0aS", status: 403, body: responseBody, bodySha256: sha256Hex(responseBody) }].map((r) => {
    const canonical = desktopResponseCanonical(r);
    return { ...r, canonical, signature: signDesktopCanonical(pkcs8Key(server.pkcs8), canonical) };
  });
  const consentInputs = [
    { userLabel: "Ada Lovelace", organizationLabel: "Analytical Engines", durationMinutes: 15, scope: ["desktop.input.click", "desktop.input.key"] as DesktopGrantScope[] },
    { userLabel: "Zoë Ölander", organizationLabel: "Ünïcode GmbH", durationMinutes: 1, scope: ["desktop.input.type"] as DesktopGrantScope[] },
    { userLabel: "Grace", organizationLabel: "Navy", durationMinutes: 60, scope: [...DESKTOP_COMMAND_ACTIONS] },
    { userLabel: "Ada Lovelace", organizationLabel: "Analytical Engines", durationMinutes: 15, scope: ["desktop.app.launch"] as DesktopGrantScope[] },
  ];
  return {
    note: "TEST KEYS ONLY. Generated by packages/core/test/computer-control-desktop-protocol-p19.test.ts. Never use these keys anywhere else.",
    deviceKey: { ...device, fingerprint: deviceFingerprint, display: desktopFingerprintDisplay(deviceFingerprint) },
    serverKey: { ...server, keyId: desktopServerKeyId(server.spki) },
    requests,
    commands,
    responses,
    consent: consentInputs.map((c) => {
      const text = renderDesktopConsentText(c);
      return { ...c, text, sha256: desktopConsentTextSha256(text) };
    }),
    pairingCodes: ["7K3M-Q9X2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01", "7k3mq9x2abcdefghjkmnpqrstvwxyz01", "iLoO-0000-0000-0000-0000-0000-0000-0000"].map((input) => {
      const normalized = normalizeDesktopPairingCode(input)!;
      return { input, normalized, hash: hashDesktopPairingCode(normalized) };
    }),
  };
}

function readOrWrite(name: string, fresh: () => unknown): unknown {
  const path = resolve(CONTRACT_DIR, name);
  if (UPDATE) {
    mkdirSync(CONTRACT_DIR, { recursive: true });
    writeFileSync(path, `${JSON.stringify(fresh(), null, 2)}\n`);
  }
  expect(existsSync(path), `${name} is missing: run with UPDATE_DESKTOP_CONTRACT=1`).toBe(true);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Phase 19.6 — the contract the .NET agent is tested against", () => {
  it("schemas.json is this code's JSON Schema of every message", () => {
    expect(readOrWrite("schemas.json", desktopAgentJsonSchemas)).toEqual(JSON.parse(JSON.stringify(desktopAgentJsonSchemas())));
  });

  it("constants.json holds this code's allowlists, codes and limits", () => {
    expect(readOrWrite("constants.json", constants)).toEqual(constants());
  });

  it("vectors.json: every canonical string, consent text and hash is what this code derives, and every signature verifies", () => {
    const vectors = readOrWrite("vectors.json", freshVectors) as Vectors;
    expect(vectors.note).toMatch(/^TEST KEYS ONLY/);
    expect(desktopKeyFingerprint(vectors.deviceKey.spki)).toBe(vectors.deviceKey.fingerprint);
    expect(desktopFingerprintDisplay(vectors.deviceKey.fingerprint)).toBe(vectors.deviceKey.display);
    expect(desktopServerKeyId(vectors.serverKey.spki)).toBe(vectors.serverKey.keyId);
    for (const r of vectors.requests) {
      expect(desktopRequestCanonical(r.parts)).toBe(r.canonical);
      expect(verifyDesktopCanonical(vectors.deviceKey.spki, r.canonical, r.signature)).toBe(true);
    }
    for (const c of vectors.commands) {
      expect(desktopParamsCanonical(c.parts.params)).toBe(c.paramsCanonical);
      expect(desktopCommandCanonical(c.parts)).toBe(c.canonical);
      expect(verifyDesktopCanonical(vectors.serverKey.spki, c.canonical, c.signature)).toBe(true);
      expect(verifyDesktopCanonical(vectors.deviceKey.spki, c.canonical, c.signature)).toBe(false);
    }
    for (const r of vectors.responses) {
      expect(sha256Hex(r.body)).toBe(r.bodySha256);
      expect(desktopResponseCanonical(r)).toBe(r.canonical);
      expect(verifyDesktopCanonical(vectors.serverKey.spki, r.canonical, r.signature)).toBe(true);
    }
    for (const c of vectors.consent) {
      const text = renderDesktopConsentText(c);
      expect(text).toBe(c.text);
      expect(desktopConsentTextSha256(text)).toBe(c.sha256);
    }
    for (const p of vectors.pairingCodes) {
      expect(normalizeDesktopPairingCode(p.input)).toBe(p.normalized);
      expect(hashDesktopPairingCode(p.normalized)).toBe(p.hash);
    }
  });

  it("the command allowlist in the JSON Schema is exactly v1's", () => {
    const schemas = desktopAgentJsonSchemas() as Record<string, { anyOf?: Array<{ properties: { action: { const: string } } }> }>;
    const actions = schemas.CommandEnvelope!.anyOf!.map((variant) => variant.properties.action.const).sort();
    expect(actions).toEqual([...DESKTOP_COMMAND_ACTIONS].sort());
  });
});

describe("Phase 19.6 — an approval is bound to its device", () => {
  it("puts the device in the approved parameters, so the hash differs per device, and the value-free record still reads", async () => {
    const { computeParamsHash } = await import("../src/utils/params-hash.js");
    const { computerControlApprovalRecord, readComputerControlApprovalRecord } = await import("../src/computer-control.js");
    const { desktopApprovalParams } = await import("../src/desktop-agent.js");
    const params: DesktopCommandParams = { action: "desktop.input.type", text: "hunter2-TYPED" };
    const onA = desktopApprovalParams(params, "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c");
    const onB = desktopApprovalParams(params, "0b8f3a52-7d1e-4c55-9f0a-2c6b1e9d4a77");
    expect(onA).toEqual({ deviceId: "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c", text: "hunter2-TYPED" });
    expect(computeParamsHash(onA)).not.toBe(computeParamsHash(onB));
    const record = computerControlApprovalRecord("desktop.input.type", onA);
    expect(JSON.stringify(record)).not.toContain("hunter2-TYPED");
    expect(readComputerControlApprovalRecord("desktop.input.type", record)?.actionSummary).toMatch(/^Type into the focused window/);
  });
});

// ---------------------------------------------------------------------------
// The no-inbound-port check looks at the agent that is running.
//
// The agent is single-instance. A check that started a copy of it beside a
// paired agent got a copy that exited at once, inspected nothing and reported a
// pass; and a socket read that failed looked like no sockets. The first suite
// reads the script, on every platform. The second runs it on Windows against
// real processes holding real sockets: a copy of node named as the agent, on
// loopback. No agent, no pairing and no input are involved.
// ---------------------------------------------------------------------------

const NO_LISTENER_CHECK = resolve(here, "../../../apps/desktop-agent/packaging/check-no-listener.ps1");
const NO_LISTENER_EVIDENCE = resolve(here, "../../../apps/desktop-agent/packaging/NoListenerEvidence.ps1");
const NO_LISTENER_TESTS = resolve(here, "../../../apps/desktop-agent/packaging/no-listener-evidence.tests.ps1");
const CI_WORKFLOW = resolve(here, "../../../.github/workflows/ci.yml");
const AGENT_PROCESS = "Jarvis.DesktopAgent";

/** A script without its comments: what it does, not what it says. */
const withoutComments = (path: string): string =>
  readFileSync(path, "utf8")
    .replace(/<#[\s\S]*?#>/g, "")
    .replace(/(^|\s)#.*$/gm, "$1");

const noListenerCode = (): string => withoutComments(NO_LISTENER_CHECK);
const evidenceCode = (): string => withoutComments(NO_LISTENER_EVIDENCE);

describe("Phase 19.6 — the no-inbound-port check, as written", () => {
  it("can start nothing: it runs only netstat by fixed name, and launches no process, job or shell", () => {
    const code = `${noListenerCode()}\n${evidenceCode()}`;
    expect(code).not.toMatch(
      /\$Executable\b|Start-Process|Start-Job|Invoke-Item|Invoke-Expression|\biex\b|Diagnostics\.Process|ProcessStartInfo/i
    );
    // The one external program it runs is netstat, by its fixed name.
    expect(evidenceCode()).toMatch(/\$NetstatPath\s*=\s*"netstat\.exe"/);
    expect(evidenceCode()).toMatch(/&\s*\$NetstatPath\s+-ano/);
    expect(evidenceCode()).not.toMatch(/&\s*["']/);
  });

  it("reads both socket tables, and a read that fails is a failure", () => {
    const code = `${noListenerCode()}\n${evidenceCode()}`;
    expect(evidenceCode()).toMatch(/ConvertFrom-NetstatOutput/);
    expect(evidenceCode()).toMatch(/GetExtendedTcpTable/);
    expect(evidenceCode()).toMatch(/GetExtendedUdpTable/);
    expect(evidenceCode()).toMatch(/Get-NetTCPConnection -State Listen -ErrorAction Stop/);
    expect(evidenceCode()).toMatch(/Get-NetUDPEndpoint -ErrorAction Stop/);
    expect(evidenceCode()).not.toMatch(/(?<!Get-Command )Get-NetTCPConnection[^\n]*-ErrorAction SilentlyContinue/);
    expect(evidenceCode()).not.toMatch(/(?<!Get-Command )Get-NetUDPEndpoint[^\n]*-ErrorAction SilentlyContinue/);
    expect(evidenceCode()).toMatch(/exit \$LASTEXITCODE/);
    // The filter that passed while a port was open must not come back.
    expect(code).not.toMatch(/State -eq "Listen"/);
    expect(code).toMatch(/Test-NetstatRowIsListener/);
  });

  it("cannot pass without seeing its own loopback control", () => {
    const code = `${noListenerCode()}${evidenceCode()}`;
    expect(code).toMatch(/New-NoListenerControl/);
    expect(code).toMatch(/ControlTcpPort/);
    expect(code).toMatch(/CONTROL_UNOBSERVED/);
    expect(code).toMatch(/INCONCLUSIVE/);
    // The control is opened by the check, on loopback, and closes in a finally.
    expect(code).toMatch(/IPAddress\]::Loopback/);
    expect(code).toMatch(/Close-NoListenerControl/);
  });

  it("treats PID 0 as the kernel's, never the process under test", () => {
    expect(evidenceCode()).toMatch(/OwningProcess -ne 0/);
  });

  it("is ASCII, so Windows PowerShell 5.1 reads it as written", () => {
    for (const path of [NO_LISTENER_CHECK, NO_LISTENER_EVIDENCE, NO_LISTENER_TESTS]) {
      expect(readFileSync(path, "utf8"), path).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
    }
  });

  it("CI runs the same parser and decision, not the old State filter", () => {
    const ci = readFileSync(CI_WORKFLOW, "utf8");
    expect(ci).not.toMatch(/State -eq "Listen"/);
    expect(ci).toMatch(/no-listener-evidence\.tests\.ps1/);
    expect(ci).toMatch(/\.\s*\.\/packaging\/NoListenerEvidence\.ps1/);
    expect(ci).not.toMatch(/check-no-listener\.ps1 -Executable/);
    expect(ci).toMatch(/- name: Start-up opens no port\n/);
    expect(ci).toMatch(/- name: The port check refuses when no agent is running\n/);
  });
});

describe.runIf(process.platform === "win32")("Phase 19.6 — the no-inbound-port check, run for real", () => {
  const STAND_IN = `
    const net = require("node:net");
    const dgram = require("node:dgram");
    const [mode, port] = process.argv.slice(2);
    const ready = () => process.stdout.write("READY\\n");
    const whenTold = (then) => process.stdin.once("data", then);
    setInterval(() => undefined, 1000);
    const polling = (then) => net.connect(Number(port), "127.0.0.1", then).on("error", () => undefined);
    if (mode === "idle") ready();
    if (mode === "polling") polling(ready);
    if (mode === "listening") polling(() => net.createServer().listen(0, "127.0.0.1", ready));
    if (mode === "wildcard") polling(() => net.createServer().listen(0, "0.0.0.0", ready));
    if (mode === "udp") polling(() => dgram.createSocket("udp4").bind(0, "127.0.0.1", ready));
    if (mode === "listens-late") polling(() => { ready(); whenTold(() => net.createServer().listen(0, "127.0.0.1")); });
    if (mode === "stops") polling(() => { ready(); whenTold(() => process.exit(0)); });
  `;

  let dir = "";
  let executable = "";
  let program = "";
  let server: Server;
  let port = 0;
  const running: ChildProcess[] = [];

  /** Runs the script; `afterFirstLook` fires when it reports a finished look, never by the clock. */
  function runCheck(args: string[], afterFirstLook?: () => void): Promise<{ status: number; output: string }> {
    const command = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", NO_LISTENER_CHECK, ...args];
    return new Promise((done) => {
      const child = execFile("powershell.exe", command, { encoding: "utf8", timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
        const status = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        done({ status, output: `${stdout}${stderr}` });
      });
      let told = false;
      child.stdout?.on("data", (data: Buffer | string) => {
        if (told || !data.toString().includes("sample 1 clean")) return;
        told = true;
        afterFirstLook?.();
      });
    });
  }

  const check = (...args: string[]) => runCheck(args);

  /** How many processes are running under the agent's name. */
  function agentProcesses(): Promise<number> {
    return new Promise((done, fail) => {
      execFile("tasklist", ["/FI", `IMAGENAME eq ${AGENT_PROCESS}.exe`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true }, (error, stdout) => {
        if (error) fail(error);
        else done(stdout.split(/\r?\n/).filter((line) => line.startsWith(`"${AGENT_PROCESS}.exe"`)).length);
      });
    });
  }

  function start(mode: string): Promise<ChildProcess> {
    return new Promise((done, fail) => {
      const child = spawn(executable, [program, mode, String(port)], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      running.push(child);
      child.on("error", fail);
      child.stdout?.on("data", (data: Buffer) => {
        if (data.toString().includes("READY")) done(child);
      });
    });
  }

  beforeAll(async () => {
    // Never beside a real agent: these tests stop what they started, and the
    // check would be looking at the wrong process.
    expect(await agentProcesses(), "a real agent is running; stop it before these tests").toBe(0);
    dir = mkdtempSync(join(tmpdir(), "jarvis-no-listener-"));
    executable = join(dir, `${AGENT_PROCESS}.exe`);
    copyFileSync(process.execPath, executable);
    program = join(dir, "stand-in.cjs");
    writeFileSync(program, STAND_IN);
    server = createServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await Promise.all(
      running.splice(0).map(
        (child) =>
          new Promise<void>((gone) => {
            if (child.exitCode !== null) return gone();
            child.once("exit", () => gone());
            child.kill();
          })
      )
    );
  });

  afterAll(() => {
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("fails when no agent is running, and starts none", async () => {
    const { status, output } = await check("-Seconds", "1");
    expect(status).toBe(1);
    expect(output).toMatch(/no running agent/i);
    expect(await agentProcesses()).toBe(0);
  });

  it("will not be told to start one", async () => {
    const { status } = await check("-Seconds", "1", "-Executable", executable);
    expect(status).not.toBe(0);
    expect(await agentProcesses()).toBe(0);
  });

  it("catches a listener in the running agent: the false pass, where a started copy exited and nothing was inspected", async () => {
    await start("listening");
    const { status, output } = await check("-Seconds", "2");
    expect(status).toBe(1);
    expect(output).toMatch(/LISTENING: 127\.0\.0\.1:\d+/);
    expect(await agentProcesses()).toBe(1);
  });

  it("catches a wildcard listener in the running agent", async () => {
    await start("wildcard");
    const { status, output } = await check("-Seconds", "2");
    expect(status).toBe(1);
    expect(output).toMatch(/LISTENING: 0\.0\.0\.0:\d+/);
  });

  it("catches a UDP endpoint in the running agent", async () => {
    await start("udp");
    const { status, output } = await check("-Seconds", "2");
    expect(status).toBe(1);
    expect(output).toMatch(/UDP: 127\.0\.0\.1:\d+/);
  });

  it("catches a listener opened after the check began", async () => {
    const agent = await start("listens-late");
    const { status, output } = await runCheck(["-Seconds", "6"], () => agent.stdin?.write("go\n"));
    expect(status).toBe(1);
    expect(output).toMatch(/sample 1 clean[\s\S]*LISTENING: 127\.0\.0\.1:\d+/);
  });

  it("fails for an agent with no connection to a server: it is not paired and polling, so nothing is proven", async () => {
    await start("idle");
    const { status, output } = await check("-Seconds", "2");
    expect(status).toBe(1);
    expect(output).toMatch(/not paired and polling/i);
  });

  it("fails when the agent stops during the check", async () => {
    const agent = await start("stops");
    const { status, output } = await runCheck(["-Seconds", "6"], () => agent.stdin?.write("go\n"));
    expect(status).toBe(1);
    expect(output).toMatch(/stopped during the check/i);
  });

  it("fails when more than one agent is running, rather than choosing", async () => {
    await start("polling");
    await start("polling");
    const { status, output } = await check("-Seconds", "1");
    expect(status).toBe(1);
    expect(output).toMatch(/2 agents are running/i);
  });

  it("passes for the running agent holding its outbound connection and no port, and names it", async () => {
    const agent = await start("polling");
    const { status, output } = await check("-Seconds", "2");
    expect(status, output).toBe(0);
    expect(output).toContain(`pid ${agent.pid}`);
    expect(output).toMatch(/positive control observed \(sources: netstat/);
    expect(output).toMatch(/PASS/);
    expect(await agentProcesses()).toBe(1);
  });
});
