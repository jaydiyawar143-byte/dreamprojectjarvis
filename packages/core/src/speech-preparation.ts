// ---------------------------------------------------------------------------
// What a reply sounds like when it is spoken, rather than read.
//
// THE GAP THIS FILLS. `POST /voice/speak` sent its `text` straight to the
// provider. The web client stripped basic markdown on its way in
// (`textForSpeech` in voice-store.ts), which helped for that one caller and
// only that one caller — the endpoint itself had no preparation at all, so
// anything else calling it spoke raw markdown, and even the web path still read
// out whole tables, tool ids and error enums.
//
// A screen reply and a spoken reply are different artefacts. On screen, a
// twelve-row table of campaign metrics is the clearest possible answer. Read
// aloud it is ninety seconds of "pipe, campaign A, pipe, one thousand two
// hundred, pipe" and the listener has lost the thread by row three. So this
// converts rather than merely strips:
//
//   tables      -> a spoken summary, with the detail left on screen
//   markdown    -> plain prose
//   tool ids    -> the thing they do, or nothing
//   ids/tokens  -> "that account", "the pending action" — never the raw value
//   JSON/errors -> a sentence a person can act on
//
// WHAT IT MUST NEVER DO is change the meaning. Numbers, currency, percentages
// and date ranges are preserved verbatim — they are the answer. An approval
// request stays explicit, because a listener who does not realise they were
// asked to approve something is the one failure here that has consequences
// beyond annoyance.
//
// Shared by the API route and the web client so there is one behaviour, not two
// that drift. The route applies it unconditionally, which is what makes it a
// property of the endpoint rather than a courtesy of one caller.
// ---------------------------------------------------------------------------

export interface SpeechPreparationResult {
  /** The text to send to the provider. */
  text: string;
  /** Which transformations actually fired. For logging, never for the user. */
  applied: string[];
  /** True when a table was summarised rather than read. */
  tableSummarised: boolean;
  /** True when the text was cut to fit the length budget. */
  truncated: boolean;
}

const DEFAULT_LIMIT = 4000;

/** Rows beyond this and a table is described, not recited. */
const MAX_SPOKEN_TABLE_ROWS = 2;

/**
 * Tool ids and internal identifiers, mapped to what a person would call them.
 *
 * An id that reaches the speech path at all is a leak from somewhere upstream —
 * the prompts forbid printing them. This is the backstop, and a backstop should
 * degrade to silence rather than to "meta dot insights".
 */
const TOOL_ID_PHRASES: Array<[RegExp, string]> = [
  [/\bmeta\.insights\b/gi, "your Meta performance data"],
  [/\bmeta\.campaigns?\b/gi, "your Meta campaigns"],
  [/\bmeta\.adsets?\b/gi, "your ad sets"],
  [/\bmeta\.ads\b/gi, "your ads"],
  [/\bmeta\.accounts?\b/gi, "your ad account"],
  [/\bcapabilities\.\w+\b/gi, "my capability list"],
  [/\bintegration\.\w+\b/gi, "your integrations"],
  [/\bmaps\.\w+\b/gi, "the maps lookup"],
  [/\bgmail\.\w+\b/gi, "your mail"],
  [/\bcalendar\.\w+\b/gi, "your calendar"],
  [/\bdrive\.\w+\b/gi, "your Drive files"],
];

/**
 * Error and status enums, spoken as what they mean.
 *
 * "TOOL_EXECUTION_FAILED" read aloud is "tool underscore execution underscore
 * failed", which tells a listener nothing and sounds broken.
 */
const ENUM_PHRASES: Array<[RegExp, string]> = [
  [/\bTOOL_EXECUTION_FAILED\b/g, "the request failed"],
  [/\bDATA_RETRIEVAL_FAILED\b/g, "the data could not be retrieved"],
  [/\bTOOL_UNAVAILABLE\b/g, "that service is unavailable"],
  [/\bTOOL_RATE_LIMITED\b/g, "the service is rate limited right now"],
  [/\bAUTHORIZATION_FAILED\b/g, "you are not authorized for that"],
  [/\bINVALID_REQUEST\b/g, "the request was not valid"],
  [/\bINTERNAL_ERROR\b/g, "something went wrong on my side"],
  [/\bNEEDS_REAUTH\b/g, "the connection needs reauthorizing"],
  [/\bNOT_CONNECTED\b/g, "not connected"],
  [/\bNOT_CONFIGURED\b/g, "not configured"],
  [/\bREQUIRES_CONFIRMATION\b/g, "needs your approval"],
  [/\bEMPTY_RESULT\b/g, "no data for that period"],
  [/\bDATA_RETURNED\b/g, "data came back"],
  [/\bEXECUTABLE\b/g, "available"],
];

/**
 * Opaque identifiers, replaced by what they refer to.
 *
 * Ordered longest-pattern-first: `act_1234` must be caught by the account rule
 * before the generic long-digit-run rule reaches it.
 */
const IDENTIFIER_PHRASES: Array<[RegExp, string]> = [
  // "for account act_2478…" is matched FIRST, or the generic rule below turns
  // it into the stutter "for account that ad account".
  [/\b(?:for\s+)?account\s+act_[0-9•*]{4,}\b/gi, "for your ad account"],
  // Meta account ids, masked or not.
  [/\bact_[0-9•*]{4,}\b/g, "your ad account"],
  // UUIDs — trace ids, request ids, approval tokens.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "that reference"],
  // cuid/cuid2, as used for conversation and approval rows.
  [/\bc[a-z0-9]{20,}\b/g, "that item"],
  // Long opaque hex/base64-ish runs: tokens, secrets, signatures.
  [/\b[A-Za-z0-9_-]{32,}\b/g, "that token"],
];

/**
 * Metric keys, spoken as words.
 *
 * Only the abbreviations that genuinely mislead when read as letters in the
 * middle of prose. CTR and CPC are fine spoken as initialisms and are left
 * alone; `ctr:` as a bare key is not prose and is expanded.
 */
const METRIC_KEY_PHRASES: Array<[RegExp, string]> = [
  [/\bspend\s*:\s*/gi, "spend was "],
  [/\bimpressions\s*:\s*/gi, "impressions were "],
  [/\breach\s*:\s*/gi, "reach was "],
  [/\bclicks\s*:\s*/gi, "clicks were "],
  [/\bctr\s*:\s*/gi, "click-through rate was "],
  [/\bcpc\s*:\s*/gi, "cost per click was "],
  [/\bcpm\s*:\s*/gi, "cost per thousand impressions was "],
  [/\bcpa\s*:\s*/gi, "cost per acquisition was "],
  [/\broas\s*:\s*/gi, "return on ad spend was "],
  [/\bconversions\s*:\s*/gi, "conversions were "],
];

/**
 * Prepare a reply for text-to-speech.
 *
 * Pure and deterministic — the same text always produces the same speech text,
 * which matters because this runs on the request path and its output is billed
 * per character.
 */
export function prepareForSpeech(
  input: string,
  limit: number = DEFAULT_LIMIT
): SpeechPreparationResult {
  const applied: string[] = [];
  let tableSummarised = false;
  let text = input ?? "";

  const note = (label: string, before: string) => {
    if (before !== text) applied.push(label);
  };

  // --- structured payloads, before anything else touches their punctuation ---
  let before = text;
  text = stripFencedBlocks(text);
  note("code-blocks", before);

  before = text;
  text = stripJsonObjects(text);
  note("json", before);

  // --- tables: summarise rather than recite ---
  before = text;
  const tableResult = summariseTables(text);
  text = tableResult.text;
  tableSummarised = tableResult.summarised;
  note("tables", before);

  // --- internal vocabulary ---
  before = text;
  for (const [pattern, phrase] of TOOL_ID_PHRASES) text = text.replace(pattern, phrase);
  note("tool-ids", before);

  before = text;
  for (const [pattern, phrase] of ENUM_PHRASES) text = text.replace(pattern, phrase);
  note("status-enums", before);

  before = text;
  for (const [pattern, phrase] of IDENTIFIER_PHRASES) text = text.replace(pattern, phrase);
  note("identifiers", before);

  before = text;
  for (const [pattern, phrase] of METRIC_KEY_PHRASES) text = text.replace(pattern, phrase);
  note("metric-keys", before);

  // --- markdown to prose ---
  before = text;
  text = stripMarkdown(text);
  note("markdown", before);

  // --- whitespace ---
  text = text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // --- length ---
  const truncated = text.length > limit;
  if (truncated) {
    text = cutAtSentence(text, limit);
    applied.push("truncated");
  }

  return { text, applied, tableSummarised, truncated };
}

// ---------------------------------------------------------------------------

function stripFencedBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ");
}

/**
 * Remove JSON objects that were printed into prose.
 *
 * Conservative on purpose: it only fires on a brace block that actually looks
 * like JSON — a quoted key followed by a colon — so an ordinary sentence
 * containing braces survives untouched.
 */
function stripJsonObjects(text: string): string {
  return text.replace(/\{[^{}]*"[^"]+"\s*:[^{}]*\}/g, " that data ");
}

/**
 * Turn markdown tables into something worth hearing.
 *
 * A table of two data rows or fewer is read as sentences, because at that size
 * the numbers ARE the answer. Anything longer is described and left on screen —
 * reciting twelve rows of metrics is how a spoken answer becomes unusable.
 */
function summariseTables(text: string): { text: string; summarised: boolean } {
  const lines = text.split("\n");
  const out: string[] = [];
  let summarised = false;
  let i = 0;

  while (i < lines.length) {
    const start = i;
    const block: string[] = [];
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
      block.push(lines[i]!);
      i++;
    }

    // A table is a header, a separator of dashes, and at least one row.
    const isTable =
      block.length >= 3 && /^\s*\|[\s:|-]+\|\s*$/.test(block[1] ?? "");

    if (!isTable) {
      if (block.length === 0) {
        out.push(lines[start]!);
        i = start + 1;
      } else {
        out.push(...block);
      }
      continue;
    }

    const headers = splitRow(block[0]!);
    const rows = block.slice(2).map(splitRow).filter((r) => r.some((c) => c.length > 0));

    if (rows.length <= MAX_SPOKEN_TABLE_ROWS) {
      // Small enough to speak: "Campaign A — spend 1200, clicks 340."
      for (const row of rows) {
        const label = row[0] ?? "";
        const pairs = headers
          .slice(1)
          .map((h, idx) => (row[idx + 1] ? `${h} ${row[idx + 1]}` : ""))
          .filter(Boolean)
          .join(", ");
        out.push(pairs ? `${label} — ${pairs}.` : `${label}.`);
      }
    } else {
      summarised = true;
      // Pluralised, because this is read out loud and "4 campaign" is exactly
      // the kind of thing that makes a spoken answer sound machine-generated.
      const noun = headers[0] ? pluralise(headers[0].toLowerCase(), rows.length) : "rows";
      out.push(
        `There are ${rows.length} ${noun} in the breakdown — I've put the full table on screen.`
      );
    }
  }

  return { text: out.join("\n"), summarised };
}

/** Naive but sufficient for table headers, which are short common nouns. */
function pluralise(noun: string, count: number): string {
  if (count === 1) return noun;
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function stripMarkdown(text: string): string {
  return (
    text
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2")
      // List markers, including the numbered ones a capability dump is full of.
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-*_]{3,}\s*$/gm, "")
      .replace(/\|/g, " ")
  );
}

function cutAtSentence(text: string, limit: number): string {
  const truncated = text.slice(0, limit);
  const lastStop = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? ")
  );
  return lastStop > limit * 0.5 ? truncated.slice(0, lastStop + 1) : truncated;
}
