// ---------------------------------------------------------------------------
// Phase 19, Stage 19.5 — value-free approval records (S3, F3).
//
// An approval for a browser or desktop action is bound to its exact
// parameters by their hash. What the approval RECORD keeps in their place is
// the same value-free projection the audit trail keeps: the action, its fixed
// summary sentence, the normalized origin, sanitized field names and counts.
// These tests pin that projection, the record that carries it, the reader
// that accepts only a well-formed record, and which tools are sealed.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  COMPUTER_CONTROL_ACTION_IDS,
  COMPUTER_CONTROL_APPROVAL_RECORD,
  computerControlApprovalRecord,
  computerControlApprovalSummary,
  computerControlValueFreeParams,
  parseComputerControlRequest,
  readComputerControlApprovalRecord,
  sealsApprovalParams,
} from "../src/computer-control.js";
import { MARKETING_TOOL_IDS } from "../src/index.js";

const SECRETS = ["hunter2-TYPED", "token=abc", "/login", "frag", "4111111111111111", "Wish-Option", "9b2d"];

const TYPE = { url: "https://shop.example/login?token=abc#frag", selector: "#password", text: "hunter2-TYPED" };
const SUBMIT = {
  url: "https://shop.example/checkout?token=abc",
  selector: "button[type=submit]",
  fields: { "#card": "4111111111111111", 'input[name="note"]': "hunter2-TYPED" },
};
const SELECT = { url: "https://shop.example/login", selector: "#plan", value: "Wish-Option" };
const UPLOAD = {
  url: "https://shop.example/login",
  selector: "#file",
  downloadId: "9b2d6a4e-1f3c-4d5e-8a7b-0c1d2e3f4a5b",
};

function expectNoSecret(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("Phase 19.5 — the value-free projection of a browser or desktop request", () => {
  it("keeps the action, the summary sentence, the origin and the field's name and length", () => {
    expect(computerControlValueFreeParams("browser.type", TYPE)).toEqual({
      action: "browser.type",
      summary: "Type into a field on https://shop.example.",
      targetResource: "https://shop.example",
      details: [
        { label: "Site", value: "https://shop.example" },
        { label: "Field", value: "#password" },
        { label: "Characters", value: "13" },
      ],
    });
  });

  it.each([
    ["browser.type", TYPE],
    ["browser.submit", SUBMIT],
    ["browser.select", SELECT],
    ["browser.upload", UPLOAD],
    ["desktop.input.type", { text: "hunter2-TYPED" }],
  ])("never carries a typed value, a query, a path or an artifact id (%s)", (toolId, params) => {
    expectNoSecret(computerControlValueFreeParams(toolId, params));
  });

  it("records an invalid request as refused, with its code and nothing it carried", () => {
    const projection = computerControlValueFreeParams("browser.type", { ...TYPE, extra: "hunter2-TYPED" });
    expect(projection).toEqual({ action: "browser.type", refused: true, reason: "INVALID_REQUEST" });
  });

  it("is the summary the approval screen shows, field for field", () => {
    const parsed = parseComputerControlRequest({ ...SUBMIT, action: "browser.submit" });
    if (!parsed.ok) throw new Error("fixture must parse");
    const summary = computerControlApprovalSummary(parsed.value);
    expect(computerControlValueFreeParams("browser.submit", SUBMIT)).toEqual({
      action: "browser.submit",
      summary: summary.actionSummary,
      targetResource: summary.targetResource,
      details: summary.detailLines,
    });
  });
});

describe("Phase 19.5 — the approval record, and the one reader of it", () => {
  it("marks the record, and round-trips to the summary it was made from", () => {
    const record = computerControlApprovalRecord("browser.type", TYPE);
    expect(record).toMatchObject({ withheld: COMPUTER_CONTROL_APPROVAL_RECORD, action: "browser.type" });
    expectNoSecret(record);
    expect(readComputerControlApprovalRecord("browser.type", record)).toEqual({
      actionSummary: "Type into a field on https://shop.example.",
      targetResource: "https://shop.example",
      detailLines: [
        { label: "Site", value: "https://shop.example" },
        { label: "Field", value: "#password" },
        { label: "Characters", value: "13" },
      ],
    });
  });

  it("survives a trip through JSON, as it does through the database", () => {
    const stored = JSON.parse(JSON.stringify(computerControlApprovalRecord("browser.submit", SUBMIT)));
    expect(readComputerControlApprovalRecord("browser.submit", stored)?.actionSummary).toMatch(/^Fill and submit a form/);
  });

  it("is made only for a computer-control action", () => {
    expect(computerControlApprovalRecord("meta.campaign.create", { name: "x" })).toBeNull();
  });

  it.each([
    ["the exact parameters", TYPE],
    ["no marker", { action: "browser.type", summary: "s", details: [] }],
    ["another marker", { withheld: "computer-control/v2", action: "browser.type", summary: "s", details: [] }],
    ["another action than the approval's", { ...computerControlApprovalRecord("browser.click", { url: "https://a.example", selector: "#b" }) }],
    ["a refused request", computerControlApprovalRecord("browser.type", { url: "nope" })],
    ["a field it does not know", { ...computerControlApprovalRecord("browser.type", TYPE), text: "hunter2-TYPED" }],
    ["an overlong summary", { ...computerControlApprovalRecord("browser.type", TYPE), summary: "x".repeat(2_000) }],
    ["a detail that is not a label and a value", { ...computerControlApprovalRecord("browser.type", TYPE), details: [{ label: "Site" }] }],
    ["too many details", { ...computerControlApprovalRecord("browser.type", TYPE), details: Array.from({ length: 40 }, () => ({ label: "a", value: "b" })) }],
    ["not an object", "computer-control/v1"],
  ])("is read as nothing when it holds %s", (_label, value) => {
    expect(readComputerControlApprovalRecord("browser.type", value)).toBeNull();
  });
});

describe("Phase 19.5 — which approvals are sealed", () => {
  it("every browser and desktop action, and nothing else", () => {
    for (const action of COMPUTER_CONTROL_ACTION_IDS) expect(sealsApprovalParams(action)).toBe(true);
    for (const toolId of ["meta.campaign.create", MARKETING_TOOL_IDS.contentPublish, "memory.forget", "", "browser.unknown"]) {
      expect(sealsApprovalParams(toolId)).toBe(false);
    }
  });
});
