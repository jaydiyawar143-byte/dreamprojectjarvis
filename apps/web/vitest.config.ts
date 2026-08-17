import { defineConfig } from "vitest/config";
import { resolve } from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 15000,
  },
});
