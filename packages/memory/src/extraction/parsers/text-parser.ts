import type { SupportedDocumentFormat } from "@jarvis/core";
import { decodeUtf8Strict } from "../document-validator.js";
import type { ParsedDocument } from "./types.js";

/**
 * Plain text and Markdown extraction.
 *
 * Both are already text, so there is nothing to parse — the work is strict
 * UTF-8 decoding, which rejects binary content wearing a `.txt` name. Markdown
 * keeps its source markup: headings are what give the document its structure,
 * and stripping them would discard the section boundaries this sprint is
 * required to preserve. Section offsets are derived later from the normalized
 * text, so no headings are reported here.
 */
export function parseText(
  content: Uint8Array,
  format: SupportedDocumentFormat
): ParsedDocument {
  const text = decodeUtf8Strict(content, format);

  return {
    blocks: [{ pageNumber: 1, text }],
    paginated: false,
    metadata: { warnings: [] },
  };
}
