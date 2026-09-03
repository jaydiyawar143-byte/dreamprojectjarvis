import type { ChunkSectionRef, ChunkSourceContext } from "@jarvis/core";

/**
 * Maps a chunk's `[start, end)` character range onto the source document's
 * pages and sections.
 *
 * Both page and section ranges from Sprint 3.2 index into the same normalized
 * text the chunker splits, so this is pure interval intersection — no text is
 * re-parsed and no offsets are re-derived.
 */

interface Range {
  startOffset: number;
  endOffset: number;
}

/**
 * True when a source range overlaps `[chunkStart, chunkEnd)`.
 *
 * Zero-length ranges need their own rule: extraction reports a page whose text
 * normalized away as `startOffset === endOffset`, and a plain
 * `start < otherEnd && end > otherStart` test would silently drop it. Such a
 * range counts as overlapping when its single point falls inside the chunk.
 */
function overlaps(range: Range, chunkStart: number, chunkEnd: number): boolean {
  if (range.startOffset === range.endOffset) {
    return range.startOffset >= chunkStart && range.startOffset < chunkEnd;
  }
  return range.startOffset < chunkEnd && range.endOffset > chunkStart;
}

/** Page numbers the chunk touches, ascending and de-duplicated. */
export function locatePages(
  context: ChunkSourceContext | undefined,
  chunkStart: number,
  chunkEnd: number
): number[] {
  const pages = context?.pages;
  if (!pages || pages.length === 0) return [];

  const hits: number[] = [];
  for (const page of pages) {
    if (overlaps(page, chunkStart, chunkEnd)) hits.push(page.pageNumber);
  }

  // Extraction emits pages in order, but sorting keeps the contract explicit
  // rather than dependent on the producer.
  return [...new Set(hits)].sort((a, b) => a - b);
}

/** Sections the chunk touches, in document order. */
export function locateSectionRefs(
  context: ChunkSourceContext | undefined,
  chunkStart: number,
  chunkEnd: number
): ChunkSectionRef[] {
  const sections = context?.sections;
  if (!sections || sections.length === 0) return [];

  return sections
    .filter((section) => overlaps(section, chunkStart, chunkEnd))
    .sort((a, b) => a.order - b.order)
    .map((section) => ({
      title: section.title,
      level: section.level,
      order: section.order,
    }));
}

/**
 * The section containing the chunk's first character.
 *
 * This is the one a caller should show as "where this chunk came from". It is
 * chosen by containment of `chunkStart` rather than by taking the first
 * overlapping section, so a chunk that begins mid-section and spills into the
 * next is still attributed to the section it actually starts in.
 */
export function findPrimarySection(
  context: ChunkSourceContext | undefined,
  chunkStart: number
): ChunkSectionRef | undefined {
  const sections = context?.sections;
  if (!sections || sections.length === 0) return undefined;

  let best: ChunkSectionRef | undefined;
  let bestOrder = Number.NEGATIVE_INFINITY;

  for (const section of sections) {
    const contains =
      section.startOffset <= chunkStart &&
      (chunkStart < section.endOffset || section.startOffset === section.endOffset);
    if (!contains) continue;

    // Deepest-starting match wins when ranges are adjacent at a boundary.
    if (section.order > bestOrder) {
      bestOrder = section.order;
      best = {
        title: section.title,
        level: section.level,
        order: section.order,
      };
    }
  }

  return best;
}
