// S7.2 L2 — test support: the answer a COMPLIANT extraction model gives.
//
// Since L2 every candidate must name the USER message it came from and quote
// it word for word, or it is not stored. Suites written before L2 script their
// candidates without that citation; they test other behaviour — types,
// scores, dedup, merge, expiry, embeddings — of memories that ARE the user's.
// Their stand-in models therefore answer the way a compliant model does: each
// candidate without a `source` cites the first USER message of the prompt and
// quotes it in full. A candidate that already carries a citation is left as
// it is, and so is any reply that is not a candidates object.
//
// The L2 rules themselves are tested with raw, uncorrected replies in
// memory-provenance-l2.test.ts and memory-provenance-l2-pg.integration.test.ts.
import type { AICompletionRequest, AICompletionResponse } from "@jarvis/core";

/** The first `[Mn] USER: …` line the service showed the model. */
function firstUserMessage(request: AICompletionRequest): { ref: string; text: string } | null {
  for (const message of request.messages) {
    const match = /^\[(M\d+)\] USER: (.+)$/m.exec(message.content ?? "");
    if (match) return { ref: match[1]!, text: match[2]! };
  }
  return null;
}

/** `content` with each uncited candidate citing the first USER message. */
export function citeFirstUserMessage(request: AICompletionRequest, content: string): string {
  const user = firstUserMessage(request);
  if (!user) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  const candidates = (parsed as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return content;
  return JSON.stringify({
    ...(parsed as object),
    candidates: candidates.map((c) =>
      typeof c === "object" && c !== null && !("source" in c) ? { ...c, source: user.ref, evidence: user.text } : c
    ),
  });
}

/** The same, for a whole model response. */
export function citedResponse(request: AICompletionRequest, response: AICompletionResponse): AICompletionResponse {
  const content = response.message.content;
  if (typeof content !== "string") return response;
  return { ...response, message: { ...response.message, content: citeFirstUserMessage(request, content) } };
}
