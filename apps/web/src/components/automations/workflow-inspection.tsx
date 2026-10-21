"use client";

// ---------------------------------------------------------------------------
// Phase 18.3B — one library workflow's sanitized structure, and its trigger
// allow-list proposal.
//
// WHAT IS SHOWN IS WHAT THE SERVER SENT, and the server sends only the
// sanitized view: trigger kinds, node types, integration categories, version,
// how current the catalog is, and what cannot be known. There is no field for
// a parameter, a credential, an input name or a URL — none can be drawn.
//
// A PROPOSAL IS NOT A CHANGE, and the panel never words it as one:
//   proposed  → another owner or admin must approve it on the Approvals page
//   approved  → "Add to trigger allow-list" appears (an on-screen action)
//   added     → only when the server says the entry is on the allow-list
// The Propose button appears only when the server says this reader may
// propose; the Add button only for an approved proposal. There is no
// activate, edit, run or publish control.
// ---------------------------------------------------------------------------

import { useState } from "react";
import {
  applyWorkflowAllowlistProposal,
  getWorkflowInspection,
  proposeWorkflowForAllowlist,
  type LibraryInspection,
} from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, type Tone } from "@/components/ui/primitives";

const UNAUTHORIZED = new Set(["NOT_AVAILABLE", "PERMISSION_DENIED"]);

const PROPOSAL_LABEL: Record<NonNullable<LibraryInspection["proposal"]>["status"], { label: string; tone: Tone }> = {
  none: { label: "No proposal", tone: "neutral" },
  awaiting_approval: { label: "Proposed — awaiting approval", tone: "info" },
  approved: { label: "Approved — ready to add", tone: "ok" },
  rejected: { label: "Proposal rejected", tone: "danger" },
  expired: { label: "Proposal expired", tone: "warn" },
  used: { label: "Proposal used", tone: "neutral" },
};

const ALLOWLIST_LABEL: Record<LibraryInspection["allowlist"]["status"], { label: string; tone: Tone }> = {
  not_on_allowlist: { label: "Not on your trigger allow-list", tone: "neutral" },
  on_allowlist: { label: "On your trigger allow-list", tone: "ok" },
  on_allowlist_other_version: { label: "On your allow-list at another version", tone: "warn" },
};

const when = (iso: string) => new Date(iso).toLocaleString();

export function WorkflowInspectionPanel({ entryId, onClose }: { entryId: string; onClose: () => void }) {
  const inspection = useResource(() => getWorkflowInspection(entryId), [entryId], {
    fallbackError: "Could not inspect this workflow.",
  });
  const [pending, setPending] = useState<"propose" | "apply" | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);

  const act = async (kind: "propose" | "apply", approvalId?: string) => {
    if (pending) return;
    setPending(kind);
    setNotice(null);
    const res =
      kind === "propose"
        ? await proposeWorkflowForAllowlist(entryId)
        : await applyWorkflowAllowlistProposal(entryId, approvalId ?? "");
    setPending(null);
    if (res.success && res.data) {
      if (kind === "propose") {
        const proposal = res.data as { existing: boolean; status: string };
        setNotice({
          tone: "info",
          text: proposal.existing
            ? "A proposal for this version is already waiting."
            : "Proposed. Another owner or admin of your organization must approve it on the Approvals page. Nothing has changed yet.",
        });
      } else {
        const applied = res.data as { outcome: string };
        setNotice({
          tone: "ok",
          text:
            applied.outcome === "unchanged"
              ? "It was already on your trigger allow-list."
              : "Added to your trigger allow-list. Triggering it still needs your approval each time.",
        });
      }
    } else {
      setNotice({ tone: "danger", text: res.error?.message ?? "That did not work." });
    }
    await inspection.reload();
  };

  const header = (
    <Button variant="ghost" size="sm" onClick={onClose}>
      Close
    </Button>
  );

  if (inspection.loading && !inspection.loaded) {
    return (
      <Panel title="Workflow structure" action={header} className="mt-4">
        <LoadingState label="Inspecting the workflow…" />
      </Panel>
    );
  }

  if (inspection.error) {
    const code = inspection.errorCode ?? "";
    return (
      <Panel title="Workflow structure" action={header} className="mt-4">
        {UNAUTHORIZED.has(code) ? (
          <EmptyState title="Not available to your account" message={inspection.error} />
        ) : code === "ENTRY_NOT_FOUND" ? (
          <EmptyState title="No longer in the library" message={inspection.error} />
        ) : (
          <ErrorState title="Could not inspect this workflow" message={inspection.error} onRetry={() => void inspection.reload()} />
        )}
      </Panel>
    );
  }

  const view = inspection.data;
  if (!view) return null;
  const proposal = view.proposal;
  const proposalBadge = PROPOSAL_LABEL[proposal?.status ?? "none"];
  const allowlistBadge = ALLOWLIST_LABEL[view.allowlist.status];
  const canAdd = proposal?.status === "approved" && proposal.approvalId && view.allowlist.status !== "on_allowlist";

  return (
    <Panel
      title={`Workflow structure — ${view.name}`}
      description={`As of the catalog's last sighting, ${when(view.observedAt)} · inspected ${when(view.inspectedAt)}`}
      action={header}
      className="mt-4"
      data-testid="workflow-inspection"
    >
      {view.stale.stale && (
        <p className="mb-3 text-sm text-amber-300" data-testid="inspection-stale">
          Stale: {view.stale.reason}
        </p>
      )}

      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-mono text-xs uppercase tracking-hud text-sys-dim">Trigger</dt>
          <dd className="mt-1 text-sys-text" data-testid="inspection-trigger">
            {view.trigger.status === "derived"
              ? view.trigger.kinds.map((k) => `${k.kind.replace("_", " ")} (${k.nodeType})`).join(", ")
              : view.trigger.status === "none_found"
                ? "No recognized trigger node."
                : "Unknown — the listing did not include nodes."}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-xs uppercase tracking-hud text-sys-dim">Version</dt>
          <dd className="mt-1 font-mono text-xs text-sys-text">{view.versionId ?? "Not reported by n8n"}</dd>
        </div>
        <div>
          <dt className="font-mono text-xs uppercase tracking-hud text-sys-dim">Integrations</dt>
          <dd className="mt-1 text-sys-text" data-testid="inspection-integrations">
            {view.integrations.status === "unavailable"
              ? "Unknown"
              : view.integrations.categories.length === 0
                ? "None recognized"
                : view.integrations.categories.map((c) => c.category.replace("_", " ")).join(", ")}
            {view.integrations.unrecognized.length > 0 && (
              <span className="text-sys-dim"> · {view.integrations.unrecognized.length} unrecognized node types</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-xs uppercase tracking-hud text-sys-dim">
            Node types{view.nodeTypes.count !== null ? ` (${view.nodeTypes.count} nodes)` : ""}
          </dt>
          <dd className="mt-1 break-words font-mono text-xs text-sys-dim" data-testid="inspection-node-types">
            {view.nodeTypes.status === "unavailable" ? "Unknown" : view.nodeTypes.items.join(", ")}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="font-mono text-xs uppercase tracking-hud text-sys-dim">Inputs</dt>
          <dd className="mt-1 text-sys-dim">Not available — {view.inputs.reason}</dd>
        </div>
      </dl>

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-sys-dim" data-testid="inspection-limitations">
        {view.limitations.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="inspection-allowlist">
        <Badge tone={allowlistBadge.tone}>{allowlistBadge.label}</Badge>
        {proposal && <Badge tone={proposalBadge.tone}>{proposalBadge.label}</Badge>}
        {view.canPropose && (
          <Button size="sm" variant="secondary" disabled={pending !== null} onClick={() => void act("propose")}>
            {pending === "propose" ? "Proposing…" : "Propose for trigger allow-list"}
          </Button>
        )}
        {canAdd && (
          <Button size="sm" variant="primary" disabled={pending !== null} onClick={() => void act("apply", proposal.approvalId!)}>
            {pending === "apply" ? "Adding…" : "Add to trigger allow-list"}
          </Button>
        )}
      </div>
      {!view.canPropose && view.proposeBlockedReason && !canAdd && (
        <p className="mt-2 text-xs text-sys-dim" data-testid="inspection-blocked">
          {view.proposeBlockedReason}
        </p>
      )}
      {proposal?.status === "awaiting_approval" && (
        <p className="mt-2 text-xs text-sys-dim">
          A proposal is not a change: another owner or admin of your organization approves it on the Approvals page, then it can be added here.
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-sys-text" data-tone={notice.tone} data-testid="inspection-notice">
          {notice.text}
        </p>
      )}
    </Panel>
  );
}
