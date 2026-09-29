// S7.2 L2 — test support: the answer a COMPLIANT extraction model gives.
//
// The API's copy of packages/memory/test/helpers/compliant-citation.ts (test
// helpers are not shared across packages). Since L2 every memory candidate
// must name the USER message it came from and quote it, or it is not stored.
// The memory suites written before L2 script candidates without that
// citation; their stand-in extraction models answer as a compliant model
// does: each candidate without a `source` cites the first USER message of the
// prompt and quotes it in full. Chat replies, and candidates that already
// carry a citation, pass through unchanged.
import type { AICompletionRequest, AICompletionResponse } from "@jarvis/core";

function firstUserMessage(request: AICompletionRequest): { ref: string; text: string } | null {
  for (const message of request.messages) {
    const match = /^\[(M\d+)\] USER: (.+)$/m.exec(message.content ?? "");
    if (match) return { ref: match[1]!, text: match[2]! };
  }
  return null;
}

/** `response` with each uncited candidate citing the first USER message. */
export function citedResponse(request: AICompletionRequest, response: AICompletionResponse): AICompletionResponse {
  const content = response.message.content;
  const user = firstUserMessage(request);
  if (typeof content !== "string" || !user) return response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return response;
  }
  const candidates = (parsed as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return response;
  const cited = candidates.map((c) =>
    typeof c === "object" && c !== null && !("source" in c) ? { ...c, source: user.ref, evidence: user.text } : c
  );
  return { ...response, message: { ...response.message, content: JSON.stringify({ ...(parsed as object), candidates: cited }) } };
}
