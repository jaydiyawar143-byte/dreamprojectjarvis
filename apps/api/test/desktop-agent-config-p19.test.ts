// ---------------------------------------------------------------------------
// Phase 19.6 — the desktop agent is OFF unless the operator switches it on,
// and stays off unless everything it needs is there.
//
// `container.desktopControl` is built only from an enabled configuration, and
// apps/api/src/index.ts mounts the desktop routes only when it exists — so
// each refusal here is a deployment with no desktop route at all.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { desktopServerKeyId } from "@jarvis/core";
import { isDesktopAgentEnabled, loadDesktopAgentConfig } from "../src/services/desktop/config.js";

const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEY = p256.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const VALID = {
  DESKTOP_AGENT_ENABLED: "true",
  DESKTOP_AGENT_COMMAND_SIGNING_KEY: KEY,
  DESKTOP_AGENT_MIN_WINDOWS_BUILD: "26100",
} as NodeJS.ProcessEnv;

describe("Phase 19.6 — desktop agent configuration", () => {
  it("is off when nothing is set", () => {
    expect(isDesktopAgentEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(loadDesktopAgentConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it.each(["TRUE", "1", "yes", "on", " true", ""])("is off for DESKTOP_AGENT_ENABLED=%j — only exactly \"true\" switches it on", (value) => {
    expect(loadDesktopAgentConfig({ ...VALID, DESKTOP_AGENT_ENABLED: value }).enabled).toBe(false);
  });

  it("stays off without the signing key, or with one that is not an ECDSA P-256 private key", () => {
    const { DESKTOP_AGENT_COMMAND_SIGNING_KEY: _omit, ...withoutKey } = VALID;
    expect(loadDesktopAgentConfig(withoutKey as NodeJS.ProcessEnv)).toMatchObject({ enabled: false, reason: expect.stringContaining("DESKTOP_AGENT_COMMAND_SIGNING_KEY") });
    expect(loadDesktopAgentConfig({ ...VALID, DESKTOP_AGENT_COMMAND_SIGNING_KEY: "not-a-key" }).enabled).toBe(false);
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(loadDesktopAgentConfig({ ...VALID, DESKTOP_AGENT_COMMAND_SIGNING_KEY: p384 }).enabled).toBe(false);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(loadDesktopAgentConfig({ ...VALID, DESKTOP_AGENT_COMMAND_SIGNING_KEY: rsa }).enabled).toBe(false);
  });

  it("stays off without a minimum Windows 11 build — there is no default — or with one before Windows 11", () => {
    const { DESKTOP_AGENT_MIN_WINDOWS_BUILD: _omit, ...withoutBuild } = VALID;
    expect(loadDesktopAgentConfig(withoutBuild as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(loadDesktopAgentConfig({ ...VALID, DESKTOP_AGENT_MIN_WINDOWS_BUILD: "19045" }).enabled).toBe(false);
    expect(loadDesktopAgentConfig({ ...VALID, DESKTOP_AGENT_MIN_WINDOWS_BUILD: "26100.1" }).enabled).toBe(false);
  });

  it("stays off with a malformed minimum agent version", () => {
    expect(loadDesktopAgentConfig({ ...VALID, DESKTOP_AGENT_MIN_VERSION: "1.0" }).enabled).toBe(false);
  });

  it("is on with everything, and names the key every computer will pin", () => {
    const loaded = loadDesktopAgentConfig(VALID);
    if (!loaded.enabled) throw new Error(loaded.reason);
    const spki = p256.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(loaded.config.serverPublicKey).toBe(spki);
    expect(loaded.config.serverKeyId).toBe(desktopServerKeyId(spki));
    expect(loaded.config.minWindowsBuild).toBe(26100);
  });
});
