// ---------------------------------------------------------------------------
// Correlatable identifiers for logs, without the identifiers.
//
// Debugging the approval lifecycle needs one thing above all: the ability to
// say "the id written at plan time is the same id read at execution time".
// That is a comparison, not a lookup — the actual value is never needed, only
// whether two of them match.
//
// So ids are logged as a short digest. Two log lines for the same approval
// carry the same token and can be lined up; a log that leaks is a list of
// digests rather than a list of user ids and approval ids.
//
// NOT A SECURITY BOUNDARY for low-entropy inputs. A digest of something
// guessable is reversible by trying the guesses, so this is for identifiers
// (uuids, cuids) and never for email addresses, tokens or content. Its purpose
// is to keep ordinary identifiers out of ordinary logs, which is where they
// actually accumulate.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/**
 * A short, stable, non-reversible token for one identifier.
 *
 * 12 hex characters: enough that two different ids in one debugging session
 * will not collide, short enough to read at a glance in a log line.
 */
export function hashForLog(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Whether two identifiers match, reported without revealing either.
 *
 * The single most useful fact when an approval is refused: was the id we were
 * handed the id we looked up?
 */
export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
  const ha = hashForLog(a);
  const hb = hashForLog(b);
  return ha !== null && ha === hb;
}
