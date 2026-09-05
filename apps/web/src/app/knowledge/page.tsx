"use client";

// ---------------------------------------------------------------------------
// Sprint 4.5 — Knowledge Base panel.
//
// Composes the Sprint 3 endpoints into one screen: an overview, the document
// list with status and metadata, upload, and semantic search. Every operation
// is an existing endpoint; the dashboard adds no extraction, chunking,
// embedding or retrieval logic of its own.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { listKnowledgeDocuments, type KnowledgeDocument } from "@/lib/api";
import { PageContainer, PageHeader, PanelGrid } from "@/components/dashboard/page-container";
import { StatPanel } from "@/components/dashboard/panel";
import { UploadPanel } from "@/components/dashboard/knowledge/upload-panel";
import { DocumentList } from "@/components/dashboard/knowledge/document-list";
import { SearchPanel } from "@/components/dashboard/knowledge/search-panel";

export default function KnowledgePage() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listKnowledgeDocuments();
    if (res.success && res.data) {
      setDocuments(res.data.documents);
    } else {
      setError(res.error?.message ?? "Could not load your documents.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const searchable = documents.filter((d) => d.status === "PROCESSED").length;
  const pages = documents.reduce((n, d) => n + (d.pageCount ?? 0), 0);
  const words = documents.reduce((n, d) => n + (d.wordCount ?? 0), 0);

  return (
    <PageContainer>
      <PageHeader
        title="Knowledge Base"
        description="Documents JARVIS can read and cite. Upload once; every answer can draw on them."
      />

      <div className="space-y-6">
        <PanelGrid columns={4}>
          <StatPanel label="Documents" value={documents.length} hint="In your knowledge base" loading={loading} />
          <StatPanel
            label="Searchable"
            value={searchable}
            hint={
              documents.length > 0 && searchable < documents.length
                ? `${documents.length - searchable} not indexed`
                : "Embedded and retrievable"
            }
            tone={documents.length > 0 && searchable < documents.length ? "warning" : "default"}
            loading={loading}
          />
          <StatPanel label="Pages" value={pages} hint="Across all documents" loading={loading} />
          <StatPanel
            label="Words"
            value={words >= 1000 ? `${Math.round(words / 1000)}k` : words}
            hint="Extracted text"
            loading={loading}
          />
        </PanelGrid>

        {/* items-start: search grows with its results, upload does not. Without
            it the grid stretches the short panel to match, leaving a tall
            column of dead space beside the results. */}
        <PanelGrid columns={2} className="items-start">
          <UploadPanel onUploaded={() => void load()} />
          <SearchPanel hasDocuments={searchable > 0} />
        </PanelGrid>

        <DocumentList
          documents={documents}
          loading={loading}
          error={error}
          onRetry={() => void load()}
          onChanged={() => void load()}
        />
      </div>
    </PageContainer>
  );
}
