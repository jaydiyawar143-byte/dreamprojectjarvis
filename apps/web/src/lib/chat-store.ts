"use client";

import { create } from "zustand";
import {
  listConversations,
  getConversation,
  sendChatMessage,
  type Conversation,
  type ConversationMessage,
} from "./api";

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: ConversationMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;

  loadConversations: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => void;
  sendMessage: (content: string) => Promise<void>;
  clearError: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  loading: false,
  sending: false,
  error: null,

  loadConversations: async () => {
    const res = await listConversations();
    if (res.success && res.data) {
      set({ conversations: res.data });
    }
  },

  selectConversation: async (id: string) => {
    set({ activeConversationId: id, messages: [], loading: true, error: null });
    const res = await getConversation(id);
    if (res.success && res.data) {
      set({ messages: res.data.messages, loading: false });
    } else {
      set({ error: res.error?.message || "Failed to load conversation", loading: false });
    }
  },

  newConversation: () => {
    set({ activeConversationId: null, messages: [], error: null });
  },

  sendMessage: async (content: string) => {
    const { activeConversationId, messages } = get();
    const userMsg: ConversationMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    set({ messages: [...messages, userMsg], sending: true, error: null });

    const res = await sendChatMessage(content, activeConversationId ?? undefined);

    if (res.success && res.data) {
      const assistantMsg: ConversationMessage = {
        id: `temp-${Date.now()}-assistant`,
        role: "assistant",
        content: res.data.message,
        createdAt: new Date().toISOString(),
      };

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
      });
    }
  },

  clearError: () => set({ error: null }),
}));
