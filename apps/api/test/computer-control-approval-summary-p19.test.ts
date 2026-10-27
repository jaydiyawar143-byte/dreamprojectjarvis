// ---------------------------------------------------------------------------
// Phase 19, Stage 19.1 — what an approver sees for a browser or desktop action.
//
// The API's summary is deterministic and server-built. These tests pin that the
// browser/desktop branch bypasses the generic "echo every scalar parameter"
// loop, so typed text, submitted values, option values, query strings, cookies
// and file references never reach the approval screen or its stored detail.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { BROWSER_TOOL_IDS } from "@jarvis/core";
import { buildApprovalSummary } from "../src/services/approval-summary.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("Phase 19.1 — browser approval summaries", () => {
  it("names the origin, not the path, query or fragment", () => {
    const summary = buildApprovalSummary(BROWSER_TOOL_IDS.navigate, {
      url: "https://Example.com:8443/private?token=SECRET-VALUE#fragment",
    });
    expect(summary.actionSummary).toBe("Open https://example.com:8443 in the browser.");
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("SECRET-VALUE");
    expect(serialized).not.toContain("/private");
    expect(serialized).not.toContain("fragment");
  });

  it("shows a typed field and its character count, never the typed text", () => {
    const summary = buildApprovalSummary(BROWSER_TOOL_IDS.type, {
      url: "https://example.com/login",
      selector: 'input[name="password"]',
      text: "hunter2",
    });
    expect(summary.detailLines).toContainEqual({ label: "Field", value: "input[name=…]" });
    expect(summary.detailLines).toContainEqual({ label: "Characters", value: "7" });
    expect(JSON.stringify(summary)).not.toContain("hunter2");
  });

  it("does not echo an unknown scalar parameter through the generic path", () => {
    // A stored row that carries an unknown field is not a valid browser
    // request, so it gets the safe fallback; the generic echo loop must never
    // be reached and the scalar must never appear in the summary.
    const summary = buildApprovalSummary(BROWSER_TOOL_IDS.type, {
      url: "https://example.com/login",
      selector: 'input[name="password"]',
      text: "hunter2",
      cookie: "session=SECRET-COOKIE",
    });
    expect(summary.actionSummary).toContain("could not be verified");
    expect(summary.detailLines).toEqual([{ label: "Action", value: BROWSER_TOOL_IDS.type }]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("SECRET-COOKIE");
    expect(serialized).not.toContain('"cookie"');
  });

  it("shows submitted field names with attribute values stripped, never a value", () => {
    const summary = buildApprovalSummary(BROWSER_TOOL_IDS.submit, {
      url: "https://example.com/checkout",
      selector: 'button[value="pay-now"]',
      fields: {
        'input[name="password"]': "hunter2",
        'input[value="secret-in-selector"]': "also-secret",
      },
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("also-secret");
    expect(serialized).not.toContain("pay-now");
    expect(serialized).not.toContain("secret-in-selector");
    expect(serialized).toContain("input[name=…]");
    expect(summary.detailLines).toContainEqual({ label: "Reversible", value: "No" });
  });

  it("never echoes a selected option value, a download id or an uploaded file name", () => {
    const select = JSON.stringify(
      buildApprovalSummary(BROWSER_TOOL_IDS.select, {
        url: "https://example.com/",
        selector: "select#country",
        value: "secret-option-value",
      })
    );
    expect(select).not.toContain("secret-option-value");
    expect(select).toContain("not shown");

    const upload = JSON.stringify(
      buildApprovalSummary(BROWSER_TOOL_IDS.upload, {
        url: "https://example.com/",
        selector: "input[type=file]",
        downloadId: UUID,
        fileName: "private-contract.pdf",
      })
    );
    expect(upload).not.toContain(UUID);
    expect(upload).not.toContain("private-contract.pdf");
  });

  it("falls back safely when the stored parameters no longer parse", () => {
    const summary = buildApprovalSummary(BROWSER_TOOL_IDS.type, {
      url: "file:///C:/secret.txt",
      selector: "#password",
      text: "hunter2",
    });
    expect(summary.actionSummary).toContain("could not be verified");
    expect(summary.detailLines).toEqual([{ label: "Action", value: BROWSER_TOOL_IDS.type }]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("secret.txt");
  });
});

describe("Phase 19.1 — desktop approval summaries", () => {
  it("shows a typed character count, never the text", () => {
    const summary = buildApprovalSummary("desktop.input.type", { text: "desktop-secret" });
    expect(summary.detailLines).toContainEqual({ label: "Characters", value: "14" });
    expect(summary.detailLines).toContainEqual({ label: "Text", value: "not shown" });
    expect(JSON.stringify(summary)).not.toContain("desktop-secret");
  });

  it("shows a bounded click position and the fixed key name", () => {
    expect(
      buildApprovalSummary("desktop.input.click", { x: 100, y: 220, button: "right" }).detailLines
    ).toContainEqual({ label: "Position", value: "100, 220" });
    expect(
      buildApprovalSummary("desktop.input.key", { key: "enter" }).actionSummary
    ).toContain("enter");
  });

  it("fails closed for a malformed desktop action without echoing it", () => {
    const summary = buildApprovalSummary("desktop.input.type", {
      text: "desktop-secret",
      command: "calc.exe",
    });
    expect(summary.actionSummary).toContain("could not be verified");
    expect(JSON.stringify(summary)).not.toContain("desktop-secret");
    expect(JSON.stringify(summary)).not.toContain("calc.exe");
  });
});
