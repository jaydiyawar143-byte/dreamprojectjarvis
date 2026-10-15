// S8.2 — the MCP runtime: one reviewed server per McpConnection. The only
// package that knows the MCP SDK. The API container is its only user: it
// builds one connection per reviewed server and registers their tools (S8.4).
// The call types (McpCallPort, McpCallResult, McpFailure…) are core's, shared
// with the tool adapter (S8.3).
export { McpConnection, type McpConnectionOptions, type McpConnectionState } from "./connection.js";
export * from "./normalize.js";
export * from "./config.js";
// S8.7 — the remote MCP transport: Streamable HTTP, for a server JARVIS does
// not spawn and cannot review (an MCP endpoint behind OAuth or a bearer token).
// Discovery and invocation only; it never claims a discovered tool was reviewed.
export * from "./http-connection.js";
