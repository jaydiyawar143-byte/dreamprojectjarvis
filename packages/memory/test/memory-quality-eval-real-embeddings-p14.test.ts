// Phase 14 — the OPT-IN real-embedding evaluation.
//
// The deterministic evaluation proves the logic; it cannot say whether the
// production THRESHOLDS suit a real embedding model, because its embeddings
// are a bag-of-words hash. This one asks the real model:
//
//   DUPLICATE THRESHOLDS  how similar are a restatement, a contradiction and
//                         an unrelated statement — and which dedup band
//                         (corroborate ≥ 0.95, revise ≥ 0.70, new) does each
//                         land in?
//   RELEVANCE FLOOR       is the memory that answers a question above the
//                         floor (0.30), and are the others below it?
//   TOP-K QUALITY         ranked by similarity, is the right memory first, and
//                         within the five the orchestrator recalls?
//
// IT IS OFF BY DEFAULT and never runs in CI. It runs only when BOTH are set:
//
//   JARVIS_MEMORY_EVAL_REAL_EMBEDDINGS=1
//   OPENAI_API_KEY=<a key>            (read from the environment; never logged,
//                                      never written anywhere by this test)
//
//   pnpm --filter @jarvis/memory exec vitest run memory-quality-eval-real-embeddings
//
// It sends the dataset's invented sentences — no real user data — in ONE
// embeddings request (about 45 short texts; a fraction of a cent), needs no
// database, and writes the report to MEMORY_EVAL_REPORT when that is set.
//
// WHAT IT ASSERTS is deliberately little, and only what must hold for memory
// to be safe: unrelated statements are never merged, an identical restatement
// is recognised, and the floor keeps most relevant memories while rejecting
// most irrelevant ones. Everything else is MEASURED and reported, so a
// threshold is changed with numbers in hand, not by this test failing.
import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync } from "node:fs";
import { MEMORY_DEDUP_THRESHOLDS, MEMORY_SIMILARITY_FLOOR } from "@jarvis/core";
import { QUERY_PAIRS, STATEMENT_PAIRS } from "./eval/dataset.js";

const ENABLED = process.env.JARVIS_MEMORY_EVAL_REAL_EMBEDDINGS === "1" && !!process.env.OPENAI_API_KEY?.trim();
const TOP_K = 5;

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(na * nb);
};

const band = (score: number) => (score >= MEMORY_DEDUP_THRESHOLDS.corroborate ? "CORROBORATE" : score >= MEMORY_DEDUP_THRESHOLDS.revise ? "REVISE" : "NEW");
const round = (n: number) => Math.round(n * 1000) / 1000;

interface RealEmbeddingReport {
  model: string;
  texts: number;
  thresholds: { similarityFloor: number; corroborate: number; revise: number };
  pairs: Array<{ id: string; kind: string; similarity: number; band: string }>;
  bandsByKind: Record<string, Record<string, number>>;
  queries: Array<{ id: string; relevant: number; bestIrrelevant: number; rank: number }>;
  floor: Array<{ floor: number; relevantKept: number; irrelevantKept: number }>;
  topK: { top1: number; topK: number; k: number };
}

let report: RealEmbeddingReport;

beforeAll(async () => {
  if (!ENABLED) return;
  const { OpenAIEmbeddingProvider } = await import("@jarvis/ai-openai");
  const provider = new OpenAIEmbeddingProvider();

  const texts = [...new Set([...STATEMENT_PAIRS.flatMap((p) => [p.a, p.b]), ...QUERY_PAIRS.flatMap((q) => [q.query, q.relevant])])];
  const response = await provider.embed({ input: texts, model: "text-embedding-3-small" });
  const vector = new Map(texts.map((text, i) => [text, response.embeddings[i]!]));
  const similarity = (a: string, b: string) => cosine(vector.get(a)!, vector.get(b)!);

  const pairs = STATEMENT_PAIRS.map((p) => {
    const score = similarity(p.a, p.b);
    return { id: p.id, kind: p.kind, similarity: round(score), band: band(score) };
  });
  const bandsByKind: RealEmbeddingReport["bandsByKind"] = {};
  for (const p of pairs) {
    bandsByKind[p.kind] ??= { CORROBORATE: 0, REVISE: 0, NEW: 0 };
    bandsByKind[p.kind]![p.band]!++;
  }

  const memories = QUERY_PAIRS.map((q) => q.relevant);
  const queries = QUERY_PAIRS.map((q) => {
    const scored = memories.map((memory) => ({ memory, score: similarity(q.query, memory) })).sort((a, b) => b.score - a.score);
    return {
      id: q.id,
      relevant: round(similarity(q.query, q.relevant)),
      bestIrrelevant: round(Math.max(...scored.filter((s) => s.memory !== q.relevant).map((s) => s.score))),
      rank: scored.findIndex((s) => s.memory === q.relevant) + 1,
    };
  });

  const irrelevantScores = QUERY_PAIRS.flatMap((q) => memories.filter((m) => m !== q.relevant).map((m) => similarity(q.query, m)));
  const floor = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45].map((value) => ({
    floor: value,
    relevantKept: round(queries.filter((q) => q.relevant >= value).length / queries.length),
    irrelevantKept: round(irrelevantScores.filter((s) => s >= value).length / irrelevantScores.length),
  }));

  report = {
    model: response.model ?? "text-embedding-3-small",
    texts: texts.length,
    thresholds: { similarityFloor: MEMORY_SIMILARITY_FLOOR, corroborate: MEMORY_DEDUP_THRESHOLDS.corroborate, revise: MEMORY_DEDUP_THRESHOLDS.revise },
    pairs,
    bandsByKind,
    queries,
    floor,
    topK: {
      top1: round(queries.filter((q) => q.rank === 1).length / queries.length),
      topK: round(queries.filter((q) => q.rank <= TOP_K).length / queries.length),
      k: TOP_K,
    },
  };

  // Straight to stdout: a passing run's console output is otherwise not shown.
  process.stdout.write(
    [
      "",
      `REAL-EMBEDDING EVALUATION — ${report.model}, ${report.texts} texts, one request`,
      `  thresholds: floor ${report.thresholds.similarityFloor}, corroborate ${report.thresholds.corroborate}, revise ${report.thresholds.revise}`,
      "  statement pairs (similarity → dedup band):",
      ...report.pairs.map((p) => `    ${p.id.padEnd(3)} ${p.kind.padEnd(13)} ${p.similarity.toFixed(3)}  ${p.band}`),
      "  questions (answering memory / best other memory / rank of the answer):",
      ...report.queries.map((q) => `    ${q.id.padEnd(3)} ${q.relevant.toFixed(3)} / ${q.bestIrrelevant.toFixed(3)} / #${q.rank}`),
      "  floor → relevant kept / irrelevant kept:",
      ...report.floor.map((f) => `    ${f.floor.toFixed(2)} → ${(f.relevantKept * 100).toFixed(0)}% / ${(f.irrelevantKept * 100).toFixed(0)}%`),
      `  top-1 ${(report.topK.top1 * 100).toFixed(0)}%, top-${report.topK.k} ${(report.topK.topK * 100).toFixed(0)}%`,
      "",
    ].join("\n")
  );
  if (process.env.MEMORY_EVAL_REPORT) writeFileSync(process.env.MEMORY_EVAL_REPORT, JSON.stringify(report, null, 2));
}, 60_000);

describe.skipIf(!ENABLED)("Phase 14 — real-embedding evaluation (opt-in; calls the embedding provider)", () => {
  it("unrelated statements are never merged: every one is below the revise threshold", () => {
    const merged = report.pairs.filter((p) => p.kind === "UNRELATED" && p.band !== "NEW");
    expect(merged.map((p) => `${p.id} ${p.similarity}`)).toEqual([]);
  });

  it("an identical restatement is recognised as the same statement", () => {
    expect(report.pairs.find((p) => p.id === "S1")!.band).toBe("CORROBORATE");
  });

  it("no restatement is treated as a new, second memory", () => {
    const duplicated = report.pairs.filter((p) => p.kind === "RESTATEMENT" && p.band === "NEW");
    expect(duplicated.map((p) => `${p.id} ${p.similarity}`)).toEqual([]);
  });

  it("the floor keeps most answering memories and rejects most others", () => {
    const shipped = report.floor.find((f) => f.floor === MEMORY_SIMILARITY_FLOOR)!;
    expect(shipped.relevantKept).toBeGreaterThanOrEqual(0.75);
    expect(shipped.irrelevantKept).toBeLessThanOrEqual(0.25);
  });

  it("the answering memory is within the top five for every question, and first for most", () => {
    expect(report.topK.topK).toBe(1);
    expect(report.topK.top1).toBeGreaterThanOrEqual(0.75);
  });
});

describe("Phase 14 — real-embedding evaluation is opt-in", () => {
  it("does not run, and calls no provider, unless explicitly enabled", () => {
    // In CI neither variable is set, so nothing above this ran and no request was made.
    if (process.env.JARVIS_MEMORY_EVAL_REAL_EMBEDDINGS !== "1") expect(ENABLED).toBe(false);
    expect(typeof ENABLED).toBe("boolean");
  });
});
