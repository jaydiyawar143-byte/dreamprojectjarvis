// ---------------------------------------------------------------------------
// Phase 17 — database suites that need a shared connection's ONE owner row
// take turns.
//
// A deployment-wide connection (the Meta credential, say) has at most one
// owner (`AutomationConnectorOwner`, unique per key). Two test files that each
// assign it to their own Organization at the same time would move it out from
// under each other, and vitest runs files in parallel. So a file that needs it
// holds a PostgreSQL advisory lock for the whole run, on a connection of its
// own, and gives it back when it is done — or loses it with the connection,
// however the run ends. Files that do not need it are not slowed at all.
// ---------------------------------------------------------------------------

export interface SharedConnectionLease {
  release(): Promise<void>;
}

export async function holdSharedConnection(key: string): Promise<SharedConnectionLease> {
  const { PrismaClient } = await import("@jarvis/db");
  const url = new URL(process.env.DATABASE_URL!);
  // One connection: the lock is the session's, so it must be taken and given
  // back on the same one.
  url.searchParams.set("connection_limit", "1");
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const name = `jarvis-test:shared-connection:${key}`;
  await client.$executeRaw`SELECT pg_advisory_lock(hashtextextended(${name}, 0))`;
  return {
    async release() {
      try {
        await client.$executeRaw`SELECT pg_advisory_unlock(hashtextextended(${name}, 0))`;
      } finally {
        await client.$disconnect();
      }
    },
  };
}
