// S7 Step 8 / Step 9B — guards of the memory vector backfill command.
//
// The command must never change a database by accident: it is a dry run
// unless --execute is given WITH the exact counts the operator expects, a new
// rollback log, a verified backup, proof that the live API runs the S7 memory
// code, and a confirmed target that matches an explicitly supplied
// DATABASE_URL. These tests drive the command with stand-in dependencies, so
// they need no database, no network, no Docker and no files.
import { describe, it, expect } from "vitest";
import {
  BACKFILL_MODEL,
  BACKUP_MAX_AGE_MINUTES,
  S7_MEMORY_CODE_SIGNATURES,
  checkBackupFile,
  checkExecutionGate,
  checkLiveApi,
  checkReembedPreflight,
  parseBackfillArgs,
  resolveBackfillTarget,
  runMemoryBackfill,
  type BackfillDeps,
  type BackupFileInfo,
  type LiveApiInspection,
  type RollbackLog,
} from "../scripts/s7-memory-backfill/backfill-cli.js";
import { inspectLiveApiContainer } from "../scripts/s7-memory-backfill/live-api.js";

const URL_ = "postgresql://jarvis:not-a-real-password@127.0.0.1:5433/jarvis?schema=public";
const TARGET = "127.0.0.1:5433/jarvis";
const NOW = Date.parse("2026-09-28T10:00:00Z");
const HASH = "0123456789abcdef0123456789abcdef";

/** A plain-format pg_dump of the Memory table, shaped like PostgreSQL 16's. */
function dumpText(rows: number, opts: { complete?: boolean; table?: string; terminated?: boolean } = {}) {
  const { complete = true, table = 'public."Memory"', terminated = true } = opts;
  const lines = [
    "--",
    "-- PostgreSQL database dump",
    "--",
    "",
    "\\restrict s7testkey",
    "",
    "-- Dumped from database version 16.10",
    "-- Dumped by pg_dump version 16.10",
    "",
    `COPY ${table} (id, "userId", type, content) FROM stdin;`,
  ];
  for (let i = 0; i < rows; i++) lines.push(`m${i}\tu1\tFACT\tsynthetic memory text ${i}`);
  if (terminated) lines.push("\\.", "");
  if (complete) lines.push("", "\\unrestrict s7testkey", "", "--", "-- PostgreSQL database dump complete", "--", "");
  return lines.join("\n");
}

const freshBackup = (rows = 24, content = dumpText(rows)): BackupFileInfo => ({
  sizeBytes: content.length,
  modifiedAtMs: NOW - 5 * 60_000,
  content,
});

const liveS7: LiveApiInspection = {
  running: true,
  signatures: S7_MEMORY_CODE_SIGNATURES.map((s) => ({ id: s.id, status: "present" as const })),
};

const EXEC_ARGS = [
  `--confirm-target=${TARGET}`,
  "--execute",
  "--expect-cast=20",
  "--expect-reembed=1",
  "--rollback-log=log.json",
  "--backup-file=backup.sql",
  "--live-api-container=jarvis-docker-api",
];

// ---------------------------------------------------------------------------
// Pure guards
// ---------------------------------------------------------------------------

describe("S7 backfill command — argument and target guards", () => {
  it("is a dry run by default", () => {
    expect(parseBackfillArgs([`--confirm-target=${TARGET}`])).toMatchObject({ ok: true, args: { mode: "dry-run" } });
  });

  it("accepts a complete execute request", () => {
    expect(parseBackfillArgs(EXEC_ARGS)).toMatchObject({
      ok: true,
      args: { mode: "execute", expectCast: 20, expectReembed: 1, backupFile: "backup.sql", liveApiContainer: "jarvis-docker-api" },
    });
  });

  it.each([
    [["--execute", "--expect-reembed=1", "--rollback-log=x.json", "--backup-file=b.sql", "--live-api-container=api"], "--expect-cast"],
    [["--execute", "--expect-cast=20", "--rollback-log=x.json", "--backup-file=b.sql", "--live-api-container=api"], "--expect-reembed"],
    [["--execute", "--expect-cast=20", "--expect-reembed=1", "--backup-file=b.sql", "--live-api-container=api"], "--rollback-log"],
    [["--execute", "--expect-cast=20", "--expect-reembed=1", "--rollback-log=x.json", "--live-api-container=api"], "--backup-file"],
    [["--execute", "--expect-cast=20", "--expect-reembed=1", "--rollback-log=x.json", "--backup-file=b.sql"], "--live-api-container"],
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

interface HarnessOptions {
  live?: LiveApiInspection | Error;
  backup?: BackupFileInfo | null;
  totalRows?: number;
  mismatch?: number;
  failPlan?: Error;
  failCastAtBatch?: number;
  failRollback?: Error;
  castConflicts?: number;
}

function harness(plan: { cast: string[]; reembed: string[] }, opts: HarnessOptions = {}) {
  const calls = {
    plan: 0,
    cast: [] as string[][],
    reembed: [] as string[][],
    rollbackCast: [] as Array<Array<{ id: string; appliedVectorHash: string }>>,
    rollbackReembed: 0,
    providers: 0,
    inspect: [] as string[],
    backupReads: [] as string[],
  };
  const files = new Map<string, string>();
  const printed: Array<Record<string, unknown>> = [];
  const deps: BackfillDeps = {
    prisma: {} as never,
    async plan() {
      calls.plan++;
      if (opts.failPlan) throw opts.failPlan;
      const done = calls.plan > 1 && calls.cast.length > 0;
      return {
        totalRows: opts.totalRows ?? 24,
        castCandidateIds: done ? [] : plan.cast,
        reembedCandidateIds: done ? [] : plan.reembed,
        noEmbeddingIds: ["n1", "n2", "n3"],
        alreadyVectorized: done ? plan.cast.length + plan.reembed.length : 0,
        invalidMetadataEmbedding: 0,
        expiredMetadataOnly: 0,
        vectorMetadataMismatch: opts.mismatch ?? 0,
      };
    },
    async applyCastBatch(_p, ids) {
      calls.cast.push(ids);
      if (opts.failCastAtBatch === calls.cast.length) throw new Error("synthetic memory text 7 could not be cast");
      return { requested: ids.length, castIds: ids, applied: ids.map((id) => ({ id, appliedVectorHash: HASH })), skippedIds: [] };
    },
    async reembed(_p, _provider, ids) {
      calls.reembed.push(ids);
      return ids.map((id) => ({ id, status: "reembedded" as const, previousMetadataEmbedding: [0.1], appliedVectorHash: HASH }));
    },
    async rollbackCast(_p, rows) {
      calls.rollbackCast.push(rows);
      if (opts.failRollback) throw opts.failRollback;
      const conflicted = Math.min(opts.castConflicts ?? 0, rows.length);
      return { reverted: rows.length - conflicted, conflicted };
    },
    async rollbackReembed(_p, entries) {
      calls.rollbackReembed += entries.length;
      return { reverted: entries.length, conflicted: 0 };
    },
    createEmbeddingProvider() {
      calls.providers++;
      return {} as never;
    },
    async inspectLiveApi(container) {
      calls.inspect.push(container);
      if (opts.live instanceof Error) throw opts.live;
      return opts.live ?? liveS7;
    },
    readBackup(path) {
      calls.backupReads.push(path);
      return opts.backup === undefined ? freshBackup(opts.totalRows ?? 24) : opts.backup;
    },
    now: () => NOW,
    fileExists: (path) => files.has(path),
    readFile: (path) => files.get(path)!,
    writeFile: (path, content) => void files.set(path, content),
    print: (event) => void printed.push(event),
  };
  const nothingWritten = () =>
    calls.cast.length === 0 && calls.reembed.length === 0 && calls.rollbackCast.length === 0 && calls.rollbackReembed === 0 && files.size === 0;
  return { deps, calls, files, printed, nothingWritten };
}

const env = { DATABASE_URL: URL_, OPENAI_API_KEY: "x" };
const cast20 = Array.from({ length: 20 }, (_, i) => `c${i + 1}`);
const run = (h: ReturnType<typeof harness>, argv: string[], url: string = env.DATABASE_URL) =>
  runMemoryBackfill(argv, url, env, h.deps);

describe("S7 backfill command — runner", () => {
  it("a dry run reports counts and writes nothing", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const code = await run(h, [`--confirm-target=${TARGET}`]);

    expect(code).toBe(0);
    expect(h.nothingWritten()).toBe(true);
    expect(h.calls.providers).toBe(0);
    expect(h.calls.inspect).toEqual([]);
    expect(h.printed[0]).toMatchObject({ event: "memory_backfill_plan", mode: "dry-run", cast: 20, reembed: 1, noEmbedding: 3, vectorMismatch: 0 });
    expect(JSON.stringify(h.printed)).not.toContain("c1"); // ids stay out of the console
  });

  it("refuses to execute when the plan does not match the expected counts", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const code = await run(h, EXEC_ARGS.map((a) => (a === "--expect-cast=20" ? "--expect-cast=19" : a)));
    expect(code).not.toBe(0);
    expect(h.nothingWritten()).toBe(true);
  });

  it("refuses an existing rollback log rather than overwrite it", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    h.files.set("log.json", "{}");
    const code = await run(h, EXEC_ARGS);
    expect(code).not.toBe(0);
    expect(h.calls.cast).toHaveLength(0);
    expect(h.calls.plan).toBe(0);
    expect(h.files.get("log.json")).toBe("{}");
  });

  it("refuses to run at all without an explicitly supplied DATABASE_URL", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const code = await runMemoryBackfill([`--confirm-target=${TARGET}`], undefined, env, h.deps);
    expect(code).toBe(64);
    expect(h.calls.plan).toBe(0);
    expect(h.printed).toEqual([{ event: "memory_backfill_refused", reason: expect.stringContaining("DATABASE_URL") }]);
  });

  it("executes in batches, logs every row's vector hash for rollback, then verifies", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const code = await run(h, [...EXEC_ARGS, "--batch-size=8"]);

    expect(code).toBe(0);
    expect(h.calls.cast.map((b) => b.length)).toEqual([8, 8, 4]);
    expect(h.calls.reembed).toEqual([["s1"]]);
    const log = JSON.parse(h.files.get("log.json")!) as RollbackLog;
    expect(log.version).toBe(2);
    expect(log.target).toBe(TARGET);
    expect(log.castBatches.flatMap((b) => b.rows.map((r) => r.id))).toEqual(cast20);
    expect(log.castBatches.flatMap((b) => b.rows.map((r) => r.appliedVectorHash))).toEqual(cast20.map(() => HASH));
    expect(log.reembedded.map((r) => r.id)).toEqual(["s1"]);
    expect(log.consumedAt).toBeUndefined();
    expect(h.printed.at(-1)).toMatchObject({ event: "memory_backfill_postflight", castRemaining: 0, reembedRemaining: 0, vectorMismatch: 0, ok: true });
  });

  it("refuses to execute while any row's vector disagrees with its metadata embedding", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] }, { mismatch: 1 });
    const code = await run(h, EXEC_ARGS);
    expect(code).not.toBe(0);
    expect(h.nothingWritten()).toBe(true);
    expect(JSON.stringify(h.printed)).toContain("memory_backfill_refused");
  });

  it("rolls back exactly what a log recorded, for the same confirmed target only", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const log: RollbackLog = {
      version: 2,
      target: TARGET,
      createdAt: new Date(NOW).toISOString(),
      backupFile: "backup.sql",
      liveApiContainer: "jarvis-docker-api",
      castBatches: [{ batch: 1, rows: [{ id: "c1", appliedVectorHash: HASH }, { id: "c2", appliedVectorHash: HASH }] }],
      reembedded: [{ id: "s1", status: "reembedded", previousMetadataEmbedding: [0.1], appliedVectorHash: HASH }],
    };
    h.files.set("log.json", JSON.stringify(log));

    const wrong = await run(h, ["--confirm-target=127.0.0.1:5436/other", "--rollback=log.json"], "postgresql://u:p@127.0.0.1:5436/other");
    expect(wrong).not.toBe(0);
    expect(h.calls.rollbackCast).toHaveLength(0);

    const code = await run(h, [`--confirm-target=${TARGET}`, "--rollback=log.json"]);
    expect(code).toBe(0);
    expect(h.calls.rollbackCast).toEqual([[{ id: "c1", appliedVectorHash: HASH }, { id: "c2", appliedVectorHash: HASH }]]);
    expect(h.calls.rollbackReembed).toBe(1);
    expect(h.printed.at(-1)).toMatchObject({ event: "memory_backfill_rollback", castReverted: 2, castConflicted: 0, reembedReverted: 1 });
  });
});

// ---------------------------------------------------------------------------
// S7 Step 9B — safety fixes
// ---------------------------------------------------------------------------

describe("F1 — the live API must run the S7 memory code", () => {
  it("checkLiveApi passes only a running container with every S7 signature present", () => {
    expect(checkLiveApi(liveS7)).toEqual({ ok: true });

    const preS7 = { running: true, signatures: liveS7.signatures.map((s) => ({ ...s, status: "absent" as const })) };
    const refused = checkLiveApi(preS7);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error).toContain("pre-S7");

    expect(checkLiveApi({ running: false, signatures: [] }).ok).toBe(false);
    expect(checkLiveApi({ running: null, signatures: [] }).ok).toBe(false);
    const unreadable = { running: true, signatures: liveS7.signatures.map((s, i) => ({ ...s, status: i === 0 ? ("unreadable" as const) : s.status })) };
    expect(checkLiveApi(unreadable).ok).toBe(false);
    // A container that reports fewer signatures than required is not proof.
    expect(checkLiveApi({ running: true, signatures: liveS7.signatures.slice(1) }).ok).toBe(false);
  });

  it("the signatures cover the S7 write path and the S7 recall path", () => {
    const files = S7_MEMORY_CODE_SIGNATURES.map((s) => s.file);
    expect(files.some((f) => f.endsWith("packages/db/dist/repositories/memory-repository.js"))).toBe(true);
    expect(files.some((f) => f.endsWith("packages/memory/dist/memory-extraction-service.js"))).toBe(true);
    expect(files.some((f) => f.endsWith("packages/agents/dist/orchestrator.js"))).toBe(true);
  });

  it.each([
    ["a pre-S7 container", { running: true, signatures: liveS7.signatures.map((s) => ({ ...s, status: "absent" as const })) }],
    ["a stopped container", { running: false, signatures: [] }],
    ["an unverifiable container", { running: null, signatures: [] }],
    ["an inspection that fails", new Error("docker: permission denied while reading secret-ish details")],
  ])("execute refuses %s before reading or writing the database", async (_label, live) => {
    const h = harness({ cast: cast20, reembed: ["s1"] }, { live: live as LiveApiInspection | Error });
    const code = await run(h, EXEC_ARGS);

    expect(code).not.toBe(0);
    expect(h.calls.inspect).toEqual(["jarvis-docker-api"]);
    expect(h.calls.plan).toBe(0);
    expect(h.nothingWritten()).toBe(true);
    expect(JSON.stringify(h.printed)).not.toContain("secret-ish");
  });

  it("inspectLiveApiContainer reads only the running flag and grep exit codes", () => {
    const seen: string[][] = [];
    const exec = (args: string[]) => {
      seen.push(args);
      if (args[0] === "inspect") return { status: 0, stdout: "true\n" };
      const text = args[args.length - 2];
      return { status: text === "minSimilarity" ? 1 : text === "memory_recall_failed" ? 2 : 0, stdout: "" };
    };
    const result = inspectLiveApiContainer("jarvis-docker-api", S7_MEMORY_CODE_SIGNATURES, exec);

    expect(result.running).toBe(true);
    const status = Object.fromEntries(result.signatures.map((s) => [s.id, s.status]));
    expect(Object.values(status).filter((s) => s === "present").length).toBe(S7_MEMORY_CODE_SIGNATURES.length - 2);
    expect(status[S7_MEMORY_CODE_SIGNATURES.find((s) => s.text === "minSimilarity")!.id]).toBe("absent");
    expect(status[S7_MEMORY_CODE_SIGNATURES.find((s) => s.text === "memory_recall_failed")!.id]).toBe("unreadable");
    // Fixed-string, quiet grep inside the named container — never env, never a shell.
    expect(seen[0]).toEqual(["inspect", "--format", "{{.State.Running}}", "jarvis-docker-api"]);
    for (const args of seen.slice(1)) {
      expect(args.slice(0, 6)).toEqual(["exec", "jarvis-docker-api", "grep", "-q", "-F", "--"]);
    }
  });

  it("inspectLiveApiContainer reports a stopped or unreachable container without grepping", () => {
    const stopped = inspectLiveApiContainer("api", S7_MEMORY_CODE_SIGNATURES, () => ({ status: 0, stdout: "false\n" }));
    expect(stopped).toEqual({ running: false, signatures: [] });
    const missing = inspectLiveApiContainer("api", S7_MEMORY_CODE_SIGNATURES, () => ({ status: null, stdout: "" }));
    expect(missing).toEqual({ running: null, signatures: [] });
  });
});

describe("F2 — cast rollback is exact", () => {
  it("reports rows whose vector changed after the backfill as conflicts, not reversions", async () => {
    const h = harness({ cast: cast20, reembed: [] }, { castConflicts: 1 });
    const log: RollbackLog = {
      version: 2,
      target: TARGET,
      createdAt: new Date(NOW).toISOString(),
      backupFile: "backup.sql",
      liveApiContainer: "jarvis-docker-api",
      castBatches: [{ batch: 1, rows: [{ id: "c1", appliedVectorHash: HASH }, { id: "c2", appliedVectorHash: HASH }] }],
      reembedded: [],
    };
    h.files.set("log.json", JSON.stringify(log));

    const code = await run(h, [`--confirm-target=${TARGET}`, "--rollback=log.json"]);
    expect(code).toBe(0);
    expect(h.printed.at(-1)).toMatchObject({ event: "memory_backfill_rollback", castReverted: 1, castConflicted: 1 });
  });
});

describe("F4 — a rollback log can be used once", () => {
  function withLog() {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    const log: RollbackLog = {
      version: 2,
      target: TARGET,
      createdAt: new Date(NOW).toISOString(),
      backupFile: "backup.sql",
      liveApiContainer: "jarvis-docker-api",
      castBatches: [{ batch: 1, rows: [{ id: "c1", appliedVectorHash: HASH }] }],
      reembedded: [{ id: "s1", status: "reembedded", previousMetadataEmbedding: [0.1], appliedVectorHash: HASH }],
    };
    h.files.set("log.json", JSON.stringify(log));
    return h;
  }

  it("marks the log consumed after a successful rollback", async () => {
    const h = withLog();
    expect(await run(h, [`--confirm-target=${TARGET}`, "--rollback=log.json"])).toBe(0);
    const log = JSON.parse(h.files.get("log.json")!) as RollbackLog;
    expect(log.consumedAt).toBe(new Date(NOW).toISOString());
    expect(log.rollbackResult).toEqual({ castReverted: 1, castConflicted: 0, reembedReverted: 1, reembedConflicted: 0 });
  });

  it("refuses a second rollback with the same log and changes nothing", async () => {
    const h = withLog();
    await run(h, [`--confirm-target=${TARGET}`, "--rollback=log.json"]);
    const afterFirst = h.files.get("log.json");
    const callsAfterFirst = JSON.stringify(h.calls);

    const second = await run(h, [`--confirm-target=${TARGET}`, "--rollback=log.json"]);
    expect(second).not.toBe(0);
    expect(JSON.stringify(h.calls)).toBe(callsAfterFirst); // no database call at all
    expect(h.files.get("log.json")).toBe(afterFirst);
    expect(h.printed.at(-1)).toMatchObject({ event: "memory_backfill_refused" });
  });

  it("does not mark the log consumed when the rollback itself fails", async () => {
    const h = withLog();
    h.deps.rollbackCast = async () => {
      throw new Error("connection lost");
    };
    const code = await run(h, [`--confirm-target=${TARGET}`, "--rollback=log.json"]);
    expect(code).not.toBe(0);
    expect((JSON.parse(h.files.get("log.json")!) as RollbackLog).consumedAt).toBeUndefined();
  });
});

describe("F5 — a verified, fresh backup is mandatory before execution", () => {
  it("checkBackupFile accepts a complete plain dump and counts its Memory rows", () => {
    expect(checkBackupFile(freshBackup(24), NOW)).toEqual({ ok: true, rows: 24 });
    expect(checkBackupFile(freshBackup(0), NOW)).toEqual({ ok: true, rows: 0 });
  });

  it.each([
    ["a missing file", null],
    ["an empty file", { sizeBytes: 0, modifiedAtMs: NOW, content: "" }],
    ["a file that is not a pg_dump", freshBackup(24, "id,content\n1,hello\n")],
    ["an unfinished dump", freshBackup(24, dumpText(24, { complete: false }))],
    ["a dump whose Memory data never ends", freshBackup(24, dumpText(24, { terminated: false }))],
    ["a dump without the Memory table", freshBackup(24, dumpText(24, { table: 'public."User"' }))],
    ["a stale dump", { ...freshBackup(24), modifiedAtMs: NOW - (BACKUP_MAX_AGE_MINUTES + 1) * 60_000 }],
    ["a UTF-16 re-encoded dump", freshBackup(24, "��-\u0000-\u0000")],
  ])("refuses %s", (_label, info) => {
    const result = checkBackupFile(info as BackupFileInfo | null, NOW);
    expect(result.ok).toBe(false);
  });

  it("execute refuses a bad backup before reading or writing the database", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] }, { backup: freshBackup(24, dumpText(24, { complete: false })) });
    const code = await run(h, EXEC_ARGS);
    expect(code).not.toBe(0);
    expect(h.calls.backupReads).toEqual(["backup.sql"]);
    expect(h.calls.plan).toBe(0);
    expect(h.nothingWritten()).toBe(true);
  });

  it("execute refuses a backup whose row count differs from the live table", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] }, { backup: freshBackup(23) });
    const code = await run(h, EXEC_ARGS);
    expect(code).not.toBe(0);
    expect(h.nothingWritten()).toBe(true);
    expect(JSON.stringify(h.printed)).toContain("23");
  });

  it("records the verified backup in the rollback log", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] });
    expect(await run(h, EXEC_ARGS)).toBe(0);
    const log = JSON.parse(h.files.get("log.json")!) as RollbackLog;
    expect(log.backupFile).toBe("backup.sql");
    expect(log.liveApiContainer).toBe("jarvis-docker-api");
  });
});

describe("F6 — unexpected errors are reported without their message", () => {
  const SENSITIVE = "Raw query failed: content 'my bank password is hunter2' vector [0.12,0.34] postgresql://jarvis:s3cret@db/jarvis";

  it("a failing plan exits non-zero with only the stage and error name", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] }, { failPlan: new TypeError(SENSITIVE) });
    const code = await run(h, [`--confirm-target=${TARGET}`]);
    expect(code).toBe(70);
    expect(h.printed).toEqual([{ event: "memory_backfill_failed", stage: "plan", errorName: "TypeError" }]);
  });

  it("a failing cast batch keeps earlier batches in the log and hides the message", async () => {
    const h = harness({ cast: cast20, reembed: ["s1"] }, { failCastAtBatch: 2 });
    const code = await run(h, [...EXEC_ARGS, "--batch-size=8"]);
    expect(code).toBe(70);
    const log = JSON.parse(h.files.get("log.json")!) as RollbackLog;
    expect(log.castBatches.flatMap((b) => b.rows)).toHaveLength(8);
    expect(JSON.stringify(h.printed)).not.toContain("synthetic memory text");
    expect(h.printed.at(-1)).toMatchObject({ event: "memory_backfill_failed", stage: "cast", batch: 2 });
  });

  it("a failing rollback hides the message", async () => {
    const h = harness({ cast: cast20, reembed: [] }, { failRollback: new Error(SENSITIVE) });
    h.files.set(
      "log.json",
      JSON.stringify({ version: 2, target: TARGET, createdAt: "x", backupFile: "b", liveApiContainer: "a", castBatches: [{ batch: 1, rows: [{ id: "c1", appliedVectorHash: HASH }] }], reembedded: [] })
    );
    const code = await run(h, [`--confirm-target=${TARGET}`, "--rollback=log.json"]);
    expect(code).toBe(70);
    expect(JSON.stringify(h.printed)).not.toMatch(/hunter2|s3cret|0\.12/);
  });

  it("a corrupt rollback log is refused without echoing its contents", async () => {
    const h = harness({ cast: cast20, reembed: [] });
    h.files.set("log.json", '{"version":2, "castBatches": [ "c1-secret-id", 0.123456');
    const code = await run(h, [`--confirm-target=${TARGET}`, "--rollback=log.json"]);
    expect(code).not.toBe(0);
    expect(h.calls.rollbackCast).toHaveLength(0);
    expect(JSON.stringify(h.printed)).not.toMatch(/c1-secret-id|0\.123456/);
  });

  it.each([
    ["a log with a malformed hash", { castBatches: [{ batch: 1, rows: [{ id: "c1", appliedVectorHash: "nope" }] }], reembedded: [] }],
    ["an old version-1 log", { version: 1, castBatches: [{ batch: 1, ids: ["c1"] }], reembedded: [] }],
  ])("refuses %s", async (_label, patch) => {
    const h = harness({ cast: cast20, reembed: [] });
    h.files.set("log.json", JSON.stringify({ version: 2, target: TARGET, createdAt: "x", backupFile: "b", liveApiContainer: "a", ...patch }));
    const code = await run(h, [`--confirm-target=${TARGET}`, "--rollback=log.json"]);
    expect(code).not.toBe(0);
    expect(h.calls.rollbackCast).toHaveLength(0);
  });

  it("argument errors never echo argument values", () => {
    const parsed = parseBackfillArgs(["--confirm-target=postgresql://jarvis:s3cret@127.0.0.1:5433/jarvis"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).not.toContain("s3cret");
    const stray = parseBackfillArgs([`--confirm-target=${TARGET}`, "postgresql://jarvis:s3cret@127.0.0.1:5433/jarvis"]);
    expect(stray.ok ? "" : stray.error).not.toContain("s3cret");
  });
});

describe("F7 — malformed flags are refused, never read as a dry run", () => {
  const base = [`--confirm-target=${TARGET}`];
  it.each([
    ["a bare --rollback", [...base, "--rollback"]],
    ["an empty --rollback", [...base, "--rollback="]],
    ["--execute with a value", [...base, "--execute=yes"]],
    ["--execute=true alongside complete options", [...EXEC_ARGS.filter((a) => a !== "--execute"), "--execute=true"]],
    ["a malformed --confirm-target", ["--confirm-target=127.0.0.1/jarvis"]],
    ["a --confirm-target with credentials", ["--confirm-target=jarvis:pw@127.0.0.1:5433/jarvis"]],
    ["a bare --confirm-target", ["--confirm-target"]],
    ["a word count", EXEC_ARGS.map((a) => (a === "--expect-cast=20" ? "--expect-cast=twenty" : a))],
    ["a negative count", EXEC_ARGS.map((a) => (a === "--expect-cast=20" ? "--expect-cast=-1" : a))],
    ["a fractional count", EXEC_ARGS.map((a) => (a === "--expect-reembed=1" ? "--expect-reembed=1.5" : a))],
    ["an empty count", EXEC_ARGS.map((a) => (a === "--expect-reembed=1" ? "--expect-reembed=" : a))],
    ["a bare count flag", EXEC_ARGS.map((a) => (a === "--expect-cast=20" ? "--expect-cast" : a))],
    ["a repeated flag", [...EXEC_ARGS, "--expect-cast=21"]],
    ["execution options without --execute", [...base, "--expect-cast=20", "--expect-reembed=1"]],
    ["a rollback log without --execute", [...base, "--rollback-log=new.json"]],
    ["a malformed container name", EXEC_ARGS.map((a) => (a.startsWith("--live-api-container") ? "--live-api-container=api;rm -rf /" : a))],
    ["a non-numeric batch size", [...EXEC_ARGS, "--batch-size=many"]],
    ["a stray positional argument", [...base, "execute"]],
  ])("refuses %s, exits safely and touches nothing", async (_label, argv) => {
    const parsed = parseBackfillArgs(argv);
    expect(parsed.ok).toBe(false);

    const h = harness({ cast: cast20, reembed: ["s1"] });
    const code = await run(h, argv);
    expect(code).toBe(64);
    expect(h.calls.plan).toBe(0);
    expect(h.calls.inspect).toEqual([]);
    expect(h.calls.backupReads).toEqual([]);
    expect(h.nothingWritten()).toBe(true);
    expect(h.printed).toHaveLength(1);
    expect(h.printed[0]).toMatchObject({ event: "memory_backfill_refused" });
  });
});
