"use client";

// ---------------------------------------------------------------------------
// UI V2 — Automations (n8n).
//
// READ-ONLY BY CONSTRUCTION. There is no HTTP endpoint that creates, edits or
// triggers a workflow — triggering is the `n8n.trigger` tool, which is
// EXTERNAL_SIDE_EFFECT and approval-gated, reachable only through the
// assistant. So this page shows what exists and what ran, and offers no run
// button, because a button here would have to bypass the approval boundary to
// work.
//
// When n8n is not configured the entire router is unmounted and every call
// 404s. That is "not deployed", not an error, and is rendered as such.
// ---------------------------------------------------------------------------

import {
  isNotDeployed,
  listN8nExecutions,
  listN8nWorkflows,
  type N8nExecution,
} from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { PageContainer, PageHeader, PanelGrid } from "@/components/dashboard/page-container";
import { Panel, StatPanel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, DataTable, StatusDot, type Tone } from "@/components/ui/primitives";

function statusTone(status: string): Tone {
  const normalized = status.toUpperCase();
  if (normalized.includes("SUCCESS") || normalized === "COMPLETED") return "ok";
  if (normalized.includes("FAIL") || normalized.includes("ERROR")) return "danger";
  if (normalized.includes("PENDING") || normalized.includes("RUNNING")) return "info";
  return "neutral";
}

export default function AutomationsPage() {
  const workflows = useResource(listN8nWorkflows, [], {
    fallbackError: "Could not load workflows.",
  });
  const executions = useResource(() => listN8nExecutions(50), [], {
    fallbackError: "Could not load executions.",
  });

  // The whole n8n router is unmounted when the integration is unconfigured, so
  // its routes fall through to the terminal 404 handler. That is "not
  // deployed", not a failure, and both requests hit the same router so one
  // answer settles it.
  const notDeployed = workflows.loaded && isNotDeployed({ code: workflows.errorCode ?? "", message: "" });

  const workflowList = workflows.data?.workflows ?? [];
  const executionList = executions.data?.executions ?? [];

  const loading = (workflows.loading && !workflows.loaded) || (executions.loading && !executions.loaded);

  return (
    <PageContainer>
      <PageHeader
        title="Automations"
        description="Workflows registered in n8n and their recent runs. Read-only — triggering a workflow is an approval-gated action taken through the assistant."
      />

      {loading && <LoadingState label="Loading automations…" />}

      {!loading && notDeployed && (
        <EmptyState
          title="n8n is not connected"
          message="This deployment has no n8n configuration, so there are no workflows to show. Set N8N_BASE_URL, N8N_API_KEY and N8N_CALLBACK_SECRET on the server to enable it."
        />
      )}

      {!loading && !notDeployed && workflows.error && (
        <ErrorState
          title="Could not load workflows"
          message={workflows.error}
          onRetry={() => void workflows.reload()}
        />
      )}

      {!loading && !notDeployed && !workflows.error && (
        <>
          <PanelGrid columns={3} className="mb-6">
            <StatPanel label="Active workflows" value={workflowList.length} />
            <StatPanel label="Recent runs" value={executionList.length} hint="Last 50" />
            <StatPanel
              label="Failed runs"
              value={executionList.filter((e) => statusTone(e.status) === "danger").length}
              tone={
                executionList.some((e) => statusTone(e.status) === "danger") ? "danger" : "default"
              }
            />
          </PanelGrid>

          <Panel
            title="Workflows"
            description="Only active workflows are listed. Webhook paths are never exposed."
            className="mb-4"
          >
            {workflowList.length === 0 ? (
              <EmptyState
                title="No active workflows"
                message="Nothing is registered for this account yet."
              />
            ) : (
              <ul>
                {workflowList.map((workflow) => (
                  <li
                    key={workflow.id}
                    data-testid="workflow-row"
                    className="flex items-center justify-between border-b border-sys-line/50 py-3 last:border-0"
                  >
                    <div>
                      <p className="text-sm text-white">{workflow.name}</p>
                      <p className="mt-0.5 font-mono text-xs text-sys-dim">{workflow.id}</p>
                    </div>
                    <StatusDot
                      tone={workflow.isActive ? "ok" : "neutral"}
                      label={workflow.isActive ? "Active" : "Inactive"}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Recent executions" description="Newest first">
            {executions.error ? (
              <ErrorState message={executions.error} onRetry={() => void executions.reload()} />
            ) : executionList.length === 0 ? (
              <EmptyState title="No runs yet" message="Executions appear here once a workflow runs." />
            ) : (
              <DataTable<N8nExecution>
                caption="Recent n8n workflow executions, newest first"
                rows={executionList}
                rowKey={(row) => row.id}
                columns={[
                  {
                    key: "workflow",
                    header: "Workflow",
                    render: (row) => (
                      <span className="font-mono text-xs text-sys-text">{row.workflowId}</span>
                    ),
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
                  },
                  {
                    key: "summary",
                    header: "Result",
                    render: (row) => (
                      <span className="text-sys-dim">
                        {row.resultSummary ?? row.errorCode ?? "—"}
                      </span>
                    ),
                  },
                  {
                    key: "triggered",
                    header: "Triggered",
                    render: (row) => new Date(row.triggeredAt).toLocaleString(),
                  },
                ]}
              />
            )}
          </Panel>
        </>
      )}
    </PageContainer>
  );
}
