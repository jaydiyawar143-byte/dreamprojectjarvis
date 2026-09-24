# What JARVIS Can Do

JARVIS has no runtime object called a "skill". What JARVIS can **do** is the combination of two things:

1. a **domain agent** that owns a kind of request, and
2. the **tools** that agent is allowed to call.

Both are defined in `packages/agents/src/agent-policy.ts`. Adding a capability means adding a tool, granting it to an agent, or — rarely — adding an agent. It never means creating a `skills/` folder.

> **Not the same thing:** `.claude/skills/` holds skills for Claude Code — the `run-jarvis` driver and design guidance. They help people *build* JARVIS. JARVIS never loads them.

> **Since Skill System V1 / S1 (2026-09-23)** there IS a code-defined
> `SkillDefinition` and a `SKILL_CATALOG`, in `packages/core`. The sentence
> above still holds: they are **metadata**, not a runtime object. A skill names
> an outcome and the tools behind it; it runs through the planner and
> `ToolExecutor` like everything else, and it grants nothing — the allowlist in
> `agent-policy.ts` is still the only thing that decides what may run. See
> [`architecture/JARVIS_SKILL_SYSTEM_V1.md`](./architecture/JARVIS_SKILL_SYSTEM_V1.md).
>
> Phase S2 audited which tool belongs to which skill. Five tools are
> deliberately in **no** skill, each with a reason recorded in
> `SKILL_UNLISTED_TOOLS`: `self.describe` (introspection, not an outcome),
> the four `task.*` tools (JARVIS's own work queue, not your to-do list — which
> is `tasks.list`, a different tool for a different question) and `system.echo`
> (a test fixture). None of that changes what any of them may do.
>
> Phase S3 tells the planner which skills actually work right now, as a short
> block of prose composed into the message. It is **orientation, not
> permission**: the tool definitions offered to the model are unchanged, and
> every tool call is still checked against `agent-policy.ts` afterwards. A tool
> named in that block is not thereby authorized, and a tool missing from it is
> not thereby forbidden — which is why the unlisted tools above keep working.
>
> Phase S4 is **not** a composition engine. Doing several things for one
> request already worked: the general assistant may call tools from seven of
> the eight skills, and the orchestrator already ran up to five rounds, feeding
> each tool result back so the model could pick what to do next. What it could
> not do was **remember earlier rounds** — by step three, step one's findings
> were gone. S4 replays every round of the turn instead, within a character
> budget that drops the oldest first and never the newest. Limits are
> unchanged: five rounds, ten tool calls.
>
> Two things S4 deliberately did not do. **Cross-agent work is still not
> possible** — one agent runs per request, so "check my ads and WhatsApp me the
> summary" fails, because `whatsapp.send` belongs to the communication agent
> alone. And **durable, scheduled work stays with the Task Engine**: "every
> Monday, analyse and send" is not a conversation.
>
> Phase S5 added an **observer**. It can now tell you what happened during a
> request — which agent ran, which skills and tools took part, and how it ended
> — by reading the audit rows it already writes. And you can mark an answer 👍
> or 👎. Those are two different things on purpose: a tool working is not the
> same as an answer being useful, and an answer you never rated is **not** the
> same as one you disliked. S5 only records these. Nothing reads them back into
> how JARVIS decides anything — there is no learning here.

Verified against the code on 2026-09-17.

---

## Tool groups

Named groups keep each policy readable as a capability rather than a list of strings.

| Group | Tool ids | Risk |
|---|---|---|
| `META_READ_TOOLS` | `meta.accounts`, `meta.campaigns`, `meta.adsets`, `meta.ads`, `meta.insights`, `meta.analyze` | read-only |
| `META_WRITE_TOOLS` | `meta.campaign.pause`, `meta.campaign.resume`, `meta.adset.pause`, `meta.adset.resume`, `meta.ad.pause`, `meta.ad.resume`, `meta.campaign.budget.update`, `meta.adset.budget.update`, `meta.campaign.create` | every one approval-gated |
| `GOOGLE_READ_TOOLS` | `google.accounts`, `google.campaigns`, `google.insights` | read-only; no Google Ads write tool exists |
| `GOOGLE_WORKSPACE_TOOLS` | `gmail.listUnread`, `gmail.search`, `gmail.getMessage`, `gmail.getThread`, `drive.searchFiles`, `drive.listRecentFiles`, `drive.getFileMetadata`, `calendar.listUpcomingEvents`, `calendar.getEvent` | read-only |
| `GOOGLE_WRITE_PLAN_TOOLS` | `google.plan.gmail.createDraft`, `google.plan.gmail.updateDraft`, `google.plan.gmail.sendDraft`, `google.plan.drive.createFolder`, `google.plan.drive.uploadFile`, `google.plan.drive.moveFile`, `google.plan.drive.renameFile`, `google.plan.calendar.createEvent`, `google.plan.calendar.updateEvent`, `google.plan.calendar.deleteEvent` | plan only — each creates an approval; a person's approval runs the write |
| `ANALYSIS_TOOLS` | `data.csv.analyze` | no network, no side effect — **granted but never registered**, see below |
| `MAPS_TOOLS` | `maps.search`, `maps.nearby`, `maps.geocode`, `maps.reverse.geocode`, `maps.current.location`, `maps.route`, `maps.distance`, `maps.place` | read-only |
| `AMBIENT_TOOLS` | `weather.current`, `market.quote`, `system.status`, `time.now`, `tasks.list` | read-only |
| `INTEGRATION_READ_TOOLS` | `integration.list`, `integration.status`, `integration.health`, `integration.permissions`, `integration.audit`, `integration.test`, `integration.validate` | read-only |
| `INTEGRATION_WRITE_TOOLS` | `integration.connect`, `integration.configure`, `integration.reconnect`, `integration.enable`, `integration.disable`, `integration.disconnect` | `integration.disconnect` is approval-gated; the rest write only to JARVIS's own encrypted store |
| `CAPABILITY_TOOLS` | `capabilities.list`, `capabilities.connected`, `capabilities.integration`, `capabilities.permissions` | read-only; granted to **every** agent |
| Single tools | `n8n.trigger`, `whatsapp.send` | approval-gated |
| `BROWSER_READ_TOOL_IDS` (in `packages/core/src/types/browser.ts`) | `browser.navigate`, `browser.inspect`, `browser.extract`, `browser.screenshot` | read-only |
| `BROWSER_ACTION_TOOL_IDS` (same file) | `browser.click`, `browser.type`, `browser.select`, `browser.submit`, `browser.download`, `browser.upload` | every one approval-gated |

## The nine agents

| Agent id | Registered | May call | Role floor |
|---|---|---|---|
| `conversational-assistant` | always | Meta read + write, Google read, analysis, maps, ambient, integration read + write, capability, Google Workspace, Google write-plan | read |
| `meta-ads-agent` | always | Meta read + write, integration read, capability | read |
| `knowledge-agent` | always | capability only — retrieval already happened in the orchestrator, so it holds no search tool on purpose | read |
| `analytics-agent` | always | Meta read, Google read, analysis, integration read, capability — no writes | read |
| `google-ads-agent` | when `google.accounts` is registered | Google read, integration read + write, capability, Google Workspace, Google write-plan | read |
| `automation-agent` | when `n8n.trigger` is registered | `n8n.trigger`, integration read, capability | read + write |
| `communication-agent` | when `whatsapp.send` is registered | `whatsapp.send`, integration read, capability | read + write |
| `browser-agent` | when `browser.navigate` is registered | browser read + action, capability | read + write |
| `location-agent` | when `maps.route` is registered (effectively always) | maps, integration read, capability | read |

Every policy sets `writesRequireApproval: true`. The allowlist decides **who may propose** a tool call; the approval boundary decides **whether it runs**. When an integration-backed agent is not registered, the router falls through to the next candidate and the request usually lands on `conversational-assistant`.

## Tools that exist but no agent can use

Five tool classes are exported by `packages/tools` and covered by its tests, but `apps/api/src/services/container.ts` never registers them. At runtime no agent can call them.

| Tool id | Class | Granted by a policy? |
|---|---|---|
| `data.csv.analyze` | `CsvAnalyzerTool` | **Yes** — in `ANALYSIS_TOOLS`, held by `conversational-assistant` and `analytics-agent`. The grant points at a tool that is never registered. |
| `document.analyze` | `DocumentAnalyzerTool` | No |
| `pdf.generate` | `PdfGeneratorTool` | No |
| `web.research` | `WebResearchTool` | No |
| `system.echo` | `SystemEchoTool` | No |

Wiring any of them in is a capability decision, not a cleanup step — see `CODEBASE_AUDIT.md`, D-6.

## Adding a capability

1. **Search first.** The capability may already exist under another name.
2. **A new provider operation:** follow "Adding a new integration" in `AGENTS.md`. You do not write a new route, tool or frontend control for an integration.
3. **A new tool:** add it under `packages/tools/src/tools/`, register it in `apps/api/src/services/container.ts`, and give it the right risk level. Tools receive ports; they never import a provider SDK.
4. **Grant it:** add the tool id to the relevant group, or directly to the right agent, in `agent-policy.ts`. Grant narrowly.
5. **A new agent** only when a whole kind of request needs its own prompt and allowlist: add it under `packages/agents/src/agents/`, add an id to `AGENT_IDS`, add a policy, and register it in the container. The registry refuses an agent with no policy.
6. Test the allowlist decision as well as the tool.
