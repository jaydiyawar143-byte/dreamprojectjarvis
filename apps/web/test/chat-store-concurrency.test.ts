// ---------------------------------------------------------------------------
// Chat turn identity.
//
// `sendMessage` is the single entry point for every request in the app: the
// composer, the command centre, a surface button, and a spoken turn. It had no
// request identity at all, which showed up in three ways once two turns could
// overlap — and they overlap easily, because the chat leg regularly takes
// several seconds and occasionally tens of them.
//
//   - the reply had to be found by scanning the message array, so a caller
//     could act on someone else's answer;
//   - the user message was appended from a SNAPSHOT captured before the await,
//     so a second send erased anything that landed in between;
//   - a late reply still opened its contextual surface, replacing the panel
//     describing the question the user had since moved on to.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockSendChatMessage = vi.fn();
const mockListConversations = vi.fn();
const mockGetConversation = vi.fn();

vi.mock("@/lib/api", () => ({
  sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
  listConversations: (...args: unknown[]) => mockListConversations(...args),
  getConversation: (...args: unknown[]) => mockGetConversation(...args),
}));

const mockApplyDirective = vi.fn();
const mockDirectiveFrom = vi.fn();
const mockDirectiveFromError = vi.fn();

vi.mock("@/lib/surface-store", () => ({
  useSurfaceStore: {
    getState: () => ({
      activeContextKeys: () => [],
      applyDirective: mockApplyDirective,
    }),
  },
  surfaceDirectiveFrom: (...args: unknown[]) => mockDirectiveFrom(...args),
  surfaceDirectiveFromError: (...args: unknown[]) => mockDirectiveFromError(...args),
}));

import { useChatStore } from "@/lib/chat-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (message: string, conversationId = "conv-1", metadata?: Record<string, unknown>) => ({
  success: true,
  data: { message, conversationId, ...(metadata ? { metadata } : {}) },
});

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    conversations: [],
    activeConversationId: "conv-1",
    messages: [],
    loading: false,
    sending: false,
    error: null,
    lastFailedMessage: null,
    currentRequestId: null,
    conversationEpoch: 0,
  });
  mockListConversations.mockResolvedValue({ success: true, data: [] });
  mockDirectiveFrom.mockReturnValue(null);
  mockDirectiveFromError.mockReturnValue(null);
});

describe("a turn returns its own reply", () => {
  it("hands back the answer to THIS request, not the newest one in the array", async () => {
    mockSendChatMessage.mockResolvedValue(ok("I have four widgets."));

    const result = await useChatStore.getState().sendMessage("how many widgets do you have?");

    expect(result.reply).toBe("I have four widgets.");
    expect(result.superseded).toBe(false);
    expect(result.error).toBeNull();
  });

  it("stamps the request id on the assistant message it appended", async () => {
    mockSendChatMessage.mockResolvedValue(ok("Four."));

    const result = await useChatStore.getState().sendMessage("count them");

    const assistant = useChatStore.getState().messages.find((m) => m.role === "assistant");
    expect((assistant?.metadata as Record<string, unknown>)?.requestId).toBe(result.requestId);
  });

  it("uses a caller-supplied id so a voice turn and its chat turn share one", async () => {
    mockSendChatMessage.mockResolvedValue(ok("Four."));

    const result = await useChatStore
      .getState()
      .sendMessage("count them", { requestId: "vt-7-abcdef" });

    expect(result.requestId).toBe("vt-7-abcdef");
  });
});

describe("two overlapping turns", () => {
  it("keeps both user messages — neither erases the other", async () => {
    const slow = deferred<unknown>();
    mockSendChatMessage.mockReturnValueOnce(slow.promise);
    mockSendChatMessage.mockResolvedValueOnce(ok("Fast answer."));

    const first = useChatStore.getState().sendMessage("slow question");
    const second = useChatStore.getState().sendMessage("fast question");

    await second;
    slow.resolve(ok("Slow answer."));
    await first;

    const contents = useChatStore.getState().messages.map((m) => m.content);
    expect(contents).toContain("slow question");
    expect(contents).toContain("fast question");
    expect(contents).toContain("Fast answer.");
    expect(contents).toContain("Slow answer.");
  });

  it("tells the older turn it was superseded", async () => {
    const slow = deferred<unknown>();
    mockSendChatMessage.mockReturnValueOnce(slow.promise);
    mockSendChatMessage.mockResolvedValueOnce(ok("Fast answer."));

    const first = useChatStore.getState().sendMessage("slow question");
    const second = useChatStore.getState().sendMessage("fast question");

    const fast = await second;
    slow.resolve(ok("Slow answer."));
    const slowResult = await first;

    expect(fast.superseded).toBe(false);
    expect(slowResult.superseded).toBe(true);
  });

  it("does not let a late reply open a surface over the newer question", async () => {
    // The panel on screen should describe what the user last asked. A surface
    // from an overtaken turn is exactly the "it answered my previous request"
    // complaint, in visual form.
    const slow = deferred<unknown>();
    mockSendChatMessage.mockReturnValueOnce(slow.promise);
    mockSendChatMessage.mockResolvedValueOnce(ok("Fast answer."));
    mockDirectiveFrom.mockReturnValue({ op: "close", reason: "test" });

    const first = useChatStore.getState().sendMessage("solana ka price");
    await useChatStore.getState().sendMessage("how many widgets");

    expect(mockApplyDirective).toHaveBeenCalledTimes(1);

    slow.resolve(ok("Solana is at 99 dollars.", "conv-1", { surface: {} }));
    await first;

    expect(mockApplyDirective).toHaveBeenCalledTimes(1);
  });

  it("does not let a late failure overwrite the newer turn's state", async () => {
    const slow = deferred<unknown>();
    mockSendChatMessage.mockReturnValueOnce(slow.promise);
    mockSendChatMessage.mockResolvedValueOnce(ok("Fast answer."));

    const first = useChatStore.getState().sendMessage("slow question");
    await useChatStore.getState().sendMessage("fast question");

    slow.resolve({ success: false, error: { code: "TOOL_FAILED", message: "Data retrieval failed." } });
    await first;

    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().lastFailedMessage).toBeNull();
  });
});

describe("cancellation", () => {
  it("passes the caller's abort signal to the request", async () => {
    mockSendChatMessage.mockResolvedValue(ok("Four."));
    const controller = new AbortController();

    await useChatStore.getState().sendMessage("count them", { signal: controller.signal });

    expect(mockSendChatMessage).toHaveBeenCalledWith(
      "count them",
      "conv-1",
      undefined,
      [],
      controller.signal
    );
  });

  it("reports an abort as cancelled rather than as a network failure", async () => {
    mockSendChatMessage.mockResolvedValue({
      success: false,
      error: { code: "ABORTED", message: "Request was cancelled" },
    });

    const result = await useChatStore.getState().sendMessage("never mind");

    expect(result.superseded).toBe(true);
    expect(result.error).toBeNull();
    // Nothing for the user to see or retry: they cancelled it themselves.
    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().lastFailedMessage).toBeNull();
    expect(useChatStore.getState().sending).toBe(false);
  });
});

describe("switching conversations mid-flight", () => {
  it("does not append a late reply into the transcript now on screen", async () => {
    const slow = deferred<unknown>();
    mockSendChatMessage.mockReturnValue(slow.promise);
    mockGetConversation.mockResolvedValue({
      success: true,
      data: { messages: [{ id: "m1", role: "user", content: "older thread", createdAt: "" }] },
    });

    const pending = useChatStore.getState().sendMessage("about conversation one");
    await useChatStore.getState().selectConversation("conv-2");

    slow.resolve(ok("An answer about conversation one.", "conv-1"));
    const result = await pending;

    expect(result.superseded).toBe(true);
    const contents = useChatStore.getState().messages.map((m) => m.content);
    expect(contents).not.toContain("An answer about conversation one.");
    expect(useChatStore.getState().activeConversationId).toBe("conv-2");
  });
});
