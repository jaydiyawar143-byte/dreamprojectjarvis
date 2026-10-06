import type { PrismaClient } from "@prisma/client";
import type { ConfirmationRecord, IConfirmationRepository } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Phase 13 — the durable confirmation store.
//
// A confirmation of one external write, kept in PostgreSQL so every API
// instance sees the same state and a restart loses nothing.
//
// `consume` is the reason this is a repository and not a query: it is the one
// atomic step in the confirmation lifecycle. Everything else — who may use a
// confirmation, whether it has expired — is judged by the confirmation service
// on the record this hands back.
// ---------------------------------------------------------------------------

export class PrismaConfirmationRepository implements IConfirmationRepository {
  constructor(private prisma: PrismaClient) {}

  async create(
    record: Omit<ConfirmationRecord, "id"> & { tokenHash: string }
  ): Promise<{ id: string }> {
    return this.prisma.confirmation.create({
      data: {
        tokenHash: record.tokenHash,
        userId: record.userId,
        integration: record.integration,
        actionId: record.actionId,
        paramsHash: record.paramsHash,
        expiresAt: record.expiresAt,
      },
      select: { id: true },
    });
  }

  /**
   * Takes a pending confirmation out of play, exactly once.
   *
   * ONE conditional UPDATE: `consumed_at IS NULL` is the compare, `SET
   * consumed_at` is the set. PostgreSQL's row lock serialises concurrent
   * callers — the second waits for the first to commit, re-reads the row, finds
   * `consumed_at` set, and updates nothing. So across any number of requests
   * and any number of API instances, exactly one caller sees `count === 1`.
   *
   * This is deliberately NOT a read, a check in application memory and a
   * write: two callers would both pass the check before either wrote.
   *
   * The read that follows is safe without a transaction. The row was claimed
   * by this caller alone, and nothing modifies a consumed row.
   */
  async consume(tokenHash: string, now: Date): Promise<ConfirmationRecord | null> {
    const claimed = await this.prisma.confirmation.updateMany({
      where: { tokenHash, consumedAt: null },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) return null;

    const row = await this.prisma.confirmation.findUnique({ where: { tokenHash } });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      integration: row.integration,
      actionId: row.actionId,
      paramsHash: row.paramsHash,
      expiresAt: row.expiresAt,
    };
  }

  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const result = await this.prisma.confirmation.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    return result.count;
  }
}
