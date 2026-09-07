"use client";

// ---------------------------------------------------------------------------
// UI V2 — Integrations.
//
// Three connections with three different amounts of introspection available,
// and the page says so rather than smoothing over the difference:
//
//   GOOGLE    has a real status route, so `configured` and `connected` are
//             reported separately — a deployment can have credentials wired
//             but no account linked, and those need different actions.
//   WHATSAPP  has NO status route. The only signal is whether the message list
//             answers or 404s.
//   N8N       likewise. Availability is inferred, and labelled as inferred.
//
// Nothing here sends anything. Outbound WhatsApp is the approval-gated
// `whatsapp.send` tool and triggering a workflow is `n8n.trigger`; both are
// reachable only through the assistant, behind a human decision. A send button
// on this page would have to route around that.
//
// No token, scope secret or webhook path is ever rendered — the API does not
// return them, and this page does not ask.
// ---------------------------------------------------------------------------

import { useState } from "react";

import {
  connectGoogle,
  disconnectGoogle,
  getGoogleStatus,
  isNotDeployed,
  listN8nWorkflows,
  listWhatsAppMessages,
} from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { PageContainer, PageHeader } from "@/components/dashboard/page-container";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, StatusDot, type Tone } from "@/components/ui/primitives";

function IntegrationPanel({
  name,
  description,
  tone,
  statusLabel,
  statusTone,
  children,
  actions,
}: {
  name: string;
  description: string;
  tone?: "default" | "warning";
  statusLabel: string;
  statusTone: Tone;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Panel
      tone={tone}
      data-testid="integration-panel"
      data-integration={name}
      title={name}
      description={description}
      action={<StatusDot tone={statusTone} label={statusLabel} />}
      footer={actions}
    >
      {children}
    </Panel>
  );
}

export default function IntegrationsPage() {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const google = useResource(getGoogleStatus, [], {
    fallbackError: "Could not read the Google connection.",
  });
  const whatsapp = useResource(() => listWhatsAppMessages(5), [], {
    fallbackError: "Could not read WhatsApp activity.",
  });
  const n8n = useResource(listN8nWorkflows, [], {
    fallbackError: "Could not read n8n workflows.",
  });

  const googleNotDeployed = google.loaded && isNotDeployed({ code: google.errorCode ?? "", message: "" });
  const whatsappNotDeployed =
    whatsapp.loaded && isNotDeployed({ code: whatsapp.errorCode ?? "", message: "" });
  const n8nNotDeployed = n8n.loaded && isNotDeployed({ code: n8n.errorCode ?? "", message: "" });

  const startGoogleConnect = async () => {
    setBusy(true);
    setActionError(null);
    const res = await connectGoogle();
    setBusy(false);
    if (res.success && res.data?.authUrl) {
      // Consent happens on Google's own domain; the callback lands back on the
      // API, which is the only party that ever sees the authorization code.
      window.location.href = res.data.authUrl;
      return;
    }
    setActionError(res.error?.message ?? "Could not start the Google connection.");
  };

  const endGoogleConnect = async () => {
    setBusy(true);
    setActionError(null);
    const res = await disconnectGoogle();
    setBusy(false);
    if (!res.success) {
      setActionError(res.error?.message ?? "Could not disconnect Google.");
      return;
    }
    void google.reload();
  };

  const loading = google.loading && !google.loaded;

  return (
    <PageContainer>
      <PageHeader
        title="Integrations"
        description="External systems this deployment can reach. Every outbound action stays behind the approval boundary — nothing on this page sends anything."
      />

      {loading && <LoadingState label="Checking connections…" />}

      {actionError && (
        <div className="mb-4">
          <ErrorState message={actionError} onRetry={() => setActionError(null)} retryLabel="Dismiss" />
        </div>
      )}

      <div className="grid gap-4">
        {/* ---------------------------------------------------------------- */}
        <IntegrationPanel
          name="Google"
          description="Google Ads, read-only. OAuth tokens are encrypted at rest and never reach this page."
          statusLabel={
            googleNotDeployed
              ? "Not deployed"
              : !google.data?.configured
                ? "Not configured"
                : google.data.connected
                  ? "Connected"
                  : "Not connected"
          }
          statusTone={
            googleNotDeployed || !google.data?.configured
              ? "neutral"
              : google.data.connected
                ? "ok"
                : "warn"
          }
          tone={google.data?.connected ? "default" : "warning"}
          actions={
            google.data?.configured ? (
              google.data.connected ? (
                <Button variant="danger" size="sm" disabled={busy} onClick={() => void endGoogleConnect()}>
                  Disconnect
                </Button>
              ) : (
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void startGoogleConnect()}>
                  Connect Google
                </Button>
              )
            ) : undefined
          }
        >
          {googleNotDeployed ? (
            <p className="text-sm text-sys-dim">
              The Google router is not mounted. Set JARVIS_ENCRYPTION_KEY on the server to enable it.
            </p>
          ) : google.error ? (
            <ErrorState message={google.error} onRetry={() => void google.reload()} />
          ) : !google.data?.configured ? (
            <p className="text-sm text-sys-dim">
              Google credentials are not configured on the server, so a connection cannot be started.
            </p>
          ) : google.data.connected && google.data.account ? (
            <div className="space-y-2">
              <p className="text-sm text-white">{google.data.account.email}</p>
              <div className="flex flex-wrap gap-1.5">
                {google.data.account.scopes.map((scope) => (
                  <Badge key={scope} tone="neutral" title={scope}>
                    {scope.split("/").pop()}
                  </Badge>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-sys-dim">
              Credentials are configured. No Google account is linked yet.
            </p>
          )}
        </IntegrationPanel>

        {/* ---------------------------------------------------------------- */}
        <IntegrationPanel
          name="WhatsApp"
          description="Inbound messages are recorded. Sending is an approval-gated action taken through the assistant."
          statusLabel={whatsappNotDeployed ? "Not deployed" : whatsapp.error ? "Unknown" : "Available"}
          statusTone={whatsappNotDeployed ? "neutral" : whatsapp.error ? "warn" : "ok"}
          tone={whatsappNotDeployed ? "warning" : "default"}
        >
          {whatsappNotDeployed ? (
            <p className="text-sm text-sys-dim">
              The WhatsApp router is not mounted. This integration has no status endpoint, so
              availability is inferred from the message list not responding.
            </p>
          ) : whatsapp.error ? (
            <ErrorState message={whatsapp.error} onRetry={() => void whatsapp.reload()} />
          ) : (whatsapp.data?.messages.length ?? 0) === 0 ? (
            <EmptyState title="No messages yet" message="Inbound messages will appear here." />
          ) : (
            <ul>
              {whatsapp.data!.messages.map((message) => (
                <li
                  key={message.id}
                  data-testid="whatsapp-message"
                  className="flex items-center justify-between border-b border-sys-line/50 py-2 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-sys-text">{message.body ?? `(${message.type})`}</p>
                    <p className="mt-0.5 font-mono text-[0.6rem] text-sys-dim">
                      {message.direction} · {new Date(message.timestamp).toLocaleString()}
                    </p>
                  </div>
                  <Badge tone="neutral">{message.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </IntegrationPanel>

        {/* ---------------------------------------------------------------- */}
        <IntegrationPanel
          name="n8n"
          description="Workflow automation. Triggering a workflow is approval-gated and happens through the assistant."
          statusLabel={n8nNotDeployed ? "Not deployed" : n8n.error ? "Unknown" : "Available"}
          statusTone={n8nNotDeployed ? "neutral" : n8n.error ? "warn" : "ok"}
          tone={n8nNotDeployed ? "warning" : "default"}
        >
          {n8nNotDeployed ? (
            <p className="text-sm text-sys-dim">
              The n8n router is not mounted. Set N8N_BASE_URL, N8N_API_KEY and N8N_CALLBACK_SECRET on
              the server to enable it.
            </p>
          ) : n8n.error ? (
            <ErrorState message={n8n.error} onRetry={() => void n8n.reload()} />
          ) : (
            <p className="text-sm text-sys-text">
              {n8n.data?.count ?? 0} active {n8n.data?.count === 1 ? "workflow" : "workflows"}.{" "}
              <a href="/automations" className="sys-focus text-sys-cyan underline">
                View automations
              </a>
            </p>
          )}
        </IntegrationPanel>
      </div>
    </PageContainer>
  );
}
