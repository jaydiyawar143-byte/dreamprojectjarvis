import { defineConfig } from "vitest/config";

// The connection tests spawn real (fake) MCP server processes.
export default defineConfig({ test: { globals: true, environment: "node", testTimeout: 30000 } });
