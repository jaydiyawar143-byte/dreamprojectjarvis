// ---------------------------------------------------------------------------
// Phase 18.4 — the Automations page's planning section and draft panel.
//
//   • the four things a reader must not confuse — catalog entry, allow-listed
//     workflow, draft, live workflow — are named;
//   • a match is shown in its own terms, each candidate with its reasons and
//     gaps; "no suitable workflow" and "not enough to compare" are states of
//     their own;
//   • drafting controls appear only when the server says the reader may draft;
//   • a draft shows its status (never "validated" when it is not), its
//     version's number and hash, a readable diff, its checks — including the
//     ones that did not run — and what is still open; a credential has no
//     input; answers save a NEW version from the version shown;
//   • there is no deploy, activate, run, execute, publish or live-edit control.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DraftView, PlanningMatchView } from "@jarvis/core/automation-planning";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/automations",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    matchWorkflows: vi.fn(),
    listWorkflowDrafts: vi.fn(),
    createWorkflowDraft: vi.fn(),
    getWorkflowDraft: vi.fn(),
    reviseWorkflowDraft: vi.fn(),
    getWorkflowInspection: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import { WorkflowPlannerSection } from "../src/components/automations/workflow-planner";
import { WorkflowDraftPanel } from "../src/components/automations/workflow-draft";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();
const ok = <T,>(data: T) => ({ success: true as const, data, timestamp: ts() });
const refused = (code: string, message: string, issues?: Array<{ code: string; path: string; message: string }>) => ({
  success: false as const,
  error: { code, message, ...(issues ? { issues } : {}) },
  timestamp: ts(),
});

const HASH = "ab12cd34ef56".padEnd(64, "0");

function matchView(over: Partial<PlanningMatchView> = {}): PlanningMatchView {
  return {
    request: {
      goal: "When a lead form is submitted, post it to Slack",
      terms: ["lead"],
      trigger: { kind: "form", source: "from_goal" },
      services: [],
      integrations: [],
      inputs: [],
      outcome: null,
      notes: [],
      openQuestions: [{ key: "outcome", question: "What should have happened when it finishes?" }],
    },
    outcome: "reuse",
    explanation: '"Lead form to Slack" appears to cover the request.',
    candidates: [
      {
        entryId: "wf-lead",
        name: "Lead form to Slack",
        active: true,
        presence: "present",
        versionId: "v-1",
        fit: "reuse",
        score: 92,
        criteria: {
          trigger: { status: "match", found: ["form"] },
          apps: { status: "full", covered: ["Slack"], missing: [] },
          words: { status: "shared", shared: ["lead"] },
          metadata: { status: "complete", missing: [] },
        },
        matches: ["Starts on a form submission, as asked.", "Uses Slack."],
        gaps: ["It is inactive in n8n."],
      },
    ],
    searched: { compared: 4, catalogTotal: 4, method: "full", complete: true },
    limitations: ["Matching compares triggers, app node types and names stored in the catalog."],
    canDraft: true,
    ...over,
  };
}

function draftView(over: Partial<DraftView> = {}): DraftView {
  return {
    draftId: "draft-00000001",
    kind: "new",
    title: "Lead alerts",
    createdAt: ts(),
    latestVersion: 2,
    version: { number: 2, contentHash: HASH, createdAt: ts(), isLatest: true, statusWhenSaved: "needs_input" },
    status: "needs_input",
    content: {
      schemaVersion: 1,
      kind: "new",
      title: "Lead alerts",
      request: { goal: "x", trigger: "form", services: ["Slack"], integrations: [], inputs: [], outcome: null },
      source: null,
      questions: [{ key: "outcome", question: "What should have happened when it finishes?", answer: null }],
      notes: [],
      nodes: [
        { key: "trigger", type: "n8n-nodes-base.formTrigger", label: "Form submission", origin: "added", remove: false, settings: [] },
        { key: "check", type: "n8n-nodes-base.if", label: "If", origin: "added", remove: false, settings: [] },
        {
          key: "slack",
          type: "n8n-nodes-base.slack",
          label: "Slack",
          origin: "added",
          remove: false,
          settings: [
            { key: "channel", label: "Which channel?", kind: "value", value: null },
            { key: "credential", label: "Slack account", kind: "credential", value: null },
          ],
        },
      ],
      connections: [
        { from: "trigger", to: "check", output: 0 },
        { from: "check", to: "slack", output: 1 },
      ],
    },
    diff: {
      nodesAdded: [
        { key: "trigger", type: "n8n-nodes-base.formTrigger", label: "Form submission", kind: "trigger" },
        { key: "check", type: "n8n-nodes-base.if", label: "If", kind: "logic" },
        { key: "slack", type: "n8n-nodes-base.slack", label: "Slack", kind: "action" },
      ],
      nodesRemoved: [],
      connectionsAdded: [
        { from: "trigger", fromLabel: "Form submission", to: "check", toLabel: "If", output: 0, outputName: null },
        { from: "check", fromLabel: "If", to: "slack", toLabel: "Slack", output: 1, outputName: "false" },
      ],
      triggersAdded: [{ key: "trigger", label: "Form submission" }],
      triggersRemoved: [],
      configurationChanges: [
        { nodeKey: "slack", nodeLabel: "Slack", origin: "added", setting: "Which channel?", kind: "value", state: "needs_input" },
        { nodeKey: "slack", nodeLabel: "Slack", origin: "added", setting: "Slack account", kind: "credential", state: "configure_in_n8n" },
      ],
      untouchedSourceTypes: [],
    },
    checks: [
      { id: "node_types", status: "passed", message: "Every node is a supported n8n node type." },
      { id: "requirements", status: "pending", message: "2 items still need an answer." },
      { id: "configuration_schema", status: "not_run", message: "Not run: n8n's parameter schemas for these node types are not available to JARVIS." },
    ],
    requirements: [
      { kind: "question", key: "question.outcome", label: "What should have happened when it finishes?", state: "needs_input", nodeKey: null },
      { kind: "setting", key: "slack.channel", label: "Slack: Which channel?", state: "needs_input", nodeKey: "slack" },
      { kind: "credential", key: null, label: "Slack: Slack account", state: "configure_in_n8n", nodeKey: "slack" },
    ],
    source: null,
    history: [
      { version: 2, contentHash: HASH, status: "needs_input", createdAt: ts() },
      { version: 1, contentHash: "ff".repeat(32), status: "needs_input", createdAt: ts() },
    ],
    canRevise: true,
    ...over,
  };
}

const FORBIDDEN = /deploy|activate|\brun\b|execute|publish|trigger it|edit in n8n|go live/i;
const noForbiddenControls = () => {
  for (const button of screen.queryAllByRole("button")) expect(button.textContent ?? "", button.textContent ?? "").not.toMatch(FORBIDDEN);
};

beforeEach(() => {
  mocked.listWorkflowDrafts.mockResolvedValue(ok({ items: [], page: 1, limit: 20, total: 0, totalPages: 1 }));
  mocked.matchWorkflows.mockResolvedValue(ok(matchView()));
  mocked.createWorkflowDraft.mockResolvedValue(ok({ draft: draftView(), existing: false }));
  mocked.getWorkflowDraft.mockResolvedValue(ok(draftView()));
  mocked.reviseWorkflowDraft.mockResolvedValue(ok({ draft: draftView({ latestVersion: 3, version: { ...draftView().version, number: 3 } }), unchanged: false }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function ask(goal = "When a lead form is submitted, post it to Slack") {
  render(<WorkflowPlannerSection />);
  fireEvent.change(screen.getByLabelText("What should it do?"), { target: { value: goal } });
  fireEvent.click(screen.getByRole("button", { name: "Find workflows" }));
  return screen.findByTestId("plan-result");
}

describe("the planning section", () => {
  it("names the four things not to confuse, and offers nothing that acts on n8n", async () => {
    render(<WorkflowPlannerSection />);
    const layers = screen.getByTestId("automation-layers");
    for (const term of ["Catalog entry", "On your trigger allow-list", "Draft", "Live workflow"]) expect(layers.textContent).toContain(term);
    expect(await screen.findByText("No drafts yet")).toBeTruthy();
    noForbiddenControls();
  });

  it("shows a match in its own terms, each candidate with reasons and gaps", async () => {
    await ask();
    expect(mocked.matchWorkflows).toHaveBeenCalledWith({ goal: "When a lead form is submitted, post it to Slack" });
    expect(screen.getByText("An existing workflow appears to cover this")).toBeTruthy();
    const candidate = screen.getByTestId("candidate-wf-lead");
    expect(candidate.textContent).toContain("✓ Starts on a form submission, as asked.");
    expect(candidate.textContent).toContain("– It is inactive in n8n.");
    expect(candidate.textContent).toContain("Catalog entry");
    expect(screen.getByTestId("plan-questions").textContent).toContain("What should have happened when it finishes?");
    expect(screen.getByTestId("plan-limitations").textContent).toContain("Matching compares");
    noForbiddenControls();
  });

  it("offers a new draft over a covering workflow only as 'anyway', and says so to the server", async () => {
    await ask();
    fireEvent.click(screen.getByRole("button", { name: "Draft a new workflow anyway" }));
    await waitFor(() => expect(mocked.createWorkflowDraft).toHaveBeenCalledWith({ goal: "When a lead form is submitted, post it to Slack", kind: "new", overrideReuse: true }));
    expect(await screen.findByTestId("workflow-draft")).toBeTruthy();
  });

  it("drafts a customization bound to the candidate", async () => {
    await ask();
    fireEvent.click(screen.getByRole("button", { name: "Draft a customization" }));
    await waitFor(() =>
      expect(mocked.createWorkflowDraft).toHaveBeenCalledWith({ goal: "When a lead form is submitted, post it to Slack", kind: "customization", sourceEntryId: "wf-lead" })
    );
  });

  it("shows no drafting control when the server says this reader may not draft", async () => {
    mocked.matchWorkflows.mockResolvedValue(ok(matchView({ canDraft: false })));
    await ask();
    expect(screen.queryByRole("button", { name: /draft/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Inspect Lead form to Slack" })).toBeTruthy();
  });

  it("has a state of its own for 'no suitable workflow', with a new draft", async () => {
    mocked.matchWorkflows.mockResolvedValue(ok(matchView({ outcome: "no_match", candidates: [], explanation: "No suitable workflow found: none of the 4 compared matched." })));
    await ask();
    expect(screen.getAllByText("No suitable workflow found").length).toBeGreaterThan(0);
    expect(screen.getByText("No suitable workflow found: none of the 4 compared matched.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start a new draft" }));
    await waitFor(() => expect(mocked.createWorkflowDraft).toHaveBeenCalledWith(expect.objectContaining({ kind: "new" })));
    expect(mocked.createWorkflowDraft.mock.calls[0]![0]).not.toHaveProperty("overrideReuse");
  });

  it("has a state of its own for 'not enough to compare', asking the open questions and offering no draft", async () => {
    mocked.matchWorkflows.mockResolvedValue(
      ok(matchView({ outcome: "insufficient_evidence", candidates: [], explanation: "The request names no trigger, app or word the catalog can be compared with." }))
    );
    await ask("do it");
    expect(screen.getAllByText("Not enough to compare").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /draft/i })).toBeNull();
  });

  it("shows the server's refusal of a draft in its own words, with each issue", async () => {
    mocked.createWorkflowDraft.mockResolvedValue(
      refused("DRAFT_INVALID", "nodes[1].type: not supported (and 1 more)", [
        { code: "UNSUPPORTED_NODE_TYPE", path: "nodes[1].type", message: "not supported" },
        { code: "DISCONNECTED_NODE", path: "nodes[2]", message: "Slack is not reached from any trigger." },
      ]) as never
    );
    await ask();
    fireEvent.click(screen.getByRole("button", { name: "Draft a customization" }));
    const error = await screen.findByTestId("plan-draft-error");
    expect(error.textContent).toContain("nodes[2]: Slack is not reached from any trigger.");
  });

  it("is unauthorized as a state, not an error", async () => {
    mocked.matchWorkflows.mockResolvedValue(refused("NOT_AVAILABLE", "n8n is not available to your account.") as never);
    render(<WorkflowPlannerSection />);
    fireEvent.change(screen.getByLabelText("What should it do?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Find workflows" }));
    expect(await screen.findByText("Not available to your account")).toBeTruthy();
  });
});

describe("the draft panel", () => {
  it("says what the draft is — and never more", async () => {
    mocked.getWorkflowDraft.mockResolvedValue(ok(draftView({ status: "unverified" })));
    render(<WorkflowDraftPanel draftId="draft-00000001" onClose={vi.fn()} />);
    const panel = await screen.findByTestId("workflow-draft");
    expect(panel.textContent).toContain("Draft — not in n8n");
    expect(panel.textContent).toContain("Structure checked — not validated against n8n's node schemas");
    expect(screen.queryByText("Validated")).toBeNull();
    expect(screen.getByTestId("draft-version").textContent).toBe("Version 2 of 2 · ab12cd34ef56");
    expect(screen.getByTestId("draft-checks").textContent).toContain("Not run");
    noForbiddenControls();
  });

  it("shows the proposed change as a readable diff", async () => {
    render(<WorkflowDraftPanel draftId="draft-00000001" onClose={vi.fn()} />);
    const diff = await screen.findByTestId("draft-diff");
    for (const line of ["Add trigger: Form submission", "Add step: If", "Add step: Slack", "Connect If (false) → Slack", "Configure Slack: Slack account — configure in n8n"]) {
      expect(diff.textContent, line).toContain(line);
    }
  });

  it("asks for values, never for a credential — and saves answers as a new version from the one shown", async () => {
    render(<WorkflowDraftPanel draftId="draft-00000001" onClose={vi.fn()} />);
    const requirements = await screen.findByTestId("draft-requirements");
    expect(requirements.textContent).toContain("Slack: Slack account — configure in n8n. JARVIS never stores credentials");
    expect(screen.queryByLabelText("Slack: Slack account")).toBeNull();
    fireEvent.change(screen.getByLabelText("Slack: Which channel?"), { target: { value: "#leads" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    await waitFor(() => expect(mocked.reviseWorkflowDraft).toHaveBeenCalledWith("draft-00000001", 2, { "slack.channel": "#leads" }));
    expect((await screen.findByTestId("draft-notice")).textContent).toBe("Saved as version 3. Earlier versions are unchanged.");
  });

  it("shows a refused revision's issues", async () => {
    mocked.reviseWorkflowDraft.mockResolvedValue(
      refused("SECRET_REFUSED", "answers.slack.channel: That text looks like it contains a secret.", [
        { code: "SECRET_REFUSED", path: "answers.slack.channel", message: "That text looks like it contains a secret." },
      ]) as never
    );
    render(<WorkflowDraftPanel draftId="draft-00000001" onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Slack: Which channel?"), { target: { value: "xoxb-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    expect((await screen.findByTestId("draft-refusal")).textContent).toContain("looks like it contains a secret");
  });

  it("shows a stale customization as stale, and offers no revision", async () => {
    mocked.getWorkflowDraft.mockResolvedValue(
      ok(
        draftView({
          kind: "customization",
          status: "stale",
          canRevise: false,
          source: { entryId: "wf-alerts", versionId: "v-1", name: "Form alerts", currentVersionId: "v-2", drift: "changed" },
        })
      )
    );
    render(<WorkflowDraftPanel draftId="draft-00000001" onClose={vi.fn()} />);
    expect((await screen.findByTestId("draft-source")).textContent).toContain("It is now at version v-2 in n8n — start a new draft from it.");
    expect(screen.getByText("Stale — its source workflow changed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save as version/ })).toBeNull();
    expect(screen.queryByLabelText("Slack: Which channel?")).toBeNull();
  });

  it("opens an earlier version read-only", async () => {
    render(<WorkflowDraftPanel draftId="draft-00000001" onClose={vi.fn()} />);
    await screen.findByTestId("draft-history");
    mocked.getWorkflowDraft.mockResolvedValue(ok(draftView({ version: { ...draftView().version, number: 1, isLatest: false, contentHash: "ff".repeat(32) }, canRevise: false })));
    fireEvent.click(screen.getByRole("button", { name: /^Version 1 ·/ }));
    await waitFor(() => expect(mocked.getWorkflowDraft).toHaveBeenLastCalledWith("draft-00000001", 1));
    expect(await screen.findByText("An earlier version — read-only")).toBeTruthy();
  });

  it("loads, and says when there is no such draft", async () => {
    let answer: (value: Awaited<ReturnType<typeof api.getWorkflowDraft>>) => void = () => undefined;
    mocked.getWorkflowDraft.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<WorkflowDraftPanel draftId="draft-00000001" onClose={vi.fn()} />);
    expect(screen.getAllByText("Opening the draft…").length).toBeGreaterThan(0);
    answer(refused("DRAFT_NOT_FOUND", "No draft with that id is in your organization.") as never);
    expect(await screen.findByText("No such draft")).toBeTruthy();
  });
});
