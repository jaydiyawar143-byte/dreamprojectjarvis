// ---------------------------------------------------------------------------
// V3 — Command Center preferences.
//
// Widget layout, clock mode, weather location, market watchlist. Stored server-
// side so the dashboard looks the same on a second device, and reusing the
// existing per-user `UserSetting` table so this needs no migration of its own.
//
// ONE ROW PER USER holding a JSON document, rather than a row per preference.
// The whole document is read on every dashboard load and written whole when
// something changes, so splitting it into rows would turn one query into a
// dozen and buy nothing — there is no query that needs a single preference in
// isolation.
//
// Namespaced under `prefs:` so these can never collide with the `credential:`
// rows in the same table.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";

const KEY = "prefs:command-center";

export class PrismaPreferenceRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * The stored document, or null.
   *
   * Unparseable JSON is treated as absent rather than thrown: a corrupt
   * preference must degrade to defaults, never break the dashboard.
   */
  async get(userId: string): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.userSetting.findUnique({
      where: { userId_key: { userId, key: KEY } },
    });
    if (!row?.value) return null;
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async put(userId: string, prefs: Record<string, unknown>): Promise<void> {
    const value = JSON.stringify(prefs);
    await this.prisma.userSetting.upsert({
      where: { userId_key: { userId, key: KEY } },
      create: { userId, key: KEY, value },
      update: { value },
    });
  }
}
