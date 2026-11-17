// ---------------------------------------------------------------------------
// UEE-0 — where a tool can be executed from.
//
// `ToolExecutor` is the one place that checks a tool's permissions, its
// Organization access, its approval, its deadline and its audit row. A tool
// run any other way runs WITHOUT those. This file inventories every `.execute(`
// call in production source and sorts it into one of three kinds:
//
//   EXECUTOR    the call is on a ToolExecutor (IToolExecutor): the sanctioned path.
//   SERVICE     a different `execute` that is not a tool: the integration command
//               service, Google writes, the publish flow, the browser-service
//               client, the sandbox client. Each is its own service's operation.
//   DIRECT      `ITool.execute(params, context)` called on a tool object, past the
//               executor. THIS is the kind the boundary is about, and it is pinned
//               EXACTLY — every file, every receiver, every call.
//
// A call that fits no kind fails the test and says so. The fix is to route it
// through the executor, or — when a direct call really is right — to add it to
// APPROVED_DIRECT below with the reason, in the same change.
//
// THE APPROVED DIRECT CALLS (verified, 2026-11). Three, in two agents:
//   meta-ads-agent.ts     meta.accounts, meta.campaigns   — the agent builds its
//                         server-authoritative account context before the model runs
//   google-ads-agent.ts   google.accounts                 — the same, for Google Ads
// plus the executor's own `tool.execute`, which is the sanctioned call itself.
// All three agent calls are READ_ONLY tools with no approval, asked once per turn
// for context. They skip the executor's role check, Organization gate and audit
// row; what stops them being more than a read is that they name three fixed ids
// and the tools enforce per-account authorization themselves. An earlier audit
// named only the Meta calls: the Google Ads one was found by the inventory below.
//
// What this does NOT prove, and cannot as a text scan: that a receiver named
// `executor` is a ToolExecutor, or that no tool is run through an alias the
// patterns below do not recognise. It guards against a change that did not mean
// to bypass the executor; the type system (`IToolExecutor`) is what makes the
// sanctioned path the easy one.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { SHARED_CONNECTION_TOOLS } from "@jarvis/core";
import { AGENT_POLICIES, schedulableToolIds } from "@jarvis/agents";
import { GoogleGetAccountsTool, MetaGetAccountsTool, MetaGetCampaignsTool } from "@jarvis/tools";

import { productionSourceFiles, readRepoFile, stripComments } from "./helpers/source-scan.js";

// ---------------------------------------------------------------------------
// Finding the calls
// ---------------------------------------------------------------------------

interface CallSite {
  file: string;
  receiver: string;
}

/** `a.b.c.execute(`, across a line break too (`this.deps.client\n  .execute(`). */
const NAMED_RECEIVER = /([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*\??\.\s*execute\s*\(/g;
/** `getTool(id).execute(`, `tools[0].execute(`: a receiver that is an expression. */
const EXPRESSION_RECEIVER = /[)\]]\s*\??\.\s*execute\s*\(/g;
/** Ways to call `execute` that do not look like a method call at all. */
const ALIASED =
  // tool["execute"](…) — a CALL. `IToolExecutor["execute"]` in a type position has no parenthesis after it.
  /\[\s*["'`]execute["'`]\s*\]\s*\??\.?\s*\(|\.execute\s*\.\s*(?:call|apply|bind)\b|\{[^{}]*\bexecute\b[^{}:]*\}\s*=[^=>]/g;

function callSites(file: string, source: string): CallSite[] {
  const code = stripComments(source);
  const sites: CallSite[] = [];
  for (const match of code.matchAll(NAMED_RECEIVER)) sites.push({ file, receiver: match[1]! });
  for (const _match of code.matchAll(EXPRESSION_RECEIVER)) sites.push({ file, receiver: "<expression>" });
  for (const match of code.matchAll(ALIASED)) sites.push({ file, receiver: `<alias: ${match[0].replace(/\s+/g, " ").slice(0, 40)}>` });
  return sites;
}

const label = (site: CallSite): string => `${site.file} :: ${site.receiver}`;

// ---------------------------------------------------------------------------
// The three kinds
// ---------------------------------------------------------------------------

/** A ToolExecutor: `executor`, `toolExecutor`, `this.deps.executor`, `container.executor`. */
const EXECUTOR_RECEIVER = /(?:^|\.)(?:tool)?[Ee]xecutor$/;

/**
 * `execute` methods that are not tools. Present or absent, any number of times:
 * an added `commands.execute(...)` in the integrations router is its own
 * service's business. Listed by file so a service's name on a new file — a tool
 * given a port called `commands`, an agent holding a `client` — is not waved
 * through by a common word.
 */
const SERVICE_CALLS = new Set<string>([
  "apps/api/src/routes/google-writes.ts :: writes", // GoogleWriteService.execute(approvalId, …)
  "apps/api/src/routes/integrations.ts :: commands", // IntegrationCommandService.execute(command, context)
  "apps/api/src/routes/marketing.ts :: deps.publishFlow", // the publish flow's own execute
  "apps/api/src/routes/recommendations.ts :: executionService", // RecommendationExecutionService
  "apps/api/src/services/container.ts :: integrationCommands", // the IntegrationCommandPort adapter
  "apps/api/src/services/google/execute-approved-action.ts :: writes", // GoogleWriteService
  "apps/api/src/services/n8n-sandbox/sandbox-service.ts :: this.client", // the sandbox client (see the import boundary)
  "apps/browser-service/src/server.ts :: registry", // BrowserSessionRegistry, inside the browser service
  "packages/browser-protocol/src/probe.ts :: client", // BrowserServiceClient
  "packages/browser-protocol/src/remote-runtime.ts :: this.deps.client", // BrowserServiceClient
  "packages/browser-protocol/src/remote-runtime.ts :: this.client", // BrowserServiceClient
  "packages/tools/src/tools/integration-tools.ts :: this.port", // IntegrationCommandPort, not a provider
]);

/**
 * `ITool.execute(params, context)` called on a tool, past the executor. EXACT:
 * every call, with its multiplicity.
 */
const APPROVED_DIRECT: readonly string[] = [
  // The executor itself: the one sanctioned place a tool is run. Not a bypass.
  "packages/tools/src/executor.ts :: tool",
  // Context for the model before it runs: the account list, read-only.
  "packages/agents/src/agents/google-ads-agent.ts :: tool", // google.accounts
  "packages/agents/src/agents/meta-ads-agent.ts :: accountsTool", // meta.accounts
  "packages/agents/src/agents/meta-ads-agent.ts :: campaignsTool", // meta.campaigns
];

type Kind = "executor" | "service" | "direct" | "unclassified";

function classify(site: CallSite): Kind {
  if (EXECUTOR_RECEIVER.test(site.receiver)) return "executor";
  if (APPROVED_DIRECT.includes(label(site))) return "direct";
  if (SERVICE_CALLS.has(label(site))) return "service";
  return "unclassified";
}

const FILES = productionSourceFiles();
const SITES = FILES.flatMap((file) => callSites(file, readRepoFile(file)));

// ---------------------------------------------------------------------------
// 1. The inventory
// ---------------------------------------------------------------------------

describe("every .execute( call in production source", () => {
  it("is scanned from the real tree, not an empty one", () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(SITES.length).toBeGreaterThan(25);
    // The sanctioned calls are found: a scan that missed them would be blind.
    expect(SITES.map(label)).toEqual(
      expect.arrayContaining([
        "packages/agents/src/orchestrator.ts :: this.toolExecutor",
        "packages/tools/src/executor.ts :: tool",
        "apps/api/src/services/tasks/task-execution-service.ts :: this.deps.executor",
      ])
    );
  });

  it("is on a ToolExecutor, a named service, or an approved direct call", () => {
    // A failure lists the file and the receiver. If it runs a TOOL, send it
    // through ToolExecutor. If it is another service's execute, add it to
    // SERVICE_CALLS. If a direct tool call is genuinely right, add it to
    // APPROVED_DIRECT with the reason — that list is the record of the bypasses.
    const unclassified = SITES.filter((site) => classify(site) === "unclassified").map(label);
    expect(unclassified).toEqual([]);
  });

  it("holds no call through an expression, an index, an alias or call/apply/bind", () => {
    const hidden = SITES.filter((site) => site.receiver.startsWith("<")).map(label);
    expect(hidden).toEqual([]);
  });
});

describe("direct tool execution, past ToolExecutor", () => {
  it("is exactly the approved calls — each file, each receiver, each call", () => {
    const direct = SITES.filter((site) => classify(site) === "direct").map(label);
    expect([...direct].sort()).toEqual([...APPROVED_DIRECT].sort());
  });

  it("in packages/agents is exactly the orchestrator's executor call and the three approved reads", () => {
    const inAgents = SITES.filter((site) => site.file.startsWith("packages/agents/src/")).map(label);
    expect([...inAgents].sort()).toEqual(
      [
        "packages/agents/src/agents/google-ads-agent.ts :: tool",
        "packages/agents/src/agents/meta-ads-agent.ts :: accountsTool",
        "packages/agents/src/agents/meta-ads-agent.ts :: campaignsTool",
        "packages/agents/src/orchestrator.ts :: this.toolExecutor",
      ].sort()
    );
  });

  it("is absent from every route, task service and tool: they run tools through the executor or a service", () => {
    for (const area of ["apps/api/src/routes/", "apps/api/src/services/", "packages/tools/src/tools/"]) {
      const direct = SITES.filter((site) => site.file.startsWith(area) && classify(site) === "direct").map(label);
      expect(direct).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. An agent's tool call goes through ToolExecutor
// ---------------------------------------------------------------------------

describe("the orchestrator, which runs every tool an agent proposes", () => {
  const orchestrator = stripComments(readRepoFile("packages/agents/src/orchestrator.ts"));

  it("executes a tool in exactly one place, and that place is its ToolExecutor", () => {
    const sites = callSites("packages/agents/src/orchestrator.ts", readRepoFile("packages/agents/src/orchestrator.ts"));
    expect(sites.map((site) => site.receiver)).toEqual(["this.toolExecutor"]);
  });

  it("holds that executor as the interface, not a concrete class that could be swapped for a tool", () => {
    expect(orchestrator).toMatch(/private\s+toolExecutor:\s*IToolExecutor\b/);
  });

  it("gives an agent a scoped, read-only view of the registry: its tools, not the executor", () => {
    const context = stripComments(readRepoFile("packages/agents/src/domain-agent.ts"));
    expect(context).not.toMatch(/ToolExecutor|toolExecutor/);
    expect(callSites("packages/agents/src/domain-agent.ts", readRepoFile("packages/agents/src/domain-agent.ts"))).toEqual([]);
  });
});

describe("the executor", () => {
  it("is built in one place: the composition root", () => {
    const builders = FILES.filter((file) => /\bnew\s+ToolExecutor\s*\(/.test(stripComments(readRepoFile(file))));
    expect(builders).toEqual(["apps/api/src/services/container.ts"]);
  });
});

// ---------------------------------------------------------------------------
// 3. The approved direct calls are reads, and fixed
// ---------------------------------------------------------------------------

describe("the approved direct tool calls", () => {
  const LOOKUP = /toolRegistry\??\.get\(\s*["']([^"']+)["']\s*\)/g;
  const ANY_LOOKUP = /toolRegistry\??\.get\(/g;

  const lookups = (file: string): { literal: string[]; all: number } => {
    const code = stripComments(readRepoFile(file));
    return { literal: [...code.matchAll(LOOKUP)].map((match) => match[1]!), all: (code.match(ANY_LOOKUP) ?? []).length };
  };

  it("name three fixed tool ids, each looked up by a literal and never by a computed name", () => {
    const meta = lookups("packages/agents/src/agents/meta-ads-agent.ts");
    expect(meta.literal.sort()).toEqual(["meta.accounts", "meta.campaigns"]);
    expect(meta.all).toBe(meta.literal.length);

    const google = lookups("packages/agents/src/agents/google-ads-agent.ts");
    expect(google.literal).toEqual(["google.accounts"]);
    expect(google.all).toBe(google.literal.length);
  });

  // The real tool classes, built with inert doubles: only their declared
  // contract is read, no method that reaches a provider is called.
  it.each([
    ["meta.accounts", () => new MetaGetAccountsTool({} as never, {} as never)],
    ["meta.campaigns", () => new MetaGetCampaignsTool({} as never, {} as never)],
    ["google.accounts", () => new GoogleGetAccountsTool({} as never, {} as never)],
  ])("%s is a read-only tool that needs no approval", (id, build) => {
    const tool = build();
    expect(tool.id).toBe(id);
    expect(tool.risk).toBe("READ_ONLY");
    expect(tool.requiresApproval).toBe(false);
    expect(tool.requiredPermissions).toEqual(["read"]);
  });

  it("are not shared-connection WRITES (a direct call must never reach one)", () => {
    for (const id of ["meta.accounts", "meta.campaigns", "google.accounts"]) {
      const entry = (SHARED_CONNECTION_TOOLS as Record<string, { access: string } | undefined>)[id];
      // meta.* are listed as reads; google.accounts is not a shared connection at all.
      expect(entry?.access ?? "read").toBe("read");
    }
  });

  it("pass the tool a context of a user, a conversation and a trace: no approval, no grant, no signal that could authorize a write", () => {
    const keys = (code: string, pattern: RegExp): string[] => {
      const body = pattern.exec(code)?.[1];
      expect(body, "the context object was not found").toBeDefined();
      return [...body!.matchAll(/(\w+)\s*:/g)].map((match) => match[1]!).sort();
    };

    const meta = stripComments(readRepoFile("packages/agents/src/agents/meta-ads-agent.ts"));
    expect(keys(meta, /const toolCtx = \{([^}]*)\}/)).toEqual(["conversationId", "traceId", "userId"]);

    const google = stripComments(readRepoFile("packages/agents/src/agents/google-ads-agent.ts"));
    expect(keys(google, /tool\.execute\(\s*\{\}\s*,\s*\{([^}]*)\}\s*\)/)).toEqual(["conversationId", "traceId", "userId"]);

    // And neither file reaches the grant machinery that lets an approval-gated tool run.
    for (const code of [meta, google]) expect(code).not.toMatch(/issueExecutionGrant|execution-grant/);
  });
});

// ---------------------------------------------------------------------------
// 4. Nothing for the sandbox exists yet on the tool side
// ---------------------------------------------------------------------------

describe("the sandbox is not a tool, and no agent holds one", () => {
  it("is on no agent's allowlist", () => {
    for (const [agentId, policy] of Object.entries(AGENT_POLICIES)) {
      expect({ agentId, sandbox: policy.allowedTools.filter((id) => /sandbox/i.test(id)) }).toEqual({ agentId, sandbox: [] });
    }
  });

  it("is not a task tool, so a scheduled run cannot reach it", () => {
    expect([...schedulableToolIds()].filter((id) => /sandbox/i.test(id))).toEqual([]);
  });

  it("is named by no tool id and no tool class in the tool, agent or core packages", () => {
    const offenders: string[] = [];
    for (const file of FILES.filter((f) => /^packages\/(?:tools|agents|core)\/src\//.test(f))) {
      const code = stripComments(readRepoFile(file));
      if (/["'`](?:n8n[.:-])?sandbox[.:][a-z]/i.test(code)) offenders.push(`${file}: a sandbox tool id`);
      if (/class\s+\w*Sandbox\w*\s+extends\s+BaseTool\b/.test(code)) offenders.push(`${file}: a sandbox tool class`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. The scanner, shown on cases it must classify
// ---------------------------------------------------------------------------

describe("the call-site scanner finds a call however it is written", () => {
  const FILE = "packages/agents/src/agents/example-agent.ts";
  const receivers = (source: string): string[] => callSites(FILE, source).map((site) => site.receiver);

  it.each<[string, string, string]>([
    ["a direct call on a tool", `const r = await tool.execute({}, ctx);`, "tool"],
    ["a call on a property chain", `await this.deps.tools.accounts.execute(p, c);`, "this.deps.tools.accounts"],
    ["an optional call", `const r = await tool?.execute({}, ctx);`, "tool"],
    ["a call after a line break", `const r = await this.deps.client\n        .execute({ a: 1 });`, "this.deps.client"],
    ["a call on an executor", `await this.toolExecutor.execute(request);`, "this.toolExecutor"],
  ])("%s", (_label, source, receiver) => {
    expect(receivers(source)).toContain(receiver);
  });

  it.each<[string, string]>([
    ["a tool from a lookup", `await registry.get(id).execute(params, context);`],
    ["a tool from an index", `await tools[0].execute(params, context);`],
    ["a bracket call", `await tool["execute"](params, context);`],
    ["a bound call", `const run = tool.execute.bind(tool);`],
    ["a call-through", `await tool.execute.call(tool, params, context);`],
    ["a destructured method", `const { execute } = tool;`],
  ])("reports %s as hidden, so it fails the classification", (_label, source) => {
    expect(receivers(source).some((receiver) => receiver.startsWith("<"))).toBe(true);
  });

  it("classifies a new direct call in an agent as unclassified, which fails the inventory", () => {
    const site = callSites(FILE, `await writeTool.execute(params, context);`)[0]!;
    expect(classify(site)).toBe("unclassified");
  });

  it("does not read a comment, a type position or a definition as a call", () => {
    expect(receivers(`// tool.execute(params, ctx)\n/* x.execute(a) */\ntype E = IToolExecutor["execute"];\nclass A { async execute(p: P) {} }`)).toEqual([]);
  });
});
