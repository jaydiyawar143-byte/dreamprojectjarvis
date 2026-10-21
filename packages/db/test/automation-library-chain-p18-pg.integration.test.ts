// Phase 18, Stage 18.2 — continue-until-complete chains in the Automation
// Library's storage, against REAL PostgreSQL.
//
// What only a database can prove:
//   • of two chains starting together — two connections, as two API instances
//     would be — exactly one holds the catalog; the other request is answered
//     with that chain;
//   • an idempotency key is one chain, even when two requests carry it at once;
//   • while a chain is alive, a single run cannot begin and another chain's
//     run cannot either; only the holder's runs begin;
//   • a chain is never held by a run: a start is refused while a run holds the
//     lease;
//   • a chain whose process died is closed as INTERRUPTED by whichever start
//     takes the catalog from it, and its scan resumes;
//   • a run's lease release keeps its chain alive, with no gap.
//
// SAFETY. As the Stage 18.1 suite: DATABASE_URL is read before the Prisma
// client is imported, only a separate test database is used (never 5432 or
// 5433), and everything created is removed. Skipped only when no database is
// configured; FAILS under JARVIS_REQUIRE_POSTGRES=1 when none is reachable.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  LIBRARY_CHAIN_STALE_MS,
  LIBRARY_LEASE_MS,
  type LibraryChainStartInput,
  type LibraryScope,
} from "@jarvis/core";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Client = InstanceType<(typeof import("@prisma/client"))["PrismaClient"]>;
type RepoModule = typeof import("../src/repositories/automation-library-repository.js");

let prisma: Client | null = null;
let second: Client | null = null;
let mod: RepoModule | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  const Prisma = await import("@prisma/client");
  mod = await import("../src/repositories/automation-library-repository.js");
  prisma = new Prisma.PrismaClient();
  second = new Prisma.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    await second.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const tenantIds: string[] = [];
const userIds: string[] = [];
let owner = "";
let admin = "";

const repo = () => new mod!.PrismaAutomationLibraryRepository(prisma!);
const repo2 = () => new mod!.PrismaAutomationLibraryRepository(second!);

let tick = Date.parse("2026-10-20T09:00:00.000Z");
const now = () => new Date((tick += 1000));

let seq = 0;
const id = (kind: string) => `${kind}-${STAMP}-${(seq += 1)}`;
const scopeNamed = (name: string): LibraryScope => ({ tenantId: tenantIds[0]!, providerId: "n8n", instanceKey: `inst-${name}-${STAMP}` });

function chainInput(scope: LibraryScope, over: Partial<LibraryChainStartInput> = {}): LibraryChainStartInput {
  return {
    scope,
    chainId: id("chain"),
    requestedById: owner,
    limits: { maxRuns: 25, maxPages: 500, maxMs: 30 * 60_000 },
    staleMs: LIBRARY_CHAIN_STALE_MS,
    now: now(),
    ...over,
  };
}

async function beginRun(scope: LibraryScope, options: { chainId?: string; at?: Date; client?: "first" | "second" } = {}) {
  const runId = id("run");
  const result = await (options.client === "second" ? repo2() : repo()).beginRun({
    scope,
    runId,
    newScanId: id("scan"),
    requestedById: owner,
    pageSize: 250,
    restart: false,
    leaseMs: LIBRARY_LEASE_MS,
    now: options.at ?? now(),
    chainStaleMs: LIBRARY_CHAIN_STALE_MS,
    ...(options.chainId ? { chainId: options.chainId } : {}),
  });
  return { runId, result };
}

const syncRow = (scope: LibraryScope) =>
  prisma!.automationLibrarySync.findUniqueOrThrow({ where: { tenantId_providerId_instanceKey: scope } });
const chainRow = (chainId: string) => prisma!.automationLibrarySyncChain.findUniqueOrThrow({ where: { id: chainId } });

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) {
    throw new Error("These Automation Library chain tests need a separate PostgreSQL test database, and none could be reached.");
  }
  for (const name of ["owner", "admin"]) {
    const user = await prisma!.user.create({
      data: { email: `p18-chain-${name}-${STAMP}@jarvis-test.local`, name, password: "not-a-real-password-hash", role: "MEMBER" },
    });
    userIds.push(user.id);
  }
  [owner, admin] = userIds as [string, string];
  const tenant = await prisma!.tenant.create({ data: { name: `p18-chain-${STAMP}` } });
  tenantIds.push(tenant.id);
});

afterAll(async () => {
  if (prisma) {
    // Sync rows, chains and runs cascade with their Organization.
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  if (second) await second.$disconnect();
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 18.2 — continue-until-complete chains on PostgreSQL", () => {
  it("lets exactly one of two chains starting together hold the catalog — the other is answered with it", async () => {
    const scope = scopeNamed("race");
    for (let round = 0; round < 5; round += 1) {
      const at = now();
      const [x, y] = await Promise.all([
        repo().startChain(chainInput(scope, { now: at })),
        repo2().startChain(chainInput(scope, { now: at, requestedById: admin })),
      ]);
      expect(x.ok && y.ok).toBe(true);
      if (!x.ok || !y.ok) return;
      expect([x.created, y.created].sort()).toEqual([false, true]);
      expect(x.chain.chainId).toBe(y.chain.chainId);
      expect(x.chain.alive && y.chain.alive).toBe(true);
      expect((await syncRow(scope)).activeChainId).toBe(x.chain.chainId);
      await repo().finishChain({ scope, chainId: x.chain.chainId, status: "COMPLETE", stopCode: null, failureCode: null, now: now() });
      expect((await syncRow(scope)).activeChainId).toBeNull();
    }
    const sync = await syncRow(scope);
    expect(await prisma!.automationLibrarySyncChain.count({ where: { syncId: sync.id } })).toBe(5);
  });

  it("makes one idempotency key one chain — at once on two connections, and after it ended", async () => {
    const scope = scopeNamed("key");
    const key = `key-${STAMP}`;
    const at = now();
    const [x, y] = await Promise.all([
      repo().startChain(chainInput(scope, { idempotencyKey: key, now: at })),
      repo2().startChain(chainInput(scope, { idempotencyKey: key, now: at })),
    ]);
    if (!x.ok || !y.ok) throw new Error("refused");
    expect(x.chain.chainId).toBe(y.chain.chainId);
    await repo().finishChain({ scope, chainId: x.chain.chainId, status: "STOPPED", stopCode: "RUN_LIMIT", failureCode: null, now: now() });

    const replay = await repo().startChain(chainInput(scope, { idempotencyKey: key }));
    expect(replay).toMatchObject({ ok: true, created: false, chain: { chainId: x.chain.chainId, status: "STOPPED", stopCode: "RUN_LIMIT", alive: false } });
    expect(await repo().peekChain(scope, { requestedById: owner, idempotencyKey: key, now: now(), staleMs: LIBRARY_CHAIN_STALE_MS })).toMatchObject({
      chainId: x.chain.chainId,
      alive: false,
    });
    // Another person's same key is their own request.
    const theirs = await repo().startChain(chainInput(scope, { idempotencyKey: key, requestedById: admin }));
    expect(theirs.ok && theirs.created).toBe(true);
    const sync = await syncRow(scope);
    expect(await prisma!.automationLibrarySyncChain.count({ where: { syncId: sync.id } })).toBe(2);
  });

  it("begins only the holder's runs while a chain is alive", async () => {
    const scope = scopeNamed("holder");
    const started = await repo().startChain(chainInput(scope));
    if (!started.ok) throw new Error("refused");
    const chainId = started.chain.chainId;

    // A single run, on either connection: refused.
    expect((await beginRun(scope)).result).toEqual({ ok: false, reason: "LEASE_HELD" });
    expect((await beginRun(scope, { client: "second" })).result).toEqual({ ok: false, reason: "LEASE_HELD" });
    // Another chain's run: it holds nothing.
    expect((await beginRun(scope, { chainId: id("chain-x") })).result).toEqual({ ok: false, reason: "CHAIN_LOST" });

    const run = await beginRun(scope, { chainId });
    expect(run.result.ok).toBe(true);
    expect(await prisma!.automationLibrarySyncRun.findUniqueOrThrow({ where: { id: run.runId } })).toMatchObject({ chainId });
    expect(await chainRow(chainId)).toMatchObject({ runsStarted: 1 });

    // The release of the run's lease keeps the chain alive, with no gap.
    const released = now();
    await repo().finishRun({ scope, runId: run.runId, status: "PARTIAL", failureCode: null, resetScan: false, now: released });
    expect((await syncRow(scope)).chainHeartbeatAt?.getTime()).toBe(released.getTime());
    expect((await repo().readStatus(scope, now())).chain).toMatchObject({ chainId, status: "RUNNING", alive: true });

    expect(await repo().recordChainProgress({ scope, chainId, now: now(), run: { runId: run.runId, pages: 2, records: 500, failureCode: null } })).toBe(true);
    expect(await chainRow(chainId)).toMatchObject({ pagesFetched: 2, recordsObserved: 500 });
    await repo().finishChain({ scope, chainId, status: "STOPPED", stopCode: "SHUTDOWN", failureCode: null, now: now() });
    expect(await chainRow(chainId)).toMatchObject({ status: "STOPPED", stopCode: "SHUTDOWN" });
    expect(await repo().recordChainProgress({ scope, chainId, now: now() })).toBe(false);
  });

  it("refuses a chain while a single run holds the lease", async () => {
    const scope = scopeNamed("single");
    const run = await beginRun(scope);
    expect(run.result.ok).toBe(true);
    expect(await repo().startChain(chainInput(scope))).toEqual({ ok: false, reason: "SYNC_RUNNING" });
    const sync = await syncRow(scope);
    expect(sync.activeChainId).toBeNull();
    expect(await prisma!.automationLibrarySyncChain.count({ where: { syncId: sync.id } })).toBe(0);
  });

  it("closes a chain whose process died as interrupted, by whichever start takes the catalog — and the scan resumes", async () => {
    for (const taker of ["single", "chain"] as const) {
      const scope = scopeNamed(`dead-${taker}`);
      const started = await repo().startChain(chainInput(scope));
      if (!started.ok) throw new Error("refused");
      const dead = started.chain.chainId;
      const run = await beginRun(scope, { chainId: dead });
      if (!run.result.ok) throw new Error("run refused");
      const scanId = run.result.checkpoint.scanId;
      // The process dies holding the lease; time passes.
      tick += Math.max(LIBRARY_LEASE_MS, LIBRARY_CHAIN_STALE_MS) + 5_000;
      expect((await repo().readStatus(scope, now())).chain).toMatchObject({ chainId: dead, status: "RUNNING", alive: false });
      expect(await repo().peekChain(scope, { requestedById: owner, now: now(), staleMs: LIBRARY_CHAIN_STALE_MS })).toBeNull();

      if (taker === "single") {
        const next = await beginRun(scope);
        expect(next.result).toMatchObject({ ok: true, resumed: true, recoveredRuns: 1, checkpoint: { scanId } });
        expect((await syncRow(scope)).activeChainId).toBeNull();
      } else {
        const next = await repo().startChain(chainInput(scope));
        expect(next).toMatchObject({ ok: true, created: true });
        if (!next.ok) return;
        const resumed = await beginRun(scope, { chainId: next.chain.chainId });
        expect(resumed.result).toMatchObject({ ok: true, resumed: true, checkpoint: { scanId } });
      }
      expect(await chainRow(dead)).toMatchObject({ status: "INTERRUPTED", stopCode: "INTERRUPTED" });
      expect(await prisma!.automationLibrarySyncRun.findUniqueOrThrow({ where: { id: run.runId } })).toMatchObject({
        status: "FAILED",
        failureCode: "INTERRUPTED",
      });
      // The dead chain's late word changes nothing.
      expect(await repo().recordChainProgress({ scope, chainId: dead, now: now() })).toBe(false);
      await repo().finishChain({ scope, chainId: dead, status: "COMPLETE", stopCode: null, failureCode: null, now: now() });
      expect(await chainRow(dead)).toMatchObject({ status: "INTERRUPTED" });
    }
  });
});
