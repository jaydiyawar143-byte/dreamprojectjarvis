// ---------------------------------------------------------------------------
// Per-user, per-integration operational state.
//
// Three facts that are neither credentials nor health:
//
//   enabled            — the user switched this integration off without
//                        discarding its credential. Distinct from "not
//                        connected": the token is still there and re-enabling
//                        must not require another consent round-trip.
//   enabledServices    — which Google sub-services the user actually wants,
//                        so a connection granting six scopes can still be
//                        narrowed without revoking anything.
//   lastSuccessfulSync — when a real provider READ last returned data. Distinct
//                        from "last tested": a test proves the credential
//                        works, a sync proves data is flowing.
//
// Backed by the EXISTING `UserSetting` table, for the same reason
// `credential-repository.ts` is: [userId, key] is already unique, so this needs
// no migration, and this repository's one historically unappliable migration is
// still the reason a cold container start can fail. Four scalar fields do not
// earn that risk.
//
// NOTHING SECRET IS STORED HERE. The value is a small JSON object of booleans,
// service ids and timestamps, written in plaintext on purpose: it carries no
// credential, and encrypting it would imply to a future reader that it does.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";

/** Namespaced so these rows can never collide with a credential or a setting. */
const KEY_PREFIX = "integration_state:";

function settingKey(integration: string): string {
  return `${KEY_PREFIX}${integration}`;
}

export interface IntegrationState {
  /** Absent in storage means enabled — an integration is on until switched off. */
  enabled: boolean;
  /** Google sub-service ids the user has switched on. */
  enabledServices: string[];
  /** ISO timestamp of the last provider read that actually returned data. */
  lastSuccessfulSyncAt: string | null;
}

const DEFAULT_STATE: IntegrationState = {
  enabled: true,
  enabledServices: [],
  lastSuccessfulSyncAt: null,
};

/**
 * Parses a stored row defensively.
 *
 * A row written by an older build, or corrupted, degrades to the default rather
 * than throwing: this is operational preference data, and failing a whole
 * status page because one JSON blob is malformed trades a cosmetic problem for
 * an outage.
 */
function parse(raw: string | null): IntegrationState {
  if (!raw) return { ...DEFAULT_STATE };
  try {
    const parsed = JSON.parse(raw) as Partial<IntegrationState>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      enabledServices: Array.isArray(parsed.enabledServices)
        ? parsed.enabledServices.filter((s): s is string => typeof s === "string")
        : [],
      lastSuccessfulSyncAt:
        typeof parsed.lastSuccessfulSyncAt === "string" ? parsed.lastSuccessfulSyncAt : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export class PrismaIntegrationStateRepository {
  constructor(private prisma: PrismaClient) {}

  async get(userId: string, integration: string): Promise<IntegrationState> {
    const row = await this.prisma.userSetting.findUnique({
      where: { userId_key: { userId, key: settingKey(integration) } },
    });
    return parse(row?.value ?? null);
  }

  /** Every integration's state for one user, keyed by integration id. */
  async getAll(userId: string): Promise<Record<string, IntegrationState>> {
    const rows = await this.prisma.userSetting.findMany({
      where: { userId, key: { startsWith: KEY_PREFIX } },
      select: { key: true, value: true },
    });
    const out: Record<string, IntegrationState> = {};
    for (const row of rows) {
      out[row.key.slice(KEY_PREFIX.length)] = parse(row.value);
    }
    return out;
  }

  /**
   * Merges a partial change into the stored state.
   *
   * Read-modify-write rather than a blind overwrite, so switching an
   * integration off does not silently discard the service selection the user
   * will still have when they switch it back on.
   */
  async patch(
    userId: string,
    integration: string,
    changes: Partial<IntegrationState>
  ): Promise<IntegrationState> {
    const current = await this.get(userId, integration);
    const next: IntegrationState = { ...current, ...changes };
    const key = settingKey(integration);
    const value = JSON.stringify(next);

    await this.prisma.userSetting.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value },
      update: { value },
    });
    return next;
  }

  /** Drops the row. Used on disconnect so a reconnect starts clean. */
  async clear(userId: string, integration: string): Promise<void> {
    await this.prisma.userSetting.deleteMany({
      where: { userId, key: settingKey(integration) },
    });
  }
}
