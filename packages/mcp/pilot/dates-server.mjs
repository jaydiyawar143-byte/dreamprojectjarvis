// ---------------------------------------------------------------------------
// S8.6 — the pilot MCP server: calendar dates.
//
// A real MCP server over stdio, on the pinned official SDK's server stack:
// real initialize, protocol negotiation, tools/list and tools/call. Reviewed
// into core's MCP_MANIFEST (server id "dates"); JARVIS runs it only through
// packages/mcp, which verifies this exact listing before any call.
//
// Deliberately boring: two read-only tools that do calendar arithmetic and
// nothing else. No state, no files, no network, no environment, no clock — the
// same question always gets the same answer. Tools only: no resources,
// prompts, completions or logging, and it never asks the client for anything.
//
// The low-level `Server`, not `McpServer`: McpServer adds `$schema` to every
// input schema, which the S8.1 review contract does not accept. Here the
// listing is written out as reviewed, byte for byte. Changing anything in it
// changes its fingerprint, and JARVIS refuses the server until it is
// reviewed again.
// ---------------------------------------------------------------------------

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const date = (description) => ({ type: "string", description, maxLength: 10 });
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "days_between",
    description:
      "Counts the days from one calendar date to another. The count is negative when the second date is earlier.",
    inputSchema: {
      type: "object",
      properties: {
        start: date("The first date, written YYYY-MM-DD."),
        end: date("The second date, written YYYY-MM-DD."),
      },
      required: ["start", "end"],
      additionalProperties: false,
    },
    annotations: { title: "Days between dates", ...READ_ONLY },
  },
  {
    name: "day_of_week",
    description: "Names the day of the week a calendar date falls on.",
    inputSchema: {
      type: "object",
      properties: { date: date("The date, written YYYY-MM-DD.") },
      required: ["date"],
      additionalProperties: false,
    },
    annotations: { title: "Day of the week", ...READ_ONLY },
  },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;

/** A real calendar date as UTC midnight, or null — 2026-02-30 is refused, never rolled over. */
function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value ? null : ms;
}

const answer = (text) => ({ content: [{ type: "text", text }] });
const refuse = (text) => ({ content: [{ type: "text", text }], isError: true });

function call(name, args) {
  if (name === "days_between") {
    const start = parseDate(args.start);
    const end = parseDate(args.end);
    if (start === null || end === null) return refuse("Both dates must be real calendar dates, written YYYY-MM-DD.");
    return answer(`${Math.round((end - start) / DAY_MS)} days from ${args.start} to ${args.end}.`);
  }
  if (name === "day_of_week") {
    const day = parseDate(args.date);
    if (day === null) return refuse("The date must be a real calendar date, written YYYY-MM-DD.");
    return answer(`${args.date} is a ${WEEKDAYS[new Date(day).getUTCDay()]}.`);
  }
  return refuse("There is no such tool.");
}

const server = new Server({ name: "jarvis-dates", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  call(request.params.name, request.params.arguments ?? {})
);
await server.connect(new StdioServerTransport());
