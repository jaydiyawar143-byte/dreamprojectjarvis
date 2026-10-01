// S8.2 — the MCP runtime: one reviewed server per McpConnection. The only
// package that knows the MCP SDK. Nothing in JARVIS uses it yet: registering
// MCP tools is a later step. The call types (McpCallPort, McpCallResult,
// McpFailure…) are core's, shared with the tool adapter (S8.3).
export { McpConnection, type McpConnectionOptions, type McpConnectionState } from "./connection.js";
export * from "./normalize.js";
export * from "./config.js";
