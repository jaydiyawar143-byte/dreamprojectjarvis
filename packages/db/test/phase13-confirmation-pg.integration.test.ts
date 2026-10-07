// Phase 13 — the confirmation store against REAL PostgreSQL.
//
// The property that matters is in `consume`: of any number of callers
// presenting one token hash at the same moment — two requests, or two API
// instances — exactly one is handed the record. An in-memory double cannot
// prove that; only a database with real connections and real row locks can.
// The races below use TWO Prisma clients, which is what two API instances are.
//
// SAFETY. DATABASE_URL is read BEFORE the Prisma client is imported, because
// constructing a client loads packages/db/.env. The suite runs only against an
// explicitly supplied, separate test database — never the development (5432)
// or deployment (5433) one. Dedicated users are removed afterwards.
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

type Client = InstanceType<(typeof import("@prisma/client"))["PrismaClient"]>;
type Repository = InstanceType<
  (typeof import("../src/repositories/confirmation-repository.js"))["PrismaConfirmationRepository"]
>;

let Prisma: typeof import("@prisma/client") | null = null;
let RepositoryClass: (new (client: Client) => Repository) | null = null;
let prisma: Client | null = null;
let second: Client | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  Prisma = await import("@prisma/client");
  RepositoryClass = (await import("../src/repositories/confirmation-repository.js"))
    .PrismaConfirmationRepository;
  prisma = new Prisma.PrismaClient();
  // A second client is a second connection pool: another API instance.
  second = new Prisma.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    await second.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = Date.now();
const NOW = new Date("2026-10-06T08:00:00.000Z");
const IN_TWO_MINUTES = new Date(NOW.getTime() + 120_000);
const userIds: string[] = [];
let userId = "";
let otherUserId = "";

const hash = () => createHash("sha256").update(randomBytes(32)).digest("hex");

function pending(overrides: Partial<{ tokenHash: string; userId: string; expiresAt: Date }> = {}) {
  return {
    tokenHash: hash(),
    userId,
    integration: "meta",
    actionId: "meta.campaign.pause",
    paramsHash: "a".repeat(64),
    expiresAt: IN_TWO_MINUTES,
    ...overrides,
  };
}

const row = (tokenHash: string) => prisma!.confirmation.findUnique({ where: { tokenHash } });

beforeAll(async () => {
  if (!dbUp) return;
  for (const name of ["owner", "other"]) {
    const user = await prisma!.user.create({
      data: {
        email: `phase13-${name}-${STAMP}@jarvis-test.local`,
        name: `Phase 13 ${name}`,
        password: "not-a-real-password-hash",
        role: "VIEWER",
      },
    });
    userIds.push(user.id);
  }
  [userId, otherUserId] = userIds as [string, string];
});

afterAll(async () => {
  if (prisma) {
    // Confirmations cascade from the user.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  await second?.$disconnect();
});

describe.skipIf(!dbUp)("Phase 13 — the confirmation store on PostgreSQL", () => {
  it("stores a pending confirmation and gives it an id", async () => {
    const repo = new RepositoryClass!(prisma!);
    const input = pending();

    const { id } = await repo.create(input);

    const stored = await row(input.tokenHash);
    expect(stored).toMatchObject({
      id,
      tokenHash: input.tokenHash,
      userId,
      integration: "meta",
      actionId: "meta.campaign.pause",
      paramsHash: "a".repeat(64),
      consumedAt: null,
    });
    expect(stored!.expiresAt.toISOString()).toBe(IN_TWO_MINUTES.toISOString());
    expect(stored!.createdAt).toBeInstanceOf(Date);
  });

  it("holds no token, no parameter and no summary — the table has no column for one", async () => {
    const columns = await prisma!.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'Confirmation'
      ORDER BY column_name`;

    expect(columns.map((column) => column.column_name)).toEqual([
      "action_id",
      "consumed_at",
      "created_at",
      "expires_at",
      "id",
      "integration",
      "params_hash",
      "token_hash",
      "user_id",
    ]);
  });

  it("hands a pending confirmation over once, and records when", async () => {
    const repo = new RepositoryClass!(prisma!);
    const input = pending();
    const { id } = await repo.create(input);

    const record = await repo.consume(input.tokenHash, NOW);

    expect(record).toEqual({
      id,
      userId,
      integration: "meta",
      actionId: "meta.campaign.pause",
      paramsHash: "a".repeat(64),
      expiresAt: IN_TWO_MINUTES,
    });
    expect((await row(input.tokenHash))!.consumedAt!.toISOString()).toBe(NOW.toISOString());
  });

  it("refuses a second consume, and leaves the first one's record untouched", async () => {
    const repo = new RepositoryClass!(prisma!);
    const input = pending();
    await repo.create(input);

    await repo.consume(input.tokenHash, NOW);
    const again = await repo.consume(input.tokenHash, new Date(NOW.getTime() + 5_000));

    expect(again).toBeNull();
    expect((await row(input.tokenHash))!.consumedAt!.toISOString()).toBe(NOW.toISOString());
  });

  it("answers null for a token hash it has never seen", async () => {
    const repo = new RepositoryClass!(prisma!);
    expect(await repo.consume(hash(), NOW)).toBeNull();
  });

  it("refuses two confirmations for one token hash", async () => {
    const repo = new RepositoryClass!(prisma!);
    const input = pending();
    await repo.create(input);
    await expect(repo.create({ ...input, userId: otherUserId })).rejects.toThrow();
  });

  it("takes an expired confirmation out of play too — judging it is the caller's job", async () => {
    const repo = new RepositoryClass!(prisma!);
    const input = pending({ expiresAt: new Date(NOW.getTime() - 1) });
    await repo.create(input);

    const record = await repo.consume(input.tokenHash, NOW);

    expect(record!.expiresAt.getTime()).toBeLessThan(NOW.getTime());
    expect(await repo.consume(input.tokenHash, NOW)).toBeNull();
  });

  // The race. Twenty-five attempts, alternating between two connection pools,
  // released together. Repeated, because one lucky ordering proves nothing.
  it("lets exactly ONE of 25 simultaneous consumers win, across two instances", async () => {
    const instances = [new RepositoryClass!(prisma!), new RepositoryClass!(second!)];

    for (let round = 0; round < 8; round++) {
      const input = pending();
      await instances[0]!.create(input);

      const results = await Promise.all(
        Array.from({ length: 25 }, (_unused, attempt) =>
          instances[attempt % 2]!.consume(input.tokenHash, new Date(NOW.getTime() + attempt))
        )
      );

      const winners = results.filter((result) => result !== null);
      expect(winners, `round ${round}`).toHaveLength(1);
      expect(results.filter((result) => result === null), `round ${round}`).toHaveLength(24);
      expect((await row(input.tokenHash))!.consumedAt).not.toBeNull();
    }
  });

  it("is still there for a process that did not create it", async () => {
    const input = pending();

    // One process issues, then goes away entirely.
    const first = new Prisma!.PrismaClient();
    await new RepositoryClass!(first).create(input);
    await first.$disconnect();

    // Another — a restart, or a second instance — is asked to honour it.
    const afterRestart = new Prisma!.PrismaClient();
    try {
      const record = await new RepositoryClass!(afterRestart).consume(input.tokenHash, NOW);
      expect(record).toMatchObject({ userId, actionId: "meta.campaign.pause" });
    } finally {
      await afterRestart.$disconnect();
    }
  });

  it("deletes what expired before the cutoff, spent or not, and nothing later", async () => {
    const repo = new RepositoryClass!(prisma!);
    const cutoff = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const longGone = pending({ userId: otherUserId, expiresAt: new Date(cutoff.getTime() - 1) });
    const longGoneSpent = pending({ userId: otherUserId, expiresAt: new Date(cutoff.getTime() - 2) });
    const atCutoff = pending({ userId: otherUserId, expiresAt: cutoff });
    const live = pending({ userId: otherUserId });
    for (const input of [longGone, longGoneSpent, atCutoff, live]) await repo.create(input);
    await repo.consume(longGoneSpent.tokenHash, NOW);

    const removed = await repo.deleteExpiredBefore(cutoff);

    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await row(longGone.tokenHash)).toBeNull();
    expect(await row(longGoneSpent.tokenHash)).toBeNull();
    expect(await row(atCutoff.tokenHash)).not.toBeNull();
    expect(await row(live.tokenHash)).not.toBeNull();
  });

  it("goes when its user goes", async () => {
    const repo = new RepositoryClass!(prisma!);
    const leaving = await prisma!.user.create({
      data: {
        email: `phase13-leaving-${STAMP}@jarvis-test.local`,
        name: "Phase 13 leaving",
        password: "not-a-real-password-hash",
        role: "VIEWER",
      },
    });
    const input = pending({ userId: leaving.id });
    await repo.create(input);

    await prisma!.user.delete({ where: { id: leaving.id } });

    expect(await row(input.tokenHash)).toBeNull();
  });
});
