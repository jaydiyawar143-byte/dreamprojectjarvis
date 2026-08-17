"use client";

import { useEffect, useRef } from "react";
import type { ConversationMessage } from "@/lib/api";

interface Props {
  messages: ConversationMessage[];
  loading: boolean;
  sending: boolean;
}

export function MessageList({ messages, loading, sending }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-400">Loading messages...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                msg.role === "user"
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-800 text-gray-100"
              }`}
            >
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
              <p className={`text-xs mt-1 ${msg.role === "user" ? "text-indigo-200" : "text-gray-500"}`}>
                {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-gray-800 rounded-2xl px-4 py-3">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
