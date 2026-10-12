# The Marketing Workspace

How JARVIS plans content, keeps a calendar, organises campaigns, researches
pages, reports on performance, recommends, and publishes — and the rules a
change to any of it must not break.

Added in Phase 15. The record of that phase — what was built, what was tested,
what is blocked and why — is [`phases/phase-15.md`](phases/phase-15.md). This
file is the contract.

---

## 1. What it is, in one picture

```
  A sentence in chat ──► Orchestrator ──► MarketingAgent ──┐
                         (allowlist, write-intent gate,    │
                          role, pending action)            ▼
                                                    ToolExecutor ──► marketing.* tool ──► MarketingService
  A button on /marketing ──► /api/v1/marketing/* ───┘ (validate, role,                       │
                             (one tool per endpoint)   approval, audit)                      ├─► PostgreSQL (own store)
                                                                                             ├─► ToolExecutor ► meta.* READ tools
                                                                                             ├─► PublicPageFetcher (public pages)
                                                                                             └─► ContentPublisher (one Page post)
```

There is **one implementation**: `MarketingService`
(`apps/api/src/services/marketing/marketing-service.ts`). The tools hold it as
their port. The REST router implements nothing — every endpoint turns a request
into one tool call and runs it through `ToolExecutor`, the same tool with the
same id the marketing agent proposes in chat. So a button and a sentence pass
one permission check, one approval gate and one audit row.

`apps/api/test/marketing-e2e-pg.integration.test.ts` proves it on PostgreSQL:
what chat saves, the page reads; what the page asks to publish, the same tool
publishes.

---

## 2. The words, and what each one means

The workspace exists to keep four things apart. Every screen, tool result and
report uses these words and only in these senses.

| Word | Meaning | How it is recorded |
|---|---|---|
| **Saved** | In JARVIS's own store. Nothing left JARVIS. | A row. `status` `IDEA` or `DRAFT`. |
| **Ready** | The words are final. Still nothing left JARVIS. | `status = READY`. Editing the copy returns it to `DRAFT`. |
| **Published · verified** | JARVIS posted it **and read the post back from the provider**. | `publication_mode = VERIFIED`, with the provider's post id and `verified_at`. |
| **Published · reported by you** | The user said they posted it. JARVIS did not publish it and has not checked. | `publication_mode = REPORTED_BY_USER`. No post id, no `verified_at`. |
| **Publish not confirmed** | A publish was sent and its outcome is not known. **Not** published. | `publish_state = UNCONFIRMED`. |
| **Recommendation** | Advice computed from the workspace. Not carried out. | `executed: false` on every one. Never stored as an action. |

A status alone never means published. The database refuses a row that says
`PUBLISHED` without a publication mode, and refuses `VERIFIED` without a post
id, a provider and a verification time (two `CHECK` constraints in the Phase 15
migration).

---

## 3. What exists

### Data (PostgreSQL, `packages/db`)

| Table | Holds |
|---|---|
| `MarketingCampaign` | A campaign **workspace**: name, goal, brief, dates, channels, status, and the Meta campaign ids its reports read. Not an ad campaign. |
| `ContentItem` | One piece of content: channel, copy, link, planned date, status, publish state, publication record. |
| `MarketingReport` | A generated report: the saved document, its period, how many data sources contributed. |
| `MarketingResearch` | One reading of one page: an SEO audit or a competitor snapshot, with where and when it was read. |

Every row carries `user_id`. A row may belong to one of its owner's projects
through a composite key `(project_id, user_id) → Project(id, user_id)`, so a
row can never be attached to another user's project even by a caller that
skipped its check.

### Tools (`packages/tools/src/tools/marketing-tools.ts`)

| Tool | Risk | Role needs | Approval | Registered |
|---|---|---|---|---|
| `marketing.campaign.list`, `.get` | READ_ONLY | read | no | always |
| `marketing.content.list` | READ_ONLY | read | no | always |
| `marketing.research.list` | READ_ONLY | read | no | always |
| `marketing.report.generate`, `.list`, `.get` | READ_ONLY | read | no | always |
| `marketing.recommendations` | READ_ONLY | read | no | always |
| `marketing.campaign.create`, `.update` | LOW_IMPACT | read, write | no | always |
| `marketing.content.plan`, `.update`, `.mark_published` | LOW_IMPACT | read, write | no | always |
| `marketing.seo.audit`, `marketing.competitor.analyze` | READ_ONLY | read | no | only when page reads are switched on |
| `marketing.publish.prepare` | READ_ONLY | read | no | only when a publisher exists |
| `marketing.content.publish` | EXTERNAL_SIDE_EFFECT | read, write | **yes** | only when a publisher exists |

`marketing.report.generate` is a read for the reason `meta.analyze` is: it
changes nothing outside JARVIS, and what it saves is a bounded record of what
it read. A report is asked for as a question as often as an order, and a tool
classed as a write would be refused on every such question.

### Who may call them (`packages/agents/src/agent-policy.ts`)

- **`marketing-agent`** — all seventeen, plus the Meta **read** tools. No Meta
  write tool, no messaging, no automation, no memory deletion.
- **General assistant** — everything **except** the two publish tools.
- **No other agent** holds any marketing tool.

Only one agent can propose a publish. The general assistant can plan and
report; it is never handed a tool that posts.

### HTTP (`apps/api/src/routes/marketing.ts`)

`/api/v1/marketing/*` — listed in [`API.md`](API.md). One endpoint, one tool.
The router decides only what belongs to HTTP: who the caller is (the verified
token, never the body), which status a refusal maps to, and the envelope.

### The screen (`apps/web/src/app/marketing`)

Five views: Calendar, Campaigns, Research, Reports, Recommendations. It draws
no control that could not do anything — see §9.

---

## 4. Scope: whose rows, and which project

Two filters, always written side by side: the **user**, and the **scope**.

| Caller | Scope |
|---|---|
| A tool call made **in a conversation** | The conversation's own project, read from the conversation row by `(conversation, user)`. A conversation with no project sees personal rows only. A `projectId` in the parameters that is not the conversation's is **refused** (`OUT_OF_SCOPE`), never obeyed — a model has no way to name a project. |
| A call with **no conversation** (the page) | One of the user's own projects when named, otherwise everything the user owns. A project that is not the caller's is answered exactly as one that does not exist. |

Another user's row, another project's row and an unknown id are one answer:
not found.

---

## 5. Publishing

### What can be published today

**A text post, with an optional link, to a Facebook Page** the configured Meta
token is allowed to post to. Nothing else. Instagram, LinkedIn, X and the rest
are content channels you can plan for; JARVIS has no publisher for them, says
so, and offers "I posted this myself" instead.

### The sequence

```
Plan → Explain → Confirm → Execute → Audit → Verify → Report
```

1. **Check** (`marketing.publish.prepare`, a read). The server builds
   `publishParams` from the **saved** item and the provider's **own** list of
   Pages: `{ contentId, targetId, targetName, message, link? }`.
2. **Ask.** An approval row is created, bound by hash to exactly those
   parameters. The person is shown the exact text and the Page. Nothing has
   been sent.
3. **Decide.** On the Approvals API (page) or as a pending action answered by
   its id (chat). One conditional `UPDATE`. A voice session cannot do this.
4. **Execute** (`marketing.content.publish`). The tool begins a journal record
   keyed by the approval, and **consumes the approval in the same durable step
   that claims the execution** — one approval, at most one run.
5. **Re-check, then claim.** Before a byte is sent the service checks again:
   the item is still ready, the saved text is still the approved text, the Page
   is still one this connection may post to and still has the approved name.
   Then one conditional `UPDATE` (`claimForPublish`) gives exactly one
   execution the item.
6. **Send, then read back.** The post is published only when it can be read
   from the provider by its id and its text is the text that was sent.
7. **Record and report.** `PUBLISHED · VERIFIED`, or exactly what happened
   instead.

### Every outcome, and what it is called

| What happened | Result | Item afterwards |
|---|---|---|
| Posted and read back | `PUBLISHED` | Published · verified |
| An earlier attempt had already posted it; found on the Page | `ALREADY_PUBLISHED` — nothing new sent | Published · verified |
| Text changed since approval | `STALE` — nothing sent | Unchanged |
| Not ready, not found, no publisher | `NOT_READY` — nothing sent | Unchanged |
| Page gone or renamed since approval | `TARGET_REFUSED` — nothing sent | Unchanged |
| Another publish of it is running | `IN_PROGRESS` — nothing sent by this one | Unchanged |
| The provider refused | `FAILED` — nothing published | Ready; the refusal is recorded |
| Sent, and the answer never came | `UNCONFIRMED` | **Not** published; `UNCONFIRMED` |
| Accepted, but could not be read back | `UNCONFIRMED` | **Not** published; the post id is kept |

### An unknown outcome is never retried blindly

When an item is `UNCONFIRMED`, the next publish **looks first**: it reads the
post by the id it kept, then looks through the Page's recent posts for the
exact text. Found — it is recorded as published and nothing new is sent. Not
found — it posts. If the Page cannot be checked, **nothing is posted**: a
duplicate public post is worse than a delay.

### What a caller can and cannot supply

A caller can name an item, a target and an approval. **It cannot supply the
text.** The page's publish endpoint takes no text at all. In chat a model does
pass `message` — and if it is not exactly the saved text, the service refuses
(`STALE`) after the person has approved it, so words a model wrote can never go
out in place of words that were saved.

One consequence, stated rather than hidden: what a model is shown has
secret-shaped words removed (`password`, `token`, `secret` and the like), or is
shortened when it is very long. A post whose text would be altered that way
could only ever come back from the model different from the saved text. So in
chat the publish check says up front that the item must be published from the
Marketing page — instead of letting the person approve something that would
then be refused.

### Declining

Declining one publish blocks nothing else. Both arms name the approval they
execute, so a rejected approval for one post never shadows a request for
another (see finding F-2 in the phase record).

---

## 6. Research

`marketing.seo.audit` and `marketing.competitor.analyze` read **one public web
page** through `PublicPageFetcher` (`packages/browser/src/page-fetcher.ts`) and
report what is on it.

- **Off unless the operator switched it on**: `BROWSER_ENABLED=true`. It needs
  no Chrome. Where it is off the two tools are not registered and the screen
  draws no form.
- **Every hop is judged** by the same navigation policy the browser tools use:
  scheme, port, credentials in the address, the domain allowlist
  (`BROWSER_DOMAIN_ALLOWLIST`), and every resolved address must be public. The
  connection is then **pinned to the address that was judged**, so a name that
  resolves differently a moment later cannot be used to reach an internal host.
- **Bounded**: 15 seconds, 2 MB of decoded body, 5 redirects.
- **A refused address is the caller's input, not a failed provider.** An
  address the policy will not open is answered `INVALID` (HTTP 400), in the
  reader's own fixed sentence. A page that could not be reached, or was not
  HTML, is `PROVIDER_FAILED` (HTTP 502). Neither saves anything.
- **Metered**: 20 page reads per user per 10 minutes, counted in the audit
  table so the limit holds across processes. Past it: `RATE_LIMITED` (HTTP 429)
  and nothing is read.
- **Untrusted**: a page's text is somebody else's writing. Results carry an
  explicit notice and the content is marked as data before any model sees it.

### What an audit is, and is not

An audit is the page's own title, description, headings, canonical address,
language, images, links and word count, checked against fixed rules in
`packages/core/src/seo-audit.ts`. **No model is involved.**

It does **not** contain rankings, search volume, traffic, backlinks or keyword
difficulty. None of those can be read from a page and none is estimated. Every
result lists what was not measured, in the result itself.

A competitor snapshot is the same facts for someone else's page, compared with
the user's own page when one is given, and with the **previous saved reading of
the same page** — which is how "what changed" is answered. When the user's own
page cannot be read, the competitor is still reported and the result says the
comparison is missing; it never shows an empty comparison that could be read as
"no differences".

---

## 7. Reports

A report is a **saved document**: arithmetic over rows that were read, built by
pure functions in `packages/core/src/marketing-report.ts`. No model writes it.

### Where the figures come from

| Source | How it is read | In this version |
|---|---|---|
| **Meta Ads** | The registered `meta.*` read tools, run **through `ToolExecutor` as a `viewer`**, for the server's configured ad account. Each read has its own audit row; the report lists their execution ids. | Included when readable. |
| **Google Ads** | Not read. The capability layer is asked whether it **could** be — from the scopes Google actually granted — and the answer is recorded in every report. | **Never included** (see below). |
| **The workspace's content** | The marketing repository. | Included. |

### The rules

- **A source that was not read contributes nothing.** It is listed with what
  happened to it — included, empty, not set up, not connected, access not
  granted, could not be read — and no figure.
- **Unknown is not zero.** A metric the provider never sent is shown as not
  available, and nothing is derived from it.
- **Reach is not added across campaigns.** One person reached by two campaigns
  is one person.
- **A provider's own error text never enters a report**, and an account id is
  always masked.
- **Period**: at most 90 days — the widest window the ad-account read accepts
  in one call. Default: the last 30 complete days, compared with the 30 before.

### Google Ads

Phase 15 puts **no Google Ads figure in any report**. Using Google Ads requires
its access scope to have been granted and that grant verified; at the time of
this phase no Google connection carried it. So `googleAdsReportSource`
(`apps/api/src/services/marketing/google-ads-source.ts`) asks the capability
service and records one of:

| Status | Meaning |
|---|---|
| `NOT_CONFIGURED` | The Google Ads read tools are not registered on this server. |
| `NOT_CONNECTED` | No usable Google connection. |
| `SCOPE_NOT_GRANTED` | Connected, and Google did not grant Ads access. |
| `NOT_INCLUDED` | Every gate is open — and this version still includes nothing. |

It **never** answers `INCLUDED`, and the service coerces that value to
`NOT_INCLUDED` even if a caller supplied it.

### Client reports

A client report is the same document under a different heading, exported as a
self-contained HTML file or Markdown (`GET /reports/:id/export`). It is sent as
a download, never rendered in the application's origin, and loads and runs
nothing. **Nothing sends a report to anyone.** There is no delivery to claim.

---

## 8. Recommendations

`marketing.recommendations` applies fixed rules
(`packages/core/src/marketing-recommendations.ts`) to the calendar, the latest
saved report and saved audits. Each recommendation lists the facts it rests on
and carries `executed: false`. There is no tool, endpoint or button that
carries one out: acting on advice means doing the thing, through the path that
thing always takes.

---

## 9. What is available where

| Capability | Needs | When it is missing |
|---|---|---|
| Campaigns, calendar, content, recommendations | The database | — |
| Reports with ad figures | `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` | The report says Meta Ads is not set up and contains no ad figure. |
| SEO audit, competitor page | `BROWSER_ENABLED=true` | Tools not registered; the screen says why and draws no form. |
| Publishing to a Facebook Page | The Meta credentials, and a Page the token may post to | Tools not registered; no Publish button anywhere. |
| Google Ads in reports | — | Not included in this version, whatever is connected. |

`GET /api/v1/marketing/status` reports the first four for the deployment, and
— from the same role table the executor checks — which of them the caller's
role could use. The screen draws from that; the executor still decides.

---

## 10. Rules a change must not break

1. **One implementation.** Marketing behaviour lives in `MarketingService`. No
   route, and no tool, implements a marketing rule of its own. A new endpoint
   runs a tool through `ToolExecutor`.
2. **Published means read back.** `VERIFIED` is written only after the post was
   read from the provider by its id. Never from a provider's "accepted", never
   from a status code, never on a timeout.
3. **The two kinds of published stay two.** `REPORTED_BY_USER` is never
   upgraded to `VERIFIED` and never worded like it.
4. **An unknown outcome is a state.** It is not published, it is not a failure
   to retry, and the next attempt looks before it sends.
5. **The text of a post comes from the saved item.** No endpoint accepts it,
   and a tool call whose text differs from the saved text is refused.
6. **Publishing is approval-gated, by the exact parameters.** No path publishes
   without an approval bound to the text and the Page, and none may be added.
7. **The claim is one conditional write.** Never read the publish state, check
   it in memory and then write.
8. **Nothing is reported that was not read.** No estimated metric, keyword,
   ranking, competitor figure or connection. A source that could not be read is
   said to be unread.
9. **Google Ads stays out of reports** until a grant carrying the Ads scope
   exists and a read against it has been verified.
10. **Page reads go through `PublicPageFetcher`.** Nothing in marketing opens a
    connection to an address a user supplied by any other route.
11. **Scope beside ownership.** Every project filter is written beside the user
    filter. The conversation decides the project; the request body never does.
12. **The service's own audit rows hold ids and outcomes** —
    `marketing.publish`, `marketing.research.fetch`,
    `marketing.report.generated`, `marketing.content.reported_published`. Never
    the text of a post, never a path or query string of a page that was read,
    never a credential, never a provider's own error text. (The executor's
    generic `tool.execute` row records each tool's parameters, as it does for
    every tool in JARVIS, after the audit system's redaction. For a publish
    those parameters are the approved text and Page — the same thing the
    approval row holds.)
13. **A date is a plan.** Nothing publishes because a date arrived. There is no
    scheduler here and adding one is a separate, reviewed change.
