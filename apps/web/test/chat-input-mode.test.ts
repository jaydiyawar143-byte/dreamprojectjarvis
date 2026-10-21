// ---------------------------------------------------------------------------
// Phase 18.2 — a spoken chat turn says so; a typed one is sent as before.
//
// The flag only narrows what the server will run (speech cannot start a
// workflow library sync), and the server also recognises its own recent
// transcripts — so a client that leaves it out widens nothing. These tests pin
// the client's half: the chat store forwards it for a voice turn, and the
// request body carries it only then.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockSendChatMessage = vi.fn();

vi.mock("@/lib/api", () => ({
  sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
  listConversations: vi.fn(async () => ({ success: true, data: [] })),
  getConversation: vi.fn(),
}));

vi.mock("@/lib/surface-store", () => ({
  useSurfaceStore: { getState: () => ({ activeContextKeys: () => [], applyDirective: vi.fn() }) },
  surfaceDirectiveFrom: () => null,
  surfaceDirectiveFromError: () => null,
}));

import { useChatStore } from "@/lib/chat-store";

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
  mockSendChatMessage.mockResolvedValue({ success: true, data: { message: "ok", conversationId: "conv-1" } });
});

describe("the chat store", () => {
  it("tells the server a voice turn was spoken", async () => {
    await useChatStore.getState().sendMessage("Sync the n8n library", { inputMode: "voice" });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
    const args = mockSendChatMessage.mock.calls[0]!;
    expect(args[0]).toBe("Sync the n8n library");
    expect(args[1]).toBe("conv-1");
    expect(args[6]).toBe("voice");
  });

  it("sends a typed turn exactly as before, with no mode at all", async () => {
    await useChatStore.getState().sendMessage("Sync the n8n library");
    const args = mockSendChatMessage.mock.calls[0]!;
    expect(args).toHaveLength(5);
    expect(args.slice(0, 4)).toEqual(["Sync the n8n library", "conv-1", undefined, []]);
  });
});

describe("the request body", () => {
  it("carries inputMode only for a spoken turn", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { message: "ok", conversationId: "c" } }), { status: 200 }));
    const original = global.fetch;
    global.fetch = fetch as unknown as typeof global.fetch;
    try {
      await actual.sendChatMessage("hello", "c", undefined, undefined, undefined, undefined, "voice");
      await actual.sendChatMessage("hello", "c");
    } finally {
      global.fetch = original;
    }
    const bodies = fetch.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies[0]).toMatchObject({ message: "hello", conversationId: "c", inputMode: "voice" });
    expect(bodies[1]).not.toHaveProperty("inputMode");
  });
});
