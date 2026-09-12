// ---------------------------------------------------------------------------
// One place the command service reads deployment configuration from.
//
// Every one of these is a PRESENCE check, never a value read. The command
// service asks "is a server key set?" and gets a boolean; it has no function
// available to it that returns the key itself. That is what keeps a secret from
// reaching a response by accident — not care at the call site, but the absence
// of any call that could do it.
//
// Re-exported through this module rather than imported from four packages
// directly so that the set of environment facts the integration layer depends
// on is enumerable by reading one file.
// ---------------------------------------------------------------------------

export {
  createGoogleMapsConfig,
  describeGoogleMapsStatus,
  isGoogleMapsBrowserConfigured,
  isGoogleMapsServerConfigured,
} from "@jarvis/config";

export { isWhatsAppConfigured, createWhatsAppConfig } from "@jarvis/whatsapp";
export { isN8nConfigured, createN8nConfig } from "@jarvis/n8n";

/**
 * The monthly Maps request ceiling.
 *
 * Mirrors `maps-usage-guard.ts`, which owns the counter. Duplicated as a READ
 * here rather than imported, because the guard is optional — it is only
 * installed when a database is present — and the configuration view must still
 * be able to report the configured ceiling on a deployment without one.
 */
export function googleMapsMonthlyLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.GOOGLE_MAPS_MONTHLY_LIMIT;
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
