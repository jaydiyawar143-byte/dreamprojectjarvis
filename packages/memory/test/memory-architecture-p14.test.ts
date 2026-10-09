// Phase 14 — the memory architecture, pinned by reading the source.
//
// Phase 14 added a memory API, a memory screen, projects, a correction flow
// and a retention sweep. None of them may become a second way of writing or
// deleting memory. These scans fail the moment one does:
//
//   ONE WRITER      only MemoryExtractionService creates or changes a memory
//   ONE DELETER     only MemoryManagementService deletes one — and it is
//                   reached only through the memory tools
//   ONE STORE       the repository is constructed once, at the composition root
//   NO SHORTCUTS    no route touches the store, the database or a delete; the
//                   retention sweep and its scheduler delete nothing themselves
//   ONE MANAGER     there is no second memory manager, writer or store class
//
// Comments are stripped before scanning, so a file may DESCRIBE a rule it
// keeps without tripping it.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function code(path: string): string {
  return readFileSync(join(ROOT, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// Every production source file: the `src` folder of each app and each package.
function sources(): string[] {
  const files: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const pkg of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, pkg, "src");
      if (!existsSync(src)) continue;
      for (const entry of readdirSync(src, { recursive: true }) as string[]) {
        if (!/\.(?:ts|tsx|mts)$/.test(entry) || entry.endsWith(".d.ts")) continue;
        const file = join(src, entry);
        if (statSync(file).isFile()) files.push(relative(ROOT, file).split(sep).join("/"));
      }
    }
  }
  return files;
}

const ALL = sources();
const matching = (pattern: RegExp, among: string[] = ALL) => among.filter((path) => pattern.test(code(path))).sort();

const WRITER = "packages/memory/src/memory-extraction-service.ts";
const MANAGER = "packages/memory/src/memory-management-service.ts";
const REPOSITORY = "packages/db/src/repositories/memory-repository.ts";
/** Pre-dates S7 and is constructed nowhere in production (asserted below). */
const UNUSED_ENGINE = "packages/memory/src/memory-engine.ts";

describe("Phase 14 — one memory writer", () => {
  it("only MemoryExtractionService asks a memory store to create or change a memory", () => {
    const writes = matching(/\b(?:store|memoryStore|memoryRepository|deps\.store)\s*\.\s*(?:store|storeWithEmbedding|update)\s*\(/).filter((path) => path !== UNUSED_ENGINE);
    expect(writes).toEqual([WRITER]);
  });

  it("the repository's own write methods are called from nowhere but the store interface", () => {
    // No file reaches into Prisma's memory table except the repository (and
    // the operator-run vector backfill, which only fills a missing vector).
    const direct = matching(/\.memory\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(direct).toEqual([REPOSITORY]);
    const raw = matching(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"Memory"/i);
    expect(raw).toEqual(["packages/db/src/maintenance/memory-vector-backfill.ts", REPOSITORY]);
    expect(code("packages/db/src/maintenance/memory-vector-backfill.ts")).not.toMatch(/DELETE\s+FROM\s+"Memory"|INSERT\s+INTO\s+"Memory"/i);
  });

  it("the old MemoryEngine is constructed nowhere in production", () => {
    expect(matching(/new\s+MemoryEngine\s*\(/)).toEqual([]);
  });

  it("the writer is built once, at the composition root", () => {
    expect(matching(/new\s+MemoryExtractionService\s*\(/)).toEqual(["apps/api/src/services/container.ts"]);
  });

  it("the writer calls no model while correcting: correct() and checkCorrection() never reach the AI provider", () => {
    const source = code(WRITER);
    const correction = source.slice(source.indexOf("checkCorrection(input"), source.indexOf("private emptyResult"));
    expect(correction.length).toBeGreaterThan(500);
    expect(correction).not.toMatch(/aiProvider|extractFromLLM|\.complete\s*\(/);
  });
});

describe("Phase 14 — one way to delete a memory", () => {
  it("only MemoryManagementService asks a memory store to delete", () => {
    const deletes = matching(/\b(?:store|memoryStore|memoryRepository|deps\.store)\s*\.\s*(?:delete|deleteAll)\s*\(/).filter((path) => path !== UNUSED_ENGINE);
    expect(deletes).toEqual([MANAGER]);
  });

  it("its deleting methods are called only by the memory tools' port", () => {
    const callers = matching(/\bmemoryManagement\s*\.\s*(?:forget|forgetAll|purgeExpired)\s*\(/);
    expect(callers).toEqual(["apps/api/src/services/memory-tool-port.ts"]);
  });

  it("the retention sweep and its scheduler delete nothing and read no memory: they call ports", () => {
    for (const path of ["packages/memory/src/memory-retention-sweep.ts", "apps/api/src/services/memory-retention-scheduler.ts"]) {
      const source = code(path);
      expect(source, path).not.toMatch(/prisma|Prisma|\.delete\s*\(|\.deleteMany\s*\(|\.deleteAll\s*\(|IMemoryStore|\.list\s*\(/);
    }
  });

  it("the purge can only reach rows past the retention cutoff: it checks each row again before deleting", () => {
    const source = code(MANAGER);
    const purge = source.slice(source.indexOf("async purgeExpired"), source.indexOf("async recordCorrection"));
    expect(purge).toMatch(/expiredBefore:\s*cutoff/);
    expect(purge).toMatch(/isPurgeable\(m\.expiresAt,\s*cutoff\)/);
    expect(purge).toMatch(/limit:\s*MEMORY_RETENTION\.sweepBatch/);
    expect(purge).toMatch(/store\.delete\(\{\s*userId,\s*memoryIds:\s*ids\s*\}\)/);
    expect(purge).not.toMatch(/deleteAll|olderThan/);
  });
});

describe("Phase 14 — one store, and no second manager", () => {
  it("the memory repository is constructed once, at the composition root", () => {
    expect(matching(/new\s+PrismaMemoryRepository\s*\(/)).toEqual(["apps/api/src/services/container.ts"]);
  });

  it("the management service is constructed once", () => {
    expect(matching(/new\s+MemoryManagementService\s*\(/)).toEqual(["apps/api/src/services/container.ts"]);
  });

  it("no new class manages, writes or stores memory", () => {
    const classes = ALL.flatMap((path) => [...code(path).matchAll(/\bclass\s+(\w*Memor\w*)\b/g)].map((m) => `${path}: ${m[1]}`)).sort();
    expect(classes).toEqual([
      "packages/db/src/repositories/memory-repository.ts: PrismaMemoryRepository",
      "packages/memory/src/memory-engine.ts: MemoryEngine",
      "packages/memory/src/memory-extraction-service.ts: MemoryExtractionService",
      "packages/memory/src/memory-management-service.ts: MemoryManagementService",
      "packages/memory/src/memory-retention-sweep.ts: MemoryRetentionSweep",
      "packages/tools/src/execution-journal.ts: MemoryApprovalConsumer",
      "packages/tools/src/execution-journal.ts: MemoryExecutionJournal",
      "packages/tools/src/tools/memory-tools.ts: MemoryCorrectTool",
      "packages/tools/src/tools/memory-tools.ts: MemoryDeleteTool",
      "packages/tools/src/tools/memory-tools.ts: MemoryForgetAllTool",
      "packages/tools/src/tools/memory-tools.ts: MemoryForgetTool",
      "packages/tools/src/tools/memory-tools.ts: MemoryListTool",
      "packages/tools/src/tools/memory-tools.ts: MemoryPurgeExpiredTool",
    ]);
  });
});

describe("Phase 14 — the routes hold no shortcut", () => {
  const ROUTES = ["apps/api/src/routes/memory.ts", "apps/api/src/routes/projects.ts", "apps/api/src/routes/memory-commands.ts"];

  it.each(ROUTES)("%s touches no database, no store and no delete", (path) => {
    const source = code(path);
    expect(source).not.toMatch(/@jarvis\/db|@prisma\/client|\bprisma\b|PrismaClient/);
    expect(source).not.toMatch(/IMemoryStore|PrismaMemoryRepository|memoryStore|memoryRepository/);
    expect(source).not.toMatch(/\.forget\s*\(|\.forgetAll\s*\(|\.purgeExpired\s*\(|\.delete\s*\(|\.deleteAll\s*\(|\.deleteMany\s*\(/);
    expect(source).not.toMatch(/\.correct\s*\(|\.update\s*\(|\.store\s*\(/);
    // A route never runs a tool for a memory change itself: confirming does.
    expect(source).not.toMatch(/executor\s*\.\s*execute|ToolExecutor/);
  });

  it("the memory router declares only reads and requests", () => {
    const source = code("apps/api/src/routes/memory.ts");
    expect(source).not.toMatch(/router\s*\.\s*(?:delete|put|patch)\s*\(/);
    const declared = [...source.matchAll(/router\s*\.\s*(get|post)\s*\(\s*(?:"([^"]+)"|`([^`]+)`)/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2] ?? m[3]}`).sort();
    expect(declared).toEqual(["GET /", "GET /:id", "GET /status", "POST /:id/correction", "POST /:id/forget", "POST /learning/${action}"]);
  });

  it("a memory change is only ever PROPOSED by a route: as memory.forget or memory.correct, with ids", () => {
    const source = code("apps/api/src/routes/memory-commands.ts");
    // Every pending action created here names one of three tools. (`pending.toolId`
    // only echoes an action that already exists back to the client.)
    const proposals = [...source.matchAll(/toolId:\s*([A-Za-z_.]+)/g)].map((m) => m[1]).filter((id) => id !== "pending.toolId").sort();
    expect(proposals).toEqual(["MEMORY_CORRECT_TOOL_ID", "MEMORY_TOOL_IDS.forget", "MEMORY_TOOL_IDS.forget", "MEMORY_TOOL_IDS.forgetAll"]);
    // The parameters of a correction are three ids and a version — never the words.
    expect(source).toMatch(/params:\s*\{\s*memoryId:\s*input\.memory\.id,\s*version:\s*input\.memory\.changedAt,\s*sourceMessageId:\s*input\.sourceMessageId\s*\}/);
  });
});

describe("Phase 14 — the orchestrator and the agents cannot write memory", () => {
  it("the orchestrator is typed against the read-only memory port", () => {
    const types = code("packages/core/src/types/orchestrator.ts");
    expect(types).toMatch(/memoryStore\?:\s*MemoryRecallPort/);
    expect(types).not.toMatch(/memoryStore\?:\s*IMemoryStore/);
    expect(code("packages/core/src/types/memory.ts")).toMatch(/export type MemoryRecallPort = Pick<IMemoryStore, "isAvailable" \| "recall" \| "list">/);
  });

  it("the agent context carries no memory store", () => {
    const agent = code("packages/core/src/types/agent.ts");
    const context = agent.slice(agent.indexOf("export interface AgentContext"), agent.indexOf("export interface IAgent"));
    expect(context).not.toMatch(/memory|Memory/);
  });

  it("no agent, and nothing in the agents package, names a memory write", () => {
    const agents = ALL.filter((path) => path.startsWith("packages/agents/src/"));
    expect(matching(/memoryManager|IMemoryStore|\bMemoryManagementService\b|\bMemoryExtractionService\b/, agents)).toEqual([]);
  });
});
