// ---------------------------------------------------------------------------
// Phase 18.3B — the workflow inspection panel on the Automations page.
//
//   1. ONLY THE SANITIZED VIEW. The panel draws the server's fields; there is
//      no place for a parameter, a credential, an input name or a URL.
//   2. A PROPOSAL IS NOT A CHANGE. "Proposed — awaiting approval" and "On your
//      trigger allow-list" are different things, worded differently.
//   3. NO CONTROL THAT CANNOT DO ANYTHING. Propose only when the server says
//      this reader may; Add only for an approved proposal; never an edit,
//      activate, run or publish control.
//   4. Each state — loading, unauthorized, gone, failed, stale — is its own.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
    getWorkflowInspection: vi.fn(),
    proposeWorkflowForAllowlist: vi.fn(),
    applyWorkflowAllowlistProposal: vi.fn(),
    getWorkflowLibraryStatus: vi.fn(),
    listWorkflowLibrary: vi.fn(),
    startWorkflowLibrarySync: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import type { LibraryInspection } from "../src/lib/api";
import { WorkflowInspectionPanel } from "../src/components/automations/workflow-inspection";
import { WorkflowLibrarySection } from "../src/components/automations/workflow-library";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();
const ok = <T,>(data: T) => ({ success: true as const, data, timestamp: ts() });
const refused = (code: string, message: string) => ({ success: false as const, error: { code, message }, timestamp: ts() });

const VIEW = (over: Partial<LibraryInspection> = {}): LibraryInspection => ({
  entryId: "wf-hook",
  name: "Invoice sync — see [link removed]",
  active: true,
  presence: "present",
  versionId: "v-1",
  observedAt: "2026-10-20T08:00:00.000Z",
  trigger: { status: "derived", kinds: [{ kind: "webhook", nodeType: "n8n-nodes-base.webhook" }] },
  nodeTypes: { status: "available", items: ["n8n-nodes-base.slack", "n8n-nodes-base.webhook"], count: 4 },
  integrations: { status: "derived", categories: [{ category: "messaging", nodeTypes: ["n8n-nodes-base.slack"] }], unrecognized: ["community.thing"] },
  inputs: { available: false, reason: "Input names live in node parameters, which are not read." },
  stale: { stale: false, reason: null },
  limitations: ["Built from the catalog's stored listing metadata. n8n was not contacted, and no node's parameters, credentials or data were read."],
  inspectedAt: "2026-10-21T08:00:00.000Z",
  source: "catalog",
  allowlist: { status: "not_on_allowlist", registeredVersionId: null },
  proposal: null,
  canPropose: true,
  proposeBlockedReason: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getWorkflowInspection.mockResolvedValue(ok(VIEW()));
  mocked.proposeWorkflowForAllowlist.mockResolvedValue(
    ok({ approvalId: "apr_1", existing: false, status: "awaiting_approval" as const, entryId: "wf-hook", versionId: "v-1", expiresAt: ts() })
  );
  mocked.applyWorkflowAllowlistProposal.mockResolvedValue(ok({ entryId: "wf-hook", versionId: "v-1", outcome: "created" as const }));
});

afterEach(() => cleanup());

const panel = () => render(<WorkflowInspectionPanel entryId="wf-hook" onClose={vi.fn()} />);
const buttons = () => screen.queryAllByRole("button").map((b) => (b.textContent ?? "").toLowerCase());

describe("the panel shows only the sanitized view", () => {
  it("draws the trigger, integrations, node types, version and limits — and says inputs are not available", async () => {
    panel();
    expect((await screen.findByTestId("inspection-trigger")).textContent).toContain("webhook");
    expect(screen.getByTestId("inspection-integrations").textContent).toContain("messaging");
    expect(screen.getByTestId("inspection-integrations").textContent).toContain("1 unrecognized");
    expect(screen.getByTestId("inspection-node-types").textContent).toContain("n8n-nodes-base.slack");
    expect(screen.getByText(/Not available — Input names live in node parameters/)).toBeTruthy();
    expect(screen.getByTestId("inspection-limitations").textContent).toContain("n8n was not contacted");
    expect(document.body.innerHTML).not.toMatch(/https?:\/\//);
  });

  it("never offers to edit, activate, run, trigger or publish", async () => {
    panel();
    await screen.findByTestId("workflow-inspection");
    for (const name of buttons()) expect(name).not.toMatch(/edit|activate|run|trigger(?! allow)|execute|publish|delete/);
  });

  it("marks a stale entry as stale", async () => {
    mocked.getWorkflowInspection.mockResolvedValue(
      ok(VIEW({ presence: "missing", stale: { stale: true, reason: "This workflow was not seen in the last complete scan." }, canPropose: false, proposeBlockedReason: "Synchronize the library first." }))
    );
    panel();
    expect((await screen.findByTestId("inspection-stale")).textContent).toContain("not seen in the last complete scan");
    expect(screen.queryByRole("button", { name: /propose/i })).toBeNull();
  });
});

describe("its states", () => {
  it("loading — and nothing else until the server answers", async () => {
    let answer: (value: Awaited<ReturnType<typeof api.getWorkflowInspection>>) => void = () => undefined;
    mocked.getWorkflowInspection.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    panel();
    expect(screen.getAllByText("Inspecting the workflow…").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("workflow-inspection")).toBeNull();
    expect(screen.queryByRole("button", { name: /propose|add to/i })).toBeNull();
    answer(ok(VIEW()));
    expect(await screen.findByTestId("inspection-trigger")).toBeTruthy();
  });

  it("unauthorized", async () => {
    mocked.getWorkflowInspection.mockResolvedValue(refused("NOT_AVAILABLE", "n8n is not available to your account."));
    panel();
    expect(await screen.findByText("Not available to your account")).toBeTruthy();
  });

  it("no longer in the library", async () => {
    mocked.getWorkflowInspection.mockResolvedValue(refused("ENTRY_NOT_FOUND", "No workflow with that id is in your organization's library."));
    panel();
    expect(await screen.findByText("No longer in the library")).toBeTruthy();
  });

  it("failed, with a retry", async () => {
    mocked.getWorkflowInspection.mockResolvedValueOnce(refused("LIBRARY_UNAVAILABLE", "The workflow library could not be read right now. Try again."));
    panel();
    expect(await screen.findByText("Could not inspect this workflow")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByTestId("inspection-trigger")).toBeTruthy();
  });

  it("unsupported metadata, shown as unknown", async () => {
    mocked.getWorkflowInspection.mockResolvedValue(
      ok(VIEW({ trigger: { status: "unavailable", kinds: [] }, nodeTypes: { status: "unavailable", items: [], count: null }, integrations: { status: "unavailable", categories: [], unrecognized: [] }, versionId: null, canPropose: false, proposeBlockedReason: "n8n did not report a version for this workflow, so a proposal could not be bound to it." }))
    );
    panel();
    expect((await screen.findByTestId("inspection-trigger")).textContent).toContain("Unknown");
    expect(screen.getByText("Not reported by n8n")).toBeTruthy();
    expect(screen.getByTestId("inspection-blocked").textContent).toContain("could not be bound");
  });
});

describe("a proposal is not a change", () => {
  it("offers Propose only when the server says so, and sends nothing but the entry", async () => {
    panel();
    fireEvent.click(await screen.findByRole("button", { name: /propose for trigger allow-list/i }));
    await waitFor(() => expect(mocked.proposeWorkflowForAllowlist).toHaveBeenCalledWith("wf-hook"));
    expect((await screen.findByTestId("inspection-notice")).textContent).toMatch(/Another owner or admin .* must approve it .* Nothing has changed yet/);
    expect(mocked.applyWorkflowAllowlistProposal).not.toHaveBeenCalled();
  });

  it("shows no Propose to a reader the server refuses, with the reason", async () => {
    mocked.getWorkflowInspection.mockResolvedValue(ok(VIEW({ canPropose: false, proposeBlockedReason: "Only an owner or admin of your organization can propose a workflow for the trigger allow-list." })));
    panel();
    expect((await screen.findByTestId("inspection-blocked")).textContent).toMatch(/owner or admin/);
    expect(screen.queryByRole("button", { name: /propose/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add to trigger allow-list/i })).toBeNull();
  });

  it("words a waiting proposal as waiting — never as added — and offers no Add", async () => {
    mocked.getWorkflowInspection.mockResolvedValue(
      ok(VIEW({ canPropose: false, proposeBlockedReason: "A proposal for this version is already waiting for approval.", proposal: { status: "awaiting_approval", approvalId: "apr_1", versionId: "v-1" } }))
    );
    panel();
    expect(await screen.findByText("Proposed — awaiting approval")).toBeTruthy();
    expect(screen.getByText("Not on your trigger allow-list")).toBeTruthy();
    expect(screen.getByText(/A proposal is not a change/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add to trigger allow-list/i })).toBeNull();
  });

  it("offers Add for an approved proposal only, with its approval id, and says added only when it was", async () => {
    mocked.getWorkflowInspection
      .mockResolvedValueOnce(ok(VIEW({ canPropose: false, proposal: { status: "approved", approvalId: "apr_7", versionId: "v-1" } })))
      .mockResolvedValue(ok(VIEW({ canPropose: false, allowlist: { status: "on_allowlist", registeredVersionId: "v-1" }, proposal: { status: "used", approvalId: "apr_7", versionId: "v-1" } })));
    panel();
    expect(await screen.findByText("Approved — ready to add")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add to trigger allow-list/i }));
    await waitFor(() => expect(mocked.applyWorkflowAllowlistProposal).toHaveBeenCalledWith("wf-hook", "apr_7"));
    expect((await screen.findByTestId("inspection-notice")).textContent).toContain("Added to your trigger allow-list");
    expect(await screen.findByText("On your trigger allow-list")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add to trigger allow-list/i })).toBeNull();
  });

  it("shows the server's refusal of an Add in its own words", async () => {
    mocked.getWorkflowInspection.mockResolvedValue(ok(VIEW({ canPropose: false, proposal: { status: "approved", approvalId: "apr_7", versionId: "v-1" } })));
    mocked.applyWorkflowAllowlistProposal.mockResolvedValue(refused("VERSION_CHANGED", "The workflow changed in n8n since it was proposed, so it was not added. Propose it again."));
    panel();
    fireEvent.click(await screen.findByRole("button", { name: /add to trigger allow-list/i }));
    expect((await screen.findByTestId("inspection-notice")).textContent).toContain("changed in n8n since it was proposed");
  });
});

describe("in the library section", () => {
  it("opens the panel from a row's Inspect", async () => {
    mocked.getWorkflowLibraryStatus.mockResolvedValue(
      ok({
        configured: true, state: "complete", canSync: false, catalog: { present: 1, missing: 0, removed: 0 }, currentScan: null,
        lastCompleteScan: { completedAt: ts(), records: 1 }, runs: [], continuation: null,
      })
    );
    mocked.listWorkflowLibrary.mockResolvedValue(
      ok({
        items: [{
          externalId: "wf-hook", name: "Invoice sync", active: true, remoteCreatedAt: null, remoteUpdatedAt: null, versionId: "v-1",
          tags: null, nodeTypes: ["n8n-nodes-base.webhook"], nodeCount: 2, presence: "present" as const, firstSeenAt: ts(), lastSeenAt: ts(),
          missingSince: null, removedAt: null,
        }],
        page: 1, limit: 25, total: 1, totalPages: 1,
      })
    );
    render(<WorkflowLibrarySection />);
    fireEvent.click(await screen.findByRole("button", { name: /inspect invoice sync/i }));
    expect(await screen.findByTestId("workflow-inspection")).toBeTruthy();
    expect(mocked.getWorkflowInspection).toHaveBeenCalledWith("wf-hook");
  });
});
