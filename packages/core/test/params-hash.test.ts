import { describe, it, expect } from "vitest";
import {
  canonicalizeForHash,
  computeParamsHash,
} from "../src/utils/params-hash.js";

describe("computeParamsHash — canonical approval param binding", () => {
  it("is deterministic for identical params", () => {
    const a = { toolId: "meta.campaign.create", proposal: { name: "X", budget: 100 } };
    const b = { toolId: "meta.campaign.create", proposal: { name: "X", budget: 100 } };
    expect(computeParamsHash(a)).toBe(computeParamsHash(b));
  });

  it("is independent of object key order (nested)", () => {
    const a = { a: 1, b: { c: 2, d: [1, { x: "s", y: true }] }, e: null };
    const b = { e: null, b: { d: [1, { y: true, x: "s" }], c: 2 }, a: 1 };
    expect(computeParamsHash(a)).toBe(computeParamsHash(b));
  });

  it("is independent of top-level key order", () => {
    expect(computeParamsHash({ accountId: "act_1", name: "n" })).toBe(
      computeParamsHash({ name: "n", accountId: "act_1" })
    );
  });

  it("changes when any parameter value changes", () => {
    const base = { name: "camp", dailyBudget: 100 };
    expect(computeParamsHash(base)).not.toBe(
      computeParamsHash({ ...base, dailyBudget: 101 })
    );
    expect(computeParamsHash(base)).not.toBe(
      computeParamsHash({ ...base, name: "camp2" })
    );
  });

  it("changes when a parameter is added or removed", () => {
    const base = { name: "camp" };
    expect(computeParamsHash(base)).not.toBe(
      computeParamsHash({ ...base, extra: 1 })
    );
  });

  it("treats arrays as positional (order matters)", () => {
    expect(computeParamsHash({ ids: [1, 2, 3] })).not.toBe(
      computeParamsHash({ ids: [3, 2, 1] })
    );
  });

  it("skips undefined properties but keeps explicit nulls", () => {
    expect(computeParamsHash({ a: 1, b: undefined })).toBe(
      computeParamsHash({ a: 1 })
    );
    expect(computeParamsHash({ a: null })).not.toBe(computeParamsHash({}));
  });

  it("distinguishes string numbers from numbers and bool from string", () => {
    expect(computeParamsHash({ v: 100 })).not.toBe(computeParamsHash({ v: "100" }));
    expect(computeParamsHash({ v: true })).not.toBe(computeParamsHash({ v: "true" }));
  });

  it("produces a 64-char sha256 hex digest", () => {
    const hash = computeParamsHash({ anything: true });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles empty params consistently", () => {
    expect(computeParamsHash({})).toBe(computeParamsHash({}));
    // @ts-expect-error runtime tolerance
    expect(computeParamsHash(null)).toBe(computeParamsHash(undefined));
    expect(computeParamsHash(null)).toBe(computeParamsHash({}));
  });

  it("stores only the digest — secret values never appear in the hash", () => {
    const SECRET = "TEST-SECRET-TOKEN-VALUE-42-not-a-real-Meta-token";
    const params = { accessToken: SECRET, name: "camp" };
    const hash = computeParamsHash(params);
    // the persisted/loggable artifact is the SHA-256 hex digest only
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(SECRET);
    // canonicalization is a transient in-memory digest input, deterministic
    expect(canonicalizeForHash(params)).toBe(canonicalizeForHash({ name: "camp", accessToken: SECRET }));
  });

  it("rejects non-serializable values deterministically", () => {
    expect(() => computeParamsHash({ fn: () => 1 })).toThrow(TypeError);
    expect(() => computeParamsHash({ big: BigInt(1) })).toThrow(TypeError);
  });
});
