// ---------------------------------------------------------------------------
// Phase 10.6 — Startup recovery
//
// Idempotent recovery pass executed once at process startup (before the
// server begins accepting traffic). It reuses the Phase 10.2/10.5 durable
// recovery primitives — it performs NO external calls, NO retries of any
// execution and NEVER touches UNKNOWN records beyond what those primitives
// already guarantee:
//
//   - stale EXECUTING (expired lease)  → UNKNOWN   (ambiguous write safety)
//   - stale RECONCILING (expired lease) → UNKNOWN (re-eligible)
//
// Running it twice produces exactly the same state because both underlying
// operations are conditional single-statement transitions guarded by lease
// expiry; rows already recovered no longer match the stale predicate.
//
// Lives in core (dependency-free, operates purely on the journal port) so
// every host — API server, future workers, integration tests in any
// package — can run identical recovery without cross-package cycles.
// ---------------------------------------------------------------------------

import type {
  ExecutionJournalPort,
} from "./types/tool-execution.js";

export interface StartupRecoveryReport {
  /** Records moved EXECUTING → UNKNOWN by this pass. */
  staleExecutingRecovered: number;
  /** Records moved RECONCILING → UNKNOWN by this pass. */
  staleReconcilingRecovered: number;
  /** ISO timestamp of the pass. */
  at: string;
}

export async function runStartupRecovery(
  journal: Pick<
    ExecutionJournalPort,
    "recoverStaleExecutions" | "recoverStaleReconciliations"
  >
): Promise<StartupRecoveryReport> {
  const [executing, reconciling] = await Promise.all([
    journal.recoverStaleExecutions(),
    journal.recoverStaleReconciliations(),
  ]);

  return {
    staleExecutingRecovered: executing.recovered.length,
    staleReconcilingRecovered: reconciling.recovered.length,
    at: new Date().toISOString(),
  };
}
