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
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  if (!authenticated) return null;

  return (
    <div className="min-h-screen flex bg-gray-950">
      <Sidebar />
      <ChatArea />
    </div>
  );
}
