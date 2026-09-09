// ---------------------------------------------------------------------------
// Google Maps monthly usage counter.
//
// WHY RAW SQL RATHER THAN `prisma.mapsUsage.upsert`.
//
// This is a CONCURRENT COUNTER, and Prisma's upsert is a read-then-write: two
// requests arriving together both see count = N and both write N + 1, losing an
// increment. Under exactly the runaway-loop conditions this guard exists to
// catch, that undercount is worst — the counter drifts low precisely when it
// matters. `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1` is a single
// atomic statement in Postgres and cannot lose a write.
//
// The parameterised `$queryRaw` tag is used throughout, never string
// interpolation, so a service name can never become SQL.
//
// THE MONTHLY RESET IS IMPLICIT. `period` is "YYYY-MM" in UTC, so a new month
// writes to new rows. There is no scheduled reset job — and therefore no reset
// job that can fail silently and carry a full counter into a new month, which
// is the failure mode that would quietly disable the guard.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** The Google services this counter distinguishes. Priced differently. */
export type MapsService =
  | "places"
  | "autocomplete"
  | "place_details"
  | "geocoding"
  | "routes";

export interface MapsServiceUsage {
  service: string;
  count: number;
}

export interface MapsUserUsage {
  userId: string;
  count: number;
}

/**
 * The UTC calendar month, "YYYY-MM".
 *
 * UTC rather than local time so that two API instances in different zones
 * cannot disagree about which month a request belongs to, and so the rollover
 * is a single instant globally.
 */
export function currentPeriod(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export class PrismaMapsUsageRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Records one billable call and returns the new count for that row.
   *
   * Atomic: the read and the write are one statement, so concurrent callers
   * cannot lose an increment.
   */
  async increment(
    period: string,
    userId: string,
    service: string,
    by = 1
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "MapsUsage" ("id", "period", "user_id", "service", "count", "created_at", "updated_at")
      VALUES (${randomUUID()}, ${period}, ${userId}, ${service}, ${by}, NOW(), NOW())
      ON CONFLICT ("period", "user_id", "service")
      DO UPDATE SET "count" = "MapsUsage"."count" + ${by}, "updated_at" = NOW()
      RETURNING "count"
    `;
    return Number(rows[0]?.count ?? 0);
  }

  /** Every user, every service, for one month. The number the limit applies to. */
  async totalFor(period: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ total: bigint | number | null }>>`
      SELECT COALESCE(SUM("count"), 0) AS total FROM "MapsUsage" WHERE "period" = ${period}
    `;
    return Number(rows[0]?.total ?? 0);
  }

  /** One user's own consumption. The per-tenant view. */
  async totalForUser(period: string, userId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ total: bigint | number | null }>>`
      SELECT COALESCE(SUM("count"), 0) AS total
      FROM "MapsUsage" WHERE "period" = ${period} AND "user_id" = ${userId}
    `;
    return Number(rows[0]?.total ?? 0);
  }

  /** Which Google service is actually consuming the budget. */
  async byService(period: string): Promise<MapsServiceUsage[]> {
    const rows = await this.prisma.$queryRaw<Array<{ service: string; total: bigint | number }>>`
      SELECT "service", SUM("count") AS total
      FROM "MapsUsage" WHERE "period" = ${period}
      GROUP BY "service" ORDER BY total DESC
    `;
    return rows.map((r) => ({ service: r.service, count: Number(r.total) }));
  }

  /**
   * Heaviest users first.
   *
   * Bounded by `limit` because this backs an admin panel, and an unbounded
   * group-by over every user is a query that gets slower every month.
   */
  async byUser(period: string, limit = 10): Promise<MapsUserUsage[]> {
    const rows = await this.prisma.$queryRaw<Array<{ user_id: string; total: bigint | number }>>`
      SELECT "user_id", SUM("count") AS total
      FROM "MapsUsage" WHERE "period" = ${period}
      GROUP BY "user_id" ORDER BY total DESC LIMIT ${limit}
    `;
    return rows.map((r) => ({ userId: r.user_id, count: Number(r.total) }));
  }

  /** When this month's most recent successful call happened. Null if none. */
  async lastRequestAt(period: string): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<Array<{ last: Date | null }>>`
      SELECT MAX("updated_at") AS last FROM "MapsUsage" WHERE "period" = ${period}
    `;
    return rows[0]?.last ?? null;
  }
}
