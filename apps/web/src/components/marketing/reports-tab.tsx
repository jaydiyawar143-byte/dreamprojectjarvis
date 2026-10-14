"use client";

// ---------------------------------------------------------------------------
// Phase 15 — performance and client reports.
//
// A REPORT IS A SAVED DOCUMENT, AND THIS TAB DRAWS IT. Every figure on screen
// is a field of the document the server computed from rows it read; this
// component adds, divides and rounds nothing. Numbers are worded by the same
// `formatReportValue` the exported file uses, so the screen and the file a
// client receives cannot disagree.
//
// WHERE THE DATA CAME FROM IS PART OF THE REPORT, not a footnote. Each source
// is listed with what happened to it — included, empty, not connected, access
// not granted, could not be read — and a source that was not read contributes
// no figure. A metric the provider never sent is shown as not available, never
// as zero.
//
// "Generate" reads; it changes nothing outside JARVIS. "Download" hands over a
// file. Nothing here sends a report to anyone: there is no delivery to claim.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import {
  REPORT_SOURCE_STATUS_LABELS,
  channelLabel,
  formatReportChange,
  formatReportValue,
  reportFileName,
  reportPublicationLabel,
  type MarketingCampaignView,
  type MarketingReportDocument,
  type MarketingReportSummary,
  type MarketingReportView,
} from "@jarvis/core/marketing";
import { downloadMarketingReport, generateMarketingReport, getMarketingReport, listMarketingReports, type MarketingStatus } from "@/lib/api";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, DataTable } from "@/components/ui/primitives";
import { INPUT_CLASS, LABEL_CLASS, SELECT_CLASS, SOURCE_TONE, failureOf, formatInstant } from "./format";

const KIND_LABEL: Record<MarketingReportSummary["kind"], string> = { PERFORMANCE: "Performance report", CLIENT: "Client report" };

/** Hand a blob to the browser as a download. The file is never opened in this page. */
function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function ReportsTab({
  status,
  projectId,
  campaigns,
}: {
  status: MarketingStatus;
  projectId: string | null;
  campaigns: MarketingCampaignView[];
}) {
  const [list, setList] = useState<MarketingReportSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<MarketingReportView | null>(null);

  const [kind, setKind] = useState<"PERFORMANCE" | "CLIENT">("PERFORMANCE");
  const [campaign, setCampaign] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [compare, setCompare] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const response = await listMarketingReports({ projectId });
    if (response.success && response.data) setList(response.data.reports);
    else setError(failureOf(response, "Saved reports could not be loaded."));
  }, [projectId]);

  useEffect(() => {
    setReport(null);
    void load();
  }, [load]);

  async function generate() {
    setBusy(true);
    setActionError(null);
    const response = await generateMarketingReport(
      { kind, compare, ...(campaign ? { campaign } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) },
      projectId
    );
    setBusy(false);
    if (!response.success || !response.data) {
      setActionError(failureOf(response, "The report could not be generated."));
      return;
    }
    setReport(response.data.report);
    await load();
  }

  async function open(id: string) {
    setBusy(true);
    setActionError(null);
    const response = await getMarketingReport(id);
    setBusy(false);
    if (response.success && response.data) setReport(response.data.report);
    else setActionError(failureOf(response, "That report could not be opened."));
  }

  /**
   * The file's name is worked out here, from the document on screen, by the
   * function the server names it with. The server sends the same name in a
   * header, but the web app and the API are different origins and a browser
   * does not show that header to a page across origins.
   */
  async function download(target: MarketingReportView, format: "html" | "md") {
    setBusy(true);
    setActionError(null);
    const file = await downloadMarketingReport(target.id, format);
    setBusy(false);
    if (file.ok) saveFile(file.blob, reportFileName(target.document, format));
    else setActionError(file.message);
  }

  return (
    <div className="space-y-6">
      {actionError && <ErrorState title="That did not go through" message={actionError} />}

      <Panel
        title="Generate a report"
        description={
          status.adAccount.available
            ? "Reads the connected ad account and this workspace's content for a period, and saves what it found. It changes nothing outside JARVIS."
            : "No ad account is connected to this server, so a report will cover this workspace's content only — and will say so."
        }
      >
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          aria-label="Generate a report"
          onSubmit={(event) => {
            event.preventDefault();
            void generate();
          }}
        >
          <label className={LABEL_CLASS}>
            <span>Kind</span>
            <select aria-label="Report kind" value={kind} onChange={(event) => setKind(event.target.value as "PERFORMANCE" | "CLIENT")} className={`${SELECT_CLASS} w-full`}>
              <option value="PERFORMANCE">{KIND_LABEL.PERFORMANCE}</option>
              <option value="CLIENT">{KIND_LABEL.CLIENT}</option>
            </select>
          </label>
          <label className={LABEL_CLASS}>
            <span>Campaign workspace</span>
            <select aria-label="Report campaign" value={campaign} onChange={(event) => setCampaign(event.target.value)} className={`${SELECT_CLASS} w-full`}>
              <option value="">Everything shown here</option>
              {campaigns.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS}>
            <span>From (optional)</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className={INPUT_CLASS} />
          </label>
          <label className={LABEL_CLASS}>
            <span>To (optional)</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className={INPUT_CLASS} />
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-sys-dim sm:col-span-2">
            <input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} />
            Compare with the period before
          </label>
          <p className="text-xs text-sys-dim sm:col-span-2">With no dates, the last 30 complete days. At most 90 days.</p>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" variant="primary" disabled={busy}>
              Generate report
            </Button>
          </div>
        </form>
        {busy && !report && <LoadingState label="Reading the data…" lines={2} className="mt-4" />}
      </Panel>

      {report && (
        <ReportDocument
          report={report}
          busy={busy}
          onDownload={(format) => void download(report, format)}
          onClose={() => setReport(null)}
        />
      )}

      <Panel title="Saved reports" description="Each is a record of what was read when it was generated. Generating again reads again.">
        {list === null && !error && <LoadingState lines={3} />}
        {error && <ErrorState message={error} onRetry={() => void load()} />}
        {list !== null && list.length === 0 && <EmptyState title="No reports yet" message="Generate one above." />}
        <ul className="space-y-2">
          {(list ?? []).map((entry) => (
            <li key={entry.id} data-testid="report-row" className="flex flex-wrap items-center gap-2 rounded border border-sys-line bg-sys-edge/20 px-4 py-3">
              <div className="mr-auto min-w-0">
                <p className="truncate text-sm text-sys-text">{entry.title}</p>
                <p className="font-mono text-xs text-sys-dim">
                  {entry.periodStart} to {entry.periodEnd} · generated {formatInstant(entry.generatedAt)}
                </p>
              </div>
              <Badge tone={entry.sourcesIncluded > 0 ? "ok" : "warn"}>
                {entry.sourcesIncluded} of {entry.sourcesTotal} sources included
              </Badge>
              <Button size="sm" onClick={() => void open(entry.id)} disabled={busy}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function ReportDocument({
  report,
  busy,
  onDownload,
  onClose,
}: {
  report: MarketingReportView;
  busy: boolean;
  onDownload: (format: "html" | "md") => void;
  onClose: () => void;
}) {
  const doc: MarketingReportDocument = report.document;
  const compared = doc.previousTotals !== null;

  return (
    <Panel
      title={doc.title}
      description={`${KIND_LABEL[doc.kind]} · ${doc.period.start} to ${doc.period.end} (${doc.period.days} days) · generated ${formatInstant(doc.generatedAt)}`}
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onDownload("html")} disabled={busy}>
            Download HTML
          </Button>
          <Button size="sm" onClick={() => onDownload("md")} disabled={busy}>
            Download Markdown
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      }
      data-testid="report-document"
    >
      <div className="space-y-6">
        {/* Said first, when it is true: this report has no advertising figures in it. */}
        {report.sourcesIncluded === 0 && (
          <p role="status" data-testid="report-no-sources" className="rounded border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-sm text-sys-text">
            No advertising data could be included in this report. The data sources below say why.
          </p>
        )}

        <section aria-label="Where the data came from" className="space-y-2" data-testid="report-sources">
          <h3 className="font-mono text-xs uppercase tracking-hud text-sys-text/80">Where the data came from</h3>
          <ul className="space-y-2">
            {doc.dataSources.map((source) => (
              <li key={source.provider} data-testid="report-source" data-status={source.status} className="rounded border border-sys-line bg-sys-edge/20 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-auto text-sm text-sys-text">
                    {source.label}
                    {source.account && <span className="ml-2 font-mono text-xs text-sys-dim">{source.account}</span>}
                  </span>
                  <Badge tone={SOURCE_TONE[source.status]}>{REPORT_SOURCE_STATUS_LABELS[source.status]}</Badge>
                </div>
                <p className="mt-1 text-sm text-sys-dim">{source.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Summary" className="space-y-2">
          <h3 className="font-mono text-xs uppercase tracking-hud text-sys-text/80">Summary</h3>
          {doc.totals ? (
            <DataTable
              caption="Totals for the period"
              rows={doc.changes}
              rowKey={(row) => row.metric}
              columns={[
                { key: "metric", header: "Metric", render: (row) => row.label },
                { key: "current", header: "This period", numeric: true, render: (row) => formatReportValue(row.current, row.unit, doc.currency) },
                ...(compared
                  ? [
                      {
                        key: "previous",
                        header: "Previous period",
                        numeric: true,
                        render: (row: (typeof doc.changes)[number]) => formatReportValue(row.previous, row.unit, doc.currency),
                      },
                      { key: "change", header: "Change", numeric: true, render: (row: (typeof doc.changes)[number]) => formatReportChange(row) },
                    ]
                  : []),
              ]}
            />
          ) : (
            <p data-testid="report-no-data" className="text-sm text-sys-dim">
              No advertising data is included in this report.
            </p>
          )}
        </section>

        {doc.campaigns.length > 0 && (
          <section aria-label="Campaigns" className="space-y-2">
            <h3 className="font-mono text-xs uppercase tracking-hud text-sys-text/80">Campaigns</h3>
            <DataTable
              caption="Performance by campaign"
              rows={doc.campaigns}
              rowKey={(row) => row.id}
              columns={[
                { key: "name", header: "Campaign", render: (row) => row.name ?? row.id },
                { key: "spend", header: "Spend", numeric: true, render: (row) => formatReportValue(row.kpis.spend, "currency", doc.currency) },
                { key: "impressions", header: "Impressions", numeric: true, render: (row) => formatReportValue(row.kpis.impressions, "count", doc.currency) },
                { key: "clicks", header: "Clicks", numeric: true, render: (row) => formatReportValue(row.kpis.clicks, "count", doc.currency) },
                { key: "ctr", header: "CTR", numeric: true, render: (row) => formatReportValue(row.kpis.ctr, "percent", doc.currency) },
                { key: "cpc", header: "Cost per click", numeric: true, render: (row) => formatReportValue(row.kpis.cpc, "currency", doc.currency) },
              ]}
            />
          </section>
        )}

        <section aria-label="Content" className="space-y-3">
          <h3 className="font-mono text-xs uppercase tracking-hud text-sys-text/80">Content</h3>
          {doc.content.published.length === 0 && doc.content.planned.length === 0 && <p className="text-sm text-sys-dim">No content items fall in this period.</p>}
          {doc.content.published.length > 0 && (
            <DataTable
              caption="Published in this period"
              rows={doc.content.published}
              rowKey={(row, index) => `${row.title}-${index}`}
              columns={[
                { key: "date", header: "Date", render: (row) => row.date ?? "—" },
                { key: "channel", header: "Channel", render: (row) => channelLabel(row.channel) },
                { key: "title", header: "Published", render: (row) => row.title },
                { key: "how", header: "How it is known", render: (row) => reportPublicationLabel(row) },
              ]}
            />
          )}
          {doc.content.planned.length > 0 && (
            <DataTable
              caption="Planned, not published"
              rows={doc.content.planned}
              rowKey={(row, index) => `${row.title}-${index}`}
              columns={[
                { key: "date", header: "Date", render: (row) => row.date ?? "no date" },
                { key: "channel", header: "Channel", render: (row) => channelLabel(row.channel) },
                { key: "title", header: "Planned, not published", render: (row) => row.title },
                { key: "status", header: "Status", render: (row) => reportPublicationLabel(row) },
              ]}
            />
          )}
        </section>

        {doc.notes.length > 0 && (
          <section aria-label="Notes" className="space-y-2">
            <h3 className="font-mono text-xs uppercase tracking-hud text-sys-text/80">Notes</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm text-sys-dim">
              {doc.notes.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </section>
        )}

        <p className="border-t border-sys-line/70 pt-3 text-xs text-sys-dim">{doc.disclaimer}</p>
      </div>
    </Panel>
  );
}
