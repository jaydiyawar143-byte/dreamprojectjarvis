// ---------------------------------------------------------------------------
// n8n Sandbox Service availability for this API.
//
// The package client (`@jarvis/n8n`) validates and owns the configuration. This
// loader exists for one reason: boot must never throw because an optional
// surface is misconfigured. It turns the package's two-way answer — configured
// or not, with a value-free reason — into a result the container can log.
//
// It deliberately has no enable flag. A self-hosted sandbox service is reached
// only when BOTH its URL and its API key are present; there is nothing else an
// operator has to remember to switch on. That is not exposure: the service is
// built into the container, and NO route, tool or agent is wired to it yet.
// ---------------------------------------------------------------------------

import {
  createN8nSandboxConfig,
  describeN8nSandboxStatus,
  type N8nSandboxConfig,
} from "@jarvis/n8n";

export type N8nSandboxConfigResult =
  | { enabled: false; reason: string }
  | { enabled: true; config: N8nSandboxConfig };

export function loadN8nSandboxConfig(
  env: NodeJS.ProcessEnv = process.env
): N8nSandboxConfigResult {
  const status = describeN8nSandboxStatus(env);
  if (!status.configured) return { enabled: false, reason: status.reason };

  try {
    return { enabled: true, config: createN8nSandboxConfig({}, env) };
  } catch (error) {
    // The package's configuration error names FIELDS, never values, so this
    // reason is safe to log. It still stays a stable sentence rather than the
    // raw error object.
    return {
      enabled: false,
      reason:
        error instanceof Error
          ? error.message
          : "n8n Sandbox configuration is invalid",
    };
  }
}
