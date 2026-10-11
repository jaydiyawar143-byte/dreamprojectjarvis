// Phase 14 — the memory quality evaluation, run in CI.
//
// The dataset (test/eval/dataset.ts) goes through the PRODUCTION extraction
// service and the REAL repository on PostgreSQL + pgvector, with deterministic
// embeddings and an eager stand-in model (test/eval/harness.ts). No network,
// no model provider, no real data.
//
// The numbers below are FLOORS, not targets: a change that makes memory worse
// fails here, and the report printed at the end says by how much and where.
// Two cases in the dataset are known gaps (a convention stated as "we"), which
// is why extraction recall is asserted below 1.0 — they are listed in the
// report every run rather than removed from the dataset.
//
// Run it with:  pnpm --filter @jarvis/memory eval      (needs DATABASE_URL)
// Save it with: MEMORY_EVAL_REPORT=/path/report.json pnpm --filter @jarvis/memory eval
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { DETERMINISTIC_FLOOR, deterministicEmbeddings, formatReport, runMemoryEvaluation, type EvalEnvironment, type EvaluationReport } from "./eval/harness.js";
import { EXTRACTION_CASES, RETRIEVAL_CASES } from "./eval/dataset.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

type Db = typeof import("@jarvis/db");
let db: Db | null = null;
let prisma: InstanceType<Db["PrismaClient"]> | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  prisma = new db.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = Date.now();
const userIds: string[] = [];

function environment(): EvalEnvironment {
  const conversations = new db!.PrismaConversationRepository(prisma!);
  const projects = new db!.PrismaProjectRepository(prisma!);
  // The same store, in the same fail-closed mode, the container uses.
  const control = new db!.PrismaPreferenceRepository(prisma!, "prefs:memory", "unreadable");
  let trace = 0;
  return {
    store: new db!.PrismaMemoryRepository(prisma!),
    embeddings: deterministicEmbeddings,
    floor: DETERMINISTIC_FLOOR,
    async newUser(tag) {
      const user = await prisma!.user.create({
        data: { email: `p14-eval-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `P14 eval ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
      });
      userIds.push(user.id);
      return user.id;
    },
    newProject: async (userId, name) => (await projects.create(userId, { name })).id,
    async saveMessage(userId, text, projectId) {
      const conversation = await conversations.create({ userId, ...(projectId ? { projectId } : {}) });
      const traceId = `00000000-0000-4000-8000-${String(++trace).padStart(12, "0")}`;
      const message = await conversations.addMessage({ conversationId: conversation.id, role: "user", content: text, metadata: { traceId } });
      return { conversationId: conversation.id, messageId: message.id, traceId };
    },
    control: {
      get: (userId) => control.get(userId),
      put: (userId, value) => control.put(userId, value),
      async corrupt(userId) {
        await prisma!.userSetting.update({ where: { userId_key: { userId, key: "prefs:memory" } }, data: { value: "{{{ not json" } });
      },
    },
  };
}

let report: EvaluationReport;

beforeAll(async () => {
  if (!dbUp) return;
  // The service logs one content-free event per decision; hundreds of them
  // would bury the report.
  const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    report = await runMemoryEvaluation(environment());
  } finally {
    quiet.mockRestore();
  }
  // Written straight to stdout: the test runner shows a passing test's console
  // output only on failure, and this report is the point of a passing run.
  process.stdout.write(`\n${formatReport(report)}\n\n`);
  if (process.env.MEMORY_EVAL_REPORT) writeFileSync(process.env.MEMORY_EVAL_REPORT, JSON.stringify(report, null, 2));
}, 120_000);

afterAll(async () => {
  if (dbUp && userIds.length > 0) {
    await prisma!.message.deleteMany({ where: { conversation: { userId: { in: userIds } } } });
    await prisma!.conversation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.userSetting.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma?.$disconnect();
});

describe.skipIf(!dbUp)("Phase 14 — memory quality evaluation (PostgreSQL, deterministic)", () => {
  it("covers every category the specification names, A to M", () => {
    const categories = new Set<string>([...EXTRACTION_CASES.map((c) => c.category), ...RETRIEVAL_CASES.map((c) => c.category)]);
    for (const letter of "ABCDEFGHIJKLM") expect(categories.has(letter), `category ${letter}`).toBe(true);
    expect(report.dataset.extractionCases).toBe(EXTRACTION_CASES.length);
    expect(report.dataset.retrievalCases).toBe(RETRIEVAL_CASES.length);
  });

  it("stores nothing it should not: extraction precision is 1.0", () => {
    expect(report.extraction.filter((r) => r.stored && r.expected === "REJECT").map((r) => r.id)).toEqual([]);
    expect(report.metrics.extractionPrecision).toBe(1);
  });

  it("never stores a forbidden memory: a secret, JARVIS's own words, a vetoed statement, a grant of authority", () => {
    expect(report.extraction.filter((r) => r.forbidden).length).toBeGreaterThanOrEqual(9);
    expect(report.metrics.forbiddenMemoryRate).toBe(0);
  });

  it("stores what it should, except the known gaps: extraction recall is at least 0.80", () => {
    const missed = report.extraction.filter((r) => r.expected === "STORE" && !r.stored);
    // Every miss is one the dataset already declares. A new miss is a regression.
    expect(missed.filter((r) => !r.knownGap).map((r) => r.id)).toEqual([]);
    expect(report.metrics.extractionRecall).toBeGreaterThanOrEqual(0.8);
  });

  it("recalls what is relevant and nothing that is not: retrieval relevance is 1.0", () => {
    expect(report.retrieval.filter((r) => !r.passed).map((r) => `${r.id} got [${r.got.join(", ")}]`)).toEqual([]);
    expect(report.metrics.retrievalRelevanceRate).toBe(1);
  });

  it("obeys the user's controls every time: control compliance is 1.0", () => {
    expect(report.controls.filter((c) => !c.passed).map((c) => c.id)).toEqual([]);
    expect(report.controls.length).toBeGreaterThanOrEqual(6);
    expect(report.metrics.controlComplianceRate).toBe(1);
  });

  it("corrects a wrong memory, and only as allowed: correction pass rate is 1.0", () => {
    expect(report.corrections.filter((c) => !c.passed).map((c) => `${c.id}${c.detail ? ` (${c.detail})` : ""}`)).toEqual([]);
    expect(report.corrections.length).toBeGreaterThanOrEqual(14);
    expect(report.metrics.correctionPassRate).toBe(1);
  });

  it("keeps a project's memory in its project: project isolation is 1.0", () => {
    expect(report.isolation.filter((c) => !c.passed).map((c) => c.id)).toEqual([]);
    expect(report.isolation.length).toBeGreaterThanOrEqual(10);
    expect(report.metrics.projectIsolationPassRate).toBe(1);
  });

  it("takes confidence from evidence, never from the model: confidence compliance is 1.0", () => {
    expect(report.confidence.filter((c) => !c.passed).map((c) => c.id)).toEqual([]);
    expect(report.metrics.confidenceComplianceRate).toBe(1);
  });

  describe("the shipped relevance weights are the ones the dataset supports", () => {
    it("rank every case correctly", () => {
      expect(report.weights.shipped!.failed).toEqual([]);
      expect(report.weights.shipped!.top1).toBe(1);
    });

    it("cosine alone cannot order memories that are equally similar — it gets those cases wrong", () => {
      expect(report.weights.cosineOnly!.top1).toBeLessThan(report.weights.shipped!.top1);
      expect(report.weights.cosineOnly!.failed.sort()).toEqual(["R2", "R3", "R4"]);
    });

    it("each secondary signal earns its place: without it, the case that depends on it fails", () => {
      expect(report.weights.withoutRecency!.failed).toEqual(["R2"]);
      expect(report.weights.withoutConfidence!.failed).toEqual(["R3"]);
      expect(report.weights.withoutImportance!.failed).toEqual(["R4"]);
    });

    it("more weight on the secondary signals lets a barely related memory outrank a relevant one", () => {
      expect(report.weights.secondaryHeavy!.failed).toEqual(["R1"]);
    });
  });
});
