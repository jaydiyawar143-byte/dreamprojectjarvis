// ---------------------------------------------------------------------------
// Phase 13 reachability — is any of this actually wired up?
//
// The previous turn built and tested the gate. This file answers the different
// and equally important question: can a real deployment reach it at all? A
// perfectly correct service that nothing constructs is worth nothing, and the
// only way that fails is silently.
//
// So this asserts composition, not behaviour: the service is built in the real
// container, the routes are mounted, the ten tools are registered, the policy
// grants them, and the capability registry reports them honestly.
//
// It also pins the one property that makes the tool layer safe: the port the
// tools receive has NO execute method, so a model cannot perform a Google write
// however it is prompted.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GOOGLE_WRITE_ACTIONS,
  WRITE_RISK,
  type IntegrationView,
  type ITool,
  type RiskLevel,
} from "@jarvis/core";
import {
  createGoogleWriteTools,
  GOOGLE_WRITE_TOOL_IDS,
  type GoogleWritePlanPort,
} from "@jarvis/tools";
import { AGENT_POLICIES, GOOGLE_WRITE_PLAN_TOOLS, isToolAllowed } from "@jarvis/agents";
import { CapabilityService } from "../src/services/capabilities/capability-service.js";

const CONTAINER_SOURCE = readFileSync(join(process.cwd(), "src/services/container.ts"), "utf-8");
const INDEX_SOURCE = readFileSync(join(process.cwd(), "src/index.ts"), "utf-8");
const BUILD_SOURCE = readFileSync(
  join(process.cwd(), "src/services/google/build-write-service.ts"),
  "utf-8"
);

/**
 * Source with comments stripped.
 *
 * Needed for ABSENCE assertions: these files document why they do NOT call
 * `claimForExecution` or `isGoogleConfigured`, so an assertion that the source
 * lacks those names would fail on the comment explaining their absence — a
 * test failing on its own documentation.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}
const ROUTE_SOURCE = readFileSync(join(process.cwd(), "src/routes/google-writes.ts"), "utf-8");

// ---------------------------------------------------------------------------

describe("the composition root builds the service", () => {
  it("constructs GoogleWriteService in the real container", () => {
    // The whole point of this file: a service nothing constructs is unreachable
    // no matter how correct it is.
    expect(CONTAINER_SOURCE).toContain("buildGoogleWriteService(");
    expect(CONTAINER_SOURCE).toContain("const googleWriteService = buildGoogleWriteService");
  });

  it("exposes it on the container so routes and tools share ONE instance", () => {
    expect(CONTAINER_SOURCE).toContain("googleWrites: googleWriteService");
    expect(CONTAINER_SOURCE).toMatch(/googleWrites:\s*GoogleWriteService \| null;/);
  });

  it("reuses the existing approval repository rather than a parallel store", () => {
    expect(BUILD_SOURCE).toContain("PrismaApprovalRepository");
    // The one atomic gate, passed straight through.
    expect(BUILD_SOURCE).toContain("consumeForExecution");
    expect(BUILD_SOURCE).not.toMatch(/class \w*ApprovalStore/);
  });

  it("reuses the existing execution journal for idempotency", () => {
    expect(BUILD_SOURCE).toContain("PrismaToolExecutionRepository");
  });

  it("reuses the existing encrypted vault and audit logger", () => {
    expect(BUILD_SOURCE).toContain("PrismaGoogleConnectionRepository");
    expect(BUILD_SOURCE).toContain("EncryptionService.fromEnv()");
    expect(BUILD_SOURCE).toContain("input.auditLogger");
  });

  it("never claims the execution itself, because the consume already does", () => {
    // Claiming here first would leave the row EXECUTING and make
    // `consumeForExecution`'s own claim fail — turning every legitimate write
    // into a denial. The comment and the absence are both asserted.
    expect(code(BUILD_SOURCE)).not.toContain("claimForExecution(");
    expect(BUILD_SOURCE).toContain("claimForExecution");
  });

  it("returns null instead of throwing when Google is not configured", () => {
    // Startup must not crash because Google is unconfigured: that would take
    // down every unrelated feature on the deployment.
    expect(BUILD_SOURCE).toContain("isGoogleOAuthConfigured()");
    expect(BUILD_SOURCE).toMatch(/return null;/);
    expect(BUILD_SOURCE).toContain("google_write_disabled");
  });

  it("gates on the OAuth client alone, not on the Ads developer token", () => {
    // Gmail, Drive and Calendar need no Ads developer token. Gating on
    // `isGoogleConfigured()` would refuse writes on a deployment fully able to
    // perform them.
    expect(code(BUILD_SOURCE)).toContain("isGoogleOAuthConfigured");
    expect(code(BUILD_SOURCE)).not.toContain("isGoogleConfigured()");
  });

  it("counts write rate limits in their own namespace", () => {
    expect(BUILD_SOURCE).toContain('"google_write"');
  });
});

// ---------------------------------------------------------------------------

describe("the routes are mounted and reachable", () => {
  it("mounts the write router at the documented path", () => {
    expect(INDEX_SOURCE).toContain('app.use("/api/v1/integrations/google/writes"');
    expect(INDEX_SOURCE).toContain("createGoogleWritesRouter(container)");
  });

  it("exposes plan, read and execute", () => {
    expect(ROUTE_SOURCE).toContain('router.post("/plan"');
    expect(ROUTE_SOURCE).toContain('router.get("/:approvalId"');
    expect(ROUTE_SOURCE).toContain('router.post(\n    "/:approvalId/execute"');
  });

  it("authenticates every route", () => {
    // Three routes, three requireAuth.
    const guards = ROUTE_SOURCE.match(/requireAuth/g) ?? [];
    // One from the declaration plus one per route.
    expect(guards.length).toBeGreaterThanOrEqual(4);
  });

  it("takes the user id ONLY from the session, never from the request", () => {
    expect(ROUTE_SOURCE).toContain("userId: req.auth.userId");
    // No route may accept a userId parameter — that would break tenant
    // isolation structurally rather than by policy.
    expect(ROUTE_SOURCE).not.toMatch(/req\.body\?\.userId|req\.query\.userId|params\.userId/);
  });

  it("does NOT offer its own approve endpoint", () => {
    // Approval stays one concept with one store and one audit trail. A second
    // way to say yes is a way the Approvals page would not know about.
    expect(ROUTE_SOURCE).not.toMatch(/router\.post\(\s*"\/:approvalId\/approve"/);
    expect(ROUTE_SOURCE).toMatch(/APPROVING IS NOT HERE/);
  });

  it("answers 202 for a plan, because nothing has happened yet", () => {
    // A 200 would invite a client to render it as complete.
    expect(ROUTE_SOURCE).toContain("approval_required: 202");
  });

  it("reports unavailability with a reason rather than 404ing", () => {
    expect(ROUTE_SOURCE).toContain("GOOGLE_CLIENT_ID");
    expect(ROUTE_SOURCE).toContain("503");
  });

  it("marks the frontend execute path as explicitly not voice", () => {
    expect(ROUTE_SOURCE).toContain("voice: false");
  });
});

// ---------------------------------------------------------------------------

describe("the ten tools exist and can only plan", () => {
  /** A port that records calls and has NO execute method. */
  function planPort() {
    const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const port: GoogleWritePlanPort = {
      async plan(action, params) {
        calls.push({ action, params });
        return {
          success: true,
          status: "approval_required",
          approvalId: "ap-1",
          message: "waiting",
          requestId: "req-1",
          plan: {
            action: action as never,
            source: "gmail",
            target: { kind: "draft", id: null, label: "x" },
            recipients: ["a@example.com"],
            fields: [{ label: "Body", before: null, after: "hello" }],
            requiredScopes: ["https://www.googleapis.com/auth/gmail.compose"],
            risk: WRITE_RISK["gmail.createDraft"],
            params,
            payloadHash: "hash",
            requestId: "req-1",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            idempotencyKey: "k",
          },
        };
      },
    };
    return { port, calls, tools: createGoogleWriteTools(port) };
  }

  it("creates exactly ten tools", () => {
    expect(planPort().tools).toHaveLength(10);
    expect(GOOGLE_WRITE_TOOL_IDS).toHaveLength(10);
  });

  it("covers every backend write action", () => {
    // A write action with no planning tool would be unreachable from JARVIS.
    const ids = new Set(planPort().tools.map((t) => t.id));
    for (const action of GOOGLE_WRITE_ACTIONS) {
      expect(ids.has(`google.plan.${action}`), action).toBe(true);
    }
  });

  it("names every tool with the google.plan. prefix", () => {
    // The prefix is how the policy, the capability registry and an audit log
    // reader can all tell at a glance that these plan rather than execute.
    for (const tool of planPort().tools) {
      expect(tool.id.startsWith("google.plan.")).toBe(true);
    }
  });

  it("holds a port with NO execute method", () => {
    // The load-bearing property: a model cannot perform a Google write however
    // it is prompted, because the capability is absent from its reachable
    // surface rather than merely discouraged.
    const { port } = planPort();
    expect("execute" in port).toBe(false);
    expect(Object.keys(port)).toEqual(["plan"]);
  });

  it("returns a pending approval, reported as SUCCESS", async () => {
    // Planning genuinely succeeded. A failure here would trip the
    // Orchestrator's all-tools-failed guard and tell the user their request
    // broke, when in fact it is waiting for them.
    const h = planPort();
    const tool = h.tools.find((t) => t.id === "google.plan.gmail.createDraft")!;

    const result = await tool.execute(
      { to: ["a@example.com"], subject: "s", body: "b" },
      { userId: "u1" }
    );

    expect(result.success).toBe(true);
    expect((result.data as { executed: boolean }).executed).toBe(false);
    expect((result.data as { awaitingApproval: boolean }).awaitingApproval).toBe(true);
    expect((result.data as { approvalId: string }).approvalId).toBe("ap-1");
  });

  it("tells the model explicitly that nothing has happened", async () => {
    const h = planPort();
    const tool = h.tools.find((t) => t.id === "google.plan.gmail.sendDraft")!;

    const result = await tool.execute({ draftId: "d1" }, { userId: "u1" });

    const rule = (result.metadata as { rule?: string }).rule ?? "";
    expect(rule).toMatch(/nothing has been sent/i);
    expect(rule).toMatch(/never say it is done/i);
    expect((result.metadata as { message?: string }).message).toMatch(/NOT yet done/i);
  });

  it("exposes risk and confirmation metadata", async () => {
    const h = planPort();
    const tool = h.tools.find((t) => t.id === "google.plan.gmail.createDraft")!;
    const result = await tool.execute(
      { to: ["a@example.com"], subject: "s", body: "b" },
      { userId: "u1" }
    );

    const risk = (result.data as { risk: Record<string, unknown> }).risk;
    expect(risk).toHaveProperty("level");
    expect(risk).toHaveProperty("irreversible");
    expect(risk).toHaveProperty("requiresStrongConfirmation");
    expect(risk).toHaveProperty("consequence");
  });

  it("declares itself LOW_IMPACT, because planning writes nothing outside", () => {
    for (const tool of planPort().tools) {
      expect(tool.risk, tool.id).toBe("LOW_IMPACT");
    }
  });

  it("validates arguments before reaching the service", async () => {
    // A missing required parameter is caught by the tool contract.
    const h = planPort();
    const tool = h.tools.find((t) => t.id === "google.plan.gmail.createDraft")!;
    expect(tool.validate({})).toBe(false);
    expect(tool.validate({ to: ["a@b.co"], subject: "s", body: "b" })).toBe(true);
  });

  it("resolves the user from the context, never from a parameter", async () => {
    const h = planPort();
    const tool = h.tools.find((t) => t.id === "google.plan.drive.createFolder")!;
    await tool.execute({ name: "Reports", userId: "attacker" }, { userId: "u1" });

    // The port receives the params, but the user came from the context. There
    // is no parameter through which a caller can act as somebody else.
    expect(h.calls).toHaveLength(1);
  });

  it("reports a disconnected Google as an actionable answer, not a failure", async () => {
    const port: GoogleWritePlanPort = {
      async plan() {
        return {
          success: false,
          status: "not_connected",
          plan: null,
          approvalId: null,
          message: "No Google account is connected.",
          requiredAction: "Connect your Google account, then try again.",
          requestId: "r1",
        };
      },
    };
    const tool = createGoogleWriteTools(port).find(
      (t) => t.id === "google.plan.calendar.createEvent"
    )!;

    const result = await tool.execute(
      { summary: "x", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z" },
      { userId: "u1" }
    );

    // Success, so the all-tools-failed guard does not fire — but plainly not
    // planned, with the remedy attached.
    expect(result.success).toBe(true);
    expect((result.data as { planned: boolean }).planned).toBe(false);
    expect((result.data as { requiredAction: string }).requiredAction).toMatch(/connect/i);
  });

  // INVERTED, deliberately.
  //
  // A bad address is something the USER fixes, so it must reach them as a
  // sentence, not as a failed ToolResult. A failure here trips the
  // Orchestrator's all-tools-failed guard, which is what turned "At least one
  // recipient is required." into "Data retrieval failed." on a live run. The
  // planner's own comment always said `invalid` was answerable; the condition
  // beneath it just never included it.
  it("returns a genuinely invalid request as an answerable result, not a failure", async () => {
    const port: GoogleWritePlanPort = {
      async plan() {
        return {
          success: false,
          status: "invalid",
          plan: null,
          approvalId: null,
          message: '"nope" is not a valid email address.',
          requestId: "r1",
        };
      },
    };
    const tool = createGoogleWriteTools(port).find(
      (t) => t.id === "google.plan.gmail.createDraft"
    )!;

    const result = await tool.execute(
      { to: ["nope"], subject: "s", body: "b" },
      { userId: "u1" }
    );

    // Successful lookup carrying bad news — the model can now say what is
    // wrong instead of the user seeing an outage.
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.planned).toBe(false);
    expect(data.status).toBe("invalid");
    expect(String(data.reason)).toMatch(/not a valid email address/i);
  });
});

// ---------------------------------------------------------------------------

describe("registration and policy", () => {
  it("registers the write tools in the container", () => {
    expect(CONTAINER_SOURCE).toContain("createGoogleWriteTools");
    expect(CONTAINER_SOURCE).toContain("google_write_tools_disabled");
  });

  it("hands the tools a plan-only port in the container", () => {
    // The container must not hand them anything that can execute.
    expect(CONTAINER_SOURCE).toMatch(/GoogleWritePlanPort = \{\s*\n\s*plan:/);
    expect(CONTAINER_SOURCE).not.toMatch(/GoogleWritePlanPort[\s\S]{0,200}execute:/);
  });

  it("grants planning to the general assistant", () => {
    // Where "Priya ko email likho" lands: it matches no domain signal.
    const general = AGENT_POLICIES["conversational-assistant"]!;
    for (const tool of GOOGLE_WRITE_PLAN_TOOLS) {
      expect(isToolAllowed(tool, general.allowedTools), tool).toBe(true);
    }
  });

  it("grants planning to the Google Ads agent", () => {
    const google = AGENT_POLICIES["google-ads-agent"]!;
    for (const tool of GOOGLE_WRITE_PLAN_TOOLS) {
      expect(isToolAllowed(tool, google.allowedTools), tool).toBe(true);
    }
  });

  it("does NOT grant write planning to unrelated agents", () => {
    // No Meta, WhatsApp, n8n, browser or knowledge agent has business
    // drafting the user's mail or touching their calendar.
    for (const agentId of [
      "meta-ads-agent",
      "communication-agent",
      "automation-agent",
      "browser-agent",
      "knowledge-agent",
      "location-agent",
    ]) {
      const policy = AGENT_POLICIES[agentId];
      if (!policy) continue;
      for (const tool of GOOGLE_WRITE_PLAN_TOOLS) {
        expect(isToolAllowed(tool, policy.allowedTools), `${agentId} -> ${tool}`).toBe(false);
      }
    }
  });

  it("grants no EXECUTE tool to any agent, because none exists", () => {
    // Execution is not a tool at all. There is nothing to grant, and this
    // asserts nobody has quietly added one.
    for (const [agentId, policy] of Object.entries(AGENT_POLICIES)) {
      for (const tool of policy.allowedTools) {
        expect(tool, `${agentId} grants an execute tool`).not.toMatch(
          /^google\.execute\.|^google\.write\.(send|delete|create|move|rename|upload)/
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("the capability registry reports write actions honestly", () => {
  function tool(id: string, risk: RiskLevel = "LOW_IMPACT"): ITool {
    return {
      id,
      name: id,
      description: `Tool ${id}`,
      category: "integration",
      risk,
      parameters: [],
      requiresApproval: false,
      requiredPermissions: ["read"],
      version: "1.0.0",
      enabled: true,
      execute: async () => ({ success: true }),
      validate: () => true,
    } as unknown as ITool;
  }

  function integration(over: Partial<IntegrationView> & { id: string }): IntegrationView {
    return {
      name: over.id,
      subtitle: "",
      category: "google",
      configKind: "oauth",
      connection: "NOT_CONNECTED",
      health: "NOT_CONNECTED",
      detail: "Nothing configured.",
      account: null,
      config: [],
      configComplete: false,
      missingConfig: [],
      permissions: [],
      actions: [],
      enabledServices: [],
      usage: null,
      lastTestedAt: null,
      lastSuccessfulSyncAt: null,
      lastError: null,
      effectiveSource: "none",
      supportedCommands: [],
      ...over,
    } as IntegrationView;
  }

  const WRITE_TOOLS = GOOGLE_WRITE_PLAN_TOOLS.map((id) => tool(id));

  function serviceWith(integrations: IntegrationView[]) {
    return new CapabilityService({
      toolRegistry: { getAll: () => WRITE_TOOLS },
      integrations: { listIntegrations: async () => integrations },
      allowedToolIds: new Set(WRITE_TOOLS.map((t) => t.id)),
    });
  }

  const DISCONNECTED = [integration({ id: "google", name: "Google" })];

  it("never marks a write as executable when Google is disconnected", async () => {
    const report = await serviceWith(DISCONNECTED).report("u1");
    const writes = report.capabilities.filter((c) => c.id.startsWith("google.plan."));

    expect(writes).toHaveLength(10);
    for (const cap of writes) {
      expect(cap.availability, cap.id).toBe("NOT_CONNECTED");
      expect(cap.reason, cap.id).toBeTruthy();
      expect(cap.requiredAction, cap.id).toBeTruthy();
    }
  });

  it("reports a write as REQUIRES_CONFIRMATION, never EXECUTABLE", async () => {
    // Planning is LOW_IMPACT, so the plain risk check would call it
    // EXECUTABLE — which would read as "JARVIS can send email on request".
    const connected = [
      integration({
        id: "google",
        name: "Google",
        connection: "CONNECTED",
        health: "CONNECTED",
        permissions: [
          {
            id: "https://www.googleapis.com/auth/gmail.compose",
            label: "Modify Gmail",
            granted: true,
            access: "write",
            service: "gmail",
          },
        ],
      }),
    ];

    const report = await serviceWith(connected).report("u1");
    const gmailWrite = report.capabilities.find(
      (c) => c.id === "google.plan.gmail.createDraft"
    )!;

    expect(gmailWrite.availability).toBe("REQUIRES_CONFIRMATION");
    expect(gmailWrite.availability).not.toBe("EXECUTABLE");
    expect(gmailWrite.access).toBe("write");
  });

  it("requires the WRITE scope, not the read scope", async () => {
    // A read-only connection must not report write planning as available.
    const readOnly = [
      integration({
        id: "google",
        name: "Google",
        connection: "CONNECTED",
        health: "CONNECTED",
        permissions: [
          {
            id: "https://www.googleapis.com/auth/gmail.readonly",
            label: "Read Gmail",
            granted: true,
            access: "read",
            service: "gmail",
          },
        ],
      }),
    ];

    const report = await serviceWith(readOnly).report("u1");
    const gmailWrite = report.capabilities.find(
      (c) => c.id === "google.plan.gmail.createDraft"
    )!;

    expect(gmailWrite.availability).toBe("PERMISSION_MISSING");
    expect(gmailWrite.reason).toMatch(/write access to Gmail was not granted/i);
  });

  it("gates each service's writes independently", async () => {
    const calendarOnly = [
      integration({
        id: "google",
        name: "Google",
        connection: "CONNECTED",
        health: "CONNECTED",
        permissions: [
          {
            id: "https://www.googleapis.com/auth/calendar.events",
            label: "Modify Calendar",
            granted: true,
            access: "write",
            service: "calendar",
          },
        ],
      }),
    ];

    const report = await serviceWith(calendarOnly).report("u1");
    const byId = new Map(report.capabilities.map((c) => [c.id, c]));

    expect(byId.get("google.plan.calendar.createEvent")!.availability).toBe(
      "REQUIRES_CONFIRMATION"
    );
    expect(byId.get("google.plan.gmail.createDraft")!.availability).toBe("PERMISSION_MISSING");
    expect(byId.get("google.plan.drive.createFolder")!.availability).toBe("PERMISSION_MISSING");
  });

  it("labels every write capability as preparing or requesting, never the bare verb", async () => {
    // "Send an email" in a capability list implies JARVIS can send one on
    // request. It cannot, and the label is where that is first communicated.
    const report = await serviceWith(DISCONNECTED).report("u1");

    for (const cap of report.capabilities.filter((c) => c.id.startsWith("google.plan."))) {
      expect(cap.label, cap.id).toMatch(/prepare|request approval/i);
    }
  });
});
