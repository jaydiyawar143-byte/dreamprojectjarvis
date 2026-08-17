"use client";

import { useEffect } from "react";
import { useChatStore } from "@/lib/chat-store";
import { useAuth } from "@/lib/auth";
import { MessageSquare, Plus, LogOut, User } from "lucide-react";

export function Sidebar() {
  const { user, logout } = useAuth();
  const { conversations, activeConversationId, loadConversations, selectConversation, newConversation } =
    useChatStore();

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  return (
    <div className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col h-screen">
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-white">JARVIS</h1>
          <button
            onClick={newConversation}
            className="p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-white transition-colors"
            title="New conversation"
          >
            <Plus size={18} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {conversations.length === 0 && (
          <p className="text-gray-500 text-sm px-2 py-4">No conversations yet</p>
        )}
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => selectConversation(conv.id)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
              activeConversationId === conv.id
                ? "bg-gray-800 text-white"
                : "text-gray-400 hover:bg-gray-800/50 hover:text-gray-200"
            }`}
          >
            <MessageSquare size={14} className="shrink-0" />
            <span className="truncate">{conv.title || "New Conversation"}</span>
          </button>
        ))}
      </div>

      <div className="p-4 border-t border-gray-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <User size={16} className="text-gray-400 shrink-0" />
            <span className="text-sm text-gray-300 truncate">{user?.name || user?.email}</span>
          </div>
          <button
            onClick={logout}
            className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-white transition-colors"
            title="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
