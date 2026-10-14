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
| **Publish not confirmed** | A publish was sent and its outcome is not known. **Not** published, **not editable**, and **nothing more is sent for it** until it is settled (§5). | `publish_state = UNCONFIRMED`, with the record of the original attempt: its Page and a hash of what was sent. |
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
| `marketing.publish.resolve` | LOW_IMPACT | read, write | no — it is itself a person's decision | only when a publisher exists; **offered to no agent** |

A publisher exists only where the operator has switched publishing on
(`MARKETING_PUBLISH_ENABLED=true`) **and** the Meta integration is configured
(§9).

`marketing.report.generate` is a read for the reason `meta.analyze` is: it
changes nothing outside JARVIS, and what it saves is a bounded record of what
it read. A report is asked for as a question as often as an order, and a tool
classed as a write would be refused on every such question.

### Who may call them (`packages/agents/src/agent-policy.ts`)

- **`marketing-agent`** — seventeen of the eighteen, plus the Meta **read**
  tools. No Meta write tool, no messaging, no automation, no memory deletion.
- **General assistant** — the same, **except** the two publish tools.
- **No other agent** holds any marketing tool.
- **No agent at all** holds `marketing.publish.resolve`. Whether an earlier post
  went out is something a person looks at a Page to know; the tool also refuses
  any call that carries an agent or a conversation.

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

**Publishing is off unless the operator switches it on.** The credentials that
read the ad account are the ones a Page publisher would use, so they are not
allowed to make a deployment able to post publicly on their own:
`MARKETING_PUBLISH_ENABLED` must be exactly `true`. Anything else — absent,
empty, `1`, `yes`, `TRUE` — leaves it off. While it is off the three publish
tools are not registered, so there is nothing for a sentence or a button to
reach: the page's publish endpoints answer `503 UNAVAILABLE` with the reason,
no agent is offered a publish tool, and **no approval for a publish can come to
exist**.

**In a conversation, where it is off.** The marketing agent's instructions are
built from the tools it was actually handed. With both publish tools it is told
how to publish; without them it is told that publishing is not available on
this server, why, and — in the operator's own sentence — how it is switched on,
and it is told not to call a publish tool. If a model names one anyway, the
orchestrator answers the call itself (`unavailable`, with that sentence) before
the executor is asked: the turn is an ordinary reply, not an error, and no
execution, approval or pending action is created. The refusal is audited
(`agent.tool_unavailable`). This is only for the tools the server named as
switched off: the two publish tools where publishing is off, and the two page
reads — the SEO audit and the competitor comparison — where page reads are off
(`BROWSER_ENABLED` not `true`), each with its own sentence.

### The sequence

```
Plan → Explain → Confirm → Execute → Audit → Verify → Report
```

1. **Check** (`marketing.publish.prepare`, a read). The server builds
   `publishParams` from the **saved** item and the provider's **own** list of
   Pages: `{ contentId, targetId, targetName, message, link?, earlierAttempt? }`.
   `earlierAttempt` is there only when an earlier publish of the item is
   unconfirmed. It names that attempt — when it was recorded, where it went and
   a hash of what it sent, as one opaque value, never the text — and its
   presence is what makes these the parameters of a **look** rather than of a
   send.
2. **Ask.** An approval row is created, bound by hash to exactly those
   parameters — so to the state the item was in, too. The person is shown the
   exact text and the Page, and which of the two it is: a post that will go
   out, or a look for an earlier one in which nothing is posted. Nothing has
   been sent.
3. **Decide.** On the Approvals API (page) or as a pending action answered by
   its id (chat). One conditional `UPDATE`. A voice session cannot do this.
4. **Execute** (`marketing.content.publish`). The tool begins a journal record
   keyed by the approval, and **consumes the approval in the same durable step
   that claims the execution** — one approval, at most one run.
5. **Re-check, then claim.** Before a byte is sent the service checks again:
   the item is still ready, the saved text is still the approved text, the Page
   is still one this connection may post to and still has the approved name.
   Then a conditional `UPDATE` (`claimForPublish`) gives exactly one execution
   the item — **only from the state the approval was made for**. An approval
   to send takes it from an item with no publish outstanding (`FRESH`); an
   approval to look takes it from an item whose earlier publish is unconfirmed,
   and only while the attempt outstanding is the one it named. Only a `FRESH`
   claim may send, and an approval to look can never take one: if the attempt
   it was for has been settled in the meantime — in another tab, by the same
   person — the statement that would make it a send is never issued, nothing
   is taken and nothing is sent. Nor does an approval to send run as a look
   because another publish went out first. Either way the person is asked
   again. Written in the same statement as a `FRESH` claim: where the attempt
   is going and a hash of what it sends, so an attempt that dies before it can
   report still leaves both behind.
6. **Send, then read back.** The post is published only when it can be read
   from the provider by its id **and the text that comes back is the text that
   was sent**. A post read back with other text, or with no text at all, is not
   published. **Nor is a post that is already another item's**: one post on the
   provider is one item here, whoever's item it is. The record that writes
   `VERIFIED` refuses a post id another item holds, under a lock on that id, so
   two items that found the same post cannot both record it.
7. **Record and report.** `PUBLISHED · VERIFIED`, or exactly what happened
   instead.

### Every outcome, and what it is called

| What happened | Result | Item afterwards |
|---|---|---|
| Posted and read back, with the text that was sent | `PUBLISHED` | Published · verified |
| An earlier attempt had already posted it; found on its Page **with the item's text** | `ALREADY_PUBLISHED` — nothing new sent | Published · verified |
| Text changed since approval | `STALE` — nothing sent | Unchanged |
| Not ready, not found, no publisher | `NOT_READY` — nothing sent | Unchanged |
| Page gone or renamed since approval | `TARGET_REFUSED` — nothing sent | Unchanged |
| Another publish of it is running | `IN_PROGRESS` — nothing sent by this one | Unchanged |
| The provider refused | `FAILED` — nothing published | Ready; the refusal is recorded |
| Sent, and the answer never came | `UNCONFIRMED` (`AMBIGUOUS_OUTCOME`) | **Not** published; `UNCONFIRMED` |
| Accepted, but could not be read back | `UNCONFIRMED` (`VERIFY_FAILED`) | **Not** published; the post id is kept |
| Accepted, and read back with other text or none | `UNCONFIRMED` (`VERIFY_MISMATCH`, `VERIFY_NO_TEXT`) | **Not** published; the post id is kept |
| A retry looked for the earlier post and did not find it | `UNCONFIRMED` (`NOT_FOUND_ON_PAGE`) — **nothing sent** | Still `UNCONFIRMED` |
| A retry found a post from the earlier attempt whose text it could not confirm | `UNCONFIRMED` (`RECONCILE_MISMATCH`) — nothing sent | Still `UNCONFIRMED` |
| A retry named another Page than the earlier attempt's | `TARGET_REFUSED` (`TARGET_CHANGED`) — nothing sent | Still `UNCONFIRMED` |
| The item's text is no longer what the earlier attempt sent | `STALE` (`TEXT_CHANGED`) — nothing sent | Still `UNCONFIRMED` |
| The Page could not be checked | `FAILED` (`RECONCILE_FAILED`) — nothing sent | Still `UNCONFIRMED` |
| An approval to **look** is run after the attempt it was for was settled | `STALE` (`STATE_CHANGED`) — **nothing sent** | Unchanged: ready, nothing outstanding |
| An approval to **send** is run after the item became unconfirmed | `STALE` (`STATE_CHANGED`) — nothing sent, and nothing looked for | Still `UNCONFIRMED` |
| An approval to look names an attempt that is no longer the one outstanding | `STALE` (`ATTEMPT_CHANGED`) — nothing sent | Still `UNCONFIRMED`, its record untouched |
| Accepted, and read back — but the post is already recorded as another item's | `UNCONFIRMED` (`POST_RECORDED_ELSEWHERE`) | **Not** published; the post id is kept |

### Nothing is sent for an item whose publish is unconfirmed

An `UNCONFIRMED` item has an earlier attempt that may or may not have posted.
From that moment, and until it is settled:

- **The item cannot be edited** — not its words, its link, its date, its status
  or its notes. A post with these words may be on the Page; the item goes on
  saying exactly what was sent. (One conditional `UPDATE`: an edit applies only
  to an item whose publish state is `NONE`.)
- **The record of the original attempt is kept as it is** across every retry:
  the Page it went to, when, the post id if the provider gave one, and a hash of
  the text and link that were sent. It never holds the text.
- **A retry is held to that record.** It cannot be aimed at another Page — the
  publish check offers only the original one, and an approval naming another is
  refused at execution — and it cannot be for other words.
- **A retry only looks. It sends nothing.** It reads the post by the id that
  was kept, then looks through that Page's recent posts for the exact text:

  | What the look finds | What happens |
  |---|---|
  | The post, **with the item's text** | Recorded as published · verified. Nothing new is sent. |
  | A post with that id, with other text or no text | Nothing is recorded. Still unconfirmed. |
  | Only a post that is already recorded as **another item's** | It is passed over: that post is the other item's, whatever its text. Still unconfirmed. |
  | Nothing | **Nothing is sent.** Still unconfirmed. |
  | The Page cannot be asked | Nothing is sent. Still unconfirmed. |

  Two calendar items can hold the same words. A post another item already
  holds is never taken for this one's: it is passed over and the Page is looked
  through again without it, so this item's own post — a different post, further
  down — can still be found. More than a handful of such posts is "could not
  tell", which changes nothing.
- **What is approved for such an item is the look, and the approval says so.**
  Its parameters carry the attempt it is for; the person is shown "look", not
  "publish"; and it runs only against that attempt (see step 5).

There are three ways out, and each is a fact or a person's decision — never
the system's guess:

1. **The post is found** by a retry or by step 3 below, and recorded.
2. **"I posted this myself"** (`marketing.content.mark_published`): recorded as
   *reported by you*, never as verified.
3. **"It was not published"** (`marketing.publish.resolve`, from the Marketing
   page only). Before it looks at all, JARVIS holds the decision to the attempt
   as it holds a retry: the item must still hold **exactly the words that
   attempt sent** (the hash that was kept; an attempt that kept none cannot be
   cleared), and the Page it went to must still be **one this connection can
   read**. If either is not so — the row was changed underneath, the Page was
   taken away — nothing is looked for and nothing is cleared: "not found" would
   mean nothing. Nor is anything cleared if the attempt under its claim is not
   the attempt it read a moment before — the first was settled and the item
   sent again in between: a decision about one attempt is not carried out on
   another (`409`). Then JARVIS looks once more. If the post is there after all,
   it is recorded as published and nothing is cleared. If a post from the
   attempt is there with other text, or the Page cannot be checked, nothing
   changes. Only if the post is not there is the attempt cleared — after which
   the item can be edited and published again, **and publishing it again posts
   it**. The decision is audited (`marketing.publish.resolve`: who, which item,
   the decision, what the look found — ids only), and **the audit row is
   written in the same transaction as the change it describes**. An attempt is
   never cleared, and an item never recorded as published by this path,
   without that row: if it cannot be written the decision is not carried out,
   the item stays unconfirmed, and the person is told so (`503`).

**What this does and does not guarantee.** JARVIS never sends a second post on
its own judgement: after an unknown outcome, another post requires a person to
say the first one did not happen, *and* JARVIS not finding it when it looks. It
is **not** a guarantee that a duplicate is impossible. If the first post is in
fact live, is not among the Page's 25 most recent posts or is not returned by
the provider when JARVIS looks, and the person says it was not published, the
next publish will post it again. That decision is the person's, and it is
recorded as theirs.

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
- **Metered**: 20 page reads per user per 10 minutes. A slot is **reserved
  before the page is fetched** — the count and the reservation are one step in
  PostgreSQL, so requests that arrive together cannot all be let through, on
  one API process or several. A comparison that reads two pages takes two
  slots. A read that fails or is refused has still used its slot. Past the
  limit: `RATE_LIMITED` (HTTP 429) and nothing is fetched.
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
- **Metered, before the ad account is read.** 10 reports per user per 10
  minutes, reserved the same way a page read is; and at most 500 saved reports
  per user. **Both are answered before any provider call**: a request over
  either limit reads nothing from the ad account (`429 RATE_LIMITED`,
  `409 LIMIT`). Opening or exporting a saved report is not metered — it reads
  nothing outside JARVIS.

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
| Publishing to a Facebook Page | `MARKETING_PUBLISH_ENABLED=true`, the Meta credentials, and a Page the token may post to | Tools not registered; no Publish button anywhere; the screen says whether it is switched off or not configured. |
| Google Ads in reports | — | Not included in this version, whatever is connected. |

`GET /api/v1/marketing/status` reports the first four for the deployment, and
— from the same role table the executor checks — which of them the caller's
role could use. The screen draws from that; the executor still decides.

### Limits on work that reaches outside JARVIS

Each is per user, over 10 minutes, and each takes its slot **before** the
provider is called (`AtomicRateLimiter`, `apps/api/src/services/rate-limiter.ts`;
the reservation is the audit row `marketing.limit.*`, counted exactly).

| Work | Limit | Past it |
|---|---|---|
| A page read (SEO audit, competitor page) | 20 | `429 RATE_LIMITED`; nothing fetched |
| A report | 10 | `429 RATE_LIMITED`; the ad account is not read |
| A publish check, and the look made when a person settles an unconfirmed publish | 60 | `429 RATE_LIMITED`; the provider is not asked, and no approval is created |

If the limit itself cannot be checked — the database cannot be reached — the
work is refused (`503 UNAVAILABLE`), never let through.

---

## 10. Rules a change must not break

1. **One implementation.** Marketing behaviour lives in `MarketingService`. No
   route, and no tool, implements a marketing rule of its own. A new endpoint
   runs a tool through `ToolExecutor`.
2. **Published means read back.** `VERIFIED` is written only after the post was
   read from the provider by its id. Never from a provider's "accepted", never
   from a status code, never on a timeout. **And one post is one item's**: a
   post id another item already holds — any user's — is never recorded a second
   time. `finalizePublished` is the only writer of `VERIFIED` and it enforces
   this under a lock on the post's id; never add a second writer, and never
   move the check out of that transaction.
3. **The two kinds of published stay two.** `REPORTED_BY_USER` is never
   upgraded to `VERIFIED` and never worded like it.
4. **An unknown outcome is a state.** It is not published and it is not a
   failure to retry. While it lasts the item cannot be edited, a retry is held
   to the original attempt's Page and words, and **a retry only looks — it
   never sends**. A post found is recorded only if its text is the item's
   text. Sending again takes a person's recorded decision that the first post
   did not happen, and JARVIS not finding it.
5. **The text of a post comes from the saved item.** No endpoint accepts it,
   and a tool call whose text differs from the saved text is refused.
6. **Publishing is approval-gated, by the exact parameters.** No path publishes
   without an approval bound to the text and the Page, and none may be added.
   It is also **switched off by default**: no publish tool is registered unless
   `MARKETING_PUBLISH_ENABLED=true`, so where it is off no approval for a
   publish can exist.
7. **The claim is a conditional write, taken only from the state the approval
   was made for.** Never read the publish state, check it in memory and then
   write — and never send on a claim that was not taken from an item with no
   publish outstanding. An approval's parameters say whether it is for a send
   or for a look at one named earlier attempt (`earlierAttempt`); the claim is
   issued for that state and no other, so a look can never become a send. Never
   add a claim that tries one state and falls back to the other.
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
    `marketing.publish`, `marketing.publish.resolve`, `marketing.research.fetch`,
    `marketing.report.generated`, `marketing.content.reported_published`, and
    the reservations `marketing.limit.*`. Never
    the text of a post, never a path or query string of a page that was read,
    never a credential, never a provider's own error text. (The executor's
    generic `tool.execute` row records each tool's parameters, as it does for
    every tool in JARVIS, after the audit system's redaction. For a publish
    those parameters are the approved text and Page — the same thing the
    approval row holds.)
13. **A date is a plan.** Nothing publishes because a date arrived. There is no
    scheduler here and adding one is a separate, reviewed change.
14. **Work that reaches outside JARVIS takes a slot first.** A page read, a
    report and a publish check each reserve their place — atomically, in
    PostgreSQL — before the provider is called. Never count, act, and write the
    counted row afterwards: requests that arrive together would all pass.
15. **No model settles an unconfirmed publish.** `marketing.publish.resolve`
    stays on no agent's allowlist and refuses a call that carries an agent or a
    conversation.
16. **Settling is held to the attempt, and changes nothing without its audit
    row.** Before the Page is looked at, the item must still hold the words the
    attempt sent, the attempt's Page must still be one the connection can
    read, and the attempt under the claim must be the one the settle checked;
    otherwise nothing is cleared. The two outcomes that change the item —
    cleared, and found-and-recorded — are written in one transaction with the
    audit row of the decision (`clearUnconfirmed`, `finalizePublished`). Never
    clear an attempt and write its audit row afterwards, and never swallow a
    failure to write it.
17. **What an agent is told about publishing follows the tools it was handed.**
    The marketing agent's prompt is computed from its definitions; the
    orchestrator answers a call to a tool the server named as switched off
    before the executor is asked. Never tell a model to call a tool it was not
    given, and never register a stand-in publish tool to make the call succeed.
