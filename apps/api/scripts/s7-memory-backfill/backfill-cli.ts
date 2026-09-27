// ---------------------------------------------------------------------------
// S7 Step 8 — the memory vector backfill command: guards and runner.
//
// The backfill itself lives in @jarvis/db (maintenance/memory-vector-backfill).
// This file decides WHETHER it may run, and records what it did:
//
//   - DRY RUN BY DEFAULT. Without --execute it only reports counts.
//   - EXPLICIT TARGET. DATABASE_URL must be supplied explicitly (the entry
//     point reads it before anything can load packages/db/.env), and
//     --confirm-target=<host>:<port>/<database> must match it.
//   - EXACT EXPECTATIONS. --execute needs --expect-cast and --expect-reembed;
//     a fresh plan that differs from either refuses to run.
//   - REVERSIBLE. --execute needs a NEW --rollback-log file, rewritten after
//     every batch, so even a run that stops halfway can be reverted with
//     --rollback=<file>, for exactly the rows it changed.
//   - NO CONTENT. The console gets counts only; ids go to the rollback log.
//
// It imports only TYPES from @jarvis/db, so importing it never loads Prisma.
// ---------------------------------------------------------------------------

import type { IEmbeddingProvider } from "@jarvis/core";
import type {
  MemoryBackfillPlan,
  MemoryVectorCastResult,
  MemoryVectorReembedResult,
  PrismaClient,
} from "@jarvis/db";

/** The model extraction embeds memories with; re-embedding must match it. */
export const BACKFILL_MODEL = "text-embedding-3-small";
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
  batchSize: number;
}

export interface RollbackLog {
  version: 1;
  target: string;
  createdAt: string;
  castBatches: Array<{ batch: number; ids: string[] }>;
  reembedded: MemoryVectorReembedResult[];
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
  rollbackCast(prisma: PrismaClient, ids: string[]): Promise<number>;
  rollbackReembed(prisma: PrismaClient, entries: MemoryVectorReembedResult[]): Promise<number>;
  createEmbeddingProvider(model: string): IEmbeddingProvider;
  fileExists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  print(event: Record<string, unknown>): void;
}

type Check = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure guards
// ---------------------------------------------------------------------------

function nonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

export function parseBackfillArgs(argv: string[]): { ok: true; args: BackfillArgs } | { ok: false; error: string } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) return { ok: false, error: `Unrecognised argument ${arg}` };
    const [, name, value] = match;
    if (!["confirm-target", "execute", "expect-cast", "expect-reembed", "rollback-log", "rollback", "batch-size"].includes(name!)) {
      return { ok: false, error: `Unknown option --${name}` };
    }
    if (value === undefined) flags.add(name!);
    else values.set(name!, value);
  }

  const batchRaw = values.get("batch-size");
  const batchSize = batchRaw === undefined ? DEFAULT_BATCH_SIZE : nonNegativeInt(batchRaw);
  if (batchSize === undefined || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    return { ok: false, error: `--batch-size must be an integer from 1 to ${MAX_BATCH_SIZE}` };
  }

  const confirmTarget = values.get("confirm-target");
  const rollbackFrom = values.get("rollback");
  const execute = flags.has("execute");

  if (rollbackFrom !== undefined) {
    if (execute || values.has("expect-cast") || values.has("expect-reembed") || values.has("rollback-log")) {
      return { ok: false, error: "--rollback cannot be combined with --execute or its options" };
    }
    return { ok: true, args: { mode: "rollback", confirmTarget, rollbackFrom, batchSize } };
  }

  if (!execute) {
    return { ok: true, args: { mode: "dry-run", confirmTarget, batchSize } };
  }

  const expectCast = nonNegativeInt(values.get("expect-cast"));
  if (expectCast === undefined) return { ok: false, error: "--execute requires --expect-cast=<exact number of rows to cast>" };
  const expectReembed = nonNegativeInt(values.get("expect-reembed"));
  if (expectReembed === undefined) return { ok: false, error: "--execute requires --expect-reembed=<exact number of rows to re-embed>" };
  const rollbackLog = values.get("rollback-log");
  if (!rollbackLog) return { ok: false, error: "--execute requires --rollback-log=<path of a NEW file>" };

  return { ok: true, args: { mode: "execute", confirmTarget, expectCast, expectReembed, rollbackLog, batchSize } };
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

  const parsed = parseBackfillArgs(argv);
  if (!parsed.ok) return refuse(EXIT.refused, parsed.error);
  const args = parsed.args;

  const resolved = resolveBackfillTarget(explicitDatabaseUrl, args.confirmTarget);
  if (!resolved.ok) return refuse(EXIT.refused, resolved.error);
  const target = resolved.target;

  // ---- rollback -----------------------------------------------------------
  if (args.mode === "rollback") {
    if (!deps.fileExists(args.rollbackFrom!)) return refuse(EXIT.refused, "The rollback log does not exist");
    const log = JSON.parse(deps.readFile(args.rollbackFrom!)) as RollbackLog;
    if (log.version !== 1 || log.target !== target) {
      return refuse(EXIT.refused, `The rollback log belongs to ${log.target}, not ${target}`);
    }
    const castReverted = await deps.rollbackCast(deps.prisma, log.castBatches.flatMap((b) => b.ids));
    const reembedReverted = await deps.rollbackReembed(deps.prisma, log.reembedded);
    deps.print({ event: "memory_backfill_rollback", target, castReverted, reembedReverted });
    return EXIT.ok;
  }

  // ---- plan ---------------------------------------------------------------
  const plan = await deps.plan(deps.prisma);
  deps.print({ event: "memory_backfill_plan", mode: args.mode, target, ...planEvent(plan) });
  if (args.mode === "dry-run") return EXIT.ok;

  // ---- execute guards -----------------------------------------------------
  const gate = checkExecutionGate(
    { cast: plan.castCandidateIds.length, reembed: plan.reembedCandidateIds.length },
    { cast: args.expectCast!, reembed: args.expectReembed! }
  );
  if (!gate.ok) return refuse(EXIT.gate, gate.error);
  const preflight = checkReembedPreflight(env, plan.reembedCandidateIds.length);
  if (!preflight.ok) return refuse(EXIT.gate, preflight.error);
  if (deps.fileExists(args.rollbackLog!)) return refuse(EXIT.gate, "The rollback log already exists; choose a new file");

  const log: RollbackLog = { version: 1, target, createdAt: new Date().toISOString(), castBatches: [], reembedded: [] };
  const saveLog = () => deps.writeFile(args.rollbackLog!, JSON.stringify(log, null, 2));
  saveLog();

  // ---- cast, batch by batch -----------------------------------------------
  let batch = 0;
  for (const ids of chunks(plan.castCandidateIds, args.batchSize)) {
    batch++;
    try {
      const result = await deps.applyCastBatch(deps.prisma, ids);
      log.castBatches.push({ batch, ids: result.castIds });
      saveLog();
      deps.print({ event: "memory_backfill_batch", batch, cast: result.castIds.length, skipped: result.skippedIds.length });
    } catch (error) {
      deps.print({ event: "memory_backfill_failed", stage: "cast", batch, errorName: error instanceof Error ? error.name : typeof error });
      return EXIT.failed;
    }
  }

  // ---- re-embed, one row at a time ----------------------------------------
  if (plan.reembedCandidateIds.length > 0) {
    const provider = deps.createEmbeddingProvider(BACKFILL_MODEL);
    let reembedded = 0;
    let skipped = 0;
    for (const id of plan.reembedCandidateIds) {
      try {
        const [result] = await deps.reembed(deps.prisma, provider, [id], { model: BACKFILL_MODEL });
        if (result?.status === "reembedded") {
          log.reembedded.push(result);
          saveLog();
          reembedded++;
        } else {
          skipped++;
        }
      } catch (error) {
        deps.print({ event: "memory_backfill_failed", stage: "reembed", errorName: error instanceof Error ? error.name : typeof error });
        return EXIT.failed;
      }
    }
    deps.print({ event: "memory_backfill_reembed", reembedded, skipped });
  }

  // ---- postflight -----------------------------------------------------------
  const after = await deps.plan(deps.prisma);
  const ok = after.castCandidateIds.length === 0 && after.reembedCandidateIds.length === 0;
  deps.print({
    event: "memory_backfill_postflight",
    target,
    castRemaining: after.castCandidateIds.length,
    reembedRemaining: after.reembedCandidateIds.length,
    alreadyVectorized: after.alreadyVectorized,
    noEmbedding: after.noEmbeddingIds.length,
    ok,
  });
  return ok ? EXIT.ok : EXIT.postflight;
}
