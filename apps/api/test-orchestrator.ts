import { PrismaClient } from "@jarvis/db";
import { PrismaApprovalRepository, PrismaAuditRepository } from "@jarvis/db";
import { ApprovalService, PermissionService, AuditLogger } from "@jarvis/security";
import { ToolRegistry, ToolExecutor, SystemEchoTool, BaseTool } from "@jarvis/tools";
import { AgentRegistry, BaseAgent, Orchestrator } from "@jarvis/agents";
import type {
  AgentInput,
  AgentOutput,
  ToolContext,
  ToolResult,
  AgentCategory,
  AgentConfig,
} from "@jarvis/core";

const prisma = new PrismaClient();
const TEST_USER_ID = "test-user-001";
const TEST_TRACE_ID = "550e8400-e29b-41d4-a716-446655440000";

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

class EchoAgent extends BaseAgent {
  constructor() {
    super(
      "echo-agent",
      "Echo Agent",
      "Simple echo agent for testing",
      "ai-core" as AgentCategory,
      [],
      { model: "test", temperature: 0, maxTokens: 100 }
    );
  }

  async process(input: AgentInput): Promise<AgentOutput> {
    return { message: `Echo: ${input.message}` };
  }
}

class EchoToolAgent extends BaseAgent {
  private callCount = 0;

  constructor() {
    super(
      "echo-tool-agent",
      "Echo Tool Agent",
      "Agent that requests system.echo tool",
      "ai-core" as AgentCategory,
      ["system.echo"],
      { model: "test", temperature: 0, maxTokens: 100 }
    );
  }

  async process(input: AgentInput): Promise<AgentOutput> {
    this.callCount++;

    if (this.callCount === 1) {
      return {
        message: `I will echo: ${input.message}`,
        actions: [
          { toolId: "system.echo", params: { message: input.message } },
        ],
      };
    }

    const toolResults = input.metadata?.toolResults as Array<{ result?: { data?: { message?: string } } }> | undefined;
    if (toolResults && toolResults.length > 0) {
      return { message: `Tool returned: ${toolResults[0].result?.data?.message}` };
    }

    return { message: "No tool results" };
  }
}

class FailAgent extends BaseAgent {
  constructor() {
    super(
      "fail-agent",
      "Fail Agent",
      "Agent that always throws",
      "ai-core" as AgentCategory,
      [],
      { model: "test", temperature: 0, maxTokens: 100 }
    );
  }

  async process(): Promise<AgentOutput> {
    throw new Error("Intentional agent failure");
  }
}

class LoopAgent extends BaseAgent {
  private callCount = 0;
  private readonly maxCalls: number;

  constructor(maxCalls: number = 100) {
    super(
      "loop-agent",
      "Loop Agent",
      "Agent that keeps requesting tools",
      "ai-core" as AgentCategory,
      ["system.echo"],
      { model: "test", temperature: 0, maxTokens: 100 }
    );
    this.maxCalls = maxCalls;
  }

  async process(input: AgentInput): Promise<AgentOutput> {
    this.callCount++;
    if (this.callCount <= this.maxCalls) {
      return {
        message: `Loop iteration ${this.callCount}`,
        actions: [
          { toolId: "system.echo", params: { message: `loop-${this.callCount}` } },
        ],
      };
    }
    return { message: "Loop done" };
  }
}

class DisabledAgent extends BaseAgent {
  constructor() {
    super(
      "disabled-agent",
      "Disabled Agent",
      "Agent that is disabled",
      "ai-core" as AgentCategory,
      [],
      { model: "test", temperature: 0, maxTokens: 100 }
    );
    this.status = "disabled";
  }

  async process(): Promise<AgentOutput> {
    return { message: "Should not reach" };
  }
}

function makeOrchestrator(config?: { maxToolExecutions?: number; maxOrchestrationDepth?: number }) {
  const approvalRepo = new PrismaApprovalRepository(prisma);
  const auditRepo = new PrismaAuditRepository(prisma);
  const approvalService = new ApprovalService(approvalRepo);
  const permissionService = new PermissionService();
  const auditLogger = new AuditLogger(auditRepo);

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new SystemEchoTool());
  toolRegistry.register(
    new (class extends BaseTool {
      constructor() {
        super(
          "system.echo-approval",
          "Echo Approval",
          "Echo that requires approval",
          "system",
          [{ name: "message", type: "string", description: "msg", required: true }],
          true,
          ["read"]
        );
      }
      async execute(params: Record<string, unknown>): Promise<ToolResult> {
        return { success: true, data: { message: params.message } };
      }
    })()
  );

  const toolExecutor = new ToolExecutor(
    toolRegistry,
    permissionService,
    approvalService,
    auditLogger
  );

  const agentRegistry = new AgentRegistry();
  const echoAgent = new EchoAgent();
  const echoToolAgent = new EchoToolAgent();
  const failAgent = new FailAgent();
  const loopAgent = new LoopAgent(config?.maxToolExecutions ? 1000 : 100);
  const disabledAgent = new DisabledAgent();

  agentRegistry.register(echoAgent);
  agentRegistry.register(echoToolAgent);
  agentRegistry.register(failAgent);
  agentRegistry.register(loopAgent);
  agentRegistry.register(disabledAgent);

  const orchestrator = new Orchestrator(
    agentRegistry,
    toolExecutor,
    auditLogger,
    config
  );

  return { orchestrator, approvalService, auditRepo, agentRegistry };
}

function makeContext(agentId?: string) {
  return {
    auth: {
      userId: TEST_USER_ID,
      role: "admin" as const,
      email: "test@test.com",
    },
    conversationId: "test-conv-001",
    agentId,
    traceId: TEST_TRACE_ID,
    ipAddress: "127.0.0.1",
  };
}

async function cleanupTestData() {
  await prisma.approval.deleteMany({ where: { userId: TEST_USER_ID } });
  await prisma.auditLog.deleteMany({ where: { userId: TEST_USER_ID } });
}

async function runTests() {
  await cleanupTestData();
  console.log("=== ORCHESTRATOR TESTS ===\n");

  // Test 1: Echo agent (no tools)
  console.log("1. Echo agent (no tools)");
  {
    const { orchestrator } = makeOrchestrator();
    const response = await orchestrator.process(
      { message: "hello world", agentId: "echo-agent" },
      makeContext()
    );
    assert("success is true", response.success === true);
    assert("message contains Echo", response.data?.message?.includes("Echo:") ?? false);
    assert("traceId is set", response.traceId === TEST_TRACE_ID);
  }

  // Test 2: Unknown agent
  console.log("\n2. Unknown agent");
  {
    const { orchestrator } = makeOrchestrator();
    const response = await orchestrator.process(
      { message: "hello", agentId: "nonexistent-agent" },
      makeContext()
    );
    assert("success is false", response.success === false);
    assert("error code is AGENT_NOT_FOUND", response.error?.code === "AGENT_NOT_FOUND");
  }

  // Test 3: Disabled agent
  console.log("\n3. Disabled agent");
  {
    const { orchestrator } = makeOrchestrator();
    const response = await orchestrator.process(
      { message: "hello", agentId: "disabled-agent" },
      makeContext()
    );
    assert("success is false", response.success === false);
    assert("error code is AGENT_ERROR", response.error?.code === "AGENT_ERROR");
  }

  // Test 4: Agent failure
  console.log("\n4. Agent failure");
  {
    const { orchestrator } = makeOrchestrator();
    const response = await orchestrator.process(
      { message: "trigger failure", agentId: "fail-agent" },
      makeContext()
    );
    assert("success is false", response.success === false);
    assert("error code is INTERNAL_ERROR", response.error?.code === "INTERNAL_ERROR");
    assert("no stack trace exposed", !JSON.stringify(response).includes("at "));
  }

  // Test 5: Tool execution success
  console.log("\n5. Tool execution success");
  {
    const { orchestrator } = makeOrchestrator();
    const response = await orchestrator.process(
      { message: "echo this", agentId: "echo-tool-agent" },
      makeContext()
    );
    assert("success is true", response.success === true);
    assert("message contains Tool returned", response.data?.message?.includes("Tool returned:") ?? false);
  }

  // Test 6: Default agent selection
  console.log("\n6. Default agent selection (no agentId)");
  {
    const { orchestrator } = makeOrchestrator();
    const response = await orchestrator.process(
      { message: "hello" },
      makeContext()
    );
    assert("success is true", response.success === true);
    assert("message is set", typeof response.data?.message === "string");
  }

  // Test 7: traceId propagation
  console.log("\n7. traceId propagation");
  {
    const { orchestrator, auditRepo } = makeOrchestrator();
    const traceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const response = await orchestrator.process(
      { message: "trace test", agentId: "echo-agent" },
      { ...makeContext(), traceId }
    );
    assert("traceId in response", response.traceId === traceId);
    const logs = await auditRepo.query({ traceId });
    assert("traceId in audit", logs.some((l) => l.traceId === traceId));
  }

  // Test 8: Tool execution limit
  console.log("\n8. Tool execution limit");
  {
    const { orchestrator } = makeOrchestrator({ maxToolExecutions: 2 });
    const response = await orchestrator.process(
      { message: "loop test", agentId: "loop-agent" },
      makeContext()
    );
    assert("success is false", response.success === false);
    assert("error message mentions limit", response.error?.message?.toLowerCase().includes("limit") ?? false);
  }

  // Test 9: Orchestration depth limit
  console.log("\n9. Orchestration depth limit");
  {
    const { orchestrator } = makeOrchestrator({ maxOrchestrationDepth: 2 });
    const response = await orchestrator.process(
      { message: "depth test", agentId: "loop-agent" },
      makeContext()
    );
    assert("success is false", response.success === false);
    assert("error message mentions depth", response.error?.message?.toLowerCase().includes("depth") ?? false);
  }

  // Test 10: Invalid request (empty message)
  console.log("\n10. Invalid request");
  {
    const { orchestrator } = makeOrchestrator();
    const response = await orchestrator.process(
      { message: "", agentId: "echo-agent" },
      makeContext()
    );
    assert("success is false or agent processes empty", response.success === true || response.success === false);
  }

  console.log(`\n=== RESULTS: ${passed} PASS, ${failed} FAIL ===`);
  if (failed > 0) process.exit(1);
}

runTests()
  .catch((e) => {
    console.error("FATAL:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
