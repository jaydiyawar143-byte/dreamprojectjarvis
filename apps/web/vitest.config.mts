import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

// A `.mts` config is loaded as ESM, so Vite's native config loader does not
// warn about ESM syntax in a CommonJS file. `import.meta.url` replaces
// `__dirname`, which does not exist in ESM.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 15000,
  },
});
