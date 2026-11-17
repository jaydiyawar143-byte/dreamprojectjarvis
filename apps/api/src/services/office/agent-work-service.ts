// ---------------------------------------------------------------------------
// VO-3.1 — what each agent is doing, from the durable rows.
//
// The office's per-agent read. It answers, for ONE user (the caller):
//
//   active            the task the agent is on: RUNNING first, then work the
//                     scheduler has claimed, then the next queued task;
//   queuedCount       how many of the caller's PENDING tasks are assigned to it;
//   lastCompleted     its most recently completed task;
//   lastFailed        its most recently failed (or unresolved) task;
//   pendingApprovals  the caller's PENDING, unexpired approvals the agent asked
//                     for — the authoritative "waiting for approval" source
//                     VO-1 deferred to VO-3.
//
// Every read is scoped to the caller FIRST: tasks through TaskService (user,
// then JARVIS work), approvals through the repository's `listByUser`, which
// returns only the requester's own. An agent id never widens either read, so
// nothing here can show one user another user's work, whatever agent they
// share. Agents themselves are the deployment's (the registry), not anyone's.
//
// It runs nothing, approves nothing and writes nothing. Parameters never leave
// this service: an approval contributes its tool, its times and a count.
// ---------------------------------------------------------------------------

import type { AgentWorkRows, TaskRecord } from "@jarvis/db";

/** One task as the office sees it. Ids, times, the title and the reason only. */
export interface OfficeTaskView {
  taskId: string;
  title: string;
  status: string;
  /**
   * The run's id, which its audit row carries in `metadata.executionId`. The
   * executor writes no agent on a task run's audit row (see VO-3.1), so this
   * is how the office attributes that row to the agent the task is assigned to.
   */
  executionId: string | null;
  toolId: string | null;
  /** The tool's declared risk, from the registry that gates execution. */
  toolRisk: string | null;
  assignedAt: string | null;
  startedAt: string | null;
  scheduledAt: string | null;
  /** True once the scheduler has taken a scheduled task to run it. */
  claimed: boolean;
  /** When a terminal task finished (its last write). */
  finishedAt: string | null;
  /** Why a failed or unresolved task ended, in the user's own terms. */
  error: string | null;
}

export interface OfficePendingApprovals {
  count: number;
  newestAt: string;
  /** The tool of the newest one. */
  toolId: string;
  expiresAt: string;
}

export interface OfficeAgentWork {
  agentId: string;
  active: OfficeTaskView | null;
  queuedCount: number;
  lastCompleted: OfficeTaskView | null;
  lastFailed: OfficeTaskView | null;
  pendingApprovals: OfficePendingApprovals | null;
}

export interface OfficeAgentWorkView {
  agents: OfficeAgentWork[];
  /** False when the approvals could not be read; no agent then claims to wait. */
  approvalsRead: boolean;
  generatedAt: string;
}

interface PendingApprovalRow {
  agentId?: string;
  toolId: string;
  createdAt: string;
  expiresAt: string;
}

export interface OfficeAgentWorkDeps {
  tasks: { agentWork(userId: string): Promise<AgentWorkRows> };
  /**
   * The requester's own approvals. `listByUser` already scopes to `userId`
   * and, for "pending", to rows that have not expired.
   */
  approvals: {
    listByUser(
      userId: string,
      options: { status: "pending"; page: number; limit: number }
    ): Promise<{ items: PendingApprovalRow[]; total: number }>;
  };
  /** The registry's declared risk for a tool, or undefined for an unknown one. */
  toolRisk: (toolId: string) => string | undefined;
  now?: () => Date;
}

/** One page of pending approvals is plenty: the office shows a count. */
export const OFFICE_APPROVALS_READ_LIMIT = 100;

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

export class OfficeAgentWorkService {
  constructor(private readonly deps: OfficeAgentWorkDeps) {}

  private view(task: TaskRecord): OfficeTaskView {
    const terminal = task.status === "COMPLETED" || task.status === "FAILED" || task.status === "UNRESOLVED";
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      executionId: task.executionId ?? null,
      toolId: task.toolId ?? null,
      toolRisk: task.toolId ? this.deps.toolRisk(task.toolId) ?? null : null,
      assignedAt: iso(task.assignedAt),
      startedAt: iso(task.startedAt),
      scheduledAt: iso(task.scheduledAt),
      claimed: task.claimedAt !== null && task.claimedAt !== undefined,
      finishedAt: terminal ? iso(task.updatedAt) : null,
      error: task.status === "FAILED" || task.status === "UNRESOLVED" ? task.error ?? null : null,
    };
  }

  async forUser(userId: string): Promise<OfficeAgentWorkView> {
    const now = (this.deps.now ?? (() => new Date()))();
    const rows = await this.deps.tasks.agentWork(userId);

    let approvalsRead = true;
    let approvals: PendingApprovalRow[] = [];
    try {
      const page = await this.deps.approvals.listByUser(userId, {
        status: "pending",
        page: 1,
        limit: OFFICE_APPROVALS_READ_LIMIT,
      });
      approvals = page.items;
    } catch {
      // Not knowing is not "nobody is waiting": say it could not be read.
      approvalsRead = false;
    }

    const agents = new Map<string, OfficeAgentWork>();
    const entry = (agentId: string): OfficeAgentWork => {
      let found = agents.get(agentId);
      if (!found) {
        found = {
          agentId,
          active: null,
          queuedCount: 0,
          lastCompleted: null,
          lastFailed: null,
          pendingApprovals: null,
        };
        agents.set(agentId, found);
      }
      return found;
    };

    // Active work: RUNNING beats claimed beats queued; among queued, the one
    // due soonest (an unscheduled task is due now).
    const rank = (task: TaskRecord): number =>
      task.status === "RUNNING" ? 0 : task.claimedAt ? 1 : 2;
    const due = (task: TaskRecord): number => task.scheduledAt?.getTime() ?? -Infinity;

    for (const task of rows.active) {
      if (!task.agentId) continue;
      const agent = entry(task.agentId);
      if (task.status === "PENDING") agent.queuedCount += 1;
      const current = agent.active;
      if (!current) {
        agent.active = this.view(task);
        continue;
      }
      const currentRow = rows.active.find((row) => row.id === current.taskId)!;
      if (
        rank(task) < rank(currentRow) ||
        (rank(task) === rank(currentRow) && due(task) < due(currentRow))
      ) {
        agent.active = this.view(task);
      }
    }

    for (const task of rows.latest) {
      if (!task.agentId) continue;
      const agent = entry(task.agentId);
      if (task.status === "COMPLETED") agent.lastCompleted = this.view(task);
      else {
        // FAILED and UNRESOLVED share the slot: the newer of the two.
        const candidate = this.view(task);
        if (!agent.lastFailed || (candidate.finishedAt ?? "") > (agent.lastFailed.finishedAt ?? "")) {
          agent.lastFailed = candidate;
        }
      }
    }

    for (const approval of approvals) {
      if (!approval.agentId) continue;
      // `listByUser("pending")` already excludes expired rows; this is the
      // same rule, applied again at this instant.
      if (Date.parse(approval.expiresAt) <= now.getTime()) continue;
      const agent = entry(approval.agentId);
      const current = agent.pendingApprovals;
      if (!current) {
        agent.pendingApprovals = {
          count: 1,
          newestAt: approval.createdAt,
          toolId: approval.toolId,
          expiresAt: approval.expiresAt,
        };
      } else {
        current.count += 1;
        if (approval.createdAt > current.newestAt) {
          current.newestAt = approval.createdAt;
          current.toolId = approval.toolId;
          current.expiresAt = approval.expiresAt;
        }
      }
    }

    return {
      agents: [...agents.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)),
      approvalsRead,
      generatedAt: now.toISOString(),
    };
  }
}
