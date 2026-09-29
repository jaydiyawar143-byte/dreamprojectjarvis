// S7 Step 8 — embedding failure policy: DROP + STRUCTURED EVENT.
//
// When extraction cannot produce a valid embedding for a candidate, that
// candidate is NOT persisted and a `memory_embedding_failed` event is logged.
// A stored memory must always be recallable; a row with no embedding is not.
//
// Unit level: a recording store stands in for the database, so these run
// without PostgreSQL. The same policy is exercised against the real repository
// in memory-embedding-failure-policy-s7-pg.integration.test.ts.
//
// Written before the policy was implemented and expected to fail against the
// Step 5 code, which stored such candidates with no embedding at all.
import { describe, it, expect, vi, afterEach } from "vitest";
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
import { JarvisError } from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";
import { citeFirstUserMessage } from "./helpers/compliant-citation.js";

const DIMS = 4;
const SECRET_LIKE = "sk-proj-SHOULD-NEVER-BE-LOGGED-1234567890";

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

function model(contents: string[]): IAIProvider {
  return {
    id: "s7-model",
    name: "S7 model",
    defaultModel: "s7",
    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
      return {
        message: {
          role: "assistant",
          // S7.2 L2 — a compliant model: each candidate cites the user's message.
          content: citeFirstUserMessage(
            request,
            JSON.stringify({
              candidates: contents.map((content) => ({ type: "FACT", content, importance: 0.8, confidence: 1 })),
            })
          ),
        },
        finishReason: "stop",
        model: "s7",
      };
    },
    async listModels() {
      return ["s7"];
    },
    async isAvailable() {
      return true;
    },
  };
}

function embeddings(produce: (inputs: string[]) => number[][]): IEmbeddingProvider {
  return {
    id: "s7-embeddings",
    name: "S7 embeddings",
    dimensions: DIMS,
    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      return { embeddings: produce(inputs), model: "s7" };
    },
    async isAvailable() {
      return true;
    },
  };
}

/** Records what would be persisted; can be told to reject a vector like the repository does. */
class RecordingStore implements IMemoryStore {
  readonly id = "s7-recording";
  readonly name = "S7 recording";
  readonly stored: MemoryStoreRequest["memories"] = [];
  readonly updates: MemoryUpdateRequest[] = [];
  constructor(
    private readonly existing: MemoryRecord[] = [],
    private readonly rejectVectorFor: (content: string) => boolean = () => false
  ) {}
  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    for (const memory of request.memories) {
      if (memory.embedding && this.rejectVectorFor(memory.content)) {
        // What PrismaMemoryRepository throws when a vector cannot be stored;
        // the transaction has rolled back, so nothing is recorded.
        throw new JarvisError("MEMORY_EMBEDDING_FAILED", "The memory embedding could not be stored");
      }
    }
    this.stored.push(...request.memories);
    return [];
  }
  async update(request: MemoryUpdateRequest): Promise<MemoryRecord> {
    const target = this.existing.find((m) => m.id === request.memoryId)!;
    if (request.embedding && this.rejectVectorFor(request.content ?? target.content)) {
      throw new JarvisError("MEMORY_EMBEDDING_FAILED", "The memory embedding could not be stored");
    }
    this.updates.push(request);
    return target;
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

const unit = (i: number): number[] => Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0));

/** Every memory_embedding_failed event logged during `run`. */
async function captureEvents<T>(run: () => Promise<T>): Promise<{ result: T; events: Array<Record<string, unknown>>; raw: string }> {
  const lines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    })
  );
  try {
    const result = await run();
    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null && e.event === "memory_embedding_failed");
    return { result, events, raw: lines.join("\n") };
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
}

function service(contents: string[], provider: IEmbeddingProvider, store: IMemoryStore) {
  return new MemoryExtractionService({ aiProvider: model(contents), store, embeddingProvider: provider, maxRetries: 0 });
}

// S7.2 L1c-2: the user message must pass the learning gate for extraction to
// run at all — a message carrying a secret is now refused before the model
// (see memory-learning-shadow-s7.test.ts). SECRET_LIKE stays where these tests
// need it: inside the provider errors that must never reach the log.
// S7.2 L3: the user message must also SAY every fact these tests script, or
// validation holds the candidate before it is ever embedded.
const USER_STATEMENT =
  "I use S7 alpha fact, S7 bravo fact, S7 charlie fact, S7 delta fact, S7 fact one, S7 fact two, " +
  "S7 provider fact, S7 broken hidden fact and S7 rejected private fact. I now want S7 merge summaries as slides.";
const extractFor = (svc: MemoryExtractionService) =>
  svc.extract({
    userId: "user-s7",
    conversationId: "conv-s7",
    messages: [{ role: "user", messageId: "msg-s7", content: USER_STATEMENT }],
  });

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Failure types
// ---------------------------------------------------------------------------

describe("S7 embedding failure policy — drop + memory_embedding_failed", () => {
  it("1. provider failure: nothing persisted, event emitted", async () => {
    const store = new RecordingStore();
    const provider = embeddings(() => {
      throw new Error(`upstream 500: ${SECRET_LIKE}`);
    });

    const { result, events } = await captureEvents(() => extractFor(service(["S7 fact one", "S7 fact two"], provider, store)));

    expect(store.stored).toHaveLength(0);
    expect(result.meta.memoriesCreated).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "warn", stage: "embed", reason: "provider_error", candidateCount: 2, action: "dropped" });
  });

  it("2. invalid dimension: nothing persisted, event emitted", async () => {
    const store = new RecordingStore();
    const { result, events } = await captureEvents(() =>
      extractFor(service(["S7 fact"], embeddings((i) => i.map(() => [0.1, 0.2, 0.3])), store))
    );

    expect(store.stored).toHaveLength(0);
    expect(result.meta.memoriesCreated).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "validate", reason: "invalid_vector", problem: "dimensions", candidateIndex: 0, action: "dropped" });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("3. %s in the vector: nothing persisted, event emitted", async (_label, bad) => {
    const store = new RecordingStore();
    const { events } = await captureEvents(() =>
      extractFor(service(["S7 fact"], embeddings((i) => i.map(() => [1, bad, 0, 0])), store))
    );

    expect(store.stored).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "validate", reason: "invalid_vector", problem: "non_finite" });
  });

  it("4. empty vector: nothing persisted, event emitted", async () => {
    const store = new RecordingStore();
    const { events } = await captureEvents(() => extractFor(service(["S7 fact"], embeddings((i) => i.map(() => [])), store)));

    expect(store.stored).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "validate", reason: "invalid_vector", problem: "empty_or_malformed" });
  });

  it("4b. a response with the wrong number of vectors: nothing persisted, event emitted", async () => {
    const store = new RecordingStore();
    const { events } = await captureEvents(() =>
      extractFor(service(["S7 fact one", "S7 fact two"], embeddings(() => [unit(0)]), store))
    );

    expect(store.stored).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "embed", reason: "invalid_response", candidateCount: 2 });
  });

  it("5. repository rejects the vector: nothing persisted, event emitted, extraction still resolves", async () => {
    const store = new RecordingStore([], () => true);
    const { result, events } = await captureEvents(() =>
      extractFor(service(["S7 fact"], embeddings((i) => i.map(() => unit(0))), store))
    );

    expect(store.stored).toHaveLength(0);
    expect(result.meta.memoriesCreated).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "persist", reason: "storage_rejected", operation: "create", errorCode: "MEMORY_EMBEDDING_FAILED" });
  });

  it("5b. a merge whose vector is rejected leaves the existing memory untouched", async () => {
    const existing: MemoryRecord = {
      id: "existing-s7",
      userId: "user-s7",
      type: "FACT",
      content: "User prefers S7 merge reports as PDF.",
      importance: 0.8,
      confidence: 1,
      accessCount: 0,
      metadata: { embedding: unit(0) },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const candidate = "User now wants S7 merge summaries as slides.";
    const store = new RecordingStore([existing], (content) => content === candidate);
    // cos 0.8 to the existing memory: inside the merge range.
    const provider = embeddings((i) => i.map(() => [0.8, 0.6, 0, 0]));

    const { events } = await captureEvents(() => extractFor(service([candidate], provider, store)));

    expect(store.updates).toHaveLength(0);
    expect(store.stored).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "persist", reason: "storage_rejected", operation: "merge" });
  });

  it("5c. a non-embedding storage error still propagates, as before", async () => {
    const store = new RecordingStore();
    vi.spyOn(store, "store").mockRejectedValueOnce(new JarvisError("INVALID_REQUEST", "Memory content must not contain secrets"));

    await expect(extractFor(service(["S7 fact"], embeddings((i) => i.map(() => unit(0))), store))).rejects.toThrow(
      "Memory content must not contain secrets"
    );
  });
});

// ---------------------------------------------------------------------------
// Success, mixed candidates, security
// ---------------------------------------------------------------------------

describe("S7 embedding failure policy — valid candidates are unaffected", () => {
  it("6. successful extraction persists the memory with its embedding in vector and metadata", async () => {
    const store = new RecordingStore();
    const { result, events } = await captureEvents(() =>
      extractFor(service(["S7 fact"], embeddings((i) => i.map(() => unit(2))), store))
    );

    expect(events).toHaveLength(0);
    expect(result.meta.memoriesCreated).toBe(1);
    expect(store.stored).toHaveLength(1);
    expect(store.stored[0]!.embedding).toEqual(unit(2));
    expect(store.stored[0]!.metadata?.embedding).toEqual(unit(2));
  });

  it("7. mixed candidates: valid ones persist with their OWN embeddings, failed ones leave nothing", async () => {
    const contents = ["S7 alpha fact", "S7 bravo fact", "S7 charlie fact", "S7 delta fact"];
    const vectors = new Map<string, number[]>([
      ["S7 alpha fact", unit(0)],
      ["S7 bravo fact", [1, Number.NaN, 0, 0]], // invalid
      ["S7 charlie fact", unit(2)],
      ["S7 delta fact", unit(3)], // storage will reject this one
    ]);
    const store = new RecordingStore([], (content) => content === "S7 delta fact");

    const { result, events } = await captureEvents(() =>
      extractFor(service(contents, embeddings((i) => i.map((t) => vectors.get(t)!)), store))
    );

    expect(store.stored.map((m) => m.content)).toEqual(["S7 alpha fact", "S7 charlie fact"]);
    expect(store.stored[0]!.embedding).toEqual(unit(0));
    expect(store.stored[1]!.embedding).toEqual(unit(2));
    expect(store.stored.every((m) => Array.isArray(m.embedding) && m.metadata?.embedding === m.embedding)).toBe(true);
    expect(result.meta.memoriesCreated).toBe(2);
    expect(result.candidates.map((c) => c.content)).toEqual(["S7 alpha fact", "S7 charlie fact"]);
    expect(events.map((e) => [e.reason, e.candidateIndex])).toEqual([
      ["invalid_vector", 1],
      ["storage_rejected", 3],
    ]);
  });

  it("8. events carry no content, user text, embedding values, user id or provider message", async () => {
    const store = new RecordingStore([], (content) => content.includes("rejected"));
    const provider = embeddings((inputs) =>
      inputs.map((t) => (t.includes("broken") ? [0.123456789, Number.NaN, 0.987654321, 0.5] : [0.111111111, 0.222222222, 0.333333333, 0.444444444]))
    );

    const { events, raw } = await captureEvents(async () => {
      await extractFor(service(["S7 broken hidden fact", "S7 rejected private fact"], provider, store));
      await extractFor(
        service(
          ["S7 provider fact"],
          embeddings(() => {
            throw new Error(`provider said: ${SECRET_LIKE}`);
          }),
          store
        )
      );
    });

    expect(events).toHaveLength(3);
    const allowed = new Set([
      "level",
      "event",
      "stage",
      "reason",
      "problem",
      "operation",
      "candidateIndex",
      "candidateCount",
      "embeddingModel",
      "errorName",
      "errorCode",
      "action",
    ]);
    for (const event of events) {
      for (const key of Object.keys(event)) expect(allowed.has(key), `unexpected field ${key}`).toBe(true);
    }
    for (const forbidden of ["broken hidden fact", "rejected private fact", "provider fact", "user-s7", SECRET_LIKE, "I use S7", "0.123456789", "0.111111111", "provider said"]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
