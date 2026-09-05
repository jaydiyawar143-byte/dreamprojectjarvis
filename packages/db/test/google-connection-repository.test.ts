import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { EncryptionService, parseKey } from "@jarvis/security";
import {
  PrismaGoogleConnectionRepository,
  PrismaOAuthStateRepository,
} from "../src/repositories/google-connection-repository.js";

// ---------------------------------------------------------------------------
// Sprint 5.2 — Google connection persistence against real PostgreSQL.
//
// Follows the established convention in this package: probe at module scope so
// describe.skipIf() can decide during collection, and clean up every row the
// suite creates. Skips automatically when the database is unreachable.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

const encryption = new EncryptionService([parseKey(1, randomBytes(32).toString("base64"))]);
let userA: string | null = null;
let userB: string | null = null;

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `sprint52-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@jarvis-test.local`,
      name: `Sprint 5.2 ${label}`,
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  return user.id;
}

beforeAll(async () => {
  if (!dbUp) return;
  userA = await makeUser("a");
  userB = await makeUser("b");
});

afterAll(async () => {
  // FK cascade removes GoogleConnection and OAuthState rows with the user.
  for (const id of [userA, userB]) {
    if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe.skipIf(!dbUp)("Sprint 5.2 — PrismaGoogleConnectionRepository", () => {
  const repo = () => new PrismaGoogleConnectionRepository(prisma, encryption);

  beforeEach(async () => {
    // Each test starts from a clean slate for both users.
    await prisma.googleConnection.deleteMany({
      where: { userId: { in: [userA!, userB!] } },
    });
  });

  const input = (userId: string) => ({
    userId,
    googleAccountEmail: "ads-owner@example.com",
    scopes: ["https://www.googleapis.com/auth/adwords", "openid", "email"],
    accessToken: "ya29.persisted-access-token",
    refreshToken: "1//persisted-refresh-token",
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  it("persists tokens as ciphertext, never as plaintext", async () => {
    await repo().save(input(userA!));

    // Read the raw row, bypassing the repository, to prove what is on disk.
    const row = await prisma.googleConnection.findFirstOrThrow({ where: { userId: userA! } });
    expect(row.accessTokenEnc).not.toContain("ya29.persisted-access-token");
    expect(row.refreshTokenEnc).not.toContain("1//persisted-refresh-token");
    expect(row.accessTokenEnc.startsWith("v1:")).toBe(true);
    expect(row.encKeyVersion).toBe(1);
  });

  it("round-trips credentials through decryption", async () => {
    await repo().save(input(userA!));
    const creds = await repo().getCredentials(userA!);

    expect(creds).not.toBeNull();
    expect(creds!.accessToken).toBe("ya29.persisted-access-token");
    expect(creds!.refreshToken).toBe("1//persisted-refresh-token");
    expect(creds!.scopes).toContain("https://www.googleapis.com/auth/adwords");
  });

  it("returns a summary that structurally cannot carry tokens", async () => {
    await repo().save(input(userA!));
    const summary = await repo().findByUser(userA!);

    expect(summary).not.toBeNull();
    expect(summary!.googleAccountEmail).toBe("ads-owner@example.com");
    const blob = JSON.stringify(summary);
    expect(blob).not.toContain("ya29.");
    expect(blob).not.toContain("1//");
    expect(blob).not.toContain("Enc");
  });

  it("isolates connections between users", async () => {
    await repo().save(input(userA!));

    expect(await repo().findByUser(userB!)).toBeNull();
    expect(await repo().getCredentials(userB!)).toBeNull();
  });

  it("upserts rather than duplicating on reconnect", async () => {
    await repo().save(input(userA!));
    await repo().save({ ...input(userA!), accessToken: "ya29.second-grant" });

    const rows = await prisma.googleConnection.findMany({ where: { userId: userA! } });
    expect(rows).toHaveLength(1);
    expect((await repo().getCredentials(userA!))!.accessToken).toBe("ya29.second-grant");
  });

  it("updates the access token while preserving the refresh token", async () => {
    await repo().save(input(userA!));
    const newExpiry = new Date(Date.now() + 7_200_000);
    await repo().updateAccessToken(userA!, "ya29.refreshed", newExpiry);

    const creds = await repo().getCredentials(userA!);
    expect(creds!.accessToken).toBe("ya29.refreshed");
    // The refresh token is the durable half and must survive a rotation.
    expect(creds!.refreshToken).toBe("1//persisted-refresh-token");
    expect(creds!.expiresAt.getTime()).toBeCloseTo(newExpiry.getTime(), -3);
  });

  it("treats a revoked connection as absent", async () => {
    await repo().save(input(userA!));
    await repo().revoke(userA!);

    expect(await repo().getCredentials(userA!)).toBeNull();
    expect(await repo().findByUser(userA!)).toBeNull();
    // The row survives for audit purposes, but is stamped revoked.
    const row = await prisma.googleConnection.findFirstOrThrow({ where: { userId: userA! } });
    expect(row.revokedAt).not.toBeNull();
  });

  it("clears revocation when the user reconnects", async () => {
    await repo().save(input(userA!));
    await repo().revoke(userA!);
    await repo().save({ ...input(userA!), accessToken: "ya29.reconnected" });

    const creds = await repo().getCredentials(userA!);
    expect(creds).not.toBeNull();
    expect(creds!.accessToken).toBe("ya29.reconnected");
  });

  it("fails loudly when the key cannot decrypt a stored row", async () => {
    await repo().save(input(userA!));

    const wrongKey = new PrismaGoogleConnectionRepository(
      prisma,
      new EncryptionService([parseKey(1, randomBytes(32).toString("base64"))])
    );
    // Silently returning null here would look like "not connected" and send the
    // user through a reconnect that cannot fix a key-management error.
    await expect(wrongKey.getCredentials(userA!)).rejects.toThrow(/authentication/i);
  });
});

describe.skipIf(!dbUp)("Sprint 5.2 — PrismaOAuthStateRepository", () => {
  const repo = () => new PrismaOAuthStateRepository(prisma);

  const record = (state: string) => ({
    state,
    userId: userA!,
    codeVerifier: "verifier-value",
    redirectUri: "https://jarvis.test/cb",
    expiresAt: new Date(Date.now() + 600_000),
  });

  beforeEach(async () => {
    await prisma.oAuthState.deleteMany({ where: { userId: { in: [userA!, userB!] } } });
  });

  it("stores and consumes a state exactly once", async () => {
    await repo().create(record("state-single-use"));

    const first = await repo().consume("state-single-use");
    expect(first).not.toBeNull();
    expect(first!.codeVerifier).toBe("verifier-value");
    expect(first!.userId).toBe(userA);

    // The replay attempt finds nothing — this is what blocks a reused code.
    expect(await repo().consume("state-single-use")).toBeNull();
  });

  it("returns null for an unknown state rather than throwing", async () => {
    expect(await repo().consume("never-issued")).toBeNull();
  });

  it("deletes expired states", async () => {
    await repo().create({ ...record("state-expired"), expiresAt: new Date(Date.now() - 1000) });
    await repo().create(record("state-fresh"));

    const removed = await repo().deleteExpired(new Date());
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await repo().consume("state-expired")).toBeNull();
    expect(await repo().consume("state-fresh")).not.toBeNull();
  });

  it("binds the state to the initiating user", async () => {
    await repo().create({ ...record("state-bound"), userId: userB! });
    const consumed = await repo().consume("state-bound");
    // The callback trusts this field to decide whose account gets connected.
    expect(consumed!.userId).toBe(userB);
  });
});
