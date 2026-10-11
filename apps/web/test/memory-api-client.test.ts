// Phase 14 — what the browser actually sends for memory, projects and a new
// conversation's project. The real client functions, over a recorded fetch.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  clearTokens,
  createProject,
  getMemoryStatus,
  listMemories,
  listProjects,
  requestMemoryCorrection,
  requestMemoryForget,
  sendChatMessage,
  setMemoryLearning,
} from "../src/lib/api";

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ status: 200, ok: true, json: () => Promise.resolve({ success: true, data: {}, timestamp: new Date().toISOString() }) });
  clearTokens();
});

const lastCall = () => {
  const [url, init] = mockFetch.mock.calls.at(-1)! as [string, RequestInit];
  return { path: url.replace(/^.*\/api\/v1/, ""), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
};

describe("memory client — reading", () => {
  it("lists with paging, project, search and the expired switch — and omits what was not asked", async () => {
    await listMemories();
    expect(lastCall()).toEqual({ path: "/memories", method: "GET", body: undefined });

    await listMemories({ limit: 20, offset: 40, project: "proj-1", q: "  short captions ", includeExpired: true });
    const { path } = lastCall();
    const query = new URLSearchParams(path.split("?")[1]);
    expect(path.startsWith("/memories?")).toBe(true);
    expect(Object.fromEntries(query)).toEqual({ limit: "20", offset: "40", project: "proj-1", q: "short captions", includeExpired: "true" });

    // "all" is the server's default: it is not sent as a project id.
    await listMemories({ project: "all", offset: 0 });
    expect(lastCall().path).toBe("/memories");
  });

  it("reads the status and flips the learning switch", async () => {
    await getMemoryStatus();
    expect(lastCall()).toMatchObject({ path: "/memories/status", method: "GET" });
    await setMemoryLearning("pause");
    expect(lastCall()).toMatchObject({ path: "/memories/learning/pause", method: "POST" });
    await setMemoryLearning("resume");
    expect(lastCall()).toMatchObject({ path: "/memories/learning/resume", method: "POST" });
  });
});

describe("memory client — forgetting and correcting are requests", () => {
  it("asks for a memory to be forgotten: a POST to its own request endpoint, never a DELETE", async () => {
    await requestMemoryForget("mem 1/x");
    expect(lastCall()).toEqual({ path: "/memories/mem%201%2Fx/forget", method: "POST", body: undefined });
    expect(mockFetch.mock.calls.every(([, init]) => (init as RequestInit).method !== "DELETE")).toBe(true);
  });

  it("asks for a correction with the user's statement and nothing else", async () => {
    await requestMemoryCorrection("mem-1", "I prefer light mode");
    expect(lastCall()).toEqual({ path: "/memories/mem-1/correction", method: "POST", body: { statement: "I prefer light mode" } });
  });
});

describe("project client", () => {
  it("lists and creates projects", async () => {
    await listProjects();
    expect(lastCall()).toMatchObject({ path: "/projects", method: "GET" });
    await createProject("Alpha", "  Spring launch ");
    expect(lastCall()).toEqual({ path: "/projects", method: "POST", body: { name: "Alpha", description: "Spring launch" } });
    await createProject("Beta");
    expect(lastCall().body).toEqual({ name: "Beta" });
  });
});

describe("chat client — a project is named only when a conversation is created", () => {
  it("sends the project with the first message of a new conversation", async () => {
    await sendChatMessage("Hello", undefined, undefined, undefined, undefined, "proj-1");
    expect(lastCall().body).toMatchObject({ message: "Hello", projectId: "proj-1" });
  });

  it("never sends a project for an existing conversation, and none when none was chosen", async () => {
    await sendChatMessage("Again", "conv-1", undefined, undefined, undefined, "proj-1");
    expect("projectId" in lastCall().body).toBe(false);
    await sendChatMessage("Hello");
    expect("projectId" in lastCall().body).toBe(false);
  });
});
