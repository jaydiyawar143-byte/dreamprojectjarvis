// ---------------------------------------------------------------------------
// V3 — tasks and reminders.
//
// Every method takes `userId` as its FIRST argument and filters on it, without
// exception. That is the tenant boundary: there is no method here that can
// return or mutate another user's task, so a route cannot leak one by
// forgetting a filter. `updateOwned` and `deleteOwned` use updateMany/deleteMany
// with the userId in the WHERE clause rather than a findUnique-then-write, which
// makes ownership part of the same atomic statement instead of a check that
// could race.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";

export type TaskPriority = "LOW" | "NORMAL" | "HIGH";

export interface TaskRecord {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  dueAt: Date | null;
  priority: string;
  completedAt: Date | null;
  remindedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  dueAt?: Date | null;
  priority?: TaskPriority;
  /** Which agent created it, when it did not come from the UI. */
  createdBy?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  dueAt?: Date | null;
  priority?: TaskPriority;
  /** true completes, false reopens. Omitted leaves completion untouched. */
  completed?: boolean;
}

export class PrismaTaskRepository {
  constructor(private prisma: PrismaClient) {}

  async create(userId: string, input: CreateTaskInput): Promise<TaskRecord> {
    return this.prisma.task.create({
      data: {
        userId,
        title: input.title,
        description: input.description ?? null,
        dueAt: input.dueAt ?? null,
        priority: input.priority ?? "NORMAL",
        createdBy: input.createdBy ?? null,
      },
    }) as unknown as Promise<TaskRecord>;
  }

  /**
   * A user's tasks.
   *
   * Ordered so the dashboard can render without re-sorting: undated tasks last
   * (Postgres sorts NULLs first on ASC by default, which would put "someday"
   * items above things due in ten minutes).
   */
  async list(
    userId: string,
    options: { includeCompleted?: boolean; limit?: number } = {}
  ): Promise<TaskRecord[]> {
    return this.prisma.task.findMany({
      where: {
        userId,
        ...(options.includeCompleted ? {} : { completedAt: null }),
      },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: Math.min(options.limit ?? 50, 200),
    }) as unknown as Promise<TaskRecord[]>;
  }

  /**
   * Updates a task the caller owns.
   *
   * Returns null when nothing matched, which covers both "no such task" and
   * "not yours" — deliberately indistinguishable, so this cannot be used to
   * probe for the existence of another user's task.
   */
  async updateOwned(
    userId: string,
    taskId: string,
    input: UpdateTaskInput
  ): Promise<TaskRecord | null> {
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.dueAt !== undefined) data.dueAt = input.dueAt;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.completed !== undefined) {
      // Idempotent: completing an already-complete task keeps the original
      // timestamp rather than moving it.
      data.completedAt = input.completed ? new Date() : null;
    }

    if (Object.keys(data).length === 0) return this.findOwned(userId, taskId);

    const result = await this.prisma.task.updateMany({
      where: { id: taskId, userId },
      data,
    });
    if (result.count === 0) return null;

    return this.findOwned(userId, taskId);
  }

  async findOwned(userId: string, taskId: string): Promise<TaskRecord | null> {
    return this.prisma.task.findFirst({
      where: { id: taskId, userId },
    }) as unknown as Promise<TaskRecord | null>;
  }

  /** True when a row was actually removed. */
  async deleteOwned(userId: string, taskId: string): Promise<boolean> {
    const result = await this.prisma.task.deleteMany({ where: { id: taskId, userId } });
    return result.count > 0;
  }

  /**
   * Tasks that are due and have not yet had a reminder raised.
   *
   * Drives the reminder surface. `remindedAt: null` is what stops the same task
   * being announced on every poll.
   */
  async dueForReminder(userId: string, now = new Date()): Promise<TaskRecord[]> {
    return this.prisma.task.findMany({
      where: {
        userId,
        completedAt: null,
        remindedAt: null,
        dueAt: { not: null, lte: now },
      },
      orderBy: { dueAt: "asc" },
      take: 20,
    }) as unknown as Promise<TaskRecord[]>;
  }

  async markReminded(userId: string, taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) return;
    await this.prisma.task.updateMany({
      where: { userId, id: { in: taskIds } },
      data: { remindedAt: new Date() },
    });
  }
}
