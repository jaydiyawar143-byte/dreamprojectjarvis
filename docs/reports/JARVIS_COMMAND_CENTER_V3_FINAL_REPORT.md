# JARVIS Command Center V3 — Final Report

**Verdict: JARVIS COMMAND CENTER V3 — PASS**, with two capabilities that are
complete in code but dormant for want of credentials this deployment does not
have, and one metric class the target hardware genuinely cannot report. All
three are named in [Known issues](#23-known-issues) rather than papered over.

Date: 2026-09-08 · Branch: `main` · Verified on localhost (:3000/:3001) and the
Docker stack (:3100/:3101)

**Revision 3 — real Google Maps.** The map widget is now a genuine
`google.maps.Map` with auto current location, place search and routes drawn on
the map. It is unconfigured here, and shows setup guidance rather than a
substitute. See the Revision 3 sections at the end.

**Revision 2 — composition and customisation.** The dashboard is now a grid with
the Orb as a cell and widgets around it, the Map is always present, World Clock
was added, crypto shows BTC/ETH/SOL, and the full Customise mode (drag, resize,
hide, save, reset, persist) is implemented. See the Revision 2 sections at the
end.

---

## 1. Architecture audit

Nothing was rebuilt. The audit found working systems to extend and, in two
cases, systems whose *shape* dictated the design:

| Found | Consequence for V3 |
|---|---|
| Socket.IO already authenticated, per-user rooms, **default-deny event allowlist** | Metrics stream reuses it. Two new events were added *to the allowlist*, which made an existing security test fail until the decision was recorded — exactly as that test intends. |
| Knowledge/RAG pipeline handles PDF, DOCX, TXT, MD | Attachments reuse it wholesale. Images are converted to text and enter the *same* pipeline, so they chunk, embed, retrieve and cite like any document. |
| `UserSetting` — per-user key/value, unique on `[userId, key]` | Dashboard preferences live there. No migration needed. |
| `ToolExecutor`, approval boundary, audit | Untouched. Nothing in V3 executes a tool. |
| Existing `fileToBase64` in the API client | Reused — I had written a duplicate and deleted it. |

Two measurements drove design more than any preference:

- **`systeminformation` profiling** (Windows, warm): `currentLoad` 0ms, `mem`
  511ms, `cpuTemperature` 663ms, **`graphics` 3058ms**, **`networkStats`
  3403ms**. A 1 Hz stream calling all of them would spend most of every second
  blocked in WMI. Hence two tiers.
- **Provider probes**, run before committing to any of them: Open-Meteo,
  CoinGecko, Nominatim and OSRM all answered from this machine, keyless and
  within terms. NIFTY had no such option.

---

## 2. UI changes

The dashboard remains the command centre from V2 — Orb, one input, one status
line. The BI panels stay on the pages that own them (`/approvals`,
`/opportunities`, `/knowledge`, `/meta-ads`), and a V2 test still asserts they do
not creep back onto the dashboard.

> **Superseded by revision 2.** This pass placed the widgets in a stack beneath
> the Orb, which turned the dashboard back into a scrolling page. Revision 2
> replaced that with a grid in which the Orb is a cell and the widgets sit around
> it — see §26.

---

## 3. Orb

Unchanged from V2 and still correct: four parallax layers (`core`, `shell`,
`halo`, a flattened `orbital` band) rotating at different rates about different
axes, ~12,000 particles at full budget, explicit WebGL disposal with
`forceContextLoss()`, a 2D canvas fallback implementing the same contract, and a
device-tier particle budget.

## 4. Voice and audio reactivity

Also unchanged, and re-verified this round through Chrome's fake capture device
with `AnalyserNode.getByteTimeDomainData` instrumented: **143 analyser reads,
peak amplitude 128** during a real listening turn, with the state walking
Ready → Listening → Thinking. Real audio, not a loop.

---

## 5. Clock

Digital and analog, real local time, real timezone (`Asia/Calcutta` here),
12/24-hour preference, persisted server-side.

**Hydration is handled deliberately.** The first paint renders no time at all,
because the server's "now" is a different instant from the client's and
rendering one guarantees a mismatch. A test asserts this via `renderToString`
rather than a mounted render — testing-library flushes effects, so the guarantee
is only observable where it actually applies.

Hand geometry is a pure function and tested: at 6:30 the hour hand sits at 195°,
having crept half way past the numeral rather than pointing at it.

## 6. Weather — real

**Open-Meteo**, called server-side. Keyless, permits this use, and — critically —
publishes the observation time for every value, which is what makes honest
freshness possible.

Verified live: **29.6 °C, 72 % humidity at Balaghat, `freshness: LIVE`, age 848 s,
source Open-Meteo.**

A figure the provider did not return is omitted entirely rather than shown as 0;
a test covers that. Geolocation is asked for once and a refusal is a normal
outcome with an actionable message, not an error.

## 7. Tasks and reminders — real, persisted

New `Task` table (`user_id`, `title`, `due_at`, `priority`, `completed_at`,
`reminded_at`), indexed on `(user_id, due_at)`. Bucketed OVERDUE / TODAY /
UPCOMING / SOMEDAY, computed from the due date so it stays correct as time
passes without anything having to run.

Ownership is enforced *in the same statement as the write* — `updateMany` /
`deleteMany` with `userId` in the WHERE clause, never findUnique-then-write — and
a missing task and someone else's task return the same 404, so the endpoint
cannot be used to probe for another user's ids.

## 8. System monitor — real, and honest about what it cannot see

Two tiers, split by the measured costs above: CPU/memory/uptime stream at 1 Hz;
network, disk, GPU and temperature refresh every 15 s and merge in.

Verified live on this machine:

```
CPU 52 %   RAM 79 % of 21.2 GB   Disk 45 % of 511 GB (C:)
Network Wi-Fi   GPU Intel(R) UHD Graphics   up 1d 6h
CPU temperature : unavailable — "No sensor is exposed by this system"
GPU utilisation : unavailable — "No sensor is exposed by this system"
```

**A bug I found and fixed in my own code:** the first CPU reading returned `0 %`.
Load is a *delta* between two tick samples, so the first has no answer — and `0`
reads as "idle", which is a different claim from "not measured yet". It now
returns `null` with a reason, and the module takes a baseline at load so the
first real request already has two samples.

The stream runs **one timer per process**, not per socket, and stops entirely
when the last subscriber leaves. It has a 30-minute idle cutoff for forgotten
tabs. It reads counters only — a test asserts the module contains no
`child_process`/`exec`/`spawn`, and the socket handlers take **no payload**, so
there is no argument to inject.

## 9. Crypto — real

**CoinGecko**, keyless. The oldest quote in the set governs freshness, so the
badge cannot overstate the slowest row.

This pass ranked by market cap, which returned **BTC, ETH, USDT** — factually the
top three, and a dollar stablecoin pinned at ~$1.00 is useless on a dashboard.
Revision 2 switched to a named watchlist (BTC/ETH/SOL) while keeping every price
and rank the provider's real value; see §30.

## 10. NIFTY 50 / BANKNIFTY — built, dormant, and never faked

The integration is complete: provider interface, vendor-payload normaliser
(tolerant of the common key spellings), caching, freshness, and a server-side
bearer key that never reaches the browser.

It is **not active**, because real-time Indian index data is licensed and the two
free routes — scraping NSE or calling an undocumented endpoint — were both ruled
out, correctly. With no provider configured it returns:

> Real-time NIFTY and BANKNIFTY are licensed data. No provider is configured;
> set `MARKET_INDICES_API_URL` and `MARKET_INDICES_API_KEY` to enable this widget.

A test asserts that in this state it **makes no network call at all** — proof it
cannot silently fall back to scraping.

## 11. Maps — real

**Nominatim** for geocoding and place search, **OSRM** for routing. Both public,
keyless, legitimate APIs; no scraping of Google Maps.

Verified live, using your own example:

```
Balaghat → Gondia : 65.6 km, ≈56 min by road
from  Balaghat, Madhya Pradesh, India
to    Gondia City, Gondiya, Maharashtra
© OpenStreetMap contributors (ODbL) · routing by OSRM
```

Nominatim's usage policy is implemented as **code, not a comment**: an
identifying User-Agent, a serialised ≤1 req/sec limiter, and a 24-hour cache. The
ODbL attribution is rendered because the licence requires it.

> **Superseded by revision 3.** This pass drew the route as inline SVG rather
> than embedding a map. That was the "placeholder route visualization" the brief
> ruled out; revision 3 replaced it with a real `google.maps.Map`. The
> OpenStreetMap/OSRM providers described here remain as the labelled fallback
> for geocoding and routing when no Google server key is configured — see §35.

## 12. Files, images and PDFs

Attachments live in the composer and reuse the existing pipeline: documents to
`/knowledge/documents` (PDF, DOCX, TXT, MD — already supported), images to a new
`/knowledge/images`.

## 13. Multimodal

An image cannot be chunked or embedded, so a vision model converts it to text and
**that text is ingested through the ordinary knowledge pipeline**. From there it
is an ordinary document: chunked, embedded, retrievable, citable. The assistant
needs no special case to answer questions about it, and the existing RAG stack is
not duplicated.

The vision prompt prioritises verbatim transcription over description, because
the common real case is a photo of a document where the words *are* the content —
and it is written to be embedded and retrieved, not read.

Image bytes are never persisted; the description is. The upload chip
distinguishes "stored" from "searchable", since without an embedding key text is
kept but cannot be retrieved.

## 14. Realtime architecture

The existing authenticated Socket.IO server, reused. `system:subscribe` /
`system:unsubscribe` were added to the **default-deny allowlist**, which made
`sprint9-socket-security.test.ts` fail until the decision was recorded — the
tripwire working as designed. Both are strictly READ_ONLY: no parameters, no
execution, per-user room emission, and they grant nothing the operator does not
already have over HTTP.

Everything else polls at a sane interval (markets 60 s, weather 15 min cache).
No high-frequency polling.

## 15. Security

| Property | Status |
|---|---|
| Secrets server-side | All third-party calls run on the API. Verified: the built client bundle contains none of `META_ACCESS_TOKEN`, `JARVIS_ENCRYPTION_KEY`, `JWT_SECRET`, `OPENAI_API_KEY`. |
| Tenant isolation | Tasks and preferences filter on the token's `userId`. Ownership is part of the write statement, not a prior check. |
| No OS command execution | Asserted by test on both the monitor and the stream. |
| Approval boundary | Untouched. Nothing in V3 executes a tool. |
| Voice cannot approve | Unchanged; V2 tests still enforce it. |
| Input validation | Every route is zod-validated; preferences use `.strict()` so a client cannot store arbitrary JSON in a shared table. |
| Provider errors | Upstream bodies are never forwarded — a vendor error can echo the API key. |

## 16. Responsive

Measured, not assumed:

```
desktop 1440 : doc 1440  body 1440  inner 1440
tablet   834 : doc  834  body  834  inner  834
mobile   390 : doc  390  body  390  inner  390
```

No page-level horizontal scrolling at any size. One element does extend past the
viewport — the Orb's atmosphere glow — and it is `pointer-events: none` inside an
`overflow: hidden` wrapper, so it affects neither layout nor interaction. That
wrapper exists because `overflow-x: hidden` cannot coexist with visible
`overflow-y`: CSS promotes the other axis to `auto`, which would have turned the
command centre into a nested scroll container with its own scrollbar.

## 17. Accessibility

Every widget is a labelled `<section>`; every control is a real `<button>` with an
accessible name; every input has a label (visually hidden where the design has no
room). The sidebar expands on hover **and on `focus-within`**, so keyboard users
are not stranded. The task delete control appears on hover *or focus*. Status
regions use `aria-live="polite"`. Reduced motion is respected by the Orb.

## 18–20. Tests, regression, typecheck

| Gate | Result |
|---|---|
| Web tests | **240 passed / 240** (12 files) |
| API tests | **664 passed / 664** (24 files) |
| `npx turbo typecheck` | **31 / 31** |
| `npx turbo build` | **17 / 17** |

New: `apps/api/test/v3-providers.test.ts` (15) and
`apps/web/test/v3-widgets.test.tsx` (31).

**Two tests changed, neither weakened.** `sprint9-socket-security.test.ts` had an
exact allowlist assertion that my two events broke; it now lists them *and* gained
a new test asserting the handlers take no payload and the stream contains no shell
call. The V2 dashboard nav test gained the Browser entry. No test was deleted or
loosened to make anything pass.

**Two real bugs were found by tests and fixed in the implementation:** the cache
treated an entry as fresh at its exact expiry instant (`>` should have been `>=`),
and the CPU-load zero described above.

## 21. Production build

`17/17`. `three` remains code-split to `/dashboard`.

## 22. Migration status

One additive migration: `20260908120000_v3_command_center_tasks` (creates `Task`,
two indexes, one FK). Applied to both databases.

**It had to be hand-written, and that is worth flagging.** `prisma migrate dev`
now fails outright, because it rebuilds a shadow database by replaying every
migration — and the pre-existing `20260824010000_phase117b_outcome_worker` cannot
replay (it adds an enum value and uses it in the same transaction; Postgres
`55P04`). The defect I reported in V2 as "blocks fresh databases" has escalated
to **blocking all future schema work through the normal tooling**. I generated
the SQL with `migrate diff` against the live datasource and applied it with
`migrate deploy`, which bypasses the shadow database. That unblocks V3 without
destabilising the applied history, but it does not fix the underlying defect.

## 23. Known issues

1. **`prisma migrate dev` is broken** by the pre-existing enum migration (above).
   Every future schema change needs the same hand-written workaround until it is
   fixed. The fix — splitting that migration so the enum values are committed
   before use — changes its checksum and therefore needs a coordinated
   `migrate resolve` on every existing database, so it wants doing deliberately.

2. **NIFTY / BANKNIFTY are dormant.** Complete in code, inert without a licensed
   provider key. This is a data-licensing constraint, not an implementation gap.

3. **CPU temperature and GPU metrics are unavailable on this machine.** Intel UHD
   integrated graphics on Windows exposes no sensor without a kernel driver. The
   tiles say so. On hardware that does expose them, the same tiles fill in with
   no code change. You chose "show Unavailable honestly" over building a
   privileged local helper service; that decision stands and section 12 of the
   brief (the separate monitor service) was therefore not built.

4. **Google sign-in remains untested against Google** (V2 issue, unchanged): no
   OAuth client credentials here.

5. **Stored Meta credentials still apply at the next restart** (V2 issue,
   unchanged): the tool registry binds `process.env` once at container
   construction.

6. **Docker reports the container, not the host.** The system widget says so on
   screen when running there.

7. Benign console entries: `/favicon.ico` 404, `/auth/google/status` 404 when
   Google is unprovisioned, and a 401 from the session probe on the login page.

## 24. External provider dependencies

| Provider | Used for | Key | Terms |
|---|---|---|---|
| Open-Meteo | Weather | none | Free for this use; called server-side |
| CoinGecko | Crypto top-3 | none | Free tier; cached 60 s to stay inside it |
| Nominatim (OSM) | Geocoding, place search | none | UA + ≤1 req/s + caching implemented; **ODbL attribution rendered** |
| OSRM | Routing | none | Public demo server; cached 1 h |
| OpenAI | Vision (images) | existing `OPENAI_API_KEY` | Server-side only |
| *(unset)* | NIFTY / BANKNIFTY | `MARKET_INDICES_API_*` | Requires a licensed vendor |

New runtime dependency: `systeminformation` (API only).

## 25. Files changed

**New — API:** `services/providers/{freshness,weather-provider,market-provider,geo-provider,system-monitor}.ts` ·
`routes/command-center.ts` · `socket/system-stream.ts` · `test/v3-providers.test.ts`

**New — packages:** `db/repositories/{task-repository,preference-repository}.ts` ·
`ai-openai/openai-vision-provider.ts` ·
`db/prisma/migrations/20260908120000_v3_command_center_tasks/`

**New — web:** `components/widgets/{widget-shell,clock-widget,weather-widget,markets-widget,tasks-widget,system-widget,map-widget,registry}.tsx` ·
`components/dashboard/attach-button.tsx` · `lib/use-system-stream.ts` ·
`test/v3-widgets.test.tsx`

**Modified:** `api/src/index.ts` (mounts) · `api/src/routes/knowledge.ts` (image
ingestion) · `api/src/socket/socket-auth.ts` (allowlist) ·
`db/prisma/schema.prisma` (Task) · `web/src/lib/api.ts` (V3 client) ·
`web/src/components/dashboard/command-center.tsx` (widget grid, attachments) ·
`api/test/sprint9-socket-security.test.ts`

---

## Acceptance criteria

| | |
|---|---|
| 3D Orb upgraded, micro-particles, audio-reactive, voice states | ✅ (V2, re-verified) |
| Sidebar collapsible, scrollbars removed, no horizontal scroll | ✅ measured at three breakpoints |
| Dashboard clutter removed | ✅ asserted by test |
| Clock, analog/digital | ✅ |
| Weather real | ✅ 29.6 °C Balaghat, LIVE |
| Tasks/reminders real and persisted | ✅ new table |
| System monitor + live graphs real | ✅ CPU/RAM/disk/network |
| Crypto real | ✅ BTC/ETH/USDT by real rank |
| NIFTY / BANKNIFTY real **or clearly labelled** | ✅ labelled unavailable, never faked |
| Maps, distance, routes | ✅ Balaghat→Gondia 65.6 km |
| Image + PDF attachment, Q&A over files | ✅ via existing RAG |
| RAG / Voice / Agents / Integrations / Browser intact | ✅ 664 API tests |
| Approval boundary, voice cannot approve | ✅ unchanged |
| No secrets exposed, tenant isolation | ✅ bundle scanned |
| Responsive, accessibility, no console errors | ✅ |
| Tests / typecheck / build / visual QA | ✅ 240 + 664, 31/31, 17/17 |

**JARVIS COMMAND CENTER V3 — PASS**

---

# Revision 2 — Composition and customisation

You were right about the diagnosis: the widgets were stacked *below* the fold
rather than arranged around the Orb, the Map was hidden by default, and nothing
was customisable. Both were fixed at the structural level rather than by
restyling.

## 26. The composition

The dashboard is now a CSS grid — four columns on a large screen, two on a
tablet, one on a phone — and **the Orb is a cell in it**, not a banner above a
list. That single change is what puts the widgets around it.

```
desktop  page height 938px for a 900px viewport   (≈ one screen, not a scroll)
         doc 1440  body 1440  inner 1440          (no horizontal overflow)
tablet   doc  834  body  834  inner  834
mobile   doc  390  body  390  inner  390
```

The Orb cell owns the prompt, the status line and a **compact** command bar
(attach · input · mic · send), so chat cannot grow to dominate the screen; the
full conversation stays behind the sidebar's Assistant link.

**Why an ordered list with sizes, rather than (x, y) coordinates.** A free-form
coordinate grid needs collision detection, compaction and re-flow, and each of
those is a way for widgets to overlap or leave holes. The layout is instead an
ORDER plus a SIZE per widget, rendered with dense auto-placement — the browser
packs it. The honest trade-off: a user cannot leave a deliberate gap. What they
get is a layout that cannot break, that reflows correctly at every breakpoint
without storing a second layout per screen size, and where "move left" means
something on a phone as well as a monitor.

## 27. Customisation

Off by default — one quiet "Customise" button, and when it is off the frame
renders its child and **nothing else**: no handles, no outlines, no extra DOM.
That matters beyond aesthetics; an invisible drag handle over the map would
break panning.

On, each widget gains:

| | |
|---|---|
| **Drag** | HTML5 drag-and-drop from a dedicated grip, so buttons, inputs and the map inside a widget keep working |
| **Resize** | ± per axis, clamped to that widget's own limits |
| **Move** | ← → buttons — the keyboard path, not an afterthought |
| **Hide** | per widget, where allowed |
| **Manage widgets** | checklist panel, with a hidden count |
| **Reset** | back to the JARVIS default |
| **Save** | explicit, with an unsaved indicator |

**Save is deliberately explicit.** Edits apply instantly so you can judge them,
but nothing reaches the server until Save. That gives Reset an honest meaning —
discard what I have been doing — and means experimenting and closing the tab has
not silently rewritten your dashboard.

**Protected minimums are enforced, not advisory.** The Orb cannot go below 2×2
and cannot be hidden at all: a dashboard where the Orb can be switched off is a
different product. Map and System Monitor have their own floors, because either
one at 1×1 is unreadable. A control at its limit is *disabled* rather than
silently doing nothing, so the limit is visible.

Verified end-to-end in a real browser:

```
resize system   1×2 → 2×2
move markets    reordered ahead of tasks
hide worldclock removed from the grid
manage panel    Orb checkbox disabled ("Always"), worldclock unchecked
save            unsaved indicator cleared
RELOAD          worldclock still hidden, system still 2×2   ← persisted
reset           worldclock back, system back to 1×2
```

Persistence is server-side through the existing preferences endpoint, so a
layout follows you to another device. `normalizeLayout` repairs anything a
previous build wrote: unknown ids dropped, **new widgets appended** (or shipping
one would make it invisible to every existing user), sizes re-clamped, and a
crafted payload cannot hide the Orb.

## 28. Map — always present

Moved into the default layout, so it is on the dashboard from first load. It is
fully configured here (OpenStreetMap + OSRM, keyless), and its empty state now
says what it can answer rather than sitting blank.

Verified with your own example, drawn as real route geometry:

```
Balaghat → Gondia City · 65.6 km · ≈56 min by road
© OpenStreetMap contributors (ODbL) · routing by OSRM
```

## 29. World clock

New widget: New York, London, Tokyo, converted through the IANA zone database so
daylight saving is handled by the platform rather than an offset table that goes
wrong twice a year. Verified live at 08:14 / 13:14 / 21:14 for one instant, and
tested across the date line.

## 30. Crypto — BTC, ETH, SOL

Changed from "top 3 by market cap" to a named watchlist, because the two answer
different questions: market-cap rank puts **USDT** — a dollar stablecoin pinned
at ~$1.00 — at number three, which is factually correct and useless on a
dashboard. Prices and ranks remain entirely the provider's real values; SOL is
shown with its true rank (#7), not relabelled as third.

## 31. Revision 2 gates

| Gate | Result |
|---|---|
| Web tests | **273 passed / 273** (13 files) — stable across three consecutive runs |
| API tests | **664 passed / 664** (24 files) |
| `npx turbo typecheck` | **31 / 31** |
| `npx turbo build` | **17 / 17** |
| Console errors | none beyond the known favicon/Google-status 404s and the login-page session probe |
| Customisation | drag, resize, move, hide, manage, save, persist, reset — all verified in a browser |
| Responsive | no horizontal overflow at 1440 / 834 / 390; Customise available on all three |

New tests: `apps/web/test/v3-layout.test.tsx` (33) covering resize clamping, the
Orb floor, move-at-the-ends, drag payload, stored-layout repair, the disabled
Orb toggle, and world-clock timezone conversion.

**One test harness updated, not weakened.** `dashboard.test.tsx` began failing
because the dashboard now renders the live widget grid, and `TasksWidget` threw
on an unstubbed `listTasks` — taking the whole tree, including the approval
panel, down with it. The fix was to stub the providers the grid touches. Two
`auth-session` failures in the same run were collateral from that crash and
disappeared with it.

## 32. Revision 2 files

**New:** `components/widgets/{layout.ts,widget-frame.tsx,customize-bar.tsx,world-clock-widget.tsx}` ·
`lib/use-dashboard-layout.ts` · `test/v3-layout.test.tsx`

**Modified:** `components/dashboard/command-center.tsx` (grid composition, Orb as
a cell, compact command bar) · `components/widgets/{widget-shell,weather-widget,map-widget}.tsx`
(header fit, top-aligned content, map empty state) ·
`api/src/routes/command-center.ts` (layout in the preferences schema) ·
`api/src/services/providers/market-provider.ts` (watchlist) · `lib/api.ts` ·
`test/dashboard.test.tsx`

## 33. Verdict, revision 2

**JARVIS COMMAND CENTER V3 — PASS**

The three qualifications from revision 1 stand unchanged: NIFTY/BANKNIFTY is
complete but dormant without a licensed provider key; CPU and GPU temperature
are not exposed by this hardware and say so; and `prisma migrate dev` remains
blocked by the pre-existing enum migration.

---

# Revision 3 — Real Google Maps

The map is now a genuine `google.maps.Map` — pan, zoom, markers, a drawn route
polyline — replacing the hand-projected SVG from revision 2. That SVG was
exactly the "placeholder route visualization" you ruled out, and it is gone.

## 34. Two keys, deliberately separate

| | Reaches the browser | Restrict by | Used for |
|---|---|---|---|
| `GOOGLE_MAPS_BROWSER_KEY` | yes, unavoidably | HTTP referrer + Maps JavaScript API only | rendering the map |
| `GOOGLE_MAPS_SERVER_KEY` | **never** | IP + Geocoding/Places/Routes only | geocoding, place search, routing |

Reusing one unrestricted key for both is the common mistake, and it converts a
referrer-restricted browser key into a billable server credential anyone can
lift out of the page. They are separate variables so that cannot happen by
accident.

**The browser key is served from an authenticated endpoint**
(`GET /command-center/maps/config`) rather than inlined as `NEXT_PUBLIC_*`. It
still reaches the browser — there is no way to render a Google map otherwise —
but it is not sitting in a static JS file that anyone can fetch without logging
in. The referrer restriction remains the actual control; this is defence in
depth. Verified: unauthenticated request to that endpoint returns **401**, and
the server key never appears in any client payload.

## 35. What happens with no key — which is this deployment

Verified in the browser:

```
map widget present        : yes
"GOOGLE MAPS · CONFIGURATION REQUIRED"
                          : shown, naming both variables
Settings → Connections    : linked
map element rendered      : NO   ← no substitute map is drawn
console errors            : none
```

The widget stays on the dashboard, as you asked. It does **not** fall back to a
drawn map, because there is no honest substitute for an interactive Google map
inside a widget labelled Google Maps.

Geocoding and routing are a different matter and **do** fall back to
OpenStreetMap/OSRM, so JARVIS can still answer "how far is Balaghat from
Gondia" today. Every response names the provider that actually answered:

```
route Balaghat → Gondia   : 65.6 km, 56 min   source: OSRM
```

The panel says so too, rather than implying location is broken.

## 36. With a key — verified end to end with a dummy credential

Booted a throwaway API with test keys:

```
browserKey served         : AIza-test-browser-key
mapsAvailable             : true
capabilities.maps         : true
unauthenticated /config   : 401
Google geocode, bad key   : UNAVAILABLE
                            source "Google Maps Platform"
                            reason names the APIs to enable
                            key echoed in response? NO
```

That last line is the security-critical one. Google's `error_message` on a
misconfigured key contains **the key and the referrer**, and forwarding it would
put the key on screen and in logs. The provider maps the `status` to our own
wording and never forwards the message — pinned by a test that asserts a fake
key does not appear anywhere in the serialised response.

## 37. The map itself

- **Auto current location** on open, through the browser's own permission
  prompt. Five states are handled distinctly: locating, available, denied,
  unavailable, unsupported — each with the right action (`Enable location` /
  `Try again` / nothing).
- **Current-location marker** is a cyan dot, deliberately different from the
  pin used for results, plus a `watchPosition` follow with a coarse threshold
  (60s max age, low accuracy) so it does not drain battery. Cleared on unmount.
- **Reverse geocoding** labels it (`📍 Nagpur, Maharashtra, India`) when a
  server key exists; without one the marker is still correct, just unlabelled.
- **My Location** control re-centres.
- **Place search** via Google Places text search, biased to the current location
  when known.
- **Routes** drawn as a real polyline with A/B markers, `fitBounds` to the
  route, distance and duration beneath — never *instead of* the map.
- **Travel modes** drive / walk / cycle / transit. With the OpenStreetMap
  fallback only driving is available, and the other three are **disabled with a
  reason** rather than silently substituted.
- **Current location → destination**: leaving "From" blank uses the real fix.
  With no permission the button stays disabled — the origin is never guessed.

**Encoded polyline decoding is implemented directly** (~20 lines, the standard
algorithm) rather than adding a dependency, and is tested against the worked
example from Google's own documentation.

## 38. Lifecycle and resizing

The SDK `<script>` is a **page-level singleton**: Google's loader refuses to
initialise twice, so the load promise is module-scoped and unmounting a map does
*not* remove the script. Everything the component itself creates is destroyed on
unmount — markers, polyline, map listeners, the geolocation watch, the
ResizeObserver.

A `ResizeObserver` re-lays-out the map when its grid cell changes, so resizing
it in Customise mode does not leave grey tiles. Default size is **2×2**, min
1×1, max 3×3, and it participates fully in drag / resize / hide / restore.

## 39. Revision 3 gates

| Gate | Result |
|---|---|
| Web tests | **276 passed / 276** (13 files) |
| API tests | **677 passed / 677** (25 files) |
| `npx turbo typecheck` | **31 / 31** |
| `npx turbo build` | **17 / 17** |
| Secret scan of the production bundle | no key values present; map loader and guidance text confirmed shipped |
| Console errors | none |
| Horizontal overflow | none |

New: `apps/api/test/v3-google-maps.test.ts` (13) — key separation, travel-mode
mapping, polyline decoding against Google's documented example, and four error
paths including the "never echo the key" assertion.

**A measurement mistake worth recording:** my first bundle scan reported the map
code missing. It was not — I had started `next dev` after building, and the dev
server overwrites `.next`. Re-scanning a clean production build (57 chunks)
found the loader and the guidance text present and no secret values.

## 40. Revision 3 files

**New:** `apps/api/src/services/providers/google-maps-provider.ts` ·
`apps/web/src/lib/use-google-maps.ts` · `apps/api/test/v3-google-maps.test.ts`

**Rewritten:** `apps/web/src/components/widgets/map-widget.tsx`

**Modified:** `packages/config/src/index.ts` (two-key gate) ·
`apps/api/src/services/providers/geo-provider.ts` (Google preferred, OSM
labelled fallback) · `apps/api/src/routes/command-center.ts`
(`/maps/config`, `/geo/reverse`, travel mode, `capabilities.maps`) ·
`apps/web/src/lib/api.ts` · `apps/web/src/components/widgets/layout.ts`
(map default 2×2) · `.env.example` · `apps/web/package.json`
(`@types/google.maps`) · `apps/web/test/v3-widgets.test.tsx`

## 41. Verdict, revision 3

**JARVIS COMMAND CENTER V3 — PASS**

One item is complete in code but cannot be exercised here: the live Google map,
because this deployment has no Google Maps credentials. Everything around it is
verified — key handling, the unconfigured state, the error paths, and the
OpenStreetMap fallback that keeps distance and place questions working
meanwhile. Add the two keys and the map renders with no code change.

The earlier qualifications are unchanged: NIFTY/BANKNIFTY needs a licensed
provider; CPU and GPU temperature are not exposed by this hardware; and
`prisma migrate dev` remains blocked by the pre-existing enum migration.
