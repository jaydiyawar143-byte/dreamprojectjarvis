// S7 Step 5 — a pre-existing defect found while implementing the vector write.
//
// deduplicateAndStore() drops skipped duplicates from its `accepted` list, but
// storeMemories() then read embeddings by position in the ORIGINAL candidate
// list. When a skipped duplicate came first, the next new memory was stored
// with the duplicate's embedding. Before S7 that wrong embedding reached only
// metadata; with the vector write it would also become the memory's vector —
// exactly the "vector does not match content" failure S7 exists to prevent.
//
// Written before the fix and expected to fail against the pre-fix code.
import { describe, it, expect } from "vitest";
import type {
  AICompletionRequest,
  AICompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  IAIProvider,
  IEmbeddingProvider,
  IMemoryStore,
  MemoryListResult,
  MemoryRecord,
  MemoryStoreRequest,
  MemoryUpdateRequest,
} from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";
import { citeFirstUserMessage } from "./helpers/compliant-citation.js";

const DUPLICATE = "User's favourite drink is masala chai.";
const NEW_FACT = "User's office is in Pune.";
const VECTORS = new Map<string, number[]>([
  [DUPLICATE, [1, 0, 0, 0]],
  [NEW_FACT, [0, 1, 0, 0]],
]);

class ScriptedModel implements IAIProvider {
  readonly id = "s7-scripted";
  readonly name = "S7 scripted";
  readonly defaultModel = "s7-scripted";
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    return {
      message: {
        role: "assistant",
        // S7.2 L2 — a compliant model: each candidate cites the user's message.
        content: citeFirstUserMessage(
          request,
          JSON.stringify({
            candidates: [
              { type: "FACT", content: DUPLICATE, importance: 0.8, confidence: 1 },
              { type: "FACT", content: NEW_FACT, importance: 0.8, confidence: 1 },
            ],
          })
        ),
      },
      finishReason: "stop",
      model: this.defaultModel,
    };
  }
  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class FixedEmbeddings implements IEmbeddingProvider {
  readonly id = "s7-fixed";
  readonly name = "S7 fixed";
  readonly dimensions = 4;
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map((t) => VECTORS.get(t) ?? [0, 0, 0, 1]), model: "s7-fixed" };
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** Already holds DUPLICATE; records every store() request. */
class RecordingStore implements IMemoryStore {
  readonly id = "s7-recording";
  readonly name = "S7 recording";
  readonly storeRequests: MemoryStoreRequest[] = [];
  readonly updateRequests: MemoryUpdateRequest[] = [];
  private readonly existing: MemoryRecord = {
    id: "existing-duplicate",
    userId: "user-s7",
    type: "FACT",
    content: DUPLICATE,
    importance: 0.8,
    confidence: 1,
    accessCount: 0,
    metadata: { embedding: VECTORS.get(DUPLICATE) },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    this.storeRequests.push(request);
    return [];
  }
  async list(): Promise<MemoryListResult> {
    return { memories: [this.existing], total: 1, hasMore: false };
  }
  async getById(): Promise<MemoryRecord | null> {
    return null;
  }
  async recall() {
    return [];
  }
  async delete(): Promise<number> {
    return 0;
  }
  async deleteAll(): Promise<number> {
    return 0;
  }
  // S7.2 L4 — the duplicate now corroborates: one evidence update, recorded.
  async update(request: MemoryUpdateRequest): Promise<MemoryRecord> {
    this.updateRequests.push(request);
    return this.existing;
  }
  async findSimilar(): Promise<MemoryRecord[]> {
    return [];
  }
  async count(): Promise<number> {
    return 1;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe("S7 extraction — embeddings stay aligned with their candidates", () => {
  it("a new memory stored after a skipped duplicate carries its OWN embedding", async () => {
    const store = new RecordingStore();
    const service = new MemoryExtractionService({
      aiProvider: new ScriptedModel(),
      store,
      embeddingProvider: new FixedEmbeddings(),
      maxRetries: 0,
    });

    const result = await service.extract({
      userId: "user-s7",
      conversationId: "conv-s7",
      // S7.2 L3: the user states both facts (the favourite, too), so both reach embedding.
      messages: [{ role: "user", messageId: "msg-s7", content: "My favourite drink is masala chai and my office is in Pune." }],
    });

    expect(result.meta.duplicatesSkipped, "the first candidate is skipped as a duplicate").toBe(1);
    expect(store.storeRequests).toHaveLength(1);
    const stored = store.storeRequests[0]!.memories;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toBe(NEW_FACT);
    expect(stored[0]!.metadata?.embedding, "metadata embedding is the new fact's").toEqual(VECTORS.get(NEW_FACT));
    expect(stored[0]!.embedding, "the vector to store is the new fact's").toEqual(VECTORS.get(NEW_FACT));
    // S7.2 L4 — the duplicate's corroboration touches evidence only: no content, no vector.
    expect(store.updateRequests.map((u) => u.memoryId)).toEqual(["existing-duplicate"]);
    expect(store.updateRequests[0]).not.toHaveProperty("embedding");
    expect(store.updateRequests[0]).not.toHaveProperty("content");
  });
});
