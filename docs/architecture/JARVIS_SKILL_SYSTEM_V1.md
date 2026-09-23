# JARVIS Skill System V1 — Phases S1 and S2

> **S1 — Skill Foundation.** The type, the catalogue, the derived view.
> **S2 — Skill Taxonomy & Membership Audit.** Which tool belongs to which skill,
> and why some belong to none.
>
> **Status: IMPLEMENTED, not committed.** Nothing here executes.
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

## 8. Not in S1 or S2

Deliberately absent, each because it has no source of truth yet:

- `confidence`, `successRate`, `version`, `prerequisites` — nothing measures them.
- `agentId` on a skill — `packages/core` cannot import `AGENT_POLICIES`
  (dependency direction), and a skill is an outcome, not an agent's property.
- persistence, learning, MCP, schema, migrations.
- any skill runtime, executor, router or registry.
- frontend surface. `buildSkillViews()` is exported and has no caller yet; S1
  builds the foundation, not the feature on top of it.

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
