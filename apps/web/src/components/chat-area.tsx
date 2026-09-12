"use client";

import { useChatStore } from "@/lib/chat-store";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { AlertCircle, X, RefreshCw } from "lucide-react";

export function ChatArea() {
  const { messages, loading, sending, error, clearError, activeConversationId, retryMessage, lastFailedMessage } =
    useChatStore();

  return (
    // `h-full min-h-0` rather than `h-screen`: the parent already owns the
    // viewport height, and `min-h-0` is what lets the message list inside
    // actually shrink and scroll instead of growing the page.
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {error && (
        <div className="bg-red-900/30 border border-red-800 text-red-300 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} className="shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
          <div className="flex items-center gap-2">
            {lastFailedMessage && (
              <button
                onClick={retryMessage}
                className="flex items-center gap-1 text-xs text-red-300 hover:text-red-200 bg-red-800/40 px-2 py-1 rounded transition-colors"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            )}
            <button onClick={clearError} className="text-red-400 hover:text-red-300">
              <X size={16} />
            </button>
          </div>
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
        <MessageList messages={messages} loading={loading} sending={sending} onRetry={retryMessage} activeConversationId={activeConversationId} />
      )}

      <MessageInput disabled={sending} conversationId={activeConversationId} />
    </div>
  );
}
