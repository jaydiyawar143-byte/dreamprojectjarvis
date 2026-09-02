import { describe, it, expect } from "vitest";
import { JarvisError, type DocumentExtractionResult } from "@jarvis/core";
import {
  DocumentExtractionService,
  type DocumentExtractionServiceConfig,
} from "../src/extraction/document-extraction-service.js";
import { toKnowledgeDocumentInput } from "../src/extraction/knowledge-document-mapper.js";
import type { PdfParseBackend } from "../src/extraction/parsers/pdf-parser.js";
import type { DocxParseBackend } from "../src/extraction/parsers/docx-parser.js";
import { buildDocx, buildPdf, utf8 } from "./document-fixtures.js";

function createService(config: DocumentExtractionServiceConfig = {}) {
  return new DocumentExtractionService(config);
}

/** Asserts a rejected promise carries a JarvisError with the expected code. */
async function expectRejection(
  promise: Promise<unknown>,
  code: string
): Promise<JarvisError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(JarvisError);
    const jarvisError = error as JarvisError;
    expect(jarvisError.code).toBe(code);
    return jarvisError;
  }
  throw new Error(`Expected a JarvisError with code ${code}, but the promise resolved`);
}

/** Every page range must address exactly the text it claims. */
function expectOffsetsConsistent(result: DocumentExtractionResult): void {
  for (const page of result.pages) {
    expect(page.endOffset).toBeGreaterThanOrEqual(page.startOffset);
    expect(page.endOffset).toBeLessThanOrEqual(result.text.length);
    expect(result.text.slice(page.startOffset, page.endOffset).length).toBe(
      page.charCount
    );
  }
  for (const section of result.sections) {
    expect(section.endOffset).toBeGreaterThan(section.startOffset);
    expect(section.endOffset).toBeLessThanOrEqual(result.text.length);
    expect(result.text.slice(section.startOffset)).toContain(section.title);
  }
}

// ---------------------------------------------------------------------------
// TXT
// ---------------------------------------------------------------------------

describe("DocumentExtractionService — TXT", () => {
  it("extracts plain text", async () => {
    const result = await createService().extract({
      fileName: "notes.txt",
      content: utf8("Hello world.\nSecond line."),
    });

    expect(result.format).toBe("TXT");
    expect(result.mimeType).toBe("text/plain");
    expect(result.text).toBe("Hello world.\nSecond line.");
    expect(result.charCount).toBe(25);
    expect(result.wordCount).toBe(4);
  });

  it("normalizes CRLF, BOM and excess blank lines", async () => {
    const bom = String.fromCodePoint(0xfeff);
    const result = await createService().extract({
      fileName: "notes.txt",
      content: utf8(`${bom}Line one\r\n\r\n\r\n\r\nLine two   \r\n`),
    });

    expect(result.text).toBe("Line one\n\nLine two");
  });

  it("reports no pages for a non-paginated format", async () => {
    const result = await createService().extract({
      fileName: "notes.txt",
      content: utf8("body"),
    });

    expect(result.pages).toEqual([]);
    expect(result.sections).toEqual([]);
    expect(result.metadata.pageCount).toBeUndefined();
  });

  it("derives the title from the first line", async () => {
    const result = await createService().extract({
      fileName: "notes.txt",
      content: utf8("Weekly Standup\n\nAttendees: everyone"),
    });

    expect(result.title).toBe("Weekly Standup");
  });

  it("falls back to the file name when the first line is too long", async () => {
    const result = await createService().extract({
      fileName: "meeting-notes.txt",
      content: utf8("x".repeat(200)),
    });

    expect(result.title).toBe("meeting-notes");
  });

  it("records the byte size of the original file", async () => {
    const content = utf8("héllo");
    const result = await createService().extract({ fileName: "n.txt", content });

    expect(result.byteSize).toBe(content.length);
    expect(result.byteSize).toBeGreaterThan(result.charCount);
  });

  it("rejects a file whose text normalizes to nothing", async () => {
    await expectRejection(
      createService().extract({ fileName: "blank.txt", content: utf8("   \n\n\t  \n") }),
      "DOCUMENT_EMPTY"
    );
  });

  it("rejects invalid UTF-8", async () => {
    await expectRejection(
      createService().extract({
        fileName: "binary.txt",
        content: new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
      }),
      "DOCUMENT_INVALID"
    );
  });
});

// ---------------------------------------------------------------------------
// MD
// ---------------------------------------------------------------------------

describe("DocumentExtractionService — MD", () => {
  const markdown = [
    "# Playbook",
    "",
    "Intro paragraph.",
    "",
    "## Budget Rules",
    "",
    "Never exceed 25 percent.",
    "",
    "### Exceptions",
    "",
    "Approved by a human.",
    "",
  ].join("\n");

  it("extracts markdown and preserves its markup", async () => {
    const result = await createService().extract({
      fileName: "playbook.md",
      content: utf8(markdown),
    });

    expect(result.format).toBe("MD");
    expect(result.mimeType).toBe("text/markdown");
    expect(result.text).toContain("# Playbook");
    expect(result.text).toContain("## Budget Rules");
  });

  it("accepts the .markdown extension", async () => {
    const result = await createService().extract({
      fileName: "playbook.markdown",
      content: utf8(markdown),
    });

    expect(result.format).toBe("MD");
  });

  it("derives sections from ATX headings", async () => {
    const result = await createService().extract({
      fileName: "playbook.md",
      content: utf8(markdown),
    });

    expect(result.sections.map((s) => [s.title, s.level, s.order])).toEqual([
      ["Playbook", 1, 0],
      ["Budget Rules", 2, 1],
      ["Exceptions", 3, 2],
    ]);
    expectOffsetsConsistent(result);
  });

  it("gives each section a range ending where the next begins", async () => {
    const result = await createService().extract({
      fileName: "playbook.md",
      content: utf8(markdown),
    });

    const [first, second, third] = result.sections;
    expect(first.endOffset).toBe(second.startOffset);
    expect(second.endOffset).toBe(third.startOffset);
    expect(third.endOffset).toBe(result.text.length);
    expect(result.text.slice(first.startOffset, first.endOffset)).toContain(
      "Intro paragraph."
    );
  });

  it("ignores headings inside fenced code blocks", async () => {
    const content = [
      "# Real Heading",
      "",
      "```bash",
      "# not a heading, a shell comment",
      "echo hi",
      "```",
      "",
      "## Second Real Heading",
    ].join("\n");

    const result = await createService().extract({
      fileName: "guide.md",
      content: utf8(content),
    });

    expect(result.sections.map((s) => s.title)).toEqual([
      "Real Heading",
      "Second Real Heading",
    ]);
  });

  it("ignores tilde-fenced code blocks too", async () => {
    const content = ["# Title", "", "~~~", "# fenced comment", "~~~"].join("\n");
    const result = await createService().extract({
      fileName: "guide.md",
      content: utf8(content),
    });

    expect(result.sections.map((s) => s.title)).toEqual(["Title"]);
  });

  it("strips a closing hash sequence from a heading", async () => {
    const result = await createService().extract({
      fileName: "guide.md",
      content: utf8("## Closed Heading ##\n\nbody"),
    });

    expect(result.sections[0].title).toBe("Closed Heading");
  });

  it("does not treat a hash without a space as a heading", async () => {
    const result = await createService().extract({
      fileName: "guide.md",
      content: utf8("#hashtag not a heading\n\nbody"),
    });

    expect(result.sections).toEqual([]);
  });

  it("uses the first heading as the title", async () => {
    const result = await createService().extract({
      fileName: "playbook.md",
      content: utf8(markdown),
    });

    expect(result.title).toBe("Playbook");
  });

  it("handles markdown with no headings", async () => {
    const result = await createService().extract({
      fileName: "plain.md",
      content: utf8("Just a paragraph with no structure."),
    });

    expect(result.sections).toEqual([]);
    expect(result.title).toBe("Just a paragraph with no structure.");
  });
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

describe("DocumentExtractionService — PDF", () => {
  it("extracts text from a single-page PDF", async () => {
    const result = await createService().extract({
      fileName: "report.pdf",
      content: buildPdf(["Hello from page one."]),
    });

    expect(result.format).toBe("PDF");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.text).toBe("Hello from page one.");
  });

  it("joins multiple pages with a single blank line", async () => {
    const result = await createService().extract({
      fileName: "report.pdf",
      content: buildPdf(["Page one text.", "Page two text.", "Page three text."]),
    });

    expect(result.text).toBe("Page one text.\n\nPage two text.\n\nPage three text.");
  });

  it("preserves page metadata with offsets addressing each page", async () => {
    const result = await createService().extract({
      fileName: "report.pdf",
      content: buildPdf(["Alpha page.", "Beta page.", "Gamma page."]),
    });

    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(result.metadata.pageCount).toBe(3);

    expect(result.text.slice(result.pages[0].startOffset, result.pages[0].endOffset)).toBe(
      "Alpha page."
    );
    expect(result.text.slice(result.pages[1].startOffset, result.pages[1].endOffset)).toBe(
      "Beta page."
    );
    expect(result.text.slice(result.pages[2].startOffset, result.pages[2].endOffset)).toBe(
      "Gamma page."
    );
    expectOffsetsConsistent(result);
  });

  it("does not splice page banners into the text", async () => {
    const result = await createService().extract({
      fileName: "report.pdf",
      content: buildPdf(["First.", "Second."]),
    });

    expect(result.text).not.toMatch(/--\s*\d+\s*of\s*\d+\s*--/);
  });

  it("reads document metadata from the Info dictionary", async () => {
    const result = await createService().extract({
      fileName: "report.pdf",
      content: buildPdf(["Body text."], {
        title: "Q3 Marketing Review",
        author: "JARVIS",
        creationDate: "D:20240115103000Z",
      }),
    });

    expect(result.metadata.title).toBe("Q3 Marketing Review");
    expect(result.metadata.author).toBe("JARVIS");
    expect(result.metadata.createdAt).toBe("2024-01-15T10:30:00.000Z");
    expect(result.title).toBe("Q3 Marketing Review");
  });

  it("falls back to the first line when the PDF declares no title", async () => {
    const result = await createService().extract({
      fileName: "untitled-report.pdf",
      content: buildPdf(["Opening line of the report."]),
    });

    expect(result.title).toBe("Opening line of the report.");
  });

  it("reports no sections for a PDF", async () => {
    const result = await createService().extract({
      fileName: "report.pdf",
      content: buildPdf(["Body."]),
    });

    expect(result.sections).toEqual([]);
  });

  it("rejects a corrupted PDF", async () => {
    const truncated = buildPdf(["Body text."]).slice(0, 40);
    const error = await expectRejection(
      createService().extract({ fileName: "broken.pdf", content: truncated }),
      "DOCUMENT_CORRUPTED"
    );
    expect(error.statusCode).toBe(422);
  });

  it("rejects a file with a PDF signature but garbage body", async () => {
    await expectRejection(
      createService().extract({
        fileName: "broken.pdf",
        content: utf8("%PDF-1.4\nthis is not a real pdf body"),
      }),
      "DOCUMENT_CORRUPTED"
    );
  });

  it("rejects a PDF whose pages carry no text layer", async () => {
    const backend: PdfParseBackend = {
      parse: async () => ({ pages: [{ num: 1, text: "   " }], total: 1 }),
    };

    await expectRejection(
      createService({ pdfBackend: backend }).extract({
        fileName: "scan.pdf",
        content: buildPdf(["placeholder"]),
      }),
      "DOCUMENT_EMPTY"
    );
  });

  it("keeps page numbering aligned when a middle page has no text", async () => {
    const backend: PdfParseBackend = {
      parse: async () => ({
        pages: [
          { num: 1, text: "First page." },
          { num: 2, text: "   " },
          { num: 3, text: "Third page." },
        ],
        total: 3,
      }),
    };

    const result = await createService({ pdfBackend: backend }).extract({
      fileName: "scan.pdf",
      content: buildPdf(["placeholder"]),
    });

    expect(result.text).toBe("First page.\n\nThird page.");
    expect(result.pages.map((p) => [p.pageNumber, p.charCount])).toEqual([
      [1, 11],
      [2, 0],
      [3, 11],
    ]);
    expect(result.pages[1].startOffset).toBe(result.pages[1].endOffset);
    expectOffsetsConsistent(result);
  });

  it("sorts pages returned out of order", async () => {
    const backend: PdfParseBackend = {
      parse: async () => ({
        pages: [
          { num: 3, text: "Third." },
          { num: 1, text: "First." },
          { num: 2, text: "Second." },
        ],
        total: 3,
      }),
    };

    const result = await createService({ pdfBackend: backend }).extract({
      fileName: "report.pdf",
      content: buildPdf(["placeholder"]),
    });

    expect(result.text).toBe("First.\n\nSecond.\n\nThird.");
  });

  it("warns when fewer pages yielded text than the document declares", async () => {
    const backend: PdfParseBackend = {
      parse: async () => ({ pages: [{ num: 1, text: "Only page." }], total: 4 }),
    };

    const result = await createService({ pdfBackend: backend }).extract({
      fileName: "report.pdf",
      content: buildPdf(["placeholder"]),
    });

    expect(result.metadata.warnings).toHaveLength(1);
    expect(result.metadata.warnings[0]).toContain("1 of 4");
  });

  it("classifies a password-protected PDF distinctly from corruption", async () => {
    const backend: PdfParseBackend = {
      parse: async () => {
        const error = new Error("No password given");
        error.name = "PasswordException";
        throw error;
      },
    };

    await expectRejection(
      createService({ pdfBackend: backend }).extract({
        fileName: "locked.pdf",
        content: buildPdf(["placeholder"]),
      }),
      "DOCUMENT_INVALID"
    );
  });

  it("classifies an unexpected backend failure as an extraction failure", async () => {
    const backend: PdfParseBackend = {
      parse: async () => {
        throw new Error("worker terminated unexpectedly");
      },
    };

    const error = await expectRejection(
      createService({ pdfBackend: backend }).extract({
        fileName: "report.pdf",
        content: buildPdf(["placeholder"]),
      }),
      "DOCUMENT_EXTRACTION_FAILED"
    );
    expect(error.statusCode).toBe(500);
  });

  it("rejects an unusable backend result", async () => {
    const backend = {
      parse: async () => ({ total: 1 }),
    } as unknown as PdfParseBackend;

    await expectRejection(
      createService({ pdfBackend: backend }).extract({
        fileName: "report.pdf",
        content: buildPdf(["placeholder"]),
      }),
      "DOCUMENT_EXTRACTION_FAILED"
    );
  });

  it("does not leak the underlying parser error message", async () => {
    const backend: PdfParseBackend = {
      parse: async () => {
        throw new Error("D:\\secrets\\internal-path\\worker.js exploded");
      },
    };

    const error = await expectRejection(
      createService({ pdfBackend: backend }).extract({
        fileName: "report.pdf",
        content: buildPdf(["placeholder"]),
      }),
      "DOCUMENT_EXTRACTION_FAILED"
    );
    expect(error.message).not.toContain("secrets");
  });
});

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

describe("DocumentExtractionService — DOCX", () => {
  const paragraphs = [
    { text: "Quarterly Report", style: "Heading1" },
    { text: "Revenue grew by 12 percent." },
    { text: "Risks", style: "Heading2" },
    { text: "Supply chain remains volatile." },
  ];

  it("extracts text from a DOCX", async () => {
    const result = await createService().extract({
      fileName: "report.docx",
      content: buildDocx(paragraphs),
    });

    expect(result.format).toBe("DOCX");
    expect(result.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(result.text).toContain("Revenue grew by 12 percent.");
    expect(result.text).toContain("Supply chain remains volatile.");
  });

  it("preserves heading structure as sections", async () => {
    const result = await createService().extract({
      fileName: "report.docx",
      content: buildDocx(paragraphs),
    });

    expect(result.sections.map((s) => [s.title, s.level, s.order])).toEqual([
      ["Quarterly Report", 1, 0],
      ["Risks", 2, 1],
    ]);
    expectOffsetsConsistent(result);
  });

  it("scopes each section to the text that follows its heading", async () => {
    const result = await createService().extract({
      fileName: "report.docx",
      content: buildDocx(paragraphs),
    });

    const [first, second] = result.sections;
    expect(result.text.slice(first.startOffset, first.endOffset)).toContain(
      "Revenue grew by 12 percent."
    );
    expect(result.text.slice(second.startOffset, second.endOffset)).toContain(
      "Supply chain remains volatile."
    );
    expect(result.text.slice(second.startOffset, second.endOffset)).not.toContain(
      "Revenue grew"
    );
  });

  it("uses the first heading as the title", async () => {
    const result = await createService().extract({
      fileName: "report.docx",
      content: buildDocx(paragraphs),
    });

    expect(result.title).toBe("Quarterly Report");
  });

  it("reports no pages, since a DOCX stores no pagination", async () => {
    const result = await createService().extract({
      fileName: "report.docx",
      content: buildDocx(paragraphs),
    });

    expect(result.pages).toEqual([]);
    expect(result.metadata.pageCount).toBeUndefined();
  });

  it("handles a DOCX with no headings", async () => {
    const result = await createService().extract({
      fileName: "flat.docx",
      content: buildDocx([{ text: "Only body text here." }]),
    });

    expect(result.sections).toEqual([]);
    expect(result.title).toBe("Only body text here.");
  });

  it("resolves repeated heading text to successive occurrences", async () => {
    const result = await createService().extract({
      fileName: "repeat.docx",
      content: buildDocx([
        { text: "Summary", style: "Heading1" },
        { text: "First body." },
        { text: "Summary", style: "Heading1" },
        { text: "Second body." },
      ]),
    });

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].startOffset).toBeLessThan(result.sections[1].startOffset);
    expect(
      result.text.slice(result.sections[0].startOffset, result.sections[0].endOffset)
    ).toContain("First body.");
    expect(
      result.text.slice(result.sections[1].startOffset, result.sections[1].endOffset)
    ).toContain("Second body.");
  });

  it("decodes XML-escaped characters in the body", async () => {
    const result = await createService().extract({
      fileName: "escaped.docx",
      content: buildDocx([{ text: "Profit & loss < 5% > target" }]),
    });

    expect(result.text).toContain("Profit & loss < 5% > target");
  });

  it("rejects a corrupted DOCX", async () => {
    const truncated = buildDocx(paragraphs).slice(0, 60);
    await expectRejection(
      createService().extract({ fileName: "broken.docx", content: truncated }),
      "DOCUMENT_CORRUPTED"
    );
  });

  it("rejects a ZIP that is not an Office package", async () => {
    const backend: DocxParseBackend = {
      parse: async () => {
        throw new Error("Could not find file in package: word/document.xml");
      },
    };

    await expectRejection(
      createService({ docxBackend: backend }).extract({
        fileName: "plain.docx",
        content: buildDocx(paragraphs),
      }),
      "DOCUMENT_CORRUPTED"
    );
  });

  it("surfaces parser warnings without failing", async () => {
    const backend: DocxParseBackend = {
      parse: async () => ({
        text: "Body text.",
        html: "<p>Body text.</p>",
        warnings: ["Unrecognised style: Fancy"],
      }),
    };

    const result = await createService({ docxBackend: backend }).extract({
      fileName: "warn.docx",
      content: buildDocx(paragraphs),
    });

    expect(result.metadata.warnings).toEqual(["Unrecognised style: Fancy"]);
  });

  it("classifies an unexpected backend failure as an extraction failure", async () => {
    const backend: DocxParseBackend = {
      parse: async () => {
        throw new Error("out of memory");
      },
    };

    await expectRejection(
      createService({ docxBackend: backend }).extract({
        fileName: "report.docx",
        content: buildDocx(paragraphs),
      }),
      "DOCUMENT_EXTRACTION_FAILED"
    );
  });

  it("rejects an empty DOCX body", async () => {
    await expectRejection(
      createService().extract({
        fileName: "empty.docx",
        content: buildDocx([{ text: "   " }]),
      }),
      "DOCUMENT_EMPTY"
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("DocumentExtractionService — determinism", () => {
  it("produces a deeply equal result for repeated PDF extraction", async () => {
    const content = buildPdf(["Alpha.", "Beta."], { title: "Fixture" });
    const service = createService();

    const first = await service.extract({ fileName: "r.pdf", content });
    const second = await service.extract({ fileName: "r.pdf", content });

    expect(second).toEqual(first);
  });

  it("produces a deeply equal result for repeated DOCX extraction", async () => {
    const content = buildDocx([
      { text: "Title", style: "Heading1" },
      { text: "Body." },
    ]);
    const service = createService();

    expect(await service.extract({ fileName: "r.docx", content })).toEqual(
      await service.extract({ fileName: "r.docx", content })
    );
  });

  it("produces a stable content hash across service instances", async () => {
    const content = utf8("# Title\n\nBody text.");

    const a = await createService().extract({ fileName: "a.md", content });
    const b = await createService().extract({ fileName: "a.md", content });

    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same hash to the same text arriving in different encodings", async () => {
    const service = createService();
    const bom = String.fromCodePoint(0xfeff);

    const unix = await service.extract({
      fileName: "a.txt",
      content: utf8("Line one\nLine two"),
    });
    const windows = await service.extract({
      fileName: "b.txt",
      content: utf8(`${bom}Line one\r\nLine two\r\n`),
    });

    expect(windows.contentHash).toBe(unix.contentHash);
  });

  it("gives different hashes to different text", async () => {
    const service = createService();

    const a = await service.extract({ fileName: "a.txt", content: utf8("alpha") });
    const b = await service.extract({ fileName: "a.txt", content: utf8("beta") });

    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("leaves the caller's PDF buffer intact", async () => {
    // pdfjs transfers typed arrays to its worker, which detaches the caller's
    // buffer unless the backend copies first. A detached buffer reads as empty,
    // so a second extraction of the same bytes would fail as an empty file.
    const content = buildPdf(["Alpha."]);
    const byteLength = content.length;

    await createService().extract({ fileName: "r.pdf", content });

    expect(content.length).toBe(byteLength);
    expect(content.subarray(0, 5)).toEqual(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
    );
  });

  it("carries no ambient state such as a timestamp", async () => {
    const result = await createService().extract({
      fileName: "a.txt",
      content: utf8("body"),
    });

    expect(JSON.stringify(result)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(result.extractionVersion).toBe("3.2.0");
  });
});

// ---------------------------------------------------------------------------
// Configuration and support probe
// ---------------------------------------------------------------------------

describe("DocumentExtractionService — configuration", () => {
  it("enforces a configured maximum file size", async () => {
    const error = await expectRejection(
      createService({ maxFileSizeBytes: 16 }).extract({
        fileName: "big.txt",
        content: utf8("a".repeat(100)),
      }),
      "DOCUMENT_TOO_LARGE"
    );
    expect(error.details).toMatchObject({ maxFileSizeBytes: 16 });
  });

  it("enforces a configured maximum extracted text length", async () => {
    await expectRejection(
      createService({ maxTextLength: 10 }).extract({
        fileName: "long.txt",
        content: utf8("a".repeat(100)),
      }),
      "DOCUMENT_TOO_LARGE"
    );
  });

  it("never truncates text it accepts", async () => {
    const body = "b".repeat(500);
    const result = await createService({ maxTextLength: 500 }).extract({
      fileName: "exact.txt",
      content: utf8(body),
    });

    expect(result.text).toBe(body);
  });

  it("restricts extraction to the configured formats", async () => {
    await expectRejection(
      createService({ allowedFormats: ["PDF"] }).extract({
        fileName: "notes.txt",
        content: utf8("hello"),
      }),
      "DOCUMENT_UNSUPPORTED_FORMAT"
    );
  });

  it("rejects an invalid configuration at construction", () => {
    expect(() => createService({ maxFileSizeBytes: 0 })).toThrow(JarvisError);
    expect(() => createService({ maxTextLength: -1 })).toThrow(JarvisError);
  });

  it("reports support through the IDocumentExtractor probe", () => {
    const service = createService();

    expect(service.supports("a.pdf")).toBe(true);
    expect(service.supports("a.docx")).toBe(true);
    expect(service.supports("a.txt")).toBe(true);
    expect(service.supports("a.md")).toBe(true);
    expect(service.supports("a.csv")).toBe(false);
    expect(service.supports("a.txt", "application/pdf")).toBe(false);
  });

  it("reflects the allowed format list in the support probe", () => {
    expect(createService({ allowedFormats: ["MD"] }).supports("a.pdf")).toBe(false);
  });

  it("rejects an unsupported format before loading any parser", async () => {
    await expectRejection(
      createService().extract({ fileName: "malware.exe", content: utf8("MZ") }),
      "DOCUMENT_UNSUPPORTED_FORMAT"
    );
  });
});

// ---------------------------------------------------------------------------
// Sprint 3.1 knowledge repository integration
// ---------------------------------------------------------------------------

describe("toKnowledgeDocumentInput", () => {
  it("maps an extraction result onto the Sprint 3.1 createDocument shape", async () => {
    const result = await createService().extract({
      fileName: "playbook.md",
      content: utf8("# Playbook\n\nNever exceed 25 percent."),
    });

    const input = toKnowledgeDocumentInput(result, { source: "upload-123" });

    expect(input.title).toBe("Playbook");
    expect(input.content).toBe(result.text);
    expect(input.documentType).toBe("MD");
    expect(input.mimeType).toBe("text/markdown");
    expect(input.source).toBe("upload-123");
  });

  it("carries structural detail through in metadata", async () => {
    const result = await createService().extract({
      fileName: "report.pdf",
      content: buildPdf(["Page one.", "Page two."]),
    });

    const metadata = toKnowledgeDocumentInput(result).metadata as Record<string, unknown>;

    expect(metadata.fileName).toBe("report.pdf");
    expect(metadata.contentHash).toBe(result.contentHash);
    expect(metadata.extractionVersion).toBe("3.2.0");
    expect(metadata.pageCount).toBe(2);
    expect(metadata.pages).toEqual(result.pages);
    expect(metadata.sections).toEqual(result.sections);
  });

  it("omits source when none is supplied", async () => {
    const result = await createService().extract({
      fileName: "a.txt",
      content: utf8("body"),
    });

    expect("source" in toKnowledgeDocumentInput(result)).toBe(false);
  });

  it("allows the title to be overridden", async () => {
    const result = await createService().extract({
      fileName: "a.txt",
      content: utf8("body"),
    });

    expect(toKnowledgeDocumentInput(result, { title: "Custom" }).title).toBe("Custom");
  });

  it("records a null page count for non-paginated formats", async () => {
    const result = await createService().extract({
      fileName: "a.txt",
      content: utf8("body"),
    });

    const metadata = toKnowledgeDocumentInput(result).metadata as Record<string, unknown>;
    expect(metadata.pageCount).toBeNull();
  });

  it("is deterministic for the same extraction result", async () => {
    const result = await createService().extract({
      fileName: "a.md",
      content: utf8("# T\n\nbody"),
    });

    expect(toKnowledgeDocumentInput(result)).toEqual(toKnowledgeDocumentInput(result));
  });
});
