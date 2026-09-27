// S7 Step 4 — structural boundary for the memory retrieval repair.
//
// The repair touches exactly two production files: the Prisma memory repository
// and the memory extraction service. Neither may reach execution, authority or a
// provider SDK. This scans ONLY those two files — it is deliberately not a
// repository-wide scanner.
//
// Expected to PASS today and to keep passing after the repair: it guards the
// scope of the change rather than describing a defect.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPAIR_FILES = {
  repository: resolve(__dirname, "../../db/src/repositories/memory-repository.ts"),
  extraction: resolve(__dirname, "../src/memory-extraction-service.ts"),
};

/** Every module specifier a file imports or re-exports, static or dynamic. */
function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const m of source.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)) specifiers.add(m[1]!);
  for (const m of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) specifiers.add(m[1]!);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(m[1]!);
  for (const m of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(m[1]!);
  return [...specifiers];
}

// Execution, authority and approval code, and every provider SDK or provider
// package. Memory needs none of them.
const FORBIDDEN_SPECIFIERS: RegExp[] = [
  /tool-executor|tool-execution|ToolExecutor/i,
  /agent-policy|\/policy|policies/i,
  /write-intent/i,
  /approval|pending-action|confirmation/i,
  /^@jarvis\/(tools|agents|security|ai-openai|ai-anthropic|ai-elevenlabs|meta-graph|google-ads|google-workspace|whatsapp|n8n|browser)(\/|$)/,
  /^(openai|@anthropic-ai\/.*|googleapis|google-auth-library|twilio)$/,
];

// The only external modules the two files may use.
const ALLOWED_EXTERNAL = new Set(["@jarvis/core", "@prisma/client"]);

// Authority identifiers that must not appear in the code at all.
const FORBIDDEN_IDENTIFIERS = [
  "ToolExecutor",
  "classifyWriteIntent",
  "AGENT_POLICIES",
  "ApprovalService",
  "PendingActionService",
];

describe("S7 memory retrieval repair — structural boundary", () => {
  for (const [name, path] of Object.entries(REPAIR_FILES)) {
    const source = readFileSync(path, "utf8");
    const specifiers = importSpecifiers(source);

    it(`${name}: imports nothing from execution, authority, approval or provider code`, () => {
      expect(specifiers.length, "the file was parsed").toBeGreaterThan(0);
      for (const specifier of specifiers) {
        for (const pattern of FORBIDDEN_SPECIFIERS) {
          expect(specifier, `${name} imports ${specifier}`).not.toMatch(pattern);
        }
      }
    });

    it(`${name}: external imports stay within core contracts and the database client`, () => {
      for (const specifier of specifiers) {
        const isLocal = specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("node:");
        expect(isLocal || ALLOWED_EXTERNAL.has(specifier), `${name} imports ${specifier}`).toBe(true);
      }
    });

    it(`${name}: names no execution or authority identifier`, () => {
      for (const identifier of FORBIDDEN_IDENTIFIERS) {
        expect(source.includes(identifier), `${name} mentions ${identifier}`).toBe(false);
      }
    });
  }
});
