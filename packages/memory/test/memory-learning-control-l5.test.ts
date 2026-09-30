// S7.2 L5 — the user's learning controls inside MemoryExtractionService.
//
// Two persistence-level checks, separate from the L1c per-turn veto:
//   - before the model: a paused user, or a vetoed message, is not even read;
//   - just before anything is written: read AGAIN, so a pause or a "forget
//     that" that arrived while the model was extracting still stops it.
// Blocked means nothing at all: no new row, no corroboration, no revision,
// no expiry refresh, no evidence. Unreadable controls fail closed.
import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  AICompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  IAIProvider,
  IEmbeddingProvider,
  IMemoryStore,
  MemoryLearningControl,
  MemoryListRequest,
  MemoryListResult,
  MemoryRecord,
  MemoryStoreRequest,
  MemoryUpdateRequest,
} from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";

const SHORT = [1, 0, 0, 0];
const T0 = new Date("2026-09-01T10:00:00.000Z");

class CountingModel implements IAIProvider {
  readonly id = "l5-model";
  readonly name = "L5 model";
  readonly defaultModel = "l5";
  calls = 0;
  constructor(private readonly onCall: () => void = () => undefined) {}
  async complete(): Promise<AICompletionResponse> {
    this.calls++;
    this.onCall();
    const candidates = [{ type: "PREFERENCE", content: "User prefers short captions", importance: 0.8, confidence: 0.9, source: "M1", evidence: "I prefer short captions" }];
    return { message: { role: "assistant", content: JSON.stringify({ candidates }) }, finishReason: "stop", model: "l5" };
  }
  async listModels() {
    return ["l5"];
  }
  async isAvailable() {
    return true;
  }
}

const embeddings: IEmbeddingProvider = {
  id: "l5-embeddings",
  name: "L5 embeddings",
  dimensions: 4,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map(() => SHORT), model: "l5" };
  },
  async isAvailable() {
    return true;
  },
};

class RecordingStore implements IMemoryStore {
  readonly id = "l5-store";
  readonly name = "L5 store";
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
  async list(request: MemoryListRequest): Promise<MemoryListResult> {
    const mine = this.existing.filter((m) => m.userId === request.userId);
    return { memories: mine, total: mine.length, hasMore: false };
  }
  async getById() {
    return null;
  }
  async recall() {
    return [];
  }
  async delete() {
    return 0;
  }
  async deleteAll() {
    return 0;
  }
  async findSimilar() {
    return [];
  }
  async count() {
    return 0;
  }
  async isAvailable() {
    return true;
  }
}

/** An existing memory the statement would corroborate, were it allowed to. */
const existing: MemoryRecord = {
  id: "m-1",
  userId: "u-1",
  type: "PREFERENCE",
  content: "User prefers short captions",
  importance: 0.7,
  confidence: 0.7,
  accessCount: 0,
  sourceType: "USER",
  sourceConversationId: "conv-A",
  sourceMessageId: "msg-1",
  metadata: {
    embedding: SHORT,
    evidence: { v: 1, count: 1, conversations: 1, firstSeenAt: T0.toISOString(), lastSeenAt: T0.toISOString(), sources: [{ messageId: "msg-1", conversationId: "conv-A", kind: "DIRECT", at: T0.toISOString() }], revisions: 0, previousSourceMessageIds: [] },
  },
  createdAt: T0,
  updatedAt: T0,
};

/** Controls the test can change between the two reads. */
function controls(initial: MemoryLearningControl) {
  const state = { current: initial, reads: 0, fail: false };
  return {
    state,
    port: {
      async get(): Promise<MemoryLearningControl> {
        state.reads++;
        if (state.fail) throw new Error(`settings unavailable for u-1`);
        return { learningPaused: state.current.learningPaused, vetoedSourceMessageIds: [...state.current.vetoedSourceMessageIds] };
      },
    },
  };
}

const ON: MemoryLearningControl = { learningPaused: false, vetoedSourceMessageIds: [] };

async function extract(opts: { control?: ReturnType<typeof controls>["port"]; model?: CountingModel; store?: RecordingStore; messageId?: string }) {
  const model = opts.model ?? new CountingModel();
  const store = opts.store ?? new RecordingStore();
  const service = new MemoryExtractionService({
    aiProvider: model,
    store,
    embeddingProvider: embeddings,
    maxRetries: 0,
    ...(opts.control ? { learningControl: opts.control } : {}),
  });
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const result = await service.extract({
      userId: "u-1",
      conversationId: "conv-B",
      messages: [
        { role: "user", content: "I prefer short captions.", messageId: opts.messageId ?? "msg-2", traceId: "trace-2" },
        { role: "assistant", content: "Noted." },
      ],
      expiryDays: 90,
    });
    const events = lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    return { result, model, store, events, raw: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe("L5 — learning pause", () => {
  it("a paused user's message is not even read by the model, and nothing is persisted", async () => {
    const { state, port } = controls({ learningPaused: true, vetoedSourceMessageIds: [] });
    const { model, store, result, events } = await extract({ control: port, store: new RecordingStore([existing]) });

    expect(model.calls).toBe(0);
    expect(store.stored).toEqual([]);
    expect(store.updates, "the existing memory is untouched: no evidence, confidence or expiry change").toEqual([]);
    expect(result.meta.memoriesCreated).toBe(0);
    expect(state.reads).toBe(1);
    expect(events).toContainEqual({ event: "memory_learning_blocked", reason: "PAUSED", candidates: 1 });
  });

  it("resuming restores learning exactly as before", async () => {
    const { state, port } = controls({ learningPaused: true, vetoedSourceMessageIds: [] });
    await extract({ control: port });
    state.current = { learningPaused: false, vetoedSourceMessageIds: [] };
    const { store } = await extract({ control: port });

    expect(store.stored.map((m) => m.content)).toEqual(["User prefers short captions"]);
  });

  it("a pause that arrives while the model is extracting still stops the write", async () => {
    const { state, port } = controls(ON);
    const model = new CountingModel(() => {
      state.current = { learningPaused: true, vetoedSourceMessageIds: [] };
    });
    const { store } = await extract({ control: port, model, store: new RecordingStore([existing]) });

    expect(model.calls).toBe(1);
    expect(store.stored).toEqual([]);
    expect(store.updates).toEqual([]);
    expect(state.reads).toBe(2);
  });
});

describe("L5 — source-message veto", () => {
  it("a vetoed message is never learned: no new row, no model call", async () => {
    const { port } = controls({ learningPaused: false, vetoedSourceMessageIds: ["msg-2"] });
    const { model, store, result } = await extract({ control: port });

    expect(model.calls).toBe(0);
    expect(store.stored).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("a vetoed message never corroborates: the existing memory's evidence, confidence and expiry are untouched", async () => {
    const { port } = controls({ learningPaused: false, vetoedSourceMessageIds: ["msg-2"] });
    const { store } = await extract({ control: port, store: new RecordingStore([existing]) });

    expect(store.updates).toEqual([]);
    expect(store.stored).toEqual([]);
  });

  it("closes the race: a veto recorded while the model is extracting blocks the write — no row, no corroboration, no revision", async () => {
    const { state, port } = controls(ON);
    const model = new CountingModel(() => {
      state.current = { learningPaused: false, vetoedSourceMessageIds: ["msg-2"] };
    });
    const { store, result, events } = await extract({ control: port, model, store: new RecordingStore([existing]) });

    expect(model.calls).toBe(1);
    expect(store.stored).toEqual([]);
    expect(store.updates).toEqual([]);
    expect(result.meta).toMatchObject({ memoriesCreated: 0, memoriesUpdated: 0, duplicatesSkipped: 0 });
    expect(events).toContainEqual({ event: "memory_learning_blocked", reason: "VETOED", candidates: 1 });
  });

  it("a replay of a vetoed message stays blocked", async () => {
    const { port } = controls({ learningPaused: false, vetoedSourceMessageIds: ["msg-2"] });
    await extract({ control: port });
    const { store, model } = await extract({ control: port });

    expect(model.calls).toBe(0);
    expect(store.stored).toEqual([]);
  });

  it("the veto is per message: another message is learned normally", async () => {
    const { port } = controls({ learningPaused: false, vetoedSourceMessageIds: ["msg-other"] });
    const { store } = await extract({ control: port });

    expect(store.stored.map((m) => m.content)).toEqual(["User prefers short captions"]);
  });
});

describe("L5 — fail closed, and unchanged without controls", () => {
  it("unreadable controls: nothing is learned, and the only log line is content-free", async () => {
    const { state, port } = controls(ON);
    state.fail = true;
    const { model, store, events, raw } = await extract({ control: port, store: new RecordingStore([existing]) });

    expect(model.calls).toBe(0);
    expect(store.stored).toEqual([]);
    expect(store.updates).toEqual([]);
    expect(events).toContainEqual({ event: "memory_learning_control_failed" });
    for (const forbidden of ["u-1", "captions", "settings unavailable"]) expect(raw, forbidden).not.toContain(forbidden);
  });

  it("controls that fail between the two reads still write nothing", async () => {
    const { state, port } = controls(ON);
    const model = new CountingModel(() => {
      state.fail = true;
    });
    const { store } = await extract({ control: port, model });

    expect(store.stored).toEqual([]);
  });

  it("without controls wired, learning is exactly as before", async () => {
    const { store } = await extract({});
    expect(store.stored.map((m) => m.content)).toEqual(["User prefers short captions"]);
  });
});
