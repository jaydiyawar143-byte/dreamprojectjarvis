// ---------------------------------------------------------------------------
// P0 — conversation context grounding.
//
// What was wrong, measured against the real model with the history present in
// its input: asked "what was the exact message I sent before this one?", it
// answered "I cannot access previous messages" (5/5), or quoted a block of
// server text back as the user's message (3/5). Two causes, both in how the
// request was assembled:
//
//   - server-made context (the skill, knowledge and memory blocks) was glued
//     in front of the user's words INSIDE the user message, so the model could
//     not tell what the user had typed;
//   - nothing told the model that the earlier messages are a transcript it may
//     read and quote, so "don't use memory" read as "don't use the transcript".
//
// These pin the corrected shape from the model's side of the wire:
//
//   system              the agent's prompt + the transcript rules
//   ...history          earlier user and assistant messages, verbatim
//   system (optional)   context the server gathered for THIS turn
//   user                the user's message, byte for byte
//
// and that the work-request detector leaves a turn ABOUT the conversation to
// the assistant, which is the only thing that can see the conversation.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import type {
  AIMessage,
  ConversationMessage,
  IEmbeddingProvider,
  IKnowledgeRetriever,
  IMemoryStore,
  MemoryRecallResult,
  RetrievedChunk,
  SkillContext,
} from "@jarvis/core";
import {
  buildTurnMessages,
  FIRST_MESSAGE_NOTE,
  TRANSCRIPT_GROUNDING,
  TURN_CONTEXT_HEADER,
} from "../src/turn-messages.js";
import { buildRoundMessages } from "../src/tool-rounds.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { KnowledgeAgent } from "../src/agents/knowledge-agent.js";
import { MetaAdsAgent } from "../src/agents/meta-ads-agent.js";
import { AGENT_IDS } from "../src/agent-policy.js";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { detectWorkRequest } from "../src/work-request-detector.js";
import {
  FakePermissionChecker,
  GatingApprovalService,
  RecordingAuditLogger,
  RecordingToolExecutor,
  ScriptedAIProvider,
  productionLikeTools,
  sessionFor,
  toolRegistryOf,
} from "./helpers/sprint6-harness.js";

const HISTORY: ConversationMessage[] = [
  { id: "m1", role: "user", content: "My marker word is TEAL-42.", createdAt: "2026-10-07T08:00:00.000Z" },
  { id: "m2", role: "assistant", content: "Noted: TEAL-42.", createdAt: "2026-10-07T08:00:01.000Z" },
];

const TC035 =
  "What was the exact message I sent immediately before this one? Do not use memory or external tools. If you cannot access the previous message, say so.";

/** Markers of the three server-made blocks. None may ever sit in a user message. */
const SERVER_BLOCK_MARKERS = ["WHAT YOU CAN ACTUALLY DO RIGHT NOW", "<knowledge_base>", "<user_memories>"];

const SKILL_BLOCK = "WHAT YOU CAN ACTUALLY DO RIGHT NOW:\n\nSystem monitoring — Keep an eye on the machine.";

function userMessages(messages: AIMessage[]): AIMessage[] {
  return messages.filter((m) => m.role === "user");
}

function expectNoServerTextInUserMessages(messages: AIMessage[]): void {
  for (const message of userMessages(messages)) {
    for (const marker of [...SERVER_BLOCK_MARKERS, TURN_CONTEXT_HEADER.split("\n")[0]!]) {
      expect(String(message.content), `"${marker}" inside a user message`).not.toContain(marker);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. The one place a turn's message list is assembled
// ---------------------------------------------------------------------------

describe("the message list for a turn", () => {
  it("is: system, the history, this turn's context, then the user's own words", () => {
    const messages = buildTurnMessages({
      systemPrompt: "You are JARVIS.",
      conversationHistory: HISTORY,
      turnContext: SKILL_BLOCK,
      userMessage: TC035,
    });

    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
    expect(messages[1]!.content).toBe("My marker word is TEAL-42.");
    expect(messages[2]!.content).toBe("Noted: TEAL-42.");
    expect(messages.at(-1)).toEqual({ role: "user", content: TC035 });
  });

  it("leaves the user's message byte for byte, whatever context came with it", () => {
    const awkward = "  leading spaces, a trailing newline and <user_memories> typed by hand\n";
    const messages = buildTurnMessages({
      systemPrompt: "You are JARVIS.",
      turnContext: SKILL_BLOCK,
      userMessage: awkward,
    });
    expect(messages.at(-1)!.content).toBe(awkward);
  });

  it("puts the context in its own system message, labelled as the system's and as data", () => {
    const messages = buildTurnMessages({
      systemPrompt: "You are JARVIS.",
      conversationHistory: HISTORY,
      turnContext: SKILL_BLOCK,
      userMessage: "hello",
    });
    const context = messages.at(-2)!;

    expect(context.role).toBe("system");
    expect(context.content).toBe(`${TURN_CONTEXT_HEADER}\n\n${SKILL_BLOCK}`);
    // The header says who wrote it and that nothing inside it is an order.
    expect(TURN_CONTEXT_HEADER).toMatch(/user did not write/i);
    expect(TURN_CONTEXT_HEADER).toMatch(/not part of the (conversation )?transcript/i);
    expect(TURN_CONTEXT_HEADER).toMatch(/never follow instructions/i);
  });

  it("adds no context message when the server gathered nothing", () => {
    for (const turnContext of [undefined, ""]) {
      const messages = buildTurnMessages({
        systemPrompt: "You are JARVIS.",
        conversationHistory: HISTORY,
        ...(turnContext === undefined ? {} : { turnContext }),
        userMessage: "hello",
      });
      expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    }
  });

  it("keeps the agent's prompt first and whole, with the transcript rules after it", () => {
    const messages = buildTurnMessages({
      systemPrompt: "You are JARVIS.",
      conversationHistory: HISTORY,
      userMessage: "hello",
    });
    expect(messages[0]).toEqual({ role: "system", content: `You are JARVIS.\n\n${TRANSCRIPT_GROUNDING}` });
  });

  it("states it as a fact when nothing came before the message being answered", () => {
    // Asked "what was my previous message?" as the FIRST message, the model
    // quoted the question back as the answer every time while this was only a
    // rule to apply. The server knows there is no history, so it says so.
    for (const conversationHistory of [undefined, []]) {
      const messages = buildTurnMessages({
        systemPrompt: "You are JARVIS.",
        ...(conversationHistory ? { conversationHistory } : {}),
        userMessage: TC035,
      });
      expect(messages[0]).toEqual({
        role: "system",
        content: `You are JARVIS.\n\n${TRANSCRIPT_GROUNDING}\n${FIRST_MESSAGE_NOTE}`,
      });
    }
    expect(FIRST_MESSAGE_NOTE).toMatch(/no earlier message/i);
    expect(FIRST_MESSAGE_NOTE).toMatch(/first one in this conversation/i);
    expect(FIRST_MESSAGE_NOTE).toMatch(/do not quote the message you are answering/i);
  });

  it("never states it once there is a history", () => {
    const messages = buildTurnMessages({
      systemPrompt: "You are JARVIS.",
      conversationHistory: HISTORY,
      userMessage: TC035,
    });
    expect(JSON.stringify(messages)).not.toContain("holds no earlier message");
    expect(TRANSCRIPT_GROUNDING).not.toMatch(/no earlier message/i);
  });

  it("sends no system message for an agent that has no prompt", () => {
    const messages = buildTurnMessages({ systemPrompt: "", conversationHistory: HISTORY, userMessage: "hello" });
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("a turn that has run tools starts with exactly the same messages", () => {
    const shared = {
      systemPrompt: "You are JARVIS.",
      conversationHistory: HISTORY,
      turnContext: SKILL_BLOCK,
      userMessage: TC035,
    };
    const rounds = buildRoundMessages({
      ...shared,
      rounds: [
        {
          assistant: {
            message: { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "time.now", arguments: {} }] },
            finishReason: "tool_calls",
            model: "m",
          },
          results: [
            {
              executionId: "e1",
              toolId: "time.now",
              toolCallId: "call-1",
              status: "completed",
              result: { success: true, data: { now: "12:00" } },
              startedAt: new Date(),
              completedAt: new Date(),
              durationMs: 1,
            },
          ],
        },
      ],
      renderEnvelope: (tr) => `TOOL: ${tr.toolId}`,
    });

    const opening = buildTurnMessages(shared);
    expect(rounds.slice(0, opening.length)).toEqual(opening);
    expect(rounds.slice(opening.length).map((m) => m.role)).toEqual(["assistant", "tool"]);
  });
});

// ---------------------------------------------------------------------------
// 2. What the model is told about the transcript
// ---------------------------------------------------------------------------

describe("the transcript rules every agent's prompt carries", () => {
  it.each([
    ["the messages are the actual transcript", /actual transcript/i],
    ["earlier messages may be read", /\bread\b/i],
    ["and quoted", /\bquote/i],
    ["the transcript is not external memory", /not (external )?memory/i],
    ["the transcript is not a tool", /not a tool/i],
    ["a question about the conversation is answered from the transcript", /answer[^.]*from (the|this) transcript/i],
    ["an earlier message that is present must not be called inaccessible", /never (say|claim)[^.]*(cannot|can't|unable|inaccessible)/i],
  ])("says %s", (_what, pattern) => {
    expect(TRANSCRIPT_GROUNDING).toMatch(pattern);
  });

  it("separates the transcript from the context the system adds", () => {
    expect(TRANSCRIPT_GROUNDING).toContain(TURN_CONTEXT_HEADER.split("\n")[0]!);
  });
});

// ---------------------------------------------------------------------------
// 3. Every kind of agent assembles its request this way
// ---------------------------------------------------------------------------

describe("each agent sends the user's words verbatim and the context separately", () => {
  let provider: ScriptedAIProvider;

  beforeEach(() => {
    provider = new ScriptedAIProvider();
  });

  function expectGroundedRequest(messages: AIMessage[]): void {
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain(TRANSCRIPT_GROUNDING);
    expect(messages.slice(1, 3).map((m) => [m.role, m.content])).toEqual([
      ["user", "My marker word is TEAL-42."],
      ["assistant", "Noted: TEAL-42."],
    ]);
    expect(messages.at(-2)).toEqual({ role: "system", content: `${TURN_CONTEXT_HEADER}\n\n${SKILL_BLOCK}` });
    expect(messages.at(-1)).toEqual({ role: "user", content: TC035 });
    expectNoServerTextInUserMessages(messages);
  }

  it("the general assistant", async () => {
    const agent = new ConversationalAssistant({ provider, systemPrompt: "You are JARVIS." });
    await agent.process({ message: TC035, conversationHistory: HISTORY, turnContext: SKILL_BLOCK });
    expectGroundedRequest(provider.requests[0]!.messages);
  });

  it("a domain agent", async () => {
    const agent = new KnowledgeAgent({ provider });
    await agent.process({ message: TC035, conversationHistory: HISTORY, turnContext: SKILL_BLOCK });
    expectGroundedRequest(provider.requests[0]!.messages);
  });

  it("the general assistant, again after its tools have run", async () => {
    const agent = new ConversationalAssistant({ provider, systemPrompt: "You are JARVIS." });
    provider.pushToolCall("time.now", {}, "call-1").pushText("It is noon.");

    await agent.process({ message: TC035, conversationId: "c1", conversationHistory: HISTORY, turnContext: SKILL_BLOCK });
    await agent.process({
      message: "",
      conversationId: "c1",
      conversationHistory: HISTORY,
      turnContext: SKILL_BLOCK,
      metadata: {
        toolResults: [
          {
            executionId: "e1",
            toolId: "time.now",
            toolCallId: "call-1",
            status: "completed",
            result: { success: true, data: { now: "12:00" } },
            startedAt: new Date(),
            completedAt: new Date(),
            durationMs: 1,
          },
        ],
      },
    });

    const second = provider.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user", "assistant", "tool"]);
    expect(second[3]!.content).toBe(`${TURN_CONTEXT_HEADER}\n\n${SKILL_BLOCK}`);
    expect(second[4]).toEqual({ role: "user", content: TC035 });
    expectNoServerTextInUserMessages(second);
  });
});

// ---------------------------------------------------------------------------
// 4. The orchestrator: the three blocks, composed as before, kept off the user
// ---------------------------------------------------------------------------

const ADVERTISING: SkillContext = {
  id: "advertising",
  title: "Business and advertising",
  summary: "Look at how your ad accounts are performing.",
  availability: "EXECUTABLE",
  toolIds: ["meta.insights"],
  blockedBy: [],
};

const CHUNK: RetrievedChunk = {
  chunkId: "chunk-1",
  documentId: "doc-1",
  documentTitle: "Refund Policy.pdf",
  documentType: "POLICY",
  source: "upload",
  chunkIndex: 0,
  content: "Refunds are issued within fourteen days of purchase.",
  score: 0.82,
  distance: 0.18,
  pageNumbers: [2],
  sections: [{ title: "Refunds", level: 1, order: 0 }],
  primarySection: { title: "Refunds", level: 1, order: 0 },
  metadata: null,
};

const RECALLED: MemoryRecallResult = {
  memory: {
    id: "mem-1",
    userId: "user-1",
    type: "PREFERENCE",
    content: "User prefers concise answers",
    importance: 0.8,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
  } as MemoryRecallResult["memory"],
  semanticScore: 0.9,
  recencyScore: 0.9,
  finalScore: 0.9,
};

describe("the orchestrator hands the model the user's words and the context separately", () => {
  const tools = toolRegistryOf(productionLikeTools());
  let provider: ScriptedAIProvider;
  let registry: AgentRegistry;

  const memoryStore = {
    isAvailable: async () => true,
    recall: async () => [RECALLED],
    list: async () => ({ memories: [], total: 0 }),
  } as unknown as IMemoryStore;
  const embeddingProvider = { embed: async () => ({ embeddings: [[1, 0]] }) } as unknown as IEmbeddingProvider;
  const knowledgeRetriever = { retrieve: async () => ({ results: [CHUNK] }) } as unknown as IKnowledgeRetriever;
  const skillContext = { forAgent: async () => [ADVERTISING] };

  beforeEach(() => {
    provider = new ScriptedAIProvider();
    registry = new AgentRegistry({ requirePolicy: true });
    registry.register(new ConversationalAssistant({ provider, systemPrompt: "You are JARVIS." }));
    registry.register(new MetaAdsAgent({ provider }));
  });

  function orchestrator(overrides: Record<string, unknown> = {}) {
    return new Orchestrator(registry, new RecordingToolExecutor(tools), new RecordingAuditLogger(), {
      toolRegistry: tools,
      permissionChecker: new FakePermissionChecker(),
      toolApprovalService: new GatingApprovalService(),
      ...overrides,
    });
  }

  const QUESTION = "What does the refund policy say about timing?";

  it("with all three blocks present: one context message, in the old order, and an untouched user message", async () => {
    provider.pushText("Fourteen days.");
    const response = await orchestrator({ memoryStore, embeddingProvider, knowledgeRetriever, skillContext }).process(
      { message: QUESTION, agentId: AGENT_IDS.general, conversationHistory: HISTORY, stream: false },
      sessionFor("user-1")
    );

    const messages = provider.requests[0]!.messages;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
    expect(messages.at(-1)).toEqual({ role: "user", content: QUESTION });
    expectNoServerTextInUserMessages(messages);

    const context = String(messages.at(-2)!.content);
    expect(context.startsWith(TURN_CONTEXT_HEADER)).toBe(true);
    // Skill, then knowledge, then memory — the order they were always composed in.
    const order = SERVER_BLOCK_MARKERS.map((marker) => context.indexOf(marker));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(context).toContain("Refunds are issued within fourteen days of purchase.");
    expect(context).toContain("[PREFERENCE] User prefers concise answers");
    expect(context.endsWith("</user_memories>")).toBe(true);

    // What the turn reports about the context it used is unchanged.
    expect(response.success).toBe(true);
    expect((response.data?.metadata as Record<string, unknown>).recalledMemoryIds).toEqual(["mem-1"]);
  });

  it("with nothing to add: no context message at all", async () => {
    provider.pushText("Hello.");
    await orchestrator().process(
      { message: "hello there", agentId: AGENT_IDS.general, conversationHistory: HISTORY, stream: false },
      sessionFor("user-1")
    );

    const messages = provider.requests[0]!.messages;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages.at(-1)).toEqual({ role: "user", content: "hello there" });
  });

  it("the Meta agent gets the same treatment", async () => {
    provider.pushText("Looks fine.");
    await orchestrator({ skillContext }).process(
      { message: "how are my campaigns doing?", agentId: AGENT_IDS.metaAds, conversationHistory: HISTORY, stream: false },
      sessionFor("user-1")
    );

    const messages = provider.requests.at(-1)!.messages;
    expect(messages[0]!.content).toContain(TRANSCRIPT_GROUNDING);
    expect(String(messages.at(-2)!.content).startsWith(TURN_CONTEXT_HEADER)).toBe(true);
    expect(messages.at(-1)).toEqual({ role: "user", content: "how are my campaigns doing?" });
    expectNoServerTextInUserMessages(messages);
  });

  it("the context is still there when the turn comes back from a tool", async () => {
    provider.pushToolCall("time.now", {}, "call-1").pushText("It is noon.");
    await orchestrator({ skillContext }).process(
      { message: "what time is it?", agentId: AGENT_IDS.general, conversationHistory: HISTORY, stream: false },
      sessionFor("user-1")
    );

    const afterTool = provider.requests[1]!.messages;
    expect(afterTool.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user", "assistant", "tool"]);
    expect(afterTool[4]).toEqual({ role: "user", content: "what time is it?" });
    expectNoServerTextInUserMessages(afterTool);
  });
});

// ---------------------------------------------------------------------------
// 5. A turn ABOUT the conversation is not work for the Task Planner
// ---------------------------------------------------------------------------

describe("the work-request detector leaves a question about the conversation alone", () => {
  it("the five phrasings from the brief are not work", () => {
    for (const message of [
      "summarize our conversation",
      "what did I ask earlier",
      "what was my previous message",
      "what did you just do",
      "what happened in the previous test",
    ]) {
      expect(detectWorkRequest(message).type, message).toBe("NONE");
    }
  });

  it("nor are they when phrased as an instruction — the form that used to be diverted", () => {
    for (const message of [
      "Summarize our conversation so far.",
      "Summarise what we discussed.",
      "Analyze the current conversation and identify the latest test/action.",
      "Please analyze this chat and tell me what I asked first.",
      "Check what my second question was.",
      "Check what I asked earlier.",
      "Verify what you just did.",
      "Check what happened in the previous test.",
      "Now check the last message I sent.",
      "Run through what we talked about above.",
      "Summarize our conversation, don't execute anything",
      "pichla message dekho",
      "maine pehle kya kaha tha, check karo",
      "hamari baatcheet summarize karo",
    ]) {
      expect(detectWorkRequest(message).type, message).toBe("NONE");
    }
  });

  it("real work is recognised exactly as before", () => {
    for (const message of [
      "Check digitalonebox.com",
      "DigitalOneBox.com ka current response check karo",
      "Analyze this file",
      "Research our top competitor",
      "Fetch https://example.com and report the status",
      "Check the latest response of digitalonebox.com",
      "Send the supplier update",
      "Check my system status",
    ]) {
      expect(detectWorkRequest(message).type, message).toBe("EXECUTE");
    }
    expect(detectWorkRequest("Plan how to check digitalonebox.com, don't execute").type).toBe("PLAN_ONLY");
    expect(
      detectWorkRequest("Tomorrow at 10 am check my system status", new Date("2026-10-07T06:00:00.000Z")).type
    ).toBe("SCHEDULE");
    expect(detectWorkRequest("Check it later").type).toBe("NEEDS_TIME");
  });
});
