"use client";

// ---------------------------------------------------------------------------
// Phase 15 — research: what a public web page says about itself.
//
// EVERYTHING HERE WAS READ FROM A PAGE, AND SAYS WHICH ONE AND WHEN. An audit
// is the page's own title, headings, tags and counts, checked against fixed
// rules. A competitor comparison is two pages' facts side by side, and what
// changed since the last time the same page was read.
//
// WHAT IT IS NOT is stated on screen with every result, in the server's own
// list: no rankings, no search volume, no traffic, no backlinks, no ad spend.
// None of those can be read from a page, and none is estimated.
//
// A page's text is somebody else's writing. It is shown as text, and the
// server marks it as untrusted before any model sees it.
//
// Where the operator has not switched page reads on, this tab says so and
// offers no form: a button that could only fail is not drawn.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import type { MarketingCampaignView, MarketingResearchSummary, MarketingResearchView, PageDifference, PageFacts } from "@jarvis/core/marketing";
import { getMarketingResearch, listMarketingResearch, runCompetitorAnalysis, runSeoAudit, type MarketingStatus } from "@/lib/api";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, DataTable } from "@/components/ui/primitives";
import { INPUT_CLASS, LABEL_CLASS, SELECT_CLASS, SEVERITY_LABEL, SEVERITY_TONE, failureOf, formatInstant } from "./format";

const KIND_LABEL: Record<MarketingResearchSummary["kind"], string> = { SEO_AUDIT: "SEO audit", COMPETITOR_SNAPSHOT: "Competitor page" };

export function ResearchTab({
  status,
  projectId,
  campaigns,
}: {
  status: MarketingStatus;
  projectId: string | null;
  campaigns: MarketingCampaignView[];
}) {
  const canRun = status.research.available && status.caller.canResearch;

  const [list, setList] = useState<MarketingResearchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ research: MarketingResearchView; notice: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const [auditUrl, setAuditUrl] = useState("");
  const [competitorUrl, setCompetitorUrl] = useState("");
  const [ownUrl, setOwnUrl] = useState("");
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const response = await listMarketingResearch({ projectId });
    if (response.success && response.data) setList(response.data.research);
    else setError(failureOf(response, "Saved research could not be loaded."));
  }, [projectId]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  async function open(id: string) {
    setOpening(id);
    setActionError(null);
    const response = await getMarketingResearch(id);
    setOpening(null);
    if (response.success && response.data) setDetail(response.data);
    else setActionError(failureOf(response, "That result could not be opened."));
  }

  /** Read a page. On failure nothing is saved, and the reason is the server's. */
  async function run(read: () => ReturnType<typeof runSeoAudit>, fallback: string): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    const response = await read();
    setBusy(false);
    if (!response.success || !response.data) {
      setActionError(failureOf(response, fallback));
      return false;
    }
    setDetail(response.data);
    await load();
    return true;
  }

  async function audit() {
    if (await run(() => runSeoAudit({ url: auditUrl.trim(), ...(campaign ? { campaign } : {}) }, projectId), "The page could not be read.")) setAuditUrl("");
  }

  async function compare() {
    const done = await run(
      () => runCompetitorAnalysis({ competitorUrl: competitorUrl.trim(), ...(ownUrl.trim() ? { ownUrl: ownUrl.trim() } : {}), ...(campaign ? { campaign } : {}) }, projectId),
      "The page could not be read."
    );
    if (done) setCompetitorUrl("");
  }

  return (
    <div className="space-y-6">
      {actionError && <ErrorState title="That did not go through" message={actionError} />}

      {!status.research.available && (
        <Panel title="Page research is switched off" tone="warning" data-testid="research-unavailable">
          <p className="text-sm text-sys-text">{status.research.reason ?? "Reading web pages is not available on this server."}</p>
          <p className="mt-2 text-sm text-sys-dim">Results saved earlier are still shown below.</p>
        </Panel>
      )}

      {canRun && (
        <Panel title="Read a page" description="JARVIS fetches the page itself and reports what is on it. Only public web pages can be read.">
          {campaigns.length > 0 && (
            <label className="mb-4 flex items-center gap-2 text-sm text-sys-dim">
              <span>File under</span>
              <select aria-label="File research under campaign" value={campaign} onChange={(event) => setCampaign(event.target.value)} className={SELECT_CLASS}>
                <option value="">No campaign</option>
                {campaigns.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <form
              className="space-y-3"
              aria-label="SEO audit"
              onSubmit={(event) => {
                event.preventDefault();
                void audit();
              }}
            >
              <h3 className="font-mono text-xs uppercase tracking-hud text-sys-text/80">SEO audit of one page</h3>
              <label className={LABEL_CLASS}>
                <span>Page address</span>
                <input value={auditUrl} onChange={(event) => setAuditUrl(event.target.value)} placeholder="https://your-site.example/" className={INPUT_CLASS} />
              </label>
              <Button type="submit" variant="primary" disabled={busy || auditUrl.trim().length === 0}>
                Audit this page
              </Button>
            </form>

            <form
              className="space-y-3"
              aria-label="Competitor page"
              onSubmit={(event) => {
                event.preventDefault();
                void compare();
              }}
            >
              <h3 className="font-mono text-xs uppercase tracking-hud text-sys-text/80">A competitor's page</h3>
              <label className={LABEL_CLASS}>
                <span>Their page</span>
                <input value={competitorUrl} onChange={(event) => setCompetitorUrl(event.target.value)} placeholder="https://competitor.example/" className={INPUT_CLASS} />
              </label>
              <label className={LABEL_CLASS}>
                <span>Your page, to compare with (optional)</span>
                <input value={ownUrl} onChange={(event) => setOwnUrl(event.target.value)} placeholder="https://your-site.example/" className={INPUT_CLASS} />
              </label>
              <Button type="submit" variant="primary" disabled={busy || competitorUrl.trim().length === 0}>
                Read their page
              </Button>
            </form>
          </div>
          {busy && <LoadingState label="Reading the page…" lines={2} className="mt-4" />}
        </Panel>
      )}

      {detail && <ResearchDetail research={detail.research} notice={detail.notice} onClose={() => setDetail(null)} />}

      <Panel title="Saved research" description="Each result is a reading of one page at one moment.">
        {list === null && !error && <LoadingState lines={3} />}
        {error && <ErrorState message={error} onRetry={() => void load()} />}
        {list !== null && list.length === 0 && (
          <EmptyState title="No research saved" message={canRun ? "Audit a page or read a competitor's page above." : "Nothing has been researched here."} />
        )}
        <ul className="space-y-2">
          {(list ?? []).map((entry) => (
            <li key={entry.id} data-testid="research-row" className="flex flex-wrap items-center gap-2 rounded border border-sys-line bg-sys-edge/20 px-4 py-3">
              <div className="mr-auto min-w-0">
                <p className="truncate text-sm text-sys-text">
                  <span className="font-mono text-xs text-sys-dim">{entry.host}</span> — {entry.headline}
                </p>
                <p className="font-mono text-xs text-sys-dim">Read {formatInstant(entry.fetchedAt)}</p>
              </div>
              <Badge tone="info">{KIND_LABEL[entry.kind]}</Badge>
              <Button size="sm" onClick={() => void open(entry.id)} disabled={opening !== null}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function ResearchDetail({ research, notice, onClose }: { research: MarketingResearchView; notice: string; onClose: () => void }) {
  const { provenance } = research;
  return (
    <Panel
      title={`${KIND_LABEL[research.kind]} — ${research.host}`}
      description={research.headline}
      action={
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      }
      data-testid="research-detail"
    >
      <div className="space-y-5">
        <div className="space-y-1">
          <p className="break-all font-mono text-xs text-sys-dim">
            Read {formatInstant(provenance.fetchedAt)} from {provenance.finalUrl} · HTTP {provenance.httpStatus}
            {provenance.redirects > 0 ? ` · ${provenance.redirects} redirect${provenance.redirects === 1 ? "" : "s"}` : ""}
            {provenance.truncated ? " · the page was longer than was read" : ""}
          </p>
          <p className="text-xs text-sys-dim">{notice}</p>
        </div>

        {research.audit && (
          <>
            <Facts facts={research.audit.facts} />
            <section aria-label="Checks" className="space-y-2">
              <h3 className="font-mono text-xs uppercase tracking-hud text-sys-text/80">What was checked</h3>
              <ul className="space-y-2">
                {research.audit.checks.map((check) => (
                  <li key={check.id} data-testid="seo-check" data-severity={check.severity} className="rounded border border-sys-line bg-sys-edge/20 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mr-auto text-sm text-sys-text">{check.label}</span>
                      <Badge tone={SEVERITY_TONE[check.severity]}>{SEVERITY_LABEL[check.severity]}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-sys-text/85">
                      <span className="font-mono text-xs uppercase tracking-hud text-sys-dim">Found </span>
                      {check.finding}
                    </p>
                    {check.recommendation && (
                      <p className="mt-1 text-sm text-sys-dim">
                        <span className="font-mono text-xs uppercase tracking-hud">Suggestion </span>
                        {check.recommendation}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <NotMeasured items={research.audit.notMeasured} />
          </>
        )}

        {research.competitor && (
          <>
            {research.competitor.ownPageError && (
              <p role="alert" className="rounded border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-sm text-sys-text">
                Your own page could not be read, so there is no comparison with it: {research.competitor.ownPageError}
              </p>
            )}
            <Facts facts={research.competitor.competitor} heading="Their page" />
            {research.competitor.own && (
              <Differences
                title="Compared with your page"
                rows={research.competitor.comparedWithOwn}
                left="Your page"
                right="Their page"
                none="No differences in the fields compared."
              />
            )}
            {research.competitor.previousFetchedAt ? (
              <Differences
                title={`Changed since ${formatInstant(research.competitor.previousFetchedAt)}`}
                rows={research.competitor.changesSinceLast}
                left="Then"
                right="Now"
                none="Nothing changed in the fields compared."
              />
            ) : (
              <p className="text-sm text-sys-dim">This is the first time this page has been read, so there is nothing earlier to compare it with.</p>
            )}
            <NotMeasured items={research.competitor.notMeasured} />
          </>
        )}
      </div>
    </Panel>
  );
}

function Facts({ facts, heading = "What the page says" }: { facts: PageFacts; heading?: string }) {
  const rows: Array<[string, string]> = [
    ["Title", facts.title ?? "(none)"],
    ["Meta description", facts.metaDescription ?? "(none)"],
    ["Main heading (H1)", facts.h1.length > 0 ? facts.h1.join(" · ") : "(none)"],
    ["Subheadings (H2)", facts.h2.length > 0 ? facts.h2.slice(0, 8).join(" · ") : "(none)"],
    ["Canonical address", facts.canonical ?? "(none)"],
    ["Language", facts.lang ?? "(not stated)"],
    ["Words of visible text", String(facts.wordCount)],
    ["Images", `${facts.images.total} (${facts.images.missingAlt} without a description)`],
    ["Links", `${facts.links.internal} to the same site, ${facts.links.external} to others`],
    ["Most frequent words", facts.topTerms.length > 0 ? facts.topTerms.map((term) => `${term.term} (${term.count})`).join(", ") : "(none)"],
  ];
  return (
    <section aria-label={heading} className="space-y-2">
      <h3 className="font-mono text-xs uppercase tracking-hud text-sys-text/80">{heading}</h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[14rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-xs text-sys-dim">{label}</dt>
            <dd className="break-words text-sm text-sys-text">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Differences({ title, rows, left, right, none }: { title: string; rows: PageDifference[]; left: string; right: string; none: string }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="font-mono text-xs uppercase tracking-hud text-sys-text/80">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-sys-dim">{none}</p>
      ) : (
        <DataTable
          caption={title}
          rows={rows}
          rowKey={(row) => row.field}
          columns={[
            { key: "field", header: "What", render: (row) => row.field },
            { key: "left", header: left, render: (row) => <span className="break-words">{row.left}</span> },
            { key: "right", header: right, render: (row) => <span className="break-words">{row.right}</span> },
          ]}
        />
      )}
    </section>
  );
}

function NotMeasured({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Not measured" data-testid="not-measured" className="rounded border border-sys-line bg-sys-edge/20 p-3">
      <h3 className="font-mono text-xs uppercase tracking-hud text-sys-dim">What this does not tell you</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-sys-dim">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
