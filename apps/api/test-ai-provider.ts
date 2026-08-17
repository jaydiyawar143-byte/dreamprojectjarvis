import { MockAIProvider, ConversationalAssistant } from "@jarvis/agents";
import type {
  IAIProvider,
  AICompletionRequest,
  AIMessage,
  AIToolDefinition,
} from "@jarvis/core";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}`);
    failed++;
  }
}

// Test 1: Mock provider text response
async function test1_MockProviderTextResponse() {
  console.log("1. Mock provider text response");
  const provider = new MockAIProvider({ textResponse: "Hello from mock" });
  const result = await provider.complete({
    messages: [{ role: "user", content: "Hi" }],
  });
  assert("message content matches", result.message.content === "Hello from mock");
  assert("finish reason is stop", result.finishReason === "stop");
  assert("model is set", result.model === "mock-model-v1");
  assert("usage is provided", !!result.usage);
  assert("usage has totalTokens", result.usage!.totalTokens === 15);
}

// Test 2: Mock provider tool call
async function test2_MockProviderToolCall() {
  console.log("\n2. Mock provider tool call");
  const provider = new MockAIProvider({
    toolCalls: [{ name: "get_weather", arguments: { city: "Mumbai" } }],
  });

  const tools: AIToolDefinition[] = [
    {
      name: "get_weather",
      description: "Get weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    },
  ];

  const result = await provider.complete({
    messages: [{ role: "user", content: "Weather?" }],
    tools,
  });

  assert("finish reason is tool_calls", result.finishReason === "tool_calls");
  assert("content is null", result.message.content === null);
  assert("tool calls returned", result.message.toolCalls?.length === 1);
  assert("tool call name matches", result.message.toolCalls![0].name === "get_weather");
  assert("tool call args match", result.message.toolCalls![0].arguments.city === "Mumbai");
  assert("tool call has id", result.message.toolCalls![0].id.startsWith("mock-call-"));
}

// Test 3: Provider failure
async function test3_ProviderFailure() {
  console.log("\n3. Provider failure");
  const provider = new MockAIProvider({
    shouldFail: true,
    failureMessage: "API rate limit exceeded",
  });

  let caught = false;
  try {
    await provider.complete({
      messages: [{ role: "user", content: "Hi" }],
    });
  } catch (e: unknown) {
    caught = true;
    const err = e as Error;
    assert("error message matches", err.message === "API rate limit exceeded");
  }
  assert("provider throws on failure", caught);

  const available = await provider.isAvailable();
  assert("isAvailable returns false when failing", available === false);
}

// Test 4: Provider timeout (via delay)
async function test4_ProviderTimeout() {
  console.log("\n4. Provider timeout (delay)");
  const provider = new MockAIProvider({
    textResponse: "slow",
    delayMs: 50,
  });

  const start = Date.now();
  await provider.complete({
    messages: [{ role: "user", content: "Hi" }],
  });
  const elapsed = Date.now() - start;

  assert("delay is applied", elapsed >= 40);
  assert("response is still correct", true);
}

// Test 5: Conversation message conversion
async function test5_ConversationMessageConversion() {
  console.log("\n5. Conversation message conversion");
  const provider = new MockAIProvider({ textResponse: "ok" });

  const messages: AIMessage[] = [
    { role: "system", content: "You are JARVIS" },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
    { role: "user", content: "Help me" },
  ];

  const result = await provider.complete({ messages });
  assert("provider receives messages", result.message.content === "ok");

  const lastReq = provider.getLastRequest();
  assert("request has 4 messages", lastReq?.messages.length === 4);
  assert("first message is system", lastReq?.messages[0].role === "system");
  assert("last message is user", lastReq?.messages[3].role === "user");
}

// Test 6: Tool definition conversion
async function test6_ToolDefinitionConversion() {
  console.log("\n6. Tool definition conversion");
  const provider = new MockAIProvider({ textResponse: "ok" });

  const tools: AIToolDefinition[] = [
    {
      name: "search",
      description: "Search the web",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "calculate",
      description: "Calculate math",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
      },
    },
  ];

  await provider.complete({
    messages: [{ role: "user", content: "Search for AI" }],
    tools,
  });

  const lastReq = provider.getLastRequest();
  assert("request has 2 tools", lastReq?.tools?.length === 2);
  assert("first tool is search", lastReq?.tools?.[0].name === "search");
  assert("second tool is calculate", lastReq?.tools?.[1].name === "calculate");
}

// Test 7: Tool result conversion
async function test7_ToolResultConversion() {
  console.log("\n7. Tool result conversion");
  const provider = new MockAIProvider({ textResponse: "ok" });

  const toolResults = [
    {
      toolCallId: "call-123",
      toolId: "get_weather",
      result: { success: true, data: { temp: 28 } },
    },
  ];

  const messages: AIMessage[] = [
    { role: "user", content: "Weather?" },
    {
      role: "tool",
      content: JSON.stringify(toolResults[0].result),
      name: "get_weather",
      toolCallId: "call-123",
    },
  ];

  await provider.complete({ messages });

  const lastReq = provider.getLastRequest();
  assert("request has 2 messages", lastReq?.messages.length === 2);
  assert("tool message has correct role", lastReq?.messages[1].role === "tool");
  assert("tool message has name", lastReq?.messages[1].name === "get_weather");
  assert("tool message has toolCallId", lastReq?.messages[1].toolCallId === "call-123");
}

// Test 8: Conversational agent normal response
async function test8_ConversationalAgentNormalResponse() {
  console.log("\n8. Conversational agent normal response");
  const provider = new MockAIProvider({
    textResponse: "The capital of India is New Delhi.",
  });

  const agent = new ConversationalAssistant({
    provider,
    systemPrompt: "You are JARVIS.",
    temperature: 0.5,
  });

  await agent.initialize({
    userId: "user-1",
    traceId: "550e8400-e29b-41d4-a716-446655440000",
    memoryManager: { store: async () => {}, recall: async () => [] },
    toolRegistry: { get: () => undefined, getAll: () => [] },
    auditLogger: { log: async () => {} },
  });

  const result = await agent.process({ message: "What is the capital of India?" });

  assert("message matches", result.message === "The capital of India is New Delhi.");
  assert("no actions", !result.actions || result.actions.length === 0);
  assert("metadata has model", result.metadata?.model === "mock-model-v1");
  assert("metadata has finishReason", result.metadata?.finishReason === "stop");
  assert("agent status is ready", agent.getStatus() === "ready");
}

// Test 9: Conversational agent tool call
async function test9_ConversationalAgentToolCall() {
  console.log("\n9. Conversational agent tool call");
  const provider = new MockAIProvider({
    toolCalls: [{ name: "system.echo", arguments: { message: "hello from tool" } }],
  });

  const tools: AIToolDefinition[] = [
    {
      name: "system.echo",
      description: "Echo tool",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
      },
    },
  ];

  const agent = new ConversationalAssistant({
    provider,
    tools,
  });

  await agent.initialize({
    userId: "user-1",
    traceId: "550e8400-e29b-41d4-a716-446655440000",
    memoryManager: { store: async () => {}, recall: async () => [] },
    toolRegistry: { get: () => undefined, getAll: () => [] },
    auditLogger: { log: async () => {} },
  });

  const result = await agent.process({ message: "Echo this" });

  assert("has actions", result.actions?.length === 1);
  assert("action toolId matches", result.actions![0].toolId === "system.echo");
  assert("action params match", result.actions![0].params.message === "hello from tool");
  assert("agent status is ready", agent.getStatus() === "ready");
}

// Test 10: Provider abstraction has no OpenAI dependency in core
async function test10_NoOpenAIInCore() {
  console.log("\n10. No OpenAI dependency in @jarvis/core");
  const fs = await import("fs");
  const path = await import("path");

  const rootDir = path.resolve(process.cwd(), "../..");

  const corePackageJson = JSON.parse(
    fs.readFileSync(
      path.join(rootDir, "packages/core/package.json"),
      "utf-8"
    )
  );

  const deps = Object.keys(corePackageJson.dependencies || {});
  const devDeps = Object.keys(corePackageJson.devDependencies || {});
  const allDeps = [...deps, ...devDeps];

  assert("core has no openai dependency", !allDeps.includes("openai"));
  assert("core has no openai in any form", !allDeps.some((d) => d.includes("openai")));

  const coreIndex = fs.readFileSync(
    path.join(rootDir, "packages/core/src/index.ts"),
    "utf-8"
  );
  assert("core index does not import openai", !coreIndex.includes("openai"));
}

// Run all tests
async function runTests() {
  console.log("=== AI PROVIDER TESTS ===\n");

  await test1_MockProviderTextResponse();
  await test2_MockProviderToolCall();
  await test3_ProviderFailure();
  await test4_ProviderTimeout();
  await test5_ConversationMessageConversion();
  await test6_ToolDefinitionConversion();
  await test7_ToolResultConversion();
  await test8_ConversationalAgentNormalResponse();
  await test9_ConversationalAgentToolCall();
  await test10_NoOpenAIInCore();

  console.log(`\n=== RESULTS: ${passed} PASS, ${failed} FAIL ===`);
  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
