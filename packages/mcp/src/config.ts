// ---------------------------------------------------------------------------
// S8.2 — runtime bounds, and the environment a server process receives.
//
// Every bound is a fixed, conservative constant. Nothing here is configured at
// runtime and nothing is persisted.
// ---------------------------------------------------------------------------

import type { McpServerManifest } from "@jarvis/core";

export const MCP_RUNTIME = Object.freeze({
  /** Spawn, initialize, the full tools/list and verification — all of it. */
  connectTimeoutMs: 10_000,
  /** A ceiling for one call. ToolExecutor's own deadline is the authority above it. */
  callTimeoutMs: 30_000,
  /** One JSON-RPC message from a server. Anything larger stops the server. */
  maxMessageBytes: 1024 * 1024,
  /** tools/list pages read before a listing counts as runaway… */
  maxListPages: 10,
  /** …and tools it may hold across them. */
  maxListedTools: 200,
  /** Closing: stdin ends; SIGTERM after this long; SIGKILL after as long again. */
  closeGraceMs: 2_000,
  /** Consecutive failed starts that open a server's breaker… */
  breakerFailures: 3,
  /** …for this long; then a single probe start is let through. */
  breakerCooldownMs: 60_000,
});

/**
 * The server process's ENTIRE environment: each variable its reviewed
 * manifest maps, read from the server's own `JARVIS_MCP_<ID>_…` variable.
 * Nothing else is taken from the parent — no DATABASE_URL, no NODE_OPTIONS,
 * no PATH. A variable that is not set is left out.
 */
export function serverEnvironment(
  server: McpServerManifest,
  source: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const prefix = `JARVIS_MCP_${server.id.toUpperCase()}_`;
  const env: Record<string, string> = {};
  for (const [name, from] of Object.entries(server.env)) {
    // S8.1 already refuses any other mapping; this keeps it true unvalidated.
    const value = from.startsWith(prefix) ? source[from] : undefined;
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * S8.4 — MCP is off unless an operator sets JARVIS_MCP_ENABLED=true: exactly
 * "true", the repository's convention for switches (BROWSER_ENABLED). Off
 * means no tool registered, no connection built, no process started.
 */
export function isMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JARVIS_MCP_ENABLED === "true";
}
