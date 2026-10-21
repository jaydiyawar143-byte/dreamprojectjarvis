// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — reading an automation request and ranking the
// catalog against it. Pure rules; named `automation-library*` so CI's core
// slice runs it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  PLANNING_LIMITATIONS,
  PLANNING_SECRET_MESSAGE,
  containsSecret,
  planningSearchTerms,
  rankLibraryCandidates,
  redactSecrets,
  validateAutomationRequest,
  type AutomationRequest,
  type LibraryEntryRecord,
} from "../src/index.js";

function entry(over: Partial<LibraryEntryRecord> & { externalId: string; name: string }): LibraryEntryRecord {
  return {
    active: true,
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
    versionId: "v-1",
    tags: [],
    nodeTypes: [],
    nodeCount: 3,
    fingerprint: "f".repeat(64),
    source: "rest",
    presence: "present",
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-20T00:00:00.000Z",
    contentChangedAt: "2026-10-01T00:00:00.000Z",
    missingSince: null,
    removedAt: null,
    ...over,
  };
}

function request(input: Record<string, unknown>): AutomationRequest {
  const read = validateAutomationRequest(input);
  if (!read.ok) throw new Error(read.code);
  return read.value;
}

const FORM_TO_SLACK_AND_SHEETS = { goal: "When a lead form is submitted, post the lead to Slack and add a row to Google Sheets", outcome: "The team sees every new lead" };

const CATALOG = [
  entry({ externalId: "wf-lead", name: "Lead form to Slack and Sheets", nodeTypes: ["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack", "n8n-nodes-base.googleSheets"] }),
  entry({ externalId: "wf-alerts", name: "Form alerts", tags: ["lead"], nodeTypes: ["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack"] }),
  entry({ externalId: "wf-report", name: "Nightly report", nodeTypes: ["n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.gmail"] }),
  entry({ externalId: "wf-nonodes", name: "Lead intake", nodeTypes: null, nodeCount: null }),
  entry({ externalId: "wf-gone", name: "Lead form to Slack and Sheets (old)", presence: "missing", nodeTypes: ["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack", "n8n-nodes-base.googleSheets"] }),
];
const FULL = { compared: CATALOG.length, catalogTotal: CATALOG.length, method: "full" as const, complete: true };

describe("reading a request", () => {
  it("takes the trigger, the apps and what is still open from the goal's own words", () => {
    const read = request(FORM_TO_SLACK_AND_SHEETS);
    expect(read.trigger).toEqual({ kind: "form", source: "from_goal" });
    expect(read.services.map((s) => [s.label, s.nodeType, s.category])).toEqual([
      ["Slack", "n8n-nodes-base.slack", "messaging"],
      ["Google Sheets", "n8n-nodes-base.googleSheets", "spreadsheet"],
    ]);
    // A category a named app already covers is not asked about again.
    expect(read.integrations).toEqual([]);
    expect(read.openQuestions.map((q) => q.key)).toEqual(["inputs"]);
    // Purpose words only: the trigger and the apps are their own criteria.
    expect(read.terms).toEqual(["lead"]);
  });

  it("lets a stated trigger win, and says the goal suggested another", () => {
    const read = request({ goal: "Every morning send a summary to Slack", trigger: "manual" });
    expect(read.trigger).toEqual({ kind: "manual", source: "stated" });
    expect(read.notes[0]).toMatch(/suggest a schedule; the stated trigger, a manual start, was used/);
  });

  it("asks instead of choosing when the goal points two ways, or nowhere", () => {
    expect(request({ goal: "Every day or when a webhook arrives, update the CRM" }).trigger.kind).toBeNull();
    expect(request({ goal: "Every day or when a webhook arrives, update the CRM" }).openQuestions[0]!.question).toMatch(/a webhook or a schedule|a schedule or a webhook/);
    const vague = request({ goal: "Tidy up our invoices" });
    expect(vague.trigger).toEqual({ kind: null, source: "unknown" });
    expect(vague.openQuestions.map((q) => q.key)).toEqual(["trigger", "integrations", "outcome"]);
  });

  it("asks which app for a category no named app covers, and never treats an unknown app as known", () => {
    const read = request({ goal: "When a webhook arrives, notify the team and save the file", services: ["Zapier"] });
    expect(read.integrations.map((i) => i.category)).toEqual(["messaging", "storage"]);
    expect(read.openQuestions.map((q) => q.key)).toEqual(expect.arrayContaining(["which_messaging", "which_storage"]));
    expect(read.services).toEqual([]);
    expect(read.notes).toEqual(['"Zapier" is not an app JARVIS recognizes as an n8n node, so it was not used for matching.']);
  });

  it("takes links and n8n expressions out of the goal, and refuses a secret outright", () => {
    const read = request({ goal: "Post {{$env.SLACK_TOKEN}} updates from https://evil.example/x?id=1 to Slack" });
    expect(read.goal).toBe("Post [expression removed] updates from [link removed] to Slack");
    for (const goal of ["Use token sk-live-abcdefghijklmnop to post", "password: hunter2 for the db", "key AKIAABCDEFGHIJKLMNOP", "xoxb-1234567890-abcdefghij"]) {
      expect(validateAutomationRequest({ goal }), goal).toEqual({ ok: false, code: "SECRET_REFUSED", message: PLANNING_SECRET_MESSAGE });
    }
  });

  it("refuses a scope field, an unknown field and values outside the vocabulary", () => {
    expect(validateAutomationRequest({ goal: "x to Slack", tenantId: "org-2" })).toMatchObject({ ok: false, code: "REQUEST_SCOPE_REFUSED" });
    expect(validateAutomationRequest({ goal: "x to Slack", baseUrl: "https://n8n" })).toMatchObject({ ok: false, code: "REQUEST_SCOPE_REFUSED" });
    for (const bad of [
      { goal: "x", nodes: [] },
      { goal: "" },
      { goal: "x".repeat(501) },
      { goal: "x", trigger: "telepathy" },
      { goal: "x", integrations: ["teleport"] },
      { goal: "x", inputs: "email" },
      null,
    ]) {
      expect(validateAutomationRequest(bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    }
  });

  it("detects secrets without changing what redaction does", () => {
    expect(containsSecret("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(containsSecret("Send the weekly report to the sales channel")).toBe(false);
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });
});

describe("ranking the catalog", () => {
  it("recommends reusing a workflow that covers the request, and explains it from the criteria", () => {
    const match = rankLibraryCandidates(request(FORM_TO_SLACK_AND_SHEETS), CATALOG, FULL);
    expect(match.outcome).toBe("reuse");
    expect(match.candidates.map((c) => [c.entryId, c.fit])).toEqual([
      ["wf-lead", "reuse"],
      ["wf-alerts", "customize"],
    ]);
    const [lead, alerts] = match.candidates;
    expect(lead!.criteria).toMatchObject({
      trigger: { status: "match", found: ["form"] },
      apps: { status: "full", covered: ["Slack", "Google Sheets"], missing: [] },
      words: { status: "shared" },
      metadata: { status: "complete", missing: [] },
    });
    expect(lead!.matches).toEqual(expect.arrayContaining(["Starts on a form submission, as asked.", "Uses Slack, Google Sheets."]));
    expect(alerts!.gaps).toContain("Does not use Google Sheets.");
    expect(match.explanation).toMatch(/^"Lead form to Slack and Sheets" appears to cover the request/);
    expect(match.limitations).toEqual([PLANNING_LIMITATIONS.scope, PLANNING_LIMITATIONS.noNodes]);
  });

  it("never recommends a workflow it cannot see, or one the last complete scan did not", () => {
    const match = rankLibraryCandidates(request(FORM_TO_SLACK_AND_SHEETS), CATALOG, FULL);
    expect(match.candidates.map((c) => c.entryId)).not.toContain("wf-nonodes");
    expect(match.candidates.map((c) => c.entryId)).not.toContain("wf-gone");
  });

  it("recommends customizing when the closest covers only part of it", () => {
    const match = rankLibraryCandidates(request(FORM_TO_SLACK_AND_SHEETS), CATALOG.filter((e) => e.externalId !== "wf-lead"), FULL);
    expect(match.outcome).toBe("customize");
    expect(match.candidates[0]).toMatchObject({ entryId: "wf-alerts", fit: "customize", criteria: { apps: { status: "partial", missing: ["Google Sheets"] } } });
    expect(match.explanation).toMatch(/^No workflow covers the whole request; the closest can be customized\./);
  });

  it("says plainly that nothing fits — and that the library is empty when it is", () => {
    const noMatch = rankLibraryCandidates(request({ goal: "Every hour send a Telegram message", trigger: "schedule" }), CATALOG.slice(0, 2), { ...FULL, compared: 2 });
    expect(noMatch).toMatchObject({ outcome: "no_match", candidates: [] });
    expect(noMatch.explanation).toMatch(/^No suitable workflow found: none of the 2 compared/);
    const empty = rankLibraryCandidates(request(FORM_TO_SLACK_AND_SHEETS), [], { compared: 0, catalogTotal: 0, method: "full", complete: true });
    expect(empty).toMatchObject({ outcome: "no_match" });
    expect(empty.explanation).toMatch(/holds no workflows to compare yet/);
  });

  it("does not judge on too little: a request with nothing to compare, or a catalog without node types", () => {
    expect(rankLibraryCandidates(request({ goal: "do it" }), CATALOG, FULL)).toMatchObject({ outcome: "insufficient_evidence", candidates: [] });
    const blind = rankLibraryCandidates(request(FORM_TO_SLACK_AND_SHEETS), [CATALOG[3]!], { ...FULL, compared: 1 });
    expect(blind.outcome).toBe("insufficient_evidence");
    expect(blind.explanation).toMatch(/carried node types/);
  });

  it("reuses only when the request's own words are shared too", () => {
    const unrelated = rankLibraryCandidates(
      request({ goal: "When a contact form is submitted, ping Slack and log it to Google Sheets" }),
      [entry({ externalId: "wf-x", name: "Zebra", nodeTypes: ["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack", "n8n-nodes-base.googleSheets"] })],
      { ...FULL, compared: 1 }
    );
    expect(unrelated.candidates[0]).toMatchObject({ fit: "customize", criteria: { words: { status: "none" } } });
    expect(unrelated.candidates[0]!.gaps).toContain("Its name shares none of your words.");
  });

  it("counts only purpose words as shared — a trigger or an app named twice is not evidence", () => {
    const support = rankLibraryCandidates(request({ goal: "When a support form is submitted, notify Slack" }), CATALOG, FULL);
    // "Form alerts" and "Lead form…" share only "form", the trigger: customizable, not the same workflow.
    expect(support.outcome).toBe("customize");
    expect(support.candidates.every((c) => c.fit === "customize")).toBe(true);
    expect(support.candidates[0]!.criteria.words).toEqual({ status: "none", shared: [] });
  });

  it("does not offer a workflow to customize on its trigger alone", () => {
    const telegram = rankLibraryCandidates(request({ goal: "Every hour send a Telegram message", trigger: "schedule" }), CATALOG, FULL);
    expect(telegram).toMatchObject({ outcome: "no_match", candidates: [] });
  });

  it("is deterministic, notes a targeted search, and never echoes a link, a tag or a fingerprint", () => {
    const hostile = entry({
      externalId: "wf-h",
      name: "Lead form https://evil.example/?token=abc to Slack and Sheets",
      tags: ["lead", "SECRET-TAG-VALUE"],
      nodeTypes: ["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack", "n8n-nodes-base.googleSheets"],
    });
    const a = rankLibraryCandidates(request(FORM_TO_SLACK_AND_SHEETS), [...CATALOG, hostile], { ...FULL, method: "targeted", complete: false });
    const b = rankLibraryCandidates(request(FORM_TO_SLACK_AND_SHEETS), [hostile, ...CATALOG].reverse(), { ...FULL, method: "targeted", complete: false });
    expect(a.candidates).toEqual(b.candidates);
    expect(a.limitations).toContain(PLANNING_LIMITATIONS.targeted);
    const text = JSON.stringify(a);
    for (const leak of ["evil.example", "token=abc", "SECRET-TAG-VALUE", "ffff"]) expect(text, leak).not.toContain(leak);
  });

  it("searches a large catalog by the request's node names, trigger and words", () => {
    expect(planningSearchTerms(request(FORM_TO_SLACK_AND_SHEETS))).toEqual(["slack", "googlesheets", "formtrigger", "lead"]);
  });
});
