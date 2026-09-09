# JARVIS — Google Maps Integration, Final Report

**Date:** 2026-09-09
**Branch:** `feat/command-center-v3`
**Scope:** Real Google Maps Platform integration, end to end — map, location, places, routing, natural-language map commands, Tool Registry, security, tests.

---

## 0. Correction to the brief

The brief opens with *"STOP working on the visual mockup"* and *"Replace the existing fake/placeholder Map implementation."*

**There was no fake map.** The audit found a genuine `google.maps.Map` already in place, created from the Maps JavaScript API with real markers, a real drawn polyline and a `ResizeObserver` that re-lays-out the map when the widget is resized. The server side already had a Google Maps provider calling the real Geocoding and Routes APIs, with an OpenStreetMap fallback that labels itself honestly.

So this work did not replace a mockup. It closed the gaps between that existing integration and what the brief specifies. Those gaps were real and several of them were significant — one was a latent production break. They are itemised in §2.

---

## 1. Audit — what already existed

Performed before any change, per the brief's §1.

| Area | Finding |
|---|---|
| Map widget | Real `google.maps.Map`. Pan, zoom, markers, polyline, resize handling, full teardown on unmount. Not a mockup. |
| SDK loading | `useGoogleMaps` hook. Browser key fetched from an **authenticated** endpoint, not baked in as `NEXT_PUBLIC_*`. Module-scoped singleton loader. |
| Server providers | `google-maps-provider.ts` — Geocoding, Places, Routes v2, polyline decoding, TTL caches, travel-mode mapping, error messages that never echo the key. |
| Fallback | `geo-provider.ts` — Nominatim + OSRM, rate-limited to Nominatim's 1 req/sec policy, ODbL attribution carried on every result. |
| API routes | `/geo/search`, `/geo/route`, `/geo/reverse`, `/maps/config`, `/capabilities` — all `requireAuth`. |
| Config | `GOOGLE_MAPS_BROWSER_KEY` / `GOOGLE_MAPS_SERVER_KEY` in `@jarvis/config`, already **separate** from Google OAuth. |
| Tests | `apps/api/test/v3-google-maps.test.ts` — 13 tests on key safety and provider selection. |

### Existing Google integrations — no duplication

The brief warns against creating a duplicate Google integration. There are **three distinct Google surfaces** in this repo and they stay distinct:

| Surface | Credential | Where |
|---|---|---|
| **Google Ads** | OAuth 2.0, per-user, tokens encrypted in Postgres | `packages/google-ads`, `routes/google-auth.ts` |
| **Google Sign-In** | OAuth 2.0, identity only | `routes/google-signin.ts` |
| **Google Maps Platform** | Two API keys, server environment | `services/providers/google-maps-provider.ts` |

Maps uses **API keys, not OAuth**, and must — Maps Platform has no user-consent model. No OAuth code was touched. No second Google client was created.

---

## 2. Gaps found, and what was done

### 2.1 Legacy Places API — a latent production break *(most important)*

The provider called `https://maps.googleapis.com/maps/api/place/textsearch/json`. Google **stopped enabling the legacy Places API for Cloud projects created after March 2025**.

The failure mode was nasty: a new deployment following the setup instructions would get a working map and working routes, and `REQUEST_DENIED` on **every place search**. Partial breakage is much harder to diagnose than total breakage.

**Migrated to Places API (New):**

| Capability | Endpoint |
|---|---|
| Text search | `POST https://places.googleapis.com/v1/places:searchText` |
| Autocomplete | `POST https://places.googleapis.com/v1/places:autocomplete` |
| Place details | `GET https://places.googleapis.com/v1/places/{placeId}` |

Field masks are sent on search and details (the New API bills by mask; an unmasked call is charged at the highest SKU). Autocomplete correctly sends **no** mask — that endpoint rejects one.

`describeStatus()` now maps gRPC status names (`PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `UNAUTHENTICATED`, `FAILED_PRECONDITION`) alongside the legacy strings, so a quota problem still reads as a quota problem and a billing problem names billing.

### 2.2 No maps tools in the Tool Registry — the largest gap

`ToolRegistry` had **zero** maps tools. Natural-language map commands could not work at all: `"Balaghat se Gondia ka route dikhao"` in chat reached an agent with no tool for it, which means a model guessing a distance.

**Eight READ_ONLY tools added** in `packages/tools/src/tools/maps-tools.ts`:

| Tool | Purpose |
|---|---|
| `maps.search` | Place, business, landmark search |
| `maps.nearby` | Places near the user |
| `maps.geocode` | Name → coordinates, flags ambiguity |
| `maps.reverse.geocode` | Coordinates → address |
| `maps.current.location` | Where the user is |
| `maps.route` | Route **with** path, for drawing |
| `maps.distance` | Distance and duration, **without** path |
| `maps.place` | Place ID → resolved place |

The model never sees a URL, a key, a field mask or a raw response. It calls a tool; `MapsPort` (implemented in `services/maps-adapter.ts`) decides which provider answers.

`maps.route` and `maps.distance` are deliberately separate. Given one tool for both, a model dumps a polyline into chat.

### 2.3 No natural-language routing

Added a `location` agent domain, a `LocationAgent` (`packages/agents/src/agents/location-agent.ts`), a `LOCATION_POLICY`, and `LOCATION_SIGNALS` in the router.

The router is a pure deterministic function — no model call picks the agent, because the agent choice selects the tool allowlist.

Every signal requires a **map word, a routing word, or an explicit proximity phrase**. `show Gondia` is deliberately *not* a signal: it is indistinguishable from asking about a campaign named Gondia. Hindi and Hinglish forms are first-class (`rasta`, `kitna door`, `mere paas`, `meri location`, `map par`).

The maps tools are granted to the **general assistant as well**, because a distance question arrives mid-conversation at least as often as it arrives alone, and the fallback agent going tool-less would make it guess.

### 2.4 No autocomplete, no debounce

Search was submit-only. Added `usePlaceSuggestions` (`apps/web/src/lib/use-place-suggestions.ts`):

- **300 ms debounce** — six keystrokes become one billed call
- **AbortController per request** — a slow `"Gond"` can no longer land after a fast `"Gondia"` and replace the right list with the wrong one
- **`skip(value)`** — writing a picked suggestion back into the input does not re-query it
- **Below 2 characters, nothing is requested** — the server rejects those anyway
- **Not cached** — the input changes per keystroke, so a cache would hold a per-user trail of partial searches and hit almost never

### 2.5 Place IDs were dropped

`Place` gained an optional `placeId`, threaded through geocoding, Places and the widget. `googleRoute` now sends `{placeId}` as a Routes waypoint when one exists, falling back to coordinates for OpenStreetMap places (which have no Place IDs and must never be given a fake one).

This is what stops `"Gondia"` — a city, a district **and** a railway station — routing to a different place from the one the user picked. Editing a field by hand clears its stored id, because the id would then name something the text does not.

### 2.6 Continuous tracking was on by default

The old widget started a `watchPosition` automatically after the first fix. **Fixed.** The dashboard now asks **once**. A watcher starts only when the user turns **LIVE** on, throttled to one update per 5 s, and stops on toggle-off and on unmount. Turning it off also tells the server to forget the position.

### 2.7 Reverse geocoding needed a Google key

`/geo/reverse` returned `UNAVAILABLE` without `GOOGLE_MAPS_SERVER_KEY`, leaving the current-location marker unlabelled on any browser-key-only deployment — for a lookup Nominatim answers perfectly well. Now falls back, with `meta.source` naming whichever provider replied.

### 2.8 No Settings entry

Added a `google-maps` provider to `routes/credentials.ts` with **three** states, because the two keys do different jobs:

| State | Meaning |
|---|---|
| `CONFIGURATION_REQUIRED` | No browser key — map cannot render |
| `CONFIGURED` | Map works; places/routing fall back to OpenStreetMap |
| `CONNECTED` | Both keys — everything served by Google |

**Neither key is ever returned.** Only whether one exists.

---

## 3. Google Cloud configuration required

### APIs to enable

| API | Needed for | Key |
|---|---|---|
| **Maps JavaScript API** | Rendering the map | Browser |
| **Places API (New)** | Search, autocomplete, details | Server |
| **Routes API** | Routes, distance, duration | Server |
| **Geocoding API** | Name ↔ coordinates | Server |

Do **not** enable the legacy Places API — this integration does not call it.

### Billing

Maps Platform requires a billing account on the Cloud project. Without it, calls fail with `FAILED_PRECONDITION`, which this integration surfaces as *"Billing may not be enabled for this Cloud project."*

### The two keys

```
GOOGLE_MAPS_BROWSER_KEY=...   # reaches the browser — see below
GOOGLE_MAPS_SERVER_KEY=...    # NEVER leaves the server
```

**Browser key restrictions (required):**
- Application restriction: **HTTP referrers**, listing only your deployed origins
- API restriction: **Maps JavaScript API only**

**Server key restrictions (required):**
- Application restriction: **IP addresses** of your API servers
- API restriction: **Places API (New), Routes API, Geocoding API**

They must be **two separate keys**. A single key restricted by referrer cannot be used server-side; one restricted by IP cannot be used in a browser. Sharing one key means dropping the restriction that makes it safe.

### Why the browser key is not a secret

The Maps JavaScript API has no way to render without a key in the page. It is served from an **authenticated** endpoint (`GET /command-center/maps/config`) rather than inlined as `NEXT_PUBLIC_*` into a static bundle anyone could fetch without logging in — but that is defence in depth. **The real control is the HTTP-referrer restriction.**

`.env` files are not committed. No key appears in source, in a response body other than the browser key's own endpoint, or in any log line.

---

## 4. What was built — file by file

### Backend

| File | Change |
|---|---|
| `services/providers/google-maps-provider.ts` | Places API (New); `googlePlaceAutocomplete`, `googlePlaceDetails`; Place ID waypoints; gRPC status mapping; Place ID validation |
| `services/providers/geo-provider.ts` | `PlaceSuggestion`; `autocomplete`, `resolveSuggestion`, `resolvePlaceId`, `reverseGeocode`, `routePlaces`; OSRM path extracted |
| `services/location-store.ts` | **New.** In-memory, per-user, 15-min TTL, bounded, range-validated |
| `services/maps-adapter.ts` | **New.** `MapsPort` + `CurrentLocationPort` implementations |
| `routes/command-center.ts` | `GET /geo/autocomplete`, `GET /geo/place/:placeId`, `POST` + `DELETE /geo/location`; `/geo/route` accepts Place IDs; `/geo/reverse` falls back to OSM |
| `routes/credentials.ts` | Google Maps provider entry with three-state status |
| `services/container.ts` | Maps tools registered unconditionally; `LocationAgent` registered |

### Tools & agents

| File | Change |
|---|---|
| `packages/tools/src/tools/maps-tools.ts` | **New.** Eight tools, two ports |
| `packages/agents/src/agents/location-agent.ts` | **New.** Agent + prompt |
| `packages/agents/src/agent-policy.ts` | `MAPS_TOOLS`, `LOCATION_POLICY`; maps granted to general |
| `packages/agents/src/agent-router.ts` | `LOCATION_SIGNALS` + candidate at 0.88 |
| `packages/core/src/types/agent.ts` | `location` domain |

### Frontend

| File | Change |
|---|---|
| `lib/use-place-suggestions.ts` | **New.** Debounced, cancelling autocomplete hook |
| `lib/api.ts` | `PlaceSuggestion`; `autocompletePlaces`, `resolvePlace`, `publishLocation`, `clearPublishedLocation`; `Place.placeId`; `getRoute` takes Place IDs |
| `components/widgets/map-widget.tsx` | Autocomplete dropdowns, Place ID tracking, LIVE toggle, one-shot default, server publish, place selection |

---

## 5. Security

### Tenant isolation

The claim is narrow and testable: **a model cannot choose a location.**

- `maps.current.location` takes **no parameters at all**
- `nearMe` is a boolean; coordinates come from `context.userId`, filled by the executor from the session
- `LocationStore` is keyed on the authenticated user id — no code path takes a user id from a request body or from model output
- `POST /geo/location` stores against `req.auth.userId`; a caller cannot name a different user
- The endpoint echoes nothing back — no reason for the server to tell a client where it just said it was

Pinned by `packages/tools/test/maps-tools.test.ts`: *"reads the current location from the AUTHENTICATED user, not from params"* and *"cannot read another user's position"* both pass a hostile `userId` in params and assert it is ignored.

### Secret protection

- Google's `error_message` is **never** forwarded — on a misconfigured key it echoes the key and referrer
- The server key goes in an `X-Goog-Api-Key` **header**, never a query string (URLs reach proxy logs and browser history)
- `/maps/config` returns the browser key and a boolean for the server key — never the server key
- Place IDs are validated against `^[A-Za-z0-9_-]{4,512}$` before entering a URL path; `../../v1/places:searchText` is rejected without a network call

### Authorization

Every route is `requireAuth`. Every tool is `READ_ONLY` / `["read"]` — auto-approved by `ToolApprovalService`, consistent with the Meta and Google Ads read tools. The approval boundary is not weakened; there is simply nothing to approve, because no map query changes state anywhere.

---

## 6. Privacy

| Requirement | Implementation |
|---|---|
| Browser permission required | Browser's own prompt; refusal handled, never looped |
| No silent tracking | One-shot by default. `watchPosition` only while LIVE is on, and the widget title reads "Live location" while it runs |
| No unnecessary persistence | Nothing written to Postgres or disk. In-memory, 15-minute TTL |
| No unnecessary logging | No coordinates in any log line |
| User-controlled | LIVE toggle stops the watcher, clears the marker **and** tells the server to forget |
| Cache does not hold a trail | Reverse-geocode cache keys round to 3 decimals (~110 m) |
| Autocomplete leaves no trail | Not cached at all |

---

## 7. Rate limiting and cost control

| Control | Where |
|---|---|
| 300 ms debounce | `usePlaceSuggestions` |
| Stale requests aborted | `AbortController` per request |
| No re-query on selection | `skip(value)` |
| Min 2 characters | Client, hook and server all refuse shorter |
| Result count clamped | Tools clamp to 10; provider caps `maxResultCount` at 20 |
| Field masks | Only drawn fields requested |
| Geocode cache | 24 h (Google permits 30 days) |
| Route cache | 1 h, keyed on Place ID when available |
| Live updates throttled | 5 s minimum |
| Nominatim serialised | 1 req/sec, per its usage policy |
| Validate before spending | Invalid input makes **zero** upstream calls — pinned by test |

---

## 8. Error handling

Every case in the brief's §24 is handled with a specific message:

| Condition | Shown |
|---|---|
| No browser key | "Google Maps · configuration required" + the variable names + a Settings link |
| SDK load failure | "…key may be invalid or restricted to a different origin" + Retry |
| Invalid / refused key | "Check that the server key is valid and the Places API (New) and Routes API are enabled" |
| Billing disabled | "Billing may not be enabled for this Cloud project" |
| Quota exceeded | "The Google Maps quota for this project has been exceeded" |
| Network failure | "Google Maps could not be reached" |
| Permission denied | "Location permission denied." + Try again |
| Location unavailable | "Current location unavailable." + Try again |
| No Geolocation API | "This browser cannot report a location." |
| Place not found | "No place matched …" |
| Route not found | "No route was found between those places" |
| Ambiguous place | `ambiguous: true` — the agent is told to ask which |
| Unsupported travel mode | Control disabled with "Needs a Google Maps server key" |

Nothing fails silently. `UNAVAILABLE` is a first-class outcome carrying a reason — never a zero, because a zero is a lie.

---

## 9. Tests

### Added — 105 tests

| File | Tests | Covers |
|---|---|---|
| `apps/api/test/v3-maps-places-location.test.ts` | 28 | Places API (New) endpoints, key-in-header, field masks, Place ID plumbing, path-traversal rejection, gRPC status mapping, routing waypoints, location store |
| `packages/tools/test/maps-tools.test.ts` | 32 | Tenant isolation, no location parameter, limit clamping, ambiguity, provider attribution, no-call-on-invalid-input |
| `packages/agents/test/location-routing.test.ts` | 18 | English/Hindi/Hinglish routing, **regression on every existing agent**, policy scope |
| `apps/web/test/map-live.test.tsx` | 27 | Map creation, location lifecycle, one-shot default, LIVE toggle, watcher cleanup, debounce, Place ID plumbing, polyline drawing, attribution |

### Full suite — no regressions, nothing weakened

| Suite | Result |
|---|---|
| `apps/api` | **705 passed** (26 files) |
| `apps/web` | **303 passed** (14 files) |
| `packages/agents` | **491 passed** |
| `packages/tools` | **720 passed** |
| `packages/core` | **416 passed** |
| **Total** | **2,635 passed, 0 failed** |

Four pre-existing drift-detector tests failed mid-work and were **updated, not weakened** — they exist to catch exactly this kind of addition:

- `sprint6-agent-wiring.test.ts` — new tools added to the registered-tool fixture; `LocationAgent` added to the registry helper, **plus** a new assertion that it is absent when its tools are
- `sprint6-agent-architecture.test.ts` — agent count 8 → 9
- `sprint6-harness.ts` — maps tools added to `productionLikeTools()`
- `sprint6-security.test.ts` — **not** modified. It caught a real convention violation: tool ids must match `^[a-z0-9]+(\.[a-z0-9]+)+$`, and `maps.reverse_geocode` / `maps.current_location` used underscores. **The tool ids were renamed** to `maps.reverse.geocode` and `maps.current.location`.

### Two real bugs caught by these tests during development

1. **Place name truncation.** `shapeNewPlace` preferred `displayName` when the address already started with it, turning `"Gondia, Maharashtra, India"` into `"Gondia"` — discarding the state and country and making two different Gondias indistinguishable in a suggestion list. Now the fuller address wins.

2. **Tool id convention.** Caught by the untouched security test, as described above.

---

## 10. Verification performed

### Typecheck — all clean

```
packages/core      tsc  ✓
packages/config    tsc  ✓
packages/tools     tsc  ✓
packages/agents    tsc  ✓
apps/api           tsc --noEmit  ✓
apps/web           tsc --noEmit  ✓
```

### Production builds — both succeed

```
apps/api    npx tsc            ✓ exit 0
apps/web    npx next build     ✓ Compiled successfully — 22 routes
```

### Live end-to-end run of the geo pipeline

Executed against the **compiled API build**, making **real network calls**:

```
geocode Balaghat  -> Balaghat, Madhya Pradesh, India  21.8611589, 80.3237105
                     source: OpenStreetMap / Nominatim  freshness: LIVE

route Balaghat->Gondia -> 65.6 km, 56 min, path points: 16
                     source: OSRM

reverse 21.15,79.09 -> Nagpur City, Nagpur Urban Taluka, Nagpur, Maharashtra, India
                     source: OpenStreetMap / Nominatim

autocomplete "Gond" -> Gond | Gond | Gond
                     source: OpenStreetMap / Nominatim
```

This proves the full pipeline — geocoding, routing **with a drawable 16-point path**, reverse geocoding (the newly-added fallback) and autocomplete — works end to end against live providers, and that every result names its real source.

---

## 11. Known limitations — read this section

### 11.1 The Google Platform paths have not been exercised against live Google

**No Maps keys are configured in this environment** (`GOOGLE_MAPS_BROWSER_KEY` and `GOOGLE_MAPS_SERVER_KEY` are both unset). The Google code paths are verified by **unit tests with mocked fetch** that assert the exact endpoints, headers, field masks and request bodies — but no real call to `places.googleapis.com` or `routes.googleapis.com` has been made.

Specifically unverified against live Google: the browser map rendering, Places API (New) responses, the Routes API, and Place ID resolution.

### 11.2 The §27 manual acceptance test was NOT executed

All ten steps require a browser session, a running database and real Maps keys. **None of them were run.** They remain outstanding:

| # | Step | Status |
|---|---|---|
| 1–2 | Dashboard loads, permission granted, map centres | ⬜ Not run |
| 3–4 | Search "Gondia", select it | ⬜ Not run |
| 5 | "Balaghat se Gondia ka route dikhao" in chat | ⬜ Not run |
| 6 | "Meri current location se Gondia ka route dikhao" | ⬜ Not run |
| 7 | MY LOCATION button | ⬜ Not run |
| 8–9 | Resize and move the widget | ⬜ Not run |
| 10 | Save layout, reload, position persists | ⬜ Not run |

Automated equivalents exist for steps 1–7 in `map-live.test.tsx` and `location-routing.test.ts`, against a stubbed SDK. That is not the same as a human watching a real map draw a real route.

### 11.3 Other limitations

- **OSRM public server is driving-only.** Walking, cycling and transit need `GOOGLE_MAPS_SERVER_KEY`. The UI disables those controls rather than silently substituting driving.
- **Autocomplete without a Google key** falls back to Nominatim search. It works (verified above) but the ranking is noticeably weaker — the `"Gond"` run returned three identically-labelled rows.
- **The location store is per-process.** A multi-instance deployment behind a load balancer without sticky sessions could publish a position to one instance and run a tool on another, producing "no location available". A shared cache would fix it; that is a deployment-topology decision, not a code gap.
- **No alternate routes.** The Routes API supports them; only the best route is requested, to keep the response and the cost small.
- **Nominatim's 1 req/sec** is a global serialisation across all users. Fine at current scale; a busy deployment should set a Google server key.

---

## 12. Verdict

### GOOGLE MAPS INTEGRATION — PASS

Every item in the brief is implemented, typechecks, builds and is covered by tests. 2,635 tests pass with no regressions and no test weakened; the one test that failed on principle caused a **code** change, not a test change.

**This verdict covers implementation and automated verification only.**

Two things it does **not** cover, stated plainly:

1. The Google Maps Platform code paths have never run against live Google — no keys exist in this environment (§11.1).
2. The §27 manual acceptance test was not executed, in any of its ten steps (§11.2).

The recommended next action is to provision the two restricted keys per §3, then run §27 by hand. Until that is done, the Google-specific behaviour is *tested* but not *observed*.

---

**Verified in this environment:** 2,635 automated tests · 6 packages typecheck clean · 2 production builds · live geocoding, routing, reverse geocoding and autocomplete over OpenStreetMap/OSRM.

**Not verified:** anything requiring a Google Maps API key.
