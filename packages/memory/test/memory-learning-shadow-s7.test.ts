// S7.2 L1c — the learning contract inside MemoryExtractionService.
//
// After the existing pre-filter and before the model call, every role:"user"
// message is classified VERBATIM with statedBy "USER", and the verdict is
// logged as { event, decision, rule } — nothing else (L1c-1, shadow).
//
// L1c-2 enforces it for the whole turn, most serious verdict first:
// REJECT, NOT_A_CANDIDATE or PERMISSION_LANGUAGE → no model call, no memory.
// ACCEPT and UNDECIDED → the existing pipeline, exactly as before. ACCEPT is
// eligibility, never a write of its own. (Since S7.2 L3 that pipeline
// validates each candidate before anything is written.)
//
// L1c finalization — the gate FAILS CLOSED: a contract that throws or returns
// no valid verdict stops the turn (no model call, no write, no update) and
// logs only { event: "memory_learning_decision_failed" }.
//
// decideLearningCandidate is wrapped in a pass-through spy, so the REAL
// contract decides while the test sees exactly what it was given.
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
  return { ...actual, decideLearningCandidate: vi.fn(actual.decideLearningCandidate) };
});

import { decideLearningCandidate, LEARNING_RULES } from "@jarvis/core";
import { MemoryExtractionService } from "../src/memory-extraction-service.js";
import { citeFirstUserMessage } from "./helpers/compliant-citation.js";

const classify = vi.mocked(decideLearningCandidate);
const DIMS = 4;

/** Built at runtime: no token-shaped literal in this file or a failure message. */
const SECRET_VALUE = ["Zq9", "Xv7", "Lp3", "Kd8", "Mw2"].join("");

// ---------------------------------------------------------------------------
// Stand-ins — the same shapes the S7 failure-policy tests use
// ---------------------------------------------------------------------------

class RecordingModel implements IAIProvider {
  readonly id = "l1c-model";
  readonly name = "L1c model";
  readonly defaultModel = "l1c";
  readonly requests: AICompletionRequest[] = [];
  constructor(
    private readonly contents: string[],
    private readonly order?: string[]
  ) {}
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.order?.push("model");
    this.requests.push(request);
    return {
      message: {
        role: "assistant",
        // S7.2 L2 — a compliant model: each candidate cites the user's message.
        content: citeFirstUserMessage(
          request,
          JSON.stringify({
            candidates: this.contents.map((content) => ({ type: "PREFERENCE", content, importance: 0.8, confidence: 1 })),
          })
        ),
      },
      finishReason: "stop",
      model: "l1c",
    };
  }
  async listModels() {
    return ["l1c"];
  }
  async isAvailable() {
    return true;
  }
}

const unit = (i: number): number[] => Array.from({ length: DIMS }, (_, k) => (k === i % DIMS ? 1 : 0));

function embeddings(): IEmbeddingProvider {
  return {
    id: "l1c-embeddings",
    name: "L1c embeddings",
    dimensions: DIMS,
    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      return { embeddings: inputs.map((_, i) => unit(i)), model: "l1c" };
    },
    async isAvailable() {
      return true;
    },
  };
}

class RecordingStore implements IMemoryStore {
  readonly id = "l1c-store";
  readonly name = "L1c store";
  readonly stored: MemoryStoreRequest["memories"] = [];
  readonly updates: MemoryUpdateRequest[] = [];
  async store(request: MemoryStoreRequest): Promise<MemoryRecord[]> {
    this.stored.push(...request.memories);
    return [];
  }
  async update(request: MemoryUpdateRequest): Promise<MemoryRecord> {
    this.updates.push(request);
    return {} as MemoryRecord;
  }
  async list(): Promise<MemoryListResult> {
    return { memories: [], total: 0, hasMore: false };
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

/** A store holding one earlier memory close enough (0.8) to "User prefers short captions" to be merged into. */
class MergeStore extends RecordingStore {
  override async list(): Promise<MemoryListResult> {
    const existing = {
      id: "m-existing",
      userId: "u-l1c",
      type: "PREFERENCE",
      content: "User likes brief captions",
      importance: 0.7,
      confidence: 0.9,
      accessCount: 0,
      metadata: { embedding: [0.8, 0.6, 0, 0] },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as unknown as MemoryRecord;
    return { memories: [existing], total: 1, hasMore: false };
  }
}

function setup(contents: string[] = ["User prefers short captions", "User works late"], order?: string[], store: RecordingStore = new RecordingStore()) {
  const model = new RecordingModel(contents, order);
  const service = new MemoryExtractionService({ aiProvider: model, store, embeddingProvider: embeddings(), maxRetries: 0 });
  return { model, store, service };
}

// S7.2 L2 — a user message carries its saved id, as the orchestrator supplies it.
const user = (content: string): ExtractionMessage => ({ role: "user", content, messageId: "msg-l1c" });
const assistant = (content: string): ExtractionMessage => ({ role: "assistant", content });

/** Runs `work`, capturing every console line and the learning events among them. */
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
    const events = parsed.filter((e) => e.event === "memory_learning_decision");
    const failures = parsed.filter((e) => e.event === "memory_learning_decision_failed");
    return { result, events, failures, raw: lines.join("\n") };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

/** What extraction DID, independent of timing: the model's input, what was stored, the counts. */
function observable(model: RecordingModel, store: RecordingStore, result: Awaited<ReturnType<MemoryExtractionService["extract"]>>) {
  const meta: Partial<typeof result.meta> = { ...result.meta };
  delete meta.processingTimeMs;
  return {
    modelInput: model.requests.map((r) => r.messages),
    stored: store.stored.map((m) => ({ type: m.type, content: m.content, embedding: m.embedding })),
    updates: store.updates.length,
    meta,
  };
}

/** The real contract, for tests that wrap or restore the spy. */
let realDecide: typeof decideLearningCandidate;
const ready = vi.importActual<typeof import("@jarvis/core")>("@jarvis/core").then((actual) => {
  realDecide = actual.decideLearningCandidate;
});

afterEach(() => {
  vi.restoreAllMocks();
  classify.mockReset();
  classify.mockImplementation((input) => realDecide(input));
});

// ---------------------------------------------------------------------------
// Where and on what the contract runs
// ---------------------------------------------------------------------------

describe("L1c-1 — the contract runs after the pre-filter, before the model", () => {
  it("1. the pre-filter runs first, then the classification, then the model", async () => {
    await ready;
    const order: string[] = [];
    const { service } = setup(undefined, order);
    const preFilter = service.preFilter.bind(service);
    vi.spyOn(service, "preFilter").mockImplementation((messages) => {
      order.push("preFilter");
      return preFilter(messages);
    });
    classify.mockImplementation((input) => {
      order.push("classify");
      return realDecide(input);
    });

    await capture(() => service.extract({ userId: "u-l1c", messages: [user("I prefer short captions.")] }));

    expect(order).toEqual(["preFilter", "classify", "model"]);
  });

  it("1b. a user message the pre-filter removes is never classified", async () => {
    await ready;
    const { service, model } = setup();
    const { events } = await capture(() =>
      service.extract({
        userId: "u-l1c",
        messages: [user("ok"), user(`api_key=${SECRET_VALUE}${SECRET_VALUE}`), user("My preferred design style is minimal.")],
      })
    );

    expect(classify.mock.calls.map(([input]) => input.statement)).toEqual(["My preferred design style is minimal."]);
    expect(events).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
  });

  it("1c. when the pre-filter leaves no user message, nothing is classified and nothing changes", async () => {
    await ready;
    const { service, model, store } = setup();
    const { events } = await capture(() =>
      service.extract({ userId: "u-l1c", messages: [user("ok"), assistant("You prefer short captions.")] })
    );

    expect(classify).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
    expect(store.stored).toHaveLength(0);
  });

  it("2. every user message is classified verbatim, with statedBy USER", async () => {
    await ready;
    const odd = "  I prefer  SHORT captions \u{1F600}  ";
    const { service } = setup();
    await capture(() => service.extract({ userId: "u-l1c", messages: [user(odd)] }));

    expect(classify.mock.calls).toEqual([[{ statement: odd, statedBy: "USER" }]]);
  });

  it("3 & 4. JARVIS's reply is never passed — not even when it looks like a stable preference", async () => {
    await ready;
    const reply = "You prefer short captions, and your default platform is Instagram.";
    const { service } = setup();
    await capture(() =>
      service.extract({ userId: "u-l1c", messages: [user("Thanks for the draft, looks fine to me"), assistant(reply)] })
    );

    expect(classify).toHaveBeenCalledTimes(1);
    for (const [input] of classify.mock.calls) {
      expect(input.statedBy).toBe("USER");
      expect(input.statement).not.toContain("You prefer");
      expect(input.statement).not.toBe(reply);
    }
  });

  it("3 & 4b. model candidates and paraphrases are never passed either", async () => {
    await ready;
    const paraphrase = "User prefers short captions";
    const { service } = setup([paraphrase]);
    await capture(() => service.extract({ userId: "u-l1c", messages: [user("I prefer short captions.")] }));

    expect(classify.mock.calls.map(([input]) => input.statement)).toEqual(["I prefer short captions."]);
  });

  it("5. multiple user messages each receive their own decision, in order", async () => {
    await ready;
    const { service } = setup();
    const { events } = await capture(() =>
      service.extract({
        userId: "u-l1c",
        messages: [
          user("I prefer short captions."),
          assistant("Noted, short captions it is."),
          user("Don't send this yet."),
          user("Maybe I prefer serif fonts."),
        ],
      })
    );

    expect(classify.mock.calls.map(([input]) => input.statement)).toEqual([
      "I prefer short captions.",
      "Don't send this yet.",
      "Maybe I prefer serif fonts.",
    ]);
    expect(events).toEqual([
      { event: "memory_learning_decision", decision: "ACCEPT", rule: "STABLE_PREFERENCE" },
      { event: "memory_learning_decision", decision: "REJECT", rule: "TEMPORARY_INSTRUCTION" },
      { event: "memory_learning_decision", decision: "UNDECIDED", rule: "AMBIGUOUS_PREFERENCE" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The event carries the verdict and nothing else
// ---------------------------------------------------------------------------

describe("L1c-1 — the shadow event", () => {
  it("6. contains exactly event, decision and rule", async () => {
    await ready;
    const { service } = setup();
    const { events } = await capture(() => service.extract({ userId: "u-l1c", messages: [user("I work from 10 AM to 6:30 PM.")] }));

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual(["decision", "event", "rule"]);
    expect(["REJECT", "NOT_A_CANDIDATE", "ACCEPT", "UNDECIDED"]).toContain(events[0]!.decision);
    expect(LEARNING_RULES as readonly unknown[]).toContain(events[0]!.rule);
  });

  it("7, 8 & 9. no user text, no JARVIS text, no candidate text, no secret value and no user id reach the log", async () => {
    await ready;
    const userText = "Keep my social media captions concise for Brand Nimbus";
    // Passes the existing pre-filter, but the contract recognises it as a secret.
    const secretText = `My password is ${SECRET_VALUE}`;
    const reply = "Understood, Nimbus captions will stay concise.";
    const candidate = "User wants concise captions for Brand Nimbus";
    const { service } = setup([candidate]);

    const { events, raw } = await capture(() =>
      service.extract({ userId: "u-secret-owner", messages: [user(userText), user(secretText), assistant(reply)] })
    );

    expect(events.map((e) => e.rule)).toEqual(["STABLE_WORKING_CONVENTION", "CONTAINS_SECRET"]);
    for (const forbidden of [userText, "Nimbus", secretText, SECRET_VALUE, reply, candidate, "u-secret-owner", "password"]) {
      expect(raw, "a forbidden fragment reached the log").not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// L1c-2 — enforcement
// ---------------------------------------------------------------------------

/** One extraction of a single user message; what the model and the store saw. */
async function extractOne(statement: string, contents: string[] = ["User prefers short captions"]) {
  await ready;
  const { service, model, store } = setup(contents);
  const { result, events, failures, raw } = await capture(() =>
    service.extract({ userId: "u-l1c", conversationId: "c-1", messages: [user(statement)] })
  );
  return { result, events, failures, raw, model, store };
}

describe("L1c-2 — ACCEPT and UNDECIDED continue through the existing pipeline", () => {
  it("1. ACCEPT — 'I prefer short captions' reaches the model and stores what extraction produces", async () => {
    const { events, model, store, result } = await extractOne("I prefer short captions");
    expect(events).toEqual([{ event: "memory_learning_decision", decision: "ACCEPT", rule: "STABLE_PREFERENCE" }]);
    expect(model.requests).toHaveLength(1);
    // ACCEPT writes nothing itself: what is stored is the model's candidate, via the existing store path.
    expect(store.stored.map((m) => m.content)).toEqual(["User prefers short captions"]);
    expect(result.meta.memoriesCreated).toBe(1);
  });

  // S7.2 L3 — UNDECIDED still reaches the model; whether anything is STORED
  // is now L3's decision. Uncertain words ("I think …") are HOLD: nothing.
  it("2. UNDECIDED — 'I think short captions are better' reaches the model; L3 then holds it, so nothing is stored", async () => {
    const { events, model, store, result, raw } = await extractOne("I think short captions are better");
    expect(events).toEqual([{ event: "memory_learning_decision", decision: "UNDECIDED", rule: "AMBIGUOUS_PREFERENCE" }]);
    expect(model.requests).toHaveLength(1);
    expect(store.stored).toEqual([]);
    expect(result.meta.memoriesCreated).toBe(0);
    expect(raw).toContain('"event":"memory_candidate_validation_rejected","decision":"HOLD","rule":"UNCERTAIN_LANGUAGE"');
  });

  // S7.2 L3 — the user states both scripted facts, so L3 validates both and the
  // comparison is about the gate alone.
  it("ACCEPT and UNDECIDED leave extraction byte-for-byte as it was", async () => {
    const conversation = [user("I prefer short captions and I work late."), assistant("Short captions noted.")];
    const runWith = async (decide: () => ReturnType<typeof decideLearningCandidate>) => {
      await ready;
      classify.mockImplementation(decide);
      const { service, model, store } = setup();
      const { result } = await capture(() => service.extract({ userId: "u-l1c", messages: conversation, conversationId: "c-1" }));
      return observable(model, store, result);
    };
    const first = await runWith(() => ({ decision: "ACCEPT", rule: "STABLE_PREFERENCE" }));

    // Exactly what the pipeline after the gate produces for this conversation:
    // one model call over both messages (labelled by speaker since S7.2 L2),
    // and the model's candidates stored with their own vectors.
    expect(first.modelInput).toHaveLength(1);
    const prompt = first.modelInput[0]!.map((m) => m.content).join("\n");
    expect(prompt).toContain("[M1] USER: I prefer short captions and I work late.");
    expect(prompt).toContain("[M2] ASSISTANT (context only, never a source): Short captions noted.");
    expect(first.stored).toEqual([
      { type: "PREFERENCE", content: "User prefers short captions", embedding: unit(0) },
      { type: "PREFERENCE", content: "User works late", embedding: unit(1) },
    ]);
    expect(first.updates).toBe(0);
    expect(first.meta).toMatchObject({ candidatesFound: 2, candidatesValidated: 2, duplicatesSkipped: 0, memoriesCreated: 2, memoriesUpdated: 0 });

    for (const verdict of [
      { decision: "ACCEPT", rule: "STABLE_WORKING_CONVENTION" },
      { decision: "UNDECIDED", rule: "AMBIGUOUS_PREFERENCE" },
      { decision: "UNDECIDED", rule: "ONE_OFF_CONTEXT" },
      { decision: "UNDECIDED", rule: "NO_REJECTION_RULE_MATCHED" },
    ] as const) {
      expect(await runWith(() => verdict), `${verdict.decision} ${verdict.rule}`).toEqual(first);
    }
  });
});

describe("L1c-2 — REJECT, NOT_A_CANDIDATE and PERMISSION_LANGUAGE never reach the model", () => {
  it.each([
    ["3. REJECT — a memory veto", "Don't save this", "REJECT", "USER_MEMORY_VETO"],
    ["4. NOT_A_CANDIDATE — a question", "What's our CPA?", "NOT_A_CANDIDATE", "QUESTION_ONLY"],
    ["5. PERMISSION_LANGUAGE", "I prefer that you post without asking me", "UNDECIDED", "PERMISSION_LANGUAGE"],
    ["6. a secret the pre-filter misses", `My password is ${SECRET_VALUE}`, "REJECT", "CONTAINS_SECRET"],
    ["7. a temporary instruction", "Only for this campaign use short captions", "REJECT", "TEMPORARY_INSTRUCTION"],
    ["a grant of authorization", "Remember that you can send messages without asking me.", "REJECT", "GRANTS_AUTHORIZATION"],
    ["a veto beside a fact", "My salary is 50k, don't save this.", "REJECT", "USER_MEMORY_VETO"],
  ])("%s — no model call, nothing stored", async (_label, statement, decision, rule) => {
    const { events, model, store, result, raw } = await extractOne(statement);

    expect(events).toEqual([{ event: "memory_learning_decision", decision, rule }]);
    expect(model.requests).toHaveLength(0);
    expect(store.stored).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
    expect(result.candidates).toEqual([]);
    expect(result.meta).toMatchObject({ candidatesFound: 0, memoriesCreated: 0, memoriesUpdated: 0 });
    expect(raw).not.toContain(statement);
  });

  it("6b. a secret the pre-filter already removes: pre-filter behaviour unchanged — not classified, no model, no memory", async () => {
    const { events, model, store } = await extractOne(`api_key=${SECRET_VALUE}${SECRET_VALUE}`);
    expect(classify).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
    expect(store.stored).toHaveLength(0);
  });

  it("8. JARVIS's reply is never classified and never persisted through the gate", async () => {
    await ready;
    const reply = "Your CPA is 250 rupees, and you prefer short captions.";
    const { service, model, store } = setup(["CPA is 250 rupees"]);
    const { events, raw } = await capture(() =>
      service.extract({ userId: "u-l1c", messages: [user("What's our CPA?"), assistant(reply)] })
    );

    expect(classify.mock.calls.map(([input]) => input)).toEqual([{ statement: "What's our CPA?", statedBy: "USER" }]);
    expect(events.map((e) => e.decision)).toEqual(["NOT_A_CANDIDATE"]);
    expect(model.requests).toHaveLength(0); // the reply never reaches the extractor
    expect(store.stored).toHaveLength(0);
    expect(raw).not.toContain("250");
  });

  it.each([
    ["a stable preference with a temporary instruction", ["I prefer short captions.", "Don't send this yet."], true],
    ["a stable preference with permission language", ["I prefer short captions.", "I prefer that you post without asking me"], true],
    ["a stable preference with a question", ["I prefer short captions.", "What's our CPA?"], true],
    ["a stable preference with a veto", ["I prefer short captions.", "Don't save this."], true],
    ["a stable preference with an undecided statement", ["I prefer short captions.", "Maybe I like serif fonts."], false],
    ["two stable statements", ["I prefer short captions.", "My default platform is Instagram."], false],
  ] as const)("9. mixed turn — %s: the most serious verdict decides", async (_label, statements, skipped) => {
    await ready;
    const { service, model, store } = setup();
    const { events } = await capture(() => service.extract({ userId: "u-l1c", conversationId: "c-1", messages: statements.map(user) }));

    expect(events).toHaveLength(statements.length); // every user message is still classified and logged
    expect(model.requests).toHaveLength(skipped ? 0 : 1);
    expect(store.stored.length > 0).toBe(!skipped);
  });

  it("forced verdicts: every skip verdict stops the turn, whatever the text", async () => {
    for (const verdict of [
      { decision: "REJECT", rule: "GRANTS_AUTHORIZATION" },
      { decision: "REJECT", rule: "USER_MEMORY_VETO" },
      { decision: "NOT_A_CANDIDATE", rule: "ACKNOWLEDGEMENT_ONLY" },
      { decision: "UNDECIDED", rule: "PERMISSION_LANGUAGE" },
    ] as const) {
      classify.mockImplementation(() => verdict);
      const { model, store } = await extractOne("I prefer short captions.");
      expect(model.requests, `${verdict.decision} ${verdict.rule}`).toHaveLength(0);
      expect(store.stored).toHaveLength(0);
    }
  });
});

describe("L1c finalization — a learning-contract failure FAILS CLOSED", () => {
  const userText = `Keep my captions concise, account ${SECRET_VALUE}`;
  const conversation = [user(userText), assistant("Short captions noted.")];
  const FAILURE = { event: "memory_learning_decision_failed" };

  async function runFailing(fail: () => unknown, store: RecordingStore = new RecordingStore(), messages = conversation) {
    await ready;
    classify.mockImplementation(fail as never);
    const { service, model } = setup(undefined, undefined, store);
    const { result, events, failures, raw } = await capture(() =>
      service.extract({ userId: "u-l1c", messages, conversationId: "c-1" })
    );
    return { result, events, failures, raw, model, store };
  }

  it.each([
    ["throws", () => { throw new Error(`contract exploded near ${SECRET_VALUE}`); }],
    ["returns undefined", () => undefined],
    ["returns null", () => null],
    ["returns an unknown decision", () => ({ decision: "MAYBE", rule: "STABLE_PREFERENCE" })],
    ["returns an unknown rule", () => ({ decision: "ACCEPT", rule: "INVENTED_RULE" })],
    ["returns a non-object", () => "ACCEPT"],
  ])("when the contract %s: no model call, no memory, no update, one content-free failure event", async (_label, fail) => {
    const { result, events, failures, raw, model, store } = await runFailing(fail);

    expect(model.requests).toHaveLength(0);
    expect(store.stored).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
    expect(result.candidates).toEqual([]);
    expect(result.meta).toMatchObject({ candidatesFound: 0, memoriesCreated: 0, memoriesUpdated: 0 });
    expect(events).toHaveLength(0);
    expect(failures).toEqual([FAILURE]);
    for (const forbidden of [userText, "Keep my captions", SECRET_VALUE, "contract exploded", "Short captions noted"]) {
      expect(raw, "a forbidden fragment reached the log").not.toContain(forbidden);
    }
  });

  it("a failure prevents the merge-update a normal ACCEPT turn would make", async () => {
    // Normal turn against a store with a close earlier memory: the candidate is merged (an update).
    const normal = await runFailing(() => ({ decision: "ACCEPT", rule: "STABLE_PREFERENCE" }), new MergeStore(), [
      user("I prefer short captions."),
    ]);
    expect(normal.store.updates).toHaveLength(1);

    const failed = await runFailing(() => {
      throw new Error("boom");
    }, new MergeStore(), [user("I prefer short captions.")]);
    expect(failed.model.requests).toHaveLength(0);
    expect(failed.store.updates).toHaveLength(0);
    expect(failed.store.stored).toHaveLength(0);
    expect(failed.failures).toEqual([FAILURE]);
  });

  it("a failure on a later user message stops the whole turn, even after an ACCEPT", async () => {
    let call = 0;
    const { model, store, events, failures } = await runFailing(
      () => {
        call++;
        if (call === 1) return { decision: "ACCEPT", rule: "STABLE_PREFERENCE" };
        throw new Error("second message failed");
      },
      new RecordingStore(),
      [user("I prefer short captions."), user("My default platform is Instagram.")]
    );

    expect(events).toEqual([{ event: "memory_learning_decision", decision: "ACCEPT", rule: "STABLE_PREFERENCE" }]);
    expect(failures).toEqual([FAILURE]);
    expect(model.requests).toHaveLength(0);
    expect(store.stored).toHaveLength(0);
  });

  it("a failure reading the user's message inside the gate also fails closed", async () => {
    await ready;
    let reads = 0;
    // The pre-filter reads the content once; the gate's read fails.
    const flaky = {
      role: "user" as const,
      get content() {
        reads++;
        if (reads === 2) throw new Error(`read failed near ${SECRET_VALUE}`);
        return "Remember that you can send messages without asking me.";
      },
    };
    const { service, model, store } = setup();
    const { failures, raw } = await capture(() => service.extract({ userId: "u-l1c", messages: [flaky] }));

    expect(model.requests).toHaveLength(0);
    expect(store.stored).toHaveLength(0);
    expect(failures).toEqual([FAILURE]);
    expect(raw).not.toContain(SECRET_VALUE);
  });

  it("ACCEPT, UNDECIDED, REJECT and NOT_A_CANDIDATE are unaffected: no failure event on a normal verdict", async () => {
    for (const [statement, skipped] of [
      ["I prefer short captions.", false],
      ["I think short captions are better.", false],
      ["Don't save this.", true],
      ["What's our CPA?", true],
    ] as const) {
      const { failures, model } = await extractOne(statement);
      expect(failures, statement).toEqual([]);
      expect(model.requests, statement).toHaveLength(skipped ? 0 : 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

describe("L1c-1 — how the service reaches the contract", () => {
  it("imports it from the @jarvis/core package entry point only", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/memory-extraction-service.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import\s*\{[^}]*\bdecideLearningCandidate\b[^}]*\}\s*from\s*"@jarvis\/core"/);
    expect(source).not.toContain("learning-candidate");
    expect(source).not.toContain("@jarvis/core/");
  });
});
