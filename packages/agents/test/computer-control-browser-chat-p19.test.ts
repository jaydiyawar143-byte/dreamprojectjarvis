// ---------------------------------------------------------------------------
// Phase 19 — chat and the browser: which messages are browsing requests, and
// what the orchestrator answers when this server has no Browser Agent.
//
// `looksLikeBrowsingRequest` is a routing heuristic and authorizes nothing:
// the Browser Agent still chooses a tool, the policy still allowlists it and
// the executor still checks it. It needs BOTH an explicit http(s) link and a
// browsing verb that governs it, so a message that merely contains a link
// keeps reaching whoever answered it before.
//
// The orchestrator, the router, the agents and the registry are the real ones;
// the model and the executor are doubles. The route-level path (task
// interception, the browser service) is in
// apps/api/test/browser-chat-route-p19.test.ts.
//
// Named `computer-control*`, the slice CI runs for this package.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { AICompletionRequest, AICompletionResponse, AuditEntry, IAIProvider, IToolExecutor } from "@jarvis/core";

import { AGENT_IDS } from "../src/agent-policy.js";
import { KNOWN_SITES } from "../src/known-sites.js";
import { looksLikeBrowsingRequest, rankAgentCandidates } from "../src/agent-router.js";
import { parseSchedulePhrase } from "../src/schedule-phrase.js";
import { detectWorkRequest } from "../src/work-request-detector.js";
import { BrowserAgent } from "../src/agents/browser-agent.js";
import { ConversationalAssistant } from "../src/agents/conversational-assistant.js";
import { Orchestrator } from "../src/orchestrator.js";
import { AgentRegistry } from "../src/registry.js";

// ---------------------------------------------------------------------------
// 1. Which messages are browsing requests
// ---------------------------------------------------------------------------

describe("looksLikeBrowsingRequest", () => {
  it.each([
    ["open a link", "Open https://example.com"],
    ["check and summarize", "Check https://example.com and summarize the page"],
    ["a screenshot of a link", "Take a screenshot of https://example.com"],
    ["read and summarise", "please read https://example.com and summarise it"],
    ["check an http link", "check http://example.com/status"],
    ["go to", "go to https://example.com/pricing"],
    ["summarize, link first", "https://example.com/blog summarize this for me"],
    ["a link on its own", "https://example.com/pricing"],
    ["Hinglish", "https://example.com kholo"],
    ["read, after the link", "Here is the doc https://example.com/doc — can you read it"],
  ])("is true for %s", (_label, message) => {
    expect(looksLikeBrowsingRequest(message)).toBe(true);
  });

  it.each([
    ["no link at all", "open this website for me"],
    ["work with no link", "check my system status"],
    ["a link the user only mentions", "Write a tagline for my site https://example.com"],
    ["a link and a request for words", "My site is https://example.com, write ad copy for it"],
    ["a past visit", "I visited https://example.com yesterday and loved it"],
    ["an application", "open notepad"],
    ["a scheme that is not the web", "open file:///etc/passwd"],
    ["empty", ""],
  ])("is false for %s", (_label, message) => {
    expect(looksLikeBrowsingRequest(message)).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// 1b. A well-known site named by NAME, with no link ("Amazon kholo ...")
// ---------------------------------------------------------------------------

describe("looksLikeBrowsingRequest: a well-known site named without a link", () => {
  it.each([
    ["the reported Hinglish request", "Amazon kholo aur iPhone 17 ka price check karo."],
    ["verb first", "open amazon and check the price of iPhone 17"],
    ["a domain name", "go to amazon.in and look at the iPhone 17"],
    ["another shop", "Flipkart kholo"],
    ["search", "search amazon for iphone 17"],
    ["Hinglish, site last", "kholo flipkart.com"],
    ["visit", "please visit wikipedia and read about Mumbai"],
  ])("is true for %s", (_label, message) => {
    expect(looksLikeBrowsingRequest(message)).toBe(true);
  });

  it.each([
    ["amazon ads", "Amazon ads ka report check karo"],
    ["a possessive", "check Amazon's quarterly results"],
    ["web services", "open Amazon Web Services console notes"],
    ["a question about the company", "who founded amazon"],
    ["no verb", "I bought an iPhone on amazon last year"],
    ["a shop and a task", "Remind me to buy from amazon tomorrow"],
  ])("is false for %s", (_label, message) => {
    expect(looksLikeBrowsingRequest(message)).toBe(false);
  });

  it("is routed to the Browser Agent first", () => {
    expect(rankAgentCandidates("Amazon kholo aur iPhone 17 ka price check karo.")[0]?.agentId).toBe(AGENT_IDS.browser);
  });

  it("is answered with the server's reason where there is no Browser Agent", async () => {
    const { say, general } = world({ reason: REASON });
    const reply = await say("Amazon kholo aur iPhone 17 ka price check karo.");
    expect(reply.data?.message).toBe(REASON);
    expect(general.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 1c. Natural phrasings: a price asked "on <site>", and "<site> par ... <verb>"
// ---------------------------------------------------------------------------

describe("looksLikeBrowsingRequest: natural phrasings that name a shop", () => {
  const ASKED = [
    ["a price asked on a site", "Price of iPhone 17 on Flipkart"],
    ["Hinglish search, site first", "Amazon par iPhone 17 search karo"],
    ["Hinglish look, site first", "Myntra par shoes dekho"],
    ["Hinglish price check with a longer gap", "Flipkart par laptop ka price check karo"],
    ["search, site last", "Search iPhone 17 on Amazon"],
    ["cost asked on a site", "what is the cost of a Sony headphone on amazon.in"],
    ["price, then a Hinglish site word", "iPhone 17 ka price Amazon par batao"],
    ["price asked of a site", "Flipkart par iPhone 17 ka price kya hai"],
  ] as const;

  it.each(ASKED)("is true for %s", (_label, message) => {
    expect(looksLikeBrowsingRequest(message)).toBe(true);
  });

  it.each(ASKED)("is ranked to the Browser Agent first, before any general answer: %s", (_label, message) => {
    expect(rankAgentCandidates(message)[0]?.agentId).toBe(AGENT_IDS.browser);
  });

  it.each([
    ["Amazon Ads strategy", "Amazon Ads campaign strategy batao"],
    ["Amazon Web Services", "Tell me about Amazon Web Services"],
    ["a business-model question", "Flipkart business model explain karo"],
    ["the company's stock price", "Amazon stock price today"],
    ["the company's share price", "Flipkart ka share price kya hai"],
    ["a price with no shop", "Price of iPhone 17 kitna hai"],
    ["a shop mentioned in passing", "I bought a phone on Flipkart last year"],
    ["a story about a shop", "Flipkart par mera order late aaya, kya karun"],
  ])("is false for %s", (_label, message) => {
    expect(looksLikeBrowsingRequest(message)).toBe(false);
  });

  it.each([
    "Price of iPhone 17 on Flipkart",
    "Amazon par iPhone 17 search karo",
    "Myntra par shoes dekho",
    "Flipkart par laptop ka price check karo",
    "Search iPhone 17 on Amazon",
  ])("is not read as a time or a schedule: %s", (message) => {
    expect(parseSchedulePhrase(message)).toBeNull();
    expect(["SCHEDULE", "NEEDS_TIME"]).not.toContain(detectWorkRequest(message).type);
  });

  it("still schedules a named time beside a shop", () => {
    expect(parseSchedulePhrase("Flipkart par laptop ka price check karo kal 10 baje")).not.toBeNull();
  });

  it("is answered with the server's reason, by no model, where there is no Browser Agent", async () => {
    const { say, general } = world({ reason: REASON });
    const reply = await say("Price of iPhone 17 on Flipkart");
    expect(reply.data?.message).toBe(REASON);
    expect(general.requests).toHaveLength(0);
  });
});

describe("the Browser Agent's prompt, for a product price", () => {
  const prompt = (): string => {
    const agent = new BrowserAgent({ provider: new AnsweringModel("p") }) as unknown as { providerSystemPrompt: string };
    return agent.providerSystemPrompt;
  };

  it("gives an address and a search address for every site it can name", () => {
    for (const site of KNOWN_SITES) {
      expect(prompt(), site.id).toContain(site.home);
      if (site.search) expect(prompt(), site.id).toContain(site.search);
    }
  });

  it("asks for the displayed price, currency, availability and source, and forbids inventing them", () => {
    const text = prompt();
    expect(text).toContain("displayed price");
    expect(text).toContain("currency");
    expect(text).toContain("availability");
    expect(text).toContain("source URL");
    expect(text).toMatch(/never (state|give|guess)[^.]*price[^.]*(memory|guess)/i);
    expect(text).toContain("robot check");
  });
});


// ---------------------------------------------------------------------------
// 1c. A number inside a request is not a time
//
// The reported defect: "iPhone 17" was read as 17:00, so "Amazon kholo aur
// iPhone 17 ka price check karo." was SCHEDULED for the evening and saved as a
// task instead of being done. A time needs "at", a day word, a meridiem, "baje"
// or hh:mm; a stated one still schedules exactly as before.
// ---------------------------------------------------------------------------

describe("a bare number is not a time", () => {
  const NOW = new Date("2026-11-17T06:00:00Z"); // 11:30 IST

  it.each([
    ["the reported sentence", "Amazon kholo aur iPhone 17 ka price check karo."],
    ["a top-N request", "check the top 5 campaigns"],
    ["a model number", "check the Galaxy S24 price on flipkart"],
    ["a quantity", "summarize the last 10 posts"],
  ])("is read as work to do now, not a schedule: %s", (_label, message) => {
    expect(parseSchedulePhrase(message, NOW)).toBeNull();
    expect(detectWorkRequest(message, NOW).type).toBe("EXECUTE");
  });

  it.each([
    ["tomorrow at 10 am check my system status", "at 10 am"],
    ["kal 5 baje check my system status", "5 baje"],
    ["check my system status at 6 pm", "at 6 pm"],
    ["check my system status at 18:30", "at 18:30"],
    ["today at 17 check my system status", "at 17"],
    ["kal 10 check my system status", "10"],
  ])("a stated time still schedules: %s", (message, matched) => {
    const found = detectWorkRequest(message, NOW);
    expect(found.type).toBe("SCHEDULE");
    if (found.type === "SCHEDULE") expect(found.matched).toBe(matched);
  });

  it("finds the stated time even when a bare number comes first", () => {
    const found = detectWorkRequest("check the iPhone 17 price tomorrow at 10 am", NOW);
    expect(found.type).toBe("SCHEDULE");
    if (found.type === "SCHEDULE") expect(found.matched).toBe("at 10 am");
  });
});

// ---------------------------------------------------------------------------
// 2. The orchestrator, with and without a Browser Agent
// ---------------------------------------------------------------------------

const REASON = "Opening web pages is switched off on this test server, so nothing was opened.";
const USER = "user-p19";

class AnsweringModel implements IAIProvider {
  readonly id = "answering";
  readonly name = "answering";
  readonly defaultModel = "answering";
  readonly requests: AICompletionRequest[] = [];
  constructor(private readonly who: string) {}
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    const said = String(request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "");
    return { message: { role: "assistant", content: `${this.who}: ${said}` }, finishReason: "stop", model: this.defaultModel };
  }
  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function world(options: { reason?: string; browserAgent?: boolean }) {
  const general = new AnsweringModel("general");
  const browser = new AnsweringModel("browser");
  const registry = new AgentRegistry({ requirePolicy: true });
  registry.register(new ConversationalAssistant({ provider: general, systemPrompt: "You are JARVIS." }));
  if (options.browserAgent) registry.register(new BrowserAgent({ provider: browser }));
  const audit: AuditEntry[] = [];
  const executor: IToolExecutor = { execute: vi.fn() };
  const orchestrator = new Orchestrator(registry, executor, { log: async (entry: AuditEntry) => void audit.push(entry) } as never, {
    ...(options.reason ? { browsingUnavailableReason: options.reason } : {}),
  });
  const say = (message: string, agentId?: string) =>
    orchestrator.process(
      { message, stream: false, ...(agentId ? { agentId } : {}) },
      { auth: { userId: USER, role: "owner", email: "p19@test.local" }, conversationId: "conv-p19", traceId: "trace-p19" }
    );
  return { say, general, browser, audit, executor };
}

describe("a browsing request on a server with no Browser Agent", () => {
  it("is answered with the server's reason, by no model, and recorded", async () => {
    const { say, general, audit, executor } = world({ reason: REASON });

    const reply = await say("Open https://example.com");

    expect(reply.success).toBe(true);
    expect(reply.data?.message).toBe(REASON);
    expect(general.requests).toHaveLength(0);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(audit.filter((entry) => entry.action === "agent.unavailable")).toEqual([
      expect.objectContaining({ userId: USER, agentId: AGENT_IDS.browser, result: "rejected", traceId: "trace-p19" }),
    ]);
  });

  it("falls through to the general assistant, as before, when the server gave no reason", async () => {
    const { say, general } = world({});

    const reply = await say("Open https://example.com");

    expect(reply.data?.message).toBe("general: Open https://example.com");
    expect(general.requests).toHaveLength(1);
  });

  it("is not answered for a message that only mentions a link", async () => {
    const { say } = world({ reason: REASON });

    const reply = await say("Write a tagline for my site https://example.com");

    expect(reply.data?.message).toBe("general: Write a tagline for my site https://example.com");
  });

  it("is not answered where the router ranks another agent first (an SEO check is marketing's)", async () => {
    const { say } = world({ reason: REASON });
    const message = "Check the SEO of https://example.com";
    // The premise: a browsing request, which the router nonetheless gives to marketing.
    expect(looksLikeBrowsingRequest(message)).toBe(true);
    expect(rankAgentCandidates(message)[0]?.agentId).toBe(AGENT_IDS.marketing);

    const reply = await say(message);

    expect(reply.data?.message).not.toBe(REASON);
  });

  it("is not answered when the client named the agent itself", async () => {
    const { say, general } = world({ reason: REASON });

    const reply = await say("Open https://example.com", AGENT_IDS.general);

    expect(reply.data?.message).toBe("general: Open https://example.com");
    expect(general.requests).toHaveLength(1);
  });
});

describe("a browsing request on a server with a Browser Agent", () => {
  it("reaches the Browser Agent, whatever reason the server was given", async () => {
    const { say, general, browser, audit } = world({ reason: REASON, browserAgent: true });

    const reply = await say("Open https://example.com");

    expect(reply.data?.agentId).toBe(AGENT_IDS.browser);
    expect(reply.data?.message).toBe("browser: Open https://example.com");
    expect(browser.requests).toHaveLength(1);
    expect(general.requests).toHaveLength(0);
    expect(audit.some((entry) => entry.action === "agent.unavailable")).toBe(false);
  });
});
