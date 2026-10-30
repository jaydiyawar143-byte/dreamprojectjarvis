// ---------------------------------------------------------------------------
// Phase 19, Stage 19.5 — the approval screen after the exact parameters are
// gone.
//
// A browser or desktop approval's row keeps only its value-free record (S3);
// its exact parameters are sealed, and deleted once it is rejected, consumed
// or expired. From then on the record is all a reader gets, so the Approvals
// page's history must still say what was asked — from the record — and never
// fall back to a parameter echo. A record that is not well formed, or is for
// another action, gets the same honest sentence a stored row that no longer
// parses gets.
// ---------------------------------------------------------------------------

import { computerControlApprovalRecord } from "@jarvis/core";
import { describe, expect, it } from "vitest";

import { buildApprovalSummary } from "../src/services/approval-summary.js";

const TYPE = { url: "https://shop.example/login?token=abc", selector: "#password", text: "hunter2-TYPED" };
const SUBMIT = {
  url: "https://shop.example/checkout",
  selector: "button[type=submit]",
  fields: { "#card": "4111111111111111" },
};

describe("Phase 19.5 — an approval summary from its value-free record", () => {
  it.each([
    ["browser.type", TYPE],
    ["browser.submit", SUBMIT],
    ["desktop.input.type", { text: "hunter2-TYPED" }],
  ])("is the summary the exact parameters gave (%s), and holds none of them", (toolId, params) => {
    const record = computerControlApprovalRecord(toolId, params)!;
    const fromRecord = buildApprovalSummary(toolId, JSON.parse(JSON.stringify(record)));
    expect(fromRecord).toEqual(buildApprovalSummary(toolId, params));
    const text = JSON.stringify(fromRecord);
    for (const value of ["hunter2-TYPED", "4111111111111111", "token=abc"]) expect(text).not.toContain(value);
  });

  it("is the could-not-verify sentence for a record of another action, or a malformed one", () => {
    const click = computerControlApprovalRecord("browser.click", { url: "https://a.example", selector: "#b" })!;
    const typed = computerControlApprovalRecord("browser.type", TYPE)!;
    for (const params of [
      click as unknown as Record<string, unknown>,
      { ...typed, summary: "x".repeat(5_000) },
      { ...typed, text: "hunter2-TYPED" },
    ]) {
      const summary = buildApprovalSummary("browser.type", params);
      expect(summary.actionSummary).toContain("could not be verified");
      expect(JSON.stringify(summary)).not.toContain("hunter2-TYPED");
    }
  });
});
