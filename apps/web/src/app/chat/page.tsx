"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar";
import { ChatArea } from "@/components/chat-area";

export default function ChatPage() {
  const { authenticated, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !authenticated) {
      router.push("/login");
    }
  }, [loading, authenticated, router]);

  if (loading) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-gray-950">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  if (!authenticated) return null;

  return (
    // `min-h-screen` let this grow past the viewport; `h-[100dvh]` pins it and
    // `overflow-hidden` keeps any inner overflow from reaching the document.
    // `dvh` rather than `vh` so mobile browser chrome does not push the
    // composer off-screen.
    <div className="flex h-[100dvh] overflow-hidden bg-gray-950">
      <Sidebar />
      <ChatArea />
    </div>
  );
}
