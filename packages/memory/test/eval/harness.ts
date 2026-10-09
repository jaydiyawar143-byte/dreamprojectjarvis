// ---------------------------------------------------------------------------
// Phase 14 — the memory quality evaluation harness.
//
// Runs the dataset through the PRODUCTION classes — MemoryExtractionService
// and whichever IMemoryStore it is given (the real repository, in the
// PostgreSQL test) — and returns numbers:
//
//   extraction precision    of what was stored, how much should have been
//   extraction recall       of what should have been stored, how much was
//   forbidden-memory rate   of what must never be stored, how much was
//   retrieval relevance     of the recall cases, how many returned exactly
//                           what they should, in the right order
//   control compliance      pause, veto, unreadable controls: obeyed?
//   correction pass rate    is a wrong memory replaced, and only as allowed?
//   project isolation       does a project's memory stay in its project?
//   confidence compliance   is confidence the evidence's, never the model's?
//
// and a comparison of the shipped relevance weights with five alternatives.
//
// TWO THINGS ARE STAND-INS, both deterministic:
//
//   THE EXTRACTION MODEL is an EAGER one: it proposes every user message as a
//   memory, verbatim, citing itself — unless a case scripts something worse
//   (a claim from JARVIS's reply, a quote the user never wrote, a claim that
//   says more than the user did). So what is measured is what the gates in
//   front of the store let through from a model that proposes everything —
//   the property that has to hold whatever model is plugged in.
//
//   THE EMBEDDINGS are a bag-of-words hash: texts sharing no word score 0,
//   texts sharing words score by overlap. That makes every similarity in the
//   dataset knowable by reading it. It is NOT a language model, so nothing
//   here calibrates the production thresholds; the opt-in real-embedding
//   evaluation does that.
//
// No network, no clock dependence beyond "now", no randomness.
// ---------------------------------------------------------------------------

import type {
  AICompletionRequest,
  AICompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  IAIProvider,
  IEmbeddingProvider,
  IMemoryStore,
  MemoryRecallResult,
  MemoryRelevanceWeights,
} from "@jarvis/core";
import { MEMORY_RELEVANCE_WEIGHTS, parseMemoryLearningControl, rankMemories, scoreMemoryRelevance } from "@jarvis/core";
import { MemoryExtractionService } from "../../src/memory-extraction-service.js";
import {
  DATASET_VERSION,
  EXTRACTION_CASES,
  RETRIEVAL_CASES,
  WEIGHT_CANDIDATES,
  type ExtractionCase,
  type ProposedCandidate,
  type RetrievalCase,
} from "./dataset.js";

// ---------------------------------------------------------------------------
// Deterministic embeddings
// ---------------------------------------------------------------------------

export const EVAL_DIMENSIONS = 1536;
/** The similarity floor that suits the bag-of-words space: shared vocabulary in, none out. */
export const DETERMINISTIC_FLOOR = 0.15;

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "my", "your", "our", "is", "are", "was", "were", "to", "of", "in", "on", "for",
  "with", "that", "this", "it", "as", "at", "by", "from", "or", "be", "i", "me", "we", "you",
]);

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 1 + (Math.abs(h) % (EVAL_DIMENSIONS - 1));
}

export function embedText(text: string): number[] {
  const vec = new Array<number>(EVAL_DIMENSIONS).fill(0);
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  if (tokens.length === 0) {
    vec[0] = 1;
    return vec;
  }
  for (const token of new Set(tokens)) vec[hashToken(token)] = 1;
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / norm);
}

export const deterministicEmbeddings: IEmbeddingProvider = {
  id: "eval-bag-of-words",
  name: "Evaluation embeddings (bag of words)",
  dimensions: EVAL_DIMENSIONS,
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    return { embeddings: inputs.map(embedText), model: "eval-bag-of-words" };
  },
  async isAvailable() {
    return true;
  },
};

// ---------------------------------------------------------------------------
// The eager extraction model
// ---------------------------------------------------------------------------

/** A model that proposes `script`, or — without one — every USER message verbatim, citing itself. */
export function proposer(script?: ProposedCandidate[]): IAIProvider & { calls: number } {
  const provider = {
    id: "eval-eager-model",
    name: "Evaluation model (proposes everything)",
    defaultModel: "eval",
    calls: 0,
    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
      provider.calls++;
      const prompt = request.messages.map((m) => String(m.content ?? "")).join("\n");
      const candidates = (
        script ??
        [...prompt.matchAll(/^\[(M\d+)\] USER: (.+)$/gm)].map((m) => ({ content: m[2]!, source: m[1]!, evidence: m[2]! }))
      ).map((c) => ({ type: "PREFERENCE", importance: 0.8, confidence: 1, source: "M1", evidence: c.content, ...c }));
      return { message: { role: "assistant", content: JSON.stringify({ candidates }) }, finishReason: "stop", model: "eval" };
    },
    async listModels() {
      return ["eval"];
    },
    async isAvailable() {
      return true;
    },
  };
  return provider;
}

// ---------------------------------------------------------------------------
// The environment a run needs — supplied by the test that owns the database
// ---------------------------------------------------------------------------

export interface SavedMessage {
  conversationId: string;
  messageId: string;
  traceId: string;
}

export interface EvalEnvironment {
  store: IMemoryStore;
  embeddings: IEmbeddingProvider;
  /** The similarity floor recall applies; it belongs to the embedding space in use. */
  floor: number;
  newUser(tag: string): Promise<string>;
  newProject(userId: string, name: string): Promise<string>;
  /** Saves `text` as a USER message in a new conversation of that user, as the chat route does. */
  saveMessage(userId: string, text: string, projectId?: string): Promise<SavedMessage>;
  control: {
    /** The user's control document, as the production store returns it. Throws when told to. */
    get(userId: string): Promise<Record<string, unknown> | null>;
    put(userId: string, value: Record<string, unknown>): Promise<void>;
    /** Overwrites the stored document with text that is not JSON. */
    corrupt(userId: string): Promise<void>;
  };
}

const DAY = 86_400_000;

function service(env: EvalEnvironment, model: IAIProvider, control = env.control): MemoryExtractionService {
  return new MemoryExtractionService({
    aiProvider: model,
    store: env.store,
    embeddingProvider: env.embeddings,
    maxRetries: 0,
    learningControl: { get: async (userId) => parseMemoryLearningControl(await control.get(userId)) },
  });
}

async function say(env: EvalEnvironment, userId: string, text: string, options: { projectId?: string; assistant?: string; propose?: ProposedCandidate[]; replay?: SavedMessage } = {}) {
  const saved = options.replay ?? (await env.saveMessage(userId, text, options.projectId));
  await service(env, proposer(options.propose)).extract({
    userId,
    conversationId: saved.conversationId,
    messages: [
      { role: "user", content: text, messageId: saved.messageId, traceId: saved.traceId },
      { role: "assistant", content: options.assistant ?? "Noted." },
    ],
    expiryDays: 90,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  });
  return saved;
}

const all = async (env: EvalEnvironment, userId: string) => (await env.store.list({ userId, includeExpired: true, limit: 50 })).memories;

async function recallContents(env: EvalEnvironment, userId: string, query: string, projectId: string | null = null): Promise<string[]> {
  const [embedding] = (await env.embeddings.embed({ input: query })).embeddings;
  return (await env.store.recall({ userId, query, embedding: embedding!, limit: 5, minSimilarity: env.floor, projectId })).map((r) => r.memory.content);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface Check {
  id: string;
  what: string;
  passed: boolean;
  detail?: string;
}

export interface EvaluationReport {
  dataset: { version: string; extractionCases: number; retrievalCases: number };
  embeddings: string;
  metrics: {
    extractionPrecision: number;
    extractionRecall: number;
    forbiddenMemoryRate: number;
    retrievalRelevanceRate: number;
    controlComplianceRate: number;
    correctionPassRate: number;
    projectIsolationPassRate: number;
    confidenceComplianceRate: number;
  };
  extraction: Array<{ id: string; category: string; expected: "STORE" | "REJECT"; stored: boolean; correct: boolean; forbidden: boolean; knownGap?: string }>;
  retrieval: Array<{ id: string; category: string; passed: boolean; got: string[]; why: string }>;
  /** Top-1 accuracy over the retrieval cases that name a first result. */
  weights: Record<string, { weights: MemoryRelevanceWeights; top1: number; failed: string[] }>;
  controls: Check[];
  corrections: Check[];
  isolation: Check[];
  confidence: Check[];
}

const rate = (checks: Array<{ passed: boolean }>) => (checks.length === 0 ? 1 : checks.filter((c) => c.passed).length / checks.length);
const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

async function runExtraction(env: EvalEnvironment, cases: ExtractionCase[]) {
  const results: EvaluationReport["extraction"] = [];
  for (const c of cases) {
    const userId = await env.newUser(`ext-${c.id}`);
    await say(env, userId, c.user, { ...(c.assistant ? { assistant: c.assistant } : {}), ...(c.propose ? { propose: c.propose } : {}) });
    const stored = (await all(env, userId)).length > 0;
    results.push({
      id: c.id,
      category: c.category,
      expected: c.expect,
      stored,
      correct: stored === (c.expect === "STORE"),
      forbidden: c.forbidden === true,
      ...(c.knownGap ? { knownGap: c.knownGap } : {}),
    });
  }
  const storedRight = results.filter((r) => r.stored && r.expected === "STORE").length;
  const forbidden = results.filter((r) => r.forbidden);
  return {
    results,
    precision: ratio(storedRight, results.filter((r) => r.stored).length),
    recall: ratio(storedRight, results.filter((r) => r.expected === "STORE").length),
    forbiddenRate: forbidden.length === 0 ? 0 : forbidden.filter((r) => r.stored).length / forbidden.length,
  };
}

// ---------------------------------------------------------------------------
// Retrieval, and the weight comparison
// ---------------------------------------------------------------------------

async function runRetrieval(env: EvalEnvironment, cases: RetrievalCase[]) {
  const now = new Date();
  const results: EvaluationReport["retrieval"] = [];
  const tops: Record<string, { right: number; failed: string[] }> = { shipped: { right: 0, failed: [] } };
  for (const name of Object.keys(WEIGHT_CANDIDATES)) tops[name] = { right: 0, failed: [] };
  let ranked = 0;

  for (const c of cases) {
    const userId = await env.newUser(`ret-${c.id}`);
    const projects = new Map<string, string>();
    for (const name of new Set([...c.memories.map((m) => m.project), c.activeProject].filter((p): p is string => typeof p === "string"))) {
      projects.set(name, await env.newProject(userId, name));
    }

    const keyOf = new Map<string, string>();
    for (const m of c.memories) {
      const stated = new Date(now.getTime() - (m.statedDaysAgo ?? 0) * DAY);
      const conversations = m.conversations ?? 1;
      const [embedding] = (await env.embeddings.embed({ input: m.content })).embeddings;
      const [record] = await env.store.store({
        userId,
        memories: [
          {
            type: "PREFERENCE",
            content: m.content,
            importance: m.importance ?? 0.5,
            confidence: m.confidence ?? 0.7,
            sourceType: "USER",
            expiresAt: new Date(now.getTime() + 90 * DAY),
            ...(m.project ? { projectId: projects.get(m.project)! } : {}),
            metadata: { evidence: { v: 1, count: conversations, conversations, firstSeenAt: stated.toISOString(), lastSeenAt: stated.toISOString(), sources: [], revisions: 0, previousSourceMessageIds: [] } },
            embedding: embedding!,
          },
        ],
      });
      keyOf.set(record!.id, m.key);
    }

    const projectId = c.activeProject ? projects.get(c.activeProject)! : null;
    const [queryEmbedding] = (await env.embeddings.embed({ input: c.query })).embeddings;
    const recall = (limit: number): Promise<MemoryRecallResult[]> =>
      env.store.recall({ userId, query: c.query, embedding: queryEmbedding!, limit, minSimilarity: env.floor, projectId });

    const got = (await recall(5)).map((r) => keyOf.get(r.memory.id) ?? "?");
    const passed =
      (c.expectTop === undefined || got[0] === c.expectTop) &&
      (c.expectIncluded ?? []).every((key) => got.includes(key)) &&
      (c.expectExcluded ?? []).every((key) => !got.includes(key));
    results.push({ id: c.id, category: c.category, passed, got, why: c.why });

    if (c.expectTop !== undefined) {
      ranked++;
      if (got[0] === c.expectTop) tops.shipped!.right++;
      else tops.shipped!.failed.push(c.id);
      // The same candidates, re-ordered with each alternative set of weights.
      const pool = await recall(50);
      for (const [name, weights] of Object.entries(WEIGHT_CANDIDATES)) {
        const [first] = rankMemories(pool.map((r) => scoreMemoryRelevance(r.memory, r.semanticScore, now, weights)), 1);
        if (first && keyOf.get(first.memory.id) === c.expectTop) tops[name]!.right++;
        else tops[name]!.failed.push(c.id);
      }
    }
  }

  const weights: EvaluationReport["weights"] = {
    shipped: { weights: { ...MEMORY_RELEVANCE_WEIGHTS }, top1: ratio(tops.shipped!.right, ranked), failed: tops.shipped!.failed },
  };
  for (const [name, candidate] of Object.entries(WEIGHT_CANDIDATES)) {
    weights[name] = { weights: { ...candidate }, top1: ratio(tops[name]!.right, ranked), failed: tops[name]!.failed };
  }
  return { results, weights };
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

async function runControls(env: EvalEnvironment): Promise<Check[]> {
  const checks: Check[] = [];
  const statement = "I prefer short captions";
  const count = async (userId: string) => (await all(env, userId)).length;

  {
    const userId = await env.newUser("ctl-pause");
    await env.control.put(userId, { v: 1, learningPaused: true, vetoedSourceMessageIds: [] });
    await say(env, userId, statement);
    checks.push({ id: "PAUSED", what: "While learning is paused, nothing is stored", passed: (await count(userId)) === 0 });

    await env.control.put(userId, { v: 1, learningPaused: false, vetoedSourceMessageIds: [] });
    await say(env, userId, statement);
    checks.push({ id: "RESUMED", what: "After resuming, the same statement is stored", passed: (await count(userId)) === 1 });
  }
  {
    const userId = await env.newUser("ctl-veto");
    const saved = await env.saveMessage(userId, statement);
    await env.control.put(userId, { v: 1, learningPaused: false, vetoedSourceMessageIds: [saved.messageId] });
    await say(env, userId, statement, { replay: saved });
    checks.push({ id: "VETOED_SOURCE", what: "Nothing is learned from a message the user vetoed", passed: (await count(userId)) === 0 });

    await say(env, userId, "I always review ad copy before it goes live");
    checks.push({ id: "VETO_IS_PER_MESSAGE", what: "A veto on one message does not stop learning from another", passed: (await count(userId)) === 1 });
  }
  {
    const userId = await env.newUser("ctl-corrupt");
    await env.control.put(userId, { v: 1, learningPaused: false, vetoedSourceMessageIds: [] });
    await env.control.corrupt(userId);
    await say(env, userId, statement);
    checks.push({ id: "CORRUPT_CONTROLS", what: "A control document that is not valid JSON stops learning (fail closed)", passed: (await count(userId)) === 0 });
  }
  {
    const userId = await env.newUser("ctl-malformed");
    await env.control.put(userId, { v: 99, learningPaused: "no" });
    await say(env, userId, statement);
    checks.push({ id: "MALFORMED_CONTROLS", what: "A control document of the wrong shape stops learning (fail closed)", passed: (await count(userId)) === 0 });
  }
  {
    const userId = await env.newUser("ctl-unreadable");
    const saved = await env.saveMessage(userId, statement);
    const throwing = { ...env.control, get: async () => Promise.reject(new Error("store down")) };
    await service(env, proposer(), throwing).extract({
      userId,
      conversationId: saved.conversationId,
      messages: [{ role: "user", content: statement, messageId: saved.messageId, traceId: saved.traceId }],
    });
    checks.push({ id: "UNREADABLE_CONTROLS", what: "Controls that cannot be read stop learning (fail closed)", passed: (await count(userId)) === 0 });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Corrections (category I — a contradicting preference)
// ---------------------------------------------------------------------------

async function runCorrections(env: EvalEnvironment): Promise<Check[]> {
  const checks: Check[] = [];
  const version = (m: { updatedAt: Date }) => m.updatedAt.toISOString();

  async function learnt(tag: string, text = "I prefer dark mode") {
    const userId = await env.newUser(`cor-${tag}`);
    await say(env, userId, text);
    const [memory] = await all(env, userId);
    return { userId, memory: memory! };
  }
  async function correct(userId: string, memoryId: string, at: string, statement: string, message = statement, model: IAIProvider = proposer()) {
    const saved = await env.saveMessage(userId, message);
    const outcome = await service(env, model).correct({ userId, memoryId, version: at, statement, userMessage: message, conversationId: saved.conversationId, messageId: saved.messageId, traceId: saved.traceId });
    return { outcome, saved };
  }

  {
    const { userId, memory } = await learnt("ok");
    const model = proposer();
    const { outcome, saved } = await correct(userId, memory.id, version(memory), "I prefer light mode", "That's wrong. I prefer light mode.", model);
    const after = await all(env, userId);
    const evidence = after[0]?.metadata?.evidence as { revisions?: number; count?: number; previousSourceMessageIds?: string[] } | undefined;
    checks.push({ id: "CORRECTED", what: "A confirmed correction replaces the memory's content", passed: outcome.status === "CORRECTED" && after.length === 1 && after[0]!.content === "I prefer light mode", detail: outcome.status });
    checks.push({ id: "SAME_MEMORY", what: "It is the same memory — same id, type and scope — not a second one", passed: after[0]?.id === memory.id && after[0]?.type === memory.type && after[0]?.projectId === memory.projectId });
    checks.push({ id: "PROVENANCE_KEPT", what: "The corrected memory points at the user's own correction message", passed: after[0]?.sourceType === "USER" && after[0]?.sourceMessageId === saved.messageId && after[0]?.sourceConversationId === saved.conversationId });
    checks.push({ id: "EVIDENCE_KEPT", what: "Its evidence restarts with that message and records the revision", passed: evidence?.revisions === 1 && evidence?.count === 1 && (evidence?.previousSourceMessageIds ?? []).length === 1 });
    checks.push({ id: "CONFIDENCE_FROM_EVIDENCE", what: "Its confidence is the evidence's (a direct statement: 0.70)", passed: after[0]?.confidence === 0.7 });
    checks.push({ id: "NO_MODEL", what: "No model is asked anything during a correction", passed: model.calls === 0 });
    const recalled = await recallContents(env, userId, "Which mode do I prefer");
    checks.push({ id: "CORRECTED_RECALLED", what: "The corrected value is what is recalled; the old one is gone", passed: recalled[0] === "I prefer light mode" && !recalled.includes("I prefer dark mode") });

    const again = await service(env, proposer()).correct({ userId, memoryId: memory.id, version: version(after[0]!), statement: "I prefer light mode", userMessage: "That's wrong. I prefer light mode.", conversationId: saved.conversationId, messageId: saved.messageId, traceId: saved.traceId });
    checks.push({ id: "REPLAY", what: "The same correction message applied twice changes nothing the second time", passed: again.status === "ALREADY_APPLIED", detail: again.status });
  }
  for (const [id, statement, what] of [
    ["NOT_LEARNABLE_TASK", "Remind me to call the printer tomorrow", "A task cannot be written into a memory as a correction"],
    ["NOT_LEARNABLE_SECRET", "My password is hunter2-example", "A secret cannot be written into a memory as a correction"],
    ["NOT_LEARNABLE_GRANT", "You can post without asking me", "A grant of authority cannot be written into a memory as a correction"],
    ["NOT_LEARNABLE_GOAL", "My goal is to reach 10,000 followers this year", "A goal cannot be written into a memory as a correction"],
  ] as const) {
    const { userId, memory } = await learnt(id.toLowerCase());
    const { outcome } = await correct(userId, memory.id, version(memory), statement);
    const [after] = await all(env, userId);
    checks.push({ id, what, passed: outcome.status === "NOT_LEARNABLE" && after!.content === "I prefer dark mode", detail: outcome.status });
  }
  {
    const { userId, memory } = await learnt("quote");
    const { outcome } = await correct(userId, memory.id, version(memory), "I prefer light mode", "Something else entirely");
    const [after] = await all(env, userId);
    checks.push({ id: "NOT_IN_MESSAGE", what: "The new value must really be in the user's saved message", passed: outcome.status === "NOT_LEARNABLE" && after!.content === "I prefer dark mode", detail: outcome.status });
  }
  {
    const { userId, memory } = await learnt("stale");
    const { outcome } = await correct(userId, memory.id, new Date(memory.updatedAt.getTime() - 1000).toISOString(), "I prefer light mode");
    const [after] = await all(env, userId);
    checks.push({ id: "STALE", what: "A memory that changed since the user saw it is not overwritten", passed: outcome.status === "STALE" && after!.content === "I prefer dark mode", detail: outcome.status });
  }
  {
    const owner = await learnt("foreign-owner");
    const intruder = await env.newUser("cor-foreign-intruder");
    const { outcome } = await correct(intruder, owner.memory.id, version(owner.memory), "I prefer light mode");
    const [after] = await all(env, owner.userId);
    checks.push({ id: "FOREIGN", what: "Another user's memory cannot be corrected: it does not exist for them", passed: outcome.status === "NOT_FOUND" && after!.content === "I prefer dark mode", detail: outcome.status });
  }
  {
    const { userId, memory } = await learnt("paused");
    await env.control.put(userId, { v: 1, learningPaused: true, vetoedSourceMessageIds: [] });
    const { outcome } = await correct(userId, memory.id, version(memory), "I prefer light mode");
    const [after] = await all(env, userId);
    checks.push({ id: "PAUSED", what: "While learning is paused, a correction writes nothing", passed: outcome.status === "BLOCKED" && after!.content === "I prefer dark mode", detail: outcome.status });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Project isolation (categories L and M)
// ---------------------------------------------------------------------------

async function runIsolation(env: EvalEnvironment): Promise<Check[]> {
  const checks: Check[] = [];
  const userId = await env.newUser("iso-owner");
  const alpha = await env.newProject(userId, "Alpha");
  const beta = await env.newProject(userId, "Beta");
  const other = await env.newUser("iso-other");
  const query = "Which captions do I prefer";

  await say(env, userId, "I prefer playful captions", { projectId: alpha });
  const [projectMemory] = await all(env, userId);
  checks.push({ id: "LEARNED_IN_PROJECT", what: "What is said in a project conversation is stored in that project", passed: projectMemory?.projectId === alpha });
  checks.push({ id: "RECALLED_IN_PROJECT", what: "It is recalled in that project", passed: (await recallContents(env, userId, query, alpha)).includes("I prefer playful captions") });
  checks.push({ id: "NOT_WITHOUT_PROJECT", what: "It is not recalled when no project is active", passed: (await recallContents(env, userId, query, null)).length === 0 });
  checks.push({ id: "NOT_IN_OTHER_PROJECT", what: "It is not recalled in another project of the same user", passed: (await recallContents(env, userId, query, beta)).length === 0 });
  checks.push({ id: "NOT_FOR_OTHER_USER", what: "Another user cannot recall it, even naming the project", passed: (await recallContents(env, other, query, alpha)).length === 0 && (await recallContents(env, other, query, null)).length === 0 });

  await say(env, userId, "I prefer short emails");
  const emails = "Which emails do I prefer";
  const personal = (await all(env, userId)).find((m) => m.content === "I prefer short emails");
  checks.push({ id: "PERSONAL_HAS_NO_PROJECT", what: "What is said in a personal conversation is a personal memory", passed: personal !== undefined && personal.projectId === undefined });
  checks.push({
    id: "PERSONAL_EVERYWHERE",
    what: "A personal memory is recalled with no project, and in each of the user's projects",
    passed:
      (await recallContents(env, userId, emails, null)).includes("I prefer short emails") &&
      (await recallContents(env, userId, emails, alpha)).includes("I prefer short emails") &&
      (await recallContents(env, userId, emails, beta)).includes("I prefer short emails"),
  });

  // The same words, said personally: a second memory, in its own scope.
  await say(env, userId, "I prefer playful captions");
  const twins = (await all(env, userId)).filter((m) => m.content === "I prefer playful captions");
  const counts = twins.map((m) => (m.metadata?.evidence as { count?: number } | undefined)?.count);
  checks.push({
    id: "NO_CROSS_SCOPE_DEDUP",
    what: "The same statement in a project and personally is two memories; neither corroborates the other",
    passed: twins.length === 2 && new Set(twins.map((m) => m.projectId ?? null)).size === 2 && counts.every((c) => c === 1),
  });

  // A near-restatement inside the project revises the project's memory only.
  await say(env, userId, "I prefer playful captions with emojis", { projectId: alpha });
  const after = await all(env, userId);
  checks.push({
    id: "REVISION_STAYS_IN_SCOPE",
    what: "A revision made in a project changes that project's memory and leaves the personal one alone",
    passed:
      after.some((m) => m.projectId === alpha && m.content === "I prefer playful captions with emojis") &&
      after.some((m) => m.projectId === undefined && m.content === "I prefer playful captions") &&
      !after.some((m) => m.projectId === undefined && m.content.includes("emojis")),
  });
  checks.push({
    id: "REVISION_NOT_LEAKED",
    what: "The project's revised wording is not recalled outside the project",
    passed: !(await recallContents(env, userId, query, null)).some((c) => c.includes("emojis")) && !(await recallContents(env, userId, query, beta)).some((c) => c.includes("emojis")),
  });
  return checks;
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

async function runConfidence(env: EvalEnvironment): Promise<Check[]> {
  const checks: Check[] = [];
  const userId = await env.newUser("conf");
  await say(env, userId, "I prefer short captions");
  const [first] = await all(env, userId);
  checks.push({ id: "NOT_THE_MODELS", what: "The model said 1.0; the stored confidence is the evidence's 0.70", passed: first?.confidence === 0.7 && first?.metadata?.modelConfidence === 1 });

  await say(env, userId, "I prefer short captions");
  const [second] = await all(env, userId);
  checks.push({ id: "RISES_WITH_EVIDENCE", what: "Stated again in a second conversation, it rises to 0.80", passed: second?.confidence === 0.8 && (await all(env, userId)).length === 1 });
  return checks;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runMemoryEvaluation(env: EvalEnvironment): Promise<EvaluationReport> {
  const extraction = await runExtraction(env, EXTRACTION_CASES);
  const retrieval = await runRetrieval(env, RETRIEVAL_CASES);
  const controls = await runControls(env);
  const corrections = await runCorrections(env);
  const isolation = await runIsolation(env);
  const confidence = await runConfidence(env);

  return {
    dataset: { version: DATASET_VERSION, extractionCases: EXTRACTION_CASES.length, retrievalCases: RETRIEVAL_CASES.length },
    embeddings: env.embeddings.id,
    metrics: {
      extractionPrecision: extraction.precision,
      extractionRecall: extraction.recall,
      forbiddenMemoryRate: extraction.forbiddenRate,
      retrievalRelevanceRate: rate(retrieval.results),
      controlComplianceRate: rate(controls),
      correctionPassRate: rate(corrections),
      projectIsolationPassRate: rate(isolation),
      confidenceComplianceRate: rate(confidence),
    },
    extraction: extraction.results,
    retrieval: retrieval.results,
    weights: retrieval.weights,
    controls,
    corrections,
    isolation,
    confidence,
  };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** The report as text: the metrics, the weight comparison, and everything that did not pass. */
export function formatReport(report: EvaluationReport): string {
  const m = report.metrics;
  const failed = (checks: Check[]) => checks.filter((c) => !c.passed).map((c) => `    FAILED ${c.id}: ${c.what}${c.detail ? ` (${c.detail})` : ""}`);
  return [
    `MEMORY QUALITY EVALUATION — dataset ${report.dataset.version}, embeddings: ${report.embeddings}`,
    `  extraction cases: ${report.dataset.extractionCases}   retrieval cases: ${report.dataset.retrievalCases}`,
    "",
    `  extraction precision       ${pct(m.extractionPrecision)}`,
    `  extraction recall          ${pct(m.extractionRecall)}`,
    `  forbidden-memory rate      ${pct(m.forbiddenMemoryRate)}`,
    `  retrieval relevance rate   ${pct(m.retrievalRelevanceRate)}`,
    `  control compliance rate    ${pct(m.controlComplianceRate)}   (${report.controls.length} checks)`,
    `  correction pass rate       ${pct(m.correctionPassRate)}   (${report.corrections.length} checks)`,
    `  project isolation pass     ${pct(m.projectIsolationPassRate)}   (${report.isolation.length} checks)`,
    `  confidence compliance      ${pct(m.confidenceComplianceRate)}   (${report.confidence.length} checks)`,
    "",
    "  relevance weights — top-1 accuracy on the ranked retrieval cases:",
    ...Object.entries(report.weights).map(
      ([name, w]) => `    ${name.padEnd(18)} ${pct(w.top1).padStart(6)}  (${w.weights.semantic}/${w.weights.recency}/${w.weights.confidence}/${w.weights.importance})${w.failed.length ? `  fails ${w.failed.join(", ")}` : ""}`
    ),
    "",
    "  not as labelled:",
    ...report.extraction.filter((r) => !r.correct).map((r) => `    ${r.id} expected ${r.expected}, ${r.stored ? "stored" : "not stored"}${r.knownGap ? ` — known gap: ${r.knownGap}` : ""}`),
    ...report.retrieval.filter((r) => !r.passed).map((r) => `    ${r.id} got [${r.got.join(", ")}] — ${r.why}`),
    ...failed(report.controls),
    ...failed(report.corrections),
    ...failed(report.isolation),
    ...failed(report.confidence),
  ].join("\n");
}
