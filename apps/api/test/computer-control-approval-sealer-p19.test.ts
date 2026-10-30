// ---------------------------------------------------------------------------
// Phase 19, Stage 19.5 — the sealer the approval store is handed (S3).
//
// A browser or desktop approval's exact parameters are sealed with the
// deployment's encryption key — the same EncryptionService, AES-256-GCM
// envelopes and rotation rules as every other secret at rest — or not at all.
// Without a usable key there is no sealer, and the store then creates no such
// approval. And the container must hand the store this sealer, register
// browser writes only when it exists, and purge what approvals leave behind.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateKey } from "@jarvis/security";
import { describe, expect, it } from "vitest";

import { createApprovalParamsSealer } from "../src/services/approval-sealer.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CONTAINER_SOURCE = readFileSync(resolve(here, "../src/services/container.ts"), "utf-8");

const PARAMS = JSON.stringify({ url: "https://shop.example/login", selector: "#password", text: "hunter2-TYPED" });

describe("Phase 19.5 — the approval sealer", () => {
  it("seals with the deployment's key, and only that key unseals", () => {
    const key = generateKey();
    const sealer = createApprovalParamsSealer({ JARVIS_ENCRYPTION_KEY: key } as NodeJS.ProcessEnv)!;
    const sealed = sealer.seal(PARAMS);
    expect(sealed).not.toContain("hunter2-TYPED");
    expect(sealer.seal(PARAMS)).not.toBe(sealed); // a fresh nonce each time
    expect(sealer.unseal(sealed)).toBe(PARAMS);

    const other = createApprovalParamsSealer({ JARVIS_ENCRYPTION_KEY: generateKey() } as NodeJS.ProcessEnv)!;
    expect(() => other.unseal(sealed)).toThrow();
  });

  it("still unseals under a retired key after rotation", () => {
    const old = generateKey();
    const sealed = createApprovalParamsSealer({ JARVIS_ENCRYPTION_KEY: old } as NodeJS.ProcessEnv)!.seal(PARAMS);
    const rotated = createApprovalParamsSealer({
      JARVIS_ENCRYPTION_KEY: generateKey(),
      JARVIS_ENCRYPTION_KEY_VERSION: "2",
      JARVIS_ENCRYPTION_KEY_RETIRED: `1:${old}`,
    } as NodeJS.ProcessEnv)!;
    expect(rotated.unseal(sealed)).toBe(PARAMS);
  });

  it("is absent without a key, or with a key that is not one — never a weaker stand-in", () => {
    expect(createApprovalParamsSealer({} as NodeJS.ProcessEnv)).toBeNull();
    expect(createApprovalParamsSealer({ JARVIS_ENCRYPTION_KEY: "" } as NodeJS.ProcessEnv)).toBeNull();
    expect(createApprovalParamsSealer({ JARVIS_ENCRYPTION_KEY: "not-a-key" } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("Phase 19.5 — the container's wiring", () => {
  it("hands the approval store the sealer", () => {
    expect(CONTAINER_SOURCE).toMatch(/const approvalSealer = createApprovalParamsSealer\(\);/);
    expect(CONTAINER_SOURCE).toMatch(
      /new PrismaApprovalRepository\(prisma, approvalSealer \? \{ sealer: approvalSealer \} : \{\}\)/
    );
  });

  it("registers browser writes only where their approvals can be sealed — in both modes", () => {
    const registrations = [...CONTAINER_SOURCE.matchAll(/createBrowserTools\(runtime, browserJournal, approvalConsumption, browserWriteScope\)/g)];
    expect(registrations).toHaveLength(2);
    for (const match of registrations) {
      const after = CONTAINER_SOURCE.slice(match.index!, match.index! + 200);
      expect(after).toMatch(/\.filter\(\(tool\) => browserWritesSealed \|\| !tool\.requiresApproval\)/);
    }
  });

  it("purges sealed parameters that approvals left behind, at start-up and on an interval", () => {
    expect(CONTAINER_SOURCE).toMatch(/const purgeSealedParams = \(\) =>\s*void approvalRepo\.purgeExpiredSealedParams\(\)\.catch\(/);
    const startup = CONTAINER_SOURCE.indexOf("\n  purgeSealedParams();");
    expect(startup).toBeGreaterThan(-1);
    expect(CONTAINER_SOURCE.indexOf("setInterval(purgeSealedParams, ")).toBeGreaterThan(startup);
  });
});
