// S7.2 L4 — evidence inside MemoryExtractionService.
//
// L4 sits on the three dedup outcomes, after L3 (only VALID + MEMORY arrives):
//   new        → the memory is stored with fresh evidence
//   duplicate  → no second row: the existing memory's evidence gains the
//                source (idempotent per message), its confidence is derived
//                and its expiry refreshed — content, vector, type and
//                provenance untouched
//   merge      → the existing merge, plus a revision: evidence restarts
// Evidence is computed for every outcome before anything is written; if the
// contract fails, the turn fails closed and writes nothing.
//
// resolveLearningEvidence is wrapped in a pass-through spy, so the REAL
// contract decides while a test can break it.
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
  LearningEvidence,
  MemoryListRequest,
  MemoryListResult,
  MemoryRecord,
  MemoryStoreRequest,
  MemoryUpdateRequest,
} from "@jarvis/core";

vi.mock("@jarvis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jarvis/core")>();
  return { ...actual, resolveLearningEvidence: vi.fn(actual.resolveLearningEvidence) };
});

import { resolveLearningEvidence } from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";

const resolve = vi.mocked(resolveLearningEvidence);
const DIMS = 4;
const DAY = 86_400_000;
const SHORT = [1, 0, 0, 0];
const SECRET_VALUE = ["Zq9", "Xv7", "Lp3", "Kd8"].join("");

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

type Candidate = Record<string, unknown>;

class ScriptedModel implements IAIProvider {
  readonly id = "l4-model";
  readonly name = "L4 model";
  readonly defaultModel = "l4";
  constructor(private readonly candidates: Candidate[]) {}
  async complete(_request: AICompletionRequest): Promise<AICompletionResponse> {
    return { message: { role: "assistant", content: JSON.stringify({ candidates: this.candidates }) }, finishReason: "stop", model: "l4" };
  }
  async listModels() {
    return ["l4"];
  }
  async isAvailable() {
    return true;
  }
}

/** A fixed vector per content; anything unlisted is orthogonal to everything here. */
class MapEmbeddings implements IEmbeddingProvider {
  readonly id = "l4-embeddings";
  readonly name = "L4 embeddings";
  readonly dimensions = DIMS;
  readonly inputs: string[][] = [];
  constructor(private readonly vectors: Record<string, number[]> = {}) {}
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    this.inputs.push(inputs);
    return { embeddings: inputs.map((t) => this.vectors[t] ?? [0, 0, 0, 1]), model: "l4" };
  }
  async isAvailable() {
    return true;
  }
}

class RecordingStore implements IMemoryStore {
  readonly id = "l4-store";
  readonly name = "L4 store";
  readonly stored: MemoryStoreRequest["memories"] = [];
  readonly storedFor: string[] = [];
  readonly updates: MemoryUpdateRequest[] = [];
  constructor(private readonly existing: MemoryRecord[] = []) {}
  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    this.stored.push(...request.memories);
    this.storedFor.push(request.userId);
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

const CREATED = new Date("2026-09-01T10:00:00.000Z");

function evidenceOf(sources: Array<[messageId: string, conversationId: string]>, over: Partial<LearningEvidence> = {}): LearningEvidence {
  const at = CREATED.toISOString();
  return {
    v: 1,
    count: sources.length,
    conversations: new Set(sources.map(([, c]) => c)).size,
    firstSeenAt: at,
    lastSeenAt: at,
    sources: sources.map(([messageId, conversationId]) => ({ messageId, conversationId, kind: "DIRECT" as const, at })),
    revisions: 0,
    previousSourceMessageIds: [],
    ...over,
  };
}

/** An existing memory. By default an L4-era one: evidence from msg-1 in conv-A. */
function memory(over: Partial<MemoryRecord> & { metadata?: Record<string, unknown> } = {}): MemoryRecord {
  return {
    id: "m-1",
    userId: "u-l4",
    type: "PREFERENCE",
    content: "User prefers short captions",
    importance: 0.7,
    confidence: 0.7,
    accessCount: 0,
    sourceType: "USER",
    sourceConversationId: "conv-A",
    sourceMessageId: "msg-1",
    metadata: { embedding: SHORT, evidence: evidenceOf([["msg-1", "conv-A"]]), modelConfidence: 0.85 },
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  } as MemoryRecord;
}

const user = (content: string, messageId: string, traceId = `trace-${messageId}`): ExtractionMessage => ({ role: "user", content, messageId, traceId });
const assistant = (content: string): ExtractionMessage => ({ role: "assistant", content });
const pref = (content: string, source: string, evidence: string, confidence = 0.9): Candidate => ({
  type: "PREFERENCE",
  content,
  importance: 0.8,
  confidence,
  source,
  evidence,
});

async function turn(opts: {
  candidates: Candidate[];
  messages: ExtractionMessage[];
  existing?: MemoryRecord[];
  vectors?: Record<string, number[]>;
  conversationId?: string;
  userId?: string;
}) {
  const store = new RecordingStore(opts.existing ?? []);
  const embeddings = new MapEmbeddings({ "User prefers short captions": SHORT, ...(opts.vectors ?? {}) });
  const service = new MemoryExtractionService({ aiProvider: new ScriptedModel(opts.candidates), store, embeddingProvider: embeddings, maxRetries: 0 });
  const lines: string[] = [];
  const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    })
  );
  const before = Date.now();
  try {
    const result = await service.extract({
      userId: opts.userId ?? "u-l4",
      conversationId: opts.conversationId ?? "conv-B",
      messages: opts.messages,
      expiryDays: 90,
    });
    const events = lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    return { store, embeddings, result, events, raw: lines.join("\n"), before, after: Date.now() };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

/** expiresAt is "now + 90 days", now being some moment during the turn. */
function expectRefreshed(expiresAt: unknown, before: number, after: number) {
  expect(expiresAt).toBeInstanceOf(Date);
  const t = (expiresAt as Date).getTime();
  expect(t).toBeGreaterThanOrEqual(before + 90 * DAY);
  expect(t).toBeLessThanOrEqual(after + 90 * DAY);
}

let realResolve: typeof resolveLearningEvidence;
const ready = vi.importActual<typeof import("@jarvis/core")>("@jarvis/core").then((actual) => {
  realResolve = actual.resolveLearningEvidence;
});

afterEach(() => {
  vi.restoreAllMocks();
  resolve.mockReset();
  resolve.mockImplementation((...args) => realResolve(...args));
});

// ---------------------------------------------------------------------------
// New
// ---------------------------------------------------------------------------

describe("L4 — a new memory is stored with its evidence", () => {
  it("DIRECT: evidence from the user's message, confidence 0.70, the model's number kept as modelConfidence", async () => {
    await ready;
    const { store, before, after } = await turn({
      candidates: [pref("User prefers short captions", "M1", "I prefer short captions", 0.9)],
      messages: [user("I prefer short captions.", "msg-9"), assistant("Noted.")],
    });

    expect(store.stored).toHaveLength(1);
    const stored = store.stored[0]!;
    expect(stored.confidence).toBe(0.7);
    expect(stored.metadata?.modelConfidence).toBe(0.9);
    const evidence = stored.metadata?.evidence as LearningEvidence;
    const at = evidence.firstSeenAt;
    expect(evidence).toEqual({
      v: 1,
      count: 1,
      conversations: 1,
      firstSeenAt: at,
      lastSeenAt: at,
      sources: [{ messageId: "msg-9", conversationId: "conv-B", traceId: "trace-msg-9", kind: "DIRECT", at }],
      revisions: 0,
      previousSourceMessageIds: [],
    });
    expect(Date.parse(at)).toBeGreaterThanOrEqual(before);
    expectRefreshed(stored.expiresAt, before, after);
    expect(stored.embedding).toEqual(SHORT);
    expect(stored.metadata?.embedding).toEqual(SHORT);
  });

  it("ENDORSEMENT: confidence 0.55", async () => {
    await ready;
    const { store } = await turn({
      candidates: [pref("User prefers short captions", "M1", "make that my default")],
      messages: [user("Yes, make that my default.", "msg-9"), assistant("Your default is short captions.")],
    });

    expect(store.stored[0]!.confidence).toBe(0.55);
    expect((store.stored[0]!.metadata?.evidence as LearningEvidence).sources[0]!.kind).toBe("ENDORSEMENT");
  });
});

// ---------------------------------------------------------------------------
// Duplicate → corroboration
// ---------------------------------------------------------------------------

describe("L4 — a duplicate corroborates the existing memory: one row, more evidence", () => {
  const restated = { candidates: [pref("User prefers short captions", "M1", "I prefer short captions")] };

  it("from another conversation: count 2, conversations 2, confidence 0.80 — and nothing but evidence, confidence and expiry changes", async () => {
    await ready;
    const { store, result, before, after } = await turn({
      ...restated,
      messages: [user("I prefer short captions.", "msg-2")],
      existing: [memory()],
      conversationId: "conv-B",
    });

    expect(store.stored).toEqual([]);
    expect(store.updates).toHaveLength(1);
    const update = store.updates[0]!;
    expect(Object.keys(update).sort()).toEqual(["confidence", "expiresAt", "memoryId", "metadata", "userId"]);
    expect(update).toMatchObject({ userId: "u-l4", memoryId: "m-1", confidence: 0.8 });
    expect(update.metadata).toMatchObject({ embedding: SHORT, modelConfidence: 0.85, evidence: { count: 2, conversations: 2 } });
    expect((update.metadata?.evidence as LearningEvidence).sources.map((s) => s.messageId)).toEqual(["msg-1", "msg-2"]);
    expectRefreshed(update.expiresAt, before, after);
    expect(result.meta).toMatchObject({ duplicatesSkipped: 1, memoriesCreated: 0, memoriesUpdated: 0 });
  });

  it("from the same conversation: count 2, conversations 1, confidence stays 0.70", async () => {
    await ready;
    const { store } = await turn({ ...restated, messages: [user("I prefer short captions.", "msg-2")], existing: [memory()], conversationId: "conv-A" });

    expect(store.updates[0]).toMatchObject({ confidence: 0.7, metadata: { evidence: { count: 2, conversations: 1 } } });
  });

  it("a replay of a message already counted writes nothing at all", async () => {
    await ready;
    const { store } = await turn({ ...restated, messages: [user("I prefer short captions.", "msg-1")], existing: [memory()], conversationId: "conv-A" });

    expect(store.updates).toEqual([]);
    expect(store.stored).toEqual([]);
  });

  it("two candidates from one message corroborate once", async () => {
    await ready;
    const { store } = await turn({
      candidates: [pref("User prefers short captions", "M1", "I prefer short captions"), pref("User prefers short captions", "M1", "I prefer short captions")],
      messages: [user("I prefer short captions.", "msg-2")],
      existing: [memory()],
    });

    expect(store.updates).toHaveLength(1);
    expect((store.updates[0]!.metadata?.evidence as LearningEvidence).count).toBe(2);
  });

  it("a memory from before L4, with no message id, starts evidence from this statement: nothing invented, its confidence kept as modelConfidence", async () => {
    await ready;
    const legacy = memory({ sourceType: "conversation", sourceMessageId: undefined, confidence: 0.95, metadata: { embedding: SHORT } });
    const { store } = await turn({ ...restated, messages: [user("I prefer short captions.", "msg-2")], existing: [legacy] });

    expect(store.updates[0]).toMatchObject({ confidence: 0.7, metadata: { modelConfidence: 0.95, evidence: { count: 1, conversations: 1 } } });
    expect((store.updates[0]!.metadata?.evidence as LearningEvidence).sources.map((s) => s.messageId)).toEqual(["msg-2"]);
  });
});

// ---------------------------------------------------------------------------
// Merge → revision
// ---------------------------------------------------------------------------

describe("L4 — a merge is a revision: evidence restarts from the new statement", () => {
  it("records the revision and the replaced statement's message, never inherits the old confidence", async () => {
    await ready;
    const strong = memory({
      content: "User likes brief captions",
      confidence: 0.9,
      metadata: {
        embedding: [0.8, 0.6, 0, 0],
        evidence: evidenceOf([["msg-1", "conv-A"], ["msg-2", "conv-C"], ["msg-3", "conv-D"]]),
        modelConfidence: 0.85,
        sourceTraceId: "trace-old",
      },
    });
    const { store, before, after } = await turn({
      candidates: [pref("User prefers short captions", "M1", "I prefer short captions", 0.6)],
      messages: [user("I prefer short captions.", "msg-9")],
      existing: [strong],
    });

    expect(store.stored).toEqual([]);
    expect(store.updates).toHaveLength(1);
    const update = store.updates[0]!;
    expect(update).toMatchObject({
      memoryId: "m-1",
      content: "User prefers short captions",
      confidence: 0.7,
      sourceType: "USER",
      sourceConversationId: "conv-B",
      sourceMessageId: "msg-9",
      embedding: SHORT,
      metadata: { embedding: SHORT, mergeCount: 1, modelConfidence: 0.6, sourceTraceId: "trace-msg-9" },
    });
    expect(update.metadata?.evidence).toMatchObject({
      count: 1,
      conversations: 1,
      revisions: 1,
      previousSourceMessageIds: ["msg-1"],
      sources: [{ messageId: "msg-9", conversationId: "conv-B", kind: "DIRECT" }],
    });
    expectRefreshed(update.expiresAt, before, after);
  });
});

// ---------------------------------------------------------------------------
// Nothing but VALID + MEMORY ever becomes evidence
// ---------------------------------------------------------------------------

describe("L4 — only VALID + MEMORY from a USER message becomes evidence", () => {
  it.each([
    ["HOLD (uncertain)", user("Maybe I prefer short captions.", "msg-h"), pref("User prefers short captions", "M1", "I prefer short captions")],
    ["INVALID (general)", user("Clients prefer short captions.", "msg-i"), pref("User prefers short captions", "M1", "prefer short captions")],
    ["INVALID (temporary)", user("For this client use short captions.", "msg-t"), pref("User prefers short captions", "M1", "use short captions")],
    ["assistant-only", user("Thanks, sounds good.", "msg-a"), pref("User prefers short captions", "M2", "You prefer short captions")],
  ])("%s: no evidence, no update, no new row — the existing memory is untouched", async (_label, message, candidate) => {
    await ready;
    const { store } = await turn({ candidates: [candidate], messages: [message, assistant("You prefer short captions.")], existing: [memory()] });

    expect(store.updates).toEqual([]);
    expect(store.stored).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("S5 feedback and S6 evaluation cannot enter: the only evidence source is the cited USER message, by its saved id", async () => {
    await ready;
    const { store } = await turn({
      candidates: [pref("User prefers short captions", "M1", "I prefer short captions")],
      messages: [user("I prefer short captions.", "msg-2"), assistant("👍 Great — that worked well.")],
      existing: [memory()],
    });

    expect(resolve.mock.calls.map(([event]) => [event.sourceMessageId, event.conversationId, event.evidenceKind])).toEqual([["msg-2", "conv-B", "DIRECT"]]);
    expect(Object.keys(resolve.mock.calls[0]![0]).sort()).toEqual(["conversationId", "evidenceKind", "kind", "occurredAt", "sourceMessageId", "traceId"]);
    expect(store.updates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Users and alignment
// ---------------------------------------------------------------------------

describe("L4 — scoped to the user, and vector-aligned", () => {
  it("another user's identical memory is never matched, corroborated or touched", async () => {
    await ready;
    const theirs = memory({ id: "m-theirs", userId: "u-other" });
    const { store } = await turn({
      candidates: [pref("User prefers short captions", "M1", "I prefer short captions")],
      messages: [user("I prefer short captions.", "msg-2")],
      existing: [theirs],
    });

    expect(store.updates).toEqual([]);
    expect(store.stored).toHaveLength(1);
    expect(store.storedFor).toEqual(["u-l4"]);
  });

  it("a corroboration carries no content and no vector; a revision carries the new content WITH its own vector", async () => {
    await ready;
    const { store } = await turn({
      candidates: [pref("User prefers short captions", "M1", "I prefer short captions"), pref("User prefers long captions", "M1", "I prefer long captions")],
      messages: [user("I prefer short captions. I prefer long captions.", "msg-2")],
      existing: [memory(), memory({ id: "m-2", content: "User likes lengthy captions", metadata: { embedding: [0, 0.8, 0.6, 0] } })],
      vectors: { "User prefers long captions": [0, 1, 0, 0] },
    });

    const [corroboration, revision] = store.updates;
    expect(corroboration).not.toHaveProperty("content");
    expect(corroboration).not.toHaveProperty("embedding");
    expect(corroboration!.metadata?.embedding).toEqual(SHORT);
    expect(revision).toMatchObject({ memoryId: "m-2", content: "User prefers long captions", embedding: [0, 1, 0, 0], metadata: { embedding: [0, 1, 0, 0] } });
  });
});

// ---------------------------------------------------------------------------
// Content-free, and fail-closed
// ---------------------------------------------------------------------------

describe("L4 — evidence never holds content", () => {
  it("no user text, JARVIS text, claim, quote or secret in the evidence, and none in the log", async () => {
    await ready;
    const { store, raw } = await turn({
      candidates: [pref(`User prefers short captions`, "M1", "I prefer short captions")],
      messages: [user(`I prefer short captions. Account ${SECRET_VALUE}`, "msg-2"), assistant(`Noted, ${SECRET_VALUE}.`)],
      existing: [memory()],
    });

    const evidence = JSON.stringify(store.updates[0]!.metadata?.evidence);
    for (const forbidden of [SECRET_VALUE, "short captions", "prefer", "Noted", "Account"]) {
      expect(evidence, forbidden).not.toContain(forbidden);
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });
});

describe("L4 — a failing evidence calculation fails the whole turn closed", () => {
  const conversation = [user("I prefer short captions. I prefer long captions.", "msg-2")];
  const candidates = [pref("User prefers long captions", "M1", "I prefer long captions"), pref("User prefers short captions", "M1", "I prefer short captions")];

  it.each([
    ["throws", () => { throw new Error(`evidence exploded near ${SECRET_VALUE}`); }],
    ["refuses the event", () => ({ accepted: false, reason: "INVALID_EVENT" })],
    ["returns malformed evidence", () => ({ accepted: true, reason: "CREATED", changed: true, refreshExpiry: true, confidence: 0.7, evidence: { v: 2 } })],
    ["returns a confidence out of range", () => ({ accepted: true, reason: "CREATED", changed: true, refreshExpiry: true, confidence: 2, evidence: evidenceOf([["x", "y"]]) })],
    ["returns nothing", () => undefined],
  ])("when it %s: no new row, no update, one content-free failure event", async (_label, fail) => {
    await ready;
    let calls = 0;
    resolve.mockImplementation(((...args: Parameters<typeof resolveLearningEvidence>) => {
      calls++;
      return calls === 2 ? (fail as () => never)() : realResolve(...args);
    }) as typeof resolveLearningEvidence);
    const { store, events, raw } = await turn({ candidates, messages: conversation, existing: [memory()] });

    expect(store.stored).toEqual([]);
    expect(store.updates).toEqual([]);
    expect(events.filter((e) => e.event === "memory_learning_evidence_failed")).toEqual([{ event: "memory_learning_evidence_failed" }]);
    for (const forbidden of [SECRET_VALUE, "evidence exploded", "captions", "msg-2", "u-l4"]) expect(raw, forbidden).not.toContain(forbidden);
  });
});

// ---------------------------------------------------------------------------
// L4.1 — a negated restatement never corroborates
// ---------------------------------------------------------------------------

describe("L4.1 — a statement and its negation never corroborate each other", () => {
  const REPORT = "User prefers to receive the weekly performance report every Monday morning";
  const NOT_REPORT = "User prefers not to receive the weekly performance report every Monday morning";
  const P = [0, 1, 0, 0];
  const N = [0, 0, 1, 0];
  const stored = (id: string, content: string, embedding: number[], source: [messageId: string, conversationId: string]) =>
    memory({ id, content, sourceMessageId: source[0], sourceConversationId: source[1], metadata: { embedding, evidence: evidenceOf([source]), modelConfidence: 0.85 } });

  it.each([
    ["a positive memory, then the negative statement", REPORT, NOT_REPORT],
    ["a negative memory, then the positive statement", NOT_REPORT, REPORT],
  ])("%s: the words overlap 0.92, yet it is a new memory, not a corroboration", async (_label, existing, said) => {
    await ready;
    const message = `${said.replace(/^User prefers/, "I prefer")}.`;
    const { store, result } = await turn({
      candidates: [pref(said, "M1", message.slice(0, -1))],
      messages: [user(message, "msg-2")],
      existing: [stored("m-report", existing, P, ["msg-1", "conv-A"])],
      vectors: { [said]: N }, // orthogonal: only the word overlap could call it a duplicate
    });

    // 11–13: the existing memory is never updated — no evidence, confidence or expiry change.
    expect(store.updates, "no corroboration update").toEqual([]);
    expect(result.meta.duplicatesSkipped).toBe(0);
    expect(store.stored).toHaveLength(1);
    expect(store.stored[0]).toMatchObject({ content: said, confidence: 0.7, embedding: N });
    expect((store.stored[0]!.metadata?.evidence as LearningEvidence).sources.map((s) => s.messageId)).toEqual(["msg-2"]);
  });

  it("the vector path too: an identical vector across a negation is a revision, never a corroboration — and the revision is correct", async () => {
    await ready;
    const { store, before, after } = await turn({
      candidates: [pref("User does not like spicy food", "M1", "I do not like spicy food")],
      messages: [user("I do not like spicy food.", "msg-2")],
      existing: [stored("m-spicy", "User likes spicy food", P, ["msg-1", "conv-A"])],
      vectors: { "User does not like spicy food": P }, // cosine 1.0: a duplicate by vector before L4.1
    });

    expect(store.stored).toEqual([]);
    expect(store.updates).toHaveLength(1);
    const update = store.updates[0]!;
    expect(update, "a revision: new content, provenance and vector").toMatchObject({
      memoryId: "m-spicy",
      content: "User does not like spicy food",
      sourceMessageId: "msg-2",
      embedding: P,
      confidence: 0.7,
    });
    expect(update.metadata?.evidence, "evidence restarts: no increment on the old evidence").toMatchObject({
      count: 1,
      conversations: 1,
      revisions: 1,
      previousSourceMessageIds: ["msg-1"],
      sources: [{ messageId: "msg-2", conversationId: "conv-B" }],
    });
    expectRefreshed(update.expiresAt, before, after); // the revision's refresh, as L4 defines it
  });

  it("9. the same polarity still corroborates exactly as before", async () => {
    await ready;
    const { store } = await turn({
      candidates: [pref(REPORT, "M1", "I prefer to receive the weekly performance report every Monday morning")],
      messages: [user("I prefer to receive the weekly performance report every Monday morning.", "msg-2")],
      existing: [stored("m-report", REPORT, P, ["msg-1", "conv-A"])],
      vectors: { [REPORT]: P },
    });

    expect(store.stored).toEqual([]);
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({ memoryId: "m-report", confidence: 0.8, metadata: { evidence: { count: 2, conversations: 2 } } });
  });

  it("a conflicting memory never shadows a genuine duplicate: the negative statement corroborates its own twin", async () => {
    await ready;
    const { store } = await turn({
      candidates: [pref(NOT_REPORT, "M1", "I prefer not to receive the weekly performance report every Monday morning")],
      messages: [user("I prefer not to receive the weekly performance report every Monday morning.", "msg-3")],
      // The positive memory is listed first: the word overlap reaches it first.
      existing: [stored("m-report", REPORT, P, ["msg-1", "conv-A"]), stored("m-not-report", NOT_REPORT, N, ["msg-2", "conv-C"])],
      vectors: { [NOT_REPORT]: N },
    });

    expect(store.stored).toEqual([]);
    expect(store.updates.map((u) => u.memoryId)).toEqual(["m-not-report"]);
    expect(store.updates[0]).toMatchObject({ confidence: 0.8, metadata: { evidence: { count: 2, conversations: 2 } } });
  });
});
