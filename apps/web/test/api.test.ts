import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setTokens,
  clearTokens,
  getAccessToken,
  loadTokens,
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
  describe("Token management", () => {
    it("1. setTokens stores tokens", () => {
      setTokens("access-123", "refresh-456");
      expect(getAccessToken()).toBe("access-123");
      expect(sessionStorage.getItem("jarvis_access")).toBe("access-123");
      expect(sessionStorage.getItem("jarvis_refresh")).toBe("refresh-456");
    });

    it("2. clearTokens removes tokens", () => {
      setTokens("access-123", "refresh-456");
      clearTokens();
      expect(getAccessToken()).toBeNull();
      expect(sessionStorage.getItem("jarvis_access")).toBeNull();
    });

    it("3. loadTokens restores from sessionStorage", () => {
      sessionStorage.setItem("jarvis_access", "saved-access");
      sessionStorage.setItem("jarvis_refresh", "saved-refresh");
      loadTokens();
      expect(getAccessToken()).toBe("saved-access");
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
      setTokens("valid-token", "refresh");

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
      setTokens("my-token", "refresh");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccess({ message: "ok", conversationId: "c1" }),
      });

      await sendChatMessage("test");
      const callHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
      expect(callHeaders?.Authorization).toBe("Bearer my-token");
    });

    it("9. Network failure returns error", async () => {
      setTokens("token", "refresh");
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const res = await sendChatMessage("test");
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("NETWORK_ERROR");
    });
  });

  describe("Conversations", () => {
    it("10. List conversations", async () => {
      setTokens("token", "refresh");
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
      setTokens("token", "refresh");
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
      setTokens("expired-token", "bad-refresh");

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

  describe("Logout", () => {
    it("13. Logout clears tokens", () => {
      setTokens("token", "refresh");
      logout();
      expect(getAccessToken()).toBeNull();
      expect(sessionStorage.getItem("jarvis_access")).toBeNull();
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
