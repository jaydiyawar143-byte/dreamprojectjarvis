import { describe, it, expect } from "vitest";
import {
  BLOCK_SEPARATOR,
  countWords,
  normalizeInlineText,
  normalizeText,
} from "../src/extraction/text-normalizer.js";

// Named so the assertions below stay readable: these characters are invisible
// in source, and a reviewer cannot otherwise tell which one a test exercises.
const ch = (cp: number) => String.fromCodePoint(cp);

const BOM = ch(0xfeff);
const LINE_SEPARATOR = ch(0x2028);
const PARAGRAPH_SEPARATOR = ch(0x2029);
const NBSP = ch(0x00a0);
const EM_SPACE = ch(0x2003);
const IDEOGRAPHIC_SPACE = ch(0x3000);
const NARROW_NBSP = ch(0x202f);
const ZERO_WIDTH_SPACE = ch(0x200b);
const ZERO_WIDTH_JOINER = ch(0x200d);
const WORD_JOINER = ch(0x2060);
const RIGHT_TO_LEFT_OVERRIDE = ch(0x202e);
const NUL = ch(0x0000);
const BELL = ch(0x0007);
const COMBINING_ACUTE = ch(0x0301);

describe("normalizeText", () => {
  it("returns an empty string unchanged", () => {
    expect(normalizeText("")).toBe("");
  });

  it("strips a leading byte-order mark", () => {
    expect(normalizeText(`${BOM}Hello`)).toBe("Hello");
  });

  it("removes a byte-order mark appearing mid-document", () => {
    expect(normalizeText(`Hel${BOM}lo`)).toBe("Hello");
  });

  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("folds Unicode line and paragraph separators into newlines", () => {
    expect(normalizeText(`a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`)).toBe("a\nb\nc");
  });

  it("replaces non-breaking and exotic spaces with U+0020", () => {
    expect(
      normalizeText(
        `a${NBSP}b${EM_SPACE}c${IDEOGRAPHIC_SPACE}d${NARROW_NBSP}e`
      )
    ).toBe("a b c d e");
  });

  it("removes zero-width and bidi control characters", () => {
    expect(
      normalizeText(
        `a${ZERO_WIDTH_SPACE}b${ZERO_WIDTH_JOINER}c${WORD_JOINER}d${RIGHT_TO_LEFT_OVERRIDE}e`
      )
    ).toBe("abcde");
  });

  it("removes control characters but keeps tabs and newlines", () => {
    expect(normalizeText(`a${NUL}b${BELL}c\td\ne`)).toBe("abc\td\ne");
  });

  it("applies NFC composition so equivalent encodings converge", () => {
    const decomposed = `cafe${COMBINING_ACUTE}`;
    const composed = "café";
    expect(normalizeText(decomposed)).toBe(normalizeText(composed));
    expect(normalizeText(decomposed)).toBe("café");
  });

  it("strips trailing whitespace from every line", () => {
    expect(normalizeText("a   \nb\t\t\nc")).toBe("a\nb\nc");
  });

  it("collapses runs of three or more newlines to a single blank line", () => {
    expect(normalizeText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("preserves a single blank line between paragraphs", () => {
    expect(normalizeText("a\n\nb")).toBe("a\n\nb");
  });

  it("trims leading and trailing whitespace from the document", () => {
    expect(normalizeText("\n\n  hello  \n\n")).toBe("hello");
  });

  it("collapses whitespace-only input to an empty string", () => {
    expect(normalizeText("  \n\t\r\n  ")).toBe("");
  });

  it("is idempotent", () => {
    const messy = `${BOM}  Line one \r\n\r\n\r\n\r\nLine two${ZERO_WIDTH_SPACE}  \n\n`;
    const once = normalizeText(messy);
    expect(normalizeText(once)).toBe(once);
  });

  it("is deterministic across repeated calls", () => {
    const input = `Some\r\ntext with${ZERO_WIDTH_SPACE}noise\n\n\n\nhere`;
    expect(normalizeText(input)).toBe(normalizeText(input));
  });

  it("produces identical output for the same words from different sources", () => {
    // A PDF text layer commonly emits NBSP where the source had a plain space.
    const fromPdf = `Revenue grew${NBSP}by 12 percent.\r\n`;
    const fromDocx = "Revenue grew by 12 percent.\n\n";
    const fromTxt = `${BOM}Revenue grew by 12 percent.`;
    expect(normalizeText(fromPdf)).toBe(normalizeText(fromDocx));
    expect(normalizeText(fromDocx)).toBe(normalizeText(fromTxt));
  });

  it("leaves the block separator normalized", () => {
    expect(normalizeText(`a${BLOCK_SEPARATOR}b`)).toBe(`a${BLOCK_SEPARATOR}b`);
  });
});

describe("countWords", () => {
  it("returns zero for empty text", () => {
    expect(countWords("")).toBe(0);
  });

  it("returns zero for whitespace-only text", () => {
    expect(countWords("   \n\t ")).toBe(0);
  });

  it("counts whitespace-delimited runs", () => {
    expect(countWords("one two three")).toBe(3);
  });

  it("ignores repeated and mixed whitespace", () => {
    expect(countWords("one   two\n\nthree\tfour")).toBe(4);
  });
});

describe("normalizeInlineText", () => {
  it("collapses internal newlines and runs of spaces", () => {
    expect(normalizeInlineText("Quarterly\n\n  Report ")).toBe("Quarterly Report");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeInlineText("  \n ")).toBe("");
  });
});
