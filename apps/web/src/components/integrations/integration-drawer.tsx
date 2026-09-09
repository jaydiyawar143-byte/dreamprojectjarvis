"use client";

// ---------------------------------------------------------------------------
// The Manage drawer.
//
// Opens over the page rather than navigating away, so an operator comparing two
// integrations does not lose the list. It shows detail; it does not become a
// second place to save a secret — the credential FORM for a form-configured
// provider still lives at Settings → Connections, which is the one path that
// validates, encrypts, stores and audits. This drawer links there.
//
// The security panel at the bottom is not decoration. "Where is this
// configured", "what is the running system actually using", and "which of these
// capabilities need a human decision" are the three questions an operator asks
// before trusting a green dot, and each has a real answer here.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ShieldCheck, X } from "lucide-react";
import type { Integration } from "@/lib/api";
import { Badge, Button } from "@/components/ui/primitives";
import { sinceLabel } from "./integration-card";

export function IntegrationDrawer({
  integration,
  busy,
  onClose,
  onTest,
}: {
  integration: Integration;
  busy: boolean;
  onClose: () => void;
  onTest: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

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

  const approvalGated = integration.capabilities.filter((c) => c.requiresApproval);

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
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-[2px]"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="sys-focus relative h-full w-full max-w-md overflow-y-auto border-l border-sys-edge bg-sys-void/95 p-5 shadow-console"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-mono text-sm uppercase tracking-hud text-white">
              {integration.name}
            </h2>
            <p className="mt-0.5 text-xs text-sys-dim">{integration.subtitle}</p>
          </div>
          <button
            type="button"
            data-testid="integration-drawer-close"
            onClick={onClose}
            aria-label="Close details"
            className="sys-focus shrink-0 rounded border border-sys-line p-1 text-sys-dim transition-colors hover:text-white"
          >
            <X size={13} aria-hidden />
          </button>
        </div>

        <div className="space-y-5 text-xs">
          <section>
            <h3 className="mb-1.5 font-mono uppercase tracking-hud text-sys-dim">Health</h3>
            <p className="leading-relaxed text-sys-text/85">{integration.detail}</p>
            <p className="mt-1 text-sys-dim">Last checked: {sinceLabel(integration.lastCheckedAt)}</p>
            {integration.lastError && (
              <p className="mt-1 leading-relaxed text-red-300/90">{integration.lastError}</p>
            )}
          </section>

          <section>
            <h3 className="mb-1.5 font-mono uppercase tracking-hud text-sys-dim">Capabilities</h3>
            <ul className="space-y-1">
              {integration.capabilities.map((cap) => (
                <li key={cap.id} className="flex items-center gap-2">
                  <span aria-hidden className={cap.available ? "text-emerald-300/90" : "text-sys-dim/60"}>
                    {cap.available ? "✓" : "✕"}
                  </span>
                  <span className={cap.available ? "text-sys-text/85" : "text-sys-dim/70"}>
                    {cap.label}
                  </span>
                  <code className="ml-auto font-mono text-sys-dim/70">{cap.id}</code>
                </li>
              ))}
            </ul>
          </section>

          {integration.usage && (
            <section>
              <h3 className="mb-1.5 font-mono uppercase tracking-hud text-sys-dim">Usage</h3>
              <p className="text-sys-text/85">
                {integration.usage.used.toLocaleString()} of{" "}
                {integration.usage.limit.toLocaleString()} this month ·{" "}
                {integration.usage.percentUsed}% · {integration.usage.level}
              </p>
              {integration.usage.blocked && (
                <p className="mt-1 text-red-300/90">
                  The monthly ceiling has been reached. Further calls are blocked until the
                  next month.
                </p>
              )}
            </section>
          )}

          <section>
            <h3 className="mb-1.5 font-mono uppercase tracking-hud text-sys-dim">Security</h3>
            <dl className="space-y-1.5">
              <div className="flex justify-between gap-3">
                <dt className="text-sys-dim">Configuration source</dt>
                <dd className="text-right text-sys-text/85">{integration.effectiveSource}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-sys-dim">Secrets in this response</dt>
                {/* Structural, not a promise: no field on the type can hold one. */}
                <dd className="text-right text-emerald-300/90">none</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-sys-dim">Approval-gated actions</dt>
                <dd className="text-right text-sys-text/85">{approvalGated.length}</dd>
              </div>
            </dl>

            {approvalGated.length > 0 && (
              <div className="mt-2 rounded border border-sys-line bg-white/[0.02] p-2.5">
                <p className="flex items-start gap-1.5 leading-relaxed text-sys-dim">
                  <ShieldCheck size={12} className="mt-0.5 shrink-0" aria-hidden />
                  <span>
                    Connecting an integration is configuration, not permission to act.{" "}
                    {approvalGated.map((c) => c.label).join(", ")} run through the tool
                    executor and stop at the approval boundary — this page cannot trigger
                    them.
                  </span>
                </p>
              </div>
            )}
          </section>

          <section className="flex flex-wrap gap-2 border-t border-sys-line pt-4">
            {integration.actions.testable && (
              <Button data-testid="integration-drawer-test" onClick={onTest} disabled={busy}>
                {busy ? "Testing…" : "Test Connection"}
              </Button>
            )}
            {integration.actions.configureUrl && (
              // The credential form lives where validation, encryption and audit
              // already are. Duplicating it here would be a second write path.
              <Link
                href="/settings/connections"
                data-testid="integration-drawer-configure"
                className="sys-focus inline-flex items-center rounded border border-sys-cyan/40 bg-sys-cyan/[0.08] px-3 py-1.5 font-mono text-xs uppercase tracking-hud text-sys-cyan-soft transition-colors hover:border-sys-cyan/80"
              >
                Configure credentials
              </Link>
            )}
            {integration.effectiveSource === "server environment" && (
              <Badge tone="neutral">Set on the server, then restart</Badge>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
