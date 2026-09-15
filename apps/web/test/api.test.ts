import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setAccessToken,
  clearTokens,
  getAccessToken,
  purgeLegacyTokenStorage,
  login,
  register,
  sendChatMessage,
  listConversations,
  getConversation,
  logout,
  type ApiResponse,
} from "../src/lib/api";

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  clearTokens();
  sessionStorage.clear();
});

afterEach(() => {
  clearTokens();
  sessionStorage.clear();
});

function mockSuccess<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

function mockError(code: string, message: string): ApiResponse {
  return {
    success: false,
    error: { code, message },
    timestamp: new Date().toISOString(),
  };
}

describe("API Client", () => {
  // UI V2 — the access token is held in memory and the refresh token lives in
  // an HttpOnly cookie. These assert the absence of persistence, which is the
  // security property, rather than the presence of it.
  describe("Token management", () => {
    it("1. setAccessToken holds the token in memory only", () => {
      setAccessToken("access-123");
      expect(getAccessToken()).toBe("access-123");
      expect(sessionStorage.getItem("jarvis_access")).toBeNull();
      expect(localStorage.getItem("jarvis_access")).toBeNull();
    });

    it("2. clearTokens removes the token", () => {
      setAccessToken("access-123");
      clearTokens();
      expect(getAccessToken()).toBeNull();
    });

    it("3. legacy tokens left by the previous build are purged", () => {
      sessionStorage.setItem("jarvis_access", "saved-access");
      sessionStorage.setItem("jarvis_refresh", "saved-refresh");
      purgeLegacyTokenStorage();
      expect(sessionStorage.getItem("jarvis_access")).toBeNull();
      expect(sessionStorage.getItem("jarvis_refresh")).toBeNull();
      expect(getAccessToken()).toBeNull();
    });
  });

  describe("Login", () => {
    it("4. Login success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockSuccess({
            user: { id: "u1", email: "a@b.com", name: "Test", role: "member", createdAt: "", updatedAt: "" },
            tokens: { accessToken: "at", refreshToken: "rt", expiresIn: 900 },
          }),
      });

      const res = await login("a@b.com", "password");
      expect(res.success).toBe(true);
      expect(res.data?.user.email).toBe("a@b.com");
      expect(res.data?.tokens.accessToken).toBe("at");
    });

    it("5. Login failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockError("AUTHENTICATION_REQUIRED", "Invalid credentials"),
      });

      const res = await login("a@b.com", "wrong");
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("AUTHENTICATION_REQUIRED");
      expect(getAccessToken()).toBeNull();
    });
  });

  describe("Register", () => {
    it("6. Register success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockSuccess({
            user: { id: "u2", email: "new@b.com", name: "New", role: "member", createdAt: "", updatedAt: "" },
            tokens: { accessToken: "at2", refreshToken: "rt2", expiresIn: 900 },
          }),
      });

      const res = await register("new@b.com", "New", "password123");
      expect(res.success).toBe(true);
      expect(res.data?.tokens.accessToken).toBe("at2");
    });
  });

  describe("Chat", () => {
    it("7. Send chat message success", async () => {
      setAccessToken("valid-token");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockSuccess({
            message: "Hello from JARVIS",
            conversationId: "conv-1",
          }),
      });

      const res = await sendChatMessage("Hi JARVIS");
      expect(res.success).toBe(true);
      expect(res.data?.message).toBe("Hello from JARVIS");
      expect(res.data?.conversationId).toBe("conv-1");
    });

    it("8. Send chat includes auth header", async () => {
      setAccessToken("my-token");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccess({ message: "ok", conversationId: "c1" }),
      });

      await sendChatMessage("test");
      const callHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
      expect(callHeaders?.Authorization).toBe("Bearer my-token");
    });

    it("9. Network failure returns error", async () => {
      setAccessToken("token");
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const res = await sendChatMessage("test");
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("NETWORK_ERROR");
    });
  });

  describe("Conversations", () => {
    it("10. List conversations", async () => {
      setAccessToken("token");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockSuccess([{ id: "c1", title: "Test Conv", userId: "u1", agentId: null, createdAt: "", updatedAt: "" }]),
      });

      const res = await listConversations();
      expect(res.success).toBe(true);
      expect(res.data).toHaveLength(1);
    });

    it("11. Get conversation with messages", async () => {
      setAccessToken("token");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          mockSuccess({
            id: "c1",
            title: "Test",
            userId: "u1",
            messages: [{ id: "m1", role: "user", content: "Hi", createdAt: "" }],
          }),
      });

      const res = await getConversation("c1");
      expect(res.success).toBe(true);
      expect(res.data?.messages).toHaveLength(1);
    });
  });

  describe("401 handling", () => {
    it("12. 401 clears tokens", async () => {
      setAccessToken("expired-token");

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: async () => mockError("AUTHENTICATION_REQUIRED", "Invalid"),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockError("AUTHENTICATION_REQUIRED", "Refresh failed"),
        });

      const res = await sendChatMessage("test");
      expect(res.success).toBe(false);
      expect(getAccessToken()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // R-29 — when the client refreshes the session and resends.
  //
  // The API answers 401 only from its authentication middleware, before any
  // handler runs, so a single resend after a successful refresh cannot repeat
  // a side effect. Every other failure — including a provider key the server
  // got wrong, which is now 503 AI_PROVIDER_AUTH_FAILED — is returned as-is,
  // sent exactly once.
  // -------------------------------------------------------------------------
  describe("R-29 — authentication retry", () => {
    const respond = (status: number, body: ApiResponse) => ({
      ok: status < 400,
      status,
      json: async () => body,
    });
    const urls = () => mockFetch.mock.calls.map((call) => String(call[0]));
    const chatCalls = () => urls().filter((url) => url.endsWith("/chat")).length;
    const refreshCalls = () => urls().filter((url) => url.includes("/auth/refresh")).length;

    it("an expired session is refreshed once and the request resent once", async () => {
      setAccessToken("expired-token");
      mockFetch
        .mockResolvedValueOnce(respond(401, mockError("AUTHENTICATION_REQUIRED", "Invalid or expired token")))
        .mockResolvedValueOnce(respond(200, mockSuccess({ accessToken: "fresh-token" })))
        .mockResolvedValueOnce(respond(200, mockSuccess({ message: "Hello", conversationId: "c1" })));

      const res = await sendChatMessage("hello");

      expect(res.success).toBe(true);
      expect(refreshCalls()).toBe(1);
      expect(chatCalls()).toBe(2);
      const retryHeaders = mockFetch.mock.calls[2]![1]?.headers as Record<string, string>;
      expect(retryHeaders.Authorization).toBe("Bearer fresh-token");
    });

    it("a second 401 after the refresh is returned, not refreshed again", async () => {
      setAccessToken("expired-token");
      mockFetch
        .mockResolvedValueOnce(respond(401, mockError("AUTHENTICATION_REQUIRED", "Invalid or expired token")))
        .mockResolvedValueOnce(respond(200, mockSuccess({ accessToken: "fresh-token" })))
        .mockResolvedValueOnce(respond(401, mockError("AUTHENTICATION_REQUIRED", "Invalid or expired token")));

      const res = await sendChatMessage("hello");

      expect(res.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(refreshCalls()).toBe(1);
      expect(chatCalls()).toBe(2);
    });

    it.each([
      [
        "a provider that rejects the server's API key",
        503,
        "AI_PROVIDER_AUTH_FAILED",
        "The AI provider rejected this server's API key. An administrator needs to check the OpenAI API key and restart the API.",
      ],
      [
        "a server with no provider configured",
        503,
        "AI_PROVIDER_NOT_CONFIGURED",
        "AI chat is not configured on this server. An administrator needs to set the OpenAI API key and restart the API.",
      ],
      ["a provider that is temporarily unavailable", 503, "AI_PROVIDER_UNAVAILABLE", "The AI service is temporarily unavailable."],
      ["a conversation too long for the model", 413, "CONTEXT_LENGTH_EXCEEDED", "This conversation is too long for the AI model."],
      ["a permission failure", 403, "AUTHORIZATION_FAILED", "Your role is not permitted to use this agent"],
    ])("%s: sent once, no session refresh, the application error returned as-is", async (_label, status, code, message) => {
      setAccessToken("valid-token");
      mockFetch.mockResolvedValueOnce(respond(status, mockError(code, message)));

      const res = await sendChatMessage("hello");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(res.error).toEqual({ code, message });
      expect(getAccessToken()).toBe("valid-token");
    });

    it("a network failure is reported once, without a session refresh", async () => {
      setAccessToken("valid-token");
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const res = await sendChatMessage("hello");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(res.error?.code).toBe("NETWORK_ERROR");
      expect(getAccessToken()).toBe("valid-token");
    });

    it("each new request gets its own single refresh", async () => {
      setAccessToken("expired-token");

      for (const turn of [1, 2]) {
        mockFetch
          .mockResolvedValueOnce(respond(401, mockError("AUTHENTICATION_REQUIRED", "Invalid or expired token")))
          .mockResolvedValueOnce(respond(200, mockSuccess({ accessToken: `fresh-${turn}` })))
          .mockResolvedValueOnce(respond(200, mockSuccess({ message: "ok", conversationId: "c1" })));

        expect((await sendChatMessage(`turn ${turn}`)).success).toBe(true);
      }

      expect(refreshCalls()).toBe(2);
      expect(chatCalls()).toBe(4);
    });
  });

  describe("Logout", () => {
    it("13. Logout revokes server-side and clears tokens", async () => {
      setAccessToken("token");
      // logout() is async in V2: it revokes the refresh token SERVER-side
      // before dropping local state. The previous version only cleared the
      // browser, leaving the session valid for its full 7 days.
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => mockSuccess({ message: "Logged out successfully" }),
      });
      await logout();
      expect(getAccessToken()).toBeNull();
      expect(sessionStorage.getItem("jarvis_access")).toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/auth/logout"),
        expect.objectContaining({ method: "POST", credentials: "include" })
      );
    });
  });

  describe("Security", () => {
    it("14. No API key in code", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const apiPath = path.resolve(__dirname, "../src/lib/api.ts");
      const content = fs.readFileSync(apiPath, "utf8");
      expect(content).not.toContain("sk-proj");
      expect(content).not.toContain("OPENAI_API_KEY");
      expect(content).not.toContain("process.env.JWT_SECRET");
    });
  });
});
