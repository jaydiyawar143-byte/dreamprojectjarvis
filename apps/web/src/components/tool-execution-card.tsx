"use client";

import { Loader2, CheckCircle2, XCircle, Wrench } from "lucide-react";

interface ToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

interface ToolResult {
  toolId: string;
  status: string;
  result?: unknown;
}

interface Props {
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

function toolDisplayName(toolId: string): string {
  const map: Record<string, string> = {
    "meta.campaign.create": "Create Campaign",
    "meta.campaign.pause": "Pause Campaign",
    "meta.campaign.resume": "Resume Campaign",
    "meta.campaign.delete": "Delete Campaign",
    "meta.adset.create": "Create Ad Set",
    "meta.adset.update": "Update Ad Set",
    "meta.ad.create": "Create Ad",
    "meta.report.get": "Fetch Report",
    "meta.audience.list": "List Audiences",
  };
  return map[toolId] ?? toolId;
}

export function ToolExecutionCard({ toolCalls, toolResults }: Props) {
  if (!toolCalls || toolCalls.length === 0) return null;

  const resultsByToolId = new Map<string, ToolResult>();
  if (toolResults) {
    for (const r of toolResults) resultsByToolId.set(r.toolId, r);
  }

  return (
    <div className="mt-2 space-y-1.5">
      {toolCalls.map((tc) => {
        const result = resultsByToolId.get(tc.name);
        const status = result?.status ?? "running";

        return (
          <div
            key={tc.id}
            className="flex items-center gap-2 rounded-lg bg-gray-800/50 border border-gray-700 px-3 py-2 text-xs"
          >
            {status === "running" ? (
              <Loader2 size={14} className="text-indigo-400 animate-spin shrink-0" />
            ) : status === "completed" ? (
              <CheckCircle2 size={14} className="text-green-400 shrink-0" />
            ) : status === "approval_required" ? (
              <Wrench size={14} className="text-yellow-400 shrink-0" />
            ) : (
              <XCircle size={14} className="text-red-400 shrink-0" />
            )}

            <span className="text-gray-300 font-medium">{toolDisplayName(tc.name)}</span>

            {status === "running" && (
              <span className="text-gray-500 ml-auto">Executing...</span>
            )}
            {status === "completed" && (
              <span className="text-green-500/70 ml-auto">Done</span>
            )}
            {status === "approval_required" && (
              <span className="text-yellow-500/70 ml-auto">Awaiting approval</span>
            )}
            {status === "failed" && (
              <span className="text-red-500/70 ml-auto">Failed</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
