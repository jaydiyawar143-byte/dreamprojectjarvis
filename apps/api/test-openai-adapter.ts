import type {
  AIMessage,
  AIToolDefinition,
  AICompletionResponse,
} from "@jarvis/core";
import {
  convertMessages,
  convertTools,
  convertResponse,
  classifyOpenAIError,
  calculateRetryDelay,
  toJarvisError,
  executeWithRetry,
} from "@jarvis/ai-openai";
import type { OpenAICompletionResponse } from "@jarvis/ai-openai";

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

// Test 1: Text response conversion
async function test1_TextResponseConversion() {
  console.log("1. Text response conversion");
  const openaiResponse: OpenAICompletionResponse = {
    id: "chatcmpl-123",
    object: "chat.completion",
    created: 1234567890,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello! How can I help you?",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 8,
      total_tokens: 18,
    },
  };

  const result = convertResponse(openaiResponse, "req-123");

  assert("message content matches", result.message.content === "Hello! How can I help you?");
  assert("finish reason is stop", result.finishReason === "stop");
  assert("model matches", result.model === "gpt-4o");
  assert("requestId propagated", result.requestId === "req-123");
  assert("usage promptTokens", result.usage?.promptTokens === 10);
  assert("usage completionTokens", result.usage?.completionTokens === 8);
  assert("usage totalTokens", result.usage?.totalTokens === 18);
  assert("no tool calls", !result.message.toolCalls);
}

// Test 2: Tool-call response conversion
async function test2_ToolCallResponseConversion() {
  console.log("\n2. Tool-call response conversion");
  const openaiResponse: OpenAICompletionResponse = {
    id: "chatcmpl-456",
    object: "chat.completion",
    created: 1234567890,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-abc",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Mumbai","unit":"celsius"}',
              },
            },
            {
              id: "call-def",
              type: "function",
              function: {
                name: "get_time",
                arguments: '{"timezone":"IST"}',
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };

  const result = convertResponse(openaiResponse);

  assert("finish reason is tool_calls", result.finishReason === "tool_calls");
  assert("content is null", result.message.content === null);
  assert("two tool calls", result.message.toolCalls?.length === 2);
  assert("first tool call id", result.message.toolCalls![0].id === "call-abc");
  assert("first tool call name", result.message.toolCalls![0].name === "get_weather");
  assert("first tool call args parsed", result.message.toolCalls![0].arguments.city === "Mumbai");
  assert("second tool call id", result.message.toolCalls![1].id === "call-def");
  assert("second tool call name", result.message.toolCalls![1].name === "get_time");
  assert("second tool call args parsed", result.message.toolCalls![1].arguments.timezone === "IST");
}

// Test 3: System/user/assistant/tool message conversion
async function test3_MessageConversion() {
  console.log("\n3. Message conversion");
  const messages: AIMessage[] = [
    { role: "system", content: "You are JARVIS" },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
    {
      role: "tool",
      content: '{"temp":28}',
      name: "get_weather",
      toolCallId: "call-123",
    },
  ];

  const converted = convertMessages(messages);

  assert("4 messages", converted.length === 4);
  assert("system role", converted[0].role === "system");
  assert("system content", converted[0].content === "You are JARVIS");
  assert("user role", converted[1].role === "user");
  assert("user content", converted[1].content === "Hello");
  assert("assistant role", converted[2].role === "assistant");
  assert("assistant content", converted[2].content === "Hi there");
  assert("tool role", converted[3].role === "tool");
  assert("tool content", converted[3].content === '{"temp":28}');
  assert("tool name", converted[3].name === "get_weather");
  assert("tool tool_call_id", converted[3].tool_call_id === "call-123");
}

// Test 4: Tool definitions conversion
async function test4_ToolDefinitionConversion() {
  console.log("\n4. Tool definitions conversion");
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
  ];

  const converted = convertTools(tools);

  assert("1 tool", converted.length === 1);
  assert("type is function", converted[0].type === "function");
  assert("function name", converted[0].function.name === "search");
  assert("function description", converted[0].function.description === "Search the web");
  assert("function parameters", converted[0].function.parameters.type === "object");
}

// Test 5: Usage metadata conversion
async function test5_UsageMetadataConversion() {
  console.log("\n5. Usage metadata conversion");
  const response: OpenAICompletionResponse = {
    id: "chatcmpl-789",
    object: "chat.completion",
    created: 1234567890,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };

  const result = convertResponse(response);

  assert("promptTokens", result.usage?.promptTokens === 100);
  assert("completionTokens", result.usage?.completionTokens === 50);
  assert("totalTokens", result.usage?.totalTokens === 150);
}

// Test 6: Model configuration
async function test6_ModelConfiguration() {
  console.log("\n6. Model configuration");
  const response: OpenAICompletionResponse = {
    id: "chatcmpl-model",
    object: "chat.completion",
    created: 1234567890,
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  };

  const result = convertResponse(response);
  assert("model from response", result.model === "gpt-4o-mini");
}

// Test 7: Finish reason mapping (all values)
async function test7_FinishReasonMapping() {
  console.log("\n7. Finish reason mapping");

  const makeResponse = (reason: string | null): OpenAICompletionResponse => ({
    id: "chatcmpl-fr",
    object: "chat.completion",
    created: 1234567890,
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: reason }],
  });

  assert("stop → stop", convertResponse(makeResponse("stop")).finishReason === "stop");
  assert("tool_calls → tool_calls", convertResponse(makeResponse("tool_calls")).finishReason === "tool_calls");
  assert("length → length", convertResponse(makeResponse("length")).finishReason === "length");
  assert("content_filter → content_filter", convertResponse(makeResponse("content_filter")).finishReason === "content_filter");
  assert("null → stop (default)", convertResponse(makeResponse(null)).finishReason === "stop");
  assert("unknown → stop (default)", convertResponse(makeResponse("unknown")).finishReason === "stop");
}

// Test 8: Authentication error mapping
async function test8_AuthenticationErrorMapping() {
  console.log("\n8. Authentication error mapping");
  const error = { status: 401, message: "Invalid API key" };
  const classified = classifyOpenAIError(error);

  assert("code is AUTHENTICATION_REQUIRED", classified.code === "AUTHENTICATION_REQUIRED");
  assert("not retryable", classified.retryable === false);
}

// Test 9: Rate-limit error mapping
async function test9_RateLimitErrorMapping() {
  console.log("\n9. Rate-limit error mapping");
  const error = { status: 429, message: "Rate limit exceeded" };
  const classified = classifyOpenAIError(error);

  assert("code is RATE_LIMITED", classified.code === "RATE_LIMITED");
  assert("retryable", classified.retryable === true);
}

// Test 10: Transient provider error handling
async function test10_TransientErrorHandling() {
  console.log("\n10. Transient error handling");
  const error500 = { status: 500, message: "Internal server error" };
  const error502 = { status: 502, message: "Bad gateway" };
  const error503 = { status: 503, message: "Service unavailable" };
  const error408 = { status: 408, message: "Timeout" };

  assert("500 retryable", classifyOpenAIError(error500).retryable === true);
  assert("502 retryable", classifyOpenAIError(error502).retryable === true);
  assert("503 retryable", classifyOpenAIError(error503).retryable === true);
  assert("408 retryable", classifyOpenAIError(error408).retryable === true);
}

// Test 11: Invalid provider response handling
async function test11_InvalidResponseHandling() {
  console.log("\n11. Invalid response handling");
  const error = { status: 400, message: "Invalid request" };
  const classified = classifyOpenAIError(error);

  assert("code is INVALID_REQUEST", classified.code === "INVALID_REQUEST");
  assert("not retryable", classified.retryable === false);

  const permError = { status: 403, message: "Forbidden" };
  const permClassified = classifyOpenAIError(permError);
  assert("403 code is AUTHORIZATION_FAILED", permClassified.code === "AUTHORIZATION_FAILED");
  assert("403 not retryable", permClassified.retryable === false);
}

// Test 12: No secret leakage
async function test12_NoSecretLeakage() {
  console.log("\n12. No secret leakage");
  const errorWithKey = {
    status: 401,
    message: "Invalid API key sk-abc123def456ghi789",
    error: { message: "Authentication failed with key sk-test-secret-key-here" },
  };

  const classified = classifyOpenAIError(errorWithKey);

  assert("API key redacted from message", !classified.message.includes("sk-abc123"));
  assert("secret key redacted", !classified.message.includes("sk-test-secret"));
  assert("message is sanitized", classified.message.includes("[REDACTED]"));
}

// Test 13: Missing API key configuration failure
async function test13_MissingAPIKey() {
  console.log("\n13. Missing API key configuration");
  const originalEnv = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  let caught = false;
  try {
    const { OpenAIAdapter } = await import("@jarvis/ai-openai");
    new OpenAIAdapter({});
  } catch (e: unknown) {
    caught = true;
    const err = e as { code?: string; message?: string };
    assert("error code is INVALID_REQUEST", err.code === "INVALID_REQUEST");
    assert("message mentions API key", err.message?.includes("API key") ?? false);
  } finally {
    if (originalEnv) process.env.OPENAI_API_KEY = originalEnv;
  }
  assert("throws on missing key", caught);
}

// Test 14: Provider availability and retry behavior
async function test14_ProviderAvailabilityAndRetry() {
  console.log("\n14. Retry behavior");

  let callCount = 0;
  const mockFn = async () => {
    callCount++;
    if (callCount < 3) {
      throw { status: 429, message: "Rate limited" };
    }
    return "success";
  };

  const result = await executeWithRetry(mockFn, 2);
  assert("retry succeeded after 2 failures", result === "success");
  assert("called 3 times", callCount === 3);

  let authCallCount = 0;
  const authFn = async () => {
    authCallCount++;
    throw { status: 401, message: "Invalid key" };
  };

  try {
    await executeWithRetry(authFn, 2);
  } catch {
    // expected
  }
  assert("auth error not retried", authCallCount === 1);
}

// Run all tests
async function runTests() {
  console.log("=== OPENAI ADAPTER TESTS ===\n");

  await test1_TextResponseConversion();
  await test2_ToolCallResponseConversion();
  await test3_MessageConversion();
  await test4_ToolDefinitionConversion();
  await test5_UsageMetadataConversion();
  await test6_ModelConfiguration();
  await test7_FinishReasonMapping();
  await test8_AuthenticationErrorMapping();
  await test9_RateLimitErrorMapping();
  await test10_TransientErrorHandling();
  await test11_InvalidResponseHandling();
  await test12_NoSecretLeakage();
  await test13_MissingAPIKey();
  await test14_ProviderAvailabilityAndRetry();

  console.log(`\n=== RESULTS: ${passed} PASS, ${failed} FAIL ===`);
  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
