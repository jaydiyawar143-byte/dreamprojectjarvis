"use client";

import { create } from "zustand";
import {
  listConversations,
  getConversation,
  sendChatMessage,
  type Conversation,
  type ConversationMessage,
} from "./api";
import {
  useSurfaceStore,
  surfaceDirectiveFrom,
  surfaceDirectiveFromError,
} from "./surface-store";

/**
 * What one chat turn produced, handed back to whoever asked for it.
 *
 * The reply is RETURNED rather than left to be found in `messages`. Reading it
 * back out of the array associates an answer with a request by position, and
 * position is not identity: a turn whose reply was empty, or whose response
 * arrived after a later one, resolves to the PREVIOUS turn's answer. That is
 * how a spoken question about widgets came back as a crypto price. Callers that
 * need to act on a reply — voice above all — must be able to hold the one their
 * own request produced.
 */
export interface ChatTurnResult {
  requestId: string;
  conversationId: string | null;
  /** The assistant's answer to THIS request. Empty string if it had none. */
  reply: string;
  /** True when a newer request started before this one came back. */
  superseded: boolean;
  error: string | null;
}

interface SendOptions {
  /** Supplied by the caller so its own logs and this turn share an id. */
  requestId?: string;
  signal?: AbortSignal;
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: ConversationMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  lastFailedMessage: string | null;
  /** The most recently STARTED request. Anything older is superseded. */
  currentRequestId: string | null;
  /**
   * Bumped whenever the visible transcript is swapped out.
   *
   * A reply in flight when the user switches conversations belongs to the
   * conversation it was asked in, not to the one now on screen. Without this
   * the late answer is appended to whatever the user is reading.
   */
  conversationEpoch: number;

  loadConversations: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => void;
  sendMessage: (content: string, options?: SendOptions) => Promise<ChatTurnResult>;
  retryMessage: () => Promise<void>;
  clearError: () => void;
}

let requestCounter = 0;

function nextChatRequestId(): string {
  requestCounter += 1;
  return `chat-${requestCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  loading: false,
  sending: false,
  error: null,
  lastFailedMessage: null,
  currentRequestId: null,
  conversationEpoch: 0,

  loadConversations: async () => {
    const res = await listConversations();
    if (res.success && res.data) {
      set({ conversations: res.data });
    }
  },

  selectConversation: async (id: string) => {
    set((state) => ({
      activeConversationId: id,
      messages: [],
      loading: true,
      error: null,
      lastFailedMessage: null,
      currentRequestId: null,
      conversationEpoch: state.conversationEpoch + 1,
    }));
    const res = await getConversation(id);
    if (res.success && res.data) {
      set({ messages: res.data.messages, loading: false });
    } else {
      set({ error: res.error?.message || "Failed to load conversation", loading: false });
    }
  },

  newConversation: () => {
    set((state) => ({
      activeConversationId: null,
      messages: [],
      error: null,
      lastFailedMessage: null,
      currentRequestId: null,
      conversationEpoch: state.conversationEpoch + 1,
    }));
  },

  sendMessage: async (content: string, options: SendOptions = {}) => {
    const requestId = options.requestId ?? nextChatRequestId();
    const { activeConversationId, conversationEpoch } = get();
    const userMsg: ConversationMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    // Functional, not a captured snapshot. Two overlapping sends each used to
    // append to the array as it was when THEY started, so the later one erased
    // whatever landed in between.
    set((state) => ({
      messages: [...state.messages, userMsg],
      sending: true,
      error: null,
      lastFailedMessage: null,
      currentRequestId: requestId,
    }));

    // The surfaces already on screen go WITH the message, so the server can
    // update one instead of opening a duplicate.
    const res = await sendChatMessage(
      content,
      activeConversationId ?? undefined,
      undefined,
      useSurfaceStore.getState().activeContextKeys(),
      options.signal
    );

    // -----------------------------------------------------------------------
    // Whether this reply is still the one being waited for.
    //
    // A response that comes back after a NEWER request started must not steer
    // shared state. It is still appended to the transcript — the user asked for
    // it and deserves the answer — but it may not clear the newer request's
    // `sending` flag, may not overwrite its error, and above all may not open a
    // surface, because the panel on screen should describe the latest question.
    // -----------------------------------------------------------------------
    const superseded = get().currentRequestId !== requestId;
    const aborted = res.error?.code === "ABORTED";
    /** The transcript this turn was asked in is no longer the one on screen. */
    const orphaned = get().conversationEpoch !== conversationEpoch;

    if (res.success && res.data) {
      const assistantMsg: ConversationMessage = {
        id: `${requestId}-assistant`,
        role: "assistant",
        content: res.data.message,
        metadata: {
          ...res.data.metadata,
          ...(res.data.pendingAction && { pendingAction: res.data.pendingAction }),
          requestId,
        },
        createdAt: new Date().toISOString(),
      };

      // A contextual surface, if the orchestrator decided one would help.
      //
      // It rides `metadata.surface` exactly as `pendingAction` rides
      // `metadata.pendingAction`, and it is VALIDATED inside the store before
      // anything renders — a malformed directive is dropped and the user keeps
      // the text answer. Most turns carry none, which is the normal case.
      if (!superseded && !orphaned) {
        const directive = surfaceDirectiveFrom(res.data.metadata);
        if (directive) useSurfaceStore.getState().applyDirective(directive);
      }

      const newConvId = res.data.conversationId;
      set((state) => ({
        // Not appended when the user has moved to another transcript: the
        // answer belongs to the conversation it was asked in, and the server
        // has already stored it there.
        ...(orphaned ? {} : { messages: [...state.messages, assistantMsg] }),
        ...(superseded || orphaned ? {} : { sending: false }),
        ...(orphaned ? {} : { activeConversationId: newConvId || state.activeConversationId }),
      }));

      get().loadConversations();

      return {
        requestId,
        conversationId: newConvId || activeConversationId,
        reply: res.data.message,
        superseded: superseded || orphaned,
        error: null,
      };
    }

    // An abort is this app's own decision. It leaves no error on screen and no
    // failed message to retry — there is nothing for the user to act on.
    if (aborted) {
      if (!superseded && !orphaned) set({ sending: false });
      return {
        requestId,
        conversationId: activeConversationId,
        reply: "",
        superseded: true,
        error: null,
      };
    }

    // A failed turn can still carry a surface: "Google Maps could not be
    // reached", "no location is available". That panel is the most useful
    // thing on screen at that moment, so it is applied even though the turn
    // itself failed.
    const message = res.error?.message || "Failed to send message";
    if (!superseded && !orphaned) {
      const failureDirective = surfaceDirectiveFromError(res.error);
      if (failureDirective) useSurfaceStore.getState().applyDirective(failureDirective);

      set({
        sending: false,
        error: message,
        lastFailedMessage: content,
      });
    }

    return {
      requestId,
      conversationId: activeConversationId,
      reply: "",
      superseded: superseded || orphaned,
      error: message,
    };
  },

  retryMessage: async () => {
    const { lastFailedMessage } = get();
    if (lastFailedMessage) {
      await get().sendMessage(lastFailedMessage);
    }
  },

  clearError: () => set({ error: null, lastFailedMessage: null }),
}));
