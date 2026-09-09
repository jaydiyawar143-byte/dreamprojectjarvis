"use client";

// ---------------------------------------------------------------------------
// Sprint 4.5 — Document upload.
//
// The UI validates only what it can validate cheaply and locally: the
// extension and the decoded size, both mirroring the server's own limits, so a
// doomed upload is refused before it is base64-encoded and sent. Everything
// that decides whether a document is usable — MIME agreement, magic bytes,
// extraction, chunking, embedding — stays on the server, unchanged.
// ---------------------------------------------------------------------------

import { useRef, useState } from "react";
import { FileUp, Loader2, X } from "lucide-react";
import {
  KNOWLEDGE_EXTENSIONS,
  KNOWLEDGE_MAX_BYTES,
  fileToBase64,
  isSupportedKnowledgeFile,
  uploadKnowledgeDocument,
  type KnowledgeIngestResult,
} from "@/lib/api";
import { Panel } from "../panel";
import { ErrorState } from "../states";

type Phase = "idle" | "reading" | "uploading";

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function UploadPanel({ onUploaded }: { onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KnowledgeIngestResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const busy = phase !== "idle";

  async function handleFile(file: File) {
    setError(null);
    setResult(null);
    setFileName(file.name);

    if (!isSupportedKnowledgeFile(file.name)) {
      setError(
        `That file type is not supported. Accepted: ${KNOWLEDGE_EXTENSIONS.join(", ")}`
      );
      return;
    }
    if (file.size > KNOWLEDGE_MAX_BYTES) {
      setError(
        `That file is ${humanSize(file.size)}. The limit is ${humanSize(KNOWLEDGE_MAX_BYTES)}.`
      );
      return;
    }
    if (file.size === 0) {
      setError("That file is empty.");
      return;
    }

    try {
      setPhase("reading");
      const content = await fileToBase64(file);

      setPhase("uploading");
      const res = await uploadKnowledgeDocument({
        fileName: file.name,
        content,
        ...(file.type ? { mimeType: file.type } : {}),
      });

      if (res.success && res.data) {
        setResult(res.data);
        onUploaded();
      } else {
        setError(res.error?.message ?? "The upload failed.");
      }
    } catch {
      setError("Could not read that file.");
    } finally {
      setPhase("idle");
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Panel
      title="Add a document"
      description={`PDF, DOCX, TXT or Markdown, up to ${humanSize(KNOWLEDGE_MAX_BYTES)}.`}
    >
      <div className="space-y-3">
        <input
          ref={inputRef}
          type="file"
          accept={KNOWLEDGE_EXTENSIONS.join(",")}
          data-testid="upload-input"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
          className="sr-only"
          id="knowledge-upload"
        />

        <label
          htmlFor="knowledge-upload"
          data-testid="upload-trigger"
          className={`sys-focus flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-4 py-6 transition-colors ${
            busy
              ? "cursor-wait border-sys-line text-sys-dim"
              : "border-sys-edge text-sys-text/85 hover:border-sys-cyan/45 hover:text-white"
          }`}
        >
          {busy ? (
            <>
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              <span className="font-mono text-xs uppercase tracking-hud">
                {phase === "reading" ? "Reading file…" : "Processing document…"}
              </span>
            </>
          ) : (
            <>
              <FileUp size={15} aria-hidden="true" />
              <span className="font-mono text-xs uppercase tracking-hud">Choose a file</span>
            </>
          )}
        </label>

        {/* Progress is deliberately phase-based, not a percentage: the server
            does extraction, chunking and embedding after the bytes land, and a
            bar that hits 100% while the document is still being processed
            would be a lie. */}
        {busy && (
          <p
            data-testid="upload-progress"
            role="status"
            aria-live="polite"
            className="text-xs text-sys-dim"
          >
            {fileName}
            {phase === "uploading" && " — extracting, chunking and embedding on the server"}
          </p>
        )}

        {error && (
          <ErrorState title="Upload rejected" message={error} />
        )}

        {result && (
          <div
            data-testid="upload-success"
            role="status"
            className="flex items-start justify-between gap-3 rounded-md border border-sys-ok/35 bg-sys-ok/[0.06] p-3"
          >
            <div className="min-w-0 space-y-1">
              <p className="font-mono text-xs uppercase tracking-hud text-sys-ok">
                {result.searchable ? "Added and searchable" : "Added, not yet searchable"}
              </p>
              <p className="truncate text-sm text-sys-text/85">{result.document.title}</p>
              <p className="text-xs text-sys-dim">
                {result.chunkCount} chunk{result.chunkCount === 1 ? "" : "s"} ·{" "}
                {result.embeddedCount} embedded
                {result.skippedCount > 0 && ` · ${result.skippedCount} skipped`}
                {!result.embedded && " · no embedding provider configured"}
              </p>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              data-testid="dismiss-success"
              onClick={() => setResult(null)}
              className="sys-focus rounded p-1 text-sys-dim hover:text-white"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
