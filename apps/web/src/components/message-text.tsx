"use client";

// ---------------------------------------------------------------------------
// Inline emphasis in a chat message, rendered rather than shown as syntax.
//
// THE DEFECT. `MessageList` rendered `{msg.content}` inside a
// `whitespace-pre-wrap` paragraph, which is safe and was deliberate — no
// `dangerouslySetInnerHTML` anywhere near model output. The cost was that any
// markdown the model produced reached the user as literal characters:
// "- **Business and advertising**: I can ..." on screen, asterisks and all.
//
// It was always true, and it became conspicuous when capability answers started
// being grouped and captioned. The prompt was told twice, with examples, to
// emit plain text; the model dropped `###` and kept `**` on every single run.
// That is the point to stop negotiating with the prompt and fix the renderer:
// a display concern belongs in the display layer, and no amount of instruction
// makes formatting a thing the model reliably does not do.
//
// SAFETY IS UNCHANGED. This builds React elements from parsed segments — it
// never constructs HTML, so there is no injection surface. A model that emits
// "<script>" still renders those characters as text, exactly as before.
//
// Scope is deliberately tiny: bold, italic, and inline code. No links (a
// model-authored href is a phishing vector), no images, no raw HTML, no block
// elements. Anything unmatched falls through untouched, so text that merely
// contains an asterisk is left alone.
// ---------------------------------------------------------------------------

import { Fragment, type ReactNode } from "react";

/** `**bold**`, `*italic*`/`_italic_`, and `` `code` ``, in one pass. */
const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|(?<![A-Za-z0-9])[*_][^*_\n]+[*_](?![A-Za-z0-9]))/g;

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const start = match.index ?? 0;

    if (start > last) out.push(text.slice(last, start));

    if (token.startsWith("**")) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      out.push(
        <code key={key++} className="rounded bg-black/25 px-1 py-0.5 text-[0.9em]">
          {token.slice(1, -1)}
        </code>
      );
    } else {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }

    last = start + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * A chat message body.
 *
 * Line breaks are preserved by `whitespace-pre-wrap` on the wrapper, as before;
 * only the leading `#` of a heading line is stripped, because a heading has no
 * block rendering here and `### Summary` reads worse than `Summary`.
 */
export function MessageText({ content, className }: { content: string; className?: string }) {
  const lines = content.split("\n");

  return (
    <p className={className}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          {renderInline(line.replace(/^\s{0,3}#{1,6}\s+/, ""))}
        </Fragment>
      ))}
    </p>
  );
}
