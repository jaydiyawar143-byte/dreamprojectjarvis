// ---------------------------------------------------------------------------
// S7 Step 8 / Step 9B — memory vector backfill: entry point.
//
//   DATABASE_URL=<target> npx tsx scripts/s7-memory-backfill/run.ts \
//     --confirm-target=<host>:<port>/<database>            # dry run
//
//   ... --execute --expect-cast=<n> --expect-reembed=<n> --rollback-log=<new file>
//       --backup-file=<fresh plain pg_dump> --live-api-container=<running API>
//   ... --rollback=<rollback log>
//
// Run from apps/api. See backfill-cli.ts for every guard. DATABASE_URL is read
// HERE, before anything imports the Prisma client — which would otherwise load
// packages/db/.env and silently point at the development database.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { BACKUP_MAX_BYTES, runMemoryBackfill } from "./backfill-cli.js";
import { inspectLiveApiContainer } from "./live-api.js";

const explicitDatabaseUrl = process.env.DATABASE_URL;

let exitCode = 70;
try {
  const db = await import("@jarvis/db");
  const { OpenAIEmbeddingProvider } = await import("@jarvis/ai-openai");
  const prisma = new db.PrismaClient();
  try {
    exitCode = await runMemoryBackfill(process.argv.slice(2), explicitDatabaseUrl, process.env, {
      prisma,
      plan: (p) => db.planMemoryVectorBackfill(p),
      applyCastBatch: db.applyMemoryVectorCastBatch,
      reembed: db.reembedMemoryVectors,
      rollbackCast: db.rollbackMemoryVectorCastBatch,
      rollbackReembed: db.rollbackMemoryVectorReembed,
      createEmbeddingProvider: (model) => new OpenAIEmbeddingProvider({ model }),
      inspectLiveApi: async (container, signatures) => inspectLiveApiContainer(container, signatures),
      readBackup: (path) => {
        let stat;
        try {
          stat = statSync(path);
        } catch {
          return null;
        }
        if (!stat.isFile()) return null;
        const content = stat.size <= BACKUP_MAX_BYTES ? readFileSync(path, "utf8") : "";
        return { sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs, content };
      },
      now: () => Date.now(),
      fileExists: existsSync,
      readFile: (path) => readFileSync(path, "utf8"),
      // The log holds row ids and previous embeddings — owner-only where the OS enforces it.
      writeFile: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
      print: (event) => console.log(JSON.stringify(event)),
    });
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
} catch (error) {
  // Start-up failed (a module or the Prisma client). Name only, never the message.
  console.log(JSON.stringify({ event: "memory_backfill_failed", stage: "startup", errorName: error instanceof Error ? error.name : typeof error }));
  exitCode = 70;
}
process.exit(exitCode);
