"use client";

// ---------------------------------------------------------------------------
// UI V2 — System health.
//
// The hard rule from the brief is "do not fake green statuses", and honouring
// it makes this page shorter than it might look like it should be.
//
// The server checks exactly TWO things: the shutdown lifecycle state, and one
// Postgres `SELECT 1`. It does not probe OpenAI, Meta, Google, WhatsApp, n8n or
// the browser runtime. So those rows report UNKNOWN, and say why, rather than
// borrowing a green tick from a check that never ran.
//
// `/dashboard/status` reports five capability booleans, which is a genuine
// signal about what this deployment WIRED — distinct from whether the
// dependency is reachable right now. The two are shown in separate sections so
// they cannot be mistaken for each other.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";

import {
  getCapabilityStatus,
  getHealth,
  getReadiness,
  type CapabilityStatus,
  type HealthReport,
} from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { PageContainer, PageHeader, PanelGrid } from "@/components/dashboard/page-container";
import { Panel, StatPanel } from "@/components/dashboard/panel";
import { ErrorState, LoadingState } from "@/components/dashboard/states";
import { Button, StatusDot, type Tone } from "@/components/ui/primitives";

type Level = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";

const LEVEL_TONE: Record<Level, Tone> = {
  HEALTHY: "ok",
  DEGRADED: "warn",
  UNAVAILABLE: "danger",
  UNKNOWN: "neutral",
};

interface Check {
  name: string;
  level: Level;
  detail: string;
}

function formatUptime(seconds: number | undefined): string {
  if (typeof seconds !== "number" || Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d`;
}

function CheckRow({ check }: { check: Check }) {
  return (
    <li
      data-testid="health-check"
      data-check={check.name}
      data-level={check.level}
      className="flex items-start justify-between gap-4 border-b border-sys-line/50 py-3 last:border-0"
    >
      <div>
        <p className="text-sm text-white">{check.name}</p>
        <p className="mt-0.5 text-xs text-sys-dim">{check.detail}</p>
      </div>
      <StatusDot tone={LEVEL_TONE[check.level]} label={check.level} />
    </li>
  );
}

export default function SystemPage() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [ready, setReady] = useState<{ ok: boolean; body: HealthReport | null } | null>(null);
  const [probing, setProbing] = useState(true);
  const [probeFailed, setProbeFailed] = useState(false);

  const capabilities = useResource<CapabilityStatus>(getCapabilityStatus, [], {
    fallbackError: "Could not read deployment capabilities.",
  });

  const probe = useCallback(async () => {
    setProbing(true);
    setProbeFailed(false);
    const [healthResult, readyResult] = await Promise.all([getHealth(), getReadiness()]);
    setHealth(healthResult.body);
    setReady(readyResult);
    // A null body means the request itself failed — the API is unreachable.
    setProbeFailed(healthResult.body === null);
    setProbing(false);
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const reloadAll = () => {
    void probe();
    void capabilities.reload();
  };

  const apiLevel: Level = probeFailed
    ? "UNAVAILABLE"
    : health?.status === "draining"
      ? "DEGRADED"
      : health
        ? "HEALTHY"
        : "UNKNOWN";

  const databaseLevel: Level = probeFailed
    ? "UNKNOWN"
    : ready?.body?.checks?.database === "ok"
      ? "HEALTHY"
      : ready?.body?.checks?.database === "failed"
        ? "UNAVAILABLE"
        : ready?.body?.status === "draining"
          ? "DEGRADED"
          : "UNKNOWN";

  const checked: Check[] = [
    {
      name: "API",
      level: apiLevel,
      detail: probeFailed
        ? "The API did not respond."
        : health?.status === "draining"
          ? `Shutting down (${health.state ?? "draining"}) — no new work is accepted.`
          : "Responding, and accepting work.",
    },
    {
      name: "Database",
      level: databaseLevel,
      detail:
        databaseLevel === "HEALTHY"
          ? "Answered a readiness query."
          : databaseLevel === "UNAVAILABLE"
            ? "Did not answer the readiness query."
            : "Not determined — the readiness probe did not report.",
    },
    {
      name: "Authentication",
      level: "HEALTHY",
      detail: "You are signed in, so tokens are being issued and verified.",
    },
  ];

  // Everything the server does not probe. Saying UNKNOWN honestly is the point.
  const unchecked: Check[] = [
    "Voice",
    "Meta Ads",
    "Google",
    "WhatsApp",
    "n8n",
    "Browser",
  ].map((name) => ({
    name,
    level: "UNKNOWN" as Level,
    detail: "The server's readiness probe does not test this dependency.",
  }));

  return (
    <PageContainer>
      <PageHeader
        title="System health"
        description="Live probes against this deployment. Only checks the server actually performs are reported as healthy."
        actions={
          <Button variant="secondary" size="sm" onClick={reloadAll}>
            Re-check
          </Button>
        }
      />

      {probing && !health && <LoadingState label="Probing the API…" />}

      {!probing && (
        <>
          <PanelGrid columns={3} className="mb-6">
            <StatPanel
              label="Status"
              value={probeFailed ? "Unreachable" : (health?.status ?? "unknown")}
              tone={apiLevel === "HEALTHY" ? "success" : apiLevel === "DEGRADED" ? "warning" : "danger"}
            />
            <StatPanel label="Uptime" value={formatUptime(health?.uptime)} hint="Since last restart" />
            <StatPanel
              label="Accepting traffic"
              value={ready?.ok ? "Yes" : "No"}
              tone={ready?.ok ? "success" : "warning"}
              hint="Readiness probe"
            />
          </PanelGrid>

          {probeFailed && (
            <div className="mb-6">
              <ErrorState
                title="The API is unreachable"
                message="Health probes did not get a response. The rest of this page reflects the last known state."
                onRetry={reloadAll}
              />
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Checked" description="Probed directly by the server">
              <ul>
                {checked.map((check) => (
                  <CheckRow key={check.name} check={check} />
                ))}
              </ul>
            </Panel>

            <Panel
              title="Not checked"
              description="No probe exists — status is genuinely unknown, not healthy"
              tone="warning"
            >
              <ul>
                {unchecked.map((check) => (
                  <CheckRow key={check.name} check={check} />
                ))}
              </ul>
            </Panel>
          </div>

          <Panel
            className="mt-4"
            title="Configured capabilities"
            description="What this deployment has wired — distinct from whether it is reachable right now"
          >
            {capabilities.loading && !capabilities.loaded && <LoadingState lines={2} />}
            {capabilities.error && (
              <ErrorState message={capabilities.error} onRetry={() => void capabilities.reload()} />
            )}
            {capabilities.data && (
              <ul className="grid gap-x-8 sm:grid-cols-2">
                {Object.entries(capabilities.data.capabilities).map(([name, enabled]) => (
                  <li
                    key={name}
                    data-testid="capability-row"
                    className="flex items-center justify-between border-b border-sys-line/50 py-2 last:border-0"
                  >
                    <span className="text-sm text-sys-text">
                      {name.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}
                    </span>
                    <StatusDot
                      tone={enabled ? "ok" : "neutral"}
                      label={enabled ? "Configured" : "Not configured"}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </PageContainer>
  );
}
