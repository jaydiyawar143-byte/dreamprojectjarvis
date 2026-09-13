// ---------------------------------------------------------------------------
// What actually reaches the speaker.
//
// Two failure modes are being pinned, and they pull in opposite directions:
//
//   TOO MUCH — markdown, twelve-row tables, tool ids, status enums, approval
//   tokens and JSON all being read out loud, which is what happened before this
//   existed server-side.
//
//   TOO LITTLE — preparation quietly eating the numbers, the date range or the
//   fact that the user was asked to approve something. That is the worse
//   failure: a spoken answer that has been tidied into saying nothing, or one
//   where the listener never realises a write is waiting on them.
//
// So every "removes X" test here has a companion "keeps Y" test.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { prepareForSpeech } from "../src/speech-preparation.js";

describe("markdown does not get read aloud", () => {
  it("strips headings, bold and bullets", () => {
    const { text } = prepareForSpeech(
      "## Summary\n\n**CPA** rose by *12%*.\n\n- Campaign A\n- Campaign B"
    );

    expect(text).not.toContain("##");
    expect(text).not.toContain("**");
    expect(text).toContain("Summary");
    expect(text).toContain("CPA");
    expect(text).toContain("12%");
  });

  it("drops numbered list markers, which a capability answer is full of", () => {
    const { text } = prepareForSpeech("1. First thing\n2. Second thing");

    expect(text).not.toMatch(/^\s*1\./m);
    expect(text).toContain("First thing");
  });

  it("keeps link text and drops the URL", () => {
    const { text } = prepareForSpeech("See [the dashboard](https://example.com/very/long/url).");

    expect(text).toContain("the dashboard");
    expect(text).not.toContain("https://");
  });

  it("does not read code blocks", () => {
    const { text } = prepareForSpeech("Here:\n\n```js\nconst x = 1;\n```\n\nDone.");

    expect(text).not.toContain("const x = 1");
    expect(text).toContain("Done.");
  });

  it("leaves plain prose exactly as it was", () => {
    expect(prepareForSpeech("Your CPA is 12 rupees.").text).toBe("Your CPA is 12 rupees.");
  });
});

describe("tables are summarised rather than recited", () => {
  const bigTable = [
    "Here is the breakdown:",
    "",
    "| Campaign | Spend | Clicks | CTR |",
    "| --- | --- | --- | --- |",
    "| Alpha | 1200 | 340 | 2.1% |",
    "| Beta | 900 | 210 | 1.8% |",
    "| Gamma | 700 | 180 | 1.5% |",
    "| Delta | 400 | 90 | 1.2% |",
    "| Epsilon | 250 | 60 | 1.1% |",
  ].join("\n");

  it("describes a long table instead of reading every cell", () => {
    const result = prepareForSpeech(bigTable);

    expect(result.tableSummarised).toBe(true);
    // Pluralised: this is read aloud, and "5 campaign" sounds broken.
    expect(result.text).toMatch(/5 campaigns/i);
    expect(result.text).toMatch(/on screen/i);
    // The individual rows must not be spoken.
    expect(result.text).not.toContain("Epsilon");
    expect(result.text).not.toContain("|");
  });

  it("speaks a short table as sentences, because there the numbers are the answer", () => {
    const small = [
      "| Campaign | Spend |",
      "| --- | --- |",
      "| Alpha | 1200 |",
    ].join("\n");

    const result = prepareForSpeech(small);

    expect(result.tableSummarised).toBe(false);
    expect(result.text).toContain("Alpha");
    expect(result.text).toContain("1200");
    expect(result.text).not.toContain("|");
  });
});

describe("internal vocabulary never reaches the speaker", () => {
  it("replaces tool ids with what they actually are", () => {
    const { text } = prepareForSpeech("I called meta.insights and capabilities.list for you.");

    expect(text).not.toContain("meta.insights");
    expect(text).not.toContain("capabilities.list");
    expect(text).toContain("your Meta performance data");
  });

  it("speaks status enums as meaning, not as underscores", () => {
    const { text } = prepareForSpeech("Result: TOOL_EXECUTION_FAILED for that account.");

    expect(text).not.toContain("TOOL_EXECUTION_FAILED");
    expect(text).toContain("the request failed");
  });

  it("never reads an account id, trace id or approval token", () => {
    const { text } = prepareForSpeech(
      "Account act_2478901624, trace 791699e7-ed17-4a0d-805f-bcc877ce7139, " +
        "approval cmtl3vinw0006ssv0el0pa3b3."
    );

    expect(text).not.toContain("act_2478901624");
    expect(text).not.toContain("791699e7");
    expect(text).not.toContain("cmtl3vinw0006ssv0el0pa3b3");
    expect(text).toContain("your ad account");
    // And not the stutter "account that ad account".
    expect(text).not.toMatch(/account\s+(that|your) ad account/i);
  });

  it("does not read JSON that leaked into the prose", () => {
    const { text } = prepareForSpeech('Got {"spend": 1200, "clicks": 340} back.');

    expect(text).not.toContain('"spend"');
    expect(text).not.toContain("{");
  });
});

describe("meaning, numbers and the approval boundary are preserved", () => {
  it("keeps spend, percentages and the date range intact", () => {
    const { text } = prepareForSpeech(
      "**Spend** was ₹12,480 across 2026-09-07 to 2026-09-13, with a CTR of 2.4% and ROAS 3.1x."
    );

    expect(text).toContain("₹12,480");
    expect(text).toContain("2026-09-07");
    expect(text).toContain("2026-09-13");
    expect(text).toContain("2.4%");
    expect(text).toContain("3.1x");
  });

  it("keeps an approval request explicit", () => {
    const { text } = prepareForSpeech(
      "I've prepared the campaign. This **needs your approval** before it runs — approve it on screen."
    );

    expect(text).toMatch(/needs your approval/i);
    expect(text).toMatch(/on screen/i);
  });

  it("turns an approval-required enum into words rather than dropping it", () => {
    const { text } = prepareForSpeech("Status: REQUIRES_CONFIRMATION.");

    expect(text).toMatch(/needs your approval/i);
  });

  it("distinguishes an empty result from a failure when speaking", () => {
    const empty = prepareForSpeech("Result: EMPTY_RESULT for that window.").text;
    const failed = prepareForSpeech("Result: DATA_RETRIEVAL_FAILED.").text;

    expect(empty).toMatch(/no data for that period/i);
    expect(failed).toMatch(/could not be retrieved/i);
    expect(empty).not.toMatch(/failed/i);
  });

  it("expands bare metric keys into spoken phrasing", () => {
    const { text } = prepareForSpeech("spend: 1200, clicks: 340, ctr: 2.1%");

    expect(text).toContain("spend was 1200");
    expect(text).toContain("click-through rate was 2.1%");
  });

  it("truncates at a sentence boundary rather than mid-word", () => {
    const long = "This is a sentence. ".repeat(50);
    const result = prepareForSpeech(long, 200);

    expect(result.text.length).toBeLessThanOrEqual(200);
    expect(result.text.endsWith(".")).toBe(true);
    expect(result.truncated).toBe(true);
  });
});

describe("what was done is reportable, for the log", () => {
  it("names the transformations that fired", () => {
    const result = prepareForSpeech("## Heading\n\nCalled meta.insights.");

    expect(result.applied).toContain("markdown");
    expect(result.applied).toContain("tool-ids");
  });

  it("reports nothing applied for text that needed nothing", () => {
    const result = prepareForSpeech("All good.");

    expect(result.applied).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });
});
