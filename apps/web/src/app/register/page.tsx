"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import Link from "next/link";

export default function RegisterPage() {
  const { register } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const result = await register(email, name, password);
    setLoading(false);
    if (result.error) setError(result.error);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="w-full max-w-md p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">JARVIS</h1>
          <p className="text-gray-400 mt-2">Create your account</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              placeholder="Full Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <input
              type="password"
              placeholder="Password (min 8 characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
            />
          </div>
          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-800 text-white rounded-lg font-medium transition-colors"
          >
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>
        <p className="text-center text-gray-500 mt-6">
          Already have an account?{" "}
          <Link href="/login" className="text-indigo-400 hover:text-indigo-300">
            Sign In
          </Link>
        </p>
      </div>
    </div>
  );
}
