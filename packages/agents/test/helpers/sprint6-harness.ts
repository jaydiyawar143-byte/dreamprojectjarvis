// ---------------------------------------------------------------------------
// Shared fixtures for the Sprint 6 suites.
//
// Everything here is a fake. No Meta, Google, WhatsApp or n8n credential is
// read, and no network call is possible: the AI provider is scripted, the tools
// are in-memory, and the repositories are arrays. A test that needed a real
// secret would be testing the vendor, not this code.
// ---------------------------------------------------------------------------

import type {
  AICompletionRequest,
  AICompletionResponse,
  AuditEntry,
  IAIProvider,
  IToolExecutor,
  ITool,
  Role,
  SessionContext,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolPermission,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// AI provider
// ---------------------------------------------------------------------------

export class ScriptedAIProvider implements IAIProvider {
  readonly id = "scripted-ai";
  readonly name = "Scripted AI";
  readonly defaultModel = "scripted-model";

  private queue: AICompletionResponse[] = [];
  private fallback: AICompletionResponse = {
    message: { role: "assistant", content: "ok" },
    finishReason: "stop",
    model: "scripted-model",
  };
  readonly requests: AICompletionRequest[] = [];

  /** Queue one response per upcoming `complete` call, in order. */
  push(...responses: AICompletionResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  /** Queue a turn in which the model asks for one tool. */
  pushToolCall(name: string, args: Record<string, unknown> = {}, id = "call-1"): this {
    return this.push({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id, name, arguments: args }],
      },
      finishReason: "tool_calls",
      model: "scripted-model",
    });
  }

  pushText(content: string): this {
    return this.push({
      message: { role: "assistant", content },
      finishReason: "stop",
      model: "scripted-model",
    });
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    return this.queue.shift() ?? this.fallback;
  }

  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  /** The system prompt of the most recent completion. */
  lastSystemPrompt(): string {
    const last = this.requests[this.requests.length - 1];
    return last?.messages.find((m) => m.role === "system")?.content ?? "";
  }

  /** Tool names offered to the model on the most recent completion. */
  lastOfferedTools(): string[] {
    const last = this.requests[this.requests.length - 1];
    return (last?.tools ?? []).map((t) => t.name);
  }
}

/** A provider that always throws, for provider-failure paths. */
export class FailingAIProvider implements IAIProvider {
  readonly id = "failing-ai";
  readonly name = "Failing AI";
  readonly defaultModel = "failing-model";

  constructor(private message = "AI provider unavailable") {}

  async complete(): Promise<AICompletionResponse> {
    throw new Error(this.message);
  }
  async listModels(): Promise<string[]> {
    return [];
  }
  async isAvailable(): Promise<boolean> {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface FakeToolOptions extends Partial<ITool> {
  id: string;
}

export function fakeTool(options: FakeToolOptions): ITool {
  return {
    id: options.id,
    name: options.name ?? options.id,
    description: options.description ?? `Tool ${options.id}`,
    category: options.category ?? "system",
    risk: options.risk ?? "READ_ONLY",
    parameters: options.parameters ?? [],
    requiresApproval: options.requiresApproval ?? false,
    requiredPermissions: options.requiredPermissions ?? (["read"] as ToolPermission[]),
    version: options.version ?? "1.0.0",
    enabled: options.enabled ?? true,
    execute:
      options.execute ??
      (async () => ({ success: true, data: { ok: true, tool: options.id } })),
    validate: options.validate ?? (() => true),
  };
}

/** The tools a fully configured deployment registers, as fakes. */
export function productionLikeTools(): ITool[] {
  const read = (id: string) => fakeTool({ id, risk: "READ_ONLY" });
  const write = (id: string) =>
    fakeTool({
      id,
      risk: "EXTERNAL_SIDE_EFFECT",
      requiresApproval: true,
      requiredPermissions: ["read", "write"],
    });

  return [
    read("meta.accounts"),
    read("meta.campaigns"),
    read("meta.adsets"),
    read("meta.ads"),
    read("meta.insights"),
    read("meta.analyze"),
    write("meta.campaign.pause"),
    write("meta.campaign.resume"),
    write("meta.adset.pause"),
    write("meta.adset.resume"),
    write("meta.ad.pause"),
    write("meta.ad.resume"),
    write("meta.campaign.budget.update"),
    write("meta.adset.budget.update"),
    write("meta.campaign.create"),
    read("google.accounts"),
    read("google.campaigns"),
    read("google.insights"),
    write("whatsapp.send"),
    write("n8n.trigger"),
    read("data.csv.analyze"),
    // Integration management. The reads and the own-store writes are
    // unapproved; only `integration.disconnect` is modelled as an external side
    // effect, because it revokes a token at the provider and cannot be undone
    // from inside JARVIS.
    read("integration.list"),
    read("integration.status"),
    read("integration.health"),
    read("integration.permissions"),
    read("integration.audit"),
    read("integration.test"),
    read("integration.validate"),
    read("integration.connect"),
    read("integration.configure"),
    read("integration.reconnect"),
    read("integration.enable"),
    read("integration.disable"),
    write("integration.disconnect"),
    // Capability discovery. All READ_ONLY: asking what you can do changes
    // nothing, and none of these can execute what they describe.
    read("capabilities.list"),
    read("capabilities.connected"),
    read("capabilities.integration"),
    read("capabilities.permissions"),
    // Phase 12 — real Gmail, Drive and Calendar reads. All READ_ONLY: there is
    // no write tool in this group and no write scope behind it.
    read("gmail.listUnread"),
    read("gmail.search"),
    read("gmail.getMessage"),
    read("gmail.getThread"),
    read("drive.searchFiles"),
    read("drive.listRecentFiles"),
    read("drive.getFileMetadata"),
    read("calendar.listUpcomingEvents"),
    read("calendar.getEvent"),
    // Phase 13 — write PLANNING. LOW_IMPACT and unapproved at the tool layer,
    // because planning writes nothing outside JARVIS: it creates a pending
    // approval row and stops. Execution is not a tool at all.
    read("google.plan.gmail.createDraft"),
    read("google.plan.gmail.updateDraft"),
    read("google.plan.gmail.sendDraft"),
    read("google.plan.drive.createFolder"),
    read("google.plan.drive.uploadFile"),
    read("google.plan.drive.moveFile"),
    read("google.plan.drive.renameFile"),
    read("google.plan.calendar.createEvent"),
    read("google.plan.calendar.updateEvent"),
    read("google.plan.calendar.deleteEvent"),
    // Sprint 7 — browser. The four reads are open; the six actions are all
    // approval-gated, which is what `write()` models here.
    read("browser.navigate"),
    read("browser.inspect"),
    read("browser.extract"),
    read("browser.screenshot"),
    write("browser.click"),
    write("browser.type"),
    write("browser.select"),
    write("browser.download"),
    write("browser.submit"),
    write("browser.upload"),
    // Maps. All READ_ONLY — a map query changes nothing anywhere.
    read("maps.search"),
    read("maps.nearby"),
    read("maps.geocode"),
    read("maps.reverse.geocode"),
    read("maps.current.location"),
    read("maps.route"),
    read("maps.distance"),
    read("maps.place"),
    // Ambient. All READ_ONLY: these read the weather, a market price and this
    // machine's own telemetry, and none of them can write, spend or reach
    // anything the user's dashboard could not already see.
    read("weather.current"),
    read("market.quote"),
    read("system.status"),
    read("time.now"),
    read("tasks.list"),
  ];
}

export function toolRegistryOf(tools: ITool[]) {
  const map = new Map(tools.map((t) => [t.id, t]));
  return {
    get: (id: string) => map.get(id),
    getAll: () => [...map.values()],
  };
}

// ---------------------------------------------------------------------------
// Executor, audit, permissions
// ---------------------------------------------------------------------------

export class RecordingToolExecutor implements IToolExecutor {
  readonly requests: ToolExecutionRequest[] = [];

  constructor(private registry?: { get(id: string): ITool | undefined }) {}

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    this.requests.push(request);
    const tool = this.registry?.get(request.toolId);
    const result = tool
      ? await tool.execute(request.params, { userId: request.userId })
      : { success: false, error: `Unknown tool ${request.toolId}` };

    return {
      executionId: request.executionId ?? "exec-1",
      toolId: request.toolId,
      toolCallId: request.toolCallId,
      status: result.success ? "completed" : "failed",
      result,
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 1,
    };
  }

  toolIds(): string[] {
    return this.requests.map((r) => r.toolId);
  }
}

export class RecordingAuditLogger {
  readonly entries: Array<Omit<AuditEntry, "id" | "timestamp">> = [];

  async log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void> {
    this.entries.push(entry);
  }

  byAction(action: string) {
    return this.entries.filter((e) => e.action === action);
  }
}

/**
 * The real role table, duplicated so the agents package does not take a
 * dependency on @jarvis/security for a test. Kept in sync deliberately: if the
 * production table changes, the Sprint 6 permission tests should be revisited.
 */
const ROLE_TOOL_PERMISSIONS: Record<Role, ToolPermission[]> = {
  owner: ["read", "write", "execute", "admin"],
  admin: ["read", "write", "execute"],
  member: ["read", "write"],
  viewer: ["read"],
};

export class FakePermissionChecker {
  hasPermission(role: Role, resource: string, action: ToolPermission): boolean {
    if (resource !== "tools") return true;
    return (ROLE_TOOL_PERMISSIONS[role] ?? []).includes(action);
  }
}

/** An approval service that gates every non-read-only tool. */
export class GatingApprovalService {
  readonly checked: string[] = [];

  async checkPreExecution(
    tool: ITool
  ): Promise<{ allowed: boolean; requiresApproval: boolean; approvalId?: string; reason?: string }> {
    this.checked.push(tool.id);
    if (tool.risk === "READ_ONLY") {
      return { allowed: true, requiresApproval: false };
    }
    return {
      allowed: false,
      requiresApproval: true,
      approvalId: `approval-${tool.id}`,
      reason: `Tool "${tool.id}" requires approval (risk: ${tool.risk})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Session context
// ---------------------------------------------------------------------------

export function sessionFor(
  userId: string,
  role: Role = "member",
  overrides: Partial<SessionContext> = {}
): SessionContext {
  return {
    auth: { userId, role, email: `${userId}@test.local` },
    conversationId: `conv-${userId}`,
    traceId: `trace-${userId}`,
    ...overrides,
  };
}
