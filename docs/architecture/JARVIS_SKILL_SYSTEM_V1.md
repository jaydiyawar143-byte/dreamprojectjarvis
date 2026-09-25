# JARVIS Skill System V1 — Phases S1 to S6

> **S1 — Skill Foundation.** The type, the catalogue, the derived view.
> **S2 — Skill Taxonomy & Membership Audit.** Which tool belongs to which skill,
> and why some belong to none.
> **S3 — Skill-Aware Planning.** The planner is told what actually works right
> now. It is told; it is not restricted.
> **S4 — Multi-Round Continuity.** Not a composition engine: composition
> already worked. The model simply could not remember what it had found.
> **S5 — Execution Outcome & Evaluation.** An observer beside the execution
> path: what happened, derived from AuditLog, plus one explicit user signal.
> It records; it does not steer.
> **S6 — Objective Evaluation.** Read-only, fixed-rule evaluation of whether
> each objective in the user's own request is proven, blocked or unknown.
> Contract approved; Phase 1 (objective extraction) implemented — see §7d.
>
> **Status: S1 and S2 committed (`e416a01`). S3 implemented, not committed.**
>
> **Status update (2026-09-25):** S3, S4 and S5 are committed (`d6316cc`); the
> write-intent gate in `5eadae0`. S6 PD-2 evidence capture and S6 Phase 1 are
> implemented and **not committed**. S6 Phases 2–4 are not implemented.
> **Status update (2026-09-25, later):** S6 Phase 2 (the pure evaluation
> builder) is implemented and **not committed**. Phases 3–4 are not implemented.
> **Status update (2026-09-25, Phase 3):** the read-only evaluation service,
> its trace-message reader and container wiring are implemented and **not
> committed**. Phase 4 (the HTTP route) is not implemented.
> **Status update (2026-09-25, Phase 4):** `GET /api/v1/activity/trace/:traceId/evaluation`
> is implemented and **not committed**. S6 is complete as specified; nothing
> in the product calls the endpoint yet (no UI in v1).
> Nothing here executes.
> Discovery that preceded it: [`JARVIS_SKILL_SYSTEM_V1_DISCOVERY.md`](./JARVIS_SKILL_SYSTEM_V1_DISCOVERY.md).
>
> Task Engine V2 (V2.1 / V2.2 / V2.3) was not touched.

---

## 1. What S1 actually did

It gave a name and a type to something the codebase already had.

`capability-presentation.ts` has grouped live capabilities into outcomes since
the "34 bullet points" fix: a title, a one-line summary, a set of tool-id
prefixes, and example phrasings each gated on a specific tool being usable.
That is a skill in everything but name. S1 named it.

```
  BEFORE                                  AFTER
  const GOAL_GROUPS: GoalGroupRule[]      export const SKILL_CATALOG:
                                            readonly SkillDefinition[]
  interface GoalGroupRule { … }           type GoalGroupRule = SkillDefinition
  (no type file)                          packages/core/src/types/skill.ts
  (nothing)                               buildSkillViews(report): SkillView[]
```

The list is the **same list**, in the same order, with the same contents.
`const GOAL_GROUPS = SKILL_CATALOG` keeps the internal prose reading as it did.
There is no second catalogue, no migration of data, and no rename churn —
`SkillDefinition` was fitted to the field names the rules already used
(`id`, `title`, `summary`, `prefixes`, `exact`, `phrases`), not the other way
round.

**Consequence:** "What can you do?" answers exactly as it did before S1. That is
asserted, not hoped — see §6 F.

---

## 2. What a Skill is here

| Concept | Question it answers | Where it lives |
|---|---|---|
| **Tool** | what single operation can I execute? | `ITool`, `ToolRegistry` |
| **Skill** | what **outcome** can I provide? | `types/skill.ts` + `SKILL_CATALOG` |
| **Agent** | how do I reason about this domain? | `AGENT_POLICIES` |
| **Integration** | which external system am I connected to? | `INTEGRATION_CATALOG` |
| **Provider** | which implementation performs the call? | `packages/meta-graph`, … |
| **Workflow** | which sequence produces the outcome? | not built |

A skill is **metadata**. There is no `execute()` on anything in `types/skill.ts`,
and the file imports nothing but `CapabilityAvailability`. Running a skill goes
the way everything already goes:

```
  Skill ──► Planner / Agent ──► ToolExecutor ──► Tool
```

A second path would put work outside the permission check, the approval gate,
the shutdown gate, the deadline and the audit row — every one of which lives in
`ToolExecutor` and nowhere else.

---

## 3. Files touched

| File | Change |
|---|---|
| `packages/core/src/types/skill.ts` | **new.** `SkillExample`, `SkillDefinition`, `SkillView`. Types only. |
| `packages/core/src/capability-presentation.ts` | `GOAL_GROUPS` → `SKILL_CATALOG` (in place); added `skillForToolId()`, `buildSkillViews()`, and `youCanAskFor()` extracted so the briefing and the skill view share one derivation. |
| `packages/core/src/index.ts` | exports `./types/skill.js`. |
| `packages/core/test/skill-foundation-s1.test.ts` | **new.** 38 tests. |
| `packages/agents/test/skill-catalog-authorization.test.ts` | **new.** 10 tests (S1) → 16 (S2). |

**Phase S2 added:**

| File | Change |
|---|---|
| `packages/core/src/types/skill.ts` | `UnlistedTool` — an id plus the reason it is in no skill. |
| `packages/core/src/capability-presentation.ts` | advertising: `exact` Google Ads ids, phantom prefixes dropped; research: `exact` `web.research` + `document.analyze`, phantom phrase dropped; new `SKILL_UNLISTED_TOOLS` and `SKILL_TASK_NAMESPACES`. |
| `packages/core/test/skill-membership-s2.test.ts` | **new.** 26 tests. |

**Phase S3 added:**

| File | Change |
|---|---|
| `packages/core/src/types/skill.ts` | `SkillContext` — the reduced, model-facing projection. Types only. |
| `packages/core/src/capability-presentation.ts` | `buildSkillContext()`, `renderSkillContext()`, and `summarizeMembers()` extracted so the view and the context share one fold. |
| `packages/core/src/types/orchestrator.ts` | `ISkillContextProvider` and the nullable `skillContext` config entry. |
| `packages/agents/src/orchestrator.ts` | the nullable port, `buildSkillBlock()`, and one more entry on the existing `Promise.all`. |
| `apps/api/src/services/container.ts` | wires the port from the existing `CapabilityService`. |
| `packages/core/test/skill-context-s3.test.ts` | **new.** 25 tests. |
| `packages/agents/test/skill-aware-planning-s3.test.ts` | **new.** 18 tests. |

**Phase S4 added:**

| File | Change |
|---|---|
| `packages/agents/src/tool-rounds.ts` | **new.** `ToolRound`, `buildRoundMessages()`, `budgetedEnvelopes()`, the budget constant. Pure — no state, no I/O. |
| `packages/agents/src/domain-agent.ts` | state holds rounds; builder delegates. **Shorter.** |
| `packages/agents/src/agents/conversational-assistant.ts` | same. **Shorter.** |
| `packages/agents/src/agents/meta-ads-agent.ts` | same. **Shorter.** |
| `packages/agents/src/index.ts` | exports the helper. |
| `packages/core/src/capability-presentation.ts` | `skillsForToolIds()` — derived skill participation. |
| `packages/agents/test/multi-round-continuity-s4.test.ts` | **new.** 19 tests. |
| `packages/agents/test/tool-rounds-budget-s4.test.ts` | **new.** 15 tests. |

**Phase S5 added:**

| File | Change |
|---|---|
| `packages/core/src/execution-outcome.ts` | **new.** `UserFeedback`, `ExecutionOutcome`, `buildExecutionOutcome()`. Pure — no state, no I/O. |
| `packages/core/src/index.ts` | exports it. |
| `packages/db/src/repositories/audit-repository.ts` | `findByTrace()` — bounded read, **no index, no migration**. |
| `apps/api/src/services/execution-outcome-service.ts` | **new.** Two operations: `outcome()`, `record()`. |
| `apps/api/src/routes/activity.ts` | `GET /activity/trace/:traceId`, `POST /activity/trace/:traceId/feedback`. |
| `apps/api/src/services/container.ts` | wires it from the existing audit repo and logger. |
| `apps/web` | 👍/👎 on the existing `MessageActions`; `traceId` carried on the message. |
| `packages/core/test/execution-outcome-s5.test.ts` | **new.** 34 tests. |
| `apps/api/test/execution-outcome-s5.test.ts` | **new.** 18 tests. |

No schema, no migration, no policy change, no executor change.

No orchestrator loop change, no policy change, no executor change, no schema.

Nothing else. No route, no tool, no agent, no policy, no schema, no migration,
no frontend.

---

## 4. Availability is derived, never stored

Every field of a `SkillView` comes from the `CapabilityReport` passed in.
Nothing is read from a database or a cache, because a stored availability is a
claim that goes stale the moment a token expires.

**The headline state is the BEST member, not the weakest.** A skill is an
outcome, and an outcome with four working tools and one unconnected provider is
*partly* available, not unavailable. Reporting the weakest member would tell a
user "I cannot look at your campaigns" because one write tool needs a reconnect,
which is false. This is the semantics the briefing already used: a group is
built from usable capabilities and appears when at least one exists.

The degradation is not hidden — it is carried alongside:

| Field | Meaning |
|---|---|
| `usableCount` | members that run on request (`EXECUTABLE` or `REQUIRES_CONFIRMATION`) |
| `approvalCount` | of those, how many stop for an explicit confirmation |
| `unavailableCount` | members that cannot run right now, for any reason |
| `totalCount` | every member, usable or not |
| `blockedBy` | distinct plain-English reasons, de-duplicated |
| `toolIds` | members this build actually has a tool for (`PLANNED` excluded) |
| `youCanAsk` | phrasings whose tool is usable *now* |

So a caller can say "I can do most of this, except …" instead of picking
between an over-promise and a flat refusal.

---

## 5. Discovery is not authorization

This is the property that has to survive every later phase.

A skill naming a tool does **not** authorize it. `SkillView.toolIds` is built
only from capabilities already present in the report, and the report has been
filtered to the compile-time agent allowlist upstream by `CapabilityService`.
A definition naming a tool the policy does not permit yields a skill *without*
that member — it cannot smuggle one in.

The guarantee is structural, not procedural: **`agent-policy.ts` does not import
the catalogue.** No edit to a skill can widen a grant, even by mistake. That is
asserted directly against the source, along with the behavioural form of it
(an invented, plausible tool id is refused by every agent).

When MCP tools, learned relationships or dynamically registered providers
arrive, they may extend *discovery*. They must not extend the allowlist.

---

## 6. Tests

`packages/core/test/skill-foundation-s1.test.ts` — 38 tests

| | |
|---|---|
| **A** | every phrase is gated on a well-formed exact tool id, owned by its own skill |
| **B** | skill ids unique; no exact id claimed twice; **no prefix is a prefix of another skill's prefix** (otherwise moving a line in the catalogue would move a tool) |
| **C** | pure and deterministic; does not mutate the report; total ordering; empty report → no skills |
| **D** | cannot name a tool the report lacked; omits a skill with no member; drops a phrase whose tool is unusable; carries no callable field |
| **E** | best-member availability; counts; `PLANNED` kept out of `toolIds`; integrations de-duplicated; state changes only with the report |
| **F** | the briefing is unchanged — same group vocabulary, same titles and summaries, same `youCanAsk`, still no raw tool id |
| **G** | a newly registered tool joins its skill by prefix alone, with no catalogue edit |
| **H** | the gaps S1 deliberately left (§7), recorded so they are decided rather than discovered |
| **I** | no `packages/skills/`, no `apps/api/src/skills/`, no `skills/`; `executor.ts` has never heard of skills; `types/skill.ts` contains no function, class or arrow |

`packages/agents/test/skill-catalog-authorization.test.ts` — 10 tests, against
the **real** allowlists (85 distinct tool ids across 9 agents)

- a skill cannot grant an agent a tool its own policy omits
- an invented member id is refused by every agent
- `agent-policy.ts` does not reference the catalogue (asserted on the source)
- every allowlisted tool maps to at most one skill; resolution is deterministic
- \>90 % of real tools have a skill
- the coverage census: **every** allowlisted tool is a member or is listed in
  `SKILL_UNLISTED_TOOLS`; the intentional orphans pinned exactly
- no phantom tool — every member id and every phrase gate is implemented
  somewhere in `packages/tools/src`, verified against the implementation source
  rather than against the consumers (a phantom is an id only consumers know)
- members that exist but no agent may call stay unreachable for every agent
- the Google Ads tools' authorization is byte-for-byte what it was
- the unlisted tools stay exactly as callable as before
- the two task namespaces stay apart, in both directions

`packages/core/test/skill-membership-s2.test.ts` — 26 tests

- Google Ads is in advertising, by exact id, and does **not** steal
  `google.plan.*` from workspace
- the briefing's spoken phrasings are unchanged; only the count moves
- no exact id is reachable by another skill's prefix (that collision would be
  silent, because `exact` is checked first)
- `knowledge.search` is gone and nothing re-promises it — but a real
  `knowledge.*` tool would still be adopted
- the unlisted register: reasons present, disjoint from the catalogue, and
  unlisted means *no skill*, not *unavailable*
- `tasks.` does not reach `task.*`, asserted in both directions
- still 8 skills, same ids, same order; briefing still deterministic

`packages/core/test/skill-context-s3.test.ts` — 25 tests

- the context names only tools inside the selected agent's allowlist
- it shrinks as the allowlist shrinks, and never the other way
- an allowlist entry the report never carried contributes nothing
- a skill with no reachable member is omitted; one with a reachable but
  *blocked* member is kept, carrying the reason
- availability is recomputed over the reachable part — the projection bug
- membership matches `buildSkillViews` exactly when nothing is narrowed
- six fields, no callable value, no account or credential
- the prose carries no raw tool id, risk level or integration id, says what is
  blocked and why, and says it is orientation rather than a restriction

`packages/agents/test/skill-aware-planning-s3.test.ts` — 18 tests

- **G** with no port: byte-identical prompt, no call, no failure path; the port
  is skipped entirely when the agent has no policy
- **A** the port receives that agent's allowlist, not the union
- **E** `providerTools` is identical with and without skill context
- **B** an invented member id in the context is refused, denied and audited
- **F** a real tool the context named but the policy omits is still denied; a
  policy-granted tool the context did *not* name is still allowed
- **H** a failing report leaves the prompt untouched and tools still execute
- **J** several skills are represented together
- **L** the port is asked once per turn; a reconnect shows on the next turn

`packages/agents/test/multi-round-continuity-s4.test.ts` — 19 tests

- **A** a three-round chain still has round 1 in view on round 3; rounds replay
  as their own assistant turns, in order; the ORIGINAL question stays the user
  turn; every tool message answers an announced call id
- **B** round 4 still sees rounds 1, 2 and 3
- **C/D** depth 5 and the ten-execution cap both still refuse
- **E** a failed round does not erase the successful ones
- **F** approval mid-chain still produces a pending action, with round 1 in view
- **H** no results at all works; a fresh turn starts with no memory of the last
- **I** the S3 skill block still prefixes the question on every round
- **J** the allowlist is checked on every call of every round; a denial is
  visible to the next round rather than hidden
- **K** every executed call goes through `ToolExecutor`, once each
- **L** skill attribution from executed tool ids; unlisted tools attribute to
  nothing; unknown ids invent nothing

`packages/agents/test/tool-rounds-budget-s4.test.ts` — 15 tests

- oldest elided first; newest never elided even alone over budget; identity and
  `STATUS` survive elision; deterministic; bounded growth across 20 rounds
- the replayed list opens system/history/original question, emits one
  assistant+tool pair per round oldest first, and answers every announced call
- an elided message stays in place — removing it would leave a call unanswered

---

## 7. Phase S2 — the membership audit

S1 left eight allowlisted tools in no skill and said so rather than guessing.
S2 built the matrix that answers it properly: every tool id in the build,
cross-referenced against the policy that grants it, the skill that claims it,
the integration that gates it and the label the capability report would give it.

**89 tool ids** exist across the build — 85 that some agent may call, and 4 that
exist but no policy grants.

### 7.1 What the audit found

| Defect | What it was |
|---|---|
| **Phantom prefix** | advertising matched `google.ads.` and `adwords.`. Neither is a tool namespace. `google.ads.accounts` **is** a real id — an *integration action* id in `integration-catalog.ts`, which carries its own `toolId: "google.accounts"` precisely because the two namespaces differ. One namespace had been matched against the other, and three registered, authorized Google Ads tools fell out of the catalogue. |
| **Phantom phrase** | research offered "answer questions from documents you have given me", gated on `knowledge.search` — an id **nothing in the build declares**. Knowledge retrieval is real here, but it is an *orchestrator* step (`orchestrator.ts`, `surface-decision.ts`), not a tool, so there was never anything to gate on. |
| **Silent capture** | the obvious repair for the first defect — a bare `google.` prefix on advertising — would have taken all nine `google.plan.*` Workspace tools **away from** the workspace skill, because `ruleFor` returns the first match and advertising is declared first. |
| **Unexplained gap** | five allowlisted tools had no skill and no written reason. |

### 7.2 Changed memberships

| Tool | Was | Now | Why |
|---|---|---|---|
| `google.accounts` | orphan | **advertising** (exact) | `GOOGLE_READ_TOOLS` is documented as "Google Ads is read-only as of Sprint 5.2"; the capability label already reads "List Google Ads accounts"; `capability-catalog` maps it with `googleService: "ads"`. It is the advertising outcome. |
| `google.campaigns` | orphan | **advertising** (exact) | as above |
| `google.insights` | orphan | **advertising** (exact) | as above |
| `web.research` | orphan | **research** (exact) | the WebResearchTool. Semantically research; no policy grants it, so it can never reach a report. |
| `document.analyze` | orphan | **research** (exact) | the DocumentAnalyzerTool. Same. |

Removed: the prefixes `google.ads.` and `adwords.`, and the `knowledge.search`
phrase. Kept: the `knowledge.` prefix, which matches nothing today and would
adopt a real `knowledge.*` tool the day one exists.

**Authorization was not touched.** Not one policy changed. The three Google Ads
tools are granted to exactly the agents they were before — `conversational-assistant`,
`google-ads-agent`, `analytics-agent` — and that is asserted.

### 7.3 Membership is semantic; authorization is separate

`web.research`, `document.analyze` and `pdf.generate` are skill members that
**no agent may call**. That is not a contradiction, it is the architecture:

- a skill says what a tool is **for**;
- `AGENT_POLICIES` says what may **run**;
- `CapabilityService` skips any registered tool outside the allowlist, so an
  unauthorized member never reaches a report and never reaches a `SkillView`.

Excluding a tool from a skill *because* it is unauthorized would collapse the
two axes — the same mistake as collapsing `connection` into `health`.

### 7.4 Intentional orphans

Recorded in code as `SKILL_UNLISTED_TOOLS`, each with a reason, so that "no
skill owns this" is always a decision and a **new** orphan fails a test.

| Tool | Why it is unlisted |
|---|---|
| `self.describe` | **Introspection, not an outcome.** It answers what JARVIS *is* — build, model, environment — where a skill answers what JARVIS can *do for you*. Its own description routes "what can you do" to `capabilities.list` instead. It has no label override, so it could never be quoted in a briefing even as a member; and a one-tool skill with no phrase is dropped by `buildCapabilityBriefing` anyway. Granted to all nine agents, and unaffected by being unlisted. |
| `task.create`, `task.get`, `task.list`, `task.updateStatus` | **JARVIS's own work queue**, not the user's to-do list. Surfaced by the Task Engine and the dashboard's JARVIS Work section, not by the capability briefing. Granted to the general assistant alone. |
| `system.echo` | A test fixture — its own description says "Harmless test tool". This is why the monitoring skill claims `system.status` and `time.now` by **exact id** rather than by a `system.` prefix. |

### 7.5 `task.` vs `tasks.` — not a typo

The singular/plural mismatch is **deliberate**, and both tools say so:

> `tasks.list`: "This is the user's OWN to-do list. It is NOT the work JARVIS
> was asked to carry out: for 'what are you working on' or 'what did you
> finish', use `task.list` instead."

> `TASK_TOOLS` policy: "managing the work JARVIS has been asked to hold on to.
> Granted to the GENERAL assistant only, deliberately."

Two different questions about two different tables. `SKILL_TASK_NAMESPACES`
records both, and a test asserts the `tasks.` prefix does **not** reach `task.*`,
so widening it would fail loudly rather than quietly merge the two answers.

### 7.6 What S2 did NOT change

- No agent policy, no `ToolExecutor`, no Task Engine, no scheduler.
- No schema, no migration, no persistence, no MCP, no learning.
- No new skill: the catalogue is still **8 definitions**.
- No spoken output. The four-phrase cap is already filled by curated Meta
  phrasings, so what a user *hears* is byte-identical — asserted directly.

## 7a. Phase S3 — skill-aware planning

### 7a.1 The problem S3 solves

A tool definition carries name, description, risk and parameters. It carries
**no availability**. With Google disconnected the general assistant is still
handed all nineteen Workspace tool definitions and has no way to know they will
fail — so it proposes them, they fail, and the user is told something went
wrong rather than "Google is not connected."

S3 gives the model the one thing the definitions cannot express.

### 7a.2 Flow C, and why not the others

```
  User request
    -> Agent Selection      (unchanged: rankAgentCandidates, no model call)
    -> Skill Context        (NEW: prose, composed into the message)
    -> Existing planner     (unchanged: model function-calling)
    -> executeTools         (unchanged: isToolAllowed, then ToolExecutor)
```

Skill discovery happens **after** agent selection, deliberately. The agent
choice *is* the allowlist choice, so a skill matcher upstream of the router
would make an editable metadata file a de-facto authorization input — the exact
property S1 and S2 exist to prevent. `agent-router.ts` says it plainly: routing
is not model-driven "because the agent choice is what selects a tool allowlist".

S3 also does **not** narrow `providerTools`. Filtering the seventy-three
definitions the general assistant receives down to the matched skills would
subtract reach, and a wrong match would fail *silently* — the model would
simply never consider a tool it needed. Context can only add orientation.

### 7a.3 `SkillContext`

Smaller than `SkillView` on purpose: the view answers "what should a person be
shown?", this answers "what does a planner need?". Counts, approval tallies and
curated phrasings are useful to a reader and noise to a planner.

| Field | |
|---|---|
| `id`, `title`, `summary` | the outcome, in the user's words |
| `availability` | best member **this agent can reach** |
| `toolIds` | authorized members — in the object, **not** in the prose |
| `blockedBy` | plain-English reasons, de-duplicated |

### 7a.4 `buildSkillContext(report, agentAllowedToolIds)`

A projection of `buildSkillViews`, narrowed **twice**:

1. `CapabilityService` already dropped every tool no agent policy grants;
2. this intersects what remains with the **selected agent's** allowlist.

Both are narrowing. No argument to this function widens anything.

Availability is **recomputed** over the intersected members rather than copied
from the view — a skill whose only agent-visible tool is blocked must not
inherit a healthy headline from a sibling this agent cannot call. The fold that
does it, `summarizeMembers`, is the same one `buildSkillViews` uses, so the
reader-facing view and the model-facing context can never disagree about
whether a skill works.

A skill with no callable member for this agent is **omitted entirely**: showing
it would invite a call the allowlist gate denies and audits.

### 7a.5 What the model reads

```
WHAT YOU CAN ACTUALLY DO RIGHT NOW:

Business and advertising - Look at how your ad accounts are performing and act on what you find.
Email, files and calendar - Read across your Google Workspace and prepare changes for you to approve.
  Partly unavailable: Google is not connected.

This is orientation, not a restriction: use whichever of your tools the request
needs, including any not named above. Where something is listed as unavailable,
say so and say why rather than attempting it.
```

Outcomes, not inventory. **No tool ids, no risk levels, no parameter shapes, no
integration ids, no counts.** Raw ids are kept out because a model shown one
will eventually quote it to a user — the defect the capability briefing was
rewritten to fix.

The closing line is load-bearing. Without it a model reads the list as the set
of things it may do and stops calling the tools that belong to no skill on
purpose: `self.describe`, the `task.*` lifecycle.

### 7a.6 Where it joins

`Orchestrator.process` already composes memory and knowledge in one
`Promise.all`. Skill context is a third entry on that rail, and the block is the
**outermost** prefix — memory and knowledge are about this request, this is
standing orientation about what works.

```ts
const userMessage = skillBlock + knowledge.message;   // "" when there is no port
```

Concatenation, not a branch: with no port the string is byte-identical to what
every existing prompt test pins.

The port is nullable and matches `memoryStore` / `knowledgeRetriever` /
`permissionChecker` exactly. It exists because `packages/agents` cannot import
`apps/api`, where `CapabilityService` lives.

### 7a.7 Multi-skill, and skills are not a restriction

A request may involve several skills — "check my ads and email me the summary"
is `advertising` + `workspace`. Nothing selects one. The context is global for
the selected agent, and the planner may still call **anything its policy
allows**, including the five intentional orphans that belong to no skill.

### 7a.8 Failure

| | |
|---|---|
| no port wired | no block; byte-identical prompt |
| agent has no policy | no block — without an allowlist there is nothing to promise |
| `report()` throws | warn log, empty block, turn proceeds normally |
| no skills to describe | empty string; prompt untouched |

A conversation is never aborted over missing **orientation**.

### 7a.9 Latency, and why there is no cache

`buildSkillContext` + `renderSkillContext` over 85 capabilities: **0.13 ms**
(mean of 2 000 runs). Immaterial.

`CapabilityService.report()` is the real cost: five integration views, each a
few database reads, run in parallel. It performs **no live provider probe** —
`buildView` reads stored state and credentials. It sits inside the existing
`Promise.all` beside memory recall and knowledge retrieval, each of which makes
an embedding **network** call plus a pgvector query. So on any turn where either
of those runs, skill context adds no wall-clock at all; it is only ever on the
critical path when both are skipped.

**No cache was added, deliberately.** Availability is a fact about right now; a
cached one survives a token expiring and becomes a false promise the model then
repeats. The measurement does not justify the risk.

---

## 7b. Phase S4 — multi-round continuity

### 7b.1 S4 is not a composition engine

Discovery asked whether JARVIS needed a skill graph, a skill planner or a
workflow engine to compose skills. It needed none of them. **Multi-skill
composition already worked**, and still does, through exactly four things that
were already here:

```
  model function calling + the multi-round Orchestrator loop
  + ToolExecutor + AGENT_POLICIES
```

The general assistant's 73-tool allowlist spans **seven of the eight skills**.
The loop already ran up to five rounds, already fed results back, and already
let the model pick its next tool from what the last one returned. Nothing about
that needed inventing.

| agent | advert | places | worksp | resear | produc | messag | monito | integr |
|---|---|---|---|---|---|---|---|---|
| conversational-assistant | ● | ● | ● | ● | ● | | ● | ● |
| meta-ads-agent | ● | | | | | | | ● |
| google-ads-agent | ● | | ● | | | | | ● |
| analytics-agent | ● | | | ● | | | | ● |
| location-agent | | ● | | | | | | ● |
| browser-agent | | | | ● | | | | ● |
| automation-agent | | | | | ● | | | ● |
| communication-agent | | | | | | ● | | ● |
| knowledge-agent | | | | | | | | ● |

### 7b.2 What was actually broken

The loop was five rounds deep and the model's working memory was **one**.

Each round rebuilt the message list from the latest assistant turn and the
latest results only, so a four-step objective discarded its own evidence:

```
  round 1   read insights          -> R1
  round 2   sees R1, analyses      -> R2
  round 3   sees R2 only. R1 is gone.
```

By "now draft the email", the numbers to write about were no longer in front of
the model. That — and only that — is what S4 fixes.

### 7b.3 The change

`ConversationState` now holds the rounds of the turn instead of one response:

```ts
interface ConversationState {
  userMessage: string;
  rounds: ToolRound[];                    // completed, oldest first
  pending: AICompletionResponse | null;   // awaiting results
}
```

`buildRoundMessages` replays them all: system, history, the **original**
question, then one assistant turn and its tool answers per round.

**Whole rounds, not a summary block.** The cheaper fix is to prepend "here is
what you found earlier" as prose. It is also a fabrication, and `domain-agent.ts`
already refuses to invent a synthetic tool-call turn because it "would put
words in the model's mouth". Replaying the real turns says exactly what
happened — and it is what the provider protocol requires, since a `tool`
message must answer an `assistant` message by call id.

**One implementation.** `ConversationalAssistant`, `MetaAdsAgent` and
`DomainAgent` each carried a private copy of this construction. All three now
call `tool-rounds.ts`, so they cannot drift into remembering different amounts
of the same conversation. Each agent file got *shorter*.

No new store: the existing per-conversation state map carries it.

### 7b.4 The context budget

`DEFAULT_TOOL_RESULT_BUDGET_CHARS = 12 000`, measured in characters because
every other context budget here is — memory is 2 000, knowledge has its own —
and a token budget would need a tokenizer on the critical path.

Why 12 000: a turn is capped at ten tool executions, and a typical envelope in
this build runs a few hundred characters to low thousands. 12 000 holds a
realistic four-step objective whole while leaving the 73 tool definitions, the
system prompt, the skill block and the history comfortable room. It is a
ceiling on the pathological case, not a target.

Three properties, each pinned by a test:

| | |
|---|---|
| **oldest first** | rendering walks newest to oldest, so what is dropped is dropped from the far end |
| **newest kept whole** | never elided, even alone over budget — eliding it would make a turn *worse* than before S4 |
| **elided, not removed** | the `tool` message stays, carrying tool id and `STATUS` |

That last one is the non-obvious constraint. Deleting an old result is the
natural instinct and produces a request the provider rejects: an assistant tool
call with nothing answering it. Identity and status survive because "I already
tried that and it failed" is the fact that stops a model trying again.

### 7b.5 Limits, unchanged

**Depth 5. Ten total tool executions.** Neither raised, both now pinned by a
test — a sixth round is refused, and the call that would cross ten is refused
before anything runs.

### 7b.6 Failure behaviour, unchanged

Partial failure still reaches the model as an envelope and the turn continues;
all-failed still goes through `classifyToolFailures`; an approval mid-chain
still produces a pending action without aborting; timeouts remain the
executor's deadline race; depth exhaustion still throws and audits. S4
redesigned none of it — it only means the successful rounds are still in view
when the failed one arrives.

### 7b.7 Skill participation, derived

`skillsForToolIds(toolIds)` — a pure function, no schema, no table, no second
write path.

`AuditLog` already carries `toolId`, `traceId`, `agentId` and
`metadata.executionId` for every call, and `skillForToolId` is deterministic.
So "which skills participated in this objective?" is answered by grouping rows
that already exist and mapping them. Storing it separately would create a
record that could disagree with the audit trail.

Intentionally unlisted tools attribute to nothing, and an unknown id invents
nothing.

### 7b.8 Cross-agent composition — deferred

One agent runs per request, chosen deterministically. Composition therefore
works across every skill **that agent** owns — seven of eight for the general
assistant.

The one gap is `messaging`: "check my ads and WhatsApp me the summary" cannot
work, because `whatsapp.send` belongs to the communication agent alone. Closing
it would mean widening a policy (an authorization decision) or agent-to-agent
communication (a new architecture). **S4 does neither.** The cost of deferring
is one skill.

### 7b.9 Durable work stays with the Task Engine

| | |
|---|---|
| "Check my ads and email me the summary." | conversational — the loop |
| "Every Monday analyse campaigns and send a report." | durable — Task Engine + scheduler |

S4 does not merge them, and the Task Engine keeps its V2.1–V2.3 claim,
recovery and lifecycle guarantees.

---

## 7c. Phase S5 — Execution Outcome & Evaluation

### 7c.1 What S5 is

An **observer**. It sits beside the execution path, reads audit rows that were
already written, and records one explicit signal. It executes nothing, plans
nothing and changes nothing about how JARVIS behaves.

```
                    ┌───────────────────────┐
                    │  S5 Outcome/Feedback  │  OBSERVER
                    └───────────▲───────────┘
                                │ reads
                            AuditLog
                                │ writes
  User → Orchestrator → Agent → Policy → ToolExecutor → Tool
```

### 7c.2 The distinction the whole phase exists for

| | |
|---|---|
| **Execution Outcome** | what the system DID — which agent ran, which skills and tools took part, which succeeded, which were denied, how the turn concluded. Derived entirely from `AuditLog`. |
| **User Feedback** | whether the person found it useful. Known **only** when they said so explicitly. |

A tool returning `success` is not a rating. A turn nobody rated is not a turn
somebody disliked. `feedback: null` means **not asked or not answered** — it is
not a negative, and nothing infers one from silence, a follow-up question, a
correction, a "thanks", sentiment or conversation length.

If those two ever blur, a later learning layer inherits a dataset where "never
asked" reads as "bad", and every conclusion drawn from it is wrong in the same
direction. That is why the separation is enforced at the type level and pinned
by four tests that deliberately cross the two: a technically successful turn
rated NOT_HELPFUL, and a technically failed turn rated HELPFUL.

### 7c.3 No parallel status enum

The outcome of a turn is the `result` the orchestrator already audited —
`success` / `failure` / `rejected` / `pending`. S5 reuses it rather than
inventing a second vocabulary that could disagree with the audit trail.

A **policy denial** is counted separately from a **tool failure**
(`toolsDenied` vs `toolsFailed`). A denied call never reached the executor;
filing it as a failure would put a policy decision in the same bucket as a
provider outage. A denied tool also attributes to **no skill**, because it
never ran.

### 7c.4 AuditLog is the source of truth

`AuditLog` already carries `userId`, `agentId`, `toolId`, `action`, `result`,
`traceId`, `metadata.executionId` and `createdAt`. Grouping by `traceId`
reconstructs a request; `skillsForToolIds()` (S4) supplies the skills.

**No new table. No new pipeline. No schema change. No migration.**

`findByTrace()` is bounded by `(userId, createdAt)` plus a 30-day window —
the same technique `findExecutionOutcome()` uses, and for the same reason:
`AuditLog` carries no index on `traceId`, and S5 is not a good enough reason to
add one to a table this hot.

### 7c.5 Feedback persistence

Feedback is **an ordinary `AuditLog` row**: `action: "conversation.feedback"`,
the turn's `traceId`, and `metadata.feedback`. It is an audited user action, so
it gets the same table, writer, redaction and retention as every other one —
and the projection therefore reads exactly one source.

**Ownership is checked before the write.** Feedback is a write keyed by an id
the caller supplies, so the service reads the trace first and refuses one that
is not the caller's. "Not yours" and "does not exist" return the same answer,
so the endpoint cannot be used to discover which trace ids are real.

### 7c.6 Feedback influences nothing

A hard invariant, asserted structurally rather than promised:

- `ExecutionOutcomeService` holds **no** executor, registry, agent or policy —
  a test greps its source for each, so no edit could make feedback run a tool.
- **Nothing on the planning path imports it** — asserted against
  `orchestrator.ts`, `agent-policy.ts`, `agent-router.ts`, `domain-agent.ts`
  and `capability-presentation.ts`.

So a recorded signal cannot reach agent selection, skill selection, tool
selection, prompts, SkillContext, `providerTools`, policies, memory confidence,
planning, execution, the Task Engine or the Scheduler.

### 7c.7 The UI

Two buttons on the existing `MessageActions` row, beside Copy — 👍 / 👎, shown
on assistant messages only, and only when the message carries a `traceId`. No
dashboard, no analytics screen, no survey, no free text, no rating scale.

The trace already travelled: the chat API returns `traceId` on the envelope and
persists it on the stored assistant message, so a live message and a reloaded
one are both rateable with no new correlation.

### 7c.8 Explicit non-goals

No learning. No adaptation. No confidence adjustment. No success-rate
optimisation. No skill scoring. No LLM judge. No automatic self-evaluation. No
MCP. No self-repair. No cross-agent composition. No Task Engine or Scheduler
change. **Future learning is not implemented, and nothing here reads the signal
back into a decision.**

---

## 7d. Phase S6 — Objective Evaluation (contract approved; Phase 1 implemented)

### 7d.0 Stage — read this first

| Part | State |
|---|---|
| Contract | **Approved** (verdict PROCEED). This section is that contract. |
| PD-2 evidence capture — every user message a chat request saves carries `metadata.traceId` | **Implemented, not committed.** `apps/api/src/routes/chat.ts`; tests in `apps/api/test/chat-trace-evidence.test.ts` and `packages/agents/test/trace-metadata-isolation.test.ts`. |
| Phase 1 — objective extraction (`packages/core/src/objective-extraction.ts`) | **Implemented, not committed.** 146 tests in `packages/core/test/objective-extraction-s6.test.ts`. |
| Phase 2 — evidence facts, attribution, status rules (`packages/core/src/objective-evaluation.ts`) | **Implemented, not committed.** Pure builder only — nothing calls it yet. 69 tests in `packages/core/test/objective-evaluation-s6.test.ts`; 4 drift tests in `packages/tools/test/objective-evaluation-drift-s6.test.ts`. |
| Phase 3 — trace message lookup (`packages/db`), read-only service, container wiring | **Implemented, not committed.** `findTraceMessages` in `packages/db/src/repositories/conversation-repository.ts`; `ObjectiveEvaluationService` in `apps/api/src/services/objective-evaluation-service.ts`, wired as `container.objectiveEvaluations`. Nothing calls it yet. 32 service tests; 5 PostgreSQL tests that skip when the database is unreachable. |
| Phase 4 — `GET /api/v1/activity/trace/:traceId/evaluation` | **Implemented, not committed.** `apps/api/src/routes/activity.ts`; documented in `docs/API.md`. 20 HTTP tests in `apps/api/test/objective-evaluation-route-s6.test.ts`. No UI. |

Nothing in S6 is user-accessible today. No part of it executes, plans,
authorizes, routes or learns — and no part of it ever will; see 7d.11.

### 7d.1 What S6 is

S5 answers *what happened* during a request. S6 answers, per objective,
*whether what the user asked for was achieved* — to the extent the evidence
can prove it, and it names what it cannot prove instead of guessing.

```
  user request (PD-2: bound to its trace)      AuditLog rows of that trace
                  │                                        │
          extractObjectives()                    facts (enumerated fields)
                  │                                        │
                  └──────────► fixed status rules ◄────────┘
                                     │
                     ObjectiveEvaluation (read-only, derived on request)
```

**Owner decisions.**

- **PD-1 — fixed, deterministic rules only.** No LLM judge and no LLM
  extractor. An objective whose satisfaction depends on the meaning of the
  reply (drafting, analysis) is `NOT_EVALUABLE` unless deterministic evidence
  exists.
- **PD-2 — evidence capture approved and implemented.** Before it, a request
  could be tied to its trace only by message order, which two overlapping sends
  break and which a failed turn (no reply stored) cannot do at all.

S5 listed "no automatic self-evaluation" among its non-goals (7c.8). S6 is the
owner-approved step past that line, and only that far: deterministic,
read-only, derived, and with feedback kept separate exactly as S5 keeps it.

**Three layers, never collapsed:** `facts` are proven (one server-written row
each); `assessments` are inferred (each names the fixed rule that produced it);
`missing` names what is unknown. There is no success boolean, no confidence, no
score and no dependency graph.

### 7d.2 Objective model — implemented in Phase 1

`extractObjectives(traceId, request): Objective[]` — pure, deterministic, no
imports at all.

1. **Split** at `. ! ? ;` followed by whitespace (the punctuation stays with its
   clause), line breaks, commas, and the whole words
   `and | then | also | plus | aur | phir | fir`.
2. **Mark** each clause with the closed lists in 7d.3 — whole words,
   case-insensitive. **Noun guard:** a write, compose or creation marker
   directly after `a | an | the | any | this | that | latest | ad` is a noun
   ("the draft", "an update", "ad set") and is ignored.
3. **Merge** each unmarked clause into the marked clause before it, or into the
   next one when it leads the request.
4. **Negation:** drop a clause whose *marked* part contains
   `don't | do not | dont | never | no need to | without | mat | nahi | nahin`,
   together with any unmarked words merged into it. Negation inside an unmarked
   clause has no effect.
5. **Framing:** a clause containing `how do | how can | how to | tell me about |
   do you know | what if | should i | can i | could i | is it` cannot be
   `EXTERNAL_WRITE`. A clause ending in `?` cannot either, unless the message
   opens with `can you | could you | would you | will you | please | kindly`.
6. **Class** by precedence `EXTERNAL_WRITE > COMPOSE > ANALYZE > RETRIEVE`. A
   creation verb (`create | make | generate | build | banao | bana do | bana de`)
   is `COMPOSE` with an artifact noun in the clause, `EXTERNAL_WRITE` without.
   A clause whose only markers were writes ruled out by framing is `RETRIEVE`.
7. **Count:** no marked clause → no objectives (reported as `OBJECTIVE_CLASS`
   missing, `extractionMissing()`). More than `MAX_OBJECTIVES = 8` → one
   objective spanning the whole trimmed request, with the highest class present.
8. **Identity:** `objectiveId = ${traceId}#${index}`, zero-based. `text` is the
   trimmed substring of the request — never rewritten. `skills` are the
   vocabulary hits in that text, by first appearance.

### 7d.3 Closed lists

Exported as `OBJECTIVE_MARKERS` and `OBJECTIVE_SKILL_VOCABULARY` so they can be
read and drift-tested. Changing either is a contract change.

| Class | Markers |
|---|---|
| `EXTERNAL_WRITE` | send, pause, resume, stop, launch, activate, deactivate, enable, disable, connect, disconnect, reconnect, configure, update, change, set, adjust, increase, decrease, raise, lower, reduce, cut, boost, delete, remove, add, rename, archive, restore, move, upload, publish, share, submit, schedule, book, invite, cancel, trigger, notify, inform · Hinglish: bhejo, bhej do, bhej de, band karo, chalu karo, shuru karo, roko, badhao, badha do, kam karo, hatao (and "<English write verb> karo", which the English list already matches) · `tell / message / email / whatsapp` directly followed by `my / our / the / him / her / them` · a creation verb without an artifact noun |
| `COMPOSE` | draft, write, compose, prepare, summarize, summarise, outline, plan, rewrite, rephrase, likho, likh do, taiyar karo · a creation verb with an artifact noun (report, summary, plan, draft, outline, proposal, strategy, note, notes, script, caption, copy, agenda, email, message) |
| `ANALYZE` | analyze, analyse, identify, compare, evaluate, assess, diagnose, rank, recommend, suggest, explain, why, figure out, weak, weakest, strong, strongest, best, worst, top, bottom, underperforming, overperforming, poor, poorly, better, worse, anomaly, anomalies, trend, trends · kyun, kyon, samjhao, kharab, accha |
| `RETRIEVE` | check, show, list, get, fetch, find, look up, look at, lookup, see, view, read, pull, search, status, tell me, give me, what, which, who, when, where, how much, how many, how is, how are · dikhao, batao, bata do, dekho, nikalo, kya, kitna, kitne, kaun, kab, kahan · a trailing `?` |

| Skill (`SKILL_CATALOG` id) | Words in the objective text |
|---|---|
| advertising | campaign(s), ad(s), ad set(s), adset(s), creative(s), budget(s), spend, roas, ctr, cpc, cpm, cpa, impressions, clicks, conversions, meta, facebook, instagram, google ads |
| places | nearby, near me, route, directions, distance, restaurant(s), cafe(s), place(s), map(s) |
| workspace | email(s), mail, gmail, inbox, draft(s), calendar, meeting(s), event(s), drive, file(s), folder(s), document(s), doc(s) |
| research | weather, stock(s), price(s), crypto, csv, pdf, web |
| productivity | task(s), todo(s), to-do(s), reminder(s), n8n, workflow(s), automation(s) |
| messaging | whatsapp |
| monitoring | cpu, disk, system status, memory usage, current time, today's date |
| integrations | integration(s), connection(s), connected, health |

The vocabulary is keyed by, and pinned by test to, exactly the `SKILL_CATALOG`
ids. It does not import the catalogue and cannot invent a skill. Naming a skill
here grants nothing.

**Worked examples** (all pinned by the corpus test):

| Request | Objectives |
|---|---|
| "Check my campaign performance." | RETRIEVE [advertising] |
| "Check my campaigns and tell me which ones are weak." | RETRIEVE [advertising] · ANALYZE "tell me which ones are weak." |
| "Check my campaigns, identify weak ones, and draft an email." | RETRIEVE · ANALYZE · COMPOSE "draft an email." [workspace] |
| "…draft an email, and send it." | the three above · EXTERNAL_WRITE "send it." |
| "How do I change the budget?" | RETRIEVE — framing rules out the write |
| "Can you pause the campaign?" | EXTERNAL_WRITE — the request opener beats the `?` |
| "iska plan banao, execute mat karo" | one COMPOSE objective; no action objective (see the correction below) |
| "yes", "no", "thanks" | none — `OBJECTIVE_CLASS` missing |

#### Correction (added 2026-09-25)

The approved contract's worked example gave the negation case as
`COMPOSE "iska plan banao"` with "the negated clause dropped". The contract's
own normative rules produce a different *text*: "execute" is not on any marker
list, so "execute mat karo" is an **unmarked** clause, which rule 3 merges into
the compose clause before it and whose negation rule 4 says has no effect. The
implemented result is therefore one COMPOSE objective with text
`"iska plan banao, execute mat karo"` — the compose objective is kept and no
action objective is produced, which is what the requirement asks for. Adding
"execute" to the write list would give the shorter text; that is a change to a
closed list and is left to the owner.
Evidence: `packages/core/test/objective-extraction-s6.test.ts`, case 7.

**Known edges**, pinned deliberately so that any change is a reviewed edit:

| Request | Result | Why |
|---|---|---|
| "Check my campaigns but don't pause anything" | none | no separator, so the negation drops the whole clause |
| "Check my campaigns without changing anything" | none | "without" negates the clause it sits in |
| "Pause the campaign, right?" | EXTERNAL_WRITE · RETRIEVE | a trailing `?` is itself a RETRIEVE marker |
| "What is my plan?" | COMPOSE | the noun guard does not cover possessives ("my") |
| "How do I create a report?" | COMPOSE | framing rules out writes only |

### 7d.4 Evidence model — implemented in Phase 2

Facts are recognised by row action or row shape; only enumerated fields are
read.

| Source row | Fact |
|---|---|
| `tool.execute` success / failure | `TOOL_RESULT` |
| `tool.execute` rejected | `TOOL_REFUSED` `UNSPECIFIED_REJECTION` — permission, shutdown and a denied approval all look alike here |
| `tool.execute` pending | `APPROVAL_REQUESTED` |
| `agent.tool_denied` · `agent.tool_not_requested` · `agent.tool_clarification_required` · `agent.approval_gate_missing` | `TOOL_REFUSED` `POLICY` · `NOT_REQUESTED` · `CLARIFICATION_REQUIRED` · `APPROVAL_GATE_MISSING` |
| approval-service row (by shape: toolId, result pending, `metadata.approvalId`) | `APPROVAL_REQUESTED` — its prose `action` is never read |
| approval-service row (by shape: toolId, rejected, `metadata.error.code = AUTHORIZATION_FAILED`) | `TOOL_REFUSED` `PERMISSION` |
| `google.write.plan.<action>` with `approvalId` | `WRITE_PLANNED` |
| `google.write.execute.<action>` | `WRITE_EXECUTED`, with `verification` |
| `google.<action>` (action in `GOOGLE_TASK_ACTIONS`) · `integration.<command>` | `PROVIDER_RESULT`, with a code from the closed `GoogleTaskStatus` / `IntegrationErrorCode` enums |
| `orchestrator.process` (last wins) | `TURN_VERDICT` |
| assistant message of the same trace | `REPLY_STORED`; `metadata.pendingAction` → `APPROVAL_REQUESTED`; `metadata.taskId` → `TASK_CREATED` |
| `approval.*`, `surface.*`, `meta.analyze`, everything else | ignored — `approval.*` takes its traceId from a client header and is not server evidence |

**Never read:** `parameters`, `metadata.detail`, `metadata.internalError`,
error messages, approval-service `action` prose and `agentId`, message content
other than the bound request, tool output, model prose.

**Corroboration.** Three tool families report success when nothing useful
happened — Google read tools when Google is not connected, `integration.test`
on a bad connection, Google planners when no plan was made — so their success
counts only when the matching provider row agrees: `google.<toolId>`,
`integration.<command>` (fixed tool→command map), `google.write.plan.<action>`.
A Google write is `EVIDENCED` only when `google.write.execute.<action>` reports
`verification: "verified"`. JARVIS's own task-store writes need no second row.
Any other write has no same-trace corroboration source and can never be
`EVIDENCED`.

**Attribution is an inference, never a fact.** A fact's side is READ when the
tool's risk is `READ_ONLY`, WRITE otherwise; unknown tools are never
attributed. Rule A1: the tool's skill (`skillForToolId`) is one of the
objective's skills. Rule A2, only when A1 finds nothing: the objective is the
only one of its class, so every fact on its side is attributed.

### 7d.5 Status rules — implemented in Phase 2

First matching row wins. *Attempt* = an attributed fact on the objective's side.
*Stop* = a refusal, a failed or rejected result, a contradicted success, or a
failed write.

| Class | Order |
|---|---|
| `RETRIEVE` | corroborated read → `EVIDENCED` · uncorroborated read → `NOT_EVALUABLE` (CORROBORATION) · all attempts stopped → `BLOCKED` · attempts not attributable → `NOT_EVALUABLE` (ATTRIBUTION) · task created → `NOT_EVALUABLE` (DEFERRED_TO_TASK) · reply stored → `NOT_EVALUABLE` (RESPONSE_MEANING) · failed turn, no reply → `NOT_ATTEMPTED` · otherwise `NOT_EVALUABLE` (TURN_CONCLUSION) |
| `EXTERNAL_WRITE` | corroborated execution → `EVIDENCED` · approval requested, write planned or `CONFIRMATION_REQUIRED` → `AWAITING_APPROVAL` · uncorroborated execution → `NOT_EVALUABLE` (CORROBORATION) · all attempts stopped → `BLOCKED` · attempts not attributable → `NOT_EVALUABLE` (ATTRIBUTION) · task created → `NOT_EVALUABLE` (DEFERRED_TO_TASK) · concluded without a failed verdict → `NOT_ATTEMPTED` · failed verdict → `NOT_EVALUABLE` (UNRECORDED_WRITE_PATH — a pending action created before the failure is recorded nowhere in the trace) · otherwise `NOT_EVALUABLE` (TURN_CONCLUSION) |
| `COMPOSE`, `ANALYZE` | reply stored → `NOT_EVALUABLE` (RESPONSE_MEANING) · failed turn, no reply, attributed stops → `BLOCKED` · failed turn, no reply → `NOT_ATTEMPTED` · otherwise `NOT_EVALUABLE` (TURN_CONCLUSION) |

Across all classes: an unbound trace gets no objectives (`REQUEST_TEXT`
missing, facts still listed); with more than 200 audit rows, `BLOCKED` and
`NOT_ATTEMPTED` — which depend on proving absence — become `NOT_EVALUABLE`
(ROW_LIMIT); feedback never changes a status.

### 7d.6 Trace binding

A trace is bound when exactly one user message owned by the caller carries
`metadata.traceId` equal to it within the 30-day S5 window. Since PD-2 every
chat branch binds — confirm, reject, modify, the Task path and the
orchestrator on success, failure and error.

**The Task record is never read.** Its fields change after the trace ends (the
scheduler clears `scheduledAt`; a later run changes `status`), so reading it
would silently join later traces. A Task-path objective not executed within its
own trace is `NOT_EVALUABLE` (DEFERRED_TO_TASK), with the `taskId` reported as
a fact.

Never bound: traces from before PD-2, the pending-action and approvals REST
routes, scheduler runs, the integration and Google panels. Approvals and
scheduled work are never followed into another trace.

### 7d.7 Feedback

Copied from `buildExecutionOutcome(traceId, rows).feedback`. Never an input to a
rule; no agreement field; silence stays `null`.

### 7d.8 Output contract — implemented in Phase 2

```ts
// Implemented in Phase 1 (objective-extraction.ts)
type EvidenceClass = "RETRIEVE" | "EXTERNAL_WRITE" | "COMPOSE" | "ANALYZE";
interface Objective { objectiveId: string; text: string; evidenceClass: EvidenceClass; skills: readonly string[] }

// Phase 2 (objective-evaluation.ts)
type ObjectiveStatus = "EVIDENCED" | "AWAITING_APPROVAL" | "BLOCKED" | "NOT_ATTEMPTED" | "NOT_EVALUABLE";
type MissingEvidence = "REQUEST_TEXT" | "OBJECTIVE_CLASS" | "ROW_LIMIT" | "TURN_CONCLUSION" | "RESPONSE_MEANING"
  | "ATTRIBUTION" | "CORROBORATION" | "DEFERRED_TO_TASK" | "UNRECORDED_WRITE_PATH";
interface EvidenceFact { ref: string; kind: FactKind; at: Date; toolId?: string; action?: string;
  result?: AuditEntry["result"]; refusal?: Refusal; code?: IntegrationErrorCode | GoogleTaskStatus;
  approvalId?: string; verification?: WriteVerification; taskId?: string }
interface ObjectiveAssessment { objectiveId: string; status: ObjectiveStatus; rule: AssessmentRule;
  evidence: readonly string[]; missing?: MissingEvidence /* iff NOT_EVALUABLE */ }
interface ObjectiveEvaluation { traceId: string; bound: boolean; objectives: readonly Objective[];
  assessments: readonly ObjectiveAssessment[]; facts: readonly EvidenceFact[];
  missing: readonly MissingEvidence[]; feedback: UserFeedback | null; asOf: Date | null }
```

Deliberately absent: `confidence`, a success boolean or counts, `blockers`,
per-assessment skills, an evaluation timestamp (`asOf` is the latest row read,
not the clock), a rules version, remedies, and any feedback-agreement field.

### 7d.9 Service (implemented in Phase 3) and API (implemented in Phase 4)

- `ObjectiveEvaluationService.evaluate(userId, traceId)` reads two things in
  parallel — S5's `findByTrace` (201 rows) and a new read-only
  `findTraceMessages` scoped through `Conversation.userId` — and calls the pure
  builder. Its only other input is a `riskOf(toolId)` function; it holds no
  executor, registry, policy, gate, planner or approval service.
- `GET /api/v1/activity/trace/:traceId/evaluation` — read-only; 401 / 400 / 404
  as the S5 trace route; unknown and foreign traces give the identical 404.
  It writes nothing. No UI in v1. A message-only trace (reject, "time too
  vague") returns 200 where S5 returns 404.

### 7d.10 Security invariants

S6 cannot authorize, plan, route, select tools, retry or learn: it holds only
readers and a pure function, and a source scan pins that. Nothing on the
planning path imports it (Phase 1 already asserts this for the extractor). It
never reads free text as evidence, never trusts a client-supplied trace id,
never returns `parameters`, and scopes every read to the authenticated user.
The write-intent gate and the extractor share no code in either direction.

### 7d.11 Non-goals

No LLM of any kind. No persistence, model, migration or index. No UI. No
learning, confidence, preference or prompt adaptation. No change to routing,
tool selection, the write-intent gate, policies, ToolExecutor, the Task
Engine, the Scheduler, S5, MCP or memory. No following approvals, scheduled
runs or task state across traces. No backfill of pre-PD-2 traces.

### 7d.12 Risks the contract accepts

- Closed lists will misread some phrasings, Hinglish especially (see the known
  edges above). Mitigated by the corpus, the noun guard and the one-objective
  fallback; never by a model.
- Attribution is by skill and side, not by action.
- `EVIDENCED` for RETRIEVE proves the read ran, not that the user saw the data —
  the Task path reply omits tool output.
- Approval-gated writes are almost never `EVIDENCED` in v1, by the decision
  not to follow approvals.
- The extractor and the write-intent gate can disagree, and are allowed to:
  they answer different questions. Two measured cases where the extractor sees
  a write and the gate says INFO: "I will pause it later" (the extractor's
  markers do not depend on position) and "Tell me about the campaign and pause
  it" (the gate applies framing to the whole message, the extractor per
  clause). A later gate-consistency test must therefore be scoped to
  instruction-shaped requests rather than assert "never" over all sentences.

### 7d.13 Phase 1 evidence

`packages/core/test/objective-extraction-s6.test.ts` — 146 tests: the four
worked requests, framing and openers, negation, the noun guard, merging, class
precedence, creation verbs, Hinglish writes / analysis / retrieval, empty
requests, the eight-objective cap, identity and verbatim text, case and
whole-word matching, the vocabulary pinned to `SKILL_CATALOG`, a 78-sentence
English and Hinglish corpus plus 5 pinned known edges, determinism across
interleaved calls, a CPU-time bound on 100 KB inputs, and isolation (no imports
beyond relative core modules; no database, HTTP, execution, policy, planning,
memory or model dependency; not reachable from the planning path). Mutation
checks — removing the noun guard, framing, negation, or swapping precedence —
each turn tests red.

### 7d.14 Phase 2 evidence

`buildObjectiveEvaluation(input)` and `normalizeEvidence(input)` in
`packages/core/src/objective-evaluation.ts`, exported from `@jarvis/core`. Pure:
imports only core types, `skillForToolId`, S5's `buildExecutionOutcome` (for
the feedback copy) and the Phase 1 extractor, which it uses unchanged.

- `packages/core/test/objective-evaluation-s6.test.ts` — 69 tests: T1–T27,
  T29, T30, T33–T35 and the builder halves of T28 (rows and messages of another
  trace are ignored) and T32 (no code shared with the gate in either
  direction); every fact kind, every refusal, every corroboration family,
  attribution A1/A2 and its ambiguity, the Task path, binding, row limit,
  feedback separation, the projection's closed shape, and source/import
  isolation. T28 over HTTP, T31's service scan, T35's service half and T38
  belong to Phases 3–4.
- `packages/tools/test/objective-evaluation-drift-s6.test.ts` — T37: the
  integration tool → command map, the Google read and planner families and the
  task-store writes are checked against the real tools.
- Mutation checks — dropping Google corroboration, the A2 fallback, the closed
  code enums, the row-limit downgrade, or treating unknown tools as reads,
  or letting a planning refusal block a COMPOSE objective — each turn tests
  red. The drift test turns red on a changed command or task-store list.

**Ambiguities found while implementing (rules unchanged; pinned in tests):**

1. **`integration.list` can never be `EVIDENCED`.** The contract requires the
   matching `integration.<command>` row for every `integration.*` tool, but the
   command service answers `list` without writing one. Such an objective is
   `NOT_EVALUABLE` (CORROBORATION).
2. **An indeterminate or duplicate Google write is `BLOCKED`** — *decided
   (PD-3, 2026-09-25): kept as a known S6 v1 limitation; no new status.* The write
   service records "may have happened" (`metadata.indeterminate`) and "already
   happened" (`reason: "duplicate"`) as `result: "failure"`; the locked rules
   read only the result. Practically unreachable in v1 — an approved write runs
   in a confirmation trace whose request ("yes") yields no objectives — but it
   must be decided before the route exposes evaluations.
3. **A reply can yield up to three facts** (the reply, its pending action, its
   task id), so those refs carry a suffix: `message:<id>#pendingAction`,
   `message:<id>#taskId`.
4. **Attempts by a tool the registry does not know** are never attributed, and
   are counted as unattributable attempts: an objective with no attributed
   attempt is then `NOT_EVALUABLE` (ATTRIBUTION) rather than `NOT_ATTEMPTED`.
5. **`WriteVerification` has six members**, not four: `indeterminate` and
   `failed` are recognised; only `verified` corroborates.

### 7d.15 Phase 3 evidence

**The service is a read layer.** `ObjectiveEvaluationService.evaluate(userId,
traceId)` sets the 30-day window, runs two reads in parallel —
`findByTrace(userId, traceId, since, 201)` (S5's reader, unchanged) and
`findTraceMessages(userId, traceId, since, 10)` — returns `null` when both
are empty, marks the read truncated when more than 200 rows came back, and
calls `buildObjectiveEvaluation`. It adds no rule. Its dependencies are the
two readers, `riskOf` and an optional clock; the container passes
`resolvingRegistry.get(toolId)?.risk`, never the registry.

**The message reader** (`PrismaConversationRepository.findTraceMessages`)
filters on `createdAt >= since`, `metadata.traceId` equal to the trace id, and
`conversation.userId` equal to the caller — ownership is the query — oldest
first, capped at 50 rows whatever the caller asks. No schema change; the scan
is of the same class as the chat route's `getMessages`.

**Tests.** `apps/api/test/objective-evaluation-service-s6.test.ts` — 32
tests: T28 without HTTP (own trace; another user's and an unknown trace both
`null`; readers always given the caller's id; foreign rows and a foreign
message stamped with the trace id never leak), binding (one, zero, two user
messages; outside the window; the request is the user message only), traces
with no bound request (pre-PD-2, pending-action button, approvals REST,
scheduler), T38's reader arguments and parallel reads, row-limit propagation
at 201 and exactness at 200, feedback copied but inert, cross-trace approvals
and task state never followed, prose and secrets, determinism, T31's source
scan and wiring check, and T35's runtime guard (any access beyond the two
reads throws). Mutation checks — no extra row, fabricating instead of
`null`, dropping the window, sequential reads — each turn tests red.
`packages/db/test/conversation-trace-lookup-s6-pg.integration.test.ts` — 5
PostgreSQL tests for T38 (ownership, exact match, window, limit, shape); they
skip when the database is unreachable and were **not run** on 2026-09-25
because it was.

**PD-3 (locked for S6 v1).** An indeterminate or duplicate Google write follows
the locked table and may evaluate `BLOCKED`. There is no `INDETERMINATE`
status and `ObjectiveStatus` is unchanged. Known limitation, recorded here.

### 7d.16 Phase 4 evidence

**The route is thin.** `GET /api/v1/activity/trace/:traceId/evaluation` sits
beside the S5 trace routes in `activity.ts`: `requireAuth`, the same
`optionalString(traceId, 64)` validation as S5, one call to
`container.objectiveEvaluations.evaluate(req.auth.userId, traceId)`, and the
result returned unchanged — `200` with the evaluation, `404 NOT_FOUND` when
the service returns `null`. Unexpected failures fall through `asyncHandler` to
the existing error handler: `500 INTERNAL_ERROR`, fixed message. No new import.

**Tests.** `apps/api/test/objective-evaluation-route-s6.test.ts` — 20 tests
over a real HTTP socket with real JWTs, the real auth middleware, request-id
middleware and error handler: T28's HTTP half (own trace 200; unknown and
foreign 404 with identical bodies; malformed id 400 and no token / bad token /
wrong-secret token 401 without the service being asked; the path is the only
trace id), the contract cases (a "yes" request → 200 with no objectives and
`OBJECTIVE_CLASS`; the caller's own unbound trace → 200 `bound: false`), the
public shape (envelope, the eight fields, each item's fields, ISO dates, no
forbidden field), no secret / raw parameter / raw audit detail / raw error /
model prose on the wire, client-stamped approval rows and model prose changing
nothing, the 500 convention leaking nothing, T35 (a request touches only the
evaluation service and writes nothing) and T31 (the router's imports, no
forbidden name, and a handler that reads only `container.objectiveEvaluations`).
Mutation checks — trace id from the query, `200` for `null`, no validation,
the raw error returned — each turn tests red.

**Not found, precisely.** Per the approved contract (§5), `404` means the
caller has no audit row and no message for the trace. A trace for which the
caller has records but no bound request — pre-PD-2, a pending-action button,
an approvals-REST or scheduler trace — is `200` with `bound: false`, never an
inference about any other user: every read is scoped to the caller.

---

## 8. Not in S1-S5

Deliberately absent, each because it has no source of truth yet:

- `confidence`, `successRate`, `version`, `prerequisites` — nothing measures them.
- `agentId` on a skill — `packages/core` cannot import `AGENT_POLICIES`
  (dependency direction), and a skill is an outcome, not an agent's property.
- persistence, learning, MCP, schema, migrations.
- any skill runtime, executor, router or registry.
- frontend surface.
- **narrowing `providerTools`** — the seventy-three-definition conversational
  surface is untouched. Filtering it by matched skill is the next phase's
  question, and only safe once the matching has been shown accurate.
- skill-driven routing or agent selection.
- any cache of capability or availability.

---

## 8a. Open, and deliberately not decided here

**Google Ads is counted but not spoken.** The three tools are now members of the
advertising skill, and the briefing counts them. It still does not *say* them,
because `MAX_PHRASES_PER_GROUP` is 4 and the seven curated Meta phrasings fill
it first. Making Google Ads audible is a **presentation** decision — phrase
priority, or a per-integration quota — not a membership one, and changing it
would alter accepted output. It belongs to whichever phase owns presentation.

**`knowledge.` matches nothing.** Retrieval is an orchestrator step. Whether
knowledge should become a tool (and therefore gateable, phrasable and
allowlistable) is an architecture question, not a membership one.

**`web.research`, `document.analyze`, `pdf.generate` are granted to nobody.**
Whether that is intentional least privilege or an oversight is an
**authorization** question. S2 does not answer it; changing a policy was an
explicit stop condition.

---

## 9. Quality gates

See the session report accompanying this change for the exact run output.
`pnpm test` is not a root script in this repository — use `npx turbo test`.
`@jarvis/db` tests need PostgreSQL with pgvector on a **separate test database**.
