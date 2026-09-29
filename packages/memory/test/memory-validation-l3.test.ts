// S7.2 L3 — validation inside MemoryExtractionService.
//
// Order: L1 gate → extraction model → L2 provenance → L3 validation → the
// existing embed / dedup / merge / write. Only a VALID candidate with scope
// MEMORY goes on (L3 finalization: goals, tasks, project state, decisions and
// temporary scope are never memory);
// HOLD and INVALID are dropped one by one with a content-free
// `memory_candidate_validation_rejected` event. If the validator itself
// throws or answers with anything but a well-formed result, the whole turn
// fails closed: no embedding, no write, no update, and only
// { event: "memory_learning_validation_failed" } is logged.
//
// validateLearningCandidate is wrapped in a pass-through spy, so the REAL
// contract decides while the test can see, and sometimes break, the call.
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

vi.mock("@jarvis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jarvis/core")>();
  return { ...actual, validateLearningCandidate: vi.fn(actual.validateLearningCandidate) };
});

import { validateLearningCandidate } from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";

const validate = vi.mocked(validateLearningCandidate);
const DIMS = 4;
const unit = (i: number): number[] => Array.from({ length: DIMS }, (_, k) => (k === i % DIMS ? 1 : 0));
const SECRET_VALUE = ["Zq9", "Xv7", "Lp3", "Kd8", "Mw2"].join("");

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

type Candidate = Record<string, unknown>;

class ScriptedModel implements IAIProvider {
  readonly id = "l3-model";
  readonly name = "L3 model";
  readonly defaultModel = "l3";
  readonly requests: AICompletionRequest[] = [];
  constructor(private readonly candidates: Candidate[]) {}
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    return { message: { role: "assistant", content: JSON.stringify({ candidates: this.candidates }) }, finishReason: "stop", model: "l3" };
  }
  async listModels() {
    return ["l3"];
  }
  async isAvailable() {
    return true;
  }
}

class RecordingEmbeddings implements IEmbeddingProvider {
  readonly id = "l3-embeddings";
  readonly name = "L3 embeddings";
  readonly dimensions = DIMS;
  readonly inputs: string[][] = [];
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    this.inputs.push(inputs);
    return { embeddings: inputs.map((_, i) => unit(i)), model: "l3" };
  }
  async isAvailable() {
    return true;
  }
}

class RecordingStore implements IMemoryStore {
  readonly id = "l3-store";
  readonly name = "L3 store";
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

/** An earlier memory. With [0.8, 0.6, 0, 0] a new candidate embedded as unit(0) would MERGE into it. */
function earlier(content: string, embedding: number[]): MemoryRecord {
  return {
    id: "m-earlier",
    userId: "u-l3",
    type: "PREFERENCE",
    content,
    importance: 0.7,
    confidence: 0.9,
    accessCount: 0,
    sourceType: "USER",
    sourceConversationId: "conv-old",
    sourceMessageId: "msg-old",
    metadata: { embedding },
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

const user = (content: string, messageId: string, traceId = "trace-l3"): ExtractionMessage => ({ role: "user", content, messageId, traceId });
const assistant = (content: string): ExtractionMessage => ({ role: "assistant", content });
const pref = (content: string, source: string, evidence: string): Candidate => ({ type: "PREFERENCE", content, importance: 0.8, confidence: 0.9, source, evidence });

async function capture<T>(work: () => Promise<T>) {
  const lines: string[] = [];
  const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    })
  );
  try {
    const result = await work();
    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
    return {
      result,
      rejections: parsed.filter((e) => e.event === "memory_candidate_validation_rejected"),
      provenanceRejections: parsed.filter((e) => e.event === "memory_candidate_provenance_rejected"),
      failures: parsed.filter((e) => e.event === "memory_learning_validation_failed"),
      raw: lines.join("\n"),
    };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

let realValidate: typeof validateLearningCandidate;
const ready = vi.importActual<typeof import("@jarvis/core")>("@jarvis/core").then((actual) => {
  realValidate = actual.validateLearningCandidate;
});

afterEach(() => {
  vi.restoreAllMocks();
  validate.mockReset();
  validate.mockImplementation((input) => realValidate(input));
});

function extract(service: MemoryExtractionService, messages: ExtractionMessage[], conversationId = "conv-l3") {
  return capture(() => service.extract({ userId: "u-l3", conversationId, messages, expiryDays: 90 }));
}

// ---------------------------------------------------------------------------
// Case 1 — a direct statement is VALID and stored exactly as before
// ---------------------------------------------------------------------------

describe("L3 case 1 — a direct user statement is VALID and stored", () => {
  it("one memory, with USER provenance, and the validator saw only the candidate, the quote and the user's message", async () => {
    await ready;
    const { service, store } = setup([pref("User prefers short captions", "M1", "I prefer short captions")]);
    const { result, rejections } = await extract(service, [user("I prefer short captions.", "msg-1", "trace-1"), assistant("Noted: short captions.")]);

    expect(store.stored).toHaveLength(1);
    expect(store.stored[0]).toMatchObject({
      type: "PREFERENCE",
      content: "User prefers short captions",
      importance: 0.8,
      confidence: 0.9,
      sourceType: "USER",
      sourceConversationId: "conv-l3",
      sourceMessageId: "msg-1",
      embedding: unit(0),
      metadata: { embedding: unit(0), sourceTraceId: "trace-1" },
    });
    expect(result.meta).toMatchObject({ candidatesFound: 1, candidatesValidated: 1, candidatesFiltered: 0, memoriesCreated: 1 });
    expect(rejections).toEqual([]);
    expect(validate.mock.calls.map(([input]) => input)).toEqual([
      {
        claim: "User prefers short captions",
        evidence: "I prefer short captions",
        userMessage: "I prefer short captions.",
        provenance: { sourceType: "USER", sourceConversationId: "conv-l3", sourceMessageId: "msg-1", sourceTraceId: "trace-1" },
      },
    ]);
    // JARVIS's reply is never handed to the validator.
    expect(JSON.stringify(validate.mock.calls)).not.toContain("Noted");
  });
});

// ---------------------------------------------------------------------------
// Case 2 — the L2 residual: JARVIS's claim quoted against an acknowledgement
// ---------------------------------------------------------------------------

describe("L3 case 2 — JARVIS's claim quoted against 'Thanks, sounds good.' is HOLD: no memory", () => {
  it("L2 accepts the quote, L3 holds the claim: nothing embedded, stored or updated", async () => {
    await ready;
    const { service, store, embeddings } = setup(
      [pref("User prefers short captions", "M1", "Thanks, sounds good.")],
      [earlier("User likes brief captions", [0.8, 0.6, 0, 0])]
    );
    const { rejections, provenanceRejections } = await extract(service, [
      user("Thanks, sounds good.", "msg-2"),
      assistant("Your default style is short captions."),
    ]);

    expect(provenanceRejections).toEqual([]);
    expect(rejections).toEqual([
      {
        event: "memory_candidate_validation_rejected",
        decision: "HOLD",
        rule: "WEAK_ACKNOWLEDGEMENT",
        scope: "UNKNOWN",
        candidateIndex: 0,
        candidateCount: 1,
      },
    ]);
    expect(embeddings.inputs).toEqual([]);
    expect(store.stored).toEqual([]);
    expect(store.updates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — an assistant-only candidate never even reaches L3
// ---------------------------------------------------------------------------

describe("L3 case 3 — an assistant-only candidate", () => {
  it("is dropped by L2 before validation: no memory, and the validator is never asked", async () => {
    await ready;
    const { service, store } = setup([pref("User's default style is short captions", "M2", "your default style is short captions")]);
    const { provenanceRejections } = await extract(service, [
      user("Thanks, sounds good.", "msg-3"),
      assistant("I've decided that your default style is short captions."),
    ]);

    expect(provenanceRejections.map((e) => e.reason)).toEqual(["SOURCE_NOT_USER"]);
    expect(validate).not.toHaveBeenCalled();
    expect(store.stored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — explicit endorsement
// ---------------------------------------------------------------------------

describe("L3 case 4 — an explicit endorsement is VALID and points at the endorsement", () => {
  it("stores the memory with the endorsement message as its source", async () => {
    await ready;
    const { service, store } = setup([pref("User prefers short captions", "M1", "make that my default")]);
    const { rejections } = await extract(service, [
      user("Yes, make that my default.", "msg-endorse", "trace-endorse"),
      assistant("Your default is short captions."),
    ]);

    expect(rejections).toEqual([]);
    expect(store.stored).toHaveLength(1);
    expect(store.stored[0]).toMatchObject({ sourceType: "USER", sourceMessageId: "msg-endorse", metadata: { sourceTraceId: "trace-endorse" } });
  });
});

// ---------------------------------------------------------------------------
// Case 5 — temporary
// ---------------------------------------------------------------------------

describe("L3 case 5 — temporary scope", () => {
  it("a one-off instruction the gate lets through is INVALID at L3: no memory", async () => {
    await ready;
    const { service, store, model } = setup([pref("User prefers short captions", "M1", "use short captions")]);
    const { rejections } = await extract(service, [user("For this client use short captions.", "msg-5")]);

    expect(model.requests).toHaveLength(1);
    expect(rejections.map((e) => [e.decision, e.rule, e.scope])).toEqual([["INVALID", "TEMPORARY_SCOPE", "TEMPORARY"]]);
    expect(store.stored).toEqual([]);
  });

  it("a temporary instruction L1 rejects never reaches the model, so never reaches L3", async () => {
    await ready;
    const { service, store, model } = setup([pref("User prefers short captions", "M1", "use short captions")]);
    await extract(service, [user("For this campaign only use short captions.", "msg-5b")]);

    expect(model.requests).toHaveLength(0);
    expect(validate).not.toHaveBeenCalled();
    expect(store.stored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — per candidate: VALID + HOLD + INVALID (+ an L2 drop)
// ---------------------------------------------------------------------------

describe("L3 case 6 — only the VALID candidate of a batch is stored", () => {
  it("VALID is stored with its own embedding; HOLD, INVALID and the L2 drop are not", async () => {
    await ready;
    const { service, store, embeddings } = setup([
      pref("User prefers short captions", "M1", "I prefer short captions"),
      pref("User always prefers short captions", "M1", "I prefer short captions"),
      pref("User prefers dark mode", "M1", "I prefer short captions"),
      pref("User's default channel is LinkedIn", "M2", "Your default channel is LinkedIn"),
    ]);
    const { result, rejections, provenanceRejections } = await extract(service, [
      user("I prefer short captions.", "msg-6"),
      assistant("Your default channel is LinkedIn."),
    ]);

    expect(embeddings.inputs).toEqual([["User prefers short captions"]]);
    expect(store.stored.map((m) => [m.content, m.sourceMessageId, m.embedding])).toEqual([["User prefers short captions", "msg-6", unit(0)]]);
    expect(rejections.map((e) => [e.candidateIndex, e.decision, e.rule, e.scope])).toEqual([
      [1, "HOLD", "CLAIM_EXCEEDS_EVIDENCE", "MEMORY"],
      [2, "INVALID", "CLAIM_NOT_SUPPORTED", "MEMORY"],
    ]);
    expect(provenanceRejections.map((e) => e.candidateIndex)).toEqual([3]);
    expect(result.meta).toMatchObject({ candidatesFound: 4, candidatesValidated: 4, candidatesFiltered: 3, memoriesCreated: 1 });
  });
});

// ---------------------------------------------------------------------------
// Case 7 — the validator fails: the whole turn fails closed
// ---------------------------------------------------------------------------

describe("L3 case 7 — a validator failure fails the whole turn closed", () => {
  const conversation = [user(`I prefer short captions. Account ${SECRET_VALUE}`, "msg-7"), assistant("Noted.")];

  it.each([
    ["throws", () => { throw new Error(`validator exploded near ${SECRET_VALUE}`); }],
    ["returns an unknown decision", () => ({ decision: "MAYBE", rule: "DIRECT_USER_STATEMENT", scope: "MEMORY", category: "STABLE_PREFERENCE" })],
    ["returns an unknown rule", () => ({ decision: "VALID", rule: "LOOKS_FINE", scope: "MEMORY" })],
    ["returns VALID with a HOLD rule", () => ({ decision: "VALID", rule: "WEAK_ACKNOWLEDGEMENT", scope: "UNKNOWN" })],
    ["returns VALID outside the MEMORY scope", () => ({ decision: "VALID", rule: "EXPLICIT_ENDORSEMENT", scope: "GOAL" })],
    ["returns a result with no scope", () => ({ decision: "VALID", rule: "EXPLICIT_ENDORSEMENT" })],
    ["returns a direct statement without its category", () => ({ decision: "VALID", rule: "DIRECT_USER_STATEMENT", scope: "MEMORY" })],
    ["returns null", () => null],
    ["reports malformed input", () => ({ decision: "INVALID", rule: "MALFORMED_INPUT", scope: "UNKNOWN" })],
    ["reports missing provenance", () => ({ decision: "INVALID", rule: "PROVENANCE_MISSING", scope: "UNKNOWN" })],
  ])("when the validator %s: no embedding, no write, no update, one content-free failure event", async (_label, fail) => {
    await ready;
    validate.mockImplementation(fail as never);
    const { service, store, embeddings } = setup(
      [pref("User prefers short captions", "M1", "I prefer short captions")],
      [earlier("User likes brief captions", [0.8, 0.6, 0, 0])]
    );
    const { result, failures, rejections, raw } = await extract(service, conversation);

    expect(embeddings.inputs).toEqual([]);
    expect(store.stored).toEqual([]);
    expect(store.updates).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(failures).toEqual([{ event: "memory_learning_validation_failed" }]);
    expect(rejections).toEqual([]);
    for (const forbidden of [SECRET_VALUE, "validator exploded", "short captions", "msg-7", "u-l3"]) expect(raw).not.toContain(forbidden);
  });

  it("a failure on a later candidate discards the whole turn, even after a VALID one", async () => {
    await ready;
    let calls = 0;
    validate.mockImplementation((input) => {
      calls++;
      if (calls === 2) throw new Error("second candidate failed");
      return realValidate(input);
    });
    const { service, store, embeddings } = setup([
      pref("User prefers short captions", "M1", "I prefer short captions"),
      pref("User prefers short captions", "M1", "I prefer short captions"),
    ]);
    const { failures } = await extract(service, [user("I prefer short captions.", "msg-7b")]);

    expect(failures).toEqual([{ event: "memory_learning_validation_failed" }]);
    expect(embeddings.inputs).toEqual([]);
    expect(store.stored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Existing memories: HOLD and INVALID never touch them; L3 corrects nothing
// ---------------------------------------------------------------------------

describe("L3 — existing memories", () => {
  it("control: a VALID candidate close to an earlier memory still merges into it, exactly as before L3", async () => {
    await ready;
    const { service, store } = setup([pref("User prefers short captions", "M1", "I prefer short captions")], [
      earlier("User likes brief captions", [0.8, 0.6, 0, 0]),
    ]);
    await extract(service, [user("I prefer short captions.", "msg-m")]);

    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({ memoryId: "m-earlier", sourceMessageId: "msg-m" });
  });

  it.each([
    ["HOLD", "Maybe I prefer short captions.", "I prefer short captions"],
    ["INVALID", "Clients prefer short captions.", "prefer short captions"],
  ])("a %s candidate close to an earlier memory neither merges nor writes", async (_label, message, evidence) => {
    await ready;
    const { service, store } = setup([pref("User prefers short captions", "M1", evidence)], [
      earlier("User likes brief captions", [0.8, 0.6, 0, 0]),
    ]);
    await extract(service, [user(message, "msg-h")]);

    expect(store.updates).toEqual([]);
    expect(store.stored).toEqual([]);
  });

  it("28/29. a VALID contradicting preference is stored as a new memory; L3 does not correct or delete the old one", async () => {
    await ready;
    // Orthogonal to the new candidate (unit(0)): the existing dedup neither skips nor merges.
    const { service, store } = setup([pref("User prefers long captions", "M1", "I prefer long captions now")], [
      earlier("User prefers short captions", [0, 0, 0, 1]),
    ]);
    const { rejections } = await extract(service, [user("Actually, I prefer long captions now.", "msg-j")]);

    expect(rejections).toEqual([]);
    expect(store.stored.map((m) => m.content)).toEqual(["User prefers long captions"]);
    expect(store.updates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The event carries no content
// ---------------------------------------------------------------------------

describe("L3 — the validation event is content-free", () => {
  it("no claim, quote, user text, JARVIS text, secret or id reaches the log", async () => {
    await ready;
    const { service } = setup([
      pref(`User's code word is ${SECRET_VALUE}`, "M1", "Thanks, sounds good."),
      pref("User prefers teal banners", "M1", "sounds good"),
    ]);
    const { rejections, raw } = await extract(
      service,
      [user("Thanks, sounds good.", "msg-private", "trace-private"), assistant(`Your code word is ${SECRET_VALUE}.`)],
      "conv-private"
    );

    expect(rejections.map((e) => e.rule)).toEqual(["WEAK_ACKNOWLEDGEMENT", "WEAK_ACKNOWLEDGEMENT"]);
    for (const e of rejections) expect(Object.keys(e).sort()).toEqual(["candidateCount", "candidateIndex", "decision", "event", "rule", "scope"]);
    for (const forbidden of [SECRET_VALUE, "code word", "teal", "Thanks", "sounds good", "msg-private", "trace-private", "conv-private", "u-l3"]) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// L3 finalization — scope: only durable USER memory is ever written
// ---------------------------------------------------------------------------

describe("L3 finalization — goals, tasks, project state, decisions and temporary scope never become memory", () => {
  it.each([
    ["GOAL", "I want to launch my SaaS by Q3.", "User wants to launch their SaaS by Q3.", "I want to launch my SaaS by Q3", "GOAL_OR_TASK"],
    ["TASK", "Remind me to call the client.", "Remind user to call the client.", "Remind me to call the client", "GOAL_OR_TASK"],
    ["PROJECT", "The current project uses Next.js.", "User's current project uses Next.js.", "The current project uses Next.js", "PROJECT_OR_CURRENT_CONTEXT"],
    ["DECISION", "I decided to use PostgreSQL.", "User decided to use PostgreSQL.", "I decided to use PostgreSQL", "CURRENT_DECISION"],
    ["TEMPORARY", "For today's post use this style.", "User prefers this style.", "use this style", "TEMPORARY_SCOPE"],
  ])("%s: the gate lets the turn through, the model extracts it, L3 refuses it — nothing embedded, written or merged", async (scope, message, claim, evidence, rule) => {
    await ready;
    const { service, store, embeddings, model } = setup([pref(claim, "M1", evidence)], [earlier("User likes brief captions", [0.8, 0.6, 0, 0])]);
    const { rejections } = await extract(service, [user(message, `msg-${scope}`), assistant("Noted.")]);

    expect(model.requests).toHaveLength(1);
    expect(rejections.map((e) => [e.decision, e.rule, e.scope])).toEqual([["INVALID", rule, scope]]);
    expect(embeddings.inputs).toEqual([]);
    expect(store.stored).toEqual([]);
    expect(store.updates).toEqual([]);
  });

  it("an undecided first-person statement ('My company uses Meta Ads.') is HOLD: nothing written", async () => {
    await ready;
    const { service, store } = setup([pref("User's company uses Meta Ads", "M1", "My company uses Meta Ads")]);
    const { rejections } = await extract(service, [user("My company uses Meta Ads.", "msg-hold")]);

    expect(rejections.map((e) => [e.decision, e.rule, e.scope])).toEqual([["HOLD", "NOT_ESTABLISHED", "UNKNOWN"]]);
    expect(store.stored).toEqual([]);
  });

  it("a stored memory carries no new field: scope and category stay a validation result, not a column", async () => {
    await ready;
    const { service, store } = setup([pref("User prefers short captions", "M1", "I prefer short captions")]);
    await extract(service, [user("I prefer short captions.", "msg-shape", "trace-shape")]);

    expect(store.stored).toHaveLength(1);
    expect(Object.keys(store.stored[0]!).sort()).toEqual([
      "confidence",
      "content",
      "embedding",
      "expiresAt",
      "importance",
      "metadata",
      "sourceConversationId",
      "sourceMessageId",
      "sourceType",
      "summary",
      "type",
    ]);
    expect(Object.keys(store.stored[0]!.metadata!).sort()).toEqual(["embedding", "sourceTraceId"]);
  });
});

describe("L3 finalization — JARVIS suggests, the user answers", () => {
  const suggestion = assistant("You prefer short captions, right?");

  it("'Okay.' — dropped before the model (pre-filter and gate): nothing extracted, nothing written", async () => {
    await ready;
    const { service, store, model } = setup([pref("User prefers short captions", "M1", "Okay.")]);
    await extract(service, [user("Okay.", "msg-ok"), suggestion]);

    expect(model.requests).toHaveLength(0);
    expect(store.stored).toEqual([]);
  });

  it("'Okay, sounds good.' — reaches the model, but L3 holds it: nothing written", async () => {
    await ready;
    const { service, store } = setup([pref("User prefers short captions", "M1", "Okay, sounds good.")]);
    const { rejections } = await extract(service, [user("Okay, sounds good.", "msg-ok2"), suggestion]);

    expect(rejections.map((e) => [e.decision, e.rule])).toEqual([["HOLD", "WEAK_ACKNOWLEDGEMENT"]]);
    expect(store.stored).toEqual([]);
  });

  it("'That's my preference.' — an explicit endorsement is VALID, and the memory points at the USER's message", async () => {
    await ready;
    const { service, store } = setup([pref("User prefers short captions", "M1", "That's my preference")]);
    const { rejections } = await extract(service, [user("That's my preference.", "msg-endorse-2", "trace-e2"), suggestion]);

    expect(rejections).toEqual([]);
    expect(store.stored).toHaveLength(1);
    expect(store.stored[0]).toMatchObject({ sourceType: "USER", sourceMessageId: "msg-endorse-2" });
  });

  it("citing JARVIS's suggestion itself is never USER evidence", async () => {
    await ready;
    const { service, store } = setup([pref("User prefers short captions", "M2", "You prefer short captions")]);
    const { provenanceRejections } = await extract(service, [user("That's my preference.", "msg-endorse-3"), suggestion]);

    expect(provenanceRejections.map((e) => e.reason)).toEqual(["SOURCE_NOT_USER"]);
    expect(store.stored).toEqual([]);
  });
});
