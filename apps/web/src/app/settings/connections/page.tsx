"use client";

// ---------------------------------------------------------------------------
// UI V2 — Connections (the Agent Credential Center).
//
// The editable counterpart to /integrations, which stays read-only. This is
// where an operator supplies the credentials JARVIS's agents use.
//
// WHAT THIS PAGE WILL NOT DO.
//
//   It never displays a stored secret. The API does not return one, so there is
//   nothing here to reveal. "Show" reveals only what the operator has typed in
//   this session, before it is saved — after that the field shows a mask and a
//   new value replaces it wholesale.
//
//   It never claims a connection it has not observed. Saving makes a provider
//   CONFIGURED; only a successful Test Connection — a real call to the provider
//   — produces CONNECTED. Those are different words on purpose.
//
//   It never offers a form for something the backend cannot accept. WhatsApp
//   and n8n read their configuration from server environment at boot, so they
//   are shown read-only with the reason, rather than given inputs that would
//   silently do nothing.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Eye, EyeOff, Loader2, Trash2 } from "lucide-react";
import {
  listCredentials,
  removeCredentials,
  saveCredentials,
  testCredentials,
  type CredentialProvider,
  type CredentialStatus,
} from "@/lib/api";
import { PageContainer, PageHeader } from "@/components/dashboard/page-container";
import { Panel } from "@/components/dashboard/panel";
import { ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button } from "@/components/ui/primitives";

/** Status → how it reads. Deliberately plain words, not jargon. */
const STATUS_LABEL: Record<CredentialStatus, string> = {
  CONNECTED: "Connected",
  CONFIGURED: "Saved — not yet verified",
  NOT_CONNECTED: "Not connected",
  CONFIGURATION_REQUIRED: "Configuration required",
  INVALID: "Invalid",
};

const STATUS_TONE: Record<CredentialStatus, "success" | "warn" | "danger" | "muted"> = {
  CONNECTED: "success",
  CONFIGURED: "warn",
  NOT_CONNECTED: "muted",
  CONFIGURATION_REQUIRED: "warn",
  INVALID: "danger",
};

function StatusBadge({ status }: { status: CredentialStatus }) {
  const tone = STATUS_TONE[status];
  const className = {
    success: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
    warn: "border-amber-400/40 bg-amber-400/10 text-amber-300",
    danger: "border-red-400/40 bg-red-400/10 text-red-300",
    muted: "border-sys-line bg-white/[0.03] text-sys-dim",
  }[tone];

  return (
    <span
      data-testid={`credential-status-${status}`}
      className={`shrink-0 rounded border px-2 py-1 font-mono text-[0.5rem] uppercase tracking-hud ${className}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One editable provider.
// ---------------------------------------------------------------------------
function CredentialForm({
  provider,
  onChanged,
}: {
  provider: CredentialProvider;
  onChanged: (next: CredentialProvider) => void;
}) {
  // Only what the operator types this session. Never seeded from the server,
  // because the server does not send secrets back.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const busy = saving || testing || removing;
  const stored = provider.values ?? {};

  const save = async () => {
    setSaving(true);
    setMessage(null);
    setFieldErrors({});

    // Non-secret fields fall back to what is already stored, so an operator
    // rotating only the token does not have to retype the account id. Secrets
    // are never defaulted — an empty secret box means "unchanged" is not an
    // option the server offers, so it is sent as typed and validated there.
    const payload: Record<string, string> = {};
    for (const field of provider.fields) {
      const typed = draft[field.name];
      if (typed !== undefined && typed !== "") payload[field.name] = typed;
      else if (field.kind !== "secret" && stored[field.name]) payload[field.name] = stored[field.name]!;
    }

    const res = await saveCredentials(provider.id, payload);
    setSaving(false);

    if (!res.success || !res.data) {
      const details = res.error?.details as Record<string, string[]> | undefined;
      if (details) {
        setFieldErrors(
          Object.fromEntries(
            Object.entries(details).map(([k, v]) => [k, v?.[0] ?? "Invalid value"])
          )
        );
      }
      setMessage({ tone: "bad", text: res.error?.message ?? "Could not save." });
      return;
    }

    setDraft({});
    setRevealed({});
    setMessage({ tone: "ok", text: "Saved and encrypted. Test the connection to verify it." });
    onChanged(res.data);
  };

  const test = async () => {
    setTesting(true);
    setMessage(null);
    const res = await testCredentials(provider.id);
    setTesting(false);

    if (!res.success || !res.data) {
      setMessage({ tone: "bad", text: res.error?.message ?? "Could not run the test." });
      return;
    }

    const passed = res.data.status === "CONNECTED";
    setMessage({ tone: passed ? "ok" : "bad", text: res.data.detail });
    // The card takes the tested status, which is the only place CONNECTED can
    // come from.
    onChanged({ ...provider, status: res.data.status, detail: res.data.detail });
  };

  const remove = async () => {
    setRemoving(true);
    setMessage(null);
    const res = await removeCredentials(provider.id);
    setRemoving(false);
    if (!res.success || !res.data) {
      setMessage({ tone: "bad", text: res.error?.message ?? "Could not remove." });
      return;
    }
    setDraft({});
    setMessage({ tone: "ok", text: "Credentials removed." });
    onChanged(res.data);
  };

  const hasStored = Object.keys(stored).length > 0;

  return (
    <div className="space-y-4">
      {provider.fields.map((field) => {
        const isSecret = field.kind === "secret";
        const show = revealed[field.name] === true;
        const typed = draft[field.name] ?? "";
        const placeholder = isSecret
          ? stored[field.name]
            ? "•••••••••••• (stored — type to replace)"
            : field.placeholder ?? ""
          : stored[field.name] ?? field.placeholder ?? "";

        return (
          <div key={field.name}>
            <label
              htmlFor={`${provider.id}-${field.name}`}
              className="mb-1.5 block font-mono text-[0.55rem] uppercase tracking-hud text-sys-dim"
            >
              {field.label}
              {!field.required && <span className="ml-1 text-sys-dim/60">(optional)</span>}
            </label>

            <div className="relative">
              <input
                id={`${provider.id}-${field.name}`}
                data-testid={`credential-input-${field.name}`}
                // Secrets are masked while typing unless explicitly revealed.
                type={isSecret && !show ? "password" : "text"}
                value={typed}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder={placeholder}
                onChange={(e) => setDraft((d) => ({ ...d, [field.name]: e.target.value }))}
                className="sys-focus w-full rounded-md border border-sys-line bg-black/30 px-3 py-2 pr-10 text-sm text-white placeholder:text-sys-dim/50 disabled:opacity-60"
              />

              {isSecret && (
                <button
                  type="button"
                  // Reveals only what is in this box right now. It cannot show
                  // a stored secret, because the server never sent one.
                  onClick={() => setRevealed((r) => ({ ...r, [field.name]: !show }))}
                  aria-label={show ? `Hide ${field.label}` : `Show ${field.label}`}
                  disabled={typed.length === 0}
                  title={typed.length === 0 ? "Nothing typed to show" : undefined}
                  className="sys-focus absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-sys-dim transition-colors enabled:hover:text-white disabled:opacity-30"
                >
                  {show ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                </button>
              )}
            </div>

            {fieldErrors[field.name] && (
              <p role="alert" className="mt-1 text-xs text-red-300/90">
                {fieldErrors[field.name]}
              </p>
            )}
            {field.help && !fieldErrors[field.name] && (
              <p className="mt-1 text-xs text-sys-dim">{field.help}</p>
            )}
          </div>
        );
      })}

      {message && (
        <p
          data-testid="credential-message"
          role="status"
          className={`text-sm ${message.tone === "ok" ? "text-emerald-300/90" : "text-red-300/90"}`}
        >
          {message.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button onClick={() => void save()} disabled={busy}>
          {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
          {saving ? "Saving…" : "Save configuration"}
        </Button>

        {provider.testable && (
          <Button
            // Secondary, not ghost: this is the action that establishes whether
            // the credentials actually work, so it needs real affordance.
            variant="secondary"
            onClick={() => void test()}
            // Nothing stored means nothing to test; the server would refuse.
            disabled={busy || !hasStored}
            data-testid="credential-test"
          >
            {testing ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
            {testing ? "Testing…" : "Test connection"}
          </Button>
        )}

        {hasStored && (
          <Button
            variant="ghost"
            onClick={() => void remove()}
            disabled={busy}
            data-testid="credential-remove"
            className="ml-auto text-red-300/80 hover:text-red-300"
          >
            <Trash2 size={13} aria-hidden="true" />
            {removing ? "Removing…" : "Remove"}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function ConnectionsPage() {
  const [providers, setProviders] = useState<CredentialProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listCredentials();
    if (res.success && res.data) {
      setProviders(res.data.providers);
    } else {
      setError(
        res.error?.code === "NOT_FOUND"
          ? "Credential storage is not enabled on this server (no encryption key is configured)."
          : res.error?.message ?? "Could not load connections."
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (next: CredentialProvider) =>
    setProviders((list) => (list ?? []).map((p) => (p.id === next.id ? next : p)));

  return (
    <PageContainer>
      <PageHeader
        title="Connections"
        description="Credentials the JARVIS agents use. Stored encrypted on the server; never in your browser."
      />

      <Link
        href="/settings"
        className="sys-focus mb-5 inline-flex items-center gap-1.5 font-mono text-[0.55rem] uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
      >
        <ArrowLeft size={12} aria-hidden="true" />
        Back to settings
      </Link>

      {loading && <LoadingState />}

      {!loading && error && (
        <ErrorState title="Connections unavailable" message={error} onRetry={() => void load()} />
      )}

      {!loading && !error && (
        <div className="space-y-5">
          {(providers ?? []).map((provider) => (
            <Panel
              key={provider.id}
              title={provider.label}
              description={provider.description}
              data-testid={`credential-card-${provider.id}`}
            >
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-sys-text/85">{provider.detail}</p>
                  <p className="mt-1 font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim/70">
                    In use: {provider.effectiveSource}
                  </p>
                </div>
                <StatusBadge status={provider.status} />
              </div>

              {provider.kind === "form" && (
                <CredentialForm provider={provider} onChanged={update} />
              )}

              {provider.kind === "oauth" && (
                <div className="flex flex-wrap items-center gap-3">
                  {provider.connectUrl && provider.status !== "CONFIGURATION_REQUIRED" ? (
                    <Link
                      href="/integrations"
                      className="sys-focus inline-flex items-center rounded border border-sys-cyan/40 bg-sys-cyan/[0.08] px-3 py-1.5 font-mono text-[0.58rem] uppercase tracking-hud text-sys-cyan-soft transition-colors hover:border-sys-cyan/80"
                    >
                      Manage connection
                    </Link>
                  ) : (
                    <Badge>Server configuration required</Badge>
                  )}
                  <p className="text-xs text-sys-dim">
                    Google is connected by consent, so there is no secret to enter here.
                  </p>
                </div>
              )}

              {provider.kind === "server-managed" && (
                <p className="text-xs text-sys-dim">
                  This integration reads its configuration from the server environment when the
                  service starts, so it cannot be changed from the browser. Set the variables on
                  the server and restart.
                </p>
              )}
            </Panel>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
