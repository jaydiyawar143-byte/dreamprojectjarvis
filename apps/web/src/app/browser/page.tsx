"use client";

// ---------------------------------------------------------------------------
// UI V2 — Browser Agent.
//
// WHY THIS PAGE EXISTS. The sidebar's rule is that it links only to pages that
// exist, so "Browser" was previously omitted rather than pointed at nothing.
// The capability is real — there is a `browser-agent` in the registry and a
// BrowserRuntime behind it — so the honest fix is a page that reports its true
// state, not a dead nav entry and not a removed one.
//
// Everything here comes from GET /api/v1/agents. The browser agent registers
// only when the runtime is enabled server-side, so on most deployments this
// page's job is to say clearly that the capability is present but switched off,
// and what would switch it on.
//
// It deliberately offers NO controls. Driving a browser is `browser.navigate`
// and friends — approval-gated tools reachable through the assistant, behind a
// human decision and an audit entry. A "go to URL" box here would be a second
// path to the same side effects that skipped both.
// ---------------------------------------------------------------------------

import { Globe, ShieldCheck, Wrench } from "lucide-react";

import { listAgents, type AgentSummary } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { PageContainer, PageHeader } from "@/components/dashboard/page-container";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, StatusDot } from "@/components/ui/primitives";

const BROWSER_AGENT_ID = "browser-agent";

export default function BrowserPage() {
  const agents = useResource<{ agents: AgentSummary[] }>(listAgents, []);

  const agent = agents.data?.agents?.find((a) => a.agentId === BROWSER_AGENT_ID);
  const available = agent?.availability === "AVAILABLE";

  return (
    <PageContainer>
      <PageHeader
        title="Browser"
        description="The browser agent, and whether this deployment can actually drive one."
      />

      {agents.loading && !agents.loaded && <LoadingState lines={3} />}

      {agents.error && (
        <ErrorState message={agents.error} onRetry={() => void agents.reload()} />
      )}

      {agents.loaded && !agent && (
        <Panel title="Browser agent">
          <EmptyState
            title="Not present in this build"
            message="The agent registry does not report a browser agent, so there is nothing to configure or drive here."
          />
        </Panel>
      )}

      {agent && (
        <div className="space-y-5">
          <Panel
            title={
              <span className="flex items-center gap-2">
                <Globe size={15} className="text-sys-dim" aria-hidden="true" />
                Browser agent
              </span>
            }
            description={agent.description}
            action={
              <StatusDot
                tone={available ? "ok" : "neutral"}
                label={available ? "Available" : "Unavailable"}
              />
            }
          >
            <div className="space-y-3">
              <p className="text-sm text-sys-text/85">
                {available
                  ? "The browser runtime is enabled. Ask the assistant to browse; every navigation and interaction runs as an approval-gated tool."
                  : "The capability exists but the browser runtime is not enabled on this server, so the agent is not registered and cannot be used."}
              </p>

              {!available && (
                <p className="text-xs text-sys-dim">
                  Set <code className="text-sys-text/80">BROWSER_ENABLED=true</code> on the API and
                  restart. Until then the assistant will not route browsing requests here.
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge tone="info">{agent.domain}</Badge>
                <Badge>
                  <Wrench size={11} className="mr-1 inline" aria-hidden="true" />
                  {agent.toolCount} tool{agent.toolCount === 1 ? "" : "s"}
                </Badge>
                {agent.writesRequireApproval && (
                  <Badge tone="danger" title="This is a fixed policy, not a preference.">
                    <ShieldCheck size={11} className="mr-1 inline" aria-hidden="true" />
                    Writes require approval
                  </Badge>
                )}
              </div>
            </div>
          </Panel>

          <Panel
            title="Tools"
            description="What this agent is permitted to call. Read from the live registry, not a fixed list."
          >
            {agent.allowedTools.length === 0 ? (
              <EmptyState
                title="No tools allowed"
                message="The agent is registered with an empty allowlist, so it can call nothing."
              />
            ) : (
              <ul className="flex flex-wrap gap-2">
                {agent.allowedTools.map((tool) => (
                  <li
                    key={tool}
                    className="rounded border border-sys-line bg-white/[0.02] px-2 py-1 font-mono text-xs text-sys-text/80"
                  >
                    {tool}
                  </li>
                ))}
              </ul>
            )}

            <p className="pt-4 text-xs leading-relaxed text-sys-dim">
              There are no controls on this page by design. Browsing runs through the assistant so
              that each action passes the same approval gate and lands in the audit trail; a
              &ldquo;go to URL&rdquo; box here would be a second route to the same side effects
              that skipped both.
            </p>
          </Panel>
        </div>
      )}
    </PageContainer>
  );
}
