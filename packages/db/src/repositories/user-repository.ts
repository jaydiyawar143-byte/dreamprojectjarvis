import type { PrismaClient } from "@prisma/client";
import type { IUserRepository } from "@jarvis/core";

export class PrismaUserRepository implements IUserRepository {
  constructor(private prisma: PrismaClient) {}

  async create(data: {
    email: string;
    name: string;
    password: string;
    role?: string;
  }) {
    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        password: data.password,
        role: (data.role?.toUpperCase() || "MEMBER") as "MEMBER",
      },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role.toLowerCase(),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async findByEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      password: user.password,
      role: user.role.toLowerCase(),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role.toLowerCase(),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }
}
