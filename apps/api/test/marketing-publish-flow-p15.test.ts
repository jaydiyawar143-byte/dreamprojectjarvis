// ---------------------------------------------------------------------------
// Phase 15 — publishing from the Marketing page: request, decide, execute.
//
// REAL: the publish flow, `ToolExecutor`, `PermissionService`,
// `ApprovalService`, the two publish tools, the execution journal's in-memory
// twin. So every answer below is the executor's and the tool's own — the
// permission check, the approval lookup, the parameter binding, the one-time
// consumption — not a description of them.
//
// STAND-INS: the marketing service behind the tools (scripted, so each test
// says what the saved item and the provider "are"), and the approval store
// (one in-memory object serving the three parties that share the real table:
// the flow, the executor's approval manager, and the tool's consumption).
//
// The same sequence against PostgreSQL, with the real service and repository,
// is in `marketing-e2e-pg.integration.test.ts`.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_TTL_MS,
  MARKETING_TOOL_IDS,
  computeParamsHash,
  marketingFail,
  marketingOk,
  type Approval,
  type ApprovalConsumptionInput,
  type ApprovalConsumptionResult,
  type ApprovalStatus,
  type AuditLogger,
  type ContentItemView,
  type IApprovalRepository,
  type IToolExecutor,
  type MarketingResult,
  type PublishOutcome,
  type PublishParams,
  type PublishPreparation,
  type Role,
  type ToolExecutionRequest,
} from "@jarvis/core";
import { ApprovalService, PermissionService } from "@jarvis/security";
import { MemoryExecutionJournal, ToolExecutor, ToolRegistry, createMarketingPublishTools, type MarketingCallContext, type MarketingPort } from "@jarvis/tools";
import { MarketingPublishFlow, type PublishCaller, type PublishFlowResult } from "../src/services/marketing/publish-flow.js";

const PUBLISH = MARKETING_TOOL_IDS.contentPublish;
const PREPARE = MARKETING_TOOL_IDS.publishPrepare;

// ---------------------------------------------------------------------------
// The approval store: one object, the three parties that share the real table
// ---------------------------------------------------------------------------

class ApprovalStore implements IApprovalRepository {
  readonly rows = new Map<string, Approval>();
  private seq = 0;
  now: () => number = () => Date.now();

  constructor(private readonly journal: MemoryExecutionJournal) {}

  /** A row as the real repository reports it: past its time, it is expired. */
  private effective(row: Approval): Approval {
    const live = row.status === "pending" || row.status === "approved";
    return live && new Date(row.expiresAt).getTime() <= this.now() ? { ...row, status: "expired" } : { ...row };
  }

  async create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval> {
    const id = `appr_${String(++this.seq).padStart(4, "0")}`;
    // Created one millisecond apart, so "newest first" is never a tie.
    const row: Approval = { ...data, id, status: "pending", createdAt: new Date(this.now() + this.seq).toISOString() };
    this.rows.set(id, row);
    return { ...row };
  }

  async findById(id: string): Promise<Approval | null> {
    const row = this.rows.get(id);
    return row ? this.effective(row) : null;
  }

  async findByIdForUser(id: string, userId: string): Promise<Approval | null> {
    const row = this.rows.get(id);
    return row && row.userId === userId ? this.effective(row) : null;
  }

  async updateStatus(id: string, status: ApprovalStatus): Promise<Approval | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    row.status = status;
    return { ...row };
  }

  async findPending(): Promise<Approval[]> {
    return [...this.rows.values()].map((row) => this.effective(row)).filter((row) => row.status === "pending");
  }

  private newestFirst(userId: string): Approval[] {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .map((row) => this.effective(row))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findExistingForTool(toolId: string, userId: string): Promise<Approval | null> {
    return this.newestFirst(userId).find((row) => row.toolId === toolId) ?? null;
  }

  async listByUser(userId: string, options?: { status?: ApprovalStatus; page?: number; limit?: number }): Promise<{ items: Approval[]; total: number }> {
    const all = this.newestFirst(userId).filter((row) => !options?.status || row.status === options.status);
    return { items: all.slice(0, options?.limit ?? 20), total: all.length };
  }

  /** The decision a person makes on the Approvals page. */
  decide(id: string, decision: "approved" | "rejected"): void {
    const row = this.rows.get(id);
    if (!row || this.effective(row).status !== "pending") throw new Error(`approval ${id} is not waiting`);
    row.status = decision;
    row.resolvedAt = new Date(this.now()).toISOString();
  }

  /** Mirrors the repository's atomic consume-and-claim, check for check. */
  async consumeForExecution(input: ApprovalConsumptionInput): Promise<ApprovalConsumptionResult> {
    const row = this.rows.get(input.approvalId);
    if (!row) return { ok: false, reason: "approval not found" };
    if (row.userId !== input.userId) return { ok: false, reason: "approval belongs to a different user" };
    if (row.toolId !== input.toolId) return { ok: false, reason: "approval was issued for a different tool" };
    if (!row.paramsHash || row.paramsHash !== input.paramsHash) return { ok: false, reason: "params hash mismatch" };
    if (row.status === "consumed") return { ok: false, reason: "approval already consumed" };
    if (row.status === "rejected") return { ok: false, reason: "approval was rejected" };
    if (row.status !== "approved") return { ok: false, reason: `approval is ${row.status}` };
    if (new Date(row.expiresAt).getTime() <= this.now()) return { ok: false, reason: "approval has expired" };

    row.status = "consumed";
    const claimed = await this.journal.claimForExecution(input.executionId, { ownerId: "p15-flow-test", leaseMs: 60_000 });
    if (!claimed) {
      row.status = "approved";
      return { ok: false, reason: "execution is not in a claimable state" };
    }
    return { ok: true };
  }

  status(id: string): ApprovalStatus | undefined {
    return this.rows.get(id)?.status;
  }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const PARAMS: PublishParams = { contentId: "item_1", targetId: "1234567890", targetName: "Shop Page", message: "Festive offer is live." };

const READY: PublishPreparation = {
  ready: true,
  blockers: [],
  channel: "FACEBOOK",
  targets: [{ id: "1234567890", name: "Shop Page", channel: "FACEBOOK", provider: "meta-graph" } as never],
  publishParams: PARAMS,
  warning: null,
};

const publishedItem = { id: "item_1", status: "PUBLISHED" } as unknown as ContentItemView;

const outcome = (status: PublishOutcome["status"], message: string, content: ContentItemView | null = null, code: string = status): PublishOutcome => ({ status, code, message, content });

interface Script {
  prepare: (contentId: string, targetId: string | undefined, ctx: MarketingCallContext) => MarketingResult<PublishPreparation>;
  publish: (params: PublishParams) => PublishOutcome | Promise<PublishOutcome>;
}

function world(options: { register?: boolean } = {}) {
  const script: Script = {
    prepare: () => marketingOk(READY),
    publish: () => outcome("PUBLISHED", "Published to Shop Page and read back from the Page.", publishedItem),
  };
  const prepared: Array<{ userId: string; contentId: string; targetId: string | undefined; ctx: MarketingCallContext }> = [];
  const published: Array<{ userId: string; params: PublishParams; ctx: MarketingCallContext }> = [];

  // Only the two methods publishing uses exist. Anything else is a mistake.
  const port = new Proxy(
    {
      async preparePublish(userId: string, contentId: string, targetId: string | undefined, ctx: MarketingCallContext) {
        prepared.push({ userId, contentId, targetId, ctx });
        return script.prepare(contentId, targetId, ctx);
      },
      async publish(userId: string, params: PublishParams, ctx: MarketingCallContext) {
        published.push({ userId, params, ctx });
        return script.publish(params);
      },
    } as Record<string, unknown>,
    {
      get(target, property) {
        if (property in target) return target[property as string];
        if (typeof property === "symbol" || property === "then") return undefined;
        return () => {
          throw new Error(`the publish flow must not reach marketing.${String(property)}`);
        };
      },
    }
  ) as unknown as MarketingPort;

  const journal = new MemoryExecutionJournal();
  const store = new ApprovalStore(journal);
  const registry = new ToolRegistry();
  if (options.register !== false) {
    for (const tool of createMarketingPublishTools(port, journal, store)) registry.register(tool);
  }

  const auditRows: Array<Record<string, unknown>> = [];
  const audit = { log: vi.fn(async (entry: Record<string, unknown>) => void auditRows.push(entry)) } as unknown as AuditLogger;
  const permissions = new PermissionService();
  const real = new ToolExecutor(registry, permissions, new ApprovalService(store), audit);

  const requests: ToolExecutionRequest[] = [];
  const hooks: { before?: (request: ToolExecutionRequest) => void | Promise<void> } = {};
  const executor: Pick<IToolExecutor, "execute"> = {
    async execute(request) {
      requests.push(request);
      await hooks.before?.(request);
      return real.execute(request);
    },
  };

  const flow = new MarketingPublishFlow({ executor, approvals: store, tools: registry, permissions, now: () => new Date(store.now()) });
  return { flow, store, script, prepared, published, requests, hooks, auditRows, registry, executor };
}

const caller = (role: Role = "member", userId = "user-1"): PublishCaller => ({ userId, role, traceId: "trace-p15-flow" });

/** Narrow a result to the approval it asks for, or fail the test with what it was. */
function asking(result: PublishFlowResult): Extract<PublishFlowResult, { status: "APPROVAL_REQUIRED" }> {
  if (result.status !== "APPROVAL_REQUIRED") throw new Error(`expected an approval to be asked for, got ${JSON.stringify(result)}`);
  return result;
}

beforeEach(() => {
  // ApprovalService announces each request on the console.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// Before anything can be asked
// ---------------------------------------------------------------------------

describe("Phase 15 publish flow — refusals that come before any approval exists", () => {
  it("is UNAVAILABLE where no publish tool is registered", async () => {
    const w = world({ register: false });

    expect((await w.flow.request(caller(), "item_1")).status).toBe("UNAVAILABLE");
    expect((await w.flow.execute(caller(), "item_1", "appr_0001")).status).toBe("UNAVAILABLE");
    expect(w.requests).toHaveLength(0);
  });

  it("refuses a viewer before the item is even looked at, and creates no approval", async () => {
    const w = world();

    const result = await w.flow.request(caller("viewer"), "item_1");

    expect(result.status).toBe("FORBIDDEN");
    expect(w.requests).toHaveLength(0);
    expect(w.prepared).toHaveLength(0);
    expect(w.store.rows.size).toBe(0);
  });

  it("refuses a viewer who holds an approved approval — the role is checked first", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller("member"), "item_1"));
    w.store.decide(approvalId, "approved");

    // The same user, demoted. The approval they were given no longer runs.
    const result = await w.flow.execute(caller("viewer"), "item_1", approvalId);

    expect(result.status).toBe("FORBIDDEN");
    expect(w.published).toHaveLength(0);
    expect(w.store.status(approvalId)).toBe("approved");
  });

  it.each(["member", "admin", "owner"] as const)("lets a %s ask", async (role) => {
    const w = world();

    expect((await w.flow.request(caller(role), "item_1")).status).toBe("APPROVAL_REQUIRED");
  });

  it("says NOT_READY with the first blocker, hands back the check, and creates no approval", async () => {
    const w = world();
    const blocked: PublishPreparation = { ...READY, ready: false, blockers: ["This item is a draft. Mark it ready first.", "Second."], publishParams: null };
    w.script.prepare = () => marketingOk(blocked);

    const result = await w.flow.request(caller(), "item_1");

    expect(result).toEqual({ status: "NOT_READY", message: "This item is a draft. Mark it ready first.", preparation: blocked });
    expect(w.store.rows.size).toBe(0);
    expect(w.published).toHaveLength(0);
  });

  it("does not trust a check that says ready without usable parameters", async () => {
    const w = world();
    w.script.prepare = () => marketingOk({ ...READY, publishParams: { ...PARAMS, message: "" } });

    const result = await w.flow.request(caller(), "item_1");

    expect(result.status).toBe("NOT_READY");
    expect(w.store.rows.size).toBe(0);
  });

  it.each([
    ["NOT_FOUND", "That content item was not found."],
    ["OUT_OF_SCOPE", "This conversation belongs to a different project."],
  ] as const)("answers NOT_FOUND when the check says %s", async (code, message) => {
    const w = world();
    w.script.prepare = () => marketingFail(code, message);

    const result = await w.flow.request(caller(), "item_other");

    expect(result).toEqual({ status: "NOT_FOUND", message });
    expect(w.store.rows.size).toBe(0);
  });

  it("answers RATE_LIMITED, and creates no approval, when the check was refused for being asked too often", async () => {
    const w = world();
    w.script.prepare = () => marketingFail("RATE_LIMITED", "Too many publish checks have been made in the last few minutes. Wait a little and try again.");

    const result = await w.flow.request(caller(), "item_1");

    expect(result).toEqual({ status: "RATE_LIMITED", message: "Too many publish checks have been made in the last few minutes. Wait a little and try again." });
    expect(w.store.rows.size).toBe(0);
    expect(w.published).toHaveLength(0);
  });

  it("answers UNAVAILABLE, and creates no approval, when the limit itself could not be checked", async () => {
    const w = world();
    w.script.prepare = () => marketingFail("UNAVAILABLE", "The request limit could not be checked just now, so nothing was started. Try again in a moment.");

    const result = await w.flow.request(caller(), "item_1");

    expect(result).toMatchObject({ status: "UNAVAILABLE" });
    expect(w.store.rows.size).toBe(0);
  });

  it("answers NOT_READY, never an approval, when the check itself fails", async () => {
    const w = world();
    w.script.prepare = () => marketingFail("PROVIDER_FAILED", "The Facebook connection could not be reached.");

    const result = await w.flow.request(caller(), "item_1");

    expect(result).toMatchObject({ status: "NOT_READY", message: "The Facebook connection could not be reached.", preparation: null });
    expect(w.store.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

describe("Phase 15 publish flow — asking creates one approval, bound to the exact text and place", () => {
  it("runs the publish check through the executor, as the caller", async () => {
    const w = world();

    await w.flow.request({ ...caller("admin", "user-7"), projectId: "proj_1", ipAddress: "203.0.113.9" }, "item_1", "1234567890");

    expect(w.requests).toHaveLength(1);
    expect(w.requests[0]).toMatchObject({
      toolId: PREPARE,
      userId: "user-7",
      role: "admin",
      traceId: "trace-p15-flow",
      ipAddress: "203.0.113.9",
      params: { contentId: "item_1", targetId: "1234567890", projectId: "proj_1" },
    });
    expect(w.prepared[0]).toMatchObject({ userId: "user-7", contentId: "item_1", targetId: "1234567890" });
  });

  it("creates a pending approval for the publish tool and posts nothing", async () => {
    const w = world();

    const result = asking(await w.flow.request(caller(), "item_1"));

    expect(result.ask).toBe("REQUESTED");
    expect(w.published).toHaveLength(0);
    expect(w.store.rows.size).toBe(1);
    const row = w.store.rows.get(result.approvalId)!;
    expect(row).toMatchObject({ userId: "user-1", toolId: PUBLISH, status: "pending", riskLevel: "EXTERNAL_SIDE_EFFECT" });
  });

  it("binds the approval to exactly the parameters the check built", async () => {
    const w = world();

    const result = asking(await w.flow.request(caller(), "item_1"));

    const row = w.store.rows.get(result.approvalId)!;
    expect(row.params).toEqual(PARAMS);
    expect(row.paramsHash).toBe(computeParamsHash({ ...PARAMS }));
    expect(result.params).toEqual(PARAMS);
  });

  it("shows the person the text and the place the approval is bound to", async () => {
    const w = world();

    const { summary } = asking(await w.flow.request(caller(), "item_1"));

    expect(summary.actionSummary).toBe("Publish this post publicly to Shop Page. JARVIS cannot undo it.");
    expect(summary.detailLines).toEqual([
      { label: "Publish to", value: "Shop Page" },
      { label: "Text to be posted", value: "Festive offer is live." },
    ]);
  });

  it("shows the link when the item has one, and binds it too", async () => {
    const w = world();
    const withLink = { ...PARAMS, link: "https://example.com/offer" };
    w.script.prepare = () => marketingOk({ ...READY, publishParams: withLink });

    const result = asking(await w.flow.request(caller(), "item_1"));

    expect(result.summary.detailLines).toContainEqual({ label: "Link", value: "https://example.com/offer" });
    expect(w.store.rows.get(result.approvalId)!.paramsHash).toBe(computeParamsHash({ ...withLink }));
  });

  it("gives the approval the one lifetime every approval has", async () => {
    const w = world();
    const at = Date.parse("2026-10-12T09:00:00.000Z");
    w.store.now = () => at;

    const result = asking(await w.flow.request(caller(), "item_1"));

    expect(result.expiresAt).toBe(new Date(at + APPROVAL_TTL_MS).toISOString());
  });

  it("returns the approval already waiting instead of creating a second", async () => {
    const w = world();

    const first = asking(await w.flow.request(caller(), "item_1"));
    const second = asking(await w.flow.request(caller(), "item_1"));

    expect(second.ask).toBe("WAITING");
    expect(second.approvalId).toBe(first.approvalId);
    expect(w.store.rows.size).toBe(1);
  });

  it("asks afresh when the saved text has changed, and leaves the old request behind", async () => {
    const w = world();
    const first = asking(await w.flow.request(caller(), "item_1"));

    const edited = { ...PARAMS, message: "Festive offer ends Sunday." };
    w.script.prepare = () => marketingOk({ ...READY, publishParams: edited });
    const second = asking(await w.flow.request(caller(), "item_1"));

    expect(second.ask).toBe("REQUESTED");
    expect(second.approvalId).not.toBe(first.approvalId);
    expect(w.store.rows.get(second.approvalId)!.params).toEqual(edited);
  });

  it("does not reuse another user's waiting approval for the same words", async () => {
    const w = world();
    const theirs = asking(await w.flow.request(caller("member", "user-2"), "item_1"));

    const mine = asking(await w.flow.request(caller("member", "user-1"), "item_1"));

    expect(mine.ask).toBe("REQUESTED");
    expect(mine.approvalId).not.toBe(theirs.approvalId);
  });
});

// ---------------------------------------------------------------------------
// Executing
// ---------------------------------------------------------------------------

describe("Phase 15 publish flow — a publish runs once, for an approval a person granted", () => {
  it("publishes when the approval was approved, naming that approval to the executor", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");

    const result = await w.flow.execute(caller(), "item_1", approvalId);

    expect(result).toEqual({ status: "PUBLISHED", alreadyPublished: false, message: "Published to Shop Page and read back from the Page.", item: publishedItem });
    const run = w.requests.at(-1)!;
    expect(run).toMatchObject({ toolId: PUBLISH, approvalId, userId: "user-1", role: "member" });
    expect(run.params).toEqual(PARAMS);
  });

  it("hands the service exactly the approved parameters", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");

    await w.flow.execute(caller(), "item_1", approvalId);

    expect(w.published).toHaveLength(1);
    expect(w.published[0]!.userId).toBe("user-1");
    expect(w.published[0]!.params).toEqual(PARAMS);
  });

  it("consumes the approval, so it can never publish twice", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");
    await w.flow.execute(caller(), "item_1", approvalId);

    const again = await w.flow.execute(caller(), "item_1", approvalId);

    expect(w.store.status(approvalId)).toBe("consumed");
    expect(again).toMatchObject({ status: "FAILED", reason: "APPROVAL_ALREADY_USED" });
    expect(w.published).toHaveLength(1);
  });

  it("posts once when the same approval is executed twice at the same moment", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");

    const results = await Promise.all([w.flow.execute(caller(), "item_1", approvalId), w.flow.execute(caller(), "item_1", approvalId)]);

    expect(w.published).toHaveLength(1);
    expect(results.filter((result) => result.status === "PUBLISHED")).toHaveLength(1);
    // The other was told plainly that nothing was posted by it.
    const other = results.find((result) => result.status !== "PUBLISHED")!;
    expect(other.status).toBe("FAILED");
    expect((other as { message: string }).message).toMatch(/nothing was published|Nothing was published/i);
  });

  it("publishes on asking again once these exact words were approved", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");

    // The page asks again after the person approved: the decision is made.
    const result = await w.flow.request(caller(), "item_1");

    expect(result.status).toBe("PUBLISHED");
    expect(w.requests.at(-1)).toMatchObject({ toolId: PUBLISH, approvalId });
    expect(w.published).toHaveLength(1);
  });

  it("does not publish while the approval is still waiting", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));

    const result = asking(await w.flow.execute(caller(), "item_1", approvalId));

    expect(result.ask).toBe("WAITING");
    expect(result.approvalId).toBe(approvalId);
    expect(w.published).toHaveLength(0);
    expect(w.requests.filter((request) => request.toolId === PUBLISH)).toHaveLength(0);
  });

  it("does not publish what the person declined", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "rejected");

    const result = await w.flow.execute(caller(), "item_1", approvalId);

    expect(result.status).toBe("DECLINED");
    expect(w.published).toHaveLength(0);
    expect(w.requests.filter((request) => request.toolId === PUBLISH)).toHaveLength(0);
  });

  it("asks again, for the item as it is now, when the approval ran out of time", async () => {
    const w = world();
    const start = Date.parse("2026-10-12T09:00:00.000Z");
    w.store.now = () => start;
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");

    // Ten minutes and a second later. Approved, and too late.
    w.store.now = () => start + APPROVAL_TTL_MS + 1000;
    const edited = { ...PARAMS, message: "Festive offer ends Sunday." };
    w.script.prepare = () => marketingOk({ ...READY, publishParams: edited });

    const result = asking(await w.flow.execute(caller(), "item_1", approvalId));

    expect(result.ask).toBe("EXPIRED");
    expect(result.approvalId).not.toBe(approvalId);
    expect(result.params).toEqual(edited);
    expect(w.published).toHaveLength(0);
  });

  it("an approval that expires between the flow's look and the executor's is not used", async () => {
    const w = world();
    const start = Date.parse("2026-10-12T09:00:00.000Z");
    w.store.now = () => start;
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");

    // The flow reads it as approved; by the time the tool consumes it, it is not.
    w.hooks.before = (request) => {
      if (request.toolId === PUBLISH) w.store.now = () => start + APPROVAL_TTL_MS + 1000;
    };
    const result = await w.flow.execute(caller(), "item_1", approvalId);

    expect(result.status).not.toBe("PUBLISHED");
    expect(w.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Whose approval, and for what
// ---------------------------------------------------------------------------

describe("Phase 15 publish flow — an approval authorises one user, one item, one tool", () => {
  it("does not find another user's approval", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller("member", "user-2"), "item_1"));
    w.store.decide(approvalId, "approved");

    const result = await w.flow.execute(caller("owner", "user-1"), "item_1", approvalId);

    expect(result).toEqual({ status: "NOT_FOUND", message: "That approval was not found for this item." });
    expect(w.published).toHaveLength(0);
    expect(w.store.status(approvalId)).toBe("approved");
  });

  it("does not use an approval for one item to publish another", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");

    const result = await w.flow.execute(caller(), "item_2", approvalId);

    expect(result.status).toBe("NOT_FOUND");
    expect(w.published).toHaveLength(0);
    expect(w.store.status(approvalId)).toBe("approved");
  });

  it("does not use an approval that was granted for a different tool", async () => {
    const w = world();
    const other = await w.store.create({
      userId: "user-1",
      toolId: "meta.campaign.pause",
      action: "execute",
      params: { ...PARAMS },
      paramsHash: computeParamsHash({ ...PARAMS }),
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    });
    w.store.decide(other.id, "approved");

    const result = await w.flow.execute(caller(), "item_1", other.id);

    expect(result.status).toBe("NOT_FOUND");
    expect(w.published).toHaveLength(0);
  });

  it("does not use an approval whose stored parameters are not publish parameters", async () => {
    const w = world();
    const odd = await w.store.create({
      userId: "user-1",
      toolId: PUBLISH,
      action: "Publish content item",
      params: { contentId: "item_1", targetId: "1234567890" },
      paramsHash: computeParamsHash({ contentId: "item_1", targetId: "1234567890" }),
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    });
    w.store.decide(odd.id, "approved");

    expect((await w.flow.execute(caller(), "item_1", odd.id)).status).toBe("NOT_FOUND");
    expect(w.published).toHaveLength(0);
  });

  it("answers an id that does not exist exactly as it answers someone else's", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller("member", "user-2"), "item_1"));

    const theirs = await w.flow.execute(caller(), "item_1", approvalId);
    const nobodys = await w.flow.execute(caller(), "item_1", "appr_9999");

    expect(nobodys).toEqual(theirs);
  });

  it("runs the publish with the parameters stored on the approval, not anything newer", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");
    // The saved item has since been edited; the check would now build this.
    w.script.prepare = () => marketingOk({ ...READY, publishParams: { ...PARAMS, message: "Edited after approval." } });

    await w.flow.execute(caller(), "item_1", approvalId);

    // What ran is what was approved. Whether it still matches the saved item
    // is the service's check — and it refuses when it does not (see below).
    expect(w.published[0]!.params).toEqual(PARAMS);
  });

  it("an approval whose parameters were altered after it was granted cannot publish", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");
    // Someone changes the stored words without the hash a person approved.
    w.store.rows.get(approvalId)!.params = { ...PARAMS, message: "Words nobody approved." };

    const result = await w.flow.execute(caller(), "item_1", approvalId);

    expect(result.status).not.toBe("PUBLISHED");
    expect(w.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Declining one thing
// ---------------------------------------------------------------------------

describe("Phase 15 publish flow — declining one publish blocks only that one", () => {
  it("lets a different item be published after another was declined", async () => {
    const w = world();
    const first = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(first.approvalId, "rejected");

    const other: PublishParams = { contentId: "item_2", targetId: "1234567890", targetName: "Shop Page", message: "A different post." };
    w.script.prepare = () => marketingOk({ ...READY, publishParams: other });
    const second = asking(await w.flow.request(caller(), "item_2"));
    expect(second.ask).toBe("REQUESTED");
    w.store.decide(second.approvalId, "approved");

    const result = await w.flow.execute(caller(), "item_2", second.approvalId);

    expect(result.status).toBe("PUBLISHED");
    expect(w.published.map((entry) => entry.params.contentId)).toEqual(["item_2"]);
  });

  it("lets the same item be asked for again after it was declined", async () => {
    const w = world();
    const first = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(first.approvalId, "rejected");

    const second = asking(await w.flow.request(caller(), "item_1"));
    expect(second.ask).toBe("REQUESTED");
    expect(second.approvalId).not.toBe(first.approvalId);
    w.store.decide(second.approvalId, "approved");

    expect((await w.flow.execute(caller(), "item_1", second.approvalId)).status).toBe("PUBLISHED");
    // The declined one is still declined.
    expect((await w.flow.execute(caller(), "item_1", first.approvalId)).status).toBe("DECLINED");
    expect(w.published).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------

describe("Phase 15 publish flow — the outcome is reported as exactly what it was", () => {
  async function approved(w: ReturnType<typeof world>): Promise<string> {
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");
    return approvalId;
  }

  it("says PUBLISHED, and that nothing new was posted, when an earlier attempt had already gone out", async () => {
    const w = world();
    w.script.publish = () => outcome("ALREADY_PUBLISHED", "An earlier attempt had already published this to Shop Page.", publishedItem);

    const result = await w.flow.execute(caller(), "item_1", await approved(w));

    expect(result).toMatchObject({ status: "PUBLISHED", alreadyPublished: true });
  });

  it("says UNCONFIRMED when the post was sent and the answer never came", async () => {
    const w = world();
    w.script.publish = () => outcome("UNCONFIRMED", "The post was sent to Shop Page, but the answer never arrived. It is NOT marked as published.");

    const result = await w.flow.execute(caller(), "item_1", await approved(w));

    expect(result).toEqual({
      status: "UNCONFIRMED",
      message: "The post was sent to Shop Page, but the answer never arrived. It is NOT marked as published.",
      reason: "UNCONFIRMED",
      // Something WAS sent by this request.
      sentNothing: false,
    });
  });

  it.each(["NOT_FOUND_ON_PAGE", "RECONCILE_MISMATCH"])("says UNCONFIRMED, and that THIS request sent nothing, when a retry only looked (%s)", async (code) => {
    const w = world();
    const message = "JARVIS looked for the earlier post on Shop Page and did not find it. Nothing new was posted.";
    w.script.publish = () => outcome("UNCONFIRMED", message, null, code);

    const result = await w.flow.execute(caller(), "item_1", await approved(w));

    expect(result).toEqual({ status: "UNCONFIRMED", message, reason: code, sentNothing: true });
  });

  it.each(["AMBIGUOUS_OUTCOME", "VERIFY_FAILED", "VERIFY_MISMATCH", "VERIFY_NO_TEXT", "RECORD_FAILED"])("never says a request that sent something sent nothing (%s)", async (code) => {
    const w = world();
    w.script.publish = () => outcome("UNCONFIRMED", "Not confirmed. It is NOT marked as published.", null, code);

    const result = await w.flow.execute(caller(), "item_1", await approved(w));

    expect(result).toMatchObject({ status: "UNCONFIRMED", reason: code, sentNothing: false });
  });

  it.each([
    ["TARGET_REFUSED", "TARGET_CHANGED"],
    ["STALE", "TEXT_CHANGED"],
  ] as const)("a retry held to the earlier attempt's Page or words is a refusal in which nothing was sent (%s)", async (status, code) => {
    const w = world();
    w.script.publish = () => outcome(status, "It cannot be sent to a different Page until that is settled. Nothing was published.", null, code);

    const result = await w.flow.execute(caller(), "item_1", await approved(w));

    expect(result).toMatchObject({ status: "NOT_READY", reason: status });
  });

  it("says UNCONFIRMED when the service reports no outcome at all", async () => {
    const w = world();
    w.script.publish = () => {
      throw new Error("connection reset by peer at 10.0.0.4:5432");
    };

    const result = await w.flow.execute(caller(), "item_1", await approved(w));

    expect(result.status).toBe("UNCONFIRMED");
    // And none of the thrown text reaches the person.
    expect(JSON.stringify(result)).not.toContain("10.0.0.4");
  });

  it("says UNCONFIRMED when the executor itself gives no answer", async () => {
    const w = world();
    const approvalId = await approved(w);
    w.hooks.before = (request) => {
      if (request.toolId === PUBLISH) throw new Error("executor crashed");
    };

    const result = await w.flow.execute(caller(), "item_1", approvalId);

    expect(result.status).toBe("UNCONFIRMED");
    expect(JSON.stringify(result)).not.toContain("executor crashed");
  });

  it("says FAILED, with the service's sentence, when the provider refused", async () => {
    const w = world();
    w.script.publish = () => outcome("FAILED", "Facebook refused the post. Nothing was published.");

    const result = await w.flow.execute(caller(), "item_1", await approved(w));

    expect(result).toEqual({ status: "FAILED", reason: "FAILED", message: "Facebook refused the post. Nothing was published." });
  });

  it.each([
    ["STALE", "The saved text is no longer the text that was approved, so nothing was published. Check the item and ask again."],
    ["NOT_READY", "This item is not marked ready, so it was not published."],
    ["TARGET_REFUSED", "That Page is not one this connection can publish to. Nothing was published."],
    ["IN_PROGRESS", "Another publish of this item is already running. Nothing was published by this request."],
  ] as const)("says NOT_READY (%s) when the tool refused before sending anything", async (status, message) => {
    const w = world();
    w.script.publish = () => outcome(status, message);

    const result = await w.flow.execute(caller(), "item_1", await approved(w));

    expect(result).toEqual({ status: "NOT_READY", reason: status, message, preparation: null });
  });

  it("an approval spent on a refused publish is spent: the next attempt needs a new one", async () => {
    const w = world();
    w.script.publish = () => outcome("STALE", "The saved text is no longer the text that was approved, so nothing was published.");
    const approvalId = await approved(w);
    await w.flow.execute(caller(), "item_1", approvalId);

    w.script.publish = () => outcome("PUBLISHED", "Published.", publishedItem);
    const retry = await w.flow.execute(caller(), "item_1", approvalId);

    expect(retry).toMatchObject({ status: "FAILED", reason: "APPROVAL_ALREADY_USED" });
    expect(w.published).toHaveLength(1);
  });

  it("never reports PUBLISHED for any outcome but the two that were read back", async () => {
    const statuses: Array<PublishOutcome["status"]> = ["UNCONFIRMED", "FAILED", "NOT_READY", "STALE", "TARGET_REFUSED", "IN_PROGRESS"];
    for (const status of statuses) {
      const w = world();
      w.script.publish = () => outcome(status, "A sentence.");

      const result = await w.flow.execute(caller(), "item_1", await approved(w));

      expect(result.status, status).not.toBe("PUBLISHED");
    }
  });
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

describe("Phase 15 publish flow — every step leaves the executor's own audit row", () => {
  it("audits the check and the publish, under the caller's trace", async () => {
    const w = world();
    const { approvalId } = asking(await w.flow.request(caller(), "item_1"));
    w.store.decide(approvalId, "approved");

    await w.flow.execute(caller(), "item_1", approvalId);

    const tools = w.auditRows.map((row) => row.toolId);
    expect(tools).toEqual([PREPARE, PUBLISH]);
    expect(w.auditRows.every((row) => row.traceId === "trace-p15-flow")).toBe(true);
    expect(w.auditRows.every((row) => row.userId === "user-1")).toBe(true);
  });

  it("audits a role's refusal by the executor too, when it is the one to refuse", async () => {
    const w = world();
    // The flow's own check is bypassed here on purpose, to show the executor
    // refuses independently: two guards, neither relying on the other.
    const direct = new MarketingPublishFlow({
      executor: w.executor,
      approvals: w.store,
      tools: w.registry,
      permissions: { checkToolPermissions: () => true },
    });

    const result = await direct.request(caller("viewer"), "item_1");

    // The publish check is a read, so a viewer may run it and an approval row
    // is created — which is exactly why the flow checks the role first.
    const { approvalId } = asking(result);
    w.store.decide(approvalId, "approved");
    const run = await direct.execute(caller("viewer"), "item_1", approvalId);

    expect(run.status).toBe("FORBIDDEN");
    expect(w.published).toHaveLength(0);
    expect(w.store.status(approvalId)).toBe("approved");
  });
});
