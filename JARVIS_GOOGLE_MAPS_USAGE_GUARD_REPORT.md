# JARVIS — Google Maps: env wiring, usage guard, admin visibility

**Date:** 2026-09-09
**Branch:** `feat/command-center-v3`
**Scope:** §1 env config · §5 monthly usage/cost guard · §6 admin visibility · §7 security verification · §8 tests · §9 validation

This continues the Google Maps integration reported in `JARVIS_GOOGLE_MAPS_INTEGRATION_FINAL_REPORT.md`. §2–§4 (real map, location, places, routing, Orchestrator tool wiring) were delivered there and are unchanged except where the usage guard now sits in front of them.

---

## 0. The key is not in `.env` — read this first

The brief states the Google Maps API key has already been added to `.env`. **It has not.** I checked every environment file in the repo and read variable *names* only:

| File | Variables |
|---|---|
| `.env` | `DATABASE_URL`, `JARVIS_ENCRYPTION_KEY`, `JARVIS_ENCRYPTION_KEY_VERSION`, `JWT_SECRET`, `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_GRAPH_API_VERSION`, `OPENAI_API_KEY`, `OPENAI_DEFAULT_MODEL`, `OPENAI_TIMEOUT_MS`, `VOICE_ENABLED` |
| `apps/web/.env.local` | `NEXT_PUBLIC_API_URL` |
| `packages/db/.env` | `DATABASE_URL` |
| `.env.example` | template only, no real values |

No variable matching `MAP`, `GEO`, `PLACES` or `GMAP` exists anywhere, and `process.env` confirms neither key is set at runtime.

**A likely cause:** `.env.example` says *"Copy this file to `.env.local`"*, but the API actually loads **`.env`**. A key placed in a root `.env.local` would be silently ignored — and no root `.env.local` exists either, so that is not what happened here, but the instruction is misleading and worth fixing.

As instructed, I have not asked for the key. Everything below is built and verified; the two variables just need values in `.env`, then a restart. Nothing else is required.

---

## 1. Environment configuration

### Variable names used (values never read, printed, or logged)

| Variable | Read by | Purpose |
|---|---|---|
| `GOOGLE_MAPS_BROWSER_KEY` | API only, served to the browser via an authenticated endpoint | Loads the Maps JavaScript API |
| `GOOGLE_MAPS_SERVER_KEY` | API only, never leaves the server | Places (New), Geocoding, Routes |
| `GOOGLE_MAPS_MONTHLY_LIMIT` | API only | JARVIS-side monthly request ceiling. Default **70000** |

### Standardisation

The names were already consistent (`packages/config`), so nothing needed renaming. `GOOGLE_MAPS_MONTHLY_LIMIT` is new and documented in `.env.example` alongside them.

`resolveMonthlyLimit()` treats a missing, blank, unparseable or negative value as **the default, never as unlimited** — a typo in an environment variable must not be the thing that removes the cost ceiling. `0` is honoured as a real value meaning *block everything*, which is a legitimate way to switch Google off without removing the keys.

### Google OAuth / Gmail is untouched

Three separate Google surfaces exist and remain separate. No OAuth file was modified in this pass:

| Surface | Credential | Untouched |
|---|---|---|
| Google Ads | OAuth 2.0, per-user, encrypted in Postgres | ✅ |
| Google Sign-In | OAuth 2.0, identity | ✅ |
| Google Maps Platform | Two API keys, server env | the subject of this work |

---

## 2. Usage / cost guard (§5)

### Storage — `MapsUsage` table

One row per **(period, user, service)**.

```
period    "2026-09"  — UTC calendar month
user_id              — per-user attribution
service              — places | autocomplete | place_details | geocoding | routes
count                — atomic counter
```

**The monthly reset is implicit.** A new month writes to new rows, so there is no scheduled reset job — and therefore no reset job that can silently fail to run and carry a full counter into a new month. That is the failure mode that would quietly disable the guard, so it was designed out rather than handled.

**UTC, not local time**, so two API instances in different zones cannot disagree about which month a request belongs to.

### Why raw SQL for the counter

`packages/db/src/repositories/maps-usage-repository.ts` uses:

```sql
INSERT ... ON CONFLICT (period, user_id, service)
DO UPDATE SET count = "MapsUsage".count + $n
```

Prisma's `upsert` is a read-then-write: two concurrent requests both see `count = N` and both write `N + 1`, losing an increment. That undercount is worst under exactly the runaway-loop conditions this guard exists to catch. The `ON CONFLICT` form is one atomic statement and cannot lose a write. All queries use parameterised `$queryRaw` — no string interpolation, so a service name can never become SQL.

### Enforcement point

The gate sits inside `google-maps-provider.ts`, **after the cache check and immediately before `fetch`**. That placement is what makes the counter accurate:

- A **cache hit** costs Google nothing and is not counted.
- A **blocked** call does not increment the counter that blocked it.
- A call that times out or 500s **is** counted, because Google bills for sending it.

All six Google entry points are gated: `googleGeocode`, `googleReverseGeocode`, `googlePlaceSearch`, `googlePlaceAutocomplete`, `googlePlaceDetails`, `googleRoute`.

The **OpenStreetMap fallback is not metered** — it costs nothing. The limit is a *Google* limit.

### Thresholds

| Usage | Level | Behaviour |
|---|---|---|
| < 70% | `OK` | — |
| ≥ 70% | `WARNING` | Amber in admin view |
| ≥ 85% | `WARNING` | Amber |
| ≥ 90% | `STRONG_WARNING` | "Review usage before it reaches the limit" |
| ≥ 95% | `CRITICAL` | "Requests will be blocked at 100%" |
| ≥ 100% | `BLOCKED` | **Hard block** |

At 100% the provider returns exactly:

> **Google Maps monthly usage limit reached.** *N* of *L* requests used this month.

**It does not silently fall back to OpenStreetMap.** Substituting a different provider without saying so would leave the user believing they were still getting Google data — that is the "silent bypass" the brief forbids. An operator who would rather degrade than stop can raise the limit; that is a deliberate, visible choice.

### Cache: over-counts, never under

The global total is read from Postgres at most once every 30 s, and every increment in between is added on top locally. The figure the guard compares against is therefore **never lower** than what the database knows. A guard that drifts low is a guard that does not guard.

### Database failure: fails open, loudly

If the counter cannot be read, we have not *established* that the limit is reached — and blocking every map request because a counter table is unreachable is the worse failure. So it fails open, but:

- logs `maps_usage_read_failed` **every time**, with an explicit `consequence: "usage guard cannot verify the limit; requests are ALLOWED"` field
- **keeps an already-established block in force** across a transient blip, so a database hiccup cannot lift a ceiling

That difference — loud and actionable versus silent — is what separates failing open from bypassing the limit. It is asserted by test.

### What the guard cannot see

**Maps JavaScript API tile loads.** They happen in the user's browser, are billed by Google, and never reach this process. The admin payload states this in a `note` field rather than implying the number is the whole bill. **A Google Cloud budget alert and a per-API quota cap are still required.**

---

## 3. Admin / Settings (§6)

`GET /api/v1/command-center/maps/usage` → rendered by `MapsUsagePanel` inside **Settings → Connections → Google Maps**.

Shows: configured/not-configured status (three states — see below), monthly usage, limit, percentage, warning level, per-service breakdown, your own usage, last successful request, and the "this is not your bill" note.

**Three configuration states**, because the two keys do different jobs:

| State | Meaning |
|---|---|
| `CONFIGURATION_REQUIRED` | No browser key — the map cannot render |
| `CONFIGURED` | Map works; places and routing fall back to OpenStreetMap |
| `CONNECTED` | Both keys — everything served by Google |

**Access control:** every authenticated user sees the global figures (they need to know why their map stopped) and their own consumption. The **per-user leaderboard is `owner`/`admin` only**, and is omitted from the payload entirely for everyone else — not hidden client-side over data that was sent anyway.

**The panel never shows a zero it does not know.** An unreadable counter renders as its own state with a Retry button, because "0 requests" and "we could not read the counter" look identical on a progress bar and mean opposite things.

---

## 4. Files changed

### New

| File | Purpose |
|---|---|
| `packages/db/src/repositories/maps-usage-repository.ts` | Atomic counter, aggregates |
| `packages/db/prisma/migrations/20260909120000_v3_maps_usage_guard/` | `MapsUsage` table |
| `apps/api/src/services/maps-usage-guard.ts` | Thresholds, cache, block, fail-open logging |
| `apps/api/test/v3-maps-usage-guard.test.ts` | 31 tests |
| `apps/web/src/components/settings/maps-usage-panel.tsx` | Admin view |

### Modified

| File | Change |
|---|---|
| `packages/db/prisma/schema.prisma` | `MapsUsage` model |
| `packages/db/src/index.ts` | Repository export |
| `apps/api/src/services/providers/google-maps-provider.ts` | `meter()` gate on all six Google calls; `UsageContext` |
| `apps/api/src/services/providers/geo-provider.ts` | Threads `usage` through every dispatcher |
| `apps/api/src/services/maps-adapter.ts` | Attribution from tool context |
| `apps/api/src/services/container.ts` | Installs the guard before registering maps tools |
| `apps/api/src/routes/command-center.ts` | `GET /maps/usage`; attributes every geo route to the caller |
| `apps/api/src/index.ts` | Wires the usage repository |
| `packages/tools/src/tools/maps-tools.ts` | `userId` attribution on `MapsPort` |
| `apps/web/src/lib/api.ts` | `getMapsUsage` |
| `apps/web/src/app/settings/connections/page.tsx` | Mounts the usage panel |
| `.env.example` | Documents `GOOGLE_MAPS_MONTHLY_LIMIT` |

---

## 5. Architecture — nothing bypassed

Natural-language map requests follow the existing path, unchanged:

```
Orchestrator → agent-router (deterministic) → LocationAgent / general assistant
             → ToolExecutor → maps.* tools (READ_ONLY, ["read"])
             → MapsPort → geo-provider → usage guard → Google
```

No parallel AI architecture. No new orchestrator. The guard was inserted *below* the tools, so every path — chat, widget, or any future caller — passes through it.

---

## 6. Security verification (§7)

| Check | Result |
|---|---|
| `.env` gitignored | ✅ `.gitignore:10`; `git ls-files .env` → not tracked |
| `apps/web/.env.local` gitignored | ✅ `.gitignore:11` |
| No key in frontend bundle | ✅ `AIza[…]{30,}` pattern: **zero matches** in `.next/` and `apps/api/dist/` |
| Variable *names* in bundle | Only inside the setup-guidance help text (`"Add GOOGLE_MAPS_BROWSER_KEY …"`) — a name, not a value |
| Web app cannot reach the server key | ✅ `@jarvis/config` is **not imported by `apps/web` at all**; the only `process.env` in web source is `NEXT_PUBLIC_API_URL` |
| No `NEXT_PUBLIC_GOOGLE*` anywhere | ✅ zero matches |
| Key in API responses | Only the browser key, from its own authenticated endpoint. The server key is never returned — `/maps/config` returns a boolean |
| Key in logs | Google's `error_message` is never forwarded (it echoes the key and referrer); guard logs carry counts only — asserted by test |
| Key in URLs | Places/Routes send it as an `X-Goog-Api-Key` **header**; URLs reach proxy logs and browser history |
| Rate limiting | 300 ms autocomplete debounce, stale-request abort, result clamps, field masks, TTL caches, Nominatim serialised to 1 req/s |
| Tenant isolation | Counter keyed on authenticated `userId`; location store likewise; a model cannot set either — asserted by test |
| Permission checks | Every route `requireAuth`; leaderboard `owner`/`admin` only; tools `READ_ONLY` / `["read"]` |
| Audit logging | Blocks log `maps_usage_limit_blocked`; read/write failures log their own events with consequences |

---

## 7. Tests added (§8) — 39 new, 144 total for Maps

| File | Tests | Covers |
|---|---|---|
| `apps/api/test/v3-maps-usage-guard.test.ts` | **31** | Env config incl. typo fallback and `0`; all five thresholds at exact boundaries (69,999 passes / 70,000 blocks); hard block; blocked requests not counted; per-user counting; cache over-counts; block reachable from local deltas alone; fail-open + loud logging; block held across a blip; UTC month rollover; new month starts at zero with the old month at limit; no secret in status or logs |
| `apps/api/test/v3-maps-places-location.test.ts` | +**8** (36 total) | Metering at the provider boundary: real call counted with right service; **cache hit not counted**; **no network call once blocked**; blocked call not charged; all four services blocked; `system` attribution; inert with no guard; limit message carries no key |

Existing Maps tests from the previous pass: `maps-tools.test.ts` (32), `location-routing.test.ts` (18), `map-live.test.tsx` (27), `v3-google-maps.test.ts` (13).

**No real Google API is called in any test.** All Google traffic is mocked via `fetch` spies, per the brief.

---

## 8. Validation (§9)

### Typecheck — all clean

```
packages/core  ✓   packages/config ✓   packages/db ✓
packages/tools ✓   packages/agents ✓
apps/api  tsc --noEmit ✓        apps/web  tsc --noEmit ✓
```

### Builds — both succeed

```
apps/api   npx tsc         ✓ exit 0
apps/web   npx next build  ✓ 22 routes
```

### Lint

**Not configured in this repo.** `next lint` opens an interactive ESLint setup prompt; there is no `.eslintrc`. I did not configure one — that is a separate decision. No lint result to report.

### Unit tests

| Suite | Result |
|---|---|
| `apps/api` | **744 passed** |
| `apps/web` | **303 passed** |
| `packages/tools` | **720 passed** |
| `packages/agents` | **491 passed** |
| `packages/core` | **416 passed** |
| **Total** | **2,674 passed** |

### Integration tests — pre-existing failures, not from this work

`packages/db` has **8 failures** in `phase103` / `phase115` / `phase117` / `phase118` outcome and recommendation suites. They fail with `DuplicateOutcomeError: Outcome already exists for recommendation …` — **leftover rows in the shared dev database from previous runs**. They fail serially as well as in parallel, they touch none of the tables or code in this work, and `git status` confirms I modified no file under `packages/db/test/`.

Two other suites (`apps/api` `sprint-1.1d-memory-e2e`, `apps/web` `map-live`) each failed **once** during full-suite runs and passed on isolation and on re-run — DB-backed and load-related flakiness, not deterministic failures. Reporting them rather than hiding them.

### Live verification of the usage guard — against real Postgres

The migration was applied (`20260909120000_v3_maps_usage_guard`; it was the only pending one of 23). The guard was then driven end-to-end against the real database with `GOOGLE_MAPS_MONTHLY_LIMIT=5`:

```
limit from env  -> 5
start           -> used 0,  0%,  OK,      blocked false
after 4 calls   -> used 4, 80%,  WARNING, blocked false
check @4/5      -> allowed: true   level: WARNING
{"level":"warn","event":"maps_usage_limit_blocked","period":"2026-09","used":5,"limit":5}
check @5/5      -> allowed: false | Google Maps monthly usage limit reached. 5 of 5 requests used this month.
byService       -> [{"service":"routes","count":3},{"service":"places","count":2}]
thisUser        -> 5
lastRequestAt   -> 2026-09-09T08:29:05.954Z
```

This exercises brief §9 step 11 (*simulate usage and confirm further calls are blocked*) at a scaled-down limit: counting persists, the threshold escalates, the block fires with the exact specified message, the block is logged, and the per-service and per-user breakdowns are correct. **The verification rows were deleted afterwards** — the table is back to zero for that user.

### Manual acceptance (§9 steps 1–10, 12) — NOT executed

Steps 1–10 need a browser session **and a Google Maps key**, which this environment does not have. They remain outstanding:

| # | Step | Status |
|---|---|---|
| 1–2 | Dashboard loads, map widget renders | ⬜ needs key |
| 3–5 | My Location → permission → marker | ⬜ needs key |
| 6–7 | Search a location, marker appears | ⬜ needs key |
| 8–9 | "Balaghat se Gondia kitni door hai?" → real distance | ⬜ needs key |
| 10 | Usage counter increments | ⬜ needs key (mechanism verified above) |
| 11 | Simulate 70,000 → blocked | ✅ **verified** at scaled limit against real Postgres |
| 12 | No key in browser source, logs, responses, Git | ✅ **verified** (§6) |

Automated equivalents for 1–9 exist against a stubbed SDK in `map-live.test.tsx` and `location-routing.test.ts`. That is not the same as watching a real map draw a real route.

---

## 9. Remaining manual Google Cloud configuration

1. **Enable four APIs**: Maps JavaScript API, **Places API (New)** — *not* the legacy Places API — Routes API, Geocoding API.
2. **Enable billing** on the Cloud project. Without it, calls fail `FAILED_PRECONDITION`, which JARVIS surfaces as *"Billing may not be enabled for this Cloud project."*
3. **Create two separate keys:**
   - *Browser key* — restrict to **HTTP referrers** (your origins) and to the **Maps JavaScript API only**.
   - *Server key* — restrict to your API server **IP addresses** and to **Places (New) + Routes + Geocoding**.
   One key cannot do both jobs: a referrer-restricted key will not work server-side, and an IP-restricted one will not work in a browser. Sharing one means dropping the restriction that makes it safe.
4. **Set a Cloud budget alert and per-API quota caps.** The JARVIS guard cannot see browser tile loads and is a safety net, not a billing control.
5. **Put the two keys in `.env`** (not `.env.local` — the API reads `.env`), optionally with `GOOGLE_MAPS_MONTHLY_LIMIT`, and restart the API.

---

## 10. Summary

Everything in §1 and §5–§9 is implemented, typechecks, builds, and is covered by 39 new tests on top of the 105 from the previous pass. The usage guard is the only part that could be verified against live infrastructure, and it was — counting, escalation, hard block and admin breakdowns all confirmed against the real Postgres database.

**The one thing standing between this and a working Google Maps integration is the two API keys, which are not in `.env`.** No code change is needed once they are added.
