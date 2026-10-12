"use client";

// ---------------------------------------------------------------------------
// Phase 15 — marketing recommendations.
//
// ADVICE, AND LABELLED AS ADVICE. Each recommendation is a rule applied to
// what is in the workspace — the calendar, the latest saved report, saved page
// audits — and it lists the facts it rests on. No model wrote it.
//
// NONE OF THEM HAS BEEN DONE. Every card says so, and there is no "apply"
// button here: acting on one means doing it — editing an item, publishing with
// approval, generating a report — on the tab where that is done.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import type { MarketingCampaignView, MarketingRecommendationSet } from "@jarvis/core/marketing";
import { getMarketingRecommendations } from "@/lib/api";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, type Tone } from "@/components/ui/primitives";
import { SELECT_CLASS, failureOf, formatInstant } from "./format";

type Recommendation = MarketingRecommendationSet["recommendations"][number];

const PRIORITY_TONE: Record<Recommendation["priority"], Tone> = { HIGH: "warn", MEDIUM: "info", LOW: "neutral" };
const PRIORITY_LABEL: Record<Recommendation["priority"], string> = { HIGH: "High priority", MEDIUM: "Medium priority", LOW: "Low priority" };

const AREA_LABEL: Record<Recommendation["area"], string> = {
  CALENDAR: "Calendar",
  CONTENT: "Content",
  CAMPAIGN: "Campaign",
  PUBLISHING: "Publishing",
  SEO: "SEO",
  PERFORMANCE: "Performance",
  REPORTING: "Reporting",
};

export function RecommendationsTab({ projectId, campaigns }: { projectId: string | null; campaigns: MarketingCampaignView[] }) {
  const [campaign, setCampaign] = useState("");
  const [set, setSet] = useState<MarketingRecommendationSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const response = await getMarketingRecommendations({ projectId, ...(campaign ? { campaign } : {}) });
    if (response.success && response.data) setSet(response.data);
    else setError(failureOf(response, "Recommendations could not be loaded."));
    setLoading(false);
  }, [projectId, campaign]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel
      title="Recommendations"
      description="Suggestions worked out from what is in this workspace. They are advice: none of them has been carried out."
      action={
        <Button size="sm" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      }
    >
      {campaigns.length > 0 && (
        <label className="mb-4 flex items-center gap-2 text-sm text-sys-dim">
          <span>Campaign</span>
          <select aria-label="Recommendations for campaign" value={campaign} onChange={(event) => setCampaign(event.target.value)} className={SELECT_CLASS}>
            <option value="">Everything shown here</option>
            {campaigns.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {loading && !set && <LoadingState lines={4} />}
      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {set && (
        <div className="space-y-4">
          <p data-testid="recommendations-basis" className="font-mono text-xs text-sys-dim">
            Worked out {formatInstant(set.generatedAt)} from {set.basis.contentItems} content item{set.basis.contentItems === 1 ? "" : "s"},{" "}
            {set.basis.hasReport ? "the latest saved report" : "no saved report"} and {set.basis.seoAudits} saved page audit{set.basis.seoAudits === 1 ? "" : "s"}.
          </p>
          <p className="text-sm text-sys-dim">{set.note}</p>

          {set.recommendations.length === 0 && (
            <EmptyState
              title="Nothing to recommend"
              message="There is not enough in this workspace to base advice on, or nothing in it needs attention. Add content, generate a report or audit a page."
            />
          )}

          <ul className="space-y-3">
            {set.recommendations.map((recommendation) => (
              <li key={recommendation.id} data-testid="recommendation" className="rounded border border-sys-line bg-sys-edge/20 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="mr-auto text-sm font-medium text-sys-text">{recommendation.title}</p>
                  <Badge>{AREA_LABEL[recommendation.area]}</Badge>
                  <Badge tone={PRIORITY_TONE[recommendation.priority]}>{PRIORITY_LABEL[recommendation.priority]}</Badge>
                </div>
                <p className="mt-2 text-sm text-sys-text/85">{recommendation.rationale}</p>
                <div className="mt-3">
                  <p className="font-mono text-xs uppercase tracking-hud text-sys-dim">Based on</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-sys-dim">
                    {recommendation.evidence.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                </div>
                <p className="mt-3 text-sm text-sys-text">
                  <span className="font-mono text-xs uppercase tracking-hud text-sys-dim">Suggested </span>
                  {recommendation.suggestedAction}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {/* The server sends `executed: false` on every one. If that ever changed, this would not say otherwise. */}
                  {recommendation.executed === false && <Badge tone="neutral">Advice · not carried out</Badge>}
                  {recommendation.needsApproval && <Badge tone="warn">Would need your approval</Badge>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
