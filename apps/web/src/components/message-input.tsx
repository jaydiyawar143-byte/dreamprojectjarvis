"use client";

import { useState, useRef } from "react";
import { useChatStore } from "@/lib/chat-store";
import { Send } from "lucide-react";

interface Props {
  disabled: boolean;
  conversationId: string | null;
}

export function MessageInput({ disabled }: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useChatStore((s) => s.sendMessage);

  async function handleSend() {
    const text = value.trim();
    if (!text || disabled) return;
    setValue("");
    await sendMessage(text);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  return (
    <div className="border-t border-gray-800 p-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-end gap-3 bg-gray-900 rounded-xl border border-gray-700 p-3">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Message JARVIS..."
            disabled={disabled}
            rows={1}
            className="flex-1 bg-transparent text-white placeholder-gray-500 resize-none focus:outline-none text-sm leading-relaxed max-h-[200px]"
          />
          <button
            onClick={handleSend}
            disabled={disabled || !value.trim()}
            className="p-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors shrink-0"
          >
            <Send size={16} />
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-2 text-center">
          Enter to send, Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}
