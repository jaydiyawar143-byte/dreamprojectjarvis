// ---------------------------------------------------------------------------
// S7 Step 8 — memory vector backfill: entry point.
//
//   DATABASE_URL=<target> npx tsx scripts/s7-memory-backfill/run.ts \
//     --confirm-target=<host>:<port>/<database>            # dry run
//
//   ... --execute --expect-cast=<n> --expect-reembed=<n> --rollback-log=<new file>
//   ... --rollback=<rollback log>
//
// Run from apps/api. See backfill-cli.ts for every guard. DATABASE_URL is read
// HERE, before anything imports the Prisma client — which would otherwise load
// packages/db/.env and silently point at the development database.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { runMemoryBackfill } from "./backfill-cli.js";

const explicitDatabaseUrl = process.env.DATABASE_URL;

const db = await import("@jarvis/db");
const { OpenAIEmbeddingProvider } = await import("@jarvis/ai-openai");

const prisma = new db.PrismaClient();
let exitCode = 1;
try {
  exitCode = await runMemoryBackfill(process.argv.slice(2), explicitDatabaseUrl, process.env, {
    prisma,
    plan: (p) => db.planMemoryVectorBackfill(p),
    applyCastBatch: db.applyMemoryVectorCastBatch,
    reembed: db.reembedMemoryVectors,
    rollbackCast: db.rollbackMemoryVectorCastBatch,
    rollbackReembed: db.rollbackMemoryVectorReembed,
    createEmbeddingProvider: (model) => new OpenAIEmbeddingProvider({ model }),
    fileExists: existsSync,
    readFile: (path) => readFileSync(path, "utf8"),
    // The log holds row ids and one previous embedding — owner-only.
    writeFile: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
    print: (event) => console.log(JSON.stringify(event)),
  });
} finally {
  await prisma.$disconnect();
}
process.exit(exitCode);
