// ---------------------------------------------------------------------------
// Sprint 4.5 — Knowledge Base panel.
//
// The panel is a client for the Sprint 3 endpoints, so these tests check that
// it calls them correctly and renders what they return — never that it computes
// anything. Two rules are asserted repeatedly because they are the point of the
// feature: provenance is always shown with a retrieved passage, and an empty
// result is reported as empty rather than filled in.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, prefetch: vi.fn() }),
  usePathname: () => "/knowledge",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    listKnowledgeDocuments: vi.fn(),
    getKnowledgeChunks: vi.fn(),
    deleteKnowledgeDocument: vi.fn(),
    uploadKnowledgeDocument: vi.fn(),
    searchKnowledge: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import KnowledgePage from "../src/app/knowledge/page";
import KnowledgeLayout from "../src/app/knowledge/layout";
import { UploadPanel } from "../src/components/dashboard/knowledge/upload-panel";
import { DocumentList } from "../src/components/dashboard/knowledge/document-list";
import { SearchPanel } from "../src/components/dashboard/knowledge/search-panel";
import { AuthProvider } from "../src/lib/auth";
import { NAV_ITEMS } from "../src/components/dashboard/nav";

const mockedApi = vi.mocked(api);
const ts = () => new Date().toISOString();

const DOC = (over: Partial<api.KnowledgeDocument> = {}): api.KnowledgeDocument => ({
  id: "doc-1",
  title: "Leave Policy",
  documentType: "MD",
  status: "PROCESSED",
  createdAt: ts(),
  updatedAt: ts(),
  fileName: "leave.md",
  wordCount: 1200,
  pageCount: 0,
  source: "hr-handbook",
  ...over,
});

/** UI V2 — session restored via the refresh cookie, not stored tokens. */
function seedSession() {
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/auth/refresh")
      ? { accessToken: "t", expiresIn: 900 }
      : { id: "u1", email: "a@b.c", name: "Op", role: "member", createdAt: ts(), updatedAt: ts() };
    return Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ success: true, data: body, timestamp: ts() }),
    } as Response);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  routerReplace.mockClear();
  sessionStorage.clear();
  seedSession();
  mockedApi.listKnowledgeDocuments.mockResolvedValue({
    success: true,
    data: { documents: [DOC()], total: 1 },
    timestamp: ts(),
  });
});

// ---------------------------------------------------------------------------
// Overview + document list
// ---------------------------------------------------------------------------

describe("knowledge overview", () => {
  it("summarises the base from the document list, computing nothing server-side", async () => {
    mockedApi.listKnowledgeDocuments.mockResolvedValue({
      success: true,
      data: {
        documents: [
          DOC({ id: "a", wordCount: 1000, pageCount: 3 }),
          DOC({ id: "b", status: "PENDING_EMBEDDING", wordCount: 2000, pageCount: 2 }),
        ],
        total: 2,
      },
      timestamp: ts(),
    });

    render(<KnowledgePage />);

    await waitFor(() => {
      const values = screen.getAllByTestId("stat-value").map((n) => n.textContent);
      expect(values).toEqual(["2", "1", "5", "3k"]);
    });
  });

  it("lists documents with their status and metadata", async () => {
    render(<KnowledgePage />);

    await waitFor(() => expect(screen.getByTestId("document-row")).toBeInTheDocument());
    const row = screen.getByTestId("document-row");
    expect(within(row).getByText("Leave Policy")).toBeInTheDocument();
    expect(screen.getByTestId("status-doc-1").textContent).toBe("Searchable");
    expect(row.textContent).toContain("1,200 words");
    expect(row.textContent).toContain("hr-handbook");
  });

  it("flags a stored-but-unindexed document as not searchable", async () => {
    render(
      <DocumentList
        documents={[DOC({ status: "PENDING_EMBEDDING" })]}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByTestId("status-doc-1").textContent).toBe("Not searchable");
  });

  it("shows an empty state when nothing has been uploaded", async () => {
    mockedApi.listKnowledgeDocuments.mockResolvedValue({
      success: true,
      data: { documents: [], total: 0 },
      timestamp: ts(),
    });

    render(<KnowledgePage />);
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());
  });

  it("surfaces a retryable error when the list cannot be loaded", async () => {
    const onRetry = vi.fn();
    render(
      <DocumentList documents={[]} loading={false} error="Network request failed" onRetry={onRetry} onChanged={vi.fn()} />
    );
    expect(screen.getByTestId("error-message").textContent).toBe("Network request failed");
    fireEvent.click(screen.getByTestId("error-retry"));
    expect(onRetry).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Chunks / source metadata
// ---------------------------------------------------------------------------

describe("document passages", () => {
  it("fetches passages on demand and shows page and section provenance", async () => {
    mockedApi.getKnowledgeChunks.mockResolvedValue({
      success: true,
      data: {
        documentId: "doc-1",
        chunks: [
          {
            id: "c1",
            chunkIndex: 0,
            content: "Every confirmed employee accrues 27 working days.",
            pageNumbers: [3, 4],
            primarySection: { title: "Annual Leave", level: 2, order: 1 },
          },
        ],
        total: 1,
      },
      timestamp: ts(),
    });

    render(<DocumentList documents={[DOC()]} loading={false} error={null} onRetry={vi.fn()} onChanged={vi.fn()} />);

    expect(mockedApi.getKnowledgeChunks).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("expand-doc-1"));

    await waitFor(() => expect(screen.getByTestId("chunk-row")).toBeInTheDocument());
    const chunk = screen.getByTestId("chunk-row");
    expect(chunk.textContent).toContain("Passage 1");
    expect(chunk.textContent).toContain("pages 3, 4");
    expect(chunk.textContent).toContain("Annual Leave");
    expect(chunk.textContent).toContain("27 working days");
  });

  it("collapses again without refetching state it already discarded", async () => {
    mockedApi.getKnowledgeChunks.mockResolvedValue({
      success: true,
      data: { documentId: "doc-1", chunks: [], total: 0 },
      timestamp: ts(),
    });

    render(<DocumentList documents={[DOC()]} loading={false} error={null} onRetry={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId("expand-doc-1"));
    await waitFor(() => expect(screen.getByTestId("chunks-doc-1")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("expand-doc-1"));
    expect(screen.queryByTestId("chunks-doc-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

describe("document removal", () => {
  it("asks before removing, and only removes on confirmation", async () => {
    mockedApi.deleteKnowledgeDocument.mockResolvedValue({
      success: true,
      data: { id: "doc-1", deleted: true },
      timestamp: ts(),
    });
    const onChanged = vi.fn();

    render(<DocumentList documents={[DOC()]} loading={false} error={null} onRetry={vi.fn()} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId("delete-doc-1"));
    expect(mockedApi.deleteKnowledgeDocument).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-delete-doc-1"));
    await waitFor(() => expect(mockedApi.deleteKnowledgeDocument).toHaveBeenCalledWith("doc-1"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("backs out cleanly when the removal is cancelled", () => {
    render(<DocumentList documents={[DOC()]} loading={false} error={null} onRetry={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId("delete-doc-1"));
    fireEvent.click(screen.getByTestId("cancel-delete-doc-1"));
    expect(screen.getByTestId("delete-doc-1")).toBeInTheDocument();
    expect(mockedApi.deleteKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("reports a failed removal without dropping the row", async () => {
    mockedApi.deleteKnowledgeDocument.mockResolvedValue({
      success: false,
      error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found" },
      timestamp: ts(),
    } as never);

    render(<DocumentList documents={[DOC()]} loading={false} error={null} onRetry={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId("delete-doc-1"));
    fireEvent.click(screen.getByTestId("confirm-delete-doc-1"));

    await waitFor(() => expect(screen.getByText("Document not found")).toBeInTheDocument());
    expect(screen.getByTestId("document-row")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function pickFile(name: string, bytes: number, type = "text/markdown") {
  const file = new File([new Uint8Array(bytes)], name, { type });
  const input = screen.getByTestId("upload-input") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
  return file;
}

describe("upload", () => {
  it("uploads a supported file and reports what the server did with it", async () => {
    mockedApi.uploadKnowledgeDocument.mockResolvedValue({
      success: true,
      data: {
        document: DOC({ title: "Expense Policy" }),
        chunkCount: 4,
        embeddedCount: 4,
        skippedCount: 0,
        embedded: true,
        searchable: true,
      },
      timestamp: ts(),
    });
    const onUploaded = vi.fn();

    render(<UploadPanel onUploaded={onUploaded} />);
    pickFile("expense.md", 120);

    await waitFor(() => expect(screen.getByTestId("upload-success")).toBeInTheDocument());
    const box = screen.getByTestId("upload-success");
    expect(box.textContent).toContain("Added and searchable");
    expect(box.textContent).toContain("Expense Policy");
    expect(box.textContent).toContain("4 chunks");
    expect(onUploaded).toHaveBeenCalledTimes(1);

    const sent = mockedApi.uploadKnowledgeDocument.mock.calls[0]![0];
    expect(sent.fileName).toBe("expense.md");
    expect(typeof sent.content).toBe("string");
  });

  it("says so when a document was stored but is not searchable", async () => {
    mockedApi.uploadKnowledgeDocument.mockResolvedValue({
      success: true,
      data: {
        document: DOC(),
        chunkCount: 2,
        embeddedCount: 0,
        skippedCount: 0,
        embedded: false,
        searchable: false,
      },
      timestamp: ts(),
    });

    render(<UploadPanel onUploaded={vi.fn()} />);
    pickFile("notes.txt", 50, "text/plain");

    await waitFor(() => expect(screen.getByTestId("upload-success")).toBeInTheDocument());
    expect(screen.getByTestId("upload-success").textContent).toContain("Added, not yet searchable");
    expect(screen.getByTestId("upload-success").textContent).toContain("no embedding provider");
  });

  it("refuses an unsupported extension before sending anything", async () => {
    render(<UploadPanel onUploaded={vi.fn()} />);
    pickFile("payload.exe", 100, "application/octet-stream");

    await waitFor(() => expect(screen.getByTestId("error-state")).toBeInTheDocument());
    expect(screen.getByTestId("error-message").textContent).toContain("not supported");
    expect(mockedApi.uploadKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("refuses a file over the size ceiling before encoding it", async () => {
    render(<UploadPanel onUploaded={vi.fn()} />);
    pickFile("huge.pdf", 7 * 1024 * 1024, "application/pdf");

    await waitFor(() => expect(screen.getByTestId("error-state")).toBeInTheDocument());
    expect(screen.getByTestId("error-message").textContent).toContain("limit is");
    expect(mockedApi.uploadKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("refuses an empty file", async () => {
    render(<UploadPanel onUploaded={vi.fn()} />);
    pickFile("empty.md", 0);

    await waitFor(() => expect(screen.getByTestId("error-message").textContent).toContain("empty"));
    expect(mockedApi.uploadKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("surfaces a server rejection verbatim", async () => {
    mockedApi.uploadKnowledgeDocument.mockResolvedValue({
      success: false,
      error: { code: "DOCUMENT_TOO_LARGE", message: "Document exceeds the maximum size" },
      timestamp: ts(),
    } as never);

    render(<UploadPanel onUploaded={vi.fn()} />);
    pickFile("big.pdf", 500, "application/pdf");

    await waitFor(() =>
      expect(screen.getByTestId("error-message").textContent).toBe("Document exceeds the maximum size")
    );
  });

  it("shows progress while the server is still processing", async () => {
    let release: (v: unknown) => void = () => {};
    mockedApi.uploadKnowledgeDocument.mockReturnValue(new Promise((r) => { release = r; }) as never);

    render(<UploadPanel onUploaded={vi.fn()} />);
    pickFile("slow.md", 100);

    await waitFor(() => expect(screen.getByTestId("upload-progress")).toBeInTheDocument());
    expect(screen.getByTestId("upload-progress").textContent).toContain("slow.md");

    release({ success: true, data: { document: DOC(), chunkCount: 1, embeddedCount: 1, skippedCount: 0, embedded: true, searchable: true }, timestamp: ts() });
    await waitFor(() => expect(screen.queryByTestId("upload-progress")).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("search", () => {
  const HIT: api.KnowledgeSearchHit = {
    chunkId: "c1",
    documentId: "doc-1",
    documentTitle: "Leave Policy",
    documentType: "MD",
    source: "hr-handbook",
    chunkIndex: 1,
    content: "Every confirmed employee accrues 27 working days of paid annual leave.",
    score: 0.58,
    pageNumbers: [3],
    primarySection: { title: "Annual Leave", level: 2, order: 1 },
  };

  it("prompts before a search has been run", () => {
    render(<SearchPanel hasDocuments />);
    expect(screen.getByText("Ask a question")).toBeInTheDocument();
    expect(mockedApi.searchKnowledge).not.toHaveBeenCalled();
  });

  it("tells the user to upload first when nothing is indexed", () => {
    render(<SearchPanel hasDocuments={false} />);
    expect(screen.getByText("Nothing to search yet")).toBeInTheDocument();
  });

  it("renders each hit with its document, page, section and relevance", async () => {
    mockedApi.searchKnowledge.mockResolvedValue({
      success: true,
      data: { query: "leave", results: [HIT], resultCount: 1, topK: 5, similarityThreshold: 0.3, emptyQuery: false },
      timestamp: ts(),
    });

    render(<SearchPanel hasDocuments />);
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "how much leave" } });
    fireEvent.click(screen.getByTestId("search-submit"));

    await waitFor(() => expect(screen.getByTestId("search-hit")).toBeInTheDocument());
    const hit = screen.getByTestId("search-hit");
    expect(within(hit).getByTestId("hit-source").textContent).toBe("Leave Policy");
    expect(hit.textContent).toContain("page 3");
    expect(hit.textContent).toContain("Annual Leave");
    expect(hit.textContent).toContain("0.58");
    expect(hit.textContent).toContain("27 working days");

    expect(mockedApi.searchKnowledge).toHaveBeenCalledWith("how much leave", { topK: 5 });
  });

  it("reports an empty result as empty, and says nothing was invented", async () => {
    mockedApi.searchKnowledge.mockResolvedValue({
      success: true,
      data: { query: "cake", results: [], resultCount: 0, topK: 5, similarityThreshold: 0.3, emptyQuery: false },
      timestamp: ts(),
    });

    render(<SearchPanel hasDocuments />);
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "chocolate cake" } });
    fireEvent.click(screen.getByTestId("search-submit"));

    await waitFor(() => expect(screen.getByText("Nothing matched")).toBeInTheDocument());
    expect(screen.queryByTestId("search-hit")).toBeNull();
  });

  it("surfaces a search failure", async () => {
    mockedApi.searchKnowledge.mockResolvedValue({
      success: false,
      error: { code: "TOOL_UNAVAILABLE", message: "Knowledge search is unavailable" },
      timestamp: ts(),
    } as never);

    render(<SearchPanel hasDocuments />);
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "leave" } });
    fireEvent.click(screen.getByTestId("search-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("error-message").textContent).toBe("Knowledge search is unavailable")
    );
  });

  it("will not submit an empty query", () => {
    render(<SearchPanel hasDocuments />);
    expect(screen.getByTestId("search-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "   " } });
    expect(screen.getByTestId("search-submit")).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("knowledge route authorization", () => {
  it("does not mount the page without a resolved session", async () => {
    sessionStorage.clear();
    global.fetch = vi.fn(() =>
      Promise.resolve({
        status: 401,
        ok: false,
        json: () => Promise.resolve({ success: false, error: { code: "AUTHENTICATION_REQUIRED", message: "x" }, timestamp: ts() }),
      } as Response)
    ) as unknown as typeof fetch;

    render(
      <AuthProvider>
        <KnowledgeLayout>
          <p data-testid="kb-child">child</p>
        </KnowledgeLayout>
      </AuthProvider>
    );

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByTestId("kb-child")).toBeNull();
    expect(mockedApi.listKnowledgeDocuments).not.toHaveBeenCalled();
  });

  it("mounts inside the dashboard shell once the session resolves", async () => {
    render(
      <AuthProvider>
        <KnowledgeLayout>
          <p data-testid="kb-child">child</p>
        </KnowledgeLayout>
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("dashboard-shell")).toBeInTheDocument());
    expect(screen.getByTestId("kb-child")).toBeInTheDocument();
  });

  it("is now a navigable destination", () => {
    const kb = NAV_ITEMS.find((i) => i.href === "/knowledge");
    expect(kb?.available).toBe(true);
  });
});
