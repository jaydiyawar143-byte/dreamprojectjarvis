import {
  CHUNK_MIN_FILL_RATIO,
  type ChunkBoundaryKind,
} from "@jarvis/core";

/**
 * Deterministic chunk boundary selection.
 *
 * Given a start offset, the window `[start, start + chunkSize)` is the widest a
 * chunk may be. Rather than cutting blindly at that limit, the end is pulled
 * back to the nearest natural separator — but never further back than
 * `minEnd`, so a document with one awkwardly placed newline cannot produce a
 * run of near-empty chunks.
 *
 * Separator priority is fixed and structural-first:
 *
 *   paragraph ("\n\n")  >  line ("\n")  >  sentence (. ! ?)  >  word (" ")
 *
 * Structure outranks punctuation because normalized text keeps meaningful line
 * breaks (list items, headings), and splitting across one of those loses more
 * than splitting mid-sentence does. When nothing is found the cut is hard, at
 * exactly `start + chunkSize` — which is what makes a 50 000-character line
 * with no spaces terminate instead of hanging.
 *
 * Every function here is pure and index-only; no text is copied.
 */

/** Characters that may follow terminal punctuation and still end a sentence. */
const SENTENCE_CLOSERS = new Set(['"', "'", ")", "]", "}", "»", "”", "’"]);
const SENTENCE_TERMINALS = new Set([".", "!", "?"]);

export interface BoundaryResult {
  /** Exclusive end offset. Always strictly greater than `start`. */
  end: number;
  kind: ChunkBoundaryKind;
}

/**
 * The earliest offset a chunk may end at.
 *
 * Two floors combine:
 *  - a fill floor, so chunks stay reasonably full;
 *  - `start + overlap + 1`, which is what guarantees forward progress. The next
 *    chunk begins at `end - overlap`; without this floor a large overlap could
 *    place it at or before `start` and the loop would never terminate.
 *
 * Both are capped at `limit`, so `minEnd <= limit` always holds. That cap is
 * safe because `chunkOverlap < chunkSize` is validated before chunking starts.
 */
export function computeMinEnd(
  start: number,
  chunkSize: number,
  chunkOverlap: number,
  limit: number
): number {
  const fillFloor = start + Math.ceil(chunkSize * CHUNK_MIN_FILL_RATIO);
  const progressFloor = start + chunkOverlap + 1;
  return Math.min(limit, Math.max(fillFloor, progressFloor));
}

/**
 * Scans backwards for a sentence terminator whose following character is
 * whitespace. Returns the offset just past that whitespace, or -1.
 *
 * Done as an explicit scan rather than a regex because the search runs
 * backwards from a bounded window; a global regex would have to match forward
 * over the whole document on every chunk.
 */
function findSentenceEnd(text: string, minEnd: number, limit: number): number {
  for (let i = limit - 1; i >= minEnd; i--) {
    const ch = text[i];
    if (ch !== " " && ch !== "\n" && ch !== "\t") continue;

    // Walk back over any closing quotes/brackets to reach the punctuation.
    let j = i - 1;
    while (j >= 0 && SENTENCE_CLOSERS.has(text[j]!)) j--;
    if (j < 0) continue;

    if (SENTENCE_TERMINALS.has(text[j]!)) {
      // End just past the whitespace so the next chunk starts on real text.
      return i + 1;
    }
  }
  return -1;
}

/**
 * Chooses where the chunk starting at `start` should end.
 *
 * `limit` is the hard ceiling (`min(start + chunkSize, text.length)`).
 */
export function findChunkEnd(
  text: string,
  start: number,
  chunkSize: number,
  chunkOverlap: number
): BoundaryResult {
  const limit = Math.min(start + chunkSize, text.length);

  // The remaining text fits — take all of it and stop.
  if (limit >= text.length) {
    return { end: text.length, kind: "document-end" };
  }

  const minEnd = computeMinEnd(start, chunkSize, chunkOverlap, limit);

  // Paragraph break. lastIndexOf searches at or before the given index, so
  // `limit - 2` keeps the whole "\n\n" inside the window.
  const paragraph = text.lastIndexOf("\n\n", limit - 2);
  if (paragraph !== -1 && paragraph + 2 >= minEnd && paragraph + 2 <= limit) {
    return { end: paragraph + 2, kind: "paragraph" };
  }

  const line = text.lastIndexOf("\n", limit - 1);
  if (line !== -1 && line + 1 >= minEnd && line + 1 <= limit) {
    return { end: line + 1, kind: "line" };
  }

  const sentence = findSentenceEnd(text, minEnd, limit);
  if (sentence !== -1) {
    return { end: sentence, kind: "sentence" };
  }

  const word = text.lastIndexOf(" ", limit - 1);
  if (word !== -1 && word + 1 >= minEnd && word + 1 <= limit) {
    return { end: word + 1, kind: "word" };
  }

  // No usable separator (e.g. one enormous unbroken token). Cut exactly at the
  // window edge; losing a word boundary beats not terminating.
  return { end: limit, kind: "hard" };
}
