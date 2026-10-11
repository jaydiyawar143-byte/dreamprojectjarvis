// Phase 14 — the relevance score, confidence levels, the owner's view of a
// memory and the retention policy. Pure contracts: no I/O, no clock.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { MemoryRecord } from "../src/types/memory.js";
import {
  LEGACY_MEMORY_CONFIDENCE,
  MEMORY_RECENCY_HALF_LIFE_DAYS,
  MEMORY_RELEVANCE_WEIGHTS,
  effectiveMemoryConfidence,
  memoryConfidenceLevel,
  memoryLastStatedAt,
  memoryRecency,
  rankMemories,
  scoreMemoryRelevance,
} from "../src/memory-relevance.js";
import { toMemoryDetail } from "../src/memory-detail.js";
import { MEMORY_PURGE_TOOL_ID, MEMORY_RETENTION, isPurgeable, memoryPurgeCutoff } from "../src/memory-retention.js";
import { MEMORY_CORRECT_TOOL_ID } from "../src/memory-correction.js";
import { DESTRUCTIVE_MEMORY_TOOL_IDS, MEMORY_TOOL_IDS } from "../src/memory-management.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function evidence(lastSeenAt: Date, conversations = 1, count = conversations, revisions = 0) {
  return { v: 1, count, conversations, firstSeenAt: lastSeenAt.toISOString(), lastSeenAt: lastSeenAt.toISOString(), sources: [], revisions, previousSourceMessageIds: [] };
}

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    userId: "u1",
    type: "PREFERENCE",
    content: "I prefer short captions",
    importance: 0.5,
    confidence: 0.7,
    accessCount: 0,
    sourceType: "USER",
    metadata: { evidence: evidence(NOW) },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("the relevance score", () => {
  it("is 0.70 semantic + 0.10 recency + 0.10 confidence + 0.10 importance", () => {
    expect(MEMORY_RELEVANCE_WEIGHTS).toEqual({ semantic: 0.7, recency: 0.1, confidence: 0.1, importance: 0.1 });
    expect(Object.isFrozen(MEMORY_RELEVANCE_WEIGHTS)).toBe(true);

    const scored = scoreMemoryRelevance(memory({ confidence: 0.8, importance: 0.6, metadata: { evidence: evidence(daysAgo(30)) } }), 0.5, NOW);

    expect(scored.semanticScore).toBe(0.5);
    expect(scored.recencyScore).toBe(0.5); // one half-life
    expect(scored.confidenceScore).toBe(0.8);
    expect(scored.importanceScore).toBe(0.6);
    expect(scored.finalScore).toBeCloseTo(0.7 * 0.5 + 0.1 * 0.5 + 0.1 * 0.8 + 0.1 * 0.6, 12);
  });

  it("is bounded: every part and the total stay in [0, 1], whatever is stored", () => {
    for (const semantic of [-5, 0, 0.3, 1, 7, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const stored of [-1, 0, 0.5, 1, 99, Number.NaN]) {
        const scored = scoreMemoryRelevance(memory({ confidence: stored, importance: stored }), semantic, NOW);
        for (const part of [scored.semanticScore, scored.recencyScore, scored.confidenceScore!, scored.importanceScore!, scored.finalScore]) {
          expect(part).toBeGreaterThanOrEqual(0);
          expect(part).toBeLessThanOrEqual(1);
        }
      }
    }
    // The best possible memory scores no more than 1, the worst no less than 0.
    expect(scoreMemoryRelevance(memory({ confidence: 0.95, importance: 1, metadata: { evidence: evidence(NOW, 4) } }), 1, NOW).finalScore).toBeLessThanOrEqual(1);
    expect(scoreMemoryRelevance(memory({ confidence: 0, importance: 0, sourceType: "x", metadata: {} , createdAt: daysAgo(4000) }), 0, NOW).finalScore).toBeCloseTo(0, 6);
  });

  it("is monotone: more of any part never lowers the score", () => {
    const base = scoreMemoryRelevance(memory({ confidence: 0.55, importance: 0.4, metadata: { evidence: evidence(daysAgo(60)) } }), 0.4, NOW).finalScore;
    expect(scoreMemoryRelevance(memory({ confidence: 0.55, importance: 0.4, metadata: { evidence: evidence(daysAgo(60)) } }), 0.6, NOW).finalScore).toBeGreaterThan(base);
    expect(scoreMemoryRelevance(memory({ confidence: 0.85, importance: 0.4, metadata: { evidence: evidence(daysAgo(60)) } }), 0.4, NOW).finalScore).toBeGreaterThan(base);
    expect(scoreMemoryRelevance(memory({ confidence: 0.55, importance: 0.9, metadata: { evidence: evidence(daysAgo(60)) } }), 0.4, NOW).finalScore).toBeGreaterThan(base);
    expect(scoreMemoryRelevance(memory({ confidence: 0.55, importance: 0.4, metadata: { evidence: evidence(daysAgo(2)) } }), 0.4, NOW).finalScore).toBeGreaterThan(base);
  });

  it("relevance decides: the three secondary parts together cannot outweigh a clearly more similar memory", () => {
    // The best a secondary signal can do, against the worst: 0.30 in total.
    const strong = memory({ id: "strong", confidence: 0.95, importance: 1, metadata: { evidence: evidence(NOW, 4) } });
    const weak = memory({ id: "weak", confidence: 0, importance: 0, sourceType: "legacy", metadata: {}, createdAt: daysAgo(3650) });

    // 0.44 more similar (> 0.30 / 0.70): the weak-but-relevant memory wins.
    const ranked = rankMemories([scoreMemoryRelevance(strong, 0.3, NOW), scoreMemoryRelevance(weak, 0.74, NOW)], 2);
    expect(ranked.map((r) => r.memory.id)).toEqual(["weak", "strong"]);
  });

  it("breaks a near-tie in similarity by what the user said most recently and most often", () => {
    // The case cosine cannot order — and the one that matters after a
    // preference changed: two memories about equally similar to the question.
    const stale = memory({ id: "a-stale", confidence: 0.55, metadata: { evidence: evidence(daysAgo(80)) } });
    const fresh = memory({ id: "b-fresh", confidence: 0.9, metadata: { evidence: evidence(daysAgo(1), 3) } });

    const ranked = rankMemories([scoreMemoryRelevance(stale, 0.62, NOW), scoreMemoryRelevance(fresh, 0.6, NOW)], 2);
    expect(ranked.map((r) => r.memory.id)).toEqual(["b-fresh", "a-stale"]);
  });

  it("orders deterministically: highest score first, then by id; and never returns more than the limit", () => {
    const twin = (id: string) => scoreMemoryRelevance(memory({ id }), 0.5, NOW);
    expect(rankMemories([twin("c"), twin("a"), twin("b")], 5).map((r) => r.memory.id)).toEqual(["a", "b", "c"]);
    expect(rankMemories([twin("c"), twin("a"), twin("b")], 2)).toHaveLength(2);
    expect(rankMemories([twin("a")], 0)).toEqual([]);
    expect(rankMemories([twin("a")], -3)).toEqual([]);
  });
});

describe("recency", () => {
  it("halves every 30 days since the user last stated the memory", () => {
    expect(MEMORY_RECENCY_HALF_LIFE_DAYS).toBe(30);
    expect(memoryRecency(NOW, NOW)).toBe(1);
    expect(memoryRecency(daysAgo(30), NOW)).toBe(0.5);
    expect(memoryRecency(daysAgo(60), NOW)).toBe(0.25);
    expect(memoryRecency(daysAgo(90), NOW)).toBe(0.125);
  });

  it("counts whole days, so milliseconds never decide an order", () => {
    expect(memoryRecency(new Date(NOW.getTime() - 5), NOW)).toBe(1);
    expect(memoryRecency(new Date(NOW.getTime() - 86_399_999), NOW)).toBe(1);
    expect(memoryRecency(new Date(NOW.getTime() - 86_400_000), NOW)).toBeLessThan(1);
  });

  it("a date in the future is simply 'now'", () => {
    expect(memoryRecency(new Date(NOW.getTime() + 86_400_000 * 10), NOW)).toBe(1);
  });

  it("is measured from the last counted statement — or, without evidence, from creation", () => {
    const stated = daysAgo(3);
    expect(memoryLastStatedAt(memory({ createdAt: daysAgo(200), metadata: { evidence: evidence(stated) } }))).toEqual(stated);
    expect(memoryLastStatedAt(memory({ createdAt: daysAgo(200), metadata: {} }))).toEqual(daysAgo(200));
    expect(memoryLastStatedAt(memory({ createdAt: daysAgo(200), metadata: { evidence: { v: 2 } } }))).toEqual(daysAgo(200));
  });
});

describe("confidence", () => {
  it("uses the stored, evidence-derived number for a memory with USER evidence", () => {
    expect(effectiveMemoryConfidence(memory({ confidence: 0.7 }))).toBe(0.7);
    expect(effectiveMemoryConfidence(memory({ confidence: 0.95 }))).toBe(0.95);
    // Never above the evidence model's own ceiling.
    expect(effectiveMemoryConfidence(memory({ confidence: 1 }))).toBe(0.95);
  });

  it("never trusts a number the extraction model chose: a memory without evidence is capped", () => {
    expect(LEGACY_MEMORY_CONFIDENCE).toBe(0.5);
    // Before L4 the model wrote "1.0" freely. That is not evidence.
    expect(effectiveMemoryConfidence(memory({ confidence: 1, metadata: {} }))).toBe(0.5);
    expect(effectiveMemoryConfidence(memory({ confidence: 1, metadata: undefined }))).toBe(0.5);
    expect(effectiveMemoryConfidence(memory({ confidence: 1, sourceType: "conversation" }))).toBe(0.5);
    expect(effectiveMemoryConfidence(memory({ confidence: 0.2, metadata: {} }))).toBe(0.2);
  });

  it.each([
    [0.95, "HIGH"],
    [0.8, "HIGH"],
    [0.79, "MEDIUM"],
    [0.7, "MEDIUM"],
    [0.65, "MEDIUM"],
    [0.6, "MEDIUM"],
    [0.59, "LOW"],
    [0.55, "LOW"],
    [0.5, "LOW"],
    [0, "LOW"],
  ] as const)("%f is %s", (confidence, level) => {
    expect(memoryConfidenceLevel(confidence)).toBe(level);
  });

  it("the levels follow the evidence model: said once, confirmed, endorsed", () => {
    expect(memoryConfidenceLevel(0.7)).toBe("MEDIUM"); // a direct statement, once
    expect(memoryConfidenceLevel(0.8)).toBe("HIGH"); // a direct statement, in two conversations
    expect(memoryConfidenceLevel(0.55)).toBe("LOW"); // an endorsement, once
    expect(memoryConfidenceLevel(Number.NaN)).toBe("LOW");
  });
});

describe("the owner's view of a memory", () => {
  it("adds confidence, project and a provenance summary to the chat's safe view", () => {
    const record = memory({
      id: "mem-1",
      confidence: 0.8,
      projectId: "proj-1",
      sourceConversationId: "conv-secret",
      sourceMessageId: "msg-secret",
      expiresAt: daysAgo(-30),
      metadata: { embedding: [0.1, 0.2], sourceTraceId: "trace-secret", modelConfidence: 1, evidence: evidence(daysAgo(2), 2, 3, 1) },
    });

    const detail = toMemoryDetail(record, NOW, new Map([["proj-1", "DCC"]]));

    expect(detail).toMatchObject({
      id: "mem-1",
      type: "PREFERENCE",
      content: "I prefer short captions",
      confidence: 0.8,
      confidenceLevel: "HIGH",
      projectId: "proj-1",
      projectName: "DCC",
      expired: false,
      legacy: false,
      provenance: { source: "USER", statements: 3, conversations: 2, revisions: 1, lastStatedAt: daysAgo(2).toISOString() },
    });
    expect(detail.updatedAt).toBe(detail.changedAt);
  });

  it("never carries the vector, the raw metadata, or a message, conversation or trace id", () => {
    const detail = toMemoryDetail(
      memory({
        sourceConversationId: "conv-secret",
        sourceMessageId: "msg-secret",
        metadata: { embedding: [0.123456], sourceTraceId: "trace-secret", modelConfidence: 0.99, evidence: { ...evidence(NOW), sources: [{ messageId: "msg-secret", conversationId: "conv-secret", kind: "DIRECT", at: NOW.toISOString() }] } },
      }),
      NOW
    );
    const text = JSON.stringify(detail);
    for (const forbidden of ["embedding", "0.123456", "metadata", "conv-secret", "msg-secret", "trace-secret", "modelConfidence", "sources", "userId"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("a personal memory has no project, and a memory without evidence is LEGACY and LOW", () => {
    const detail = toMemoryDetail(memory({ confidence: 1, sourceType: "conversation", metadata: {} }), NOW);
    expect(detail.projectId).toBeNull();
    expect(detail.projectName).toBeUndefined();
    expect(detail.legacy).toBe(true);
    expect(detail.confidence).toBe(0.5);
    expect(detail.confidenceLevel).toBe("LOW");
    expect(detail.provenance).toEqual({ source: "LEGACY", statements: 0, conversations: 0, revisions: 0 });
  });

  it("says when a memory has expired", () => {
    expect(toMemoryDetail(memory({ expiresAt: daysAgo(1) }), NOW).expired).toBe(true);
    expect(toMemoryDetail(memory({ expiresAt: daysAgo(-1) }), NOW).expired).toBe(false);
    expect(toMemoryDetail(memory({ expiresAt: undefined }), NOW).expired).toBe(false);
  });
});

describe("the retention policy", () => {
  it("is explicit: 90 days, a 30-day grace before the purge, and bounded sweeps", () => {
    expect(MEMORY_RETENTION).toEqual({ defaultDays: 90, purgeGraceDays: 30, sweepBatch: 200, sweepUsers: 50 });
    expect(Object.isFrozen(MEMORY_RETENTION)).toBe(true);
  });

  it("only a memory that expired BEFORE the cutoff may be purged", () => {
    const cutoff = memoryPurgeCutoff(NOW);
    expect(cutoff).toEqual(daysAgo(30));

    expect(isPurgeable(daysAgo(31), cutoff)).toBe(true);
    expect(isPurgeable(daysAgo(30), cutoff)).toBe(false); // exactly at the cutoff: not yet
    expect(isPurgeable(daysAgo(29), cutoff)).toBe(false); // expired, still in its grace period
    expect(isPurgeable(daysAgo(-10), cutoff)).toBe(false); // not expired at all
  });

  it("a memory with no expiry is never purgeable, and neither is a broken date", () => {
    const cutoff = memoryPurgeCutoff(NOW);
    expect(isPurgeable(undefined, cutoff)).toBe(false);
    expect(isPurgeable(new Date("not a date"), cutoff)).toBe(false);
    expect(isPurgeable("2020-01-01" as unknown as Date, cutoff)).toBe(false);
  });
});

describe("the Phase 14 tool ids", () => {
  it("are new names beside the L5 ones, which are unchanged", () => {
    expect(MEMORY_CORRECT_TOOL_ID).toBe("memory.correct");
    expect(MEMORY_PURGE_TOOL_ID).toBe("memory.purge_expired");
    expect(MEMORY_TOOL_IDS).toEqual({ list: "memory.list", forget: "memory.forget", forgetAll: "memory.forget_all" });
    expect([...DESTRUCTIVE_MEMORY_TOOL_IDS]).toEqual(["memory.forget", "memory.forget_all"]);
  });
});

describe("isolation — the Phase 14 contracts are pure core logic", () => {
  const files = ["memory-relevance", "memory-correction", "memory-retention", "memory-detail"];

  it.each(files)("%s reads no clock, randomness, environment, network, database or filesystem", (name) => {
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["Date.now", "new Date()", "Math.random", "process.env", "fetch(", "prisma", "Prisma", "@jarvis/", "node:", "readFile"]) {
      expect(code, `${name}: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(files)("%s does not read the L1–L4 learning contracts — MemoryExtractionService stays their only consumer", (name) => {
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
    for (const forbidden of ["learning-candidate", "learning-provenance", "learning-validation", "learning-evidence"]) {
      expect(source, `${name}: ${forbidden}`).not.toContain(forbidden);
    }
  });
});
