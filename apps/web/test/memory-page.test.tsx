// ---------------------------------------------------------------------------
// Phase 14 — the Memory screen.
//
// The screen is a client for the memory API, so these tests check that it
// calls it correctly and renders what it returns. One rule is asserted again
// and again because it is the point of the screen: "Forget" and "Correct" ASK,
// and nothing is confirmed until the user presses Confirm — which is the
// existing pending-action confirmation, not a call of the screen's own.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/memory",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    listMemories: vi.fn(),
    getMemoryStatus: vi.fn(),
    setMemoryLearning: vi.fn(),
    requestMemoryForget: vi.fn(),
    requestMemoryCorrection: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    confirmPendingAction: vi.fn(),
    rejectPendingActionApi: vi.fn(),
    sendChatMessage: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import MemoryPage from "../src/app/memory/page";
import { ProjectPicker } from "../src/components/project-picker";
import { useChatStore } from "../src/lib/chat-store";
import { NAV_ITEMS } from "../src/components/dashboard/nav";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();
const ok = <T,>(data: T) => ({ success: true as const, data, timestamp: ts() });
const refused = (code: string, message: string) => ({ success: false as const, error: { code, message }, timestamp: ts() });

const MEMORY = (over: Partial<api.MemoryItem> = {}): api.MemoryItem => ({
  id: "mem-1",
  type: "PREFERENCE",
  content: "I prefer dark mode",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-03T10:00:00.000Z",
  expiresAt: "2026-12-01T10:00:00.000Z",
  expired: false,
  confidence: 0.7,
  confidenceLevel: "MEDIUM",
  projectId: null,
  legacy: false,
  provenance: { source: "USER", statements: 1, conversations: 1, revisions: 0 },
  ...over,
});

const STATUS = (over: Partial<api.MemoryStatus> = {}): api.MemoryStatus => ({
  learningPaused: false,
  vetoedSources: 0,
  active: 2,
  expired: 1,
  retention: { days: 90, purgeGraceDays: 30 },
  correctionAvailable: true,
  ...over,
});

const PAGE = (memories: api.MemoryItem[], over: Partial<api.MemoryPage> = {}): api.MemoryPage => ({ memories, total: memories.length, hasMore: false, limit: 20, offset: 0, ...over });

const REQUEST = (toolId: string, summary: string): api.MemoryRequest => ({
  pendingAction: { id: "pa-1", toolId, action: "x", expiresAt: ts() },
  conversationId: "conv-memory",
  summary,
});

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ newConversationProjectId: null, activeConversationId: null, messages: [] });
  mocked.listMemories.mockResolvedValue(
    ok(
      PAGE([
        MEMORY(),
        MEMORY({ id: "mem-2", content: "I prefer playful captions", confidence: 0.9, confidenceLevel: "HIGH", projectId: "proj-1", projectName: "Alpha", provenance: { source: "USER", statements: 3, conversations: 2, revisions: 1 } }),
      ])
    )
  );
  mocked.getMemoryStatus.mockResolvedValue(ok(STATUS()));
  mocked.listProjects.mockResolvedValue(ok({ projects: [{ id: "proj-1", name: "Alpha", description: null, createdAt: ts(), updatedAt: ts() }] }));
});

const items = () => screen.findAllByTestId("memory-item");
const item = async (text: string) => (await items()).find((node) => within(node).queryByText(text))!;
const button = (scope: HTMLElement, name: string) => within(scope).getByRole("button", { name });

// ---------------------------------------------------------------------------

describe("Memory screen — what it shows", () => {
  it("lists each memory with its type, confidence level, project, dates and where it came from", async () => {
    render(<MemoryPage />);

    const personal = await item("I prefer dark mode");
    expect(within(personal).getByText("PREFERENCE")).toBeTruthy();
    expect(within(personal).getByText("Medium confidence")).toBeTruthy();
    expect(within(personal).getByText("Personal")).toBeTruthy();
    expect(within(personal).getByText("You said this 1 time, in 1 conversation.")).toBeTruthy();
    expect(personal.textContent).toContain("Learned");
    expect(personal.textContent).toContain("Updated");
    expect(personal.textContent).toContain("Expires");

    const project = await item("I prefer playful captions");
    expect(within(project).getByText("High confidence")).toBeTruthy();
    expect(within(project).getByText("Alpha")).toBeTruthy();
    expect(within(project).getByText("You said this 3 times, in 2 conversations. Its wording was changed 1 time.")).toBeTruthy();
  });

  it("shows the controls' state: how many memories, expired ones, learning and retention", async () => {
    render(<MemoryPage />);
    await waitFor(() => {
      const values = screen.getAllByTestId("stat-value").map((n) => n.textContent);
      expect(values).toEqual(["2", "1", "On", "90 days"]);
    });
    expect(screen.getByText("Hidden; removed 30 days after expiry")).toBeTruthy();
  });

  it("marks an expired memory, an older one, and one that never expires", async () => {
    mocked.listMemories.mockResolvedValue(
      ok(
        PAGE([
          MEMORY({ id: "old", content: "An expired memory", expired: true, expiresAt: "2026-08-01T10:00:00.000Z" }),
          MEMORY({ id: "legacy", content: "An older memory", legacy: true, confidence: 0.5, confidenceLevel: "LOW", expiresAt: undefined, provenance: { source: "LEGACY", statements: 0, conversations: 0, revisions: 0 } }),
        ])
      )
    );
    render(<MemoryPage />);

    const expired = await item("An expired memory");
    expect(within(expired).getAllByText(/Expired/).length).toBeGreaterThanOrEqual(1);
    const legacy = await item("An older memory");
    expect(within(legacy).getByText("Low confidence")).toBeTruthy();
    expect(within(legacy).getByText("An older memory, learned before sources were recorded.")).toBeTruthy();
    expect(legacy.textContent).toContain("Does not expire");
  });

  it("says so when there is nothing, and offers a retry when loading fails", async () => {
    mocked.listMemories.mockResolvedValueOnce(ok(PAGE([])));
    const { unmount } = render(<MemoryPage />);
    expect(await screen.findByText("No memories here")).toBeTruthy();
    unmount();

    mocked.listMemories.mockResolvedValueOnce(refused("INTERNAL_ERROR", "The memory service is unavailable."));
    render(<MemoryPage />);
    expect(await screen.findByText("The memory service is unavailable.")).toBeTruthy();
    mocked.listMemories.mockResolvedValueOnce(ok(PAGE([MEMORY()])));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("I prefer dark mode")).toBeTruthy();
  });
});

describe("Memory screen — search, project filter and paging", () => {
  it("loads the first page of everything, without expired memories", async () => {
    render(<MemoryPage />);
    await items();
    expect(mocked.listMemories).toHaveBeenCalledWith({ limit: 20, offset: 0, project: "all", q: "", includeExpired: false });
  });

  it("searches on submit, filters by project, and can include expired memories", async () => {
    render(<MemoryPage />);
    await items();

    fireEvent.change(screen.getByLabelText("Search memories"), { target: { value: "captions" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(mocked.listMemories).toHaveBeenLastCalledWith(expect.objectContaining({ q: "captions", offset: 0 })));

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "proj-1" } });
    await waitFor(() => expect(mocked.listMemories).toHaveBeenLastCalledWith(expect.objectContaining({ project: "proj-1", q: "captions" })));

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "personal" } });
    await waitFor(() => expect(mocked.listMemories).toHaveBeenLastCalledWith(expect.objectContaining({ project: "personal" })));

    fireEvent.click(screen.getByLabelText("Show expired"));
    await waitFor(() => expect(mocked.listMemories).toHaveBeenLastCalledWith(expect.objectContaining({ includeExpired: true })));
  });

  it("pages forward and back", async () => {
    mocked.listMemories.mockResolvedValue(ok(PAGE([MEMORY()], { total: 45, hasMore: true })));
    render(<MemoryPage />);
    await items();
    expect(screen.getByText("Showing 1–1 of 45")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mocked.listMemories).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 })));
    await waitFor(() => expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(mocked.listMemories).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })));
  });
});

describe("Memory screen — pausing and resuming learning", () => {
  it("pauses, says what that means, and offers to resume", async () => {
    mocked.setMemoryLearning.mockResolvedValue(ok(STATUS({ learningPaused: true })));
    render(<MemoryPage />);
    await items();

    fireEvent.click(screen.getByRole("button", { name: "Pause learning" }));

    await waitFor(() => expect(mocked.setMemoryLearning).toHaveBeenCalledWith("pause"));
    expect(await screen.findByText("Learning is paused. What is already remembered stays.")).toBeTruthy();
    expect(screen.getAllByTestId("stat-value").map((n) => n.textContent)).toContain("Paused");

    mocked.setMemoryLearning.mockResolvedValue(ok(STATUS({ learningPaused: false })));
    fireEvent.click(screen.getByRole("button", { name: "Resume learning" }));
    await waitFor(() => expect(mocked.setMemoryLearning).toHaveBeenLastCalledWith("resume"));
  });
});

describe("Memory screen — forgetting is a request the user confirms", () => {
  it("asks first, shows what would happen, and confirms through the existing pending-action call", async () => {
    mocked.requestMemoryForget.mockResolvedValue(ok(REQUEST("memory.forget", "I'll forget this memory:\n1. I prefer dark mode\n\nReply “yes” to forget it, or “no” to keep it.")));
    mocked.confirmPendingAction.mockResolvedValue(ok({ pendingAction: {}, executionResult: { status: "completed", result: { success: true, data: { forgotten: 1 } } } }));
    render(<MemoryPage />);

    fireEvent.click(button(await item("I prefer dark mode"), "Forget"));

    const confirmation = await screen.findByTestId("memory-confirmation");
    expect(mocked.requestMemoryForget).toHaveBeenCalledWith("mem-1");
    expect(confirmation.textContent).toContain("I'll forget this memory:");
    expect(confirmation.textContent).toContain("I prefer dark mode");
    // Chat wording about replying "yes" is not shown as an instruction here.
    expect(confirmation.textContent).not.toContain("Reply “yes”");
    // Asked — not done.
    expect(mocked.confirmPendingAction).not.toHaveBeenCalled();

    fireEvent.click(button(confirmation, "Confirm"));

    await waitFor(() => expect(mocked.confirmPendingAction).toHaveBeenCalledWith("pa-1", "conv-memory"));
    expect(await screen.findByText("The memory was forgotten.")).toBeTruthy();
    expect(screen.queryByTestId("memory-confirmation")).toBeNull();
    // The list is read again from the server.
    expect(mocked.listMemories.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("Cancel rejects the pending action and confirms nothing", async () => {
    mocked.requestMemoryForget.mockResolvedValue(ok(REQUEST("memory.forget", "I'll forget this memory:\n1. I prefer dark mode")));
    mocked.rejectPendingActionApi.mockResolvedValue(ok({ message: "Action cancelled" }));
    render(<MemoryPage />);

    fireEvent.click(button(await item("I prefer dark mode"), "Forget"));
    fireEvent.click(button(await screen.findByTestId("memory-confirmation"), "Cancel"));

    await waitFor(() => expect(mocked.rejectPendingActionApi).toHaveBeenCalledWith("pa-1", "conv-memory"));
    expect(mocked.confirmPendingAction).not.toHaveBeenCalled();
    expect(await screen.findByText("Cancelled. Nothing was changed.")).toBeTruthy();
  });

  it("while one request waits, no other can be started", async () => {
    mocked.requestMemoryForget.mockResolvedValue(ok(REQUEST("memory.forget", "I'll forget this memory:\n1. I prefer dark mode")));
    render(<MemoryPage />);

    fireEvent.click(button(await item("I prefer dark mode"), "Forget"));
    await screen.findByTestId("memory-confirmation");

    for (const node of await items()) {
      expect((button(node, "Forget") as HTMLButtonElement).disabled).toBe(true);
      expect((button(node, "Correct") as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("when the confirmed action did not succeed, it says nothing was changed — in the server's words", async () => {
    mocked.requestMemoryForget.mockResolvedValue(ok(REQUEST("memory.forget", "I'll forget this memory:\n1. I prefer dark mode")));
    mocked.confirmPendingAction.mockResolvedValue(
      ok({ pendingAction: {}, executionResult: { status: "completed", result: { success: false, error: "That memory changed after you chose it, so nothing was forgotten." } } })
    );
    render(<MemoryPage />);

    fireEvent.click(button(await item("I prefer dark mode"), "Forget"));
    fireEvent.click(button(await screen.findByTestId("memory-confirmation"), "Confirm"));

    expect(await screen.findByText("That memory changed after you chose it, so nothing was forgotten.")).toBeTruthy();
    expect(screen.queryByText("The memory was forgotten.")).toBeNull();
  });
});

describe("Memory screen — correcting is a request the user confirms", () => {
  it("takes the user's own words, asks, and changes nothing until Confirm", async () => {
    mocked.requestMemoryCorrection.mockResolvedValue(ok(REQUEST("memory.correct", "I'll change this memory:\n1. I prefer dark mode\n\nto:\n“I prefer light mode”")));
    mocked.confirmPendingAction.mockResolvedValue(ok({ pendingAction: {}, executionResult: { status: "completed", result: { success: true, data: { corrected: 1 } } } }));
    render(<MemoryPage />);

    const target = await item("I prefer dark mode");
    fireEvent.click(button(target, "Correct"));
    // Nothing can be requested with an empty statement.
    expect((button(target, "Request change") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(target).getByLabelText("Corrected memory"), { target: { value: "I prefer light mode" } });
    fireEvent.click(button(target, "Request change"));

    const confirmation = await screen.findByTestId("memory-confirmation");
    expect(mocked.requestMemoryCorrection).toHaveBeenCalledWith("mem-1", "I prefer light mode");
    expect(confirmation.textContent).toContain("I prefer light mode");
    expect(mocked.confirmPendingAction).not.toHaveBeenCalled();

    fireEvent.click(button(confirmation, "Confirm"));
    await waitFor(() => expect(mocked.confirmPendingAction).toHaveBeenCalledWith("pa-1", "conv-memory"));
    expect(await screen.findByText("The memory was changed.")).toBeTruthy();
  });

  it("a statement the server will not learn is refused in the server's words, and nothing is proposed", async () => {
    mocked.requestMemoryCorrection.mockResolvedValue(refused("MEMORY_NOT_LEARNABLE", "That can't be saved as a memory."));
    render(<MemoryPage />);

    const target = await item("I prefer dark mode");
    fireEvent.click(button(target, "Correct"));
    fireEvent.change(within(target).getByLabelText("Corrected memory"), { target: { value: "Remind me tomorrow" } });
    fireEvent.click(button(target, "Request change"));

    expect(await screen.findByText("That can't be saved as a memory.")).toBeTruthy();
    expect(screen.queryByTestId("memory-confirmation")).toBeNull();
    expect(mocked.confirmPendingAction).not.toHaveBeenCalled();
  });

  it("the form can be closed without asking for anything", async () => {
    render(<MemoryPage />);
    const target = await item("I prefer dark mode");
    fireEvent.click(button(target, "Correct"));
    fireEvent.click(button(target, "Cancel"));
    expect(within(target).queryByLabelText("Corrected memory")).toBeNull();
    expect(mocked.requestMemoryCorrection).not.toHaveBeenCalled();
  });

  it("where correction is not available, the control is disabled rather than pretending", async () => {
    mocked.getMemoryStatus.mockResolvedValue(ok(STATUS({ correctionAvailable: false })));
    render(<MemoryPage />);
    const target = await item("I prefer dark mode");
    await waitFor(() => expect((button(target, "Correct") as HTMLButtonElement).disabled).toBe(true));
    expect((button(target, "Forget") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Memory screen — projects", () => {
  it("lists the user's projects and creates one by name", async () => {
    mocked.createProject.mockResolvedValue(ok({ project: { id: "proj-2", name: "Beta", description: null, createdAt: ts(), updatedAt: ts() } }));
    render(<MemoryPage />);
    await items();

    fireEvent.change(screen.getByLabelText("New project name"), { target: { value: "Beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    await waitFor(() => expect(mocked.createProject).toHaveBeenCalledWith("Beta"));
    expect(await screen.findByText(/Project “Beta” created/)).toBeTruthy();
  });

  it("a refused project is reported in the server's words", async () => {
    mocked.createProject.mockResolvedValue(refused("INVALID_REQUEST", "You already have a project with that name"));
    render(<MemoryPage />);
    await items();
    fireEvent.change(screen.getByLabelText("New project name"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByText("You already have a project with that name")).toBeTruthy();
  });
});

describe("Memory screen — it has no way to change a memory on its own", () => {
  it("the API client exports no call that deletes or edits a memory directly", () => {
    const names = Object.keys(api).filter((name) => /memor/i.test(name));
    expect(names.sort()).toEqual(["getMemoryStatus", "listMemories", "requestMemoryCorrection", "requestMemoryForget", "setMemoryLearning"]);
    expect(names.filter((name) => /delete|remove|update|edit|purge/i.test(name))).toEqual([]);
  });

  it("is reachable from the navigation", () => {
    expect(NAV_ITEMS.find((entry) => entry.href === "/memory")).toMatchObject({ label: "Memory", available: true });
  });
});

// ---------------------------------------------------------------------------
// The project a new conversation belongs to
// ---------------------------------------------------------------------------

describe("Project picker — which project a NEW conversation is in", () => {
  it("renders nothing when the user has no projects", async () => {
    mocked.listProjects.mockResolvedValue(ok({ projects: [] }));
    const { container } = render(<ProjectPicker />);
    await waitFor(() => expect(mocked.listProjects).toHaveBeenCalled());
    expect(container.querySelector("select")).toBeNull();
  });

  it("offers Personal and the user's projects, and remembers the choice for the next new conversation", async () => {
    render(<ProjectPicker />);
    const select = (await screen.findByLabelText("Project for this conversation")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Personal (no project)", "Alpha"]);
    expect(select.value).toBe("");

    fireEvent.change(select, { target: { value: "proj-1" } });
    expect(useChatStore.getState().newConversationProjectId).toBe("proj-1");
    fireEvent.change(select, { target: { value: "" } });
    expect(useChatStore.getState().newConversationProjectId).toBeNull();
  });

  it("drops a choice whose project no longer exists", async () => {
    useChatStore.setState({ newConversationProjectId: "proj-gone" });
    render(<ProjectPicker />);
    await screen.findByLabelText("Project for this conversation");
    await waitFor(() => expect(useChatStore.getState().newConversationProjectId).toBeNull());
  });

  it("the project goes with the message that STARTS a conversation, and with no later one", async () => {
    mocked.sendChatMessage.mockResolvedValue(ok({ message: "Noted.", conversationId: "conv-1" }));
    useChatStore.setState({ newConversationProjectId: "proj-1", activeConversationId: null, messages: [] });

    await useChatStore.getState().sendMessage("I prefer playful captions");
    expect(mocked.sendChatMessage.mock.calls[0]![0]).toBe("I prefer playful captions");
    expect(mocked.sendChatMessage.mock.calls[0]![1]).toBeUndefined();
    expect(mocked.sendChatMessage.mock.calls[0]![5]).toBe("proj-1");

    // The conversation now exists: its project is the server's, not sent again.
    expect(useChatStore.getState().activeConversationId).toBe("conv-1");
    await useChatStore.getState().sendMessage("And another thing");
    expect(mocked.sendChatMessage.mock.calls[1]![1]).toBe("conv-1");
    expect(mocked.sendChatMessage.mock.calls[1]).toHaveLength(5);
  });

  it("with no project chosen, a new conversation is personal: no project is sent", async () => {
    mocked.sendChatMessage.mockResolvedValue(ok({ message: "Noted.", conversationId: "conv-2" }));
    await useChatStore.getState().sendMessage("Hello");
    expect(mocked.sendChatMessage.mock.calls[0]).toHaveLength(5);
  });
});
