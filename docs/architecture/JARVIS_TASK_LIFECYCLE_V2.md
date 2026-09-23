# JARVIS Task Lifecycle V2

> **Status: SPECIFICATION — NOT IMPLEMENTED.**
> Sections marked **CURRENT** describe code that exists today and were derived
> by reading it. Sections marked **PROPOSED** describe behaviour that does
> **not** exist. Nothing in this document has been built, and no existing task
> record has been changed.
>
> Audit date: 2026-09-23. Repository state: Scheduler V1 complete and running.

---

## 1. Current Architecture

**CURRENT.** One table, one status enum, two surfaces reading it.

```
packages/core/src/types/task.ts          TaskStatusSchema, TRANSITIONS,
                                         canTransitionTask, JARVIS_TASK_CREATOR
packages/db/prisma/schema.prisma         model Task
packages/db/src/repositories/
  task-repository.ts                     create, list, findOwned, listByStatus,
                                         updateOwned, transitionOwned,
                                         setScheduleOwned, findDueScheduled,
                                         claimSchedule, deleteOwned
apps/api/src/services/tasks/
  task-service.ts                        createTask/getTask/listTasks/
                                         startTask/completeTask/failTask
  task-execution-service.ts              executeTask — the six-step run
  task-planner-service.ts                planTask — goal -> ONE tool call
  task-scheduler-service.ts              scheduleTask/cancelScheduledTask/
                                         getScheduledTask/runDue
  task-conversation-service.ts           the chat sequence
apps/api/src/services/task-scheduler-loop.ts   the interval sweep
packages/agents/src/work-request-detector.ts   EXECUTE/SCHEDULE/PLAN_ONLY/
                                               NEEDS_TIME/NONE
packages/agents/src/schedule-phrase.ts         phrase -> instant (SCHEDULE_ZONE)
apps/api/src/routes/tasks.ts                   the work REST surface
apps/api/src/routes/command-center.ts          the todo REST surface
apps/web/src/lib/api.ts                        TaskRecord, isJarvisTask
apps/web/src/components/widgets/tasks-widget.tsx  both surfaces on screen
```

**One table serves two different lifecycles.** `createdBy` is the
discriminator: `"jarvis"` means work, `null` means a todo typed into the
dashboard. `JARVIS_TASK_CREATOR` is the single definition of that value.

---

## 2. Current Status Semantics

**CURRENT.** Four values, defined in `TaskStatusSchema`:

| Status | Meaning in code | Terminal? |
|---|---|---|
| `PENDING` | Recorded, not started. **The only state a task may be created in.** | no |
| `RUNNING` | Work has begun. Always carries `startedAt`. | no |
| `COMPLETED` | Finished successfully. Carries `completedAt`, `error = null`. | **yes** |
| `FAILED` | Finished unsuccessfully. Carries `error`. **Deliberately no `completedAt`** — a failure is finished but not done, and the widget reads `completedAt` as "done". | **yes** |
| `UNRESOLVED` *(V2.3 Phase 1)* | The execution was **entered** and its outcome **cannot be determined**. Carries `error` as the reason the outcome is unknown. No `completedAt`. | **yes** |

### `UNRESOLVED` — what it means, and what it does not

**IMPLEMENTED (V2.3 Phase 1): the state, the transition and the service
primitive. NOT implemented: anything that sets it automatically.**

> The execution was entered, and the system cannot safely determine whether the
> external side effect occurred.

A task reaches `UNRESOLVED` only from `RUNNING`, which means `executeTask` had
already committed `PENDING -> RUNNING` and called the executor. If the process
then died before evidence was written, the tool may have reached an external
system and completed there — a campaign paused, an email sent — or it may never
have got that far. Nothing durable says which.

**It is not a synonym for `FAILED`.** `FAILED` asserts the work did not happen.
For an interrupted run that assertion may be **false**, and acting on it is how
a user redoes a write that already landed. `UNRESOLVED` asserts only what is
true: it started, and nothing more can be said.

**It is terminal, and has no retry edge.** `allowedTaskTransitions("UNRESOLVED")`
is `[]`. Re-running could duplicate a write that already succeeded, so these
are resolved by a human or by a later reconciliation with real evidence —
never by the automatic engine.

**Nothing sets it yet.** Detecting an ambiguous run is V2.3 Phase 2 and is not
implemented; a stale `RUNNING` task still stays `RUNNING`.

`PENDING` is overloaded. It covers at least four distinguishable situations
that the enum cannot currently tell apart — see §11.

---

## 3. State Ownership

**CURRENT.** `canTransitionTask` in `packages/core` is the **only** definition
of a legal move, and `TaskService.move()` is its **only** consumer. Everything
that changes a work task's status goes through `TaskService`.

### Writers of `status`

There are **two**, and only one consults the transition table.

| Writer | Path | Consults `canTransitionTask`? |
|---|---|---|
| `transitionOwned` | `TaskService.move()` → repository CAS on `status` | **yes** |
| `updateOwned` | `PATCH /command-center/tasks/:id` (the todo checkbox) | **no** |

`updateOwned` sets `status` directly from `completed`
(`task-repository.ts:171`), guarded only by `NOT: { status: "RUNNING" }`. It
can therefore perform `COMPLETED → PENDING`, which `TRANSITIONS` forbids.

> **FINDING.** This is not currently a defect for work tasks — the same route
> passes `excludeCreatedBy: JARVIS_TASK_CREATOR`, so a `createdBy = "jarvis"`
> row is unreachable from that path. It *is* a second, unguarded lifecycle
> that happens to be confined to todos. Two writers of one column, one of which
> ignores the rule table, is a structural risk if that filter is ever relaxed.

### Callers of the lifecycle methods

| Caller | Calls | Purpose |
|---|---|---|
| `TaskExecutionService.executeTask` | `startTask` → `completeTask` \| `failTask` | the run |
| `TaskSchedulerService.runOne` | `startTask` → `failTask` | mark an unplannable scheduled task |
| `PATCH /api/v1/tasks/:id/status` | all three | manual operator control |
| `task.updateStatus` tool | all three | JARVIS's own control, via the container port |

### Writers of `scheduledAt`

| Writer | Effect |
|---|---|
| `setScheduleOwned(…, date)` | sets it — `WHERE` pins `status = PENDING`, `createdBy = "jarvis"`, `userId` |
| `setScheduleOwned(…, null)` | cancels the schedule |
| `claimSchedule(…)` | sets it to `null` as the claim — **does not touch `status`** |

`findDueScheduled` reads only.

---

## 4. State Transition Matrix

**CURRENT.** Exactly the moves `TRANSITIONS` permits — nothing else is
reachable through `TaskService`.

| CURRENT | NEXT | OWNER | CONDITION |
|---|---|---|---|
| *(none)* | `PENDING` | `TaskService.createTask` | creation; the only entry state |
| `PENDING` | `RUNNING` | `TaskExecutionService` | `executeTask` step 4 — the claim, after ownership + allowlist |
| `RUNNING` | `UNRESOLVED` | `TaskService.unresolveTask` *(V2.3 Phase 1)* | an outcome that cannot be established. **No automatic caller exists** |
| `UNRESOLVED` | — | — | **terminal.** `TRANSITIONS.UNRESOLVED = []`; no retry edge |
| `PENDING` | `RUNNING` | `TaskSchedulerService` | `runOne`, only to then mark it `FAILED` when re-planning fails |
| `PENDING` | `RUNNING` | `PATCH /tasks/:id/status`, `task.updateStatus` | explicit operator or agent instruction |
| `RUNNING` | `COMPLETED` | `TaskExecutionService` | `execution.status === "completed" && result.success === true` |
| `RUNNING` | `FAILED` | `TaskExecutionService` | any other execution outcome, with a reason |
| `RUNNING` | `FAILED` | `TaskSchedulerService` | the scheduled run could not be planned |
| `RUNNING` | `COMPLETED`/`FAILED` | `PATCH /tasks/:id/status`, `task.updateStatus` | explicit instruction |
| `COMPLETED` | — | — | **terminal.** `TRANSITIONS.COMPLETED = []` |
| `FAILED` | — | — | **terminal.** `TRANSITIONS.FAILED = []` |

`PENDING` is refused as a *destination* explicitly at `tasks.ts:224`: "A task
cannot be moved back to pending."

**Todo-only path, outside the table:** `updateOwned` performs
`* → COMPLETED` and `COMPLETED → PENDING` for `createdBy = null` rows.

---

## 5. Immediate Work Lifecycle

**CURRENT.**

```
chat message
  detectWorkRequest  -> EXECUTE
  TaskConversationService.handle
    createTask(createdBy = "jarvis")      status PENDING, scheduledAt null
    planner.planTask(title, description)  -> executable? toolId + params
    execution.executeTask(...)
      ownership -> PENDING-only -> allowlist -> startTask (CAS)   status RUNNING
      ToolExecutor.execute                                        the only side effect
      completeTask | failTask                        status COMPLETED | FAILED
```

`scheduledAt` is `null` throughout. Immediate work never touches it.

If the planner returns `executable: false`, the task is **left `PENDING` with
`scheduledAt = null`** and nothing runs — one of the four meanings of `PENDING`
in §11.

---

## 6. Scheduled Work Lifecycle

**CURRENT.** What happens to `scheduledAt` at each stage:

| Stage | Component | `status` | `scheduledAt` |
|---|---|---|---|
| 1. chat, `SCHEDULE` detected | `work-request-detector` | — | — (instant held in memory as `at`) |
| 2. task created | `TaskConversationService` | `PENDING` | `null` |
| 3. feasibility pre-check | `TaskPlannerService` | `PENDING` | `null` — **not persisted**; a check, not a commitment |
| 4. scheduled | `setScheduleOwned` | `PENDING` | **set to the instant** |
| 5. discovered due | `findDueScheduled` | `PENDING` | unchanged (read only) |
| 6. **claimed** | `claimSchedule` | `PENDING` | **set back to `null`** — clearing it *is* the claim |
| 7. re-planned | `TaskPlannerService` | `PENDING` | `null` |
| 8. started | `startTask` | `RUNNING` | `null` |
| 9. settled | `completeTask`/`failTask` | `COMPLETED`/`FAILED` | `null` |

Two properties follow directly:

- **There is no second "consumed" column.** `scheduledAt IS NOT NULL` in the
  claim's `WHERE` is the compare; setting it to `null` is the set.
- **Between steps 6 and 8 a task is `PENDING` with `scheduledAt = null`** —
  byte-identical to a stale row. See §11.

Planning happens at **execution time** (step 7), from the task as it reads
then, so a title edited after scheduling is re-planned rather than trusted.
A scheduled run executes with `SCHEDULED_RUN_ROLE = "member"`, the lowest role
that reaches read-only work, and with the **owning user's** id.

**The loop:** `startTaskSchedulerLoop`, 60 s default
(`JARVIS_TASK_SCHEDULER_INTERVAL_MS`), one sweep at a time, immediate first
sweep on boot, at most 20 due tasks per sweep, `ShutdownLifecycle`-tracked as
`EXTERNAL_SIDE_EFFECT`.

---

## 7. Failure Lifecycle

**CURRENT.** All derived from code; none of it is aspirational.

**When execution fails.** `executeTask` step 6 treats anything that is not
`status === "completed" && result.success === true` as a failure:
`failTask(taskId, describeFailure(execution))` → `FAILED` with a sentence in
`error`. `completedAt` stays `null` deliberately.

**Approval-gated actions** become `FAILED`, not a pending-approval state. V1
has no `PENDING_APPROVAL`; `describeFailure` writes a message saying what to do
instead. Nothing ran outside JARVIS in that case.

**Retry: none.** `TRANSITIONS.FAILED = []` and `TRANSITIONS.COMPLETED = []`.
A terminal task is terminal. `executeTask` step 2 additionally refuses any task
that is not `PENDING`.

**After an API restart.** Schedules survive — the due set is a database query,
never in-process state — and the loop's immediate first sweep picks up anything
that fell due while the process was down. An overdue task runs **once**,
because the claim consumed `scheduledAt`.

**A task `RUNNING` during a crash stays `RUNNING` forever.**
- `findDueScheduled` requires `status = "PENDING"` → the scheduler skips it.
- `executeTask` step 2 requires `PENDING` → manual execution refuses it.
- `updateOwned` has `NOT: { status: "RUNNING" }` → the checkbox cannot touch it.
- Only an explicit `PATCH /tasks/:id/status` or the `task.updateStatus` tool
  can move it, and both require a human or an agent to notice.

> **FINDING.** `RUNNING` is terminal *in practice* while not being terminal in
> the table. There is no lease, no heartbeat and no reaper.

**Can `FAILED` tasks be retried?** No. **Can `PENDING` tasks be cancelled?**
No — `cancelScheduledTask` clears the *schedule* and leaves the task `PENDING`.
There is no way to cancel the task itself.

---

## 8. Cancellation — Future Contract

**PROPOSED. `CANCELLED` does not exist. Do not add it to the schema yet.**

**Which states can be cancelled**

| From | Proposed | Why |
|---|---|---|
| `PENDING` | **yes** | nothing has run; safest and the main case |
| `RUNNING` | **no, in V2** | the tool call is already in flight and `ToolExecutor` owns its own deadline; "cancelled" would claim something JARVIS cannot guarantee |
| `COMPLETED` / `FAILED` | **no** | terminal; cancelling a finished thing is meaningless |

Proposed additions: `PENDING → CANCELLED` only; `CANCELLED` terminal (`[]`).

**Who performs it.** **Both**, through the same service method, exactly as the
integration rule requires of every other operation — one implementation in
`TaskService`, reached by a REST route and by a tool. Ownership is unconditional.

**What happens to `scheduledAt`.** Cleared in the **same statement** that sets
`CANCELLED`, so a cancelled task can never be found by `findDueScheduled`.
Clearing it first and setting status second would leave a window.

**Do cancelled tasks remain visible?** **Yes.** Cancellation is a record of a
decision, not a delete. `deleteOwned` already exists for removal and is a
separate act.

**Open question — see §"Ambiguity".** Whether cancelling should be allowed on
a `PENDING` task that has *no* schedule (the stale rows) is a product decision,
not a technical one.

---

## 9. Crash Recovery — Future Contract

**PROPOSED. None of this exists.**

The problem in one line: a process that dies between `startTask` and
`completeTask` leaves a row `RUNNING` that nothing will ever move.

Three options, in ascending cost:

1. **Reaper sweep.** A periodic job moves `RUNNING` tasks whose `startedAt` is
   older than a bounded threshold to `FAILED` with an explicit reason such as
   "interrupted by a restart". Smallest change; requires a new
   `RUNNING → FAILED` owner and a threshold that is honest about the longest
   legitimate run (`ToolExecutor`'s 30 s default deadline gives a floor).
2. **Lease + heartbeat.** A `leaseExpiresAt` column refreshed while running;
   expiry makes the task reclaimable. Precedent exists in this repository —
   `ToolExecution` already has leases — but it governs provider calls, not
   user-owned work, and copying it is a bigger design decision.
3. **Startup reconciliation.** On boot, settle every `RUNNING` task owned by
   this process. Cheap, but wrong the moment there is more than one replica.

A second, narrower gap needs its own answer: a crash between `claimSchedule`
and `startTask` consumes the schedule and leaves the task `PENDING` with
`scheduledAt = null` — **silently unscheduled, indistinguishable from a stale
row**, and it will never run.

---

## 10. Idempotency

**CURRENT. Can the same task execute twice? No — two independent gates stop it.**

**Gate 1 — the schedule claim.**
```sql
UPDATE "Task" SET scheduled_at = NULL
WHERE id = ? AND created_by = 'jarvis'
  AND status = 'PENDING' AND scheduled_at IS NOT NULL
```
`count === 1` means this caller won. Applies across ticks, sweeps **and
replicas**: N processes sweeping produce exactly one winner and N−1 no-ops.

**Gate 2 — the status claim.** `startTask` → `transitionOwned`, whose `WHERE`
pins `status = expectedFrom`. Two callers arriving together produce one winner;
the loser matches zero rows and returns `ALREADY_CLAIMED`.

Neither is a read-then-write. The loop adds a third, weaker guard: a tick
arriving mid-sweep joins the in-flight promise rather than starting a second.

**Verified** by `scheduler-v1.test.ts` cases K (two concurrent sweeps) and K2
(two scheduler *processes* over the same rows): exactly one `executed`, the
tool called once, the planner invoked once.

**The residual risk is not double execution, it is lost execution** — the
claim/start window in §9. Losing a run is the safer failure of the two, and it
is the one the current design takes.

---

## 11. Stale / Unscheduled Tasks

**CURRENT.** `PENDING + scheduledAt = null` is **not one state**. It is at
least four, and the schema cannot distinguish them:

| Situation | How it arises | Will it ever run? |
|---|---|---|
| **A. Awaiting an immediate run** | created, planner not yet called | yes, within the same request |
| **B. Intentionally unscheduled** | `PLAN_ONLY`, or a plan that was not executable — recorded, no time given | **no** |
| **C. Claimed, not yet started** | between `claimSchedule` and `startTask` | yes, within milliseconds |
| **D. Stale** | created before the goal-cleaning fix; recorded and abandoned | **no** |

**Answer to the audit question.** `PENDING + scheduledAt = null` today means
**"recorded, and not currently eligible for the scheduler"** — nothing more.
It is *not* an invalid state: B is a legitimate resting place the code produces
deliberately, and C is a correct transient. Calling it invalid would
misdescribe two of the four.

**PROPOSED — how V2 should distinguish them without touching existing rows.**

The distinction must be **derivable**, not migrated, because historical rows
cannot be reinterpreted retroactively without guessing at intent:

- **C becomes unambiguous** by collapsing the window: claim and start in one
  statement, or record the claim distinctly from the schedule. Then
  `PENDING + null` no longer includes a transient.
- **A becomes unambiguous** because it never outlives a request.
- **B vs D cannot be separated from the data as it stands.** Both are
  "recorded, no time, no plan". Separating them needs a new fact recorded *at
  creation time* — a nullable `plannedOutcome` or an explicit `UNSCHEDULED`
  marker — which applies to new rows only. **Existing rows stay as they are
  and read as B**, which is the truthful default: nothing will run them, and
  the system is not claiming otherwise.

The frontend already does the derivable half of this today, as a label only:
`PENDING && !scheduledAt` renders **"Unscheduled"**. That is presentation, not
state, and it changes nothing in the database.

---

## 12. Frontend Lifecycle Semantics

**CURRENT** (implemented in `tasks-widget.tsx`): groups `RUNNING → PENDING →
FAILED → COMPLETED`, empty groups omitted, counts per group, read-only rows
with no complete/delete control, `Scheduled …` / `Unscheduled` /
`Failed — <reason>` as a secondary line.

**PROPOSED** — what each state should eventually show:

| State | Label | Secondary line | Controls |
|---|---|---|---|
| `PENDING` + schedule | **Scheduled** | `Scheduled 23 Sep, 10:00` | Cancel *(when §8 exists)* |
| `PENDING` + no schedule | **Pending** | `Unscheduled` | Schedule…, Cancel *(future)* |
| `RUNNING` | **Running** | `Started 10:00` | none |
| `COMPLETED` | **Done** | tool + completion time | none |
| `FAILED` | **Failed** | the reason, in the user's terms | Retry *(only if retry is ever designed)* |
| `CANCELLED` *(future)* | **Cancelled** | who cancelled it, when | none |
| `UNSCHEDULED` | **not a status** — a derived label on `PENDING` | | |

`SCHEDULED` and `UNSCHEDULED` should stay **derived**, not stored. They are
functions of `(status, scheduledAt)`, and storing them would create a second
source of truth that can disagree with the column it was derived from.

---

## 13. Invariants

**CURRENT** — hold today, verified in code:

1. `canTransitionTask` is the only definition of a legal move for work tasks.
2. A new task is always created `PENDING`.
3. `COMPLETED` and `FAILED` are terminal.
4. `RUNNING` always carries `startedAt`; `COMPLETED` always carries
   `completedAt`; `FAILED` never carries `completedAt`.
5. Every status change is a compare-and-set pinning the expected current value.
6. Every task query is filtered by `userId`, unconditionally.
7. Only `createdBy = "jarvis"` rows can be scheduled.
8. A schedule is consumed exactly once.
9. A scheduled run reaches the same permission and approval checks as an
   immediate one; a schedule grants nothing.
10. `ToolExecutor` is the only path to a side effect.

**PROPOSED** — must hold after V2:

11. A task in a terminal state is never re-entered without an explicit,
    designed transition.
12. `scheduledAt != null` implies `status = PENDING`.
13. No task can be `RUNNING` for longer than a bounded, stated interval.
14. Every state a task can rest in is distinguishable from every other.

---

## 14. Current Limitations

**CURRENT.** Each is real and checkable in the code.

| # | Limitation | Consequence |
|---|---|---|
| L1 | No retry | a `FAILED` task is final; re-asking means a new task |
| L2 | No cancellation | a `PENDING` task cannot be stopped, only unscheduled |
| L3 | `RUNNING` is stuck after a crash | needs manual `PATCH`; no reaper |
| L4 | Claim/start window | a crash there loses the run **silently** |
| L5 | `PENDING` is four states | stale and intentional work are indistinguishable |
| L6 | No `PENDING_APPROVAL` | approval-gated scheduled writes always land `FAILED` |
| L7 | Two `status` writers | `updateOwned` bypasses the transition table |
| L8 | No per-user timezone | `SCHEDULE_ZONE` is deployment-wide |
| L9 | No plan persisted | a schedule accepted today can be unplannable at run time |
| L10 | 20 due tasks per sweep | a large backlog drains over several minutes |
| L11 | `tasks.list` tool still excludes work | JARVIS cannot see its own work tasks in chat |

---

## 15. Recommended V2 Implementation Phases

**PROPOSED.** Ordered by *risk removed per unit of change*, smallest first.

| Phase | Scope | Removes | Schema change? |
|---|---|---|---|
| **V2.1** | Close the claim/start window — claim and start atomically | L4 | no |
| **V2.2** | Reaper for `RUNNING` past a bounded age → `FAILED` with a stated reason | L3 | no |
| **V2.3** | `CANCELLED` state + `PENDING → CANCELLED`, one service method, REST + tool | L2 | **yes** — additive enum value |
| **V2.4** | Route `updateOwned`'s completion through `TaskService` so one table governs both surfaces | L7 | no |
| **V2.5** | Record *why* a task is unscheduled, at creation time, new rows only | L5 | **yes** — additive nullable column |
| **V2.6** | Retry semantics, if wanted: `FAILED → PENDING` with an attempt count | L1 | **yes** |
| **V2.7** | Per-user timezone | L8 | **yes** |

V2.1, V2.2 and V2.4 need **no migration** and remove the two failure modes that
lose or strand work. They are the honest starting point.

---

## MUST NOT be changed without a migration plan

These are load-bearing. Changing any of them silently breaks stored data,
a security boundary, or both.

1. **`JARVIS_TASK_CREATOR = "jarvis"`.** It is the discriminator for every
   existing row. Changing the value orphans every work task in the database.
2. **`scheduledAt` as the consumption marker.** Adding a separate "consumed"
   column, or ceasing to clear it on claim, breaks the exactly-once guarantee
   that has no other implementation.
3. **The `claimSchedule` `WHERE` clause.** Removing `scheduled_at IS NOT NULL`
   or `status = 'PENDING'` turns the compare-and-set into a plain update and
   permits double execution across replicas.
4. **`TRANSITIONS` as the single source of truth.** Adding a state without
   adding its edges makes it unreachable; adding an edge without an owner makes
   it unattributable.
5. **The `userId` filter on every query.** It is unconditional everywhere and
   is the only tenant boundary.
6. **`excludeCreatedBy` on `PATCH` and `DELETE` in `command-center.ts`.**
   Removing it lets the todo UI rename a task the scheduler re-plans from at
   run time, changing what a scheduled task does between agreement and
   execution.
7. **`createdByIsNot`'s null-safe form.** `NOT created_by = 'jarvis'` and
   `created_by <> 'jarvis'` both drop `NULL` rows in SQL's three-valued logic —
   and `NULL` is the normal case for a todo. Reverting to either empties the
   todo list.
8. **`FAILED` not setting `completedAt`.** The widget reads `completedAt` as
   "done"; setting it would silently check off failures.
9. **`SCHEDULED_RUN_ROLE = "member"`.** Raising it would let a schedule run
   later with more authority than the moment it was created.
10. **`SCHEDULE_ZONE` as an explicit constant.** Reverting to `setHours` /
    ambient `TZ` reintroduces the bug where a UTC container resolved spoken
    times 5½ hours off.
11. **Existing `PENDING + scheduledAt = null` rows.** They must not be
    retroactively reinterpreted, completed or deleted by a migration. Their
    original intent is not recoverable from the data.
