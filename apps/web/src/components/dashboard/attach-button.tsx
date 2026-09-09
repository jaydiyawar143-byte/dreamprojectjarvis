"use client";

// ---------------------------------------------------------------------------
// V3 — attachments in the command composer.
//
// Reuses the EXISTING knowledge pipeline rather than inventing a second one.
// A document goes to /knowledge/documents (already handles PDF, DOCX, TXT, MD);
// an image goes to /knowledge/images, where a vision model turns it into text
// that is then ingested through that same pipeline.
//
// The consequence worth stating: an attachment becomes an ordinary knowledge
// document. It is chunked, embedded, retrievable and citable, so the assistant
// answers questions about it through the RAG path that already existed — no
// special "attachment context" that only works for the next message.
//
// VALIDATION IS CLIENT-SIDE AND SERVER-SIDE. The checks here exist to give a
// fast, specific error; the server repeats every one of them, because a client
// check is a courtesy and not a control.
// ---------------------------------------------------------------------------

import { useRef, useState } from "react";
import { FileText, ImageIcon, Loader2, Paperclip, X } from "lucide-react";
import {
  MAX_ATTACHMENT_BYTES,
  SUPPORTED_IMAGE_TYPES,
  fileToBase64,
  isSupportedKnowledgeFile,
  uploadKnowledgeDocument,
  uploadKnowledgeImage,
} from "@/lib/api";

export interface AttachedFile {
  id: string;
  name: string;
  kind: "document" | "image";
  /** The knowledge document id, once ingested. */
  documentId?: string;
  status: "uploading" | "ready" | "error";
  message?: string;
  searchable?: boolean;
}

const ACCEPT = [".pdf", ".docx", ".txt", ".md", ...SUPPORTED_IMAGE_TYPES].join(",");

export function AttachButton({
  attachments,
  onChange,
  disabled = false,
}: {
  attachments: AttachedFile[];
  onChange: (next: AttachedFile[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  // Kept in a ref so an upload that resolves after another has started still
  // updates the correct list rather than clobbering it with a stale closure.
  const listRef = useRef(attachments);
  listRef.current = attachments;

  const update = (id: string, patch: Partial<AttachedFile>) => {
    onChange(listRef.current.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);

    for (const file of Array.from(files)) {
      const isImage = SUPPORTED_IMAGE_TYPES.includes(file.type);
      const id = `${Date.now()}-${file.name}`;

      if (!isImage && !isSupportedKnowledgeFile(file.name)) {
        onChange([
          ...listRef.current,
          { id, name: file.name, kind: "document", status: "error", message: "Unsupported file type" },
        ]);
        continue;
      }

      if (file.size > MAX_ATTACHMENT_BYTES) {
        onChange([
          ...listRef.current,
          { id, name: file.name, kind: isImage ? "image" : "document", status: "error", message: "File is larger than 10MB" },
        ]);
        continue;
      }

      const entry: AttachedFile = {
        id,
        name: file.name,
        kind: isImage ? "image" : "document",
        status: "uploading",
      };
      onChange([...listRef.current, entry]);

      try {
        const content = await fileToBase64(file);

        const res = isImage
          ? await uploadKnowledgeImage({ fileName: file.name, content, mimeType: file.type })
          : await uploadKnowledgeDocument({
              fileName: file.name,
              content,
              ...(file.type ? { mimeType: file.type } : {}),
              source: "command-center",
            });

        if (res.success && res.data) {
          const data = res.data as { document?: { id: string }; searchable?: boolean };
          update(id, {
            status: "ready",
            ...(data.document?.id ? { documentId: data.document.id } : {}),
            // "Ingested" and "searchable" differ: without an embedding key the
            // text is stored but cannot be retrieved, and saying so avoids the
            // user wondering why JARVIS cannot find it.
            searchable: data.searchable ?? false,
          });
        } else {
          update(id, { status: "error", message: res.error?.message ?? "Upload failed" });
        }
      } catch {
        update(id, { status: "error", message: "Could not read the file" });
      }
    }

    setBusy(false);
    // Clear the input, or selecting the same file twice fires no change event.
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        data-testid="attach-input"
        onChange={(e) => void handleFiles(e.target.files)}
        tabIndex={-1}
        aria-hidden="true"
      />

      <button
        type="button"
        data-testid="attach-button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || busy}
        aria-label="Attach a file or image"
        title="Attach a PDF, document or image"
        className="sys-focus flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sys-dim transition-colors enabled:hover:bg-white/[0.06] enabled:hover:text-white disabled:opacity-40"
      >
        {busy ? (
          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
        ) : (
          <Paperclip size={15} aria-hidden="true" />
        )}
      </button>
    </>
  );
}

/** The chips shown above the composer once something is attached. */
export function AttachmentList({
  attachments,
  onRemove,
}: {
  attachments: AttachedFile[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <ul data-testid="attachment-list" className="mb-2 flex flex-wrap gap-1.5">
      {attachments.map((file) => (
        <li
          key={file.id}
          data-testid="attachment-chip"
          data-status={file.status}
          className={`flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2 py-1 text-xs ${
            file.status === "error"
              ? "border-red-400/35 bg-red-400/10 text-red-300/90"
              : file.status === "uploading"
                ? "border-sys-line bg-white/[0.03] text-sys-dim"
                : "border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-300/90"
          }`}
        >
          {file.status === "uploading" ? (
            <Loader2 size={10} className="shrink-0 animate-spin" aria-hidden="true" />
          ) : file.kind === "image" ? (
            <ImageIcon size={10} className="shrink-0" aria-hidden="true" />
          ) : (
            <FileText size={10} className="shrink-0" aria-hidden="true" />
          )}

          <span className="min-w-0 flex-1 truncate">{file.name}</span>

          {file.status === "ready" && file.searchable === false && (
            <span
              title="Stored, but not searchable: this deployment has no embedding key."
              className="shrink-0 font-mono text-xs uppercase tracking-hud text-amber-300/80"
            >
              stored
            </span>
          )}
          {file.status === "error" && file.message && (
            <span className="shrink-0 font-mono text-xs uppercase tracking-hud">
              {file.message}
            </span>
          )}

          <button
            type="button"
            onClick={() => onRemove(file.id)}
            aria-label={`Remove ${file.name}`}
            className="sys-focus shrink-0 rounded text-current opacity-60 transition-opacity hover:opacity-100"
          >
            <X size={9} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
