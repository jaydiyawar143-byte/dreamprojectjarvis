// Phase 13 — a write confirmation is durable, on the REAL production wiring
// and PostgreSQL.
//
//   buildIntegrationCommandService  (the function the container calls)
//     → IntegrationCommandService   → confirmation service
//     → PrismaConfirmationRepository → the "Confirmation" table
//
// Nothing between the command and the database is a double. The only fake is
// the execution authority, which records what reached it and runs nothing, so
// no provider is ever called.
//
// What is proven here and cannot be proven without a database:
//   - a confirmation issued by one process is honoured by another (a restart,
//     or a second API instance);
//   - of many simultaneous confirms — across two instances — the write runs
//     exactly once;
//   - a spent, expired or unknown confirmation never runs the write;
//   - the table never holds the token or anything the user typed.
//
// SAFETY. DATABASE_URL is read BEFORE anything imports the Prisma client. The
// suite runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
import { createHash } from "node:crypto";
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import type { IToolExecutor, IntegrationCommandResult } from "@jarvis/core";
import { AuditLogger, generateKey } from "@jarvis/security";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

type Db = typeof import("@jarvis/db");
type Build = typeof import("../src/services/integrations/build.js");
type Client = InstanceType<Db["PrismaClient"]>;

let db: Db | null = null;
let build: Build | null = null;
let prisma: Client | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  db = await import("@jarvis/db");
  build = await import("../src/services/integrations/build.js");
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
const previousKey = process.env.JARVIS_ENCRYPTION_KEY;

// Two connection pools, shared by the suite: two API instances. Kept to two so
// this file adds as little load as it can to the database the other
// PostgreSQL suites are using at the same time.
let poolOne: Client | null = null;
let poolTwo: Client | null = null;

async function newUser(tag: string): Promise<string> {
  const user = await prisma!.user.create({
    data: {
      email: `phase13-api-${tag}-${STAMP}@jarvis-test.local`,
      name: `Phase 13 ${tag}`,
      password: "not-a-real-password-hash",
      role: "ADMIN",
    },
  });
  userIds.push(user.id);
  return user.id;
}

/** One API instance over the given connection pool, recording what reaches the executor. */
function instance(
  executed: Array<{ toolId: string; params: Record<string, unknown> }>,
  client: Client = poolOne!
) {
  const executor: IToolExecutor = {
    async execute(request) {
      executed.push({ toolId: request.toolId, params: request.params });
      return {
        executionId: `exec-${executed.length}`,
        toolId: request.toolId,
        status: "completed",
        result: { success: true, data: { done: true } },
        startedAt: new Date(),
        completedAt: new Date(),
      };
    },
  };
  const service = build!.buildIntegrationCommandService({
    prisma: client,
    auditLogger: new AuditLogger(new db!.PrismaAuditRepository(client)),
    executor,
  });
  if (!service) throw new Error("the command service was not built");
  return { service, client };
}

const pause = (campaignId: string, confirmationToken?: string) => ({
  command: "executeAction" as const,
  integration: "meta" as const,
  actionId: "meta.campaign.pause",
  actionParams: { campaignId },
  ...(confirmationToken ? { confirmationToken } : {}),
});

const frontend = (userId: string) => ({ userId, source: "frontend" as const });

const tokenOf = (result: IntegrationCommandResult): string => {
  const confirmation = (result as { confirmationRequired?: { token: string } }).confirmationRequired;
  if (!confirmation) throw new Error(`no confirmation was issued: ${JSON.stringify(result)}`);
  return confirmation.token;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Stores Meta credentials for the user, so the action reaches the write gate. */
async function connectMeta(service: ReturnType<typeof instance>["service"], userId: string) {
  const configured = await service.execute(
    {
      command: "configure",
      integration: "meta",
      config: { accessToken: "phase13-test-access-token", adAccountId: "act_1300000013" },
    },
    frontend(userId)
  );
  if (!configured.ok) throw new Error(`could not configure meta: ${configured.message}`);
}

beforeAll(() => {
  if (!dbUp) return;
  poolOne = new db!.PrismaClient();
  poolTwo = new db!.PrismaClient();
  // The builder refuses to exist without a key; this one is generated here and
  // encrypts only this suite's throwaway credentials.
  process.env.JARVIS_ENCRYPTION_KEY = generateKey();
  // The real audit logger prints one line per command.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (previousKey === undefined) delete process.env.JARVIS_ENCRYPTION_KEY;
  else process.env.JARVIS_ENCRYPTION_KEY = previousKey;

  if (prisma && userIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userSetting.deleteMany({ where: { userId: { in: userIds } } });
    // Confirmations cascade from the user.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await poolOne?.$disconnect().catch(() => undefined);
  await poolTwo?.$disconnect().catch(() => undefined);
  await prisma?.$disconnect();
});

describe.skipIf(!dbUp)("Phase 13 — durable write confirmation (PostgreSQL)", () => {
  it("records the confirmation in PostgreSQL, without the token or what the user typed", async () => {
    const executed: Array<{ toolId: string; params: Record<string, unknown> }> = [];
    const { service } = instance(executed);
    const userId = await newUser("stored");
    await connectMeta(service, userId);

    const asked = await service.execute(pause("campaign-SECRET-NAME-77"), frontend(userId));

    expect(asked.ok).toBe(false);
    expect((asked as { code: string }).code).toBe("CONFIRMATION_REQUIRED");
    const token = tokenOf(asked);

    const rows = await prisma!.confirmation.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tokenHash: sha256(token),
      integration: "meta",
      actionId: "meta.campaign.pause",
      consumedAt: null,
    });
    const lifetime = rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime();
    expect(lifetime).toBeGreaterThan(110_000);
    expect(lifetime).toBeLessThan(130_000);

    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain("campaign-SECRET-NAME-77");
    expect(executed).toHaveLength(0);
  });

  it("is honoured after a restart: one process asks, another one confirms", async () => {
    const executed: Array<{ toolId: string; params: Record<string, unknown> }> = [];
    const userId = await newUser("restart");

    // The process that asked the question...
    const before = instance(executed, new db!.PrismaClient());
    await connectMeta(before.service, userId);
    const token = tokenOf(await before.service.execute(pause("campaign-R"), frontend(userId)));
    // ...is gone: its connections are closed and its memory with them.
    await before.client.$disconnect();

    // A new process — nothing in common but the database.
    const after = instance(executed, new db!.PrismaClient());
    let confirmed: IntegrationCommandResult;
    try {
      confirmed = await after.service.execute(pause("campaign-R", token), frontend(userId));
    } finally {
      await after.client.$disconnect();
    }

    expect(confirmed.ok).toBe(true);
    expect(executed).toEqual([{ toolId: "meta.campaign.pause", params: { campaignId: "campaign-R" } }]);
    const row = await prisma!.confirmation.findUnique({ where: { tokenHash: sha256(token) } });
    expect(row!.consumedAt).not.toBeNull();
  });

  it("runs the write exactly once when the same confirmation is sent twice", async () => {
    const executed: Array<{ toolId: string; params: Record<string, unknown> }> = [];
    const { service } = instance(executed);
    const userId = await newUser("duplicate");
    await connectMeta(service, userId);
    const token = tokenOf(await service.execute(pause("campaign-D"), frontend(userId)));

    const first = await service.execute(pause("campaign-D", token), frontend(userId));
    const second = await service.execute(pause("campaign-D", token), frontend(userId));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect((second as { code: string }).code).toBe("CONFIRMATION_REQUIRED");
    expect((second as { message: string }).message).toMatch(/not recognised/i);
    expect(executed).toHaveLength(1);
  });

  it("runs the write exactly ONCE for 20 simultaneous confirms across two instances", async () => {
    const executed: Array<{ toolId: string; params: Record<string, unknown> }> = [];
    const one = instance(executed, poolOne!);
    const two = instance(executed, poolTwo!);
    const userId = await newUser("race");
    await connectMeta(one.service, userId);
    const token = tokenOf(await one.service.execute(pause("campaign-X"), frontend(userId)));

    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_unused, attempt) =>
        (attempt % 2 === 0 ? one : two).service.execute(pause("campaign-X", token), frontend(userId))
      )
    );

    const succeeded = attempts.filter((attempt) => attempt.ok);
    const refused = attempts.filter((attempt) => !attempt.ok);
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(19);
    for (const attempt of refused) {
      expect((attempt as { code: string }).code).toBe("CONFIRMATION_REQUIRED");
    }
    // The execution authority was reached once, not nineteen times too many.
    expect(executed).toHaveLength(1);
  });

  it("refuses an expired confirmation, and the expiry it reads is the stored one", async () => {
    const executed: Array<{ toolId: string; params: Record<string, unknown> }> = [];
    const { service } = instance(executed);
    const userId = await newUser("expired");
    await connectMeta(service, userId);
    const token = tokenOf(await service.execute(pause("campaign-E"), frontend(userId)));

    // Two minutes pass.
    await prisma!.confirmation.update({
      where: { tokenHash: sha256(token) },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const late = await service.execute(pause("campaign-E", token), frontend(userId));
    expect(late.ok).toBe(false);
    expect((late as { message: string }).message).toMatch(/has expired/i);

    // And it does not come back to life for a second try.
    const again = await service.execute(pause("campaign-E", token), frontend(userId));
    expect(again.ok).toBe(false);
    expect(executed).toHaveLength(0);
  });

  it("refuses a token that was never issued", async () => {
    const executed: Array<{ toolId: string; params: Record<string, unknown> }> = [];
    const { service } = instance(executed);
    const userId = await newUser("unknown");
    await connectMeta(service, userId);

    const result = await service.execute(pause("campaign-U", "made-up-token"), frontend(userId));

    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/not recognised/i);
    expect(executed).toHaveLength(0);
  });

  it("cannot be replayed for another target or by another user, and is spent by the attempt", async () => {
    const executed: Array<{ toolId: string; params: Record<string, unknown> }> = [];
    const { service } = instance(executed);
    const owner = await newUser("owner");
    const other = await newUser("other");
    await connectMeta(service, owner);
    await connectMeta(service, other);

    // Confirmed for campaign A, presented for campaign B.
    const forA = tokenOf(await service.execute(pause("campaign-A"), frontend(owner)));
    const replay = await service.execute(pause("campaign-B", forA), frontend(owner));
    expect(replay.ok).toBe(false);
    expect((replay as { message: string }).message).toMatch(/different action or different parameters/i);
    // The misuse spent it: even the right call is refused now.
    expect((await service.execute(pause("campaign-A", forA), frontend(owner))).ok).toBe(false);

    // Issued to one user, presented by another.
    const forOwner = tokenOf(await service.execute(pause("campaign-A"), frontend(owner)));
    const stolen = await service.execute(pause("campaign-A", forOwner), frontend(other));
    expect(stolen.ok).toBe(false);

    expect(executed).toHaveLength(0);
  });
});
