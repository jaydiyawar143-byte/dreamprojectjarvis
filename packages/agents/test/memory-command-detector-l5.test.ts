// S7.2 L5 — the memory-command detector.
//
// A pure, closed-pattern detector beside detectIntent and detectWorkRequest.
// It recognises only whole-message, explicit commands about JARVIS's memory;
// everything else — including "forget it", "never mind" and ordinary talk
// that merely mentions memory — is NONE and flows on exactly as before.
import { describe, it, expect } from "vitest";
import { DESTRUCTIVE_MEMORY_TOOL_IDS, MEMORY_TOOL_IDS, type PendingAction } from "@jarvis/core";
import { detectMemoryCommand } from "../src/memory-command-detector.js";
import { detectIntent } from "../src/intent-detector.js";
import { AGENT_IDS, AGENT_POLICIES } from "../src/agent-policy.js";

describe("L5 — LIST", () => {
  it.each([
    "show my memories",
    "Show me my memories.",
    "list my memories",
    "Jarvis, show my memories",
    "please show my memories",
    "what do you remember about me?",
    "What do you remember about me",
  ])("English: %j", (text) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "LIST" });
  });

  it.each(["meri memories dikhao", "Meri saari memories dikhao", "tumhe mere baare mein kya yaad hai?", "aapko mere baare me kya yaad hai"])(
    "Hinglish: %j",
    (text) => {
      expect(detectMemoryCommand(text)).toEqual({ kind: "LIST" });
    }
  );
});

describe("L5 — FORGET", () => {
  it.each(["forget this memory", "forget this", "Delete this memory.", "remove this preference", "forget that memory"])(
    "the memory just shown or used: %j",
    (text) => {
      expect(detectMemoryCommand(text)).toEqual({ kind: "FORGET", target: { kind: "THIS" } });
    }
  );

  it.each([
    ["forget 2", [2]],
    ["forget number 2", [2]],
    ["delete memory 3", [3]],
    ["forget memories 1 and 3", [1, 3]],
    ["forget 1, 3 and 4", [1, 3, 4]],
    ["forget #2", [2]],
    ["remove 2 and 2", [2]],
  ])("a selection from the last list: %j", (text, positions) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "FORGET", target: { kind: "SELECTION", positions } });
  });

  it.each(["ye memory bhool jao", "yeh memory delete karo", "is preference ko hata do"])("Hinglish: %j", (text) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "FORGET", target: { kind: "THIS" } });
  });

  it("Hinglish selection: \"2 number wali memory bhool jao\"", () => {
    expect(detectMemoryCommand("2 number wali memory bhool jao")).toEqual({ kind: "FORGET", target: { kind: "SELECTION", positions: [2] } });
  });
});

describe("L5 — FORGET_ALL", () => {
  it.each([
    "forget everything you remember about me",
    "Forget everything about me.",
    "delete all my memories",
    "forget all my memories",
    "clear all of my memories",
    "meri saari memories delete karo",
    "mere baare mein sab kuch bhool jao",
  ])("every memory: %j", (text) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "FORGET_ALL", scope: "ALL" });
  });

  it.each(["forget my old memories", "delete all legacy memories", "forget all my older memories"])("only the legacy ones: %j", (text) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "FORGET_ALL", scope: "LEGACY" });
  });
});

describe("L5 — CORRECT", () => {
  it.each([
    "that's wrong",
    "That is wrong.",
    "that's no longer true",
    "this is incorrect",
    "that's not true anymore",
    "No, that's wrong",
    "this preference is wrong",
    "ye galat hai",
  ])("%j", (text) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "CORRECT", target: { kind: "LAST_REPLY" } });
  });
});

describe("L5 — VETO (the message the user just sent)", () => {
  it.each([
    "forget that",
    "Forget that.",
    "forget what I just said",
    "don't remember what I just said",
    "do not remember that",
    "jo maine abhi kaha woh yaad mat rakhna",
  ])("%j", (text) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "VETO", target: { kind: "PREVIOUS_MESSAGE" } });
  });
});

describe("L5 — learning pause and resume", () => {
  it.each([
    "don't remember anything about me from now on",
    "stop remembering things about me",
    "stop remembering",
    "pause memory",
    "ab se mere baare mein kuch yaad mat rakhna",
  ])("pause: %j", (text) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "LEARNING_PAUSE" });
  });

  it.each(["start remembering things about me again", "resume memory", "start remembering again", "phir se yaad rakhna shuru karo"])(
    "resume: %j",
    (text) => {
      expect(detectMemoryCommand(text)).toEqual({ kind: "LEARNING_RESUME" });
    }
  );
});

describe("L5 — REPLACE is recognised and learned normally, never deleted", () => {
  it.each(["change my preference to professional tone", "update my default design style to minimal"])("%j", (text) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "REPLACE" });
  });
});

describe("L5 — ordinary conversation is never a memory command", () => {
  it.each([
    "forget it",
    "forget",
    "never mind",
    "forget about it",
    "Forget the campaign, let's talk about ads.",
    "I forgot my password",
    "remember to call mom tomorrow",
    "please remember that I prefer short captions",
    "I have a bad memory for names",
    "my memory card is full",
    "don't forget the meeting",
    "that's wrong about the capital, it's Paris",
    "show my campaigns",
    "delete this campaign",
    "remove this ad",
    "forget 2 campaigns",
    "what do you know about blockchain?",
    "I prefer long captions",
    "Actually I prefer long captions",
    "That was a great memory",
    "",
  ])("%j → NONE", (text) => {
    expect(detectMemoryCommand(text)).toEqual({ kind: "NONE" });
  });

  it("\"forget it\" still cancels a pending action, exactly as before", () => {
    const pending = {
      id: "pa-1",
      conversationId: "c-1",
      userId: "u-1",
      toolId: "meta.campaign.pause",
      action: "pause",
      params: {},
      riskLevel: "EXTERNAL_SIDE_EFFECT",
      state: "WAITING_CONFIRMATION",
      approvalId: "ap-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    } as PendingAction;
    expect(detectIntent("forget it", pending).type).toBe("REJECT");
    expect(detectMemoryCommand("forget it")).toEqual({ kind: "NONE" });
  });

  it("is deterministic", () => {
    const answers = new Set(Array.from({ length: 5 }, () => JSON.stringify(detectMemoryCommand("forget memories 1 and 3"))));
    expect(answers.size).toBe(1);
  });
});

describe("L5 — policy: no agent can propose a deletion", () => {
  it("no agent's allowlist holds a destructive memory tool", () => {
    for (const policy of Object.values(AGENT_POLICIES)) {
      for (const toolId of DESTRUCTIVE_MEMORY_TOOL_IDS) {
        expect(policy.allowedTools, `${policy.agentId} -> ${toolId}`).not.toContain(toolId);
      }
    }
  });

  it("only the general assistant may list memories, and listing is all it may do", () => {
    const holders = Object.values(AGENT_POLICIES)
      .filter((p) => p.allowedTools.includes(MEMORY_TOOL_IDS.list))
      .map((p) => p.agentId);
    expect(holders).toEqual([AGENT_IDS.general]);
  });
});
