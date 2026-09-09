"use client";

// ---------------------------------------------------------------------------
// Integration Control Center.
//
// Replaces the passive status page. An operator can now see every integration's
// real health, verify it against the provider, open its detail, and reach the
// action that changes it.
//
// THREE THINGS IT DELIBERATELY DOES NOT DO.
//
// 1. IT DOES NOT SAVE SECRETS. The credential form stays at Settings →
//    Connections, which is the one path that validates, encrypts, stores and
//    audits. A second form here would be a second way to get that wrong. The
//    drawer links there instead.
//
// 2. IT DOES NOT EXECUTE. There is no button that sends a WhatsApp message,
//    triggers a workflow or changes a Meta budget. Those are tools, and tools
//    run USER → Orchestrator → agent → ToolExecutor → permission → approval →
//    audit. A dashboard shortcut around that is the one thing this page must
//    never become.
//
// 3. IT DOES NOT GUESS. An integration whose credentials exist but has not been
//    verified reads "Not checked", never "Connected". The Test button is the
//    only thing that can produce a green dot, and the timestamp of that test is
//    shown beside it.
//
// Status is refreshed after every action rather than polled: nothing here
// changes on its own, so a timer would only cost requests.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";

import {
  connectGoogle,
  disconnectGoogle,
  listIntegrations,
  refreshIntegration,
  removeCredentials,
  testIntegration,
  type Integration,
  type IntegrationCategory,
} from "@/lib/api";
import { PageContainer, PageHeader } from "@/components/dashboard/page-container";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { IntegrationCard } from "@/components/integrations/integration-card";
import { IntegrationDrawer } from "@/components/integrations/integration-drawer";

type Filter = "all" | "connected" | "not-connected" | "attention";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "connected", label: "Connected" },
  { id: "not-connected", label: "Not connected" },
  { id: "attention", label: "Needs attention" },
];

const CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  google: "Google",
  maps: "Maps",
  communication: "Communication",
  automation: "Automation",
  advertising: "Advertising",
};

/** Which bucket a health value falls into for the filter row. */
function matchesFilter(integration: Integration, filter: Filter): boolean {
  switch (filter) {
    case "connected":
      return integration.health === "CONNECTED";
    case "not-connected":
      return integration.health === "NOT_CONNECTED" || integration.health === "DISABLED";
    case "attention":
      // Anything an operator would want to act on: a failed check, a partial
      // configuration, or a degraded provider. "Not checked" is not attention —
      // it is simply unverified.
      return (
        integration.health === "ERROR" ||
        integration.health === "DEGRADED" ||
        integration.health === "CONFIG_REQUIRED"
      );
    default:
      return true;
  }
}

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listIntegrations();
    setLoading(false);

    if (res.success && res.data) {
      setIntegrations(res.data.integrations);
      setError(null);
      return;
    }
    setIntegrations(null);
    setError(res.error?.message ?? "Integration status could not be read.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Replaces one card in place, so a test does not reload the whole list. */
  const patch = useCallback((id: string, next: Partial<Integration>) => {
    setIntegrations((current) =>
      current ? current.map((i) => (i.id === id ? { ...i, ...next } : i)) : current
    );
  }, []);

  const runTest = useCallback(
    async (id: string) => {
      setBusyId(id);
      setNotice(null);
      const res = await testIntegration(id);
      setBusyId(null);

      if (res.success && res.data) {
        patch(id, {
          health: res.data.health,
          detail: res.data.detail,
          lastCheckedAt: res.data.checkedAt,
          lastError:
            res.data.health === "ERROR" || res.data.health === "DEGRADED" ? res.data.detail : null,
        });
        return;
      }
      setNotice(res.error?.message ?? "The connection test could not be completed.");
    },
    [patch]
  );

  const runConnect = useCallback(async (integration: Integration) => {
    setBusyId(integration.id);
    setNotice(null);

    // Google is the only OAuth integration. Everything else is configured on the
    // server or through the credential form, and says so.
    if (integration.id === "google") {
      const res = await connectGoogle();
      setBusyId(null);
      if (res.success && res.data?.authUrl) {
        // The authorisation URL is built and signed by the server; the browser
        // only follows it.
        window.location.href = res.data.authUrl;
        return;
      }
      setNotice(res.error?.message ?? "Could not start the Google authorization flow.");
      return;
    }

    setBusyId(null);
    setNotice(
      integration.actions.configureUrl
        ? "Enter credentials at Settings → Connections, then test the connection here."
        : "This integration is configured from the server environment. Set its variables and restart."
    );
  }, []);

  const runDisconnect = useCallback(
    async (integration: Integration) => {
      setBusyId(integration.id);
      setNotice(null);

      // Both paths go through the EXISTING endpoints, which revoke where the
      // provider supports it, delete the encrypted credential and write an
      // audit event. Nothing is deleted here directly.
      const res =
        integration.id === "google" ? await disconnectGoogle() : await removeCredentials("meta");

      if (!res.success) {
        setBusyId(null);
        setNotice(res.error?.message ?? "Could not disconnect.");
        return;
      }

      // Drop the cached verdict so the card cannot keep showing a result from
      // before the credential was removed.
      const refreshed = await refreshIntegration(integration.id);
      setBusyId(null);
      if (refreshed.success && refreshed.data) {
        patch(integration.id, refreshed.data);
        setOpenId(null);
      } else {
        void load();
      }
    },
    [patch, load]
  );

  const visible = useMemo(() => {
    if (!integrations) return [];
    const needle = query.trim().toLowerCase();
    return integrations.filter((i) => {
      if (!matchesFilter(i, filter)) return false;
      if (!needle) return true;
      return (
        i.name.toLowerCase().includes(needle) ||
        i.subtitle.toLowerCase().includes(needle) ||
        CATEGORY_LABEL[i.category].toLowerCase().includes(needle) ||
        i.capabilities.some((c) => c.label.toLowerCase().includes(needle))
      );
    });
  }, [integrations, query, filter]);

  const grouped = useMemo(() => {
    const map = new Map<IntegrationCategory, Integration[]>();
    for (const integration of visible) {
      const list = map.get(integration.category) ?? [];
      list.push(integration);
      map.set(integration.category, list);
    }
    return [...map.entries()];
  }, [visible]);

  const open = integrations?.find((i) => i.id === openId) ?? null;

  const counts = useMemo(() => {
    const all = integrations ?? [];
    return {
      total: all.length,
      connected: all.filter((i) => i.health === "CONNECTED").length,
      attention: all.filter((i) => matchesFilter(i, "attention")).length,
    };
  }, [integrations]);

  return (
    <PageContainer>
      <PageHeader
        title="Integration Control Center"
        description="Connect, verify and monitor everything JARVIS talks to. Credentials are stored encrypted on the server and never returned to the browser."
      />

      {loading && <LoadingState label="Reading integration status" />}

      {!loading && error && (
        <ErrorState title="Integrations unavailable" message={error} onRetry={() => void load()} />
      )}

      {!loading && !error && integrations && (
        <div className="space-y-5">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <label htmlFor="integration-search" className="sr-only">
                Search integrations
              </label>
              <Search
                size={12}
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sys-dim"
              />
              <input
                id="integration-search"
                data-testid="integration-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search integrations…"
                className="sys-focus w-full rounded-md border border-sys-control bg-black/40 py-1.5 pl-7 pr-2 text-sm text-white placeholder:text-sys-dim"
              />
            </div>

            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter integrations">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  data-testid={`integration-filter-${f.id}`}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                  className={`sys-focus rounded border px-2 py-1 font-mono text-xs uppercase tracking-hud transition-colors ${
                    filter === f.id
                      ? "border-sys-cyan/40 bg-sys-cyan/10 text-sys-cyan"
                      : "border-sys-line text-sys-dim hover:text-white"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <p data-testid="integration-summary" className="text-xs text-sys-dim">
            {counts.connected} of {counts.total} verified connected
            {counts.attention > 0 && ` · ${counts.attention} need attention`}
          </p>

          {notice && (
            <p data-testid="integration-notice" className="text-xs leading-relaxed text-amber-300/90">
              {notice}
            </p>
          )}

          {visible.length === 0 && (
            <EmptyState
              title="No integrations match"
              message="Try a different search or filter."
            />
          )}

          {grouped.map(([category, items]) => (
            <section key={category} className="space-y-3">
              <h2 className="font-mono text-xs uppercase tracking-hud text-sys-dim">
                {CATEGORY_LABEL[category]}
              </h2>
              <div className="grid gap-3 lg:grid-cols-2">
                {items.map((integration) => (
                  <IntegrationCard
                    key={integration.id}
                    integration={integration}
                    busy={busyId === integration.id}
                    onTest={() => void runTest(integration.id)}
                    onManage={() => setOpenId(integration.id)}
                    onConnect={() => void runConnect(integration)}
                    onDisconnect={() => void runDisconnect(integration)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {open && (
        <IntegrationDrawer
          integration={open}
          busy={busyId === open.id}
          onClose={() => setOpenId(null)}
          onTest={() => void runTest(open.id)}
        />
      )}
    </PageContainer>
  );
}
