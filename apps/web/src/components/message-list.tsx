"use client";

import { useEffect, useRef } from "react";
import type { ConversationMessage } from "@/lib/api";
import { ToolExecutionCard } from "./tool-execution-card";
import { InlineApprovalCard } from "./inline-approval-card";
import { PendingActionCard, type PendingActionData } from "./pending-action-card";
import { MessageActions } from "./message-actions";
import { MessageText } from "./message-text";

interface Props {
  messages: ConversationMessage[];
  loading: boolean;
  sending: boolean;
  onRetry?: () => void;
  activeConversationId?: string | null;
}

export function MessageList({ messages, loading, sending, onRetry, activeConversationId }: Props) {
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
    // `min-h-0` is load-bearing. A flex child defaults to `min-height: auto`,
    // so with `flex-1` alone this refused to shrink below its content, grew
    // past the viewport and put a scrollbar on the DOCUMENT — the overflow rule
    // never engaged. This is the internal scroll region for messages.
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {messages.map((msg, idx) => {
          const meta = msg.metadata as Record<string, unknown> | undefined;
          const toolCalls = meta?.toolCalls as Array<{ id: string; name: string; arguments?: Record<string, unknown> }> | undefined;
          const toolResults = meta?.toolResults as Array<{ toolId: string; status: string; result?: unknown }> | undefined;
          const approval = meta?.approval as { approvalId: string; summary: string; expiresAt?: string; detailLines?: Array<{ label: string; value: string }> } | undefined;
          const pendingAction = meta?.pendingAction as PendingActionData | undefined;
          const canRetry = msg.role === "user" && idx === messages.length - 1 && onRetry;

          return (
            <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} group`}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                  msg.role === "user"
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-800 text-gray-100"
                }`}
              >
                <MessageText
                  content={msg.content}
                  className="whitespace-pre-wrap text-sm leading-relaxed"
                />

                {msg.role === "assistant" && pendingAction && pendingAction.state === "WAITING_CONFIRMATION" && (
                  <PendingActionCard
                    pendingAction={pendingAction}
                    conversationId={activeConversationId ?? ""}
                  />
                )}

                {msg.role === "assistant" && !pendingAction && toolCalls && (
                  <ToolExecutionCard toolCalls={toolCalls} toolResults={toolResults} />
                )}

                {msg.role === "assistant" && !pendingAction && approval && (
                  <InlineApprovalCard
                    approvalId={approval.approvalId}
                    summary={approval.summary}
                    expiresAt={approval.expiresAt}
                    detailLines={approval.detailLines}
                  />
                )}

                <div className="flex items-center justify-between">
                  <p className={`text-xs mt-1 ${msg.role === "user" ? "text-indigo-200" : "text-gray-500"}`}>
                    {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                  <MessageActions
                    content={msg.content}
                    role={msg.role as "user" | "assistant"}
                    onRetry={canRetry ? onRetry : undefined}
                    // S5 — rides the message metadata the API already stores.
                    traceId={
                      typeof msg.metadata?.traceId === "string"
                        ? msg.metadata.traceId
                        : undefined
                    }
                  />
                </div>
              </div>
            </div>
          );
        })}
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
