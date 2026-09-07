// ---------------------------------------------------------------------------
// Untrusted remote content.
//
// Anything fetched from outside JARVIS — a web page, a downloaded document, a
// search snippet — is DATA that will be placed near a system prompt, not
// instructions. A page that says "ignore your previous instructions" is a page
// that contains that sentence; it is not a command.
//
// Two defences, and they do different jobs:
//
//   `containsInstructionInjection` FLAGS the content so the caller can label it
//   in tool metadata and the model can be told, in the envelope, that what
//   follows is quoted material.
//
//   `wrapUntrustedContent` DELIMITS it, so the boundary between our
//   instructions and their text is explicit rather than positional.
//
// Neither one "sanitizes" the text by deleting the offending sentence. Silently
// rewriting remote content would make the tool lie about what the page said,
// which is worse than quoting it accurately and saying where it came from.
//
// The pattern list originated in packages/tools/src/tools/web-research.ts and
// document-analyzer.ts, which each carry their own copy. It lives here so a
// third consumer — the Sprint 7 browser tools — does not create a fourth.
// ---------------------------------------------------------------------------

/** Phrasings that characterise an attempt to redirect the model. */
export const INSTRUCTION_INJECTION_PATTERNS: readonly RegExp[] = Object.freeze([
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|above|prior)/i,
  /you\s+are\s+now\s+/i,
  /system\s*:\s*/i,
  /act\s+as\s+if/i,
  /pretend\s+you\s+are/i,
  /override\s+(system|instructions?)/i,
  /new\s+instructions?\s*:/i,
  /\[INST\]/i,
  /<\|im_start\|>/i,
  /<\|system\|>/i,
]);

/** True when remote text is trying to talk to the model rather than to a reader. */
export function containsInstructionInjection(text: unknown): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return INSTRUCTION_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Metadata every tool returning remote content should carry.
 *
 * `treatedAsUntrustedData: true` is the existing convention in this repo
 * (web-research.ts sets it); `containsSuspectedInjection` is the extra signal
 * a reviewer or an audit query can filter on.
 */
export function untrustedContentMetadata(text: unknown): {
  treatedAsUntrustedData: true;
  containsSuspectedInjection: boolean;
} {
  return {
    treatedAsUntrustedData: true,
    containsSuspectedInjection: containsInstructionInjection(text),
  };
}

/**
 * Fences remote text so the model can see where it starts and stops.
 *
 * The tag names the origin, so a reader of the transcript can tell one page's
 * text from another's without inferring it from position.
 */
export function wrapUntrustedContent(text: string, source: string): string {
  const safeSource = source.replace(/[<>"]/g, "").slice(0, 200);
  return [
    `<untrusted_content source="${safeSource}">`,
    text,
    "</untrusted_content>",
  ].join("\n");
}
