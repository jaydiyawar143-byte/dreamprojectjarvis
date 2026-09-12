"use client";

// ---------------------------------------------------------------------------
// The Manage drawer — every manual control, in one place.
//
// Opens over the page rather than navigating away, so an operator comparing two
// integrations does not lose the list.
//
// WHAT MAKES THIS SAFE TO BE A CONFIGURATION FORM. It posts to
// `PUT /integrations/:id/config`, which runs the SAME server-side validator the
// JARVIS `integration.configure` tool runs, encrypts with the same key and
// writes the same audit row. It is not a second write path; it is a second
// caller of the one that exists.
//
// SECRETS ARE ONE-WAY. A stored secret arrives as `hasValue: true` and a mask.
// The input renders empty with a "replace" affordance, and an untouched secret
// field posts the mask back — which the server reads as "leave it alone" rather
// than overwriting a working token with a row of dots. There is no code path
// here that could display a stored secret, because the value never arrives.
//
// A SERVER-MANAGED FIELD IS READ-ONLY AND SAYS WHY. Rendering an editable box
// for something only an environment variable can change would be exactly the
// fake-control this whole feature exists to remove.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck, X } from "lucide-react";
import {
  configureIntegration,
  disconnectIntegration,
  getIntegrationAudit,
  validateIntegrationConfig,
  type Integration,
  type IntegrationAuditEntry,
  type IntegrationFieldState,
} from "@/lib/api";
import { Badge, Button } from "@/components/ui/primitives";
import { sinceLabel } from "./integration-card";

/** Matches the server's mask. Posting it back means "unchanged". */
const MASK = "••••••••••••";

export interface IntegrationDrawerProps {
  integration: Integration;
  busy: boolean;
  onClose: () => void;
  onTest: () => void;
  onReconnect: () => void;
  /** Called after any change so the parent can refresh the card in place. */
  onChanged: (message: string) => void;
}

export function IntegrationDrawer({
  integration,
  busy,
  onClose,
  onTest,
  onReconnect,
  onChanged,
}: IntegrationDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formNotice, setFormNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [audit, setAudit] = useState<IntegrationAuditEntry[] | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const can = (command: string) => integration.supportedCommands.includes(command as never);
  const editable = integration.config.filter((f) => !f.serverManaged);
  const serverManaged = integration.config.filter((f) => f.serverManaged);

  // Escape closes, and focus moves into the drawer on open — a dialog that
  // traps neither is a dialog a keyboard user cannot leave or reach.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The activity feed is fetched on open rather than with the list: it is one
  // request per drawer, not five on every page load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getIntegrationAudit(integration.id, 15);
      if (!cancelled) setAudit(res.success && res.data ? res.data.entries : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [integration.id]);

  /**
   * The values to submit.
   *
   * An untouched secret that already has a value is sent as the MASK, which the
   * server treats as "unchanged". Sending nothing would be equivalent here, but
   * sending the mask is what the server's own sentinel documents, so the two
   * agree explicitly rather than by coincidence.
   */
  const payload = useCallback((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const field of editable) {
      const typed = draft[field.name];
      if (typed !== undefined) {
        out[field.name] = typed;
      } else if (field.kind === "secret" && field.hasValue) {
        out[field.name] = MASK;
      }
    }
    return out;
  }, [draft, editable]);

  const save = useCallback(async () => {
    setSaving(true);
    setFormNotice(null);
    const res = await configureIntegration(integration.id, payload());
    setSaving(false);

    if (res.success && res.data) {
      setDraft({});
      setFormNotice({ tone: "ok", text: res.data.message });
      onChanged(res.data.message);
      return;
    }
    setFormNotice({ tone: "error", text: res.error?.message ?? "Could not save configuration." });
  }, [integration.id, payload, onChanged]);

  const validate = useCallback(async () => {
    setSaving(true);
    setFormNotice(null);
    const res = await validateIntegrationConfig(
      integration.id,
      editable.length > 0 ? payload() : undefined
    );
    setSaving(false);

    setFormNotice(
      res.success && res.data
        ? { tone: "ok", text: res.data.message }
        : { tone: "error", text: res.error?.message ?? "Configuration is not valid." }
    );
  }, [integration.id, payload, editable.length]);

  const disconnect = useCallback(async () => {
    setSaving(true);
    const res = await disconnectIntegration(integration.id);
    setSaving(false);
    setConfirmingDisconnect(false);

    if (res.success && res.data) {
      onChanged(res.data.message);
      onClose();
      return;
    }
    setFormNotice({ tone: "error", text: res.error?.message ?? "Could not disconnect." });
  }, [integration.id, onChanged, onClose]);

  const grantedPermissions = integration.permissions.filter((p) => p.granted);

  return (
    <div
      data-testid="integration-drawer"
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={`${integration.name} details`}
    >
      {/* Click-away. Rendered as a button so it is reachable without a mouse. */}
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="sys-focus relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-sys-line bg-sys-panel/95 shadow-2xl backdrop-blur-xl"
      >
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-sys-line bg-sys-panel/95 px-4 py-3 backdrop-blur-xl">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-white">{integration.name}</h2>
            <p className="truncate text-xs text-sys-dim">{integration.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="sys-focus rounded p-1 text-sys-dim hover:text-white"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="space-y-5 px-4 py-4">
          <p className="text-xs leading-relaxed text-sys-text/85">{integration.detail}</p>

          {/* ---------------------------------------------------------------
              State
              --------------------------------------------------------------- */}
          <section className="space-y-1.5" data-testid="drawer-state">
            <h3 className="font-mono text-xs uppercase tracking-hud text-sys-dim">State</h3>
            <Row label="Health" value={integration.health} />
            <Row label="Setup" value={integration.connection} />
            <Row label="Configured by" value={integration.effectiveSource} />
            <Row label="Last tested" value={sinceLabel(integration.lastTestedAt)} />
            <Row label="Last successful sync" value={sinceLabel(integration.lastSuccessfulSyncAt)} />
            {integration.enabledServices.length > 0 && (
              <Row label="Enabled services" value={integration.enabledServices.join(", ")} />
            )}
            {integration.lastError && (
              <p className="pt-1 text-xs leading-relaxed text-red-300/90">{integration.lastError}</p>
            )}
          </section>

          {/* ---------------------------------------------------------------
              Permissions — what is actually GRANTED, not what was asked for.
              --------------------------------------------------------------- */}
          <section className="space-y-1.5" data-testid="drawer-permissions">
            <h3 className="font-mono text-xs uppercase tracking-hud text-sys-dim">
              Active permissions
            </h3>
            {grantedPermissions.length === 0 ? (
              <p className="text-xs text-sys-dim">
                None. Nothing is connected, so JARVIS has no access to this provider.
              </p>
            ) : (
              <ul className="space-y-1">
                {grantedPermissions.map((permission) => (
                  <li key={permission.id} className="flex items-start gap-2 text-xs">
                    <Badge tone={permission.access === "write" ? "warn" : "neutral"}>
                      {permission.access}
                    </Badge>
                    <span className="min-w-0 flex-1 text-sys-text/85">{permission.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ---------------------------------------------------------------
              Configuration
              --------------------------------------------------------------- */}
          {integration.config.length > 0 && (
            <section className="space-y-2" data-testid="drawer-config">
              <h3 className="font-mono text-xs uppercase tracking-hud text-sys-dim">
                Configuration
              </h3>

              {editable.map((field) => (
                <SecretSafeField
                  key={field.name}
                  field={field}
                  value={draft[field.name]}
                  onChange={(v) => setDraft((d) => ({ ...d, [field.name]: v }))}
                  onClear={() =>
                    setDraft((d) => {
                      const next = { ...d };
                      delete next[field.name];
                      return next;
                    })
                  }
                />
              ))}

              {serverManaged.length > 0 && (
                <div className="space-y-1 rounded border border-sys-line/70 bg-black/20 p-2">
                  <p className="text-xs text-sys-dim">
                    Set by server environment variables. Change them on the server and restart —
                    they cannot be edited here.
                  </p>
                  {serverManaged.map((field) => (
                    <div key={field.name} className="flex items-baseline gap-2 text-xs">
                      <span aria-hidden className={field.hasValue ? "text-emerald-300/90" : "text-sys-dim/60"}>
                        {field.hasValue ? "✓" : "✕"}
                      </span>
                      <span className="text-sys-text/85">{field.label}</span>
                      <span className="ml-auto font-mono text-sys-dim">
                        {field.hasValue ? "set" : "not set"}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {formNotice && (
                <p
                  data-testid="drawer-config-notice"
                  className={`text-xs leading-relaxed ${
                    formNotice.tone === "ok" ? "text-emerald-300/90" : "text-red-300/90"
                  }`}
                >
                  {formNotice.text}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {can("configure") && editable.length > 0 && (
                  <Button data-testid="drawer-save" onClick={() => void save()} disabled={saving || busy}>
                    {saving ? <Loader2 size={11} className="animate-spin" aria-hidden /> : null}
                    Save configuration
                  </Button>
                )}
                {can("validateConfig") && (
                  <Button
                    data-testid="drawer-validate"
                    variant="secondary"
                    onClick={() => void validate()}
                    disabled={saving || busy}
                  >
                    Validate
                  </Button>
                )}
              </div>
            </section>
          )}

          {/* ---------------------------------------------------------------
              Actions
              --------------------------------------------------------------- */}
          <section className="space-y-2" data-testid="drawer-actions">
            <h3 className="font-mono text-xs uppercase tracking-hud text-sys-dim">Actions</h3>
            <div className="flex flex-wrap gap-2">
              <Button data-testid="drawer-test" variant="secondary" onClick={onTest} disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 size={11} className="animate-spin" aria-hidden />
                    Testing…
                  </>
                ) : (
                  "Test connection"
                )}
              </Button>
              {can("reconnect") && (
                <Button
                  data-testid="drawer-reconnect"
                  variant="secondary"
                  onClick={onReconnect}
                  disabled={busy}
                >
                  Reconnect
                </Button>
              )}
            </div>

            {can("disconnect") &&
              (confirmingDisconnect ? (
                // Confirmation in place, naming the consequence. Disconnect
                // revokes at the provider and cannot be undone from here.
                <div
                  data-testid="drawer-disconnect-confirm"
                  className="space-y-2 rounded border border-red-400/30 bg-red-500/5 p-2"
                >
                  <p className="text-xs leading-relaxed text-red-200/90">
                    Disconnect {integration.name}? This removes the stored credentials and revokes
                    the token at the provider. Reconnecting will require granting consent again. To
                    pause it instead, use Disable.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      data-testid="drawer-disconnect-yes"
                      variant="danger"
                      onClick={() => void disconnect()}
                      disabled={saving}
                    >
                      Yes, disconnect
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setConfirmingDisconnect(false)}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  data-testid="drawer-disconnect"
                  variant="danger"
                  onClick={() => setConfirmingDisconnect(true)}
                  disabled={busy}
                >
                  Disconnect
                </Button>
              ))}
          </section>

          {/* ---------------------------------------------------------------
              Recent activity — the same audit rows JARVIS reads.
              --------------------------------------------------------------- */}
          <section className="space-y-1.5" data-testid="drawer-audit">
            <h3 className="font-mono text-xs uppercase tracking-hud text-sys-dim">
              Recent activity
            </h3>
            {audit === null && <p className="text-xs text-sys-dim">Loading…</p>}
            {audit?.length === 0 && (
              <p className="text-xs text-sys-dim">No recorded activity in the last 30 days.</p>
            )}
            {audit && audit.length > 0 && (
              <ul className="space-y-1">
                {audit.map((entry) => (
                  <li key={entry.id} className="flex items-baseline gap-2 text-xs">
                    <span
                      aria-hidden
                      className={entry.result === "success" ? "text-emerald-300/90" : "text-red-300/90"}
                    >
                      {entry.result === "success" ? "✓" : "✕"}
                    </span>
                    <span className="font-mono text-sys-text/85">{entry.command}</span>
                    <span className="ml-auto shrink-0 text-sys-dim">{sinceLabel(entry.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ---------------------------------------------------------------
              The honesty panel.
              --------------------------------------------------------------- */}
          <section className="space-y-1.5 rounded border border-sys-line/70 bg-black/20 p-2">
            <div className="flex items-center gap-1.5">
              <ShieldCheck size={11} aria-hidden className="text-sys-cyan" />
              <h3 className="font-mono text-xs uppercase tracking-hud text-sys-dim">Security</h3>
            </div>
            <p className="text-xs leading-relaxed text-sys-dim">
              Secrets are stored encrypted on the server and are never sent back to this browser.
              Anything marked <span className="text-amber-300/90">Approval</span> changes something
              outside JARVIS: it requires explicit confirmation and cannot be authorized by voice.
            </p>
            <p className="text-xs leading-relaxed text-sys-dim">
              Every control here has an equivalent JARVIS command, and both use the same backend
              service — so nothing you can do on this page skips a check a spoken command has to
              pass.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="shrink-0 text-sys-dim">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right font-mono text-sys-text/85">{value}</span>
    </div>
  );
}

/**
 * One configuration input.
 *
 * A secret that is already stored renders as a masked, read-only display with a
 * Replace button rather than as a pre-filled password box. The distinction
 * matters: a pre-filled box implies the value is present in the page, and the
 * whole point is that it is not — the browser was never given it.
 */
function SecretSafeField({
  field,
  value,
  onChange,
  onClear,
}: {
  field: IntegrationFieldState;
  value: string | undefined;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  const storedSecret = field.kind === "secret" && field.hasValue;
  const replacing = value !== undefined;

  return (
    <div className="space-y-1">
      <label
        htmlFor={`config-${field.name}`}
        className="block text-xs text-sys-text/85"
      >
        {field.label}
        {field.required && <span className="ml-1 text-amber-300/90">*</span>}
      </label>

      {storedSecret && !replacing ? (
        <div className="flex items-center gap-2">
          <span
            data-testid={`config-masked-${field.name}`}
            className="flex-1 rounded border border-sys-control bg-black/40 px-2 py-1.5 font-mono text-sm text-sys-dim"
          >
            {field.masked}
          </span>
          <Button
            data-testid={`config-replace-${field.name}`}
            variant="secondary"
            onClick={() => onChange("")}
          >
            Replace
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            id={`config-${field.name}`}
            data-testid={`config-input-${field.name}`}
            type={field.kind === "secret" ? "password" : "text"}
            value={value ?? field.value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="off"
            className="sys-focus w-full flex-1 rounded border border-sys-control bg-black/40 px-2 py-1.5 text-sm text-white placeholder:text-sys-dim"
          />
          {storedSecret && (
            <Button variant="secondary" onClick={onClear}>
              Cancel
            </Button>
          )}
        </div>
      )}

      {field.help && <p className="text-xs leading-relaxed text-sys-dim">{field.help}</p>}
    </div>
  );
}
