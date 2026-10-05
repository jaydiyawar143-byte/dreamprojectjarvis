// ---------------------------------------------------------------------------
// S8.8 — the second reviewed MCP server: unit conversion.
//
// A real MCP server over stdio, on the pinned official SDK's server stack,
// reviewed into core's MCP_MANIFEST as its own server (id "units") with its
// own identity and its own pinned listing. JARVIS runs it only through
// packages/mcp, on its own connection, verified against its own review.
//
// Deliberately boring, and deliberately unlike the dates pilot: two read-only
// tools that convert numbers between fixed units by fixed factors. No state,
// no files, no network, no environment, no clock — the same question always
// gets the same answer, to six significant figures. Tools only: no resources,
// prompts, completions or logging, and it never asks the client for anything.
//
// The low-level `Server`, for the reason the dates pilot gives: the listing is
// written out as reviewed, byte for byte, with no `$schema` added.
// ---------------------------------------------------------------------------

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Metres per unit. */
const LENGTH = { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 };
const TEMPERATURE = ["C", "F", "K"];

const conversion = (units) => ({
  type: "object",
  properties: {
    value: { type: "number", description: "The amount to convert." },
    from: { type: "string", description: "The unit to convert from.", enum: units },
    to: { type: "string", description: "The unit to convert to.", enum: units },
  },
  required: ["value", "from", "to"],
  additionalProperties: false,
});
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "convert_length",
    description: "Converts a length between metric and imperial units.",
    inputSchema: conversion(Object.keys(LENGTH)),
    annotations: { title: "Convert length", ...READ_ONLY },
  },
  {
    name: "convert_temperature",
    description: "Converts a temperature between Celsius, Fahrenheit and Kelvin. Values below absolute zero are refused.",
    inputSchema: conversion(TEMPERATURE),
    annotations: { title: "Convert temperature", ...READ_ONLY },
  },
];

const toKelvin = { C: (v) => v + 273.15, F: (v) => ((v - 32) * 5) / 9 + 273.15, K: (v) => v };
const fromKelvin = { C: (k) => k - 273.15, F: (k) => ((k - 273.15) * 9) / 5 + 32, K: (k) => k };

/** Six significant figures, without trailing zeros. */
const rounded = (value) => String(Number(value.toPrecision(6)));
const answer = (text) => ({ content: [{ type: "text", text }] });
const refuse = (text) => ({ content: [{ type: "text", text }], isError: true });
const isUnit = (table, unit) => typeof unit === "string" && Object.hasOwn(table, unit);

function call(name, args) {
  const { value, from, to } = args;
  if (typeof value !== "number" || !Number.isFinite(value)) return refuse("The value must be a finite number.");
  if (name === "convert_length") {
    if (!isUnit(LENGTH, from) || !isUnit(LENGTH, to)) return refuse("Both units must be listed length units.");
    return answer(`${value} ${from} is ${rounded((value * LENGTH[from]) / LENGTH[to])} ${to}.`);
  }
  if (name === "convert_temperature") {
    if (!isUnit(toKelvin, from) || !isUnit(fromKelvin, to)) return refuse("Both units must be C, F or K.");
    const kelvin = toKelvin[from](value);
    if (kelvin < 0) return refuse("That temperature is below absolute zero.");
    return answer(`${value} ${from} is ${rounded(fromKelvin[to](kelvin))} ${to}.`);
  }
  return refuse("There is no such tool.");
}

const server = new Server({ name: "jarvis-units", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  call(request.params.name, request.params.arguments ?? {})
);
await server.connect(new StdioServerTransport());
