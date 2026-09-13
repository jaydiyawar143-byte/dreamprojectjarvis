"use client";

// ---------------------------------------------------------------------------
// One integration card.
//
// THE RULE THIS COMPONENT EXISTS TO ENFORCE: never claim a connection nobody
// verified. `UNVERIFIED` is its own state with its own label ("Not checked") —
// it is not folded into "Connected" just because credentials are present, and
// the Test button is the only thing that can produce a green dot.
//
// TWO AXES, SHOWN SEPARATELY. `connection` says whether it is SET UP;
// `health` says whether it WORKS. A card shows both because they answer
// different questions and the difference is exactly where a misleading status
// page goes wrong — "credentials saved" is not "we checked and it works".
//
// EVERY CONTROL HERE HAS A JARVIS EQUIVALENT. Test, Reconnect, Enable, Disable,
// Disconnect and Configure each post to an endpoint that the identically-named
// JARVIS tool also reaches, through one backend service. The button is not a
// shortcut past anything the sentence has to pass.
//
// There is no field on `Integration` that can hold a secret, so there is
// nothing here to accidentally render.
// ---------------------------------------------------------------------------

import { Loader2, ShieldCheck } from "lucide-react";
import type { Integration, IntegrationHealth, IntegrationConnectionState } from "@/lib/api";
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
  NEEDS_REAUTH: { tone: "danger", label: "Reauthorization needed" },
  DISABLED: { tone: "neutral", label: "Disabled" },
};

const CONNECTION_LABEL: Record<IntegrationConnectionState, string> = {
  CONNECTED: "Set up",
  NOT_CONNECTED: "Not set up",
  PARTIAL: "Partially configured",
  NEEDS_REAUTH: "Authorization expired",
  DISABLED: "Switched off",
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

export interface IntegrationCardProps {
  integration: Integration;
  busy: boolean;
  onTest: () => void;
  onManage: () => void;
  onConnect: () => void;
  onReconnect: () => void;
  /** Requests the incremental WRITE upgrade for the named services. */
  onGrantWrite?: (services: string[]) => void;
  onToggleEnabled: (enabled: boolean) => void;
}

export function IntegrationCard({
  integration,
  busy,
  onTest,
  onManage,
  onConnect,
  onReconnect,
  onGrantWrite,
  onToggleEnabled,
}: IntegrationCardProps) {
  const health = HEALTH[integration.health];
  const can = (command: string) => integration.supportedCommands.includes(command as never);

  const disabled = integration.connection === "DISABLED";
  const needsReauth =
    integration.connection === "NEEDS_REAUTH" || integration.health === "NEEDS_REAUTH";
  const notSetUp =
    integration.connection === "NOT_CONNECTED" || integration.connection === "PARTIAL";

  /**
   * Write access this build supports and this connection has not authorized.
   *
   * Read straight from the server's permission list — the page never decides
   * which scopes exist, only whether to offer what the server already reported
   * as ungranted. Offered ONLY on a live connection: an upgrade is incremental
   * consent on top of an existing grant, and showing it next to "Connect" would
   * be two buttons for the same first step.
   */
  const pendingWrite = integration.permissions.filter(
    (p) => p.access === "write" && !p.granted && Boolean(p.service)
  );
  const showGrantWrite = pendingWrite.length > 0 && integration.connection === "CONNECTED";
  const pendingWriteLabel = pendingWrite
    .map((p) => p.label.replace(/^Modify\s+/, "").replace(/\s*\(approval-gated\)$/, ""))
    .join(", ");

  return (
    <Panel
      data-testid={`integration-card-${integration.id}`}
      data-health={integration.health}
      data-connection={integration.connection}
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

        {/* Setup state, stated separately from health so neither implies the
            other. "Set up" plus "Not checked" is a real and common combination
            and the card has to be able to say it. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span data-testid={`integration-connection-${integration.id}`} className="text-sys-dim">
            {CONNECTION_LABEL[integration.connection]}
          </span>
          {!integration.configComplete && integration.missingConfig.length > 0 && (
            <span
              data-testid={`integration-missing-${integration.id}`}
              className="text-amber-300/90"
            >
              Missing: {integration.missingConfig.join(", ")}
            </span>
          )}
        </div>

        {/* What this deployment can actually do once connected. Writes are
            badged, so a connected card cannot be read as "this dashboard can
            spend money" — it cannot; writes stop at the approval boundary. */}
        <ul className="space-y-1" data-testid={`integration-capabilities-${integration.id}`}>
          {integration.actions.map((action) => (
            <li key={action.id} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden
                className={action.available ? "text-emerald-300/90" : "text-sys-dim/60"}
              >
                {action.available ? "✓" : "✕"}
              </span>
              <span className={action.available ? "text-sys-text/85" : "text-sys-dim/70"}>
                {action.label}
              </span>
              <span className="sr-only">{action.available ? "available" : "unavailable"}</span>
              {action.writesExternally && (
                <Badge
                  tone="warn"
                  className="ml-auto"
                  title="Changes something outside JARVIS. Requires explicit confirmation and stops at the approval boundary."
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
                {integration.usage.used.toLocaleString()} /{" "}
                {integration.usage.limit.toLocaleString()}
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
          Last tested:{" "}
          <span data-testid={`integration-checked-${integration.id}`}>
            {sinceLabel(integration.lastTestedAt)}
          </span>
          {" · "}
          Last successful sync:{" "}
          <span data-testid={`integration-sync-${integration.id}`}>
            {sinceLabel(integration.lastSuccessfulSyncAt)}
          </span>
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
          {/* Re-authorization is the ONLY thing offered when the grant is gone:
              a Test button here would just fail again, and offering it invites
              the user to retry something that cannot succeed. */}
          {/*
            Grant write access.
            ----------------------------------------------------------------
            Rendered from the server's own permission list: any entry that is
            `access: "write"` and not granted is a capability this build has
            and this connection has not authorized. Before this existed, a user
            whose connection carried only Ads scopes was told "Gmail write
            permission is missing" with no control anywhere that could grant
            it — the server had supported the upgrade since Phase 13 and
            nothing could reach it.

            Named after the services rather than "Upgrade", because consenting
            to Gmail access is the thing the user is actually deciding.
          */}
          {showGrantWrite && onGrantWrite && (
            <Button
              data-testid={`integration-grant-write-${integration.id}`}
              onClick={() => onGrantWrite(pendingWrite.map((p) => p.service!))}
              disabled={busy}
            >
              Grant {pendingWriteLabel} access
            </Button>
          )}

          {needsReauth && can("reconnect") ? (
            <Button
              data-testid={`integration-reconnect-${integration.id}`}
              onClick={onReconnect}
              disabled={busy}
            >
              Reauthorize
            </Button>
          ) : (
            <>
              {notSetUp && can("connect") && (
                <Button
                  data-testid={`integration-connect-${integration.id}`}
                  onClick={onConnect}
                  disabled={busy}
                >
                  Connect
                </Button>
              )}
              {!disabled && (
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
            </>
          )}

          <Button
            data-testid={`integration-manage-${integration.id}`}
            variant="secondary"
            onClick={onManage}
          >
            Manage
          </Button>

          {/* Disable, not disconnect. Switching off keeps the credential, so
              turning it back on needs no second consent round trip — which is
              what most people actually mean by "turn it off". */}
          <Button
            data-testid={`integration-toggle-${integration.id}`}
            variant="secondary"
            onClick={() => onToggleEnabled(disabled)}
            disabled={busy}
          >
            {disabled ? "Enable" : "Disable"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
