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
export {
  PrismaRecommendationRepository,
  DuplicateRecommendationError,
} from "./repositories/recommendation-repository.js";
export {
  PrismaOutcomeRepository,
  DuplicateOutcomeError,
  FinalizedOutcomeImmutableError,
} from "./repositories/outcome-repository.js";
export { PrismaKnowledgeRepository } from "./repositories/knowledge-repository.js";
export {
  PrismaGoogleConnectionRepository,
  PrismaOAuthStateRepository,
} from "./repositories/google-connection-repository.js";
export { PrismaWhatsAppRepository } from "./repositories/whatsapp-repository.js";
export { PrismaN8nRepository } from "./repositories/n8n-repository.js";

// UI V2 — per-user third-party credentials (encrypted envelopes at rest).
export { PrismaCredentialRepository, type StoredCredential } from "./repositories/credential-repository.js";

// V3 — Command Center: tasks/reminders and per-user dashboard preferences.
export {
  PrismaTaskRepository,
  type TaskRecord,
  type TaskPriority,
  type CreateTaskInput,
  type UpdateTaskInput,
} from "./repositories/task-repository.js";
export { PrismaPreferenceRepository } from "./repositories/preference-repository.js";
export {
  PrismaMapsUsageRepository,
  currentPeriod,
  type MapsService,
  type MapsServiceUsage,
  type MapsUserUsage,
} from "./repositories/maps-usage-repository.js";

// Per-user integration enable/disable, service selection and last-sync marker.
export {
  PrismaIntegrationStateRepository,
  type IntegrationState,
} from "./repositories/integration-state-repository.js";

// Phase 13 — durable confirmation state for external writes.
export { PrismaConfirmationRepository } from "./repositories/confirmation-repository.js";

// S7 Step 8 — the controlled Memory vector backfill. Operator-driven only
// (apps/api/scripts/s7-memory-backfill); nothing in the runtime calls it.
export {
  planMemoryVectorBackfill,
  applyMemoryVectorCastBatch,
  rollbackMemoryVectorCastBatch,
  reembedMemoryVectors,
  rollbackMemoryVectorReembed,
  BACKFILL_EMBEDDING_DIMENSIONS,
  SUSPICIOUS_SIMILARITY,
  SUSPICIOUS_MIN_GAP_SECONDS,
  type MemoryBackfillPlan,
  type MemoryBackfillScope,
  type MemoryVectorCastResult,
  type MemoryVectorCastRow,
  type MemoryVectorReembedResult,
  type MemoryVectorRollbackResult,
} from "./maintenance/memory-vector-backfill.js";
