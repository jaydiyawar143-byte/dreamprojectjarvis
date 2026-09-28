// ---------------------------------------------------------------------------
// S7 Step 8 / Step 9B — the memory vector backfill command: guards and runner.
//
// The backfill itself lives in @jarvis/db (maintenance/memory-vector-backfill).
// This file decides WHETHER it may run, and records what it did:
//
//   - DRY RUN BY DEFAULT. Without --execute it only reports counts.
//   - STRICT ARGUMENTS. A malformed, repeated or misplaced option is refused;
//     it is never quietly read as a dry run. Refusals never echo values.
//   - EXPLICIT TARGET. DATABASE_URL must be supplied explicitly (the entry
//     point reads it before anything can load packages/db/.env), and
//     --confirm-target=<host>:<port>/<database> must match it.
//   - S7 CODE LIVE. --execute inspects the live API container and refuses
//     unless it runs the S7 memory code: pre-S7 code updates content and
//     metadata.embedding without the vector, which would leave backfilled
//     vectors stale. It also refuses while any row's vector already disagrees
//     with its metadata embedding.
//   - VERIFIED BACKUP. --execute needs a fresh, complete plain-format pg_dump
//     of the Memory table holding exactly as many rows as the table has now.
//   - EXACT EXPECTATIONS. --execute needs --expect-cast and --expect-reembed;
//     a fresh plan that differs from either refuses to run.
//   - REVERSIBLE, ONCE. --execute needs a NEW --rollback-log file, rewritten
//     after every batch with the md5 of every vector written, so --rollback
//     reverts exactly those vectors — and only while they are unchanged. A log
//     is marked consumed after a rollback and refused thereafter.
//   - NO CONTENT. The console gets counts and status only; ids go to the
//     rollback log. Unexpected errors are reported by stage and error name,
//     never by message.
//
// It imports only TYPES from @jarvis/db, so importing it never loads Prisma.
// ---------------------------------------------------------------------------

import type { IEmbeddingProvider } from "@jarvis/core";
import type {
  MemoryBackfillPlan,
  MemoryVectorCastResult,
  MemoryVectorCastRow,
  MemoryVectorReembedResult,
  MemoryVectorRollbackResult,
  PrismaClient,
} from "@jarvis/db";

/** The model extraction embeds memories with; re-embedding must match it. */
export const BACKFILL_MODEL = "text-embedding-3-small";
/** A backup older than this does not describe the table being changed. */
export const BACKUP_MAX_AGE_MINUTES = 120;
/** Larger dumps are not read into memory for verification. */
export const BACKUP_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 1000;

export type BackfillMode = "dry-run" | "execute" | "rollback";

export interface BackfillArgs {
  mode: BackfillMode;
  confirmTarget?: string;
  expectCast?: number;
  expectReembed?: number;
  rollbackLog?: string;
  rollbackFrom?: string;
  backupFile?: string;
  liveApiContainer?: string;
  batchSize: number;
}

export interface RollbackResultCounts {
  castReverted: number;
  castConflicted: number;
  reembedReverted: number;
  reembedConflicted: number;
}

export interface RollbackLog {
  version: 2;
  target: string;
  createdAt: string;
  backupFile: string;
  liveApiContainer: string;
  castBatches: Array<{ batch: number; rows: MemoryVectorCastRow[] }>;
  reembedded: MemoryVectorReembedResult[];
  /** Set by a rollback. A consumed log is never used again. */
  consumedAt?: string;
  rollbackResult?: RollbackResultCounts;
}

// ---------------------------------------------------------------------------
// The live API's code
// ---------------------------------------------------------------------------

/** A fixed string that exists in one compiled file only from S7 on. */
export interface CodeSignature {
  id: string;
  file: string;
  text: string;
}

export type SignatureStatus = "present" | "absent" | "unreadable";

export interface LiveApiInspection {
  /** null: the container could not be inspected at all. */
  running: boolean | null;
  signatures: Array<{ id: string; status: SignatureStatus }>;
}

const REPOSITORY = "/workspace/packages/db/dist/repositories/memory-repository.js";
const EXTRACTION = "/workspace/packages/memory/dist/memory-extraction-service.js";
const ORCHESTRATOR = "/workspace/packages/agents/dist/orchestrator.js";

/**
 * The S7 memory write and recall code, identified in the compiled files the
 * API image runs (WORKDIR /workspace — see the Dockerfile). Every identifier
 * is absent from the same package sources before S7 (75dd684) and present from
 * f6cfd63 on. Presence in all five is the proof the command requires.
 */
export const S7_MEMORY_CODE_SIGNATURES: readonly CodeSignature[] = [
  { id: "atomic_vector_create", file: REPOSITORY, text: "storeAtomically" },
  { id: "atomic_vector_merge", file: REPOSITORY, text: "updateWithEmbedding" },
  { id: "embedding_drop_policy", file: EXTRACTION, text: "memory_embedding_failed" },
  { id: "recall_similarity_floor", file: ORCHESTRATOR, text: "minSimilarity" },
  { id: "recall_failure_event", file: ORCHESTRATOR, text: "memory_recall_failed" },
];

// ---------------------------------------------------------------------------
// The backup
// ---------------------------------------------------------------------------

export interface BackupFileInfo {
  sizeBytes: number;
  modifiedAtMs: number;
  /** The file as UTF-8; empty when it is too large to verify. Never printed. */
  content: string;
}

export interface BackfillDeps {
  prisma: PrismaClient;
  plan(prisma: PrismaClient): Promise<MemoryBackfillPlan>;
  applyCastBatch(prisma: PrismaClient, ids: string[]): Promise<MemoryVectorCastResult>;
  reembed(
    prisma: PrismaClient,
    provider: IEmbeddingProvider,
    ids: string[],
    options: { model: string }
  ): Promise<MemoryVectorReembedResult[]>;
  rollbackCast(prisma: PrismaClient, rows: MemoryVectorCastRow[]): Promise<MemoryVectorRollbackResult>;
  rollbackReembed(prisma: PrismaClient, entries: MemoryVectorReembedResult[]): Promise<MemoryVectorRollbackResult>;
  createEmbeddingProvider(model: string): IEmbeddingProvider;
  inspectLiveApi(container: string, signatures: readonly CodeSignature[]): Promise<LiveApiInspection>;
  /** null when the file does not exist. */
  readBackup(path: string): BackupFileInfo | null;
  now(): number;
  fileExists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  print(event: Record<string, unknown>): void;
}

type Check = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure guards
// ---------------------------------------------------------------------------

const FLAG_OPTIONS = new Set(["execute"]);
const VALUE_OPTIONS = new Set([
  "confirm-target",
  "expect-cast",
  "expect-reembed",
  "rollback-log",
  "rollback",
  "batch-size",
  "backup-file",
  "live-api-container",
]);
/** Options that only mean something to --execute. */
const EXECUTE_OPTIONS = ["expect-cast", "expect-reembed", "rollback-log", "backup-file", "live-api-container", "batch-size"];

const TARGET_PATTERN = /^[A-Za-z0-9.-]+:\d{1,5}\/[A-Za-z0-9_-]+$/;
const COUNT_PATTERN = /^(0|[1-9]\d{0,8})$/;
const BATCH_PATTERN = /^[1-9]\d{0,3}$/;
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH_PATTERN = /^[0-9a-f]{32}$/;

export function parseBackfillArgs(argv: string[]): { ok: true; args: BackfillArgs } | { ok: false; error: string } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const arg of argv) {
    const match = /^--([a-z][a-z-]*)(=([\s\S]*))?$/.exec(arg);
    // Values are never echoed: a mistyped argument can be a database URL.
    if (!match) return { ok: false, error: "Unrecognised argument; every argument must be --option or --option=value" };
    const name = match[1]!;
    const value = match[3];
    if (flags.has(name) || values.has(name)) return { ok: false, error: `--${name} is given more than once` };
    if (FLAG_OPTIONS.has(name)) {
      if (value !== undefined) return { ok: false, error: `--${name} takes no value` };
      flags.add(name);
    } else if (VALUE_OPTIONS.has(name)) {
      if (value === undefined || value === "") return { ok: false, error: `--${name} needs a value (--${name}=...)` };
      values.set(name, value);
    } else {
      return { ok: false, error: `Unknown option --${name}` };
    }
  }

  const confirmTarget = values.get("confirm-target");
  if (confirmTarget !== undefined && !TARGET_PATTERN.test(confirmTarget)) {
    return { ok: false, error: "--confirm-target must be <host>:<port>/<database>" };
  }

  const batchRaw = values.get("batch-size");
  if (batchRaw !== undefined && (!BATCH_PATTERN.test(batchRaw) || Number(batchRaw) > MAX_BATCH_SIZE)) {
    return { ok: false, error: `--batch-size must be a whole number from 1 to ${MAX_BATCH_SIZE}` };
  }
  const batchSize = batchRaw === undefined ? DEFAULT_BATCH_SIZE : Number(batchRaw);

  const execute = flags.has("execute");
  const rollbackFrom = values.get("rollback");

  if (rollbackFrom !== undefined) {
    if (execute || EXECUTE_OPTIONS.some((o) => values.has(o))) {
      return { ok: false, error: "--rollback cannot be combined with --execute or its options" };
    }
    return { ok: true, args: { mode: "rollback", confirmTarget, rollbackFrom, batchSize } };
  }

  if (!execute) {
    const stray = EXECUTE_OPTIONS.find((o) => values.has(o));
    if (stray) return { ok: false, error: `--${stray} requires --execute` };
    return { ok: true, args: { mode: "dry-run", confirmTarget, batchSize } };
  }

  const countOf = (name: string, meaning: string): number | string => {
    const raw = values.get(name);
    if (raw === undefined) return `--execute requires --${name}=<${meaning}>`;
    if (!COUNT_PATTERN.test(raw)) return `--${name} must be a whole number (${meaning})`;
    return Number(raw);
  };
  const expectCast = countOf("expect-cast", "exact number of rows to cast");
  if (typeof expectCast === "string") return { ok: false, error: expectCast };
  const expectReembed = countOf("expect-reembed", "exact number of rows to re-embed");
  if (typeof expectReembed === "string") return { ok: false, error: expectReembed };
  const rollbackLog = values.get("rollback-log");
  if (!rollbackLog) return { ok: false, error: "--execute requires --rollback-log=<path of a NEW file>" };
  const backupFile = values.get("backup-file");
  if (!backupFile) return { ok: false, error: "--execute requires --backup-file=<fresh plain pg_dump of the Memory table>" };
  const liveApiContainer = values.get("live-api-container");
  if (!liveApiContainer) return { ok: false, error: "--execute requires --live-api-container=<name of the running API container>" };
  if (!CONTAINER_PATTERN.test(liveApiContainer)) return { ok: false, error: "--live-api-container must be a container name" };

  return {
    ok: true,
    args: { mode: "execute", confirmTarget, expectCast, expectReembed, rollbackLog, backupFile, liveApiContainer, batchSize },
  };
}

/** `<host>:<port>/<database>` of an explicitly supplied URL — never its credentials. */
export function resolveBackfillTarget(
  explicitDatabaseUrl: string | undefined,
  confirmTarget: string | undefined
): { ok: true; target: string } | { ok: false; error: string } {
  if (!explicitDatabaseUrl) {
    return { ok: false, error: "DATABASE_URL must be set explicitly for this command; .env is never used" };
  }
  let target: string;
  try {
    const url = new URL(explicitDatabaseUrl);
    target = `${url.hostname}:${url.port || "5432"}/${url.pathname.replace(/^\//, "")}`;
  } catch {
    return { ok: false, error: "DATABASE_URL is not a valid URL" };
  }
  if (!TARGET_PATTERN.test(target)) return { ok: false, error: "DATABASE_URL does not name a <host>:<port>/<database>" };
  if (!confirmTarget) return { ok: false, error: `--confirm-target is required (this DATABASE_URL is ${target})` };
  if (confirmTarget !== target) {
    return { ok: false, error: `--confirm-target ${confirmTarget} does not match DATABASE_URL (${target})` };
  }
  return { ok: true, target };
}

export function checkExecutionGate(
  planned: { cast: number; reembed: number },
  expected: { cast: number; reembed: number }
): Check {
  if (planned.cast !== expected.cast || planned.reembed !== expected.reembed) {
    return {
      ok: false,
      error: `The plan has cast=${planned.cast}, reembed=${planned.reembed}; expected cast=${expected.cast}, reembed=${expected.reembed}. Nothing was changed.`,
    };
  }
  return { ok: true };
}

export function checkReembedPreflight(env: Record<string, string | undefined>, reembedCount: number): Check {
  if (reembedCount === 0) return { ok: true };
  if (!env.OPENAI_API_KEY) return { ok: false, error: "Re-embedding needs OPENAI_API_KEY" };
  const configured = env.OPENAI_EMBEDDING_MODEL;
  if (configured && configured !== BACKFILL_MODEL) {
    return {
      ok: false,
      error: `OPENAI_EMBEDDING_MODEL is ${configured}, but memories are embedded with ${BACKFILL_MODEL}; refusing to mix embedding spaces`,
    };
  }
  return { ok: true };
}

/** Passes only a running container whose files hold every S7 signature. */
export function checkLiveApi(inspection: LiveApiInspection): Check {
  if (inspection.running === null) {
    return { ok: false, error: "The live API container could not be inspected, so its memory code cannot be verified" };
  }
  if (!inspection.running) {
    return { ok: false, error: "The live API container is not running, so its memory code cannot be verified" };
  }
  const status = new Map(inspection.signatures.map((s) => [s.id, s.status]));
  const missing = S7_MEMORY_CODE_SIGNATURES.filter((s) => status.get(s.id) !== "present").map((s) => s.id);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `The live API runs pre-S7 or unverifiable memory code (missing: ${missing.join(", ")}). Deploy the S7 memory code before the backfill.`,
    };
  }
  return { ok: true };
}

/**
 * A fresh, complete, plain-format pg_dump holding the Memory table's data.
 * Returns how many Memory rows it holds; the file's content is never printed.
 */
export function checkBackupFile(
  info: BackupFileInfo | null,
  nowMs: number
): { ok: true; rows: number } | { ok: false; error: string } {
  if (!info) return { ok: false, error: "The backup file does not exist" };
  if (info.sizeBytes === 0) return { ok: false, error: "The backup file is empty" };
  if (info.sizeBytes > BACKUP_MAX_BYTES) return { ok: false, error: "The backup file is too large to verify" };
  if (nowMs - info.modifiedAtMs > BACKUP_MAX_AGE_MINUTES * 60_000) {
    return { ok: false, error: `The backup is older than ${BACKUP_MAX_AGE_MINUTES} minutes; take a fresh one` };
  }
  const text = info.content;
  if (!text.slice(0, 512).includes("-- PostgreSQL database dump")) {
    return {
      ok: false,
      error: "The backup is not a plain-format pg_dump (a PowerShell redirect re-encodes one; copy it out with docker cp)",
    };
  }
  if (!text.slice(-1024).includes("-- PostgreSQL database dump complete")) {
    return { ok: false, error: "The backup is incomplete: pg_dump did not finish" };
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^COPY public\."Memory" \(.*\) FROM stdin;$/.test(line));
  if (start < 0) return { ok: false, error: "The backup does not contain the Memory table's data" };
  const end = lines.indexOf("\\.", start + 1);
  if (end < 0) return { ok: false, error: "The backup's Memory data is not terminated" };
  return { ok: true, rows: end - start - 1 };
}

/** A rollback log this command wrote — anything else is refused. */
function validateRollbackLog(value: unknown): { ok: true; log: RollbackLog } | { ok: false; error: string } {
  const log = value as Partial<RollbackLog> | null;
  const invalid = { ok: false as const, error: "The rollback log is not a valid version-2 backfill log" };
  if (!log || typeof log !== "object" || log.version !== 2) return invalid;
  if (typeof log.target !== "string" || !TARGET_PATTERN.test(log.target)) return invalid;
  if (!Array.isArray(log.castBatches) || !Array.isArray(log.reembedded)) return invalid;
  const rowsOk = log.castBatches.every(
    (b) =>
      b &&
      Array.isArray(b.rows) &&
      b.rows.every((r) => r && typeof r.id === "string" && r.id.length > 0 && HASH_PATTERN.test(String(r.appliedVectorHash)))
  );
  const reembedOk = log.reembedded.every(
    (r) =>
      r &&
      typeof r.id === "string" &&
      (r.status !== "reembedded" ||
        (HASH_PATTERN.test(String(r.appliedVectorHash)) &&
          (r.previousMetadataEmbedding === null ||
            (Array.isArray(r.previousMetadataEmbedding) && r.previousMetadataEmbedding.every((n) => Number.isFinite(n))))))
  );
  if (!rowsOk || !reembedOk) return invalid;
  return { ok: true, log: log as RollbackLog };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const EXIT = { ok: 0, postflight: 3, refused: 64, gate: 65, failed: 70 } as const;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function planEvent(plan: MemoryBackfillPlan) {
  return {
    total: plan.totalRows,
    cast: plan.castCandidateIds.length,
    reembed: plan.reembedCandidateIds.length,
    noEmbedding: plan.noEmbeddingIds.length,
    alreadyVectorized: plan.alreadyVectorized,
    invalid: plan.invalidMetadataEmbedding,
    expired: plan.expiredMetadataOnly,
    vectorMismatch: plan.vectorMetadataMismatch,
  };
}

/** The error's class name and machine code only — its message can carry content. */
function errorFields(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? { errorCode: code } : {}),
  };
}

/** Runs the command. Returns the process exit code. */
export async function runMemoryBackfill(
  argv: string[],
  explicitDatabaseUrl: string | undefined,
  env: Record<string, string | undefined>,
  deps: BackfillDeps
): Promise<number> {
  const refuse = (code: number, reason: string) => {
    deps.print({ event: "memory_backfill_refused", reason });
    return code;
  };
  let stage = "arguments";

  try {
    const parsed = parseBackfillArgs(argv);
    if (!parsed.ok) return refuse(EXIT.refused, parsed.error);
    const args = parsed.args;

    const resolved = resolveBackfillTarget(explicitDatabaseUrl, args.confirmTarget);
    if (!resolved.ok) return refuse(EXIT.refused, resolved.error);
    const target = resolved.target;

    // ---- rollback ---------------------------------------------------------
    if (args.mode === "rollback") {
      stage = "rollback_log";
      if (!deps.fileExists(args.rollbackFrom!)) return refuse(EXIT.refused, "The rollback log does not exist");
      let raw: unknown;
      try {
        raw = JSON.parse(deps.readFile(args.rollbackFrom!));
      } catch {
        return refuse(EXIT.refused, "The rollback log is not valid JSON");
      }
      const validated = validateRollbackLog(raw);
      if (!validated.ok) return refuse(EXIT.refused, validated.error);
      const log = validated.log;
      if (log.target !== target) return refuse(EXIT.refused, `The rollback log belongs to ${log.target}, not ${target}`);
      if (log.consumedAt !== undefined) {
        return refuse(EXIT.refused, "This rollback log has already been used; a log can roll back only once");
      }

      stage = "rollback";
      const cast = await deps.rollbackCast(deps.prisma, log.castBatches.flatMap((b) => b.rows));
      const reembed = await deps.rollbackReembed(deps.prisma, log.reembedded);
      const result: RollbackResultCounts = {
        castReverted: cast.reverted,
        castConflicted: cast.conflicted,
        reembedReverted: reembed.reverted,
        reembedConflicted: reembed.conflicted,
      };
      stage = "rollback_log";
      deps.writeFile(
        args.rollbackFrom!,
        JSON.stringify({ ...log, consumedAt: new Date(deps.now()).toISOString(), rollbackResult: result }, null, 2)
      );
      deps.print({ event: "memory_backfill_rollback", target, ...result });
      return EXIT.ok;
    }

    // ---- execute: local preflight, before the database is read -------------
    let backupRows = -1;
    if (args.mode === "execute") {
      stage = "preflight";
      if (deps.fileExists(args.rollbackLog!)) return refuse(EXIT.gate, "The rollback log already exists; choose a new file");

      const backup = checkBackupFile(deps.readBackup(args.backupFile!), deps.now());
      if (!backup.ok) return refuse(EXIT.gate, backup.error);
      backupRows = backup.rows;

      const live = checkLiveApi(await deps.inspectLiveApi(args.liveApiContainer!, S7_MEMORY_CODE_SIGNATURES));
      if (!live.ok) return refuse(EXIT.gate, live.error);
    }

    // ---- plan (read only) -------------------------------------------------
    stage = "plan";
    const plan = await deps.plan(deps.prisma);
    deps.print({ event: "memory_backfill_plan", mode: args.mode, target, ...planEvent(plan) });
    if (args.mode === "dry-run") return EXIT.ok;

    // ---- execute guards -----------------------------------------------------
    stage = "gate";
    const gate = checkExecutionGate(
      { cast: plan.castCandidateIds.length, reembed: plan.reembedCandidateIds.length },
      { cast: args.expectCast!, reembed: args.expectReembed! }
    );
    if (!gate.ok) return refuse(EXIT.gate, gate.error);
    if (plan.vectorMetadataMismatch > 0) {
      return refuse(
        EXIT.gate,
        `${plan.vectorMetadataMismatch} row(s) already have a vector that disagrees with their metadata embedding — a pre-S7 writer has run. Nothing was changed.`
      );
    }
    if (backupRows !== plan.totalRows) {
      return refuse(EXIT.gate, `The backup holds ${backupRows} Memory rows but the table has ${plan.totalRows}; take a fresh backup`);
    }
    const preflight = checkReembedPreflight(env, plan.reembedCandidateIds.length);
    if (!preflight.ok) return refuse(EXIT.gate, preflight.error);

    stage = "rollback_log";
    const log: RollbackLog = {
      version: 2,
      target,
      createdAt: new Date(deps.now()).toISOString(),
      backupFile: args.backupFile!,
      liveApiContainer: args.liveApiContainer!,
      castBatches: [],
      reembedded: [],
    };
    const saveLog = () => deps.writeFile(args.rollbackLog!, JSON.stringify(log, null, 2));
    saveLog();

    // ---- cast, batch by batch ---------------------------------------------
    stage = "cast";
    let batch = 0;
    for (const ids of chunks(plan.castCandidateIds, args.batchSize)) {
      batch++;
      try {
        const result = await deps.applyCastBatch(deps.prisma, ids);
        log.castBatches.push({ batch, rows: result.applied });
        saveLog();
        deps.print({ event: "memory_backfill_batch", batch, cast: result.castIds.length, skipped: result.skippedIds.length });
      } catch (error) {
        deps.print({ event: "memory_backfill_failed", stage: "cast", batch, ...errorFields(error) });
        return EXIT.failed;
      }
    }

    // ---- re-embed, one row at a time --------------------------------------
    if (plan.reembedCandidateIds.length > 0) {
      stage = "reembed";
      const provider = deps.createEmbeddingProvider(BACKFILL_MODEL);
      let reembedded = 0;
      let skipped = 0;
      let conflicted = 0;
      for (const id of plan.reembedCandidateIds) {
        const [result] = await deps.reembed(deps.prisma, provider, [id], { model: BACKFILL_MODEL });
        if (result?.status === "reembedded") {
          log.reembedded.push(result);
          saveLog();
          reembedded++;
        } else if (result?.status === "conflicted") {
          conflicted++;
        } else {
          skipped++;
        }
      }
      deps.print({ event: "memory_backfill_reembed", reembedded, skipped, conflicted });
    }

    // ---- postflight -------------------------------------------------------
    stage = "postflight";
    const after = await deps.plan(deps.prisma);
    const ok =
      after.castCandidateIds.length === 0 && after.reembedCandidateIds.length === 0 && after.vectorMetadataMismatch === 0;
    deps.print({
      event: "memory_backfill_postflight",
      target,
      castRemaining: after.castCandidateIds.length,
      reembedRemaining: after.reembedCandidateIds.length,
      alreadyVectorized: after.alreadyVectorized,
      noEmbedding: after.noEmbeddingIds.length,
      vectorMismatch: after.vectorMetadataMismatch,
      ok,
    });
    return ok ? EXIT.ok : EXIT.postflight;
  } catch (error) {
    // Not swallowed: reported, and the exit code says the run failed.
    deps.print({ event: "memory_backfill_failed", stage, ...errorFields(error) });
    return EXIT.failed;
  }
}
