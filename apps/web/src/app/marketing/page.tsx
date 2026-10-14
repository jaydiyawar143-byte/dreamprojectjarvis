"use client";

// ---------------------------------------------------------------------------
// Phase 15 — the Marketing screen.
//
// One workspace, five views of it: the content calendar, campaign workspaces,
// page research, reports and recommendations.
//
// THE SAME PATH AS CHAT. Every button here calls an endpoint that runs one
// tool through the server's executor — the tool the marketing agent proposes
// when the same thing is asked for in a conversation. So what is saved here is
// what chat sees, and a rule that holds there holds here.
//
// WHAT THE SCREEN KEEPS APART, because the difference is the point:
//   saved          in JARVIS's own store. Nothing left the building.
//   ready          the words are final. Still nothing left the building.
//   published      verified (JARVIS posted it and read it back), or reported
//                  by you (you said so). Never merged, never assumed.
//   advice         a recommendation. Not carried out.
//
// WHAT IT DOES NOT DRAW. A control that could not do anything: research forms
// where page reads are switched off, Publish where there is no publisher or
// the role cannot publish, editing for a role that can only read. The server
// says which of those apply (`/marketing/status`), from the same role table
// its executor enforces — and it still enforces it whatever this screen draws.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import type { MarketingCampaignView } from "@jarvis/core/marketing";
import { getMarketingStatus, listMarketingCampaigns, listProjects, type MarketingStatus, type ProjectItem } from "@/lib/api";
import { PageContainer, PageHeader } from "@/components/dashboard/page-container";
import { ErrorState, LoadingState } from "@/components/dashboard/states";
import { Tabs } from "@/components/ui/primitives";
import { CalendarTab } from "@/components/marketing/calendar-tab";
import { CampaignsTab } from "@/components/marketing/campaigns-tab";
import { ResearchTab } from "@/components/marketing/research-tab";
import { ReportsTab } from "@/components/marketing/reports-tab";
import { RecommendationsTab } from "@/components/marketing/recommendations-tab";
import { SELECT_CLASS, failureOf } from "@/components/marketing/format";

type View = "calendar" | "campaigns" | "research" | "reports" | "recommendations";

const VIEWS: Array<{ value: View; label: string }> = [
  { value: "calendar", label: "Calendar" },
  { value: "campaigns", label: "Campaigns" },
  { value: "research", label: "Research" },
  { value: "reports", label: "Reports" },
  { value: "recommendations", label: "Recommendations" },
];

export default function MarketingPage() {
  const [status, setStatus] = useState<MarketingStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [project, setProject] = useState("");
  const [campaigns, setCampaigns] = useState<MarketingCampaignView[]>([]);
  const [inOtherProjects, setInOtherProjects] = useState(0);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [view, setView] = useState<View>("calendar");

  const projectId = project || null;

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    const [marketing, projectList] = await Promise.all([getMarketingStatus(), listProjects()]);
    if (marketing.success && marketing.data) setStatus(marketing.data);
    else setStatusError(failureOf(marketing, "The marketing workspace could not be loaded."));
    if (projectList.success && projectList.data) setProjects(projectList.data.projects);
  }, []);

  const loadCampaigns = useCallback(async () => {
    setCampaignsLoading(true);
    const response = await listMarketingCampaigns({ projectId });
    if (response.success && response.data) {
      setCampaigns(response.data.campaigns);
      setInOtherProjects(response.data.inOtherProjects ?? 0);
    } else {
      setCampaigns([]);
      setInOtherProjects(0);
    }
    setCampaignsLoading(false);
  }, [projectId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  return (
    <PageContainer>
      <PageHeader
        title="Marketing"
        description="Plan content, keep a calendar, research pages and report on performance. Saving is not publishing: a post goes out only when you approve its exact text."
        actions={
          projects.length > 0 ? (
            <label className="flex items-center gap-2 text-xs text-sys-dim">
              <span>Project</span>
              <select aria-label="Project" value={project} onChange={(event) => setProject(event.target.value)} className={SELECT_CLASS}>
                <option value="">All projects</option>
                {projects.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          ) : undefined
        }
      />

      {statusError && <ErrorState message={statusError} onRetry={() => void loadStatus()} />}
      {!status && !statusError && <LoadingState lines={4} />}

      {status && (
        <div className="space-y-6">
          {!status.caller.canEdit && (
            <p data-testid="marketing-read-only" role="status" className="rounded border border-sys-line bg-sys-edge/30 px-3 py-2 text-sm text-sys-dim">
              Your role can view the marketing workspace. It cannot change it or publish.
            </p>
          )}

          <Tabs options={VIEWS} value={view} onChange={setView} label="Marketing views" />

          {view === "calendar" && <CalendarTab status={status} projectId={projectId} campaigns={campaigns} />}
          {view === "campaigns" && (
            <CampaignsTab
              status={status}
              projectId={projectId}
              campaigns={campaigns}
              inOtherProjects={inOtherProjects}
              loading={campaignsLoading}
              onChanged={loadCampaigns}
            />
          )}
          {view === "research" && <ResearchTab status={status} projectId={projectId} campaigns={campaigns} />}
          {view === "reports" && <ReportsTab status={status} projectId={projectId} campaigns={campaigns} />}
          {view === "recommendations" && <RecommendationsTab projectId={projectId} campaigns={campaigns} />}
        </div>
      )}
    </PageContainer>
  );
}
