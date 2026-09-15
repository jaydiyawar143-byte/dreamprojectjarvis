// ---------------------------------------------------------------------------
// R-29 — what the chat shows when the model provider fails.
//
// The server's message for these failures is written for the user, so the
// store shows it as it arrived, keeps the text for a retry, and sends the turn
// exactly once. No provider failure is a reason to resend.
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

vi.mock("@/lib/surface-store", () => ({
  useSurfaceStore: {
    getState: () => ({
      activeContextKeys: () => [],
      applyDirective: vi.fn(),
    }),
  },
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
  mockListConversations.mockResolvedValue({ success: true, data: [] });
});

describe("R-29 — provider failures in the chat", () => {
  it.each([
    [
      "AI_PROVIDER_NOT_CONFIGURED",
      "AI chat is not configured on this server. An administrator needs to set the OpenAI API key and restart the API.",
    ],
    [
      "AI_PROVIDER_AUTH_FAILED",
      "The AI provider rejected this server's API key. An administrator needs to check the OpenAI API key and restart the API.",
    ],
    ["AI_PROVIDER_UNAVAILABLE", "The AI service is temporarily unavailable. Please try again in a moment."],
    [
      "CONTEXT_LENGTH_EXCEEDED",
      "This conversation is too long for the AI model. Start a new conversation or send a shorter message.",
    ],
  ])("shows %s with the server's message, once, and keeps the text for a retry", async (code, message) => {
    mockSendChatMessage.mockResolvedValue({ success: false, error: { code, message } });

    await useChatStore.getState().sendMessage("hello");

    const state = useChatStore.getState();
    expect(state.error).toBe(message);
    expect(state.sending).toBe(false);
    expect(state.lastFailedMessage).toBe("hello");
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
  });
});
