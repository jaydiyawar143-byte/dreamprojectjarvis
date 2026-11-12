// ---------------------------------------------------------------------------
// VO-2.1 — the in-memory twin of `PrismaTaskRepository.countByStatus`.
//
// The task tests build their own small stores. This is the one counting rule
// they share, so a fake cannot drift into a different answer from the real
// `GROUP BY status`: the caller's rows only, narrowed by creator when asked,
// every lifecycle state present (zero when none), nothing outside the
// lifecycle counted.
// ---------------------------------------------------------------------------

import { TaskStatusSchema, type TaskStatus } from "@jarvis/core";

interface CountableRow {
  userId: string;
  status: string;
  createdBy: string | null;
}

export function countTaskRows(
  rows: Iterable<CountableRow>,
  userId: string,
  options: { createdBy?: string } = {}
): Record<TaskStatus, number> {
  const counts = Object.fromEntries(
    TaskStatusSchema.options.map((status) => [status, 0])
  ) as Record<TaskStatus, number>;

  for (const row of rows) {
    if (row.userId !== userId) continue;
    if (options.createdBy !== undefined && row.createdBy !== options.createdBy) continue;
    const parsed = TaskStatusSchema.safeParse(row.status);
    if (parsed.success) counts[parsed.data] += 1;
  }

  return counts;
}
