"use client";

// ---------------------------------------------------------------------------
// Phase 15 — campaign workspaces.
//
// A campaign here is a WORKSPACE in JARVIS: a name, a goal, dates, and the
// content, research and reports gathered under it. It is not an ad campaign,
// and nothing on this tab creates, changes, pauses or spends anything in an ad
// account. Linking Meta campaign ids only tells a report which of the ad
// account's campaigns to read.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { CAMPAIGN_STATUSES, type CampaignStatus, type CampaignWorkspaceView, type MarketingCampaignView } from "@jarvis/core/marketing";
import { createMarketingCampaign, getMarketingCampaign, updateMarketingCampaign, type MarketingStatus } from "@/lib/api";
import { Panel, StatPanel } from "@/components/dashboard/panel";
import { PanelGrid } from "@/components/dashboard/page-container";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button } from "@/components/ui/primitives";
import {
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_TONE,
  CONTENT_STATUS_LABEL,
  INPUT_CLASS,
  LABEL_CLASS,
  SELECT_CLASS,
  failureOf,
  formatDay,
  formatInstant,
} from "./format";

export function CampaignsTab({
  status,
  projectId,
  campaigns,
  inOtherProjects,
  loading,
  onChanged,
}: {
  status: MarketingStatus;
  projectId: string | null;
  campaigns: MarketingCampaignView[];
  /** Campaigns this user has in projects other than the one being shown. */
  inOtherProjects: number;
  loading: boolean;
  /** The list of campaigns changed on the server: read it again. */
  onChanged: () => Promise<void> | void;
}) {
  const canEdit = status.caller.canEdit;
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [selected, setSelected] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<CampaignWorkspaceView | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [linked, setLinked] = useState("");

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const open = useCallback(async (id: string) => {
    setSelected(id);
    setWorkspace(null);
    setWorkspaceError(null);
    const response = await getMarketingCampaign(id);
    if (response.success && response.data) {
      setWorkspace(response.data);
      setLinked(response.data.campaign.metaCampaignIds.join(", "));
    } else {
      setWorkspaceError(failureOf(response, "The campaign could not be opened."));
    }
  }, []);

  // A campaign that is no longer in the list being shown is no longer open.
  useEffect(() => {
    if (selected && !campaigns.some((campaign) => campaign.id === selected)) {
      setSelected(null);
      setWorkspace(null);
    }
  }, [campaigns, selected]);

  async function act(run: () => Promise<{ success: boolean; error?: { message?: string } }>, done: string, fallback: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    const response = await run();
    setBusy(false);
    if (!response.success) {
      setActionError(failureOf(response, fallback));
      return false;
    }
    setNotice(done);
    await onChanged();
    return true;
  }

  async function create() {
    const saved = await act(
      () =>
        createMarketingCampaign(
          {
            name: name.trim(),
            ...(objective.trim() ? { objective: objective.trim() } : {}),
            ...(startDate ? { startDate } : {}),
            ...(endDate ? { endDate } : {}),
          },
          projectId
        ),
      "Campaign workspace created. Nothing was published or changed outside JARVIS.",
      "The campaign could not be created."
    );
    if (saved) {
      setName("");
      setObjective("");
      setStartDate("");
      setEndDate("");
    }
  }

  async function change(id: string, patch: Parameters<typeof updateMarketingCampaign>[1], done: string) {
    const saved = await act(() => updateMarketingCampaign(id, patch), done, "The campaign could not be changed.");
    if (saved) await open(id);
  }

  return (
    <div className="space-y-6">
      {notice && (
        <p role="status" className="rounded border border-sys-ok/35 bg-sys-ok/10 px-3 py-2 text-sm text-sys-text">
          {notice}
        </p>
      )}
      {actionError && <ErrorState title="That did not go through" message={actionError} />}

      {canEdit && (
        <Panel title="New campaign workspace" description="A place in JARVIS to keep a campaign's content, research and reports. It creates nothing in an ad account.">
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            aria-label="New campaign"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label className={LABEL_CLASS}>
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Diwali Sale" className={INPUT_CLASS} />
            </label>
            <label className={LABEL_CLASS}>
              <span>Goal (optional)</span>
              <input value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={300} placeholder="What it is for" className={INPUT_CLASS} />
            </label>
            <label className={LABEL_CLASS}>
              <span>Starts (optional)</span>
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className={INPUT_CLASS} />
            </label>
            <label className={LABEL_CLASS}>
              <span>Ends (optional)</span>
              <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className={INPUT_CLASS} />
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
                Create workspace
              </Button>
            </div>
          </form>
        </Panel>
      )}

      <Panel title="Campaign workspaces" description="Open one to see what is planned, what went out, and what was researched and reported.">
        {loading && campaigns.length === 0 && <LoadingState lines={3} />}
        {!loading && campaigns.length === 0 && (
          <EmptyState
            title="No campaign workspaces here"
            message={
              inOtherProjects > 0
                ? `${inOtherProjects} campaign${inOtherProjects === 1 ? " is" : "s are"} in other projects. Choose “All projects” above to see ${inOtherProjects === 1 ? "it" : "them"}.`
                : "A campaign workspace keeps one campaign's content, research and reports together."
            }
          />
        )}
        <ul className="space-y-2">
          {campaigns.map((campaign) => (
            <li key={campaign.id} data-testid="campaign-row" className="flex flex-wrap items-center gap-2 rounded border border-sys-line bg-sys-edge/20 px-4 py-3">
              <div className="mr-auto min-w-0">
                <p className="truncate text-sm font-medium text-sys-text">{campaign.name}</p>
                <p className="font-mono text-xs text-sys-dim">
                  {campaign.startDate ? formatDay(campaign.startDate) : "No start date"}
                  {campaign.endDate ? ` to ${formatDay(campaign.endDate)}` : ""}
                </p>
              </div>
              <Badge tone={CAMPAIGN_STATUS_TONE[campaign.status]}>{CAMPAIGN_STATUS_LABEL[campaign.status]}</Badge>
              <Button size="sm" onClick={() => void open(campaign.id)} disabled={busy} aria-pressed={selected === campaign.id}>
                {selected === campaign.id ? "Open" : "Open workspace"}
              </Button>
            </li>
          ))}
        </ul>
      </Panel>

      {selected && workspaceError && <ErrorState message={workspaceError} onRetry={() => void open(selected)} />}
      {selected && !workspace && !workspaceError && <LoadingState label="Opening the workspace…" lines={3} />}

      {workspace && (
        <div className="space-y-4" data-testid="campaign-workspace">
          <Panel
            title={workspace.campaign.name}
            description={workspace.campaign.objective ?? "No goal written down yet."}
            action={<Badge tone={CAMPAIGN_STATUS_TONE[workspace.campaign.status]}>{CAMPAIGN_STATUS_LABEL[workspace.campaign.status]}</Badge>}
          >
            {workspace.campaign.brief && <p className="mb-3 whitespace-pre-wrap text-sm text-sys-text/85">{workspace.campaign.brief}</p>}
            {canEdit && (
              <label className="flex flex-wrap items-center gap-2 text-sm text-sys-dim">
                <span>Status</span>
                <select
                  aria-label="Campaign status"
                  value={workspace.campaign.status}
                  onChange={(event) =>
                    void change(workspace.campaign.id, { status: event.target.value }, `Status set to ${CAMPAIGN_STATUS_LABEL[event.target.value as CampaignStatus]}.`)
                  }
                  disabled={busy}
                  className={SELECT_CLASS}
                >
                  {CAMPAIGN_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {CAMPAIGN_STATUS_LABEL[value]}
                    </option>
                  ))}
                </select>
                <span className="text-xs">This is the workspace's own status. It changes nothing in an ad account.</span>
              </label>
            )}
          </Panel>

          <PanelGrid columns={4}>
            <StatPanel label="Ideas & drafts" value={workspace.content.byStatus.IDEA + workspace.content.byStatus.DRAFT} hint="Not final" />
            <StatPanel label={CONTENT_STATUS_LABEL.READY} value={workspace.content.byStatus.READY} hint="Final, not published" />
            <StatPanel label={CONTENT_STATUS_LABEL.PUBLISHED} value={workspace.content.byStatus.PUBLISHED} hint="Verified or reported by you" />
            <StatPanel
              label="Not confirmed"
              value={workspace.content.unconfirmed}
              hint="Sent, outcome unknown"
              tone={workspace.content.unconfirmed > 0 ? "warning" : "default"}
            />
          </PanelGrid>

          <Panel title="Coming up" description="The next dated items that have not gone out.">
            {workspace.content.upcoming.length === 0 ? (
              <p className="text-sm text-sys-dim">Nothing is dated from today onwards.</p>
            ) : (
              <ul className="space-y-2">
                {workspace.content.upcoming.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-2 text-sm text-sys-text">
                    <span className="font-mono text-xs text-sys-dim">{item.scheduledDate ? formatDay(item.scheduledDate) : "No date"}</span>
                    <span className="mr-auto">{item.title}</span>
                    <Badge>{CONTENT_STATUS_LABEL[item.status]}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <PanelGrid columns={2}>
            <Panel title="Latest report">
              {workspace.latestReport ? (
                <div className="space-y-1 text-sm text-sys-text">
                  <p>{workspace.latestReport.title}</p>
                  <p className="font-mono text-xs text-sys-dim">
                    {workspace.latestReport.periodStart} to {workspace.latestReport.periodEnd} · {workspace.latestReport.sourcesIncluded} of {workspace.latestReport.sourcesTotal} data
                    sources included
                  </p>
                </div>
              ) : (
                <p className="text-sm text-sys-dim">No report has been generated for this campaign.</p>
              )}
            </Panel>
            <Panel title="Latest research">
              {workspace.latestResearch.length === 0 ? (
                <p className="text-sm text-sys-dim">No page has been researched for this campaign.</p>
              ) : (
                <ul className="space-y-2">
                  {workspace.latestResearch.map((entry) => (
                    <li key={entry.id} className="text-sm text-sys-text">
                      <span className="font-mono text-xs text-sys-dim">{entry.host}</span> — {entry.headline}
                      <span className="block font-mono text-xs text-sys-dim">Read {formatInstant(entry.fetchedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </PanelGrid>

          {/* Linking only matters where there is an ad account to read. */}
          {canEdit && status.adAccount.available && (
            <Panel
              title="Meta campaigns this workspace reports on"
              description="Their ids, separated by commas. A report for this workspace then reads only these. It changes nothing in the ad account. Leave empty to report on the whole account."
            >
              <form
                className="flex flex-wrap items-end gap-2"
                aria-label="Linked Meta campaigns"
                onSubmit={(event) => {
                  event.preventDefault();
                  const ids = linked
                    .split(/[\s,]+/)
                    .map((id) => id.trim())
                    .filter(Boolean);
                  void change(workspace.campaign.id, { metaCampaignIds: ids }, ids.length > 0 ? "Linked. Reports for this workspace will read those campaigns." : "Unlinked. Reports will read the whole account.");
                }}
              >
                <label className={`${LABEL_CLASS} min-w-56 flex-1`}>
                  <span>Meta campaign ids</span>
                  <input value={linked} onChange={(event) => setLinked(event.target.value)} placeholder="120210000000000001, 120210000000000002" className={INPUT_CLASS} />
                </label>
                <Button type="submit" disabled={busy}>
                  Save
                </Button>
              </form>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
