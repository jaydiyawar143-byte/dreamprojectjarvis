"use client";

import { useState } from "react";
import { Copy, Check, RotateCcw, ThumbsUp, ThumbsDown } from "lucide-react";
import { sendMessageFeedback, type UserFeedbackValue } from "@/lib/api";

interface Props {
  content: string;
  role: "user" | "assistant";
  onRetry?: () => void;
  /**
   * S5 — the request this answer came from.
   *
   * Absent for a user message, and absent for an assistant message that
   * predates S5 or was produced by a path that records no trace. Feedback is
   * simply not offered then, rather than sent somewhere it cannot be filed.
   */
  traceId?: string;
}

export function MessageActions({ content, role, onRetry, traceId }: Props) {
  const [copied, setCopied] = useState(false);
  // Null means NOT RATED, and that is deliberately not the same as a thumbs
  // down. Nothing here infers a rating from anything the user did or did not
  // do next — only a click counts.
  const [given, setGiven] = useState<UserFeedbackValue | null>(null);
  const [sending, setSending] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function rate(feedback: UserFeedbackValue) {
    if (!traceId || sending) return;
    setSending(true);
    // Optimistic: the signal is advisory and recording it is the only effect,
    // so a failed write costs the user nothing and is not worth an error
    // dialog. It reverts so the control does not lie about what was saved.
    setGiven(feedback);
    const res = await sendMessageFeedback(traceId, feedback);
    if (!res.success) setGiven(null);
    setSending(false);
  }

  const canRate = role === "assistant" && Boolean(traceId);

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
      {canRate && (
        <>
          <button
            onClick={() => rate("HELPFUL")}
            disabled={sending}
            aria-pressed={given === "HELPFUL"}
            className={`p-1 rounded transition-colors hover:bg-gray-700/50 ${
              given === "HELPFUL" ? "text-green-400" : "text-gray-500 hover:text-gray-300"
            }`}
            title="Helpful"
          >
            <ThumbsUp size={13} />
          </button>
          <button
            onClick={() => rate("NOT_HELPFUL")}
            disabled={sending}
            aria-pressed={given === "NOT_HELPFUL"}
            className={`p-1 rounded transition-colors hover:bg-gray-700/50 ${
              given === "NOT_HELPFUL" ? "text-amber-400" : "text-gray-500 hover:text-gray-300"
            }`}
            title="Not helpful"
          >
            <ThumbsDown size={13} />
          </button>
        </>
      )}
    </div>
  );
}
