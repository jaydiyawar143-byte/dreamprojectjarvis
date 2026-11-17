import { z } from "zod";

// ---------------------------------------------------------------------------
// n8n Sandbox Service configuration
// ---------------------------------------------------------------------------
// A THIRD n8n surface, separate from the Public REST API (`api-client.ts`) and
// the MCP connector (`mcp-connector.ts`). It talks to a self-hosted
// `n8n-io/n8n-sandbox-service` deployment — never to n8n Cloud — and never
// starts a process on this host.
//
// The API key is a server-side credential. It is read here, kept on the client
// instance and sent only in the `X-Api-Key` header. It is never placed in a URL,
// a log line, an error message or a response.
//
// The service is CONFIGURED only when both the URL and the key are present.
// Nothing is registered by that fact alone: no route and no tool is wired to
// this service yet, so configuration cannot expose a command surface to a
// caller or to a model.
// ---------------------------------------------------------------------------

/** Timeout for one non-streaming request (create, read, delete, cancel). */
export const N8N_SANDBOX_DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const N8N_SANDBOX_MAX_REQUEST_TIMEOUT_MS = 120_000;

/** The Sandbox Service's own default for `timeout_ms` on an execution. */
export const N8N_SANDBOX_DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;

/**
 * The longest execution this client will ask for. The service has its own
 * ceiling and answers `400` above it; this one is the client's bound, chosen so
 * a single call cannot hold an API request open indefinitely.
 */
export const N8N_SANDBOX_MAX_EXECUTION_TIMEOUT_MS = 3_600_000;

/**
 * Extra time allowed after the server-side execution timeout before the client
 * aborts the stream. The server must have a chance to write its `exit` event
 * with `timed_out: true`; aborting at exactly `timeout_ms` would turn a real
 * timeout into a client-side stream failure.
 */
export const N8N_SANDBOX_EXECUTION_GRACE_MS = 30_000;

/** Collected stdout + stderr are bounded so one command cannot exhaust memory. */
export const N8N_SANDBOX_DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
export const N8N_SANDBOX_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const sandboxConfigSchema = z.object({
  apiUrl: z.string().url("N8N_SANDBOX_API_URL must be an absolute URL"),
  apiKey: z.string().min(1, "N8N_SANDBOX_API_KEY is required"),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(N8N_SANDBOX_MAX_REQUEST_TIMEOUT_MS)
    .default(N8N_SANDBOX_DEFAULT_REQUEST_TIMEOUT_MS),
  executionTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(N8N_SANDBOX_MAX_EXECUTION_TIMEOUT_MS)
    .default(N8N_SANDBOX_DEFAULT_EXECUTION_TIMEOUT_MS),
  maxOutputBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(N8N_SANDBOX_MAX_OUTPUT_BYTES)
    .default(N8N_SANDBOX_DEFAULT_MAX_OUTPUT_BYTES),
});

export type N8nSandboxConfig = z.infer<typeof sandboxConfigSchema>;

export interface N8nSandboxConfigInput {
  apiUrl?: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  executionTimeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Normalizes and confines the base URL.
 *
 * The URL is server configuration, never a caller value, but it is still
 * checked: credentials embedded in it would be a second secret in a place the
 * rest of the code does not treat as one, and a query or fragment cannot be
 * part of a base URL. Only http(s) is accepted; a self-hosted sandbox service
 * commonly sits on an internal network, so plain http is allowed rather than
 * silently requiring TLS.
 */
function normalizeSandboxApiUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("N8N_SANDBOX_API_URL must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("N8N_SANDBOX_API_URL must use http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("N8N_SANDBOX_API_URL must not contain credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("N8N_SANDBOX_API_URL must not contain a query or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

export function createN8nSandboxConfig(
  input: N8nSandboxConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): N8nSandboxConfig {
  const raw = {
    apiUrl: input.apiUrl ?? env.N8N_SANDBOX_API_URL,
    apiKey: input.apiKey ?? env.N8N_SANDBOX_API_KEY,
    requestTimeoutMs: input.requestTimeoutMs ?? env.N8N_SANDBOX_REQUEST_TIMEOUT_MS,
    executionTimeoutMs: input.executionTimeoutMs ?? env.N8N_SANDBOX_EXECUTION_TIMEOUT_MS,
    maxOutputBytes: input.maxOutputBytes ?? env.N8N_SANDBOX_MAX_OUTPUT_BYTES,
  };

  const result = sandboxConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([field, issues]) => `${field}: ${issues?.join(", ")}`)
      .join("; ");
    // Field NAMES only — the key's value is never repeated.
    throw new Error(`n8n Sandbox configuration error: ${messages}`);
  }

  let apiUrl: string;
  try {
    apiUrl = normalizeSandboxApiUrl(result.data.apiUrl);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "N8N_SANDBOX_API_URL is invalid";
    throw new Error(`n8n Sandbox configuration error: ${reason}`);
  }

  return { ...result.data, apiUrl };
}

/**
 * Whether this deployment has an n8n Sandbox Service to talk to.
 *
 * Presence is not permission and not exposure: the service builds an HTTP client
 * that nothing is wired to yet. Whether a route or a tool may ever call it is
 * decided separately, when one is added.
 */
export function isN8nSandboxConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.N8N_SANDBOX_API_URL?.trim() && env.N8N_SANDBOX_API_KEY?.trim());
}

/** A stable, value-free explanation for the startup log and diagnostics. */
export function describeN8nSandboxStatus(
  env: NodeJS.ProcessEnv = process.env
): { configured: boolean; reason: string } {
  if (!env.N8N_SANDBOX_API_URL?.trim() && !env.N8N_SANDBOX_API_KEY?.trim()) {
    return {
      configured: false,
      reason: "N8N_SANDBOX_API_URL and N8N_SANDBOX_API_KEY are not set",
    };
  }
  if (!env.N8N_SANDBOX_API_URL?.trim()) {
    return { configured: false, reason: "N8N_SANDBOX_API_URL is not set" };
  }
  if (!env.N8N_SANDBOX_API_KEY?.trim()) {
    return { configured: false, reason: "N8N_SANDBOX_API_KEY is not set" };
  }
  return { configured: true, reason: "n8n Sandbox Service configured" };
}
