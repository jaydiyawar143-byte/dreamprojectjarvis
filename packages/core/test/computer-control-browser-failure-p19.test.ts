// ---------------------------------------------------------------------------
// Phase 19 — what a person is told when the browser service cannot do what a
// browsing request needs. The browser tools raise the service's own fixed
// sentences ("The browser service is not available."). Before this rule none
// of them matched a known remedy, so every one collapsed to "Data retrieval
// failed." — which says nothing about browsing and nothing to do. Named
// `computer-control*`, the slice CI runs for this package.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { classifyToolFailure, classifyToolFailures } from "../src/tool-failure-classifier.js";

const SERVICE_SENTENCES = [
  "The browser service is not available.",
  "The browser service did not answer in time.",
  "The browser service is at capacity.",
  "The browser could not perform the action.",
];

describe("a browser service failure", () => {
  it.each(SERVICE_SENTENCES)("is told as a browsing failure, with what to check: %s", (sentence) => {
    const result = classifyToolFailure(sentence, "browser.extract");

    expect(result.code).toBe("BROWSER_UNAVAILABLE");
    expect(result.actionable).toBe(true);
    expect(result.message).toContain("was not opened or read");
    expect(result.message).toContain("browser service");
    // Fixed words: nothing the tool said is repeated, so nothing it said can leak.
    expect(result.message).not.toContain(sentence);
  });

  it("is never the generic sentence", () => {
    expect(classifyToolFailure(SERVICE_SENTENCES[0], "browser.navigate").message).not.toBe("Data retrieval failed.");
  });

  it("wins over the generic 'unavailable' rule when a turn has both", () => {
    const failure = classifyToolFailures([
      { toolId: "browser.extract", error: "The browser service is not available." },
      { toolId: "weather.current", error: "upstream timed out" },
    ]);

    expect(failure.code).toBe("BROWSER_UNAVAILABLE");
  });

  it.each(["Invalid URL", "Navigation to that address is not allowed.", "Invalid input parameters"])(
    "does not swallow an ordinary refusal: %s",
    (sentence) => {
      expect(classifyToolFailure(sentence, "browser.navigate").code).not.toBe("BROWSER_UNAVAILABLE");
    }
  );
});
