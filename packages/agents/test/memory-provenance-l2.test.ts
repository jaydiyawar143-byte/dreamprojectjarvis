// S7.2 L2 Step 1 — the orchestrator hands memory extraction the turn's own
// source ids.
//
// The chat route saves the user's message before calling the orchestrator
// and puts its id in the SERVER-built session context (`userMessageId`), next
// to the route's own `traceId`. The orchestrator passes both on the user's
// message, and the conversation id on the request, so every memory can point
// back at the exact message that produced it. JARVIS's reply is passed as
// context with role and content only: it has no stored id yet, and it is
// never a source.
//
// Nothing here is taken from the request body or from stored history.
import { describe, it, expect } from "vitest";
import type { IMemoryExtractor, MemoryExtractionRequest, MemoryExtractionResult, SessionContext } from "@jarvis/core";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";
import { AGENT_IDS } from "../src/agent-policy.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { RecordingAuditLogger, RecordingToolExecutor, ScriptedAIProvider, sessionFor } from "./helpers/sprint6-harness.js";

const TRACE = "7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6";
const HISTORY_TRACE = "5b0c9d7e-3f4a-4c21-9e8b-1a2b3c4d5e6f";

async function extractionFor(context: SessionContext, message = "I prefer short captions.", reply = "Noted: short captions.") {
  let received: MemoryExtractionRequest | undefined;
  let signal!: () => void;
  const extracted = new Promise<void>((resolve) => (signal = resolve));
  const extractor = {
    id: "capturing-extractor",
    name: "Capturing extractor",
    async isAvailable() {
      return true;
    },
    async extract(request: MemoryExtractionRequest) {
      received = request;
      signal();
      return { candidates: [], meta: {} } as unknown as MemoryExtractionResult;
    },
  } satisfies IMemoryExtractor;

  const registry = new AgentRegistry({ requirePolicy: true });
  registry.register(new ConversationalAssistant({ provider: new ScriptedAIProvider().pushText(reply) }));
  const orchestrator = new Orchestrator(registry, new RecordingToolExecutor(), new RecordingAuditLogger(), {
    memoryExtractor: extractor,
  });

  await orchestrator.process(
    {
      message,
      conversationId: context.conversationId,
      conversationHistory: [
        { id: "m0", role: "user", content: "Hi JARVIS.", createdAt: new Date(0).toISOString(), metadata: { traceId: HISTORY_TRACE } },
      ],
      agentId: AGENT_IDS.general,
      stream: false,
    },
    context
  );
  await extracted;
  return received!;
}

describe("L2 — the orchestrator passes the turn's source ids to memory extraction", () => {
  it("the user's message carries its saved id and the turn's trace; the conversation id is on the request", async () => {
    const request = await extractionFor(sessionFor("user-1", "member", { conversationId: "conv-l2", traceId: TRACE, userMessageId: "msg-saved-1" }));

    expect(request.conversationId).toBe("conv-l2");
    expect(request.messages).toEqual([
      { role: "user", content: "I prefer short captions.", messageId: "msg-saved-1", traceId: TRACE },
      { role: "assistant", content: "Noted: short captions." },
    ]);
  });

  it("JARVIS's reply carries no id and no trace: it is context, never a source", async () => {
    const request = await extractionFor(sessionFor("user-1", "member", { conversationId: "conv-l2", traceId: TRACE, userMessageId: "msg-saved-1" }));

    expect(Object.keys(request.messages[1]!).sort()).toEqual(["content", "role"]);
  });

  it("with no saved message id in the context, none is invented", async () => {
    const request = await extractionFor(sessionFor("user-1", "member", { conversationId: "conv-l2", traceId: TRACE }));

    expect(request.messages[0]).toEqual({ role: "user", content: "I prefer short captions.", traceId: TRACE });
    expect("messageId" in request.messages[0]!).toBe(false);
  });

  it("stored history, and its trace, never reach extraction", async () => {
    const request = await extractionFor(sessionFor("user-1", "member", { conversationId: "conv-l2", traceId: TRACE, userMessageId: "msg-saved-1" }));

    const input = JSON.stringify(request);
    expect(input).not.toContain("Hi JARVIS.");
    expect(input).not.toContain(HISTORY_TRACE);
    expect(request.messages).toHaveLength(2);
  });
});
