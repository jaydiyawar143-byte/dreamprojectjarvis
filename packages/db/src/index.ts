import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "@prisma/client";
export { PrismaApprovalRepository } from "./repositories/approval-repository.js";
export { PrismaAuditRepository } from "./repositories/audit-repository.js";
export { PrismaUserRepository } from "./repositories/user-repository.js";
export { PrismaRefreshTokenRepository } from "./repositories/refresh-token-repository.js";
export { PrismaConversationRepository } from "./repositories/conversation-repository.js";
export type { CreateConversationInput, AddMessageInput } from "./repositories/conversation-repository.js";
export { PrismaMemoryRepository } from "./repositories/memory-repository.js";
export { PrismaToolExecutionRepository } from "./repositories/tool-execution-repository.js";
