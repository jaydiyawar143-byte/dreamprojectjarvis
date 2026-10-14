// ---------------------------------------------------------------------------
// Phase 15 — publishing from the Marketing page.
//
// WHAT A BUTTON DOES. Exactly what a sentence in chat does, in the same two
// steps, with a person between them:
//
//   REQUEST   an approval row is created for the publish tool, bound to the
//             exact parameters — the saved text and the place — that the
//             publish check built on the server. Nothing is sent anywhere.
//   EXECUTE   once the person has approved THAT row, the publish tool is run
//             through `ToolExecutor` with that approval's id. The tool consumes
//             the approval in the durable step that claims the execution, so
//             one approval publishes at most once.
//
// THIS FILE PUBLISHES NOTHING AND APPROVES NOTHING. It holds the executor, the
// approval store and the tool registry, and it sequences them. The decision is
// made on the Approvals API (`decideApproval`, one conditional UPDATE); the
// post is made by the tool; every check that matters — permission, parameter
// binding, expiry, the saved text against the approved text — is made by the
// executor and the tool, not here.
//
// WHY EXECUTION ALWAYS NAMES ITS APPROVAL. `ToolExecutor` can also find an
// approval by itself, by looking through the user's recent approvals for the
// tool. On that path a rejected approval for ANY parameters shadows a new
// request for different ones (see docs/phases/phase-15.md, finding F-2). Naming
// the approval takes the other branch, which looks at that one row and nothing
// else — so declining to publish one post never blocks publishing another.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import {
  APPROVAL_TTL_MS,
  MARKETING_TOOL_IDS,
  PUBLISH_LOOK_ONLY_CODES,
  computeParamsHash,
  type Approval,
  type ContentItemView,
  type ITool,
  type IToolExecutor,
  type PublishParams,
  type PublishPreparation,
  type Role,
  type ToolExecutionResult,
  type ToolPermission,
} from "@jarvis/core";
import { isPublishParams } from "@jarvis/tools";
import { buildApprovalSummary, type ApprovalSummary } from "../approval-summary.js";

export interface PublishFlowDeps {
  executor: Pick<IToolExecutor, "execute">;
  approvals: {
    create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval>;
    findByIdForUser(id: string, userId: string): Promise<Approval | null>;
    listByUser(userId: string, options?: { status?: Approval["status"]; page?: number; limit?: number }): Promise<{ items: Approval[]; total: number }>;
  };
  tools: { get(toolId: string): ITool | undefined };
  /** The same role table the executor checks against. */
  permissions: { checkToolPermissions(role: Role, required: ToolPermission[]): boolean };
  /**
   * Why publishing is unavailable here, when it is — switched off, or not
   * configured. Said to the caller in place of the general sentence.
   */
  unavailableMessage?: string;
  now?: () => Date;
}

export interface PublishCaller {
  userId: string;
  role: Role;
  /** A project the screen is showing, when one is selected. */
  projectId?: string;
  traceId?: string;
  ipAddress?: string;
}

/** Why the screen is being asked to show an approval. */
export type ApprovalAsk =
  /** A new request was just made. */
  | "REQUESTED"
  /** A request for exactly this already exists and is still waiting. */
  | "WAITING"
  /** The earlier request ran out of time; this is a fresh one. */
  | "EXPIRED";

export type PublishFlowResult =
  | { status: "UNAVAILABLE"; message: string }
  | { status: "FORBIDDEN"; message: string }
  | { status: "NOT_FOUND"; message: string }
  | {
      status: "NOT_READY";
      message: string;
      preparation: PublishPreparation | null;
      /** Set when the publish tool itself refused, after the approval: which check failed. */
      reason?: string;
    }
  | {
      status: "APPROVAL_REQUIRED";
      ask: ApprovalAsk;
      approvalId: string;
      expiresAt: string;
      /** Exactly what will be posted and where — the parameters the approval is bound to. */
      params: PublishParams;
      summary: ApprovalSummary;
    }
  | { status: "DECLINED"; message: string }
  | { status: "PUBLISHED"; message: string; alreadyPublished: boolean; item: ContentItemView | null }
  /**
   * The item's publish is not confirmed. `reason` is the specific outcome;
   * `sentNothing` is true when this request only looked for an earlier
   * attempt's post and sent nothing itself.
   */
  | { status: "UNCONFIRMED"; message: string; reason?: string; sentNothing?: boolean }
  /** The caller has asked the provider too often for now. Nothing was started. */
  | { status: "RATE_LIMITED"; message: string }
  /** `reason` is the specific failure. It is never the envelope's code: that is always this status. */
  | { status: "FAILED"; reason: string; message: string };

const PUBLISH = MARKETING_TOOL_IDS.contentPublish;
const PREPARE = MARKETING_TOOL_IDS.publishPrepare;

/** What the publish tool reports when it refused BEFORE sending anything. */
const NOTHING_SENT: ReadonlySet<string> = new Set(["NOT_READY", "STALE", "TARGET_REFUSED", "IN_PROGRESS"]);

export class MarketingPublishFlow {
  private readonly now: () => Date;
  /** Said whenever the publish tools are not registered here. No approval is ever created then. */
  private readonly unavailable: PublishFlowResult;

  constructor(private readonly deps: PublishFlowDeps) {
    this.now = deps.now ?? (() => new Date());
    this.unavailable = {
      status: "UNAVAILABLE",
      message: deps.unavailableMessage ?? "Publishing is not available on this server: JARVIS has no publishing connection configured.",
    };
  }

  /** Whether this caller's role may publish at all — the tool's own requirement, the executor's own table. */
  private mayPublish(caller: PublishCaller, tool: ITool): boolean {
    return this.deps.permissions.checkToolPermissions(caller.role, tool.requiredPermissions);
  }

  private ask(approval: Approval, params: PublishParams, ask: ApprovalAsk): PublishFlowResult {
    return {
      status: "APPROVAL_REQUIRED",
      ask,
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      params,
      summary: buildApprovalSummary(PUBLISH, { ...params }),
    };
  }

  /**
   * Ask to publish one content item.
   *
   * Runs the publish check (a read, through the executor). If the item can be
   * published, returns an approval for the exact parameters — the one already
   * waiting for them, or a new one. If the person has ALREADY approved these
   * exact parameters, publishes.
   */
  async request(caller: PublishCaller, contentId: string, targetId?: string): Promise<PublishFlowResult> {
    const tool = this.deps.tools.get(PUBLISH);
    if (!tool || !this.deps.tools.get(PREPARE)) return this.unavailable;
    // Refused BEFORE an approval row exists: a request nobody could ever act
    // on should not sit in front of a person asking to be approved.
    if (!this.mayPublish(caller, tool)) {
      return { status: "FORBIDDEN", message: "Your role cannot publish content." };
    }

    const check = await this.deps.executor.execute({
      toolId: PREPARE,
      params: { contentId, ...(targetId ? { targetId } : {}), ...(caller.projectId ? { projectId: caller.projectId } : {}) },
      userId: caller.userId,
      role: caller.role,
      traceId: caller.traceId ?? randomUUID(),
      ...(caller.ipAddress ? { ipAddress: caller.ipAddress } : {}),
    });
    if (check.status === "permission_denied") return { status: "FORBIDDEN", message: "Your role cannot publish content." };
    if (check.status !== "completed" || !check.result?.success) {
      const code = check.result?.metadata?.code;
      const message = check.result?.error ?? check.error ?? "The item could not be checked for publishing.";
      // The check is metered, and it was refused before the provider was asked.
      if (code === "RATE_LIMITED") return { status: "RATE_LIMITED", message };
      if (code === "UNAVAILABLE") return { status: "UNAVAILABLE", message };
      return code === "NOT_FOUND" || code === "OUT_OF_SCOPE"
        ? { status: "NOT_FOUND", message }
        : { status: "NOT_READY", message, preparation: null };
    }

    const preparation = check.result.data as PublishPreparation;
    const params = preparation.publishParams;
    if (!preparation.ready || !params || !isPublishParams({ ...params })) {
      return {
        status: "NOT_READY",
        message: preparation.blockers[0] ?? "This item cannot be published yet.",
        preparation,
      };
    }

    const paramsHash = computeParamsHash({ ...params });
    const bound = (approval: Approval): boolean => approval.toolId === PUBLISH && approval.paramsHash === paramsHash;

    // Already approved, for exactly this text going to exactly this place?
    // Then the decision has been made and there is nothing left to ask.
    const approved = (await this.deps.approvals.listByUser(caller.userId, { status: "approved", limit: 100 })).items.find(bound);
    if (approved) return this.run(caller, approved.id, params);

    // Already waiting? Show that one rather than piling up a second.
    const waiting = (await this.deps.approvals.listByUser(caller.userId, { status: "pending", limit: 100 })).items.find(bound);
    if (waiting) return this.ask(waiting, params, "WAITING");

    return this.ask(await this.createApproval(caller, tool, params, paramsHash), params, "REQUESTED");
  }

  /**
   * Publish, for an approval the person has decided.
   *
   * The approval is read for THIS user and must be for this content item.
   * What happens next depends only on what was decided about that one row.
   */
  async execute(caller: PublishCaller, contentId: string, approvalId: string): Promise<PublishFlowResult> {
    const tool = this.deps.tools.get(PUBLISH);
    if (!tool) return this.unavailable;
    if (!this.mayPublish(caller, tool)) return { status: "FORBIDDEN", message: "Your role cannot publish content." };

    const approval = await this.deps.approvals.findByIdForUser(approvalId, caller.userId);
    // Another user's approval, an approval for another tool or for another
    // item, and an id that does not exist are one answer.
    if (!approval || approval.toolId !== PUBLISH || !isPublishParams(approval.params) || approval.params.contentId !== contentId) {
      return { status: "NOT_FOUND", message: "That approval was not found for this item." };
    }
    const params: PublishParams = {
      contentId: approval.params.contentId,
      targetId: approval.params.targetId,
      targetName: approval.params.targetName,
      message: approval.params.message,
      ...(approval.params.link !== undefined ? { link: approval.params.link } : {}),
      // Whether this approval was for a look, and for which earlier attempt.
      // Part of what was approved, so it is carried exactly as it was bound.
      ...(approval.params.earlierAttempt !== undefined ? { earlierAttempt: approval.params.earlierAttempt } : {}),
    };

    switch (approval.status) {
      case "approved":
        return this.run(caller, approval.id, params);
      case "pending":
        return this.ask(approval, params, "WAITING");
      case "rejected":
        return { status: "DECLINED", message: "You declined this publish, so nothing was posted. Ask again if you have changed your mind." };
      case "consumed":
        return { status: "FAILED", reason: "APPROVAL_ALREADY_USED", message: "That approval was already used. Nothing new was posted." };
      default:
        // Expired. The decision was never made in time, so it is asked again —
        // for the item as it is saved NOW, through the same check.
        return this.expired(await this.request(caller, contentId, params.targetId));
    }
  }

  private expired(result: PublishFlowResult): PublishFlowResult {
    return result.status === "APPROVAL_REQUIRED" && result.ask === "REQUESTED" ? { ...result, ask: "EXPIRED" } : result;
  }

  private createApproval(caller: PublishCaller, tool: ITool, params: PublishParams, paramsHash: string): Promise<Approval> {
    return this.deps.approvals.create({
      userId: caller.userId,
      toolId: PUBLISH,
      action: tool.name,
      params: { ...params },
      paramsHash,
      riskLevel: tool.risk,
      // The one approval lifetime every surface uses. Never extended.
      expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS).toISOString(),
    });
  }

  /** Run the publish tool, naming the approval that authorises it. */
  private async run(caller: PublishCaller, approvalId: string, params: PublishParams): Promise<PublishFlowResult> {
    let run: ToolExecutionResult;
    try {
      run = await this.deps.executor.execute({
        toolId: PUBLISH,
        params: { ...params },
        userId: caller.userId,
        role: caller.role,
        approvalId,
        traceId: caller.traceId ?? randomUUID(),
        ...(caller.ipAddress ? { ipAddress: caller.ipAddress } : {}),
      });
    } catch {
      // The executor reports outcomes as values. If it threw, nothing is known.
      return {
        status: "UNCONFIRMED",
        message: "The publish did not report an outcome, so it is not known whether the post went out. It is NOT marked as published. Check the Page before trying again.",
      };
    }

    const data = (run.result?.data ?? null) as { status?: string; message?: string; item?: ContentItemView | null } | null;
    const outcome = run.result?.metadata?.status;
    const code = typeof run.result?.metadata?.code === "string" ? run.result.metadata.code : undefined;
    const said = run.result?.error ?? run.error;

    switch (run.status) {
      case "completed":
        if (run.result?.success) {
          return {
            status: "PUBLISHED",
            alreadyPublished: data?.status === "ALREADY_PUBLISHED",
            message: data?.message ?? "Published.",
            item: data?.item ?? null,
          };
        }
        break;
      case "permission_denied":
        return { status: "FORBIDDEN", message: "Your role cannot publish content." };
      case "approval_denied":
        return { status: "DECLINED", message: "This publish was declined, so nothing was posted." };
      case "approval_pending":
      case "approval_required":
        // The executor could not use the approval it was given and asked for
        // another. Whatever the reason, nothing ran.
        if (run.approvalId) {
          const fresh = await this.deps.approvals.findByIdForUser(run.approvalId, caller.userId);
          if (fresh) return this.ask(fresh, params, "EXPIRED");
        }
        return { status: "FAILED", reason: "APPROVAL_NOT_USABLE", message: "That approval could not be used. Nothing was posted. Ask again." };
      case "timed_out":
        // The deadline passed WHILE the tool was running. A request may have
        // gone out; nothing here can say.
        return {
          status: "UNCONFIRMED",
          message: "The publish did not finish in time, so it is not known whether the post went out. It is NOT marked as published. Check the Page before trying again.",
        };
      default:
        break;
    }

    if (outcome === "UNCONFIRMED") {
      return {
        status: "UNCONFIRMED",
        message: said ?? "The outcome of the publish is not known. It is NOT marked as published.",
        ...(code ? { reason: code, sentNothing: PUBLISH_LOOK_ONLY_CODES.includes(code) } : {}),
      };
    }
    // The tool checked again, after the approval, and refused before sending
    // anything: the item, its text or the Page was no longer what was approved,
    // or another publish of it was running. A conflict with the saved state —
    // not a failure of the provider.
    if (typeof outcome === "string" && NOTHING_SENT.has(outcome)) {
      return { status: "NOT_READY", reason: outcome, message: said ?? "This item could not be published as approved. Nothing was posted.", preparation: null };
    }
    return {
      status: "FAILED",
      reason: typeof outcome === "string" ? outcome : "PUBLISH_FAILED",
      message: said ?? "The publish failed. Nothing was published.",
    };
  }
}
