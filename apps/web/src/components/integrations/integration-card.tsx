"use client";

// ---------------------------------------------------------------------------
// One integration card.
//
// THE RULE THIS COMPONENT EXISTS TO ENFORCE: never claim a connection nobody
// verified. `UNVERIFIED` is its own state with its own label ("Not checked") —
// it is not folded into "Connected" just because credentials are present, and
// the Test button is the only thing that can produce a green dot.
//
// The second rule is about EXECUTION. A capability that changes something
// outside JARVIS is rendered with an "approval" badge. Connecting an
// integration is configuration; sending a WhatsApp message or changing a Meta
// budget is execution, and execution goes through ToolExecutor and stops at the
// approval boundary. Nothing on this card can trigger one.
//
// There is no field on `Integration` that can hold a secret, so there is
// nothing here to accidentally render.
// ---------------------------------------------------------------------------

import { Loader2, ShieldCheck } from "lucide-react";
import type { Integration, IntegrationHealth } from "@/lib/api";
import { Badge, Button, StatusDot, type Tone } from "@/components/ui/primitives";
import { Panel } from "@/components/dashboard/panel";

/** Health → the dot's tone and the words beside it. */
const HEALTH: Record<IntegrationHealth, { tone: Tone; label: string }> = {
  CONNECTED: { tone: "ok", label: "Connected" },
  DEGRADED: { tone: "warn", label: "Degraded" },
  // Deliberately NOT "Connected". Credentials existing is not a connection.
  UNVERIFIED: { tone: "neutral", label: "Not checked" },
  ERROR: { tone: "danger", label: "Error" },
  NOT_CONNECTED: { tone: "neutral", label: "Not connected" },
  CONFIG_REQUIRED: { tone: "warn", label: "Configuration required" },
  DISABLED: { tone: "neutral", label: "Disabled" },
};

/** "2 min ago" — how long since the check, not when the page loaded. */
export function sinceLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Usage bar tone. Mirrors the server's own threshold bands. */
function usageTone(level: string): { bar: string; text: string } {
  switch (level) {
    case "BLOCKED":
    case "CRITICAL":
      return { bar: "bg-sys-danger", text: "text-sys-danger" };
    case "STRONG_WARNING":
      return { bar: "bg-amber-400", text: "text-amber-300" };
    case "WARNING":
      return { bar: "bg-amber-400/80", text: "text-amber-300/90" };
    default:
      return { bar: "bg-sys-cyan", text: "text-sys-dim" };
  }
}

export function IntegrationCard({
  integration,
  busy,
  onTest,
  onManage,
  onConnect,
  onDisconnect,
}: {
  integration: Integration;
  busy: boolean;
  onTest: () => void;
  onManage: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const health = HEALTH[integration.health];
  const notConnected =
    integration.health === "NOT_CONNECTED" || integration.health === "CONFIG_REQUIRED";

  return (
    <Panel
      data-testid={`integration-card-${integration.id}`}
      data-health={integration.health}
      title={integration.name}
      description={integration.subtitle}
      action={<StatusDot tone={health.tone} label={health.label} />}
    >
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-sys-text/85">{integration.detail}</p>

        {/* A safe identifier the user themselves authorised — never a secret. */}
        {integration.account && (
          <div data-testid={`integration-account-${integration.id}`} className="min-w-0">
            <p className="truncate font-mono text-xs text-sys-cyan-soft">
              {integration.account.label}
            </p>
            {integration.account.detail && (
              <p className="truncate text-xs text-sys-dim">{integration.account.detail}</p>
            )}
          </div>
        )}

        {/* Capabilities. A tick means this deployment can really do it. */}
        <ul className="space-y-1" data-testid={`integration-capabilities-${integration.id}`}>
          {integration.capabilities.map((cap) => (
            <li key={cap.id} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden
                className={cap.available ? "text-emerald-300/90" : "text-sys-dim/60"}
              >
                {cap.available ? "✓" : "✕"}
              </span>
              <span className={cap.available ? "text-sys-text/85" : "text-sys-dim/70"}>
                {cap.label}
              </span>
              <span className="sr-only">{cap.available ? "available" : "unavailable"}</span>
              {cap.requiresApproval && (
                <Badge
                  tone="warn"
                  className="ml-auto"
                  title="Runs through ToolExecutor and stops at the approval boundary. This page cannot trigger it."
                >
                  <ShieldCheck size={9} aria-hidden />
                  Approval
                </Badge>
              )}
            </li>
          ))}
        </ul>

        {/* Usage, where the integration has a ceiling. */}
        {integration.usage && (
          <div data-testid={`integration-usage-${integration.id}`}>
            <div className="flex items-baseline gap-2 text-xs">
              <span className="font-mono text-sys-text/85 [font-variant-numeric:tabular-nums]">
                {integration.usage.used.toLocaleString()} / {integration.usage.limit.toLocaleString()}
              </span>
              <span className={`ml-auto font-mono ${usageTone(integration.usage.level).text}`}>
                {integration.usage.percentUsed}%
              </span>
            </div>
            <div
              className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]"
              role="progressbar"
              aria-valuenow={integration.usage.percentUsed}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${integration.name} monthly usage`}
            >
              <div
                className={`h-full ${usageTone(integration.usage.level).bar}`}
                // Clamped for the bar only; the number beside it stays honest
                // even past 100%.
                style={{ width: `${Math.min(100, Math.max(0, integration.usage.percentUsed))}%` }}
              />
            </div>
          </div>
        )}

        <p className="text-xs text-sys-dim">
          Last checked: <span data-testid={`integration-checked-${integration.id}`}>{sinceLabel(integration.lastCheckedAt)}</span>
        </p>

        {integration.lastError && (
          <p
            data-testid={`integration-error-${integration.id}`}
            className="text-xs leading-relaxed text-red-300/90"
          >
            {integration.lastError}
          </p>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {notConnected && integration.actions.connectUrl && (
            <Button data-testid={`integration-connect-${integration.id}`} onClick={onConnect} disabled={busy}>
              Connect
            </Button>
          )}
          {integration.actions.testable && (
            <Button
              data-testid={`integration-test-${integration.id}`}
              variant="secondary"
              onClick={onTest}
              disabled={busy}
            >
              {busy ? (
                <>
                  <Loader2 size={11} className="animate-spin" aria-hidden />
                  Testing…
                </>
              ) : (
                "Test Connection"
              )}
            </Button>
          )}
          <Button
            data-testid={`integration-manage-${integration.id}`}
            variant="secondary"
            onClick={onManage}
          >
            Manage
          </Button>
          {integration.actions.disconnectUrl && (
            <Button
              data-testid={`integration-disconnect-${integration.id}`}
              variant="danger"
              onClick={onDisconnect}
              disabled={busy}
            >
              Disconnect
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}
