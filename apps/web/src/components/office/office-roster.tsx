"use client";

// ---------------------------------------------------------------------------
// VO-1 — the roster.
//
// The floor draws only registered agents. The agents a deployment declares but
// did not construct are listed here, explicitly OUTSIDE the floor and labelled
// "not on this deployment" — visible, so the absence is legible, but never
// dressed as an employee.
// ---------------------------------------------------------------------------

import { Badge } from "@/components/ui/primitives";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState } from "@/components/dashboard/states";
import {
  OFFICE_DEPARTMENTS,
  type OfficeAgentActor,
} from "./office-model";
import type { AgentSummary } from "@/lib/api";

function departmentLabel(id: string): string {
  return OFFICE_DEPARTMENTS.find((department) => department.id === id)?.label ?? id;
}

export function OfficeRoster({
  agents,
  unavailable,
}: {
  agents: OfficeAgentActor[];
  unavailable: AgentSummary[];
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="office-roster">
      <Panel title="Agents on this floor" description="Read from the live agent registry.">
        {agents.length === 0 ? (
          <EmptyState
            title="No agents registered"
            message="This deployment constructed no agents. The floor shows only JARVIS system work."
          />
        ) : (
          <ul className="space-y-1.5">
            {agents.map((agent) => (
              <li
                key={agent.id}
                data-testid="office-roster-agent"
                data-agent-id={agent.id}
                className="flex items-center justify-between gap-3 rounded border border-sys-line/60 bg-sys-edge/10 px-2.5 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-sys-text">
                    {agent.label}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-hud text-sys-dim">
                    {departmentLabel(agent.department)}
                  </span>
                </span>
                <Badge
                  tone={
                    agent.state === "recent"
                      ? "ok"
                      : agent.state === "attention"
                        ? "danger"
                        : agent.state === "waiting"
                          ? "warn"
                          : "neutral"
                  }
                >
                  {agent.stateLabel}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Declared, not on this deployment"
        description="Policies compiled into the server whose integration is not configured here."
      >
        {unavailable.length === 0 ? (
          <p className="text-sm text-sys-dim">
            Every declared agent is registered on this deployment.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {unavailable.map((agent) => (
              <li
                key={agent.agentId}
                data-testid="office-unavailable-agent"
                data-agent-id={agent.agentId}
                className="flex items-center justify-between gap-3 rounded border border-dashed border-sys-line/60 px-2.5 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs text-sys-text/80">
                    {agent.agentId}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-hud text-sys-dim">
                    {agent.domain}
                  </span>
                </span>
                <Badge tone="warn">Not registered</Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
