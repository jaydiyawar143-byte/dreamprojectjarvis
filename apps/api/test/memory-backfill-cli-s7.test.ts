// S7 Step 8 — guards of the memory vector backfill command.
//
// The command must never change a database by accident: it is a dry run
// unless --execute is given WITH the exact counts the operator expects, a new
// rollback log, and a confirmed target that matches an explicitly supplied
// DATABASE_URL. These tests drive the command with stand-in dependencies, so
// they need no database, no network and no files.
import { describe, it, expect } from "vitest";
import {
  BACKFILL_MODEL,
  checkExecutionGate,
  checkReembedPreflight,
  parseBackfillArgs,
  resolveBackfillTarget,
  runMemoryBackfill,
  type BackfillDeps,
  type RollbackLog,
} from "../scripts/s7-memory-backfill/backfill-cli.js";

const URL_ = "postgresql://jarvis:not-a-real-password@127.0.0.1:5433/jarvis?schema=public";
const TARGET = "127.0.0.1:5433/jarvis";

// ---------------------------------------------------------------------------
// Pure guards
// ---------------------------------------------------------------------------

describe("S7 backfill command — argument and target guards", () => {
  it("is a dry run by default", () => {
    expect(parseBackfillArgs([`--confirm-target=${TARGET}`])).toMatchObject({ ok: true, args: { mode: "dry-run" } });
  });

  it.each([
    [["--execute", "--expect-reembed=1", "--rollback-log=x.json"], "--expect-cast"],
    [["--execute", "--expect-cast=20", "--rollback-log=x.json"], "--expect-reembed"],
    [["--execute", "--expect-cast=20", "--expect-reembed=1"], "--rollback-log"],
    [["--execute", "--expect-cast=twenty", "--expect-reembed=1", "--rollback-log=x.json"], "--expect-cast"],
    [["--execute", "--rollback=x.json", "--expect-cast=1", "--expect-reembed=0", "--rollback-log=y.json"], "--rollback"],
    [["--batch-size=0"], "--batch-size"],
    [["--surprise"], "--surprise"],
  ])("refuses %j", (argv, mentions) => {
    const parsed = parseBackfillArgs([`--confirm-target=${TARGET}`, ...argv]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toContain(mentions);
  });

  it("requires an explicit DATABASE_URL and a matching --confirm-target", () => {
    expect(resolveBackfillTarget(undefined, TARGET)).toMatchObject({ ok: false });
    expect(resolveBackfillTarget(URL_, undefined)).toMatchObject({ ok: false });
    expect(resolveBackfillTarget(URL_, "127.0.0.1:5432/jarvis")).toMatchObject({ ok: false });
    const ok = resolveBackfillTarget(URL_, TARGET);
    expect(ok).toEqual({ ok: true, target: TARGET });
    expect(JSON.stringify(ok)).not.toContain("not-a-real-password");
  });

  it("executes only when the fresh plan matches the expected counts exactly", () => {
    expect(checkExecutionGate({ cast: 20, reembed: 1 }, { cast: 20, reembed: 1 })).toEqual({ ok: true });
    const off = checkExecutionGate({ cast: 21, reembed: 1 }, { cast: 20, reembed: 1 });
    expect(off.ok).toBe(false);
    expect(off.ok ? "" : off.error).toContain("21");
  });

  it("re-embedding requires the key and the same embedding model extraction used", () => {
    expect(checkReembedPreflight({}, 0)).toEqual({ ok: true });
    expect(checkReembedPreflight({}, 1).ok).toBe(false);
    expect(checkReembedPreflight({ OPENAI_API_KEY: "x", OPENAI_EMBEDDING_MODEL: "text-embedding-3-large" }, 1).ok).toBe(false);
    expect(checkReembedPreflight({ OPENAI_API_KEY: "x" }, 1)).toEqual({ ok: true });
    expect(checkReembedPreflight({ OPENAI_API_KEY: "x", OPENAI_EMBEDDING_MODEL: BACKFILL_MODEL }, 1)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Runner with stand-in dependencies
// ---------------------------------------------------------------------------

function harness(plan: { cast: string[]; reembed: string[] }) {
  const calls = { cast: [] as string[][], reembed: [] as string[][], rollbackCast: [] as string[][], rollbackReembed: 0, providers: 0 };
  const files = new Map<string, string>();
  const printed: Array<Record<string, unknown>> = [];
  let planCalls = 0;
  const deps: BackfillDeps = {
    prisma: {} as never,
    async plan() {
      planCalls++;
      const done = planCalls > 1 && calls.cast.length > 0;
      return {
        totalRows: 24,
        castCandidateIds: done ? [] : plan.cast,
        reembedCandidateIds: done ? [] : plan.reembed,
        noEmbeddingIds: ["n1", "n2", "n3"],
        alreadyVectorized: done ? plan.cast.length + plan.reembed.length : 0,
        invalidMetadataEmbedding: 0,
        expiredMetadataOnly: 0,
      };
    },
    async applyCastBatch(_p, ids) {
      calls.cast.push(ids);
      return { requested: ids.length, castIds: ids, skippedIds: [] };
    },
    async reembed(_p, _provider, ids) {
      calls.reembed.push(ids);
      return ids.map((id) => ({ id, status: "reembedded" as const, previousMetadataEmbedding: [0.1], appliedVectorHash: "h" }));
    },
    async rollbackCast(_p, ids) {
      calls.rollbackCast.push(ids);
      return ids.length;
    },
    async rollbackReembed(_p, entries) {
      calls.rollbackReembed += entries.length;
      return entries.length;
    },
    createEmbeddingProvider() {
      calls.providers++;
      return {} as never;
    },
    fileExists: (path) => files.has(path),
    readFile: (path) => files.get(path)!,
    writeFile: (path, content) => void files.set(path, content),
    print: (event) => void printed.push(event),
  };
  return { deps, calls, files, printed };
}

const env = { DATABASE_URL: URL_, OPENAI_API_KEY: "x" };
const cast20 = Array.from({ length: 20 }, (_, i) => `c${i + 1}`);

describe("S7 backfill command — runner", () => {
  it("a dry run reports counts and writes nothing", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const code = await runMemoryBackfill([`--confirm-target=${TARGET}`], env.DATABASE_URL, env, h.deps);

    expect(code).toBe(0);
    expect(h.calls.cast).toHaveLength(0);
    expect(h.calls.reembed).toHaveLength(0);
    expect(h.calls.providers).toBe(0);
    expect(h.files.size).toBe(0);
    expect(h.printed[0]).toMatchObject({ event: "memory_backfill_plan", mode: "dry-run", cast: 20, reembed: 1, noEmbedding: 3 });
    expect(JSON.stringify(h.printed)).not.toContain("c1"); // ids stay out of the console
  });

  it("refuses to execute when the plan does not match the expected counts", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const code = await runMemoryBackfill(
      [`--confirm-target=${TARGET}`, "--execute", "--expect-cast=19", "--expect-reembed=1", "--rollback-log=log.json"],
      env.DATABASE_URL,
      env,
      h.deps
    );
    expect(code).not.toBe(0);
    expect(h.calls.cast).toHaveLength(0);
    expect(h.files.size).toBe(0);
  });

  it("refuses an existing rollback log rather than overwrite it", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    h.files.set("log.json", "{}");
    const code = await runMemoryBackfill(
      [`--confirm-target=${TARGET}`, "--execute", "--expect-cast=20", "--expect-reembed=1", "--rollback-log=log.json"],
      env.DATABASE_URL,
      env,
      h.deps
    );
    expect(code).not.toBe(0);
    expect(h.calls.cast).toHaveLength(0);
  });

  it("refuses to run at all without an explicitly supplied DATABASE_URL", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const code = await runMemoryBackfill([`--confirm-target=${TARGET}`], undefined, env, h.deps);
    expect(code).not.toBe(0);
    expect(h.printed.some((e) => e.event === "memory_backfill_plan")).toBe(false);
  });

  it("executes in batches, logs every batch for rollback, then verifies", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const code = await runMemoryBackfill(
      [`--confirm-target=${TARGET}`, "--execute", "--expect-cast=20", "--expect-reembed=1", "--rollback-log=log.json", "--batch-size=8"],
      env.DATABASE_URL,
      env,
      h.deps
    );

    expect(code).toBe(0);
    expect(h.calls.cast.map((b) => b.length)).toEqual([8, 8, 4]);
    expect(h.calls.reembed).toEqual([["s1"]]);
    const log = JSON.parse(h.files.get("log.json")!) as RollbackLog;
    expect(log.target).toBe(TARGET);
    expect(log.castBatches.flatMap((b) => b.ids)).toEqual(cast20);
    expect(log.reembedded.map((r) => r.id)).toEqual(["s1"]);
    expect(h.printed.at(-1)).toMatchObject({ event: "memory_backfill_postflight", castRemaining: 0, reembedRemaining: 0, ok: true });
  });

  it("rolls back exactly what a log recorded, for the same confirmed target only", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const log: RollbackLog = {
      version: 1,
      target: TARGET,
      createdAt: new Date().toISOString(),
      castBatches: [{ batch: 1, ids: ["c1", "c2"] }],
      reembedded: [{ id: "s1", status: "reembedded", previousMetadataEmbedding: [0.1], appliedVectorHash: "h" }],
    };
    h.files.set("log.json", JSON.stringify(log));

    const wrong = await runMemoryBackfill(["--confirm-target=127.0.0.1:5436/other", "--rollback=log.json"], "postgresql://u:p@127.0.0.1:5436/other", env, h.deps);
    expect(wrong).not.toBe(0);
    expect(h.calls.rollbackCast).toHaveLength(0);

    const code = await runMemoryBackfill([`--confirm-target=${TARGET}`, "--rollback=log.json"], env.DATABASE_URL, env, h.deps);
    expect(code).toBe(0);
    expect(h.calls.rollbackCast).toEqual([["c1", "c2"]]);
    expect(h.calls.rollbackReembed).toBe(1);
  });
});
