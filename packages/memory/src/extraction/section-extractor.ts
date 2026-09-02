import type { ExtractedSection } from "@jarvis/core";
import { normalizeInlineText } from "./text-normalizer.js";
import type { ParsedHeading } from "./parsers/types.js";

/**
 * Section derivation over already-normalized text.
 *
 * Sections form a flat sequence in document order: each runs from its own
 * heading to the start of the next heading of any level, or to the end of the
 * document. Ranges therefore never overlap, and nesting is expressed by
 * `level` rather than by containment — which keeps offsets unambiguous for the
 * chunker that will consume them.
 */

const ATX_HEADING = /^(#{1,6})[ \t]+(.*)$/;
const FENCE = /^(?:```|~~~)/;

interface HeadingLocation {
  title: string;
  level: number;
  startOffset: number;
}

/**
 * Scans Markdown for ATX headings (`## Title`).
 *
 * Fenced code blocks are tracked so that a `#` comment inside a shell snippet
 * is not mistaken for a heading. Setext headings (underlined with `===`) are
 * not recognised; ATX is what the corpus this feeds uses, and guessing at
 * underlines would produce sections from ordinary tables and rules.
 */
export function extractMarkdownSections(text: string): ExtractedSection[] {
  if (text.length === 0) return [];

  const locations: HeadingLocation[] = [];
  let offset = 0;
  let inFence = false;

  for (const line of text.split("\n")) {
    if (FENCE.test(line.trim())) {
      inFence = !inFence;
    } else if (!inFence) {
      const match = ATX_HEADING.exec(line);
      if (match !== null) {
        // Trailing '#' characters are a closing sequence, not part of the title.
        const title = normalizeInlineText(match[2].replace(/\s+#+\s*$/, ""));
        if (title.length > 0) {
          locations.push({ title, level: match[1].length, startOffset: offset });
        }
      }
    }
    offset += line.length + 1; // +1 for the newline consumed by split
  }

  return toSections(locations, text.length);
}

/**
 * Locates parser-supplied headings (DOCX) within the normalized text.
 *
 * The search advances a cursor so repeated heading text resolves to successive
 * occurrences in document order. A heading that cannot be found — normalization
 * having altered it beyond an exact match — is skipped rather than guessed at:
 * a section with a wrong offset is worse than a missing one.
 */
export function locateSections(
  text: string,
  headings: readonly ParsedHeading[]
): ExtractedSection[] {
  if (text.length === 0 || headings.length === 0) return [];

  const locations: HeadingLocation[] = [];
  let cursor = 0;

  for (const heading of headings) {
    const title = normalizeInlineText(heading.title);
    if (title.length === 0) continue;

    const found = text.indexOf(title, cursor);
    if (found === -1) continue;

    locations.push({
      title,
      level: clampLevel(heading.level),
      startOffset: found,
    });
    cursor = found + title.length;
  }

  return toSections(locations, text.length);
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(6, Math.max(1, Math.trunc(level)));
}

function toSections(
  locations: readonly HeadingLocation[],
  textLength: number
): ExtractedSection[] {
  return locations.map((location, index) => ({
    title: location.title,
    level: location.level,
    order: index,
    startOffset: location.startOffset,
    endOffset:
      index + 1 < locations.length
        ? locations[index + 1].startOffset
        : textLength,
  }));
}
