"use client";

import { useState } from "react";
import { Copy, Check, RotateCcw } from "lucide-react";

interface Props {
  content: string;
  role: "user" | "assistant";
  onRetry?: () => void;
}

export function MessageActions({ content, role, onRetry }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        onClick={handleCopy}
        className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-700/50 transition-colors"
        title="Copy"
      >
        {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
      </button>
      {role === "user" && onRetry && (
        <button
          onClick={onRetry}
          className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-700/50 transition-colors"
          title="Retry"
        >
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}
