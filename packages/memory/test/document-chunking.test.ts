import { describe, it, expect } from "vitest";
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DOCUMENT_CHUNKING_VERSION,
  JarvisError,
  MAX_CHUNK_SIZE,
  type DocumentChunkingResult,
  type DocumentExtractionResult,
  type ExtractedPage,
  type ExtractedSection,
} from "@jarvis/core";
import {
  DocumentChunkingService,
  computeChunkSpans,
  deriveChunkId,
  findChunkEnd,
  findPrimarySection,
  locatePages,
  locateSectionRefs,
  resolveChunkingOptions,
  toKnowledgeChunkInputs,
} from "../src/chunking/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const chunker = new DocumentChunkingService();

/** Deterministic prose long enough to force many chunks. */
function prose(sentences: number): string {
  const parts: string[] = [];
  for (let i = 0; i < sentences; i++) {
    parts.push(`Sentence number ${i} carries a little payload of words.`);
  }
  return parts.join(" ");
}

/**
 * The invariants every chunk set must satisfy. Asserted from one place so each
 * test below can state only what is specific to it.
 */
function assertCoreInvariants(
  text: string,
  result: DocumentChunkingResult,
  { expectNoGaps = true }: { expectNoGaps?: boolean } = {}
): void {
  expect(result.chunkCount).toBe(result.chunks.length);
  expect(result.totalCharCount).toBe(text.length);

  result.chunks.forEach((chunk, i) => {
    // Ordering is contiguous and 0-based.
    expect(chunk.index).toBe(i);

    // The defining invariant: a chunk is exactly its slice of the source.
    expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.content);

    expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
    expect(chunk.charCount).toBe(chunk.content.length);
    expect(chunk.metadata.chunkingVersion).toBe(DOCUMENT_CHUNKING_VERSION);
  });

  if (result.chunks.length > 0) {
    const last = result.chunks[result.chunks.length - 1]!;
    expect(last.endOffset).toBe(text.length);
  }

  if (expectNoGaps) {
    for (let i = 1; i < result.chunks.length; i++) {
      const previous = result.chunks[i - 1]!;
      const current = result.chunks[i]!;
      // No gap: the next chunk starts at or before the previous one ended.
      expect(current.startOffset).toBeLessThanOrEqual(previous.endOffset);
      // Forward progress.
      expect(current.startOffset).toBeGreaterThan(previous.startOffset);
    }
  }
}

function makeExtractionResult(
  overrides: Partial<DocumentExtractionResult> = {}
): DocumentExtractionResult {
  return {
    format: "MD",
    mimeType: "text/markdown",
    fileName: "handbook.md",
    title: "Handbook",
    text: "placeholder",
    charCount: 11,
    wordCount: 1,
    byteSize: 11,
    contentHash: "a".repeat(64),
    pages: [],
    sections: [],
    metadata: { warnings: [] },
    extractionVersion: "3.2.0",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

describe("resolveChunkingOptions", () => {
  it("applies documented defaults", () => {
    expect(resolveChunkingOptions()).toEqual({
      chunkSize: DEFAULT_CHUNK_SIZE,
      chunkOverlap: DEFAULT_CHUNK_OVERLAP,
      minChunkSize: 0,
    });
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects chunkSize %p", (chunkSize) => {
    expect(() => resolveChunkingOptions({ chunkSize })).toThrow(JarvisError);
  });

  it("rejects a chunkSize beyond the ceiling", () => {
    expect(() => resolveChunkingOptions({ chunkSize: MAX_CHUNK_SIZE + 1 })).toThrow(
      /must not exceed/
    );
  });

  it.each([-1, 2.5])("rejects chunkOverlap %p", (chunkOverlap) => {
    expect(() => resolveChunkingOptions({ chunkOverlap })).toThrow(JarvisError);
  });

  it("rejects overlap equal to chunk size, which could never advance", () => {
    expect(() =>
      resolveChunkingOptions({ chunkSize: 100, chunkOverlap: 100 })
    ).toThrow(/smaller than chunkSize/);
  });

  it("rejects overlap larger than chunk size", () => {
    expect(() =>
      resolveChunkingOptions({ chunkSize: 100, chunkOverlap: 101 })
    ).toThrow(/smaller than chunkSize/);
  });

  it("rejects a negative minChunkSize", () => {
    expect(() => resolveChunkingOptions({ minChunkSize: -1 })).toThrow(JarvisError);
  });

  it("raises INVALID_REQUEST, matching the extraction service's config errors", () => {
    try {
      resolveChunkingOptions({ chunkSize: 0 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(JarvisError);
      expect((error as JarvisError).code).toBe("INVALID_REQUEST");
      expect((error as JarvisError).statusCode).toBe(400);
    }
  });

  it("validates eagerly in the constructor", () => {
    expect(() => new DocumentChunkingService({ chunkSize: -5 })).toThrow(JarvisError);
  });
});

describe("option inheritance", () => {
  it("rescales an inherited overlap that cannot fit a smaller chunk size", () => {
    // The service default overlap is 200. Asking for chunkSize 100 alone is a
    // perfectly reasonable request and must not fail validation.
    const result = chunker.chunkText("a".repeat(500), {}, { chunkSize: 100 });

    expect(result.chunkSize).toBe(100);
    expect(result.chunkOverlap).toBe(20); // 20%, the proportion the defaults encode
    expect(result.chunkCount).toBeGreaterThan(0);
  });

  it("leaves a valid inherited overlap untouched", () => {
    const service = new DocumentChunkingService({ chunkSize: 500, chunkOverlap: 50 });
    const result = service.chunkText("a".repeat(4000), {}, { chunkSize: 1000 });

    expect(result.chunkOverlap).toBe(50);
  });

  it("still rejects an impossible pair the caller states outright", () => {
    expect(() =>
      chunker.chunkText("text", {}, { chunkSize: 100, chunkOverlap: 100 })
    ).toThrow(/smaller than chunkSize/);
  });

  it("keeps service defaults when a call passes no options", () => {
    const service = new DocumentChunkingService({ chunkSize: 300, chunkOverlap: 30 });
    const result = service.chunkText(prose(40));

    expect(result.chunkSize).toBe(300);
    expect(result.chunkOverlap).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Empty and whitespace-only content
// ---------------------------------------------------------------------------

describe("empty content", () => {
  it("returns zero chunks for an empty string rather than throwing", () => {
    const result = chunker.chunkText("");
    expect(result.chunks).toEqual([]);
    expect(result.chunkCount).toBe(0);
    expect(result.totalCharCount).toBe(0);
  });

  it.each(["   ", "\n\n\n", " \t \n \t ", "\n \n"])(
    "returns zero chunks for whitespace-only input %j",
    (text) => {
      const result = chunker.chunkText(text);
      expect(result.chunks).toEqual([]);
      expect(result.chunkCount).toBe(0);
    }
  );

  it("still reports a well-formed result for empty input", () => {
    const result = chunker.chunkText("");
    expect(result.chunkingVersion).toBe(DOCUMENT_CHUNKING_VERSION);
    expect(result.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    expect(result.chunkOverlap).toBe(DEFAULT_CHUNK_OVERLAP);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes empty and whitespace input differently", () => {
    expect(chunker.chunkText("").contentHash).not.toBe(
      chunker.chunkText("   ").contentHash
    );
  });
});

// ---------------------------------------------------------------------------
// Short documents
// ---------------------------------------------------------------------------

describe("short documents", () => {
  it("emits a single chunk holding the whole document", () => {
    const text = "A very short note.";
    const result = chunker.chunkText(text);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.content).toBe(text);
    expect(result.chunks[0]!.startOffset).toBe(0);
    expect(result.chunks[0]!.endOffset).toBe(text.length);
    expect(result.chunks[0]!.boundary).toBe("document-end");
    expect(result.chunks[0]!.overlapWithPrevious).toBe(0);
    assertCoreInvariants(text, result);
  });

  it("handles a single character", () => {
    const result = chunker.chunkText("x");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.content).toBe("x");
    expect(result.chunks[0]!.wordCount).toBe(1);
  });

  it("handles text exactly one character under the chunk size", () => {
    const text = "a".repeat(99);
    const result = chunker.chunkText(text, {}, { chunkSize: 100, chunkOverlap: 0 });
    expect(result.chunks).toHaveLength(1);
    assertCoreInvariants(text, result);
  });

  it("handles text exactly at the chunk size", () => {
    const text = "a".repeat(100);
    const result = chunker.chunkText(text, {}, { chunkSize: 100, chunkOverlap: 0 });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.content).toBe(text);
    assertCoreInvariants(text, result);
  });
});

// ---------------------------------------------------------------------------
// Normal splitting
// ---------------------------------------------------------------------------

describe("normal splitting", () => {
  it("splits long prose into several chunks that satisfy every invariant", () => {
    const text = prose(200);
    const result = chunker.chunkText(text, {}, { chunkSize: 400, chunkOverlap: 50 });

    expect(result.chunkCount).toBeGreaterThan(5);
    assertCoreInvariants(text, result);
  });

  it("never exceeds the configured chunk size", () => {
    const text = prose(120);
    const result = chunker.chunkText(text, {}, { chunkSize: 300, chunkOverlap: 40 });

    for (const chunk of result.chunks) {
      expect(chunk.charCount).toBeLessThanOrEqual(300);
    }
  });

  it("starts at offset 0 and ends at the last character", () => {
    const text = prose(60);
    const result = chunker.chunkText(text, {}, { chunkSize: 250, chunkOverlap: 25 });

    expect(result.chunks[0]!.startOffset).toBe(0);
    expect(result.chunks[result.chunks.length - 1]!.endOffset).toBe(text.length);
  });

  it("reconstructs the document when overlap is removed", () => {
    const text = prose(80);
    const result = chunker.chunkText(text, {}, { chunkSize: 300, chunkOverlap: 60 });

    let rebuilt = "";
    let covered = 0;
    for (const chunk of result.chunks) {
      rebuilt += text.slice(Math.max(chunk.startOffset, covered), chunk.endOffset);
      covered = Math.max(covered, chunk.endOffset);
    }
    expect(rebuilt).toBe(text);
  });

  it("counts words per chunk", () => {
    const text = prose(40);
    const result = chunker.chunkText(text, {}, { chunkSize: 300, chunkOverlap: 0 });

    for (const chunk of result.chunks) {
      expect(chunk.wordCount).toBe(chunk.content.trim().split(/\s+/).length);
    }
  });
});

// ---------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------

describe("overlap", () => {
  it("produces contiguous, non-overlapping chunks when overlap is 0", () => {
    const text = prose(50);
    const result = chunker.chunkText(text, {}, { chunkSize: 200, chunkOverlap: 0 });

    for (let i = 1; i < result.chunks.length; i++) {
      expect(result.chunks[i]!.startOffset).toBe(result.chunks[i - 1]!.endOffset);
      expect(result.chunks[i]!.overlapWithPrevious).toBe(0);
    }
  });

  it("repeats exactly the requested number of characters", () => {
    const text = prose(50);
    const overlap = 40;
    const result = chunker.chunkText(text, {}, { chunkSize: 200, chunkOverlap: overlap });

    // Every chunk except the last leads into a neighbour offset by `overlap`.
    for (let i = 1; i < result.chunks.length; i++) {
      const previous = result.chunks[i - 1]!;
      const current = result.chunks[i]!;
      expect(current.startOffset).toBe(previous.endOffset - overlap);
      expect(current.overlapWithPrevious).toBe(overlap);
    }
  });

  it("shares real text between neighbours", () => {
    const text = prose(30);
    const result = chunker.chunkText(text, {}, { chunkSize: 200, chunkOverlap: 50 });

    for (let i = 1; i < result.chunks.length; i++) {
      const previous = result.chunks[i - 1]!;
      const current = result.chunks[i]!;
      const tail = previous.content.slice(-50);
      expect(current.content.startsWith(tail)).toBe(true);
    }
  });

  it("reports zero overlap for the first chunk", () => {
    const result = chunker.chunkText(prose(30), {}, { chunkSize: 200, chunkOverlap: 60 });
    expect(result.chunks[0]!.overlapWithPrevious).toBe(0);
  });

  it("terminates with an overlap just below the chunk size", () => {
    // The pathological case: a large overlap could otherwise place the next
    // start at or before the current one and spin forever.
    const text = prose(20);
    const result = chunker.chunkText(text, {}, { chunkSize: 100, chunkOverlap: 99 });

    expect(result.chunkCount).toBeGreaterThan(0);
    assertCoreInvariants(text, result);
  });

  it("still advances when the overlap exceeds the minimum fill floor", () => {
    const text = prose(15);
    const result = chunker.chunkText(text, {}, { chunkSize: 80, chunkOverlap: 70 });

    for (let i = 1; i < result.chunks.length; i++) {
      expect(result.chunks[i]!.startOffset).toBeGreaterThan(
        result.chunks[i - 1]!.startOffset
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Boundary selection
// ---------------------------------------------------------------------------

describe("boundary selection", () => {
  it("prefers a paragraph break", () => {
    const text = "First para here.\n\nSecond paragraph continues well past the window.";
    const result = chunker.chunkText(text, {}, { chunkSize: 30, chunkOverlap: 0 });

    expect(result.chunks[0]!.boundary).toBe("paragraph");
    expect(result.chunks[0]!.content).toBe("First para here.\n\n");
  });

  it("falls back to a line break when no paragraph break is in range", () => {
    const text = "alpha beta gamma\ndelta epsilon zeta eta theta iota kappa lambda";
    const result = chunker.chunkText(text, {}, { chunkSize: 24, chunkOverlap: 0 });

    expect(result.chunks[0]!.boundary).toBe("line");
    expect(result.chunks[0]!.content).toBe("alpha beta gamma\n");
  });

  it("falls back to a sentence end when there is no newline", () => {
    const text = "abc. def. ghi. jkl.";
    const result = chunker.chunkText(text, {}, { chunkSize: 12, chunkOverlap: 0 });

    expect(result.chunks[0]!.boundary).toBe("sentence");
    expect(result.chunks[0]!.content).toBe("abc. def. ");
  });

  it("treats a closing quote after the terminator as part of the sentence", () => {
    const text = 'He said "stop." Then everyone left the building quietly today.';
    const result = chunker.chunkText(text, {}, { chunkSize: 20, chunkOverlap: 0 });

    expect(result.chunks[0]!.boundary).toBe("sentence");
    expect(result.chunks[0]!.content).toBe('He said "stop." ');
  });

  it("falls back to a word boundary with no punctuation", () => {
    const text = "aaaa bbbb cccc dddd";
    const result = chunker.chunkText(text, {}, { chunkSize: 12, chunkOverlap: 0 });

    expect(result.chunks[0]!.boundary).toBe("word");
    expect(result.chunks[0]!.content).toBe("aaaa bbbb ");
  });

  it("cuts hard through an unbroken token", () => {
    const text = "a".repeat(50);
    const result = chunker.chunkText(text, {}, { chunkSize: 10, chunkOverlap: 0 });

    expect(result.chunks[0]!.boundary).toBe("hard");
    expect(result.chunks[0]!.content).toBe("a".repeat(10));
    expect(result.chunkCount).toBe(5);
  });

  it("does not pull a boundary back past the minimum fill floor", () => {
    // The only space sits at offset 2, well below half of chunkSize, so
    // snapping to it would emit a 3-character chunk.
    const text = `ab ${"c".repeat(200)}`;
    const result = chunker.chunkText(text, {}, { chunkSize: 100, chunkOverlap: 0 });

    expect(result.chunks[0]!.charCount).toBeGreaterThanOrEqual(50);
    expect(result.chunks[0]!.boundary).toBe("hard");
  });

  it("marks the final chunk as document-end", () => {
    const result = chunker.chunkText(prose(20), {}, { chunkSize: 200, chunkOverlap: 0 });
    expect(result.chunks[result.chunks.length - 1]!.boundary).toBe("document-end");
  });

  it("exposes findChunkEnd for direct inspection", () => {
    const text = "one two three four five six seven eight nine ten";
    expect(findChunkEnd(text, 0, 1000, 0)).toEqual({
      end: text.length,
      kind: "document-end",
    });
  });
});

// ---------------------------------------------------------------------------
// Very long documents
// ---------------------------------------------------------------------------

describe("very long documents", () => {
  it("chunks a large document without gaps or overruns", () => {
    const text = prose(4000);
    expect(text.length).toBeGreaterThan(200_000);

    const result = chunker.chunkText(text, {}, { chunkSize: 1000, chunkOverlap: 100 });

    expect(result.chunkCount).toBeGreaterThan(200);
    assertCoreInvariants(text, result);
  });

  it("terminates on a very long document with no separators at all", () => {
    const text = "x".repeat(60_000);
    const result = chunker.chunkText(text, {}, { chunkSize: 500, chunkOverlap: 100 });

    expect(result.chunkCount).toBeGreaterThan(100);
    expect(result.chunks.every((c) => c.boundary !== "word")).toBe(true);
    assertCoreInvariants(text, result);
  });

  it("handles a document that is one enormous word", () => {
    const text = "z".repeat(10_000);
    const result = chunker.chunkText(text, {}, { chunkSize: 1000, chunkOverlap: 0 });

    expect(result.chunkCount).toBe(10);
    assertCoreInvariants(text, result);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("produces deeply equal results across runs", () => {
    const text = prose(100);
    const a = chunker.chunkText(text, {}, { chunkSize: 300, chunkOverlap: 50 });
    const b = chunker.chunkText(text, {}, { chunkSize: 300, chunkOverlap: 50 });

    expect(a).toEqual(b);
  });

  it("produces identical ids from separate service instances", () => {
    const text = prose(40);
    const a = new DocumentChunkingService({ chunkSize: 250, chunkOverlap: 25 });
    const b = new DocumentChunkingService({ chunkSize: 250, chunkOverlap: 25 });

    expect(a.chunkText(text).chunks.map((c) => c.id)).toEqual(
      b.chunkText(text).chunks.map((c) => c.id)
    );
  });

  it("gives every chunk in a document a distinct id", () => {
    const result = chunker.chunkText(prose(120), {}, { chunkSize: 200, chunkOverlap: 20 });
    const ids = new Set(result.chunks.map((c) => c.id));
    expect(ids.size).toBe(result.chunkCount);
  });

  it("changes ids when the chunk size changes", () => {
    const text = prose(60);
    const a = chunker.chunkText(text, {}, { chunkSize: 300, chunkOverlap: 0 });
    const b = chunker.chunkText(text, {}, { chunkSize: 400, chunkOverlap: 0 });

    expect(a.chunks[0]!.id).not.toBe(b.chunks[0]!.id);
  });

  it("changes ids when the overlap changes", () => {
    const text = prose(60);
    const a = chunker.chunkText(text, {}, { chunkSize: 300, chunkOverlap: 0 });
    const b = chunker.chunkText(text, {}, { chunkSize: 300, chunkOverlap: 50 });

    // Same first span, but the options differ, so the ids must too.
    expect(a.chunks[0]!.startOffset).toBe(b.chunks[0]!.startOffset);
    expect(a.chunks[0]!.id).not.toBe(b.chunks[0]!.id);
  });

  it("changes ids when the document content changes", () => {
    const a = chunker.chunkText("The first document body.", {}, { chunkSize: 100 });
    const b = chunker.chunkText("The second document body.", {}, { chunkSize: 100 });

    expect(a.chunks[0]!.id).not.toBe(b.chunks[0]!.id);
  });

  it("derives ids as 32 hex characters", () => {
    const result = chunker.chunkText(prose(10));
    for (const chunk of result.chunks) {
      expect(chunk.id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("keeps deriveChunkId a pure function of its inputs", () => {
    const options = { chunkSize: 100, chunkOverlap: 10, minChunkSize: 0 };
    const first = deriveChunkId("hash", options, 0, 0, 100);
    const second = deriveChunkId("hash", options, 0, 0, 100);
    const shifted = deriveChunkId("hash", options, 1, 0, 100);

    expect(first).toBe(second);
    expect(first).not.toBe(shifted);
  });

  it("ties the result hash to the exact text", () => {
    expect(chunker.chunkText("alpha").contentHash).not.toBe(
      chunker.chunkText("alphb").contentHash
    );
  });
});

// ---------------------------------------------------------------------------
// minChunkSize merging
// ---------------------------------------------------------------------------

describe("minChunkSize", () => {
  it("leaves a small tail alone by default", () => {
    const text = `${"a".repeat(100)} tail`;
    const result = chunker.chunkText(text, {}, { chunkSize: 100, chunkOverlap: 0 });

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks[result.chunks.length - 1]!.content.trim()).toBe("tail");
  });

  it("merges a tail shorter than minChunkSize into the previous chunk", () => {
    const text = `${"a".repeat(100)} tail`;
    const merged = chunker.chunkText(
      text,
      {},
      { chunkSize: 100, chunkOverlap: 0, minChunkSize: 20 }
    );

    expect(merged.chunkCount).toBe(1);
    expect(merged.chunks[0]!.endOffset).toBe(text.length);
    assertCoreInvariants(text, merged);
  });

  it("never merges away the only chunk", () => {
    const text = "tiny";
    const result = chunker.chunkText(
      text,
      {},
      { chunkSize: 100, chunkOverlap: 0, minChunkSize: 500 }
    );

    expect(result.chunkCount).toBe(1);
    expect(result.chunks[0]!.content).toBe(text);
  });

  it("leaves a tail at or above the threshold in place", () => {
    const text = `${"a".repeat(100)} abcdefghij`;
    const result = chunker.chunkText(
      text,
      {},
      { chunkSize: 100, chunkOverlap: 0, minChunkSize: 10 }
    );

    expect(result.chunkCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("metadata", () => {
  const pages: ExtractedPage[] = [
    { pageNumber: 1, charCount: 100, startOffset: 0, endOffset: 100 },
    { pageNumber: 2, charCount: 100, startOffset: 100, endOffset: 200 },
    { pageNumber: 3, charCount: 100, startOffset: 200, endOffset: 300 },
  ];

  const sections: ExtractedSection[] = [
    { title: "Intro", level: 1, order: 0, startOffset: 0, endOffset: 120 },
    { title: "Body", level: 2, order: 1, startOffset: 120, endOffset: 260 },
    { title: "Outro", level: 2, order: 2, startOffset: 260, endOffset: 300 },
  ];

  it("carries source provenance onto every chunk", () => {
    const text = prose(30);
    const result = chunker.chunkText(
      text,
      {
        documentTitle: "Quarterly Report",
        fileName: "q3.pdf",
        format: "PDF",
        mimeType: "application/pdf",
        source: "upload-42",
        contentHash: "b".repeat(64),
        extractionVersion: "3.2.0",
      },
      { chunkSize: 200, chunkOverlap: 0 }
    );

    for (const chunk of result.chunks) {
      expect(chunk.metadata.documentTitle).toBe("Quarterly Report");
      expect(chunk.metadata.fileName).toBe("q3.pdf");
      expect(chunk.metadata.format).toBe("PDF");
      expect(chunk.metadata.mimeType).toBe("application/pdf");
      expect(chunk.metadata.source).toBe("upload-42");
      expect(chunk.metadata.contentHash).toBe("b".repeat(64));
      expect(chunk.metadata.extractionVersion).toBe("3.2.0");
    }
  });

  it("omits provenance the document never declared", () => {
    const result = chunker.chunkText("Some text with no context supplied.");
    const metadata = result.chunks[0]!.metadata;

    expect(metadata).not.toHaveProperty("fileName");
    expect(metadata).not.toHaveProperty("source");
    expect(metadata.pageNumbers).toEqual([]);
    expect(metadata.sections).toEqual([]);
  });

  it("maps a chunk onto every page it spans", () => {
    expect(locatePages({ pages }, 0, 100)).toEqual([1]);
    expect(locatePages({ pages }, 50, 150)).toEqual([1, 2]);
    expect(locatePages({ pages }, 0, 300)).toEqual([1, 2, 3]);
    expect(locatePages({ pages }, 100, 200)).toEqual([2]);
  });

  it("includes a page whose text normalized away", () => {
    const withEmpty: ExtractedPage[] = [
      { pageNumber: 1, charCount: 50, startOffset: 0, endOffset: 50 },
      { pageNumber: 2, charCount: 0, startOffset: 50, endOffset: 50 },
      { pageNumber: 3, charCount: 50, startOffset: 50, endOffset: 100 },
    ];
    expect(locatePages({ pages: withEmpty }, 0, 100)).toEqual([1, 2, 3]);
    // The empty page sits at offset 50, outside a chunk ending there.
    expect(locatePages({ pages: withEmpty }, 0, 50)).toEqual([1]);
  });

  it("maps a chunk onto every section it spans, in document order", () => {
    expect(locateSectionRefs({ sections }, 0, 100).map((s) => s.title)).toEqual([
      "Intro",
    ]);
    expect(locateSectionRefs({ sections }, 100, 200).map((s) => s.title)).toEqual([
      "Intro",
      "Body",
    ]);
    expect(locateSectionRefs({ sections }, 0, 300).map((s) => s.order)).toEqual([
      0, 1, 2,
    ]);
  });

  it("attributes a chunk to the section it starts in", () => {
    expect(findPrimarySection({ sections }, 0)?.title).toBe("Intro");
    expect(findPrimarySection({ sections }, 119)?.title).toBe("Intro");
    expect(findPrimarySection({ sections }, 120)?.title).toBe("Body");
    // Starts in Body and spills into Outro — still attributed to Body.
    expect(findPrimarySection({ sections }, 250)?.title).toBe("Body");
  });

  it("returns no primary section for an unstructured document", () => {
    expect(findPrimarySection({}, 0)).toBeUndefined();
    expect(findPrimarySection({ sections: [] }, 0)).toBeUndefined();
  });

  it("attaches page and section metadata through the chunker", () => {
    const text = "x".repeat(300);
    const result = chunker.chunkText(
      text,
      { pages, sections },
      { chunkSize: 150, chunkOverlap: 0 }
    );

    expect(result.chunkCount).toBe(2);
    expect(result.chunks[0]!.metadata.pageNumbers).toEqual([1, 2]);
    expect(result.chunks[0]!.metadata.primarySection?.title).toBe("Intro");
    expect(result.chunks[1]!.metadata.pageNumbers).toEqual([2, 3]);
    expect(result.chunks[1]!.metadata.primarySection?.title).toBe("Body");
  });
});

// ---------------------------------------------------------------------------
// chunkDocument — extraction result integration
// ---------------------------------------------------------------------------

describe("chunkDocument", () => {
  it("carries extraction identity through without restating it", () => {
    const text = prose(40);
    const extraction = makeExtractionResult({
      text,
      charCount: text.length,
      contentHash: "c".repeat(64),
      pages: [
        { pageNumber: 1, charCount: text.length, startOffset: 0, endOffset: text.length },
      ],
      sections: [
        { title: "Overview", level: 1, order: 0, startOffset: 0, endOffset: text.length },
      ],
    });

    const result = chunker.chunkDocument(extraction, {
      chunkSize: 200,
      chunkOverlap: 20,
      source: "upload-7",
    });

    expect(result.contentHash).toBe("c".repeat(64));
    assertCoreInvariants(text, result);

    for (const chunk of result.chunks) {
      expect(chunk.metadata.documentTitle).toBe("Handbook");
      expect(chunk.metadata.fileName).toBe("handbook.md");
      expect(chunk.metadata.format).toBe("MD");
      expect(chunk.metadata.source).toBe("upload-7");
      expect(chunk.metadata.extractionVersion).toBe("3.2.0");
      expect(chunk.metadata.pageNumbers).toEqual([1]);
      expect(chunk.metadata.primarySection?.title).toBe("Overview");
    }
  });

  it("uses the extraction content hash so ids track the document", () => {
    const text = prose(20);
    const a = chunker.chunkDocument(
      makeExtractionResult({ text, contentHash: "d".repeat(64) }),
      { chunkSize: 200 }
    );
    const b = chunker.chunkDocument(
      makeExtractionResult({ text, contentHash: "e".repeat(64) }),
      { chunkSize: 200 }
    );

    expect(a.chunks[0]!.id).not.toBe(b.chunks[0]!.id);
  });

  it("omits source when the caller supplies none", () => {
    const result = chunker.chunkDocument(makeExtractionResult({ text: "Body text." }));
    expect(result.chunks[0]!.metadata).not.toHaveProperty("source");
  });
});

// ---------------------------------------------------------------------------
// Repository mapper
// ---------------------------------------------------------------------------

describe("toKnowledgeChunkInputs", () => {
  it("maps chunks onto the Sprint 3.1 createChunks shape", () => {
    const text = prose(30);
    const result = chunker.chunkText(
      text,
      { fileName: "notes.md" },
      { chunkSize: 200, chunkOverlap: 20 }
    );
    const inputs = toKnowledgeChunkInputs(result);

    expect(inputs).toHaveLength(result.chunkCount);
    inputs.forEach((input, i) => {
      expect(input.chunkIndex).toBe(i);
      expect(input.content).toBe(result.chunks[i]!.content);
      expect(input.metadata.chunkId).toBe(result.chunks[i]!.id);
      expect(input.metadata.startOffset).toBe(result.chunks[i]!.startOffset);
      expect(input.metadata.chunkSize).toBe(200);
      expect(input.metadata.chunkOverlap).toBe(20);
      expect(input.metadata.fileName).toBe("notes.md");
    });
  });

  it("maps an empty result to an empty array", () => {
    expect(toKnowledgeChunkInputs(chunker.chunkText(""))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Low-level span computation
// ---------------------------------------------------------------------------

describe("computeChunkSpans", () => {
  it("returns nothing for empty text", () => {
    expect(computeChunkSpans("", { chunkSize: 10, chunkOverlap: 0, minChunkSize: 0 })).toEqual(
      []
    );
  });

  it("always advances, even at maximum overlap", () => {
    const spans = computeChunkSpans("a".repeat(1000), {
      chunkSize: 50,
      chunkOverlap: 49,
      minChunkSize: 0,
    });

    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.startOffset).toBeGreaterThan(spans[i - 1]!.startOffset);
    }
    expect(spans[spans.length - 1]!.endOffset).toBe(1000);
  });
});
