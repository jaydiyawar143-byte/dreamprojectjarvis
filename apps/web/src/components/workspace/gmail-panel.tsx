"use client";

// ---------------------------------------------------------------------------
// Gmail — unread list, search, and one message's detail.
//
// READ-ONLY, VISIBLY. There is no compose control, no reply, no archive and no
// delete. The panel cannot send mail because the backend has no tool that can.
//
// BODIES ARE PLAIN TEXT, ALWAYS. The server decodes and strips message bodies
// to text before they reach the browser, and this panel renders them inside a
// `whitespace-pre-wrap` block — never via `dangerouslySetInnerHTML`. Rendering
// provider HTML would hand an injection surface to anyone who can email the
// user, which is everyone.
//
// The list shows Google's own snippet, not the body: opening a message is an
// explicit act, and fetching fifty bodies to show fifty subjects would move a
// great deal of private content for no benefit.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Paperclip, Search } from "lucide-react";
import {
  getGmailMessage,
  listUnreadGmail,
  searchGmail,
  type GmailListResult,
  type GmailMessageDetail,
  type GmailMessageSummary,
  type GoogleTaskStatus,
} from "@/lib/api";
import { Panel } from "@/components/dashboard/panel";
import { Badge } from "@/components/ui/primitives";
import { PanelEmpty, PanelLoading, PanelProblem, relativeTime } from "./workspace-states";

type Problem = { status: Exclude<GoogleTaskStatus, "ok">; message: string; requiredAction?: string };

export function GmailPanel({ onConnect }: { onConnect: () => void }) {
  const [list, setList] = useState<GmailListResult | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"unread" | "search">("unread");

  const [openMessage, setOpenMessage] = useState<GmailMessageDetail | null>(null);
  const [openLoading, setOpenLoading] = useState(false);

  const load = useCallback(async (searchQuery?: string) => {
    setLoading(true);
    setProblem(null);
    setOpenMessage(null);

    const result = searchQuery
      ? await searchGmail(searchQuery, 15)
      : await listUnreadGmail(15);

    setLoading(false);

    if (result.success && result.data) {
      setList(result.data);
      return;
    }

    // The server's status decides the state. Never inferred from the message.
    setList(null);
    setProblem({
      status: result.status === "ok" ? "provider_error" : result.status,
      message: result.message ?? "Gmail could not be read.",
      ...(result.requiredAction ? { requiredAction: result.requiredAction } : {}),
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback(async (message: GmailMessageSummary) => {
    setOpenLoading(true);
    const result = await getGmailMessage(message.id);
    setOpenLoading(false);

    if (result.success && result.data) {
      setOpenMessage(result.data);
      return;
    }
    setProblem({
      status: result.status === "ok" ? "provider_error" : result.status,
      message: result.message ?? "That message could not be opened.",
      ...(result.requiredAction ? { requiredAction: result.requiredAction } : {}),
    });
  }, []);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    setMode(trimmed ? "search" : "unread");
    void load(trimmed || undefined);
  };

  return (
    <Panel
      data-testid="gmail-panel"
      // Fills its grid cell and lets the body shrink, so the list inside is
      // what scrolls rather than the page.
      className="min-h-0 flex-1"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      title="Gmail"
      description={mode === "search" ? "Search results" : "Unread inbox"}
      action={
        list && list.messages.length > 0 ? (
          <span className="font-mono text-xs text-sys-dim">{list.messages.length}</span>
        ) : null
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {/* Search. Gmail query syntax is accepted verbatim and sent as a
            parameter — it cannot alter the endpoint. */}
        <form onSubmit={submitSearch} className="flex items-center gap-2">
          <label htmlFor="gmail-search" className="sr-only">
            Search Gmail
          </label>
          <div className="relative min-w-0 flex-1">
            <Search
              size={12}
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sys-dim"
            />
            <input
              id="gmail-search"
              data-testid="gmail-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="from:priya has:attachment…"
              className="sys-focus w-full rounded-md border border-sys-control bg-black/40 py-1.5 pl-7 pr-2 text-sm text-white placeholder:text-sys-dim"
            />
          </div>
          {mode === "search" && (
            <button
              type="button"
              data-testid="gmail-clear-search"
              onClick={() => {
                setQuery("");
                setMode("unread");
                void load();
              }}
              className="sys-focus rounded border border-sys-line px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-dim hover:text-white"
            >
              Unread
            </button>
          )}
        </form>

        {loading && <PanelLoading label="Reading Gmail" />}

        {!loading && problem && (
          <PanelProblem
            {...problem}
            onConnect={onConnect}
            onRetry={() => void load(mode === "search" ? query : undefined)}
          />
        )}

        {!loading && !problem && list && list.messages.length === 0 && (
          <PanelEmpty
            message={
              mode === "search"
                ? "No messages matched that search."
                : "No unread messages. Your inbox is clear."
            }
          />
        )}

        {/* Detail view. Replaces the list rather than opening a dialog, so the
            panel never scrolls the page. */}
        {!loading && !problem && openMessage && (
          <div data-testid="gmail-detail" className="flex min-h-0 flex-1 flex-col gap-2">
            <button
              type="button"
              data-testid="gmail-back"
              onClick={() => setOpenMessage(null)}
              className="sys-focus flex w-fit items-center gap-1 rounded font-mono text-xs uppercase tracking-hud text-sys-dim hover:text-white"
            >
              <ArrowLeft size={11} aria-hidden />
              Back
            </button>

            <p className="text-sm font-medium text-white">{openMessage.subject}</p>
            <p className="truncate text-xs text-sys-cyan-soft">{openMessage.from}</p>
            <p className="text-xs text-sys-dim">{relativeTime(openMessage.receivedAt)}</p>

            {openMessage.attachments.length > 0 && (
              <ul className="space-y-0.5">
                {openMessage.attachments.map((a) => (
                  <li key={a.filename} className="flex items-center gap-1.5 text-xs text-sys-dim">
                    <Paperclip size={10} aria-hidden />
                    {/* Name and size only — this phase never downloads content. */}
                    <span className="truncate">{a.filename}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* Plain text, pre-wrapped. Never dangerouslySetInnerHTML. */}
            <div className="min-h-0 flex-1 overflow-y-auto rounded border border-sys-line/70 bg-black/20 p-2">
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-sys-text/85">
                {openMessage.body || "(no text content)"}
              </p>
            </div>
          </div>
        )}

        {openLoading && <PanelLoading label="Opening message" />}

        {/* The list. Internal scroll region — `min-h-0` is what lets it shrink
            and scroll rather than growing the page. */}
        {!loading && !problem && !openMessage && list && list.messages.length > 0 && (
          <ul data-testid="gmail-list" className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {list.messages.map((message) => (
              <li key={message.id}>
                <button
                  type="button"
                  data-testid={`gmail-message-${message.id}`}
                  onClick={() => void open(message)}
                  className="sys-focus w-full rounded border border-sys-line/60 bg-white/[0.02] p-2 text-left transition-colors hover:border-sys-cyan/30 hover:bg-white/[0.04]"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-sys-cyan-soft">
                      {message.from}
                    </span>
                    {message.hasAttachments && (
                      <Paperclip size={10} aria-hidden className="shrink-0 text-sys-dim" />
                    )}
                    {message.unread && (
                      <Badge tone="ok" className="shrink-0">
                        New
                      </Badge>
                    )}
                    <span className="shrink-0 font-mono text-xs text-sys-dim">
                      {relativeTime(message.receivedAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs font-medium text-white">{message.subject}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-sys-dim">
                    {message.snippet}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
