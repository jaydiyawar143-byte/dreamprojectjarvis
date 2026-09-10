"use client";

import { create } from "zustand";
import {
  listConversations,
  getConversation,
  sendChatMessage,
  type Conversation,
  type ConversationMessage,
} from "./api";
import { useSurfaceStore, surfaceDirectiveFrom } from "./surface-store";

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: ConversationMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  lastFailedMessage: string | null;

  loadConversations: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => void;
  sendMessage: (content: string) => Promise<void>;
  retryMessage: () => Promise<void>;
  clearError: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  loading: false,
  sending: false,
  error: null,
  lastFailedMessage: null,

  loadConversations: async () => {
    const res = await listConversations();
    if (res.success && res.data) {
      set({ conversations: res.data });
    }
  },

  selectConversation: async (id: string) => {
    set({ activeConversationId: id, messages: [], loading: true, error: null, lastFailedMessage: null });
    const res = await getConversation(id);
    if (res.success && res.data) {
      set({ messages: res.data.messages, loading: false });
    } else {
      set({ error: res.error?.message || "Failed to load conversation", loading: false });
    }
  },

  newConversation: () => {
    set({ activeConversationId: null, messages: [], error: null, lastFailedMessage: null });
  },

  sendMessage: async (content: string) => {
    const { activeConversationId, messages } = get();
    const userMsg: ConversationMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    set({ messages: [...messages, userMsg], sending: true, error: null, lastFailedMessage: null });

    // The surfaces already on screen go WITH the message, so the server can
    // update one instead of opening a duplicate.
    const res = await sendChatMessage(
      content,
      activeConversationId ?? undefined,
      undefined,
      useSurfaceStore.getState().activeContextKeys()
    );

    if (res.success && res.data) {
      const assistantMsg: ConversationMessage = {
        id: `temp-${Date.now()}-assistant`,
        role: "assistant",
        content: res.data.message,
        metadata: {
          ...res.data.metadata,
          ...(res.data.pendingAction && { pendingAction: res.data.pendingAction }),
        },
        createdAt: new Date().toISOString(),
      };

      // A contextual surface, if the orchestrator decided one would help.
      //
      // It rides `metadata.surface` exactly as `pendingAction` rides
      // `metadata.pendingAction`, and it is VALIDATED inside the store before
      // anything renders — a malformed directive is dropped and the user keeps
      // the text answer. Most turns carry none, which is the normal case.
      const directive = surfaceDirectiveFrom(res.data.metadata);
      if (directive) useSurfaceStore.getState().applyDirective(directive);

      const newConvId = res.data.conversationId;
      set((state) => ({
        messages: [...state.messages, assistantMsg],
        sending: false,
        activeConversationId: newConvId || state.activeConversationId,
      }));

      get().loadConversations();
    } else {
      set({
        sending: false,
        error: res.error?.message || "Failed to send message",
        lastFailedMessage: content,
      });
    }
  },

  retryMessage: async () => {
    const { lastFailedMessage } = get();
    if (lastFailedMessage) {
      await get().sendMessage(lastFailedMessage);
    }
  },

  clearError: () => set({ error: null, lastFailedMessage: null }),
}));
