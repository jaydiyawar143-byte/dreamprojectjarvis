// S7.2 L2 Step 1 — every extracted memory carries USER provenance, or is not
// stored at all.
//
// The extraction model sees each message labelled with its speaker ([M1] USER,
// [M2] ASSISTANT). JARVIS's reply is context: it can explain what "that" means
// in the user's message, but it is never a source. For every candidate the
// model names the USER message it came from and quotes it word for word; the
// service checks both against its OWN record of the turn and takes every id
// — conversation, message, trace — from that record, never from the model.
//
// A candidate that cites JARVIS, cites nothing, quotes words the user never
// wrote, or points at a message with no ids is dropped, with a content-free
// `memory_candidate_provenance_rejected` event. Everything else about a valid
// memory — content, type, importance, confidence, embedding, dedup, merge,
// expiry — is exactly as before.
import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  AICompletionRequest,
  AICompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ExtractionMessage,
  IAIProvider,
  IEmbeddingProvider,
  IMemoryStore,
  MemoryListResult,
  MemoryRecord,
  MemoryStoreRequest,
  MemoryUpdateRequest,
} from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";

const DIMS = 4;
const unit = (i: number): number[] => Array.from({ length: DIMS }, (_, k) => (k === i % DIMS ? 1 : 0));

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

type Candidate = Record<string, unknown>;

class ScriptedModel implements IAIProvider {
  readonly id = "l2-model";
  readonly name = "L2 model";
  readonly defaultModel = "l2";
  readonly requests: AICompletionRequest[] = [];
  constructor(private readonly candidates: Candidate[]) {}
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    return {
      message: { role: "assistant", content: JSON.stringify({ candidates: this.candidates }) },
      finishReason: "stop",
      model: "l2",
    };
  }
  async listModels() {
    return ["l2"];
  }
  async isAvailable() {
    return true;
  }
}

class RecordingEmbeddings implements IEmbeddingProvider {
  readonly id = "l2-embeddings";
  readonly name = "L2 embeddings";
  readonly dimensions = DIMS;
  readonly inputs: string[][] = [];
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    this.inputs.push(inputs);
    return { embeddings: inputs.map((_, i) => unit(i)), model: "l2" };
  }
  async isAvailable() {
    return true;
  }
}

class RecordingStore implements IMemoryStore {
  readonly id = "l2-store";
  readonly name = "L2 store";
  readonly stored: MemoryStoreRequest["memories"] = [];
  readonly updates: MemoryUpdateRequest[] = [];
  constructor(private readonly existing: MemoryRecord[] = []) {}
  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    this.stored.push(...request.memories);
    return [];
  }
  async update(request: MemoryUpdateRequest): Promise<MemoryRecord> {
    this.updates.push(request);
    return { id: request.memoryId } as MemoryRecord;
  }
  async list(): Promise<MemoryListResult> {
    return { memories: this.existing, total: this.existing.length, hasMore: false };
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
  async findSimilar(): Promise<MemoryRecord[]> {
    return [];
  }
  async count(): Promise<number> {
    return this.stored.length;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** An earlier memory; `embedding` decides whether a new candidate merges into it or is a duplicate. */
function earlier(embedding: number[], metadata: Record<string, unknown> = {}): MemoryRecord {
  return {
    id: "m-earlier",
    userId: "u-l2",
    type: "PREFERENCE",
    content: "User likes brief captions",
    importance: 0.7,
    confidence: 0.9,
    accessCount: 0,
    sourceType: "conversation",
    sourceConversationId: "conv-old",
    sourceMessageId: "msg-old",
    metadata: { embedding, sourceTraceId: "trace-old", ...metadata },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as MemoryRecord;
}

function setup(candidates: Candidate[], existing: MemoryRecord[] = []) {
  const model = new ScriptedModel(candidates);
  const embeddings = new RecordingEmbeddings();
  const store = new RecordingStore(existing);
  const service = new MemoryExtractionService({ aiProvider: model, store, embeddingProvider: embeddings, maxRetries: 0 });
  return { model, embeddings, store, service };
}

const user = (content: string, messageId?: string, traceId?: string): ExtractionMessage => ({
  role: "user",
  content,
  ...(messageId !== undefined ? { messageId } : {}),
  ...(traceId !== undefined ? { traceId } : {}),
});
const assistant = (content: string): ExtractionMessage => ({ role: "assistant", content });

const candidate = (content: string, citation: Record<string, unknown>): Candidate => ({
  type: "PREFERENCE",
  content,
  importance: 0.8,
  confidence: 0.9,
  ...citation,
});

/** Runs `work` with the console captured; returns the provenance events and the raw log. */
async function capture<T>(work: () => Promise<T>) {
  const lines: string[] = [];
  const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    })
  );
  try {
    const result = await work();
    const rejections = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null && e.event === "memory_candidate_provenance_rejected");
    return { result, rejections, raw: lines.join("\n") };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The model's view: labelled speakers, no ids
// ---------------------------------------------------------------------------

describe("L2 — what the extraction model is shown", () => {
  it("labels every message with its speaker, marks JARVIS's reply as context, and asks for a source and a quote", async () => {
    const { service, model } = setup([]);
    await capture(() =>
      service.extract({
        userId: "u-l2",
        conversationId: "conv-a",
        messages: [user("I prefer short captions.", "msg-a", "trace-a"), assistant("Noted: short captions.")],
      })
    );

    const [system, prompt] = model.requests[0]!.messages;
    expect(prompt!.content).toContain("[M1] USER: I prefer short captions.");
    expect(prompt!.content).toContain("[M2] ASSISTANT (context only, never a source): Noted: short captions.");
    expect(system!.content).toContain('"source"');
    expect(system!.content).toContain('"evidence"');
    expect(system!.content).toMatch(/ASSISTANT[^\n]*never/i);
  });

  it("never shows the model a conversation, message or trace id", async () => {
    const { service, model } = setup([]);
    await capture(() =>
      service.extract({
        userId: "u-l2",
        conversationId: "conv-secret-id",
        messages: [user("I prefer short captions.", "msg-secret-id", "trace-secret-id"), assistant("Noted.")],
      })
    );

    const shown = JSON.stringify(model.requests[0]!.messages);
    for (const id of ["conv-secret-id", "msg-secret-id", "trace-secret-id", "u-l2"]) expect(shown).not.toContain(id);
  });
});

// ---------------------------------------------------------------------------
// A — a USER statement becomes a USER memory
// ---------------------------------------------------------------------------

describe("L2 A — the user's own statement is stored with USER provenance", () => {
  const conversation = [
    user("I prefer short captions.", "msg-a-user", "trace-a"),
    assistant("Great, I'll remember that you prefer short captions."),
  ];

  it("points at the user's message, conversation and trace — never at JARVIS's reply", async () => {
    const { service, store } = setup([candidate("User prefers short captions", { source: "M1", evidence: "I prefer short captions" })]);
    const { result } = await capture(() =>
      service.extract({ userId: "u-l2", conversationId: "conv-a", messages: conversation, expiryDays: 90 })
    );

    expect(store.stored).toHaveLength(1);
    const memory = store.stored[0]!;
    expect(memory).toMatchObject({
      type: "PREFERENCE",
      content: "User prefers short captions",
      importance: 0.8,
      confidence: 0.7, // S7.2 L4 — derived: one DIRECT statement
      sourceType: "USER",
      sourceConversationId: "conv-a",
      sourceMessageId: "msg-a-user",
      embedding: unit(0),
      metadata: { embedding: unit(0), sourceTraceId: "trace-a" },
    });
    // S7.2 L4 — plus the evidence (ids only) and the model's own confidence.
    expect(Object.keys(memory.metadata!).sort()).toEqual(["embedding", "evidence", "modelConfidence", "sourceTraceId"]);
    expect(memory.metadata!.modelConfidence).toBe(0.9);
    expect(result.candidates[0]).toMatchObject({
      sourceType: "USER",
      sourceConversationId: "conv-a",
      sourceMessageId: "msg-a-user",
      sourceTraceId: "trace-a",
    });
    expect(result.meta).toMatchObject({ candidatesFound: 1, candidatesValidated: 1, candidatesFiltered: 0, memoriesCreated: 1 });
  });

  it("the same content attributed to JARVIS's reply is not stored", async () => {
    const { service, store } = setup([
      candidate("User prefers short captions", { source: "M2", evidence: "you prefer short captions" }),
    ]);
    const { rejections } = await capture(() => service.extract({ userId: "u-l2", conversationId: "conv-a", messages: conversation }));

    expect(store.stored).toHaveLength(0);
    expect(rejections).toEqual([{ event: "memory_candidate_provenance_rejected", reason: "SOURCE_NOT_USER", candidateIndex: 0, candidateCount: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// B — JARVIS's own claim never becomes a USER memory
// ---------------------------------------------------------------------------

describe("L2 B — an assistant-only claim never becomes a USER memory", () => {
  const conversation = [
    user("Thanks, sounds good.", "msg-b-user", "trace-b"),
    assistant("I've decided that your default style is short captions."),
  ];
  const claim = "User's default style is short captions";

  it.each([
    ["cited to JARVIS's reply", { source: "M2", evidence: "your default style is short captions" }, "SOURCE_NOT_USER"],
    ["cited to the user but quoting JARVIS's words", { source: "M1", evidence: "your default style is short captions" }, "EVIDENCE_NOT_IN_SOURCE"],
    ["with no source at all", {}, "SOURCE_MISSING"],
    ["with a source but no quote", { source: "M1" }, "EVIDENCE_MISSING"],
  ])("%s → no memory, no update", async (_label, citation, reason) => {
    const { service, store, model } = setup([candidate(claim, citation)], [earlier([0.8, 0.6, 0, 0])]);
    const { result, rejections } = await capture(() =>
      service.extract({ userId: "u-l2", conversationId: "conv-b", messages: conversation })
    );

    expect(model.requests).toHaveLength(1);
    expect(store.stored).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
    expect(result.candidates).toEqual([]);
    expect(rejections.map((e) => e.reason)).toEqual([reason]);
  });
});

// ---------------------------------------------------------------------------
// C — an explicit endorsement is USER evidence
// ---------------------------------------------------------------------------

describe("L2 C — an explicit user endorsement becomes a USER memory pointing at the endorsement", () => {
  it("the memory's source is the user's 'make that my default', not JARVIS's restatement", async () => {
    const conversation = [
      user("Yes, make that my default.", "msg-c-endorse", "trace-c"),
      assistant("Your default is short captions."),
    ];
    const { service, store } = setup([
      candidate("User's default caption style is short captions", { source: "M1", evidence: "make that my default" }),
    ]);
    await capture(() => service.extract({ userId: "u-l2", conversationId: "conv-c", messages: conversation }));

    expect(store.stored).toHaveLength(1);
    expect(store.stored[0]).toMatchObject({
      sourceType: "USER",
      sourceConversationId: "conv-c",
      sourceMessageId: "msg-c-endorse",
      metadata: { sourceTraceId: "trace-c" },
    });
  });
});

// ---------------------------------------------------------------------------
// D — per candidate: a JARVIS-sourced candidate never costs a valid neighbour
// ---------------------------------------------------------------------------

describe("L2 D — only the USER-sourced candidates of a batch are stored", () => {
  it("drops the assistant-sourced candidate and keeps the user-sourced one, with aligned embeddings", async () => {
    const conversation = [
      user("I work late on Fridays.", "msg-d-user", "trace-d"),
      assistant("Your default channel is LinkedIn."),
    ];
    const { service, store, embeddings } = setup([
      candidate("User's default channel is LinkedIn", { source: "M2", evidence: "Your default channel is LinkedIn" }),
      candidate("User works late on Fridays", { source: "M1", evidence: "I work late on Fridays" }),
    ]);
    const { result, rejections } = await capture(() =>
      service.extract({ userId: "u-l2", conversationId: "conv-d", messages: conversation })
    );

    expect(embeddings.inputs).toEqual([["User works late on Fridays"]]);
    expect(store.stored.map((m) => [m.content, m.sourceMessageId, m.embedding])).toEqual([
      ["User works late on Fridays", "msg-d-user", unit(0)],
    ]);
    expect(rejections).toEqual([{ event: "memory_candidate_provenance_rejected", reason: "SOURCE_NOT_USER", candidateIndex: 0, candidateCount: 2 }]);
    expect(result.meta).toMatchObject({ candidatesFound: 2, candidatesValidated: 2, candidatesFiltered: 1, memoriesCreated: 1 });
  });
});

// ---------------------------------------------------------------------------
// E — missing provenance is never filled in as USER
// ---------------------------------------------------------------------------

describe("L2 E — missing provenance is refused, never silently assigned", () => {
  const good = candidate("User prefers short captions", { source: "M1", evidence: "I prefer short captions" });

  it.each([
    ["the user message has no id", { conversationId: "conv-e", messages: [user("I prefer short captions.", undefined, "trace-e")] }],
    ["the turn has no conversation id", { messages: [user("I prefer short captions.", "msg-e", "trace-e")] }],
  ])("%s → SOURCE_IDS_MISSING, nothing stored", async (_label, request) => {
    const { service, store } = setup([good]);
    const { rejections } = await capture(() => service.extract({ userId: "u-l2", ...request }));

    expect(store.stored).toHaveLength(0);
    expect(rejections.map((e) => e.reason)).toEqual(["SOURCE_IDS_MISSING"]);
  });

  it("the legacy lastMessageId is never used as a memory's source", async () => {
    const { service, store } = setup([good]);
    await capture(() =>
      service.extract({
        userId: "u-l2",
        conversationId: "conv-e",
        lastMessageId: "msg-last",
        messages: [user("I prefer short captions.", "msg-e-user")],
      })
    );

    expect(store.stored[0]!.sourceMessageId).toBe("msg-e-user");
  });
});

// ---------------------------------------------------------------------------
// Propagation — conversation, message and trace ids
// ---------------------------------------------------------------------------

describe("L2 — ids propagate from the cited message", () => {
  it("each candidate gets the ids of the user message it cites", async () => {
    const conversation = [
      user("I prefer short captions.", "msg-1", "trace-1"),
      assistant("Noted."),
      user("My default platform is Instagram.", "msg-3", "trace-3"),
    ];
    const { service, store } = setup([
      candidate("User's default platform is Instagram", { source: "M3", evidence: "default platform is Instagram" }),
      candidate("User prefers short captions", { source: "M1", evidence: "prefer short captions" }),
    ]);
    await capture(() => service.extract({ userId: "u-l2", conversationId: "conv-p", messages: conversation }));

    expect(store.stored.map((m) => [m.content, m.sourceConversationId, m.sourceMessageId, m.metadata?.sourceTraceId])).toEqual([
      ["User's default platform is Instagram", "conv-p", "msg-3", "trace-3"],
      ["User prefers short captions", "conv-p", "msg-1", "trace-1"],
    ]);
  });

  it("without a trace id, no trace is written and nothing else changes", async () => {
    const { service, store } = setup([candidate("User prefers short captions", { source: "M1", evidence: "I prefer short captions" })]);
    await capture(() =>
      service.extract({ userId: "u-l2", conversationId: "conv-p", messages: [user("I prefer short captions.", "msg-p")] })
    );

    expect(store.stored[0]!.metadata!.embedding).toEqual(unit(0));
    expect(store.stored[0]!.metadata).not.toHaveProperty("sourceTraceId");
    expect(store.stored[0]).toMatchObject({ sourceType: "USER", sourceConversationId: "conv-p", sourceMessageId: "msg-p" });
  });
});

// ---------------------------------------------------------------------------
// Dedup and merge keep provenance coherent
// ---------------------------------------------------------------------------

describe("L2 — dedup and merge", () => {
  const conversation = [user("I prefer short captions.", "msg-new", "trace-new"), assistant("Noted.")];
  const cited = candidate("User prefers short captions", { source: "M1", evidence: "I prefer short captions" });

  it("a merge moves the memory's provenance to the user message that restated it", async () => {
    const { service, store } = setup([cited], [earlier([0.8, 0.6, 0, 0])]);
    await capture(() => service.extract({ userId: "u-l2", conversationId: "conv-new", messages: conversation }));

    expect(store.stored).toHaveLength(0);
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({
      memoryId: "m-earlier",
      content: "User prefers short captions",
      sourceType: "USER",
      sourceConversationId: "conv-new",
      sourceMessageId: "msg-new",
      embedding: unit(0),
      metadata: { embedding: unit(0), sourceTraceId: "trace-new", mergeCount: 1 },
    });
  });

  it("a merge from a message without a trace drops the earlier memory's trace instead of keeping a stale one", async () => {
    const { service, store } = setup([cited], [earlier([0.8, 0.6, 0, 0])]);
    await capture(() =>
      service.extract({ userId: "u-l2", conversationId: "conv-new", messages: [user("I prefer short captions.", "msg-new")] })
    );

    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]!.sourceMessageId).toBe("msg-new");
    expect(store.updates[0]!.metadata).not.toHaveProperty("sourceTraceId");
  });

  // S7.2 L4 — a duplicate is no longer ignored: it corroborates. Its content,
  // vector and provenance stay exactly as they were.
  it("a duplicate corroborates: the earlier memory's content, vector and provenance are untouched", async () => {
    const { service, store } = setup([cited], [earlier([1, 0, 0, 0])]);
    const { result } = await capture(() => service.extract({ userId: "u-l2", conversationId: "conv-new", messages: conversation }));

    expect(store.stored).toHaveLength(0);
    expect(store.updates).toHaveLength(1);
    expect(Object.keys(store.updates[0]!).sort()).toEqual(["confidence", "expiresAt", "memoryId", "metadata", "userId"]);
    expect(store.updates[0]!.metadata).toMatchObject({ embedding: [1, 0, 0, 0], sourceTraceId: "trace-old" });
    expect(result.meta.duplicatesSkipped).toBe(1);
  });

  it("an assistant-sourced candidate cannot merge into an earlier memory", async () => {
    const { service, store } = setup(
      [candidate("User prefers short captions", { source: "M2", evidence: "Noted" })],
      [earlier([0.8, 0.6, 0, 0])]
    );
    await capture(() => service.extract({ userId: "u-l2", conversationId: "conv-new", messages: conversation }));

    expect(store.updates).toHaveLength(0);
    expect(store.stored).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The rejection event is content-free
// ---------------------------------------------------------------------------

describe("L2 — the provenance rejection event carries no content", () => {
  it("no user text, JARVIS text, candidate text, quote or id reaches the log", async () => {
    const secretish = ["Zq9", "Xv7", "Lp3"].join("");
    const { service } = setup([
      candidate(`User's code word is ${secretish}`, { source: "M2", evidence: `code word is ${secretish}` }),
      candidate("User prefers long captions", { source: "M1", evidence: "long captions" }),
      candidate("User prefers tabs", {}),
    ]);
    const { rejections, raw } = await capture(() =>
      service.extract({
        userId: "u-l2-private",
        conversationId: "conv-private",
        messages: [user("I prefer short captions.", "msg-private", "trace-private"), assistant(`Your code word is ${secretish}.`)],
      })
    );

    expect(rejections.map((e) => e.reason)).toEqual(["SOURCE_NOT_USER", "EVIDENCE_NOT_IN_SOURCE", "SOURCE_MISSING"]);
    for (const e of rejections) expect(Object.keys(e).sort()).toEqual(["candidateCount", "candidateIndex", "event", "reason"]);
    for (const forbidden of [
      secretish,
      "short captions",
      "long captions",
      "tabs",
      "code word",
      "u-l2-private",
      "conv-private",
      "msg-private",
      "trace-private",
    ]) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });
});
