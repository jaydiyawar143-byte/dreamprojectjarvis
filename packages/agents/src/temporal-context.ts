// ---------------------------------------------------------------------------
// Server-authoritative "what day is it".
//
// THE BUG THIS FIXES. No prompt in this system ever told the model the date.
// A language model does not know it — the closest thing it has is the era its
// training data came from — so every date it produced was a guess anchored
// years in the past. Asked "mere Meta campaigns ke insights batao" on
// 2026-09-13, the model called meta.insights with 2023-10-01 to 2023-10-21.
// Meta returned nothing for a window three years gone, and JARVIS reported "no
// insights available for your campaigns" as though that were a finding about
// the ads. It was a finding about the clock.
//
// The date-range DEFAULT is fixed properly at the tool boundary
// (`resolveInsightsDateRange` — the server resolves it, the model no longer
// supplies it). This block is the other half: when the user DOES name a window
// — "last 7 days", "is hafte", "compare this week with last week" — the model
// has to convert that to real dates, and it cannot do that without knowing
// today. Both halves are needed; neither alone is sufficient.
//
// Injected per turn rather than baked into a prompt string at construction,
// because a long-running server would otherwise be confidently certain that
// today is whenever it happened to boot.
// ---------------------------------------------------------------------------

/**
 * A short dated preamble to prepend to any system prompt.
 *
 * UTC, and explicitly labelled as such, so a model doing arithmetic on it has
 * no ambiguity to resolve. `now` is injectable for tests.
 */
export function currentDateBlock(now: Date = new Date()): string {
  const iso = now.toISOString().slice(0, 10);
  const readable = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return [
    "=== TODAY'S DATE (server-authoritative) ===",
    `Today is ${readable} — ${iso} (UTC).`,
    "You do NOT otherwise know the current date. Never guess one, and never use a date from your training data.",
    "Whenever the user names a relative window, compute it from the date above:",
    `- "last 7 days" / "is hafte" / "this week" -> ${daysAgo(now, 6)} to ${iso}`,
    `- "last 30 days" / "last month's performance" -> ${daysAgo(now, 29)} to ${iso}`,
    `- "yesterday" -> ${daysAgo(now, 1)}`,
    "If the user names no window at all, omit the date parameters entirely and let the tool apply its own default. Do not invent dates to fill them.",
    "==========================================",
  ].join("\n");
}

function daysAgo(now: Date, days: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Prepend the dated block to a prompt, keeping a null/empty prompt null-safe. */
export function withCurrentDate(systemPrompt: string | undefined, now: Date = new Date()): string {
  const block = currentDateBlock(now);
  return systemPrompt ? `${block}\n\n${systemPrompt}` : block;
}
