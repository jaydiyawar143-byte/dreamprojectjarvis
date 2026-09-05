"use client";

// ---------------------------------------------------------------------------
// Sprint 4.5 — Document list, status and metadata.
//
// Status is the one thing a reader needs at a glance: PROCESSED means the
// document is searchable, PENDING_EMBEDDING means it is stored but invisible to
// retrieval, FAILED means ingestion stopped part-way. Each gets its own chip,
// so the state is readable without decoding a colour.
//
// Deletion uses the existing owner-scoped DELETE endpoint. It is confirmed
// in-place rather than with a browser dialog, and it is the only write on this
// screen.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Trash2 } from "lucide-react";
import {
  deleteKnowledgeDocument,
  getKnowledgeChunks,
  type KnowledgeChunk,
  type KnowledgeDocument,
} from "@/lib/api";
import { Panel } from "../panel";
import { EmptyState, ErrorState, LoadingState } from "../states";
import { cn } from "@/lib/utils";

const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  PROCESSED: { label: "Searchable", className: "border-sys-ok/45 bg-sys-ok/10 text-sys-ok" },
  PENDING_EMBEDDING: {
    label: "Not searchable",
    className: "border-amber-400/45 bg-amber-400/10 text-amber-300",
  },
  FAILED: { label: "Failed", className: "border-sys-danger/45 bg-sys-danger/10 text-sys-danger" },
  UPLOADED: { label: "Processing", className: "border-sys-line bg-white/[0.03] text-sys-dim" },
};

function chip(status: string) {
  return STATUS_CHIP[status] ?? { label: status, className: "border-sys-line text-sys-dim" };
}

function meta(doc: KnowledgeDocument): string {
  const parts: string[] = [doc.documentType];
  if (typeof doc.pageCount === "number" && doc.pageCount > 0) {
    parts.push(`${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}`);
  }
  if (typeof doc.wordCount === "number") parts.push(`${doc.wordCount.toLocaleString()} words`);
  if (doc.source) parts.push(doc.source);
  return parts.join(" · ");
}

export function DocumentList({
  documents,
  loading,
  error,
  onRetry,
  onChanged,
}: {
  documents: KnowledgeDocument[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function toggle(id: string) {
    if (expanded === id) {
      setExpanded(null);
      setChunks([]);
      return;
    }
    setExpanded(id);
    setChunks([]);
    setChunksLoading(true);
    const res = await getKnowledgeChunks(id);
    setChunks(res.success && res.data ? res.data.chunks : []);
    setChunksLoading(false);
  }

  async function remove(id: string) {
    setDeleting(id);
    setActionError(null);
    const res = await deleteKnowledgeDocument(id);
    setDeleting(null);
    setConfirming(null);
    if (res.success) {
      if (expanded === id) setExpanded(null);
      onChanged();
    } else {
      setActionError(res.error?.message ?? "Could not remove that document.");
    }
  }

  return (
    <Panel title="Documents" description="Everything JARVIS can cite when it answers you.">
      {loading ? (
        <LoadingState label="Loading documents" lines={3} />
      ) : error ? (
        <ErrorState title="Could not load your documents" message={error} onRetry={onRetry} />
      ) : documents.length === 0 ? (
        <EmptyState
          title="No documents yet"
          message="Add a PDF, Word file, text file or Markdown and JARVIS will be able to cite it."
          icon={<FileText size={18} />}
        />
      ) : (
        <div className="space-y-2">
          {actionError && <ErrorState title="Removal failed" message={actionError} />}

          <ul className="divide-y divide-sys-line/60">
            {documents.map((doc) => {
              const status = chip(doc.status);
              const isOpen = expanded === doc.id;

              return (
                <li key={doc.id} data-testid="document-row" className="py-2.5">
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => void toggle(doc.id)}
                      aria-expanded={isOpen}
                      data-testid={`expand-${doc.id}`}
                      className="sys-focus mt-0.5 rounded p-0.5 text-sys-dim hover:text-white"
                      aria-label={isOpen ? "Hide extracted passages" : "Show extracted passages"}
                    >
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm text-sys-text" title={doc.title}>
                          {doc.title}
                        </span>
                        <span
                          data-testid={`status-${doc.id}`}
                          className={cn(
                            "rounded border px-1.5 py-px font-mono text-[0.5rem] uppercase tracking-hud",
                            status.className
                          )}
                        >
                          {status.label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-sys-dim">{meta(doc)}</p>
                    </div>

                    {confirming === doc.id ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          data-testid={`confirm-delete-${doc.id}`}
                          disabled={deleting === doc.id}
                          onClick={() => void remove(doc.id)}
                          className="sys-focus rounded border border-sys-danger/50 bg-sys-danger/10 px-2 py-1 font-mono text-[0.55rem] uppercase tracking-hud text-sys-danger disabled:opacity-50"
                        >
                          {deleting === doc.id ? "Removing…" : "Remove"}
                        </button>
                        <button
                          type="button"
                          data-testid={`cancel-delete-${doc.id}`}
                          onClick={() => setConfirming(null)}
                          className="sys-focus rounded border border-sys-line px-2 py-1 font-mono text-[0.55rem] uppercase tracking-hud text-sys-dim"
                        >
                          Keep
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid={`delete-${doc.id}`}
                        onClick={() => setConfirming(doc.id)}
                        aria-label={`Remove ${doc.title}`}
                        className="sys-focus shrink-0 rounded p-1.5 text-sys-dim transition-colors hover:bg-sys-danger/10 hover:text-sys-danger"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>

                  {isOpen && (
                    <div className="mt-2 pl-6" data-testid={`chunks-${doc.id}`}>
                      {chunksLoading ? (
                        <LoadingState label="Loading passages" lines={2} />
                      ) : chunks.length === 0 ? (
                        <p className="text-xs text-sys-dim">No passages were stored for this document.</p>
                      ) : (
                        <ul className="space-y-2">
                          {chunks.map((c) => (
                            <li
                              key={c.id}
                              data-testid="chunk-row"
                              className="rounded border border-sys-line/70 bg-white/[0.015] p-2.5"
                            >
                              <p className="mb-1 font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim">
                                Passage {c.chunkIndex + 1}
                                {c.pageNumbers.length > 0 &&
                                  ` · page${c.pageNumbers.length > 1 ? "s" : ""} ${c.pageNumbers.join(", ")}`}
                                {/* Suppressed when it merely repeats the document
                                    title, which is what a Markdown H1 gives us. */}
                                {c.primarySection?.title &&
                                  c.primarySection.title.trim() !== doc.title.trim() &&
                                  ` · ${c.primarySection.title}`}
                              </p>
                              <p className="line-clamp-3 text-xs leading-relaxed text-sys-text/80">
                                {c.content}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}
