// ---------------------------------------------------------------------------
// UI V2 — per-user third-party credentials, encrypted at rest.
//
// Backed by the EXISTING `UserSetting` table (a per-user key/value store with a
// unique constraint on [userId, key]), so this needs no migration. That matters
// here: the one migration in this repository's history that could not apply to
// a fresh database is still the reason a container start can fail, and adding
// another table for four string fields would not earn its risk.
//
// WHAT IS STORED IS AN ENVELOPE, NEVER PLAINTEXT. Callers hand in a string that
// EncryptionService has already sealed (`v1:iv:tag:ciphertext`). This layer
// deliberately does not encrypt: keeping the key out of the persistence layer
// means a query, a log line or a backup of this table cannot leak a secret, and
// there is exactly one place — the route — that holds plaintext at all.
//
// The `Integration` model is NOT used, for the reason its own schema comment
// gives: it is global rather than per-user and has no User relation, so it
// cannot express "this operator's Meta token" or be isolated per tenant.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";

/** Namespaced so these rows can never collide with an ordinary user setting. */
const KEY_PREFIX = "credential:";

function settingKey(provider: string): string {
  return `${KEY_PREFIX}${provider}`;
}

export interface StoredCredential {
  provider: string;
  /** Opaque AES-256-GCM envelope. Meaningless without the encryption key. */
  envelope: string;
}

export class PrismaCredentialRepository {
  constructor(private prisma: PrismaClient) {}

  /** The sealed envelope for one provider, or null when nothing is stored. */
  async get(userId: string, provider: string): Promise<string | null> {
    const row = await this.prisma.userSetting.findUnique({
      where: { userId_key: { userId, key: settingKey(provider) } },
    });
    return row?.value ?? null;
  }

  /**
   * Stores or replaces a provider's credentials.
   *
   * Upsert rather than create-then-update so a double submit converges instead
   * of failing on the unique constraint.
   */
  async put(userId: string, provider: string, envelope: string): Promise<void> {
    const key = settingKey(provider);
    await this.prisma.userSetting.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value: envelope },
      update: { value: envelope },
    });
  }

  /** Removes a provider's credentials. Absent rows are not an error. */
  async remove(userId: string, provider: string): Promise<void> {
    await this.prisma.userSetting.deleteMany({
      where: { userId, key: settingKey(provider) },
    });
  }

  /**
   * Which providers this user has configured.
   *
   * Returns names only — never the envelopes — so a caller listing status
   * cannot accidentally serialise ciphertext into a response.
   */
  async listConfiguredProviders(userId: string): Promise<string[]> {
    const rows = await this.prisma.userSetting.findMany({
      where: { userId, key: { startsWith: KEY_PREFIX } },
      select: { key: true },
    });
    return rows.map((r: { key: string }) => r.key.slice(KEY_PREFIX.length));
  }
}
