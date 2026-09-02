/**
 * Deterministic text normalization shared by every document parser.
 *
 * All parsers funnel their output through {@link normalizeText} so that a PDF,
 * a DOCX and a plain text file containing the same words produce byte-identical
 * text — chunking and embeddings downstream depend on that.
 *
 * The pipeline is fixed and order-sensitive:
 *   1. strip a leading byte-order mark
 *   2. Unicode NFC composition
 *   3. CRLF / lone CR / line & paragraph separators  ->  LF
 *   4. exotic spaces -> U+0020, zero-width and bidi marks removed
 *   5. control characters removed (tab and newline survive)
 *   6. trailing whitespace stripped per line
 *   7. runs of 3+ blank lines collapsed to a single blank line
 *   8. leading/trailing whitespace stripped from the document
 *
 * The result is idempotent: `normalizeText(normalizeText(x)) === normalizeText(x)`.
 */

/** A single codepoint, or an inclusive `[low, high]` range. */
type CodepointSpec = number | readonly [number, number];

/**
 * Builds a character-class regex from explicit codepoints. Written this way so
 * the source stays readable — the alternative is embedding literal control and
 * zero-width characters, which are invisible in a diff and easy to corrupt.
 */
function charClassRegex(specs: readonly CodepointSpec[]): RegExp {
  const body = specs
    .map((spec) =>
      typeof spec === "number"
        ? escapeCodepoint(spec)
        : `${escapeCodepoint(spec[0])}-${escapeCodepoint(spec[1])}`
    )
    .join("");
  return new RegExp(`[${body}]`, "gu");
}

function escapeCodepoint(cp: number): string {
  return `\\u{${cp.toString(16).toUpperCase()}}`;
}

const BOM_CODEPOINT = 0xfeff;
const BOM = String.fromCodePoint(BOM_CODEPOINT);

/** Spaces that render like U+0020 but break exact-match lookups. */
const SPACE_LIKE = charClassRegex([
  0x00a0, // no-break space
  0x1680, // ogham space mark
  [0x2000, 0x200a], // en/em quad through hair space
  0x202f, // narrow no-break space
  0x205f, // medium mathematical space
  0x3000, // ideographic space
]);

/** Zero-width characters and bidi controls: invisible, so dropped outright. */
const ZERO_WIDTH = charClassRegex([
  [0x200b, 0x200f], // zero-width space/joiners, LRM, RLM
  [0x202a, 0x202e], // bidi embedding and override
  0x2060, // word joiner
  [0x2066, 0x2069], // bidi isolates
  BOM_CODEPOINT, // BOM appearing mid-document
]);

/** Unicode line and paragraph separators, folded into ordinary newlines. */
const LINE_SEPARATORS = charClassRegex([0x2028, 0x2029]);

/** C0/C1 controls, except tab (U+0009) and line feed (U+000A). */
const CONTROL_CHARS = charClassRegex([
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
]);

const TRAILING_LINE_WHITESPACE = /[ \t]+$/gm;

const EXCESS_BLANK_LINES = /\n{3,}/g;

export function normalizeText(input: string): string {
  if (input.length === 0) return "";

  let text = input.startsWith(BOM) ? input.slice(BOM.length) : input;

  text = text.normalize("NFC");
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(LINE_SEPARATORS, "\n");
  text = text.replace(SPACE_LIKE, " ");
  text = text.replace(ZERO_WIDTH, "");
  text = text.replace(CONTROL_CHARS, "");
  text = text.replace(TRAILING_LINE_WHITESPACE, "");
  text = text.replace(EXCESS_BLANK_LINES, "\n\n");

  return text.trim();
}

/**
 * Separator inserted between normalized blocks (PDF pages) when assembling a
 * document. Exactly one blank line, which is what {@link normalizeText} would
 * itself have produced, so the joined text stays normalized.
 */
export const BLOCK_SEPARATOR = "\n\n";

/**
 * Word count over normalized text. Whitespace-delimited runs, so it is stable
 * for the same input regardless of source format.
 */
export function countWords(text: string): number {
  if (text.length === 0) return 0;
  const matches = text.match(/\S+/g);
  return matches === null ? 0 : matches.length;
}

/**
 * Collapses whitespace within a single line — used for titles and headings,
 * where internal newlines and runs of spaces carry no meaning.
 */
export function normalizeInlineText(input: string): string {
  return normalizeText(input).replace(/\s+/g, " ").trim();
}
