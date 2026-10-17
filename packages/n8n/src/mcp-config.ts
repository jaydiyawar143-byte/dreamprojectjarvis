import { z } from "zod";

// ---------------------------------------------------------------------------
// n8n MCP configuration (S8.7)
// ---------------------------------------------------------------------------
// Mirrors config.ts: every value is server-side and nothing here reaches a
// browser. This is the SECOND n8n surface — the MCP server, beside the REST API
// the api-client.ts module speaks.
//
// THE ENDPOINT IS DERIVED, NOT HARD-CODED. n8n Cloud serves its MCP server from
// `<baseUrl>/mcp-server/http`, so the default is built from N8N_BASE_URL rather
// than baked in. A self-hosted or differently-mounted instance overrides it with
// N8N_MCP_ENDPOINT — business logic never names a host.
//
// THE TOKEN IS A SEPARATE SECRET from N8N_API_KEY, and it is NOT the REST API
// key. n8n's instance-level MCP server authenticates a client either by OAuth
// 2.1 (its recommended flow) or by a personal access token sent as
// `Authorization: Bearer` — the "API key" tab in n8n's "Connect a client"
// dialog, available since n8n 2.33. A REST API key is not accepted as an MCP
// token. This module implements the bearer path only, and keeps the token under
// its own name (N8N_MCP_TOKEN) so the two can never be confused for one
// another. Live-verified 2026-10-16: "n8n MCP Server" v1.2.0 answered a bearer
// `tools/list` with 58 tools.
//
// OFF UNLESS SWITCHED ON. `N8N_MCP_ENABLED` must be exactly "true" — the
// repository's convention for a switch (BROWSER_ENABLED, JARVIS_MCP_ENABLED).
// Off means no connection is built and no discovery is attempted.
// ---------------------------------------------------------------------------

/** Default per-operation ceiling for an MCP call or a listing page. */
export const N8N_MCP_DEFAULT_TIMEOUT_MS = 15_000;

/** Where n8n mounts its MCP server, relative to the instance base URL. */
export const N8N_MCP_ENDPOINT_PATH = "/mcp-server/http";

export interface N8nMcpConfig {
  /** The MCP endpoint. HTTPS, with no embedded credentials. */
  endpoint: string;
  /** The bearer token, or null when none is configured. Never logged. */
  token: string | null;
  timeoutMs: number;
  /**
   * Origins the endpoint may belong to. The n8n base origin is always included;
   * a self-hosted deployment that serves MCP elsewhere adds its own.
   */
  allowedOrigins: readonly string[];
}

export interface N8nMcpConfigInput {
  baseUrl?: string;
  endpoint?: string;
  token?: string | null;
  timeoutMs?: number;
  allowedOrigins?: readonly string[];
}

const n8nMcpConfigSchema = z.object({
  endpoint: z.string().url("N8N_MCP_ENDPOINT must be an absolute URL"),
  token: z.string().min(1).nullable().default(null),
  timeoutMs: z.coerce.number().positive().max(120000).default(N8N_MCP_DEFAULT_TIMEOUT_MS),
});

/**
 * The MCP endpoint for an instance: the explicit override, or n8n's standard
 * mount under the base URL. Never returns a value that is not absolute.
 */
export function resolveN8nMcpEndpoint(baseUrl: string | undefined, endpoint?: string): string | null {
  if (typeof endpoint === "string" && endpoint.trim().length > 0) return endpoint.trim();
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) return null;
  const base = baseUrl.trim().replace(/\/+$/, "");
  try {
    return new URL(`${base}${N8N_MCP_ENDPOINT_PATH}`).toString();
  } catch {
    return null;
  }
}

/** Parses the comma-separated origin override. Blank entries are dropped. */
function parseOrigins(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** `https://host` for a URL string, or null when it is not an absolute URL. */
function originOf(url: string | undefined): string | null {
  if (typeof url !== "string" || url.trim().length === 0) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * Builds and validates the MCP configuration.
 *
 * A missing base URL and no explicit endpoint is an error: there is nothing to
 * discover, and a caller asking for the config wants the problem named rather
 * than an empty endpoint that 401s later. A missing token is NOT an error — the
 * config is still usable, and discovery will report AUTH_FAILURE honestly.
 */
export function createN8nMcpConfig(input: N8nMcpConfigInput = {}): N8nMcpConfig {
  const baseUrl = input.baseUrl ?? process.env.N8N_BASE_URL;
  const endpointRaw = input.endpoint ?? process.env.N8N_MCP_ENDPOINT;
  const endpoint = resolveN8nMcpEndpoint(baseUrl, endpointRaw);
  if (endpoint === null) {
    throw new Error("n8n MCP configuration error: N8N_BASE_URL or N8N_MCP_ENDPOINT is required");
  }

  const tokenRaw = input.token ?? process.env.N8N_MCP_TOKEN ?? null;
  const timeoutRaw = input.timeoutMs ?? process.env.N8N_MCP_TIMEOUT_MS;
  const originsRaw = input.allowedOrigins ?? parseOrigins(process.env.N8N_MCP_ALLOWED_ORIGINS);

  const result = n8nMcpConfigSchema.safeParse({
    endpoint,
    token: typeof tokenRaw === "string" && tokenRaw.length > 0 ? tokenRaw : null,
    timeoutMs: timeoutRaw,
  });
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([k, v]) => `${k}: ${v?.join(", ")}`)
      .join("; ");
    // Field NAMES only — the values are secrets.
    throw new Error(`n8n MCP configuration error: ${messages}`);
  }

  // The base origin is always allowed, so the default endpoint is never refused
  // by the containment check; any extra origin is explicit.
  const allowed = new Set<string>();
  const baseOrigin = originOf(baseUrl);
  if (baseOrigin) allowed.add(baseOrigin);
  for (const origin of originsRaw) {
    const parsed = originOf(origin) ?? origin;
    allowed.add(parsed);
  }

  return {
    endpoint: result.data.endpoint,
    token: result.data.token,
    timeoutMs: result.data.timeoutMs,
    allowedOrigins: [...allowed].sort(),
  };
}

/**
 * MCP is off unless an operator sets N8N_MCP_ENABLED=true — exactly "true".
 * Off means no connection, no discovery, no tool.
 */
export function isN8nMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.N8N_MCP_ENABLED === "true";
}

/**
 * Whether the MCP surface is set up: switched on, with an endpoint and a token.
 * This is CONFIGURATION, not health — being set up says nothing about whether
 * the token is accepted. That question is answered by a real discovery, and the
 * two must never be collapsed into one another.
 */
export function isN8nMcpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isN8nMcpEnabled(env)) return false;
  const endpoint = resolveN8nMcpEndpoint(env.N8N_BASE_URL, env.N8N_MCP_ENDPOINT);
  return endpoint !== null && typeof env.N8N_MCP_TOKEN === "string" && env.N8N_MCP_TOKEN.length > 0;
}
