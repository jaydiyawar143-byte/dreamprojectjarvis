"use client";

import { useChatStore } from "@/lib/chat-store";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { AlertCircle, X } from "lucide-react";

export function ChatArea() {
  const { messages, loading, sending, error, clearError, activeConversationId } =
    useChatStore();

  return (
    <div className="flex-1 flex flex-col h-screen">
      {error && (
        <div className="bg-red-900/30 border border-red-800 text-red-300 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} />
            <span className="text-sm">{error}</span>
          </div>
          <button onClick={clearError} className="text-red-400 hover:text-red-300">
            <X size={16} />
          </button>
        </div>
      )}

      {messages.length === 0 && !loading && !sending ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-2xl font-semibold text-gray-300 mb-2">JARVIS</h2>
            <p className="text-gray-500">How can I help you today?</p>
          </div>
        </div>
      ) : (
        <MessageList messages={messages} loading={loading} sending={sending} />
      )}

      <MessageInput disabled={sending} conversationId={activeConversationId} />
    </div>
  );
}
