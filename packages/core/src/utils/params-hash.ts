import { createHash } from "node:crypto";

/**
 * Deterministic canonical serialization for approval parameter hashing.
 *
 * Rules:
 * - Object keys are recursively sorted lexicographically so hash is
 *   independent of key insertion order.
 * - Array order is significant (arrays are positional).
 * - `undefined` property values are skipped; `undefined` array items and
 *   standalone values serialize as `null` (matching JSON semantics).
 * - Functions and symbols are rejected (non-serializable params).
 * - The representation is internal only — it is never logged.
 */
export function canonicalizeForHash(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "bigint":
      throw new TypeError("bigint is not supported in approval params");
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item) =>
          item === undefined ? "null" : serialize(item)
        );
        return `[${items.join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(
        `Unsupported type "${typeof value}" in approval params`
      );
  }
}

/**
 * SHA-256 hex digest of the canonical representation of tool params.
 * Used to bind an approval to the exact parameters a human approved;
 * any parameter change produces a different hash and invalidates reuse.
 */
export function computeParamsHash(
  params: Record<string, unknown> | null | undefined
): string {
  return createHash("sha256")
    .update(canonicalizeForHash(params ?? {}))
    .digest("hex");
}
