// An in-memory IConfirmationRepository for unit tests.
//
// The real store is PostgreSQL (PrismaConfirmationRepository); its atomicity is
// proven against a real database in the `*-pg.integration` tests. This double
// exists so the confirmation RULES — binding, expiry, single use — can be
// tested without one. It is test code and is never wired into the application.
import type { ConfirmationRecord, IConfirmationRepository } from "@jarvis/core";

export interface StoredConfirmation extends ConfirmationRecord {
  tokenHash: string;
  consumedAt: Date | null;
}

export function memoryConfirmationStore() {
  const rows = new Map<string, StoredConfirmation>();
  let sequence = 0;

  const store: IConfirmationRepository = {
    async create(record) {
      const id = `confirmation-${++sequence}`;
      rows.set(record.tokenHash, { ...record, id, consumedAt: null });
      return { id };
    },
    async consume(tokenHash, now) {
      const row = rows.get(tokenHash);
      if (!row || row.consumedAt) return null;
      row.consumedAt = now;
      return {
        id: row.id,
        userId: row.userId,
        integration: row.integration,
        actionId: row.actionId,
        paramsHash: row.paramsHash,
        expiresAt: row.expiresAt,
      };
    },
    async deleteExpiredBefore(cutoff) {
      let removed = 0;
      for (const [tokenHash, row] of rows) {
        if (row.expiresAt < cutoff) {
          rows.delete(tokenHash);
          removed += 1;
        }
      }
      return removed;
    },
  };

  return { store, rows };
}
