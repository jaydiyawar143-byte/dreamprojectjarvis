import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// EncryptionService — authenticated symmetric encryption for secrets at rest
// ---------------------------------------------------------------------------
// Sprint 5.2. JARVIS previously had NO encryption-at-rest primitive: `crypto`
// was used only for scrypt password hashing, SHA token hashing and UUIDs.
// Google refresh tokens are long-lived bearer credentials, so they must never
// reach Postgres as plaintext.
//
// AES-256-GCM is used rather than CBC/CTR because it authenticates: a mutated
// ciphertext fails to decrypt instead of yielding attacker-influenced plaintext.
//
// Envelope format (all base64url, ":" separated — the envelope is not secret):
//
//   v<keyVersion>:<iv>:<authTag>:<ciphertext>
//
// The version prefix exists so keys can be ROTATED without a migration: new
// writes use the active key, old rows still decrypt under their original key
// until re-encrypted. Decrypting an envelope whose key version is not in the
// keyring is a hard error, never a silent empty string.
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;
const ENVELOPE_PARTS = 4;

export type EncryptionErrorCode =
  | "INVALID_KEY"
  | "INVALID_ENVELOPE"
  | "UNKNOWN_KEY_VERSION"
  | "DECRYPTION_FAILED";

export class EncryptionError extends Error {
  override readonly name = "EncryptionError";
  readonly code: EncryptionErrorCode;

  constructor(code: EncryptionErrorCode, message: string) {
    // Messages are STATIC descriptions. They must never embed key material,
    // plaintext, or ciphertext — these strings reach logs and audit rows.
    super(message);
    this.code = code;
  }
}

export interface EncryptionKey {
  version: number;
  /** Raw 32-byte key. */
  key: Buffer;
}

/** Decodes a base64 key and rejects anything that is not exactly 32 bytes. */
export function parseKey(version: number, encoded: string): EncryptionKey {
  if (!Number.isInteger(version) || version < 1) {
    throw new EncryptionError("INVALID_KEY", "Encryption key version must be a positive integer");
  }
  const raw = Buffer.from(encoded, "base64");
  if (raw.length !== KEY_BYTES) {
    throw new EncryptionError(
      "INVALID_KEY",
      "Encryption key must decode to exactly 32 bytes for AES-256"
    );
  }
  return { version, key: raw };
}

/** Generates a fresh base64 key. Operator convenience — never called at runtime. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export class EncryptionService {
  private readonly keyring = new Map<number, Buffer>();
  private readonly activeVersion: number;

  /**
   * @param keys All keys that must remain decryptable (current + retired).
   * @param activeVersion Version used for new writes. Defaults to the highest.
   */
  constructor(keys: EncryptionKey[], activeVersion?: number) {
    if (keys.length === 0) {
      throw new EncryptionError("INVALID_KEY", "At least one encryption key is required");
    }
    for (const { version, key } of keys) {
      if (key.length !== KEY_BYTES) {
        throw new EncryptionError("INVALID_KEY", "Encryption key must be 32 bytes for AES-256");
      }
      this.keyring.set(version, key);
    }
    const resolved = activeVersion ?? Math.max(...keys.map((k) => k.version));
    if (!this.keyring.has(resolved)) {
      throw new EncryptionError("INVALID_KEY", "Active key version is not present in the keyring");
    }
    this.activeVersion = resolved;
  }

  /**
   * Builds a service from the environment. JARVIS_ENCRYPTION_KEY is the active
   * key; JARVIS_ENCRYPTION_KEY_RETIRED optionally carries retired keys as
   * "version:base64" pairs, comma separated, so rotation needs no migration.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): EncryptionService {
    const active = env.JARVIS_ENCRYPTION_KEY;
    if (!active) {
      throw new EncryptionError(
        "INVALID_KEY",
        "JARVIS_ENCRYPTION_KEY is required to store third-party credentials"
      );
    }
    const activeVersion = Number(env.JARVIS_ENCRYPTION_KEY_VERSION ?? "1");
    const keys: EncryptionKey[] = [parseKey(activeVersion, active)];

    const retired = env.JARVIS_ENCRYPTION_KEY_RETIRED;
    if (retired) {
      for (const entry of retired.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = entry.indexOf(":");
        if (idx === -1) {
          throw new EncryptionError(
            "INVALID_KEY",
            "Retired encryption keys must be formatted as version:base64"
          );
        }
        const version = Number(entry.slice(0, idx));
        if (version === activeVersion) continue;
        keys.push(parseKey(version, entry.slice(idx + 1)));
      }
    }
    return new EncryptionService(keys, activeVersion);
  }

  get keyVersion(): number {
    return this.activeVersion;
  }

  encrypt(plaintext: string): string {
    const key = this.keyring.get(this.activeVersion)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      "v" + this.activeVersion,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(":");
  }

  decrypt(envelope: string): string {
    const parts = envelope.split(":");
    if (parts.length !== ENVELOPE_PARTS || !parts[0].startsWith("v")) {
      throw new EncryptionError("INVALID_ENVELOPE", "Malformed ciphertext envelope");
    }
    const version = Number(parts[0].slice(1));
    if (!Number.isInteger(version)) {
      throw new EncryptionError("INVALID_ENVELOPE", "Malformed ciphertext envelope");
    }
    const key = this.keyring.get(version);
    if (!key) {
      throw new EncryptionError(
        "UNKNOWN_KEY_VERSION",
        "Ciphertext was encrypted with a key that is not in the keyring"
      );
    }

    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new EncryptionError("INVALID_ENVELOPE", "Malformed ciphertext envelope");
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // GCM tag mismatch — tampered, truncated, or wrong key. Never leak which.
      throw new EncryptionError("DECRYPTION_FAILED", "Ciphertext failed authentication");
    }
  }

  /** True when an envelope was written under a retired key and should be re-encrypted. */
  needsRotation(envelope: string): boolean {
    const version = Number(envelope.split(":")[0]?.slice(1));
    return Number.isInteger(version) && version !== this.activeVersion;
  }
}

/** Constant-time comparison for OAuth state and similar short opaque values. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
