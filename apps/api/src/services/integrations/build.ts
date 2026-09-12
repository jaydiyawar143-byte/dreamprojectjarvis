// ---------------------------------------------------------------------------
// Assembles the one IntegrationCommandService from real infrastructure.
//
// Separated from `container.ts` so the encryption boundary is visible in a
// short file rather than buried in eight hundred lines of wiring. The rule it
// implements:
//
//   THE ENCRYPTION KEY NEVER LEAVES THIS FILE.
//
// `IntegrationCommandService` receives a `CredentialPort` — four methods that
// take and return plain objects. It has no key, no `EncryptionService` and no
// Prisma client, so no future edit inside the command service can write a
// credential to the database unencrypted or read a ciphertext into a response.
// Sealing and unsealing happen in the two closures below and nowhere else.
//
// A deployment with no key gets `null` rather than a degraded service. Storing
// third-party secrets in plaintext is not an acceptable fallback, and a service
// that silently did so would be worse than an integrations page that explains
// why it is unavailable.
// ---------------------------------------------------------------------------

import {
  EncryptionService,
  type AuditLogger,
} from "@jarvis/security";
import {
  type PrismaClient,
  PrismaCredentialRepository,
  PrismaGoogleConnectionRepository,
  PrismaIntegrationStateRepository,
  PrismaOAuthStateRepository,
} from "@jarvis/db";
import { createGoogleConfig, isGoogleConfigured, type GoogleConfig } from "@jarvis/google-ads";
import type { IToolExecutor, IntegrationUsage } from "@jarvis/core";
import { DbBackedRateLimiter } from "../rate-limiter.js";
import { getMapsUsageGuard } from "../maps-usage-guard.js";
import { IntegrationCommandService, type CredentialPort } from "./command-service.js";

export interface BuildInput {
  prisma: PrismaClient;
  auditLogger: AuditLogger;
  /** The single execution authority. Integration actions are gated, then handed here. */
  executor?: IToolExecutor;
}

/**
 * Builds the command service, or null when secrets cannot be stored safely.
 */
export function buildIntegrationCommandService(
  input: BuildInput
): IntegrationCommandService | null {
  if (!process.env.JARVIS_ENCRYPTION_KEY) {
    console.log(
      JSON.stringify({
        level: "info",
        event: "integration_commands_disabled",
        reason: "JARVIS_ENCRYPTION_KEY is not set",
      })
    );
    return null;
  }

  const encryption = EncryptionService.fromEnv();
  const credentialRepo = new PrismaCredentialRepository(input.prisma);
  const stateRepo = new PrismaIntegrationStateRepository(input.prisma);

  /**
   * The encryption boundary.
   *
   * Plaintext exists only inside these three closures. Everything above them
   * sees plain objects; everything below them sees opaque envelopes.
   */
  const credentials: CredentialPort = {
    async read(userId, provider) {
      const envelope = await credentialRepo.get(userId, provider);
      if (!envelope) return null;
      try {
        return JSON.parse(encryption.decrypt(envelope)) as Record<string, string>;
      } catch {
        // A row that will not decrypt means the key was rotated or the value
        // was tampered with. Reported as absent to callers — which renders as
        // "not configured", the state that prompts the user to re-enter — and
        // logged WITHOUT the envelope, since ciphertext in a log is still a
        // thing an attacker with the key can use.
        console.log(
          JSON.stringify({
            level: "warn",
            event: "credential_decrypt_failed",
            provider,
          })
        );
        return null;
      }
    },
    async write(userId, provider, values) {
      await credentialRepo.put(userId, provider, encryption.encrypt(JSON.stringify(values)));
    },
    async remove(userId, provider) {
      await credentialRepo.remove(userId, provider);
    },
  };

  const googleConfig = (): GoogleConfig | null => {
    if (!isGoogleConfigured()) return null;
    try {
      return createGoogleConfig();
    } catch {
      // Misconfiguration must not take the API down. Google reports as
      // unconfigured and every Google verb explains what is missing.
      return null;
    }
  };

  const mapsUsage = async (): Promise<IntegrationUsage | null> => {
    const guard = getMapsUsageGuard();
    if (!guard) return null;
    try {
      const status = await guard.status();
      return {
        used: status.used,
        limit: status.limit,
        percentUsed: status.percentUsed,
        level: status.level,
        blocked: status.blocked,
      };
    } catch {
      // A counter that cannot be read is reported as ABSENT, never as zero. A
      // zero would read as "no usage" and hide exactly the problem worth seeing.
      return null;
    }
  };

  return new IntegrationCommandService({
    credentials,
    state: stateRepo,
    audit: input.auditLogger,
    // Counted in the same audit-backed window every other limiter uses, so the
    // limit holds across processes rather than per instance.
    rateLimiter: new DbBackedRateLimiter(input.auditLogger, "integration"),
    googleConnections: new PrismaGoogleConnectionRepository(input.prisma, encryption),
    oauthStates: new PrismaOAuthStateRepository(input.prisma),
    googleConfig,
    mapsUsage,
    ...(input.executor ? { executor: input.executor } : {}),
  });
}
