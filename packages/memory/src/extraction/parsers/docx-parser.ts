import { JarvisError } from "@jarvis/core";
import { normalizeInlineText } from "../text-normalizer.js";
import type { ParsedDocument, ParsedHeading } from "./types.js";

/**
 * DOCX text extraction.
 *
 * Two passes over the same buffer: `extractRawText` supplies the authoritative
 * body text, and an HTML conversion supplies the heading structure that raw
 * text discards. Deriving both from the HTML would risk fidelity loss in the
 * body, and deriving neither would lose the document's outline.
 *
 * Known limitation: the OOXML core properties (`docProps/core.xml` — author,
 * created date, and so on) are not read. Doing so needs a ZIP reader the
 * extraction path does not otherwise require, so DOCX metadata is limited to
 * what the body itself provides. The title falls back to the first heading.
 */

export interface DocxParseOutput {
  text: string;
  /** Body rendered as HTML, used only to recover headings. */
  html: string;
  warnings: string[];
}

export interface DocxParseBackend {
  parse(data: Uint8Array): Promise<DocxParseOutput>;
}

const CORRUPTION_MESSAGE_PATTERNS = [
  /corrupt/i,
  /end of central directory/i,
  /invalid signature/i,
  /can't find end of central directory/i,
  /not a valid zip/i,
  /could not find file/i,
  /invalid zip/i,
];

export function createDefaultDocxBackend(): DocxParseBackend {
  return {
    async parse(data: Uint8Array): Promise<DocxParseOutput> {
      const mammoth = (await import("mammoth")).default;
      // mammoth's Node input takes a Buffer; wrap without copying the bytes.
      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);

      const raw = await mammoth.extractRawText({ buffer });
      const html = await mammoth.convertToHtml({ buffer });

      return {
        text: raw.value,
        html: html.value,
        warnings: [...raw.messages, ...html.messages]
          .filter((m) => m.type === "warning" || m.type === "error")
          .map((m) => m.message),
      };
    },
  };
}

const HEADING_TAG = /<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
const HTML_TAG = /<[^>]*>/g;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    return HTML_ENTITIES[key] ?? match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** Pulls `<h1>`-`<h6>` headings out of the converted body, in document order. */
export function extractHeadingsFromHtml(html: string): ParsedHeading[] {
  if (typeof html !== "string" || html.length === 0) return [];

  const headings: ParsedHeading[] = [];
  HEADING_TAG.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = HEADING_TAG.exec(html)) !== null) {
    const level = Number(match[1]);
    const title = normalizeInlineText(
      decodeHtmlEntities(match[2].replace(HTML_TAG, ""))
    );
    if (title.length > 0) headings.push({ title, level });
  }

  return headings;
}

function classifyDocxError(error: unknown, fileName: string): JarvisError {
  if (error instanceof JarvisError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (CORRUPTION_MESSAGE_PATTERNS.some((p) => p.test(message))) {
    return new JarvisError(
      "DOCUMENT_CORRUPTED",
      "DOCX could not be parsed because the file is damaged or is not a valid Office Open XML package",
      { fileName, format: "DOCX" }
    );
  }

  return new JarvisError(
    "DOCUMENT_EXTRACTION_FAILED",
    "DOCX text extraction failed",
    { fileName, format: "DOCX" }
  );
}

export async function parseDocx(
  content: Uint8Array,
  fileName: string,
  backend: DocxParseBackend
): Promise<ParsedDocument> {
  let output: DocxParseOutput;
  try {
    output = await backend.parse(content);
  } catch (error) {
    throw classifyDocxError(error, fileName);
  }

  if (output === null || output === undefined || typeof output.text !== "string") {
    throw new JarvisError(
      "DOCUMENT_EXTRACTION_FAILED",
      "DOCX parser returned an unusable result",
      { fileName, format: "DOCX" }
    );
  }

  const headings = extractHeadingsFromHtml(output.html ?? "");

  return {
    blocks: [{ pageNumber: 1, text: output.text }],
    paginated: false,
    headings,
    metadata: {
      // DOCX carries no page count: pagination is a rendering decision made by
      // the word processor, not a property of the stored document.
      title: headings.length > 0 ? headings[0].title : undefined,
      warnings: Array.isArray(output.warnings) ? [...output.warnings] : [],
    },
  };
}
