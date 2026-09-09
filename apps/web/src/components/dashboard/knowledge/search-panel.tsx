"use client";

// ---------------------------------------------------------------------------
// Sprint 4.5 — Semantic search.
//
// Calls POST /api/v1/knowledge/search and renders what it returns. The query
// vector, the cosine search and the ranking are all server-side; this component
// never touches an embedding.
//
// Each hit shows its provenance — document, page, section, relevance — because
// a retrieved passage without a source is exactly the thing a knowledge base
// exists to avoid.
// ---------------------------------------------------------------------------

import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { searchKnowledge, type KnowledgeSearchHit } from "@/lib/api";
import { Panel } from "../panel";
import { EmptyState, ErrorState, LoadingState } from "../states";

export function SearchPanel({ hasDocuments }: { hasDocuments: boolean }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    setSubmitted(q);

    const res = await searchKnowledge(q, { topK: 5 });
    if (res.success && res.data) {
      setHits(res.data.results);
    } else {
      setHits([]);
      setError(res.error?.message ?? "Search failed.");
    }
    setLoading(false);
  }

  return (
    <Panel
      title="Search your documents"
      description="Ask in your own words — matching is by meaning, not keywords."
    >
      <form onSubmit={run} className="mb-4 flex gap-2">
        <label htmlFor="kb-search" className="sr-only">
          Search your documents
        </label>
        <input
          id="kb-search"
          data-testid="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What does my policy say about…"
          maxLength={4096}
          className="sys-focus sys-input min-w-0 flex-1 rounded-md border border-sys-control bg-sys-panel px-3 py-2 text-sm text-sys-text placeholder:text-sys-dim"
        />
        <button
          type="submit"
          data-testid="search-submit"
          disabled={loading || query.trim().length === 0}
          className="sys-focus inline-flex shrink-0 items-center gap-1.5 rounded-md border border-sys-cyan/45 bg-sys-cyan/[0.08] px-3 py-2 font-mono text-xs uppercase tracking-hud text-sys-cyan-soft transition-colors hover:border-sys-cyan/80 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Search size={12} aria-hidden="true" />
          Search
        </button>
      </form>

      {loading ? (
        <LoadingState label="Searching" lines={3} />
      ) : error ? (
        <ErrorState title="Search failed" message={error} />
      ) : submitted === null ? (
        <EmptyState
          title={hasDocuments ? "Ask a question" : "Nothing to search yet"}
          message={
            hasDocuments
              ? "Results come back with the document, page and section they were found in."
              : "Add a document first, then you can search it."
          }
          icon={<Search size={18} />}
        />
      ) : hits.length === 0 ? (
        <EmptyState
          title="Nothing matched"
          message={`No passage in your documents was close enough to “${submitted}”. Nothing has been invented to fill the gap.`}
          icon={<Search size={18} />}
        />
      ) : (
        <ul className="space-y-3" data-testid="search-results">
          {hits.map((hit) => (
            <li
              key={hit.chunkId}
              data-testid="search-hit"
              className="rounded-md border border-sys-line bg-white/[0.015] p-3"
            >
              <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span
                  data-testid="hit-source"
                  className="font-mono text-xs uppercase tracking-hud text-sys-cyan/85"
                >
                  {hit.documentTitle}
                </span>
                {hit.pageNumbers.length > 0 && (
                  <span className="font-mono text-xs uppercase tracking-hud text-sys-dim">
                    page{hit.pageNumbers.length > 1 ? "s" : ""} {hit.pageNumbers.join(", ")}
                  </span>
                )}
                {/* A Markdown document's first section is its H1, which is
                    also its title. Printing both just says the same thing
                    twice, so the section is shown only when it adds something. */}
                {hit.primarySection?.title &&
                  hit.primarySection.title.trim() !== hit.documentTitle.trim() && (
                    <span className="font-mono text-xs uppercase tracking-hud text-sys-dim">
                      {hit.primarySection.title}
                    </span>
                  )}
                <span className="ml-auto font-mono text-xs tabular-nums text-sys-dim">
                  {hit.score.toFixed(2)}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-sys-text/85">{hit.content}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
