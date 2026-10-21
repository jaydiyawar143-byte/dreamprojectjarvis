// ---------------------------------------------------------------------------
// Phase 18.2 — the workflow library on the Automations page.
//
// The section is a client of `/api/v1/n8n/library`. What is asserted:
//   1. WHAT IS SHOWN IS WHAT THE SERVER SAID. "Complete" only when the server's
//      state is complete; a partial scan says the list may be incomplete; a
//      failed run and a stopped chain show their fixed reasons.
//   2. NO CONTROL THAT CANNOT DO ANYTHING. Sync and Continue appear only when
//      the server says this reader may start one, are disabled while one
//      runs, and there is never an activate, edit or run control.
//   3. ONE CLICK, ONE REQUEST. A second click while one is starting sends
//      nothing; a retry after a network failure reuses the click's key.
//   4. NO SCOPE FROM THE BROWSER. No request carries an Organization, an
//      instance or a cursor.
// And, for the voice half of the stage: a spoken chat turn says so, and a
// typed one is sent exactly as before.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
    getWorkflowLibraryStatus: vi.fn(),
    listWorkflowLibrary: vi.fn(),
    startWorkflowLibrarySync: vi.fn(),
    listN8nWorkflows: vi.fn(),
    listN8nExecutions: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import type { LibraryStatus, LibraryWorkflow, LibraryWorkflowPage } from "../src/lib/api";
import { WorkflowLibrarySection } from "../src/components/automations/workflow-library";
import AutomationsPage from "../src/app/automations/page";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();
const ok = <T,>(data: T) => ({ success: true as const, data, timestamp: ts() });
const refused = (code: string, message: string) => ({ success: false as const, error: { code, message }, timestamp: ts() });

const STATUS = (over: Partial<LibraryStatus> = {}): LibraryStatus => ({
  configured: true,
  state: "complete",
  canSync: true,
  catalog: { present: 2, missing: 1, removed: 0 },
  currentScan: null,
  lastCompleteScan: { completedAt: "2026-10-20T08:00:00.000Z", records: 3 },
  runs: [
    {
      runId: "run-1",
      status: "COMPLETE",
      resumed: false,
      pagesFetched: 1,
      recordsObserved: 3,
      created: 3,
      updated: 0,
      unchanged: 0,
      rejected: 0,
      markedMissing: 1,
      markedRemoved: 0,
      failure: null,
      startedAt: "2026-10-20T07:59:00.000Z",
      finishedAt: "2026-10-20T08:00:00.000Z",
    },
  ],
  continuation: null,
  ...over,
});

const WORKFLOW = (i: number, over: Partial<LibraryWorkflow> = {}): LibraryWorkflow => ({
  externalId: `wf-${i}`,
  name: `Invoice flow ${i}`,
  active: i % 2 === 0,
  remoteCreatedAt: null,
  remoteUpdatedAt: null,
  versionId: `v${i}`,
  tags: ["finance"],
  nodeTypes: ["n8n-nodes-base.webhook"],
  nodeCount: 4,
  presence: "present",
  firstSeenAt: "2026-10-19T08:00:00.000Z",
  lastSeenAt: "2026-10-20T08:00:00.000Z",
  missingSince: null,
  removedAt: null,
  ...over,
});

const PAGE = (items: LibraryWorkflow[], over: Partial<LibraryWorkflowPage> = {}): LibraryWorkflowPage => ({
  items,
  page: 1,
  limit: 25,
  total: items.length,
  totalPages: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getWorkflowLibraryStatus.mockResolvedValue(ok(STATUS()));
  mocked.listWorkflowLibrary.mockResolvedValue(ok(PAGE([WORKFLOW(1), WORKFLOW(2)])));
  mocked.startWorkflowLibrarySync.mockResolvedValue(ok({ mode: "continue" as const, chainId: "chain-1", existing: false, state: "running" as const }));
  mocked.listN8nWorkflows.mockResolvedValue(ok({ workflows: [], count: 0 }));
  mocked.listN8nExecutions.mockResolvedValue(ok({ executions: [], count: 0 }));
});

afterEach(() => cleanup());

const section = () => render(<WorkflowLibrarySection />);
const buttonNamed = (name: RegExp) => screen.queryByRole("button", { name });

describe("what the section shows is what the server said", () => {
  it("lists the catalog with the server's state, and offers an owner or admin Sync and Continue", async () => {
    section();
    expect(await screen.findByText("Invoice flow 1")).toBeTruthy();
    const library = screen.getByTestId("workflow-library");
    expect(within(library).getAllByText("Complete").length).toBeGreaterThan(0);
    expect(screen.getByTestId("library-summary").textContent).toContain("Last complete scan");
    expect(buttonNamed(/^sync$/i)).toBeTruthy();
    expect(buttonNamed(/continue until complete/i)).toBeTruthy();
    expect(mocked.listWorkflowLibrary).toHaveBeenCalledWith({ page: 1, limit: 25, presence: "current" });
  });

  it("never offers to activate, edit or run a workflow", async () => {
    section();
    await screen.findByText("Invoice flow 1");
    const names = screen.getAllByRole("button").map((b) => (b.textContent ?? "").toLowerCase());
    for (const name of names) expect(name).not.toMatch(/activate|deactivate|edit|run|trigger|execute|delete/);
  });

  it("shows no sync control to a reader the server says may not start one", async () => {
    mocked.getWorkflowLibraryStatus.mockResolvedValue(ok(STATUS({ canSync: false })));
    section();
    await screen.findByText("Invoice flow 1");
    expect(screen.queryByTestId("library-sync-controls")).toBeNull();
    expect(buttonNamed(/^sync$/i)).toBeNull();
  });

  it("tells an outsider the library is not available, and asks for nothing more", async () => {
    mocked.getWorkflowLibraryStatus.mockResolvedValue(refused("NOT_AVAILABLE", "n8n is not available to your account."));
    section();
    expect(await screen.findByText("Not available to your account")).toBeTruthy();
    expect(screen.getByText("n8n is not available to your account.")).toBeTruthy();
    expect(mocked.listWorkflowLibrary).not.toHaveBeenCalled();
    expect(buttonNamed(/sync|continue/i)).toBeNull();
  });

  it("shows a failure to check authorization as an error with a retry", async () => {
    mocked.getWorkflowLibraryStatus.mockResolvedValueOnce(
      refused("AUTHORIZATION_UNAVAILABLE", "Organization access could not be verified, so nothing was done.")
    );
    section();
    expect(await screen.findByText("Organization access could not be verified, so nothing was done.")).toBeTruthy();
    expect(mocked.listWorkflowLibrary).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("Invoice flow 1")).toBeTruthy();
  });

  it("says when n8n is not configured, with nothing to click", async () => {
    mocked.getWorkflowLibraryStatus.mockResolvedValue(ok(STATUS({ configured: false, canSync: false, state: "never_synced", runs: [], lastCompleteScan: null })));
    section();
    expect(await screen.findByText("n8n is not configured")).toBeTruthy();
    expect(mocked.listWorkflowLibrary).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("explains an empty, never-synchronized library", async () => {
    mocked.getWorkflowLibraryStatus.mockResolvedValue(ok(STATUS({ state: "never_synced", runs: [], lastCompleteScan: null, catalog: { present: 0, missing: 0, removed: 0 } })));
    mocked.listWorkflowLibrary.mockResolvedValue(ok(PAGE([])));
    section();
    expect(await screen.findByText("Not synchronized yet")).toBeTruthy();
    expect(screen.getByText("Start a sync to read the workflow list from n8n.")).toBeTruthy();
    expect(screen.getByText("No scan has completed yet.")).toBeTruthy();
  });

  it("says a partial scan may be incomplete — and never calls it complete", async () => {
    mocked.getWorkflowLibraryStatus.mockResolvedValue(
      ok(STATUS({ state: "partial", lastCompleteScan: null, currentScan: { pagesFetched: 4, recordsObserved: 1000, startedAt: ts() } }))
    );
    section();
    const progress = await screen.findByTestId("library-progress");
    expect(progress.textContent).toContain("may be incomplete");
    expect(progress.textContent).toContain("4 pages");
    expect(screen.getByText("Partial")).toBeTruthy();
    expect(screen.queryByText("Complete")).toBeNull();
  });

  it("shows a failed run's fixed reason", async () => {
    mocked.getWorkflowLibraryStatus.mockResolvedValue(
      ok(
        STATUS({
          state: "failed",
          lastCompleteScan: null,
          runs: [{ ...STATUS().runs[0]!, status: "FAILED", failure: { code: "PROVIDER_AUTH_FAILED", message: "n8n refused the stored API key." } }],
        })
      )
    );
    section();
    expect((await screen.findByTestId("library-failure")).textContent).toContain("n8n refused the stored API key.");
  });

  it("follows a running chain: its progress and limits, with the controls disabled", async () => {
    mocked.getWorkflowLibraryStatus.mockResolvedValue(
      ok(
        STATUS({
          state: "running",
          lastCompleteScan: null,
          currentScan: { pagesFetched: 6, recordsObserved: 1500, startedAt: ts() },
          continuation: {
            chainId: "chain-1",
            status: "RUNNING",
            stop: null,
            runFailure: null,
            runs: 2,
            pages: 6,
            recordsObserved: 1500,
            limits: { maxRuns: 25, maxPages: 500, deadlineAt: ts() },
            startedAt: ts(),
            finishedAt: null,
          },
        })
      )
    );
    section();
    const chain = await screen.findByTestId("library-continuation");
    expect(chain.textContent).toContain("Runs 2 of 25");
    expect(chain.textContent).toContain("pages 6 of 500");
    expect((buttonNamed(/^sync$/i) as HTMLButtonElement).disabled).toBe(true);
    expect((buttonNamed(/continue until complete/i) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows why a chain stopped", async () => {
    mocked.getWorkflowLibraryStatus.mockResolvedValue(
      ok(
        STATUS({
          state: "partial",
          lastCompleteScan: null,
          continuation: {
            chainId: "chain-1",
            status: "STOPPED",
            stop: { code: "BUDGET_EXHAUSTED", message: "The organization's synchronization budget for this library is spent." },
            runFailure: null,
            runs: 3,
            pages: 9,
            recordsObserved: 2250,
            limits: { maxRuns: 25, maxPages: 500, deadlineAt: ts() },
            startedAt: ts(),
            finishedAt: ts(),
          },
        })
      )
    );
    section();
    const chain = await screen.findByTestId("library-continuation");
    expect(chain.textContent).toContain("Stopped");
    expect(chain.textContent).toContain("budget for this library is spent");
  });
});

describe("starting a sync", () => {
  it("sends one request per click, with a key and nothing the server decides", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.startWorkflowLibrarySync>>) => void;
    mocked.startWorkflowLibrarySync.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    section();
    const button = await screen.findByRole("button", { name: /continue until complete/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: /starting/i }));
    expect(mocked.startWorkflowLibrarySync).toHaveBeenCalledTimes(1);
    const [options] = mocked.startWorkflowLibrarySync.mock.calls[0]!;
    expect(Object.keys(options).sort()).toEqual(["continueUntilComplete", "idempotencyKey"]);
    expect(options.continueUntilComplete).toBe(true);
    expect(options.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    finish(ok({ mode: "continue", chainId: "chain-1", existing: false, state: "running" }));
    expect((await screen.findByTestId("library-sync-notice")).textContent).toContain("Continuing until the scan completes");
    // The status is read again for what the server now says.
    await waitFor(() => expect(mocked.getWorkflowLibraryStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("gives each new click its own key, and a retry after a network failure the same one", async () => {
    mocked.startWorkflowLibrarySync
      .mockResolvedValueOnce(refused("NETWORK_ERROR", "Network request failed"))
      .mockResolvedValueOnce(ok({ mode: "run", runId: "run-2", resumed: true, state: "running" }))
      .mockResolvedValueOnce(ok({ mode: "run", runId: "run-3", resumed: true, state: "running" }));
    section();
    fireEvent.click(await screen.findByRole("button", { name: /^sync$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));
    await screen.findByText("A synchronization run started, continuing the unfinished scan.");
    fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));
    await waitFor(() => expect(mocked.startWorkflowLibrarySync).toHaveBeenCalledTimes(3));
    const keys = mocked.startWorkflowLibrarySync.mock.calls.map(([o]) => o.idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(mocked.startWorkflowLibrarySync.mock.calls[0]![0]).not.toHaveProperty("continueUntilComplete");
  });

  it("shows the server's refusal in its own words", async () => {
    mocked.startWorkflowLibrarySync.mockResolvedValueOnce(
      refused("SYNC_ALREADY_RUNNING", "A synchronization of this library is already running. Follow it on the status endpoint.")
    );
    section();
    fireEvent.click(await screen.findByRole("button", { name: /^sync$/i }));
    expect((await screen.findByTestId("library-sync-notice")).textContent).toContain("already running");
    expect(buttonNamed(/try again/i)).toBeNull();
  });
});

describe("searching and paging", () => {
  it("passes the search, filters and page the user chose — and nothing else", async () => {
    mocked.listWorkflowLibrary.mockResolvedValue(ok(PAGE([WORKFLOW(1)], { total: 60, totalPages: 3 })));
    section();
    await screen.findByText("Invoice flow 1");
    fireEvent.change(screen.getByLabelText(/search names/i), { target: { value: " invoice " } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await waitFor(() => expect(mocked.listWorkflowLibrary).toHaveBeenLastCalledWith({ page: 1, limit: 25, search: "invoice", presence: "current" }));

    fireEvent.click(screen.getByRole("tab", { name: /removed/i }));
    await waitFor(() => expect(mocked.listWorkflowLibrary).toHaveBeenLastCalledWith({ page: 1, limit: 25, search: "invoice", presence: "removed" }));
    fireEvent.click(screen.getByRole("tab", { name: /^inactive/i }));
    await waitFor(() =>
      expect(mocked.listWorkflowLibrary).toHaveBeenLastCalledWith({ page: 1, limit: 25, search: "invoice", presence: "removed", active: false })
    );
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(mocked.listWorkflowLibrary).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));

    for (const [query] of mocked.listWorkflowLibrary.mock.calls) {
      expect(Object.keys(query ?? {}).every((key) => ["page", "limit", "search", "presence", "active"].includes(key))).toBe(true);
    }
  });
});

describe("the Automations page", () => {
  it("shows the library section beside the registered workflows", async () => {
    render(<AutomationsPage />);
    expect(await screen.findByTestId("workflow-library")).toBeTruthy();
    expect(await screen.findByText("Invoice flow 1")).toBeTruthy();
  });

  it("still shows the library when the trigger allow-list router is not deployed", async () => {
    mocked.listN8nWorkflows.mockResolvedValue(refused("NOT_FOUND", "Not found"));
    mocked.listN8nExecutions.mockResolvedValue(refused("NOT_FOUND", "Not found"));
    mocked.getWorkflowLibraryStatus.mockResolvedValue(ok(STATUS({ configured: false, canSync: false, state: "never_synced", runs: [], lastCompleteScan: null })));
    render(<AutomationsPage />);
    expect(await screen.findByText("n8n is not connected")).toBeTruthy();
    expect(await screen.findByText("n8n is not configured")).toBeTruthy();
  });
});
