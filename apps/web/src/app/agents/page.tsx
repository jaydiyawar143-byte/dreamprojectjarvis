"use client";

// ---------------------------------------------------------------------------
// UI V2 — Agent Center.
//
// Every card here is drawn from GET /api/v1/agents. Nothing is hardcoded, and
// that is the point: four of the eight agents register only when their
// integration is configured, so a static list would tell an operator this
// deployment can send WhatsApp messages when it cannot.
//
// The page answers three questions and refuses to answer a fourth:
//
//   WHAT CAN IT DO   — domain, description, tool count
//   CAN IT RIGHT NOW — AVAILABLE / UNAVAILABLE, from live registration
//   WHO SAYS SO      — every agent gates its writes behind a human
//
// It does NOT show recent per-agent activity. The activity endpoint records a
// `toolId` but not reliably an `agentId`, so a per-agent feed would be built on
// a join that does not hold. The Activity page shows the real timeline instead.
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Bot, ShieldCheck, Wrench } from "lucide-react";

import { listAgents, type AgentSummary } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { PageContainer, PageHeader, PanelGrid } from "@/components/dashboard/page-container";
import { Panel, StatPanel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, StatusDot, Tabs } from "@/components/ui/primitives";

type Filter = "all" | "available" | "unavailable";

/** Human labels for the registry's domain slugs. */
const DOMAIN_LABEL: Record<string, string> = {
  general: "General",
  "meta-ads": "Meta Ads",
  "google-ads": "Google Ads",
  knowledge: "Knowledge",
  analytics: "Analytics",
  automation: "Automation",
  communication: "Communication",
  browser: "Browser",
};

function agentTitle(agentId: string): string {
  return agentId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Why an agent is unavailable.
 *
 * The API reports THAT it did not register, not why — the registry has no such
 * field. These are the documented registration conditions from the container,
 * phrased as what an operator would have to do, and only ever shown on a card
 * that is already marked unavailable.
 */
const UNAVAILABLE_HINT: Record<string, string> = {
  "google-ads-agent": "Needs Google Ads credentials configured on the server.",
  "automation-agent": "Needs n8n configured on the server.",
  "communication-agent": "Needs WhatsApp Business credentials configured on the server.",
  "browser-agent": "Needs BROWSER_ENABLED and a Chrome or Edge executable on the server.",
};

function AgentCard({ agent }: { agent: AgentSummary }) {
  const available = agent.registered;

  return (
    <Panel
      tone={available ? "default" : "warning"}
      className={available ? undefined : "opacity-80"}
      data-testid="agent-card"
      data-agent-id={agent.agentId}
      data-available={available}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 rounded border border-sys-line bg-sys-edge/40 p-1.5 text-sys-cyan"
          >
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-white" data-testid="agent-name">
              {agentTitle(agent.agentId)}
            </h3>
            <p className="mt-0.5 font-mono text-xs uppercase tracking-hud text-sys-dim">
              {DOMAIN_LABEL[agent.domain] ?? agent.domain}
            </p>
          </div>
        </div>
        <StatusDot
          tone={available ? "ok" : "warn"}
          label={available ? "Available" : "Unavailable"}
        />
      </div>

      <p className="mt-3 text-sm leading-relaxed text-sys-text">{agent.description}</p>

      {!available && (
        <p className="mt-2 text-xs text-amber-300/90" data-testid="agent-unavailable-hint">
          {UNAVAILABLE_HINT[agent.agentId] ?? "Not registered on this deployment."}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge tone="neutral" title={agent.allowedTools.join(", ") || "No tools"}>
          <Wrench className="h-3 w-3" aria-hidden />
          {agent.toolCount} {agent.toolCount === 1 ? "tool" : "tools"}
        </Badge>

        {agent.writesRequireApproval && (
          <Badge tone="info" title="Every action beyond reading stops at an on-screen approval.">
            <ShieldCheck className="h-3 w-3" aria-hidden />
            Approval required
          </Badge>
        )}

        {!agent.clientSelectable && <Badge tone="warn">Not directly selectable</Badge>}
      </div>

      {agent.toolCount === 0 && (
        <p className="mt-3 text-xs text-sys-dim">
          Holds no tools by design — it answers from retrieved context rather than by calling
          anything.
        </p>
      )}
    </Panel>
  );
}

export default function AgentsPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const agents = useResource(listAgents, [], {
    fallbackError: "Could not load the agent registry.",
  });

  const list = agents.data?.agents ?? [];

  const shown = useMemo(() => {
    if (filter === "available") return list.filter((a) => a.registered);
    if (filter === "unavailable") return list.filter((a) => !a.registered);
    return list;
  }, [list, filter]);

  const registeredCount = agents.data?.registeredCount ?? 0;
  const total = agents.data?.total ?? 0;

  return (
    <PageContainer>
      <PageHeader
        title="Agents"
        description="Specialized agents registered on this deployment. Availability is read from the live registry, not from configuration."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void agents.reload()}>
            Refresh
          </Button>
        }
      />

      {agents.loading && !agents.loaded && <LoadingState label="Reading the agent registry…" />}

      {agents.error && (
        <ErrorState
          title="Could not load agents"
          message={agents.error}
          onRetry={() => void agents.reload()}
        />
      )}

      {agents.loaded && !agents.error && (
        <>
          <PanelGrid columns={3} className="mb-6">
            <StatPanel label="Registered" value={registeredCount} hint="Usable right now" />
            <StatPanel
              label="Declared"
              value={total}
              hint="Policies compiled into the server"
              tone="default"
            />
            <StatPanel
              label="Unavailable"
              value={total - registeredCount}
              hint="Integration not configured"
              tone={total - registeredCount > 0 ? "warning" : "default"}
            />
          </PanelGrid>

          <Tabs
            label="Filter agents by availability"
            className="mb-4"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: total },
              { value: "available", label: "Available", count: registeredCount },
              { value: "unavailable", label: "Unavailable", count: total - registeredCount },
            ]}
          />

          {shown.length === 0 ? (
            <EmptyState
              title="Nothing to show"
              message={
                filter === "unavailable"
                  ? "Every declared agent is registered on this deployment."
                  : "No agents matched this filter."
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {shown.map((agent) => (
                <AgentCard key={agent.agentId} agent={agent} />
              ))}
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
