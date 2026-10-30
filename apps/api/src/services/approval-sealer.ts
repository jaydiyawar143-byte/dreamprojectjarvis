// ---------------------------------------------------------------------------
// Phase 19, Stage 19.5 — the sealer the approval store is handed (S3).
//
// A browser or desktop approval is bound to its exact parameters, which may
// hold what a person typed — a password among them — and a URL whose query
// can carry a token. The approval record keeps only their value-free form; the
// parameters themselves are sealed with the deployment's encryption key, as
// every other secret at rest is (`EncryptionService`: AES-256-GCM envelopes,
// a key version, retired keys still read), and deleted once the approval can
// no longer run.
//
// No key, or a key that is not one: no sealer. The approval store then
// creates no browser or desktop approval at all — there is no weaker
// stand-in, and nothing is ever written in the clear instead.
// ---------------------------------------------------------------------------

import type { ApprovalParamsSealer } from "@jarvis/core";
import { EncryptionService } from "@jarvis/security";

export function createApprovalParamsSealer(env: NodeJS.ProcessEnv = process.env): ApprovalParamsSealer | null {
  if (!env.JARVIS_ENCRYPTION_KEY) return null;
  let encryption: EncryptionService;
  try {
    encryption = EncryptionService.fromEnv(env);
  } catch {
    return null;
  }
  return {
    seal: (plaintext) => encryption.encrypt(plaintext),
    unseal: (sealed) => encryption.decrypt(sealed),
  };
}
