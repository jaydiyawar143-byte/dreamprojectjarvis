// ---------------------------------------------------------------------------
// Phase 19, P0 — the real-Chromium E2E's own vitest configuration.
//
// `pnpm test` never reads this file, and the default configuration never
// collects `*.e2e.ts` (vitest collects `*.test.*` and `*.spec.*`). The one
// way to run the E2E is scripts/browser-e2e/run.mjs, which starts the isolated
// browser service first and passes its address and throwaway credentials in.
// ---------------------------------------------------------------------------

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/e2e/**/*.e2e.ts"],
    // One file, one real browser service: run in order, never in parallel.
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: false },
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
