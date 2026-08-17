"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function Home() {
  const { authenticated, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading) {
      router.push(authenticated ? "/chat" : "/login");
    }
  }, [loading, authenticated, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <p className="text-gray-400">Loading...</p>
    </div>
  );
}
