import type { PrismaClient } from "@prisma/client";
import type {
  IGoogleConnectionRepository,
  GoogleConnectionSummary,
  GoogleCredentials,
  IOAuthStateRepository,
  OAuthStateRecord,
} from "@jarvis/core";
import type { EncryptionService } from "@jarvis/security";

// ---------------------------------------------------------------------------
// PrismaGoogleConnectionRepository (Sprint 5.2)
// ---------------------------------------------------------------------------
// The ONLY place Google tokens are encrypted or decrypted. Everything above
// this class deals in GoogleConnectionSummary, which structurally cannot carry
// token material — so a leak would have to be a deliberate new code path, not
// an oversight.
//
// A revoked connection is treated as absent by every read: getCredentials()
// returns null rather than expired-but-decryptable tokens.
// ---------------------------------------------------------------------------

/** Maps a row to the token-free summary handed to routes and services. */
function toSummary(row: {
  id: string;
  userId: string;
  googleAccountEmail: string;
  scopes: string[];
  createdAt: Date;
  accessTokenExpiresAt: Date;
  revokedAt: Date | null;
}): GoogleConnectionSummary {
  return {
    id: row.id,
    userId: row.userId,
    googleAccountEmail: row.googleAccountEmail,
    scopes: row.scopes,
    connectedAt: row.createdAt,
    expiresAt: row.accessTokenExpiresAt,
    revokedAt: row.revokedAt,
  };
}

export class PrismaGoogleConnectionRepository implements IGoogleConnectionRepository {
  constructor(
    private prisma: PrismaClient,
    private encryption: EncryptionService
  ) {}

  async save(input: {
    userId: string;
    googleAccountEmail: string;
    scopes: string[];
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }): Promise<GoogleConnectionSummary> {
    const accessTokenEnc = this.encryption.encrypt(input.accessToken);
    const refreshTokenEnc = this.encryption.encrypt(input.refreshToken);

    // Reconnecting the same Google account clears any prior revocation rather
    // than leaving a dead row that would shadow the new grant.
    const row = await this.prisma.googleConnection.upsert({
      where: {
        userId_googleAccountEmail: {
          userId: input.userId,
          googleAccountEmail: input.googleAccountEmail,
        },
      },
      create: {
        userId: input.userId,
        googleAccountEmail: input.googleAccountEmail,
        scopes: input.scopes,
        accessTokenEnc,
        refreshTokenEnc,
        encKeyVersion: this.encryption.keyVersion,
        accessTokenExpiresAt: input.expiresAt,
      },
      update: {
        scopes: input.scopes,
        accessTokenEnc,
        refreshTokenEnc,
        encKeyVersion: this.encryption.keyVersion,
        accessTokenExpiresAt: input.expiresAt,
        revokedAt: null,
      },
    });

    return toSummary(row);
  }

  async findByUser(userId: string): Promise<GoogleConnectionSummary | null> {
    const row = await this.prisma.googleConnection.findFirst({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return row ? toSummary(row) : null;
  }

  async getCredentials(userId: string): Promise<GoogleCredentials | null> {
    const row = await this.prisma.googleConnection.findFirst({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row) return null;

    return {
      accessToken: this.encryption.decrypt(row.accessTokenEnc),
      refreshToken: this.encryption.decrypt(row.refreshTokenEnc),
      expiresAt: row.accessTokenExpiresAt,
      scopes: row.scopes,
    };
  }

  async updateAccessToken(userId: string, accessToken: string, expiresAt: Date): Promise<void> {
    const row = await this.prisma.googleConnection.findFirst({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row) return;

    await this.prisma.googleConnection.update({
      where: { id: row.id },
      data: {
        accessTokenEnc: this.encryption.encrypt(accessToken),
        encKeyVersion: this.encryption.keyVersion,
        accessTokenExpiresAt: expiresAt,
      },
    });
  }

  async revoke(userId: string): Promise<void> {
    await this.prisma.googleConnection.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

// ---------------------------------------------------------------------------
// PrismaOAuthStateRepository — single-use CSRF/PKCE state
// ---------------------------------------------------------------------------

export class PrismaOAuthStateRepository implements IOAuthStateRepository {
  constructor(private prisma: PrismaClient) {}

  async create(record: OAuthStateRecord): Promise<void> {
    await this.prisma.oAuthState.create({
      data: {
        state: record.state,
        userId: record.userId,
        codeVerifier: record.codeVerifier,
        redirectUri: record.redirectUri,
        expiresAt: record.expiresAt,
      },
    });
  }

  /**
   * Consumes the state atomically. `delete` on the primary key either removes
   * exactly one row and returns it, or throws P2025 — so two concurrent
   * callbacks replaying one authorization code cannot both succeed.
   */
  async consume(state: string): Promise<OAuthStateRecord | null> {
    try {
      const row = await this.prisma.oAuthState.delete({ where: { state } });
      return {
        state: row.state,
        userId: row.userId,
        codeVerifier: row.codeVerifier,
        redirectUri: row.redirectUri,
        expiresAt: row.expiresAt,
      };
    } catch {
      return null;
    }
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.prisma.oAuthState.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}
