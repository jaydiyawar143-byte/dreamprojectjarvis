import { JarvisError } from "@jarvis/core";
import type { ParsedBlock, ParsedDocument } from "./types.js";

/**
 * PDF text extraction.
 *
 * The parsing library sits behind {@link PdfParseBackend} so the service can be
 * tested against deterministic fakes, and so a future library swap does not
 * reach into the extraction pipeline. The default backend is loaded lazily —
 * `pdf-parse` pulls in `pdfjs-dist`, which is far too heavy to import for a
 * process that only ever handles `.txt` files.
 */

export interface PdfTextPage {
  num: number;
  text: string;
}

export interface PdfParseOutput {
  pages: PdfTextPage[];
  total: number;
  /** The PDF `Info` dictionary, as reported by the backend. */
  info?: Record<string, unknown>;
}

export interface PdfParseBackend {
  /**
   * Must not retain or detach `data` — the caller still owns those bytes and
   * reads them again after extraction. An implementation wrapping a library
   * that transfers ownership has to copy first.
   */
  parse(data: Uint8Array): Promise<PdfParseOutput>;
}

/**
 * Errors the backend raises for structurally broken files. `pdfjs` reports
 * these as named exception classes rather than typed codes, so the name is what
 * we can match on.
 */
const CORRUPTION_ERROR_NAMES = new Set([
  "InvalidPDFException",
  "MissingPDFException",
  "UnexpectedResponseException",
]);

const CORRUPTION_MESSAGE_PATTERNS = [
  /invalid pdf/i,
  /corrupt/i,
  /malformed/i,
  /unexpected end of file/i,
  /xref/i,
];

const PASSWORD_ERROR_NAMES = new Set(["PasswordException"]);

export function createDefaultPdfBackend(): PdfParseBackend {
  return {
    async parse(data: Uint8Array): Promise<PdfParseOutput> {
      const { PDFParse } = await import("pdf-parse");
      // pdfjs transfers the typed array to its worker thread, which detaches
      // the caller's buffer and leaves it zero-length. Extraction must not
      // consume the bytes it was handed, so the worker gets a copy.
      const parser = new PDFParse({ data: new Uint8Array(data) });
      try {
        // An empty pageJoiner suppresses the library's "-- 1 of 3 --" page
        // banners; page boundaries are recorded as offsets instead of being
        // spliced into the text.
        const result = await parser.getText({ pageJoiner: "" });
        const info = await parser.getInfo();
        return {
          pages: result.pages.map((p) => ({ num: p.num, text: p.text })),
          total: result.total,
          info: (info.info ?? undefined) as Record<string, unknown> | undefined,
        };
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    },
  };
}

/**
 * Converts a PDF date string (`D:YYYYMMDDHHmmSS`, optionally with a `Z` or
 * `+HH'mm'` suffix) to ISO-8601.
 *
 * A value with no timezone is read as UTC rather than local time: extraction
 * must produce the same output on every machine that runs it.
 */
export function parsePdfDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const match =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(
      value.trim()
    );
  if (match === null) return undefined;

  const [, year, month, day, hour, minute, second, , sign, offsetHour, offsetMinute] =
    match;

  const y = Number(year);
  const mo = Number(month ?? "01");
  const d = Number(day ?? "01");
  const h = Number(hour ?? "00");
  const mi = Number(minute ?? "00");
  const s = Number(second ?? "00");

  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
    return undefined;
  }

  let timestamp = Date.UTC(y, mo - 1, d, h, mi, s);
  if (sign !== undefined && offsetHour !== undefined) {
    const offsetMs =
      (Number(offsetHour) * 60 + Number(offsetMinute ?? "00")) * 60_000;
    timestamp += sign === "+" ? -offsetMs : offsetMs;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function readString(info: Record<string, unknown> | undefined, key: string) {
  const value = info?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function classifyPdfError(error: unknown, fileName: string): JarvisError {
  if (error instanceof JarvisError) return error;

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  if (PASSWORD_ERROR_NAMES.has(name) || /password/i.test(message)) {
    return new JarvisError(
      "DOCUMENT_INVALID",
      "PDF is password protected and cannot be read",
      { fileName, format: "PDF" }
    );
  }

  if (
    CORRUPTION_ERROR_NAMES.has(name) ||
    CORRUPTION_MESSAGE_PATTERNS.some((p) => p.test(message))
  ) {
    return new JarvisError(
      "DOCUMENT_CORRUPTED",
      "PDF could not be parsed because the file is damaged or malformed",
      { fileName, format: "PDF" }
    );
  }

  return new JarvisError(
    "DOCUMENT_EXTRACTION_FAILED",
    "PDF text extraction failed",
    { fileName, format: "PDF" }
  );
}

export async function parsePdf(
  content: Uint8Array,
  fileName: string,
  backend: PdfParseBackend
): Promise<ParsedDocument> {
  let output: PdfParseOutput;
  try {
    output = await backend.parse(content);
  } catch (error) {
    throw classifyPdfError(error, fileName);
  }

  if (output === null || output === undefined || !Array.isArray(output.pages)) {
    throw new JarvisError(
      "DOCUMENT_EXTRACTION_FAILED",
      "PDF parser returned an unusable result",
      { fileName, format: "PDF" }
    );
  }

  // Page order is asserted here rather than trusted: offsets are meaningless if
  // pages arrive out of sequence.
  const blocks: ParsedBlock[] = output.pages
    .map((page) => ({
      pageNumber: typeof page.num === "number" ? page.num : 0,
      text: typeof page.text === "string" ? page.text : "",
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber);

  const info = output.info;
  const warnings: string[] = [];
  const pageCount =
    typeof output.total === "number" && output.total > 0
      ? output.total
      : blocks.length;

  if (blocks.length !== pageCount) {
    warnings.push(
      `Extracted ${blocks.length} of ${pageCount} pages; the remainder yielded no text layer`
    );
  }

  return {
    blocks,
    paginated: true,
    metadata: {
      title: readString(info, "Title"),
      author: readString(info, "Author"),
      subject: readString(info, "Subject"),
      keywords: readString(info, "Keywords"),
      creator: readString(info, "Creator"),
      producer: readString(info, "Producer"),
      createdAt: parsePdfDate(info?.["CreationDate"]),
      modifiedAt: parsePdfDate(info?.["ModDate"]),
      pageCount,
      warnings,
    },
  };
}
