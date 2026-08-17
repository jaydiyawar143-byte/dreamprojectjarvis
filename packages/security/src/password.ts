import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import type { IPasswordHasher } from "@jarvis/core";

const SALT_LENGTH = 32;
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 128 * 1024 * 1024,
};

export class PasswordHasher implements IPasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await this.scryptAsync(password, salt);
    return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
  }

  async compare(password: string, storedHash: string): Promise<boolean> {
    const parts = storedHash.split(":");
    if (parts.length !== 3 || parts[0] !== "scrypt") {
      return false;
    }

    const salt = Buffer.from(parts[1], "hex");
    const storedKey = Buffer.from(parts[2], "hex");
    const derived = await this.scryptAsync(password, salt);

    if (storedKey.length !== derived.length) {
      return false;
    }

    return timingSafeEqual(storedKey, derived);
  }

  private scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey as Buffer);
      });
    });
  }
}
