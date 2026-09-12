"use client";

// ---------------------------------------------------------------------------
// Drive — recent files, search, and one file's metadata.
//
// METADATA ONLY. Nothing here downloads a file. The link opens in the viewer's
// own browser against their own Google session, so access is re-checked by
// Google at the moment of opening rather than inherited from this server —
// which is why the link is safe to show and a proxied download would not be.
//
// `rel="noreferrer"` on that link is deliberate: without it the Drive page
// receives this dashboard's URL as a referrer.
//
// No rename, no move, no delete, no share. Phase 12 has no write path.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FileText, Search, Users } from "lucide-react";
import {
  getDriveFileMetadata,
  listRecentDriveFiles,
  searchDriveFiles,
  type DriveFile,
  type DriveListResult,
  type GoogleTaskStatus,
} from "@/lib/api";
import { Panel } from "@/components/dashboard/panel";
import { Badge } from "@/components/ui/primitives";
import {
  PanelEmpty,
  PanelLoading,
  PanelProblem,
  fileSize,
  relativeTime,
} from "./workspace-states";

type Problem = { status: Exclude<GoogleTaskStatus, "ok">; message: string; requiredAction?: string };

export function DrivePanel({ onConnect }: { onConnect: () => void }) {
  const [list, setList] = useState<DriveListResult | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"recent" | "search">("recent");
  const [detail, setDetail] = useState<DriveFile | null>(null);

  const load = useCallback(async (searchQuery?: string) => {
    setLoading(true);
    setProblem(null);
    setDetail(null);

    const result = searchQuery
      ? await searchDriveFiles(searchQuery, 15)
      : await listRecentDriveFiles(15);

    setLoading(false);

    if (result.success && result.data) {
      setList(result.data);
      return;
    }
    setList(null);
    setProblem({
      status: result.status === "ok" ? "provider_error" : result.status,
      message: result.message ?? "Drive could not be read.",
      ...(result.requiredAction ? { requiredAction: result.requiredAction } : {}),
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (file: DriveFile) => {
    const result = await getDriveFileMetadata(file.id);
    if (result.success && result.data) {
      setDetail(result.data);
      return;
    }
    setProblem({
      status: result.status === "ok" ? "provider_error" : result.status,
      message: result.message ?? "Those file details could not be read.",
      ...(result.requiredAction ? { requiredAction: result.requiredAction } : {}),
    });
  }, []);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    setMode(trimmed ? "search" : "recent");
    void load(trimmed || undefined);
  };

  return (
    <Panel
      data-testid="drive-panel"
      // Fills its grid cell and lets the body shrink, so the list inside is
      // what scrolls rather than the page.
      className="min-h-0 flex-1"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      title="Google Drive"
      description={mode === "search" ? "Search results" : "Recently modified"}
      action={
        list && list.files.length > 0 ? (
          <span className="font-mono text-xs text-sys-dim">{list.files.length}</span>
        ) : null
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <form onSubmit={submitSearch} className="flex items-center gap-2">
          <label htmlFor="drive-search" className="sr-only">
            Search Drive
          </label>
          <div className="relative min-w-0 flex-1">
            <Search
              size={12}
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sys-dim"
            />
            <input
              id="drive-search"
              data-testid="drive-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // Kind words work as filters server-side, which is what makes
              // "presentation" find presentations rather than the word.
              placeholder="presentation, budget spreadsheet…"
              className="sys-focus w-full rounded-md border border-sys-control bg-black/40 py-1.5 pl-7 pr-2 text-sm text-white placeholder:text-sys-dim"
            />
          </div>
          {mode === "search" && (
            <button
              type="button"
              data-testid="drive-clear-search"
              onClick={() => {
                setQuery("");
                setMode("recent");
                void load();
              }}
              className="sys-focus rounded border border-sys-line px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-dim hover:text-white"
            >
              Recent
            </button>
          )}
        </form>

        {loading && <PanelLoading label="Reading Drive" />}

        {!loading && problem && (
          <PanelProblem
            {...problem}
            onConnect={onConnect}
            onRetry={() => void load(mode === "search" ? query : undefined)}
          />
        )}

        {!loading && !problem && list && list.files.length === 0 && (
          <PanelEmpty
            message={mode === "search" ? "No files matched that search." : "No recent files."}
          />
        )}

        {!loading && !problem && list && list.files.length > 0 && (
          <ul data-testid="drive-list" className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {list.files.map((file) => (
              <li
                key={file.id}
                className="rounded border border-sys-line/60 bg-white/[0.02] p-2"
                data-testid={`drive-file-${file.id}`}
              >
                <div className="flex items-baseline gap-2">
                  <FileText size={11} aria-hidden className="shrink-0 text-sys-dim" />
                  <button
                    type="button"
                    onClick={() => void openDetail(file)}
                    className="sys-focus min-w-0 flex-1 truncate text-left text-xs font-medium text-white hover:text-sys-cyan-soft"
                  >
                    {file.name}
                  </button>
                  {file.webViewLink && (
                    <a
                      href={file.webViewLink}
                      target="_blank"
                      // noreferrer so the Drive page is not handed this
                      // dashboard's URL.
                      rel="noreferrer noopener"
                      aria-label={`Open ${file.name} in Google Drive`}
                      className="sys-focus shrink-0 rounded p-0.5 text-sys-dim hover:text-sys-cyan"
                    >
                      <ExternalLink size={11} aria-hidden />
                    </a>
                  )}
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-sys-dim">
                  <Badge tone="neutral">{file.kind}</Badge>
                  <span>{relativeTime(file.modifiedAt)}</span>
                  <span aria-hidden>·</span>
                  <span>{fileSize(file.sizeBytes)}</span>
                  {file.shared && (
                    <>
                      <Users size={9} aria-hidden />
                      <span>Shared</span>
                    </>
                  )}
                </div>

                {/* Detail expands in place: a dialog here would be a second
                    scroll container over a panel that already scrolls. */}
                {detail?.id === file.id && (
                  <dl
                    data-testid={`drive-detail-${file.id}`}
                    className="mt-2 space-y-0.5 border-t border-sys-line/70 pt-2 text-xs"
                  >
                    <Row label="Type" value={detail.mimeType} />
                    <Row label="Owners" value={detail.owners.join(", ") || "—"} />
                    <Row
                      label="Created"
                      value={detail.createdAt ? relativeTime(detail.createdAt) : "—"}
                    />
                    <Row label="Modified" value={relativeTime(detail.modifiedAt)} />
                    <Row label="Size" value={fileSize(detail.sizeBytes)} />
                  </dl>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-sys-dim">{label}</dt>
      <dd className="ml-auto min-w-0 truncate text-right font-mono text-sys-text/85">{value}</dd>
    </div>
  );
}
