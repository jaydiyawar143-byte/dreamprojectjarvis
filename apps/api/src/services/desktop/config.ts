// ---------------------------------------------------------------------------
// Phase 19, Stage 19.6 — whether this deployment offers desktop control, and
// with what.
//
// OFF unless `DESKTOP_AGENT_ENABLED` is exactly "true". On, it needs every one
// of these, or it stays off and says which is missing (never which value):
//
//   DESKTOP_AGENT_COMMAND_SIGNING_KEY  base64 PKCS#8 DER of the ECDSA P-256 key
//                                      that signs every command and response.
//                                      Agents pin its public half at pairing.
//   DESKTOP_AGENT_MIN_WINDOWS_BUILD    the oldest Windows 11 build accepted.
//                                      No default (U6a): "serviced releases
//                                      only" is the operator's to name, from
//                                      Microsoft's lifecycle, not this code's.
//   DESKTOP_AGENT_MIN_VERSION          optional; the oldest agent accepted.
//                                      Defaults to this release's agent.
//   DESKTOP_TYPE_MAX_LENGTH            optional; the longest text one action may
//                                      type here, up to the protocol's bound.
//   JARVIS_ENCRYPTION_KEY              checked where the sealer is built: a
//                                      command's parameters are sealed.
// ---------------------------------------------------------------------------

import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

import {
  DESKTOP_AGENT_CURRENT_VERSION,
  DESKTOP_TYPE_TEXT_DEFAULT_MAX_LENGTH,
  DESKTOP_TYPE_TEXT_MAX_LENGTH,
  DESKTOP_WINDOWS_11_FIRST_BUILD,
  compareDesktopAgentVersions,
  desktopServerKeyId,
} from "@jarvis/core";

export interface DesktopAgentConfig {
  signingKey: KeyObject;
  /** Base64 SubjectPublicKeyInfo of the signing key, sent to agents at pairing. */
  serverPublicKey: string;
  serverKeyId: string;
  minWindowsBuild: number;
  minAgentVersion: string;
  /** The longest text one action may type on this deployment. */
  typeMaxLength: number;
}

export type DesktopAgentConfigResult =
  | { enabled: false; reason: string }
  | { enabled: true; config: DesktopAgentConfig };

export function isDesktopAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DESKTOP_AGENT_ENABLED === "true";
}

export function loadDesktopAgentConfig(env: NodeJS.ProcessEnv = process.env): DesktopAgentConfigResult {
  if (!isDesktopAgentEnabled(env)) return { enabled: false, reason: "DESKTOP_AGENT_ENABLED is not set to true" };

  const rawKey = env.DESKTOP_AGENT_COMMAND_SIGNING_KEY?.trim();
  if (!rawKey) return { enabled: false, reason: "DESKTOP_AGENT_COMMAND_SIGNING_KEY is not set" };
  let signingKey: KeyObject;
  try {
    signingKey = createPrivateKey({ key: Buffer.from(rawKey, "base64"), format: "der", type: "pkcs8" });
  } catch {
    return { enabled: false, reason: "DESKTOP_AGENT_COMMAND_SIGNING_KEY is not a base64 PKCS#8 private key" };
  }
  if (signingKey.asymmetricKeyType !== "ec" || signingKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    return { enabled: false, reason: "DESKTOP_AGENT_COMMAND_SIGNING_KEY is not an ECDSA P-256 key" };
  }

  const rawBuild = env.DESKTOP_AGENT_MIN_WINDOWS_BUILD?.trim();
  if (!rawBuild) {
    return { enabled: false, reason: "DESKTOP_AGENT_MIN_WINDOWS_BUILD is not set; name the oldest serviced Windows 11 build" };
  }
  if (!/^[0-9]{5,7}$/.test(rawBuild) || Number(rawBuild) < DESKTOP_WINDOWS_11_FIRST_BUILD) {
    return { enabled: false, reason: `DESKTOP_AGENT_MIN_WINDOWS_BUILD must be a Windows 11 build number (${DESKTOP_WINDOWS_11_FIRST_BUILD} or later)` };
  }

  const minAgentVersion = env.DESKTOP_AGENT_MIN_VERSION?.trim() || DESKTOP_AGENT_CURRENT_VERSION;
  if (compareDesktopAgentVersions(minAgentVersion, DESKTOP_AGENT_CURRENT_VERSION) === null) {
    return { enabled: false, reason: "DESKTOP_AGENT_MIN_VERSION must be major.minor.patch" };
  }

  const rawLength = env.DESKTOP_TYPE_MAX_LENGTH?.trim();
  const typeMaxLength = rawLength ? Number(rawLength) : DESKTOP_TYPE_TEXT_DEFAULT_MAX_LENGTH;
  if (!Number.isInteger(typeMaxLength) || typeMaxLength < 1 || typeMaxLength > DESKTOP_TYPE_TEXT_MAX_LENGTH) {
    return { enabled: false, reason: `DESKTOP_TYPE_MAX_LENGTH must be a whole number from 1 to ${DESKTOP_TYPE_TEXT_MAX_LENGTH}` };
  }

  const serverPublicKey = createPublicKey(signingKey).export({ format: "der", type: "spki" }).toString("base64");
  return {
    enabled: true,
    config: {
      signingKey,
      serverPublicKey,
      serverKeyId: desktopServerKeyId(serverPublicKey),
      minWindowsBuild: Number(rawBuild),
      minAgentVersion,
      typeMaxLength,
    },
  };
}
