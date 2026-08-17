import type { PrismaClient } from "@prisma/client";
import type { IRefreshTokenRepository } from "@jarvis/core";

export class PrismaRefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private prisma: PrismaClient) {}

  async create(data: {
    userId: string;
    tokenHash: string;
    userAgent?: string;
    ipAddress?: string;
    expiresAt: Date;
  }) {
    const token = await this.prisma.refreshToken.create({
      data: {
        userId: data.userId,
        tokenHash: data.tokenHash,
        userAgent: data.userAgent,
        ipAddress: data.ipAddress,
        expiresAt: data.expiresAt,
      },
    });

    return { id: token.id };
  }

  async findByTokenHash(tokenHash: string) {
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!token) return null;

    return {
      id: token.id,
      userId: token.userId,
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
      revokedAt: token.revokedAt,
    };
  }

  async revoke(id: string): Promise<void> {
    await this.prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  async deleteExpired(): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    return result.count;
  }
}
