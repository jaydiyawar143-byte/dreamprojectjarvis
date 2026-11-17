# Virtual Office

The Virtual Office is a 2D floor plan of the agents this deployment registered, the task engine's queue, and the newest audit records, with a live feed while the dashboard is open. Since VO-2.2 it is a **widget on the main dashboard**, which opens the full office in a dialog; it has no sidebar entry, and the old `/office` route redirects to `/dashboard?office=open`. Since VO-3.1 it is a **living office**: agents walk, take breaks and return to their desks, while the work they show is still only what the server records. It is a **window, not an authority**: nothing in it runs, approves or writes anything.

This file is the contract for VO-1 (the office view), VO-2 (the live stream), VO-2.1 (hardening), VO-2.2 (the dashboard widget) and VO-3.1 (the living office). AGENTS.md's "Virtual Office" section lists the parts a change must not break; this file says why, and what is still open.

## What it reads

| Source | Used for |
|---|---|
| `GET /api/v1/agents` | Which agents are registered (drawn) and which are declared but not registered (listed outside the floor); since VO-3.1 each agent's tools with their declared risk |
| `GET /api/v1/tasks` | The task engine's work list (titles), and since VO-2.1 `statusCounts`: every state's total for the caller's JARVIS work, counted in the database |
| `GET /api/v1/office/agent-work` | Since VO-3.1, the caller's per-agent work: the active task (assigned, queued or running, with its tool), the queued count, the newest completed and failed task, and pending approvals |
| `GET /api/v1/activity?limit=40` | The newest audit rows, already redacted at write time |
| Socket.IO `office:event` | Live activity and task events, after `office:subscribe` |

`buildOfficeModel` (`apps/web/src/components/office/office-model.ts`) is the one derivation; the renderer only paints what it returns.

## Where it lives (VO-2.2)

**A dashboard widget.** `OfficeWidget` (`apps/web/src/components/office/office-widget.tsx`) is registered like every other widget: the `office` id, its limits (at least 4×3, hideable, shown by default) and the default layout in `components/widgets/layout.ts`, its label in the customise bar, and its priority in the layout optimiser. By default it takes the top-right 8×5 slot beside the Orb, and the map moves to the bottom-right. Stage 1 drew the floor with the VO-1 DOM renderer; Stage 2 (below) draws the pixel-art office in both the widget and the expanded view.

## The pixel-art office (VO-2.2 Stage 2)

**One SVG, scaled by the browser.** `PixelOfficeRenderer` (`components/office/pixel/pixel-office-renderer.tsx`) draws the whole office as one SVG in scene units (236×118, `SCENE`), with `shape-rendering: crispEdges` and `image-rendering: pixelated`, so the same scene is the widget's preview and the expanded view's floor. It is registered as `OFFICE_RENDERERS.pixel` behind the VO-1 renderer seam; the VO-1 list (`dom`) stays registered as the text fallback. No canvas, no WebGL, no new dependency: a Canvas renderer, if one is ever needed, is added to the registry and nowhere else.

**Sprites are data** (`pixel/sprites.ts`, pure). Every figure and fixture is a matrix of characters keyed to a palette, turned into one SVG path per colour from its horizontal runs and memoised per sprite. Characters are composed from parts — four hair styles, three accessories, three poses — and recoloured per agent: the eleven published agents have hand-picked looks (`lookForAgent`), and any other registered agent gets a stable look from a hash of its id, never a blank. The outfit is the department's accent.

**The building is constants** (`pixel/floor-plan.ts`, pure). Six rooms in a 3×2 block, in department order, each with a wall, a signed plaque, its own fixtures (desks with monitors, a server rack, a whiteboard, a chart screen, a bookshelf, a conference table, windows, a coffee machine, a vending machine, a sofa, plants) and workstations. `placeAgents` seats a department's agents at its desks first, then its standing spots, then along the wall; nobody is dropped. A figure works at the left of its desk and the monitor stands at the right, so neither covers the other; desk rows are 20 apart so a name tag never touches the head behind it. The JARVIS core stands in the Command Center. The corridor floor runs far past the building, so when a cell is wider than 2:1 the letterbox shows more building, not black bars.

**A look is not a claim.** `agentVisual` and `systemVisual` are the only two functions that turn a state into a look, and they map exactly the lifecycle `office-lifecycle.ts` derives from durable rows (VO-3.1): an idle agent breathes (decorative, as the legend says) and its monitor is dark; a queued or assigned agent holds still with its queue or assignment glyph; a running task scrolls the monitor and types at the desk; "Waiting for approval" shows a blinking amber hourglass; a completion holds still with a green check and a one-shot completion pop keyed by the completion time; a failure shows a blinking red mark. Typing is mapped ONLY from the three states a RUNNING task produces, and the renderer draws it only while the figure is seated. JARVIS's core cycles its light only from a RUNNING task, and draws one amber queue marker per PENDING task (capped at five) only from the real count. A room's door light blinks only while something in it is not idle.

**Motion is CSS, driven by one clock.** Two or three pre-painted frames per figure, toggled by keyframes; no animation frame and no React state tick for the frames. Since VO-3.1 the scene owns ONE timer, and it does not tick on a fixed beat: it wakes at the next instant anything is scheduled to change (a slot boundary, a leg of a walk ending) and, only while someone walks, every `WALK_TICK_MS` so a CSS transition can carry the figure smoothly. A test passes `clock` and gets no timer at all. `prefers-reduced-motion` stops every loop in the stylesheet and turns the ambient layer off, `usePrefersReducedMotion` reports it on the scene (`data-motion`) and follows a change, and its listener is removed on unmount.

**Looking around** (`pixel/use-office-viewport.ts`). The expanded view pans by drag, zooms with ctrl/⌘ + wheel (a plain wheel still scrolls the page), + / − / 0 and the arrow keys, and the on-screen controls; a double-click resets. The viewBox is clamped to the scene and to 1×–4×. A drag that ends on a figure is not a click on it (`consumeDrag`). The pointer is captured only once a press has become a drag: capturing on pointerdown makes the browser deliver the click to the SVG, and nothing on the floor could be clicked (jsdom does not show this; Chrome did). The ctrl+wheel listener is native and non-passive, and removed on unmount. The widget's preview is static: no controls, no listener, no focusable floor.

**Fitting the cell.** The widget's floor fills its body (`absolute inset-0`) beside an invisible 2:1 spacer capped at the body's height: in the grid the cell decides the height and the floor can never spill past it (Auto optimize sees no scrollbar), and in the stacked phone column, where a cell has only a minimum height, the spacer gives the floor its height from its width. `OfficeScene` takes its position class instead of adding `relative` to it, because `relative absolute` lets `relative` win.

**Interaction.** A figure and the core are buttons (click, Enter, Space) with `aria-pressed`; the selection is ringed on the floor and the selected-actor panel shows what the model knows. A room's sign, or its chip under the floor, inspects the room: the floor frames it and dims the others, and `OfficeDepartmentPanel` lists who is stationed there with their states and the newest events naming them, from the same model; "Whole office" returns. The side panel shows whichever the person chose last, so inspecting a room while an agent is selected shows the room and keeps the selection ringed on the floor. On the widget, a figure opens the office with that agent selected and a sign opens it looking at that room; the room is a way of looking and does not survive a close, the selection does.

**Tests.** `apps/web/test/office-pixel-vo3.test.tsx` pins the sprites, the floor plan, the state mapping, selection, department inspection, live updates, the viewport (pointer capture and wheel-listener cleanup included), reduced motion, the expanded view and the widget. `office-page.test.tsx` and `office-widget-vo22.test.tsx` run against the pixel floor unchanged in what they assert.

### Evidence (2026-11-13, Windows, from the working tree, not committed)

| Check | Result |
|---|---|
| Web suite | 50 files, 1,080 passed, 0 failed |
| `tsc --noEmit` (web, tests included) / `eslint src/` | 0 errors / clean |
| Browser, real Chrome against the running stack and the live registry (8 registered agents) | 29/29 checks: default 8×5 cell, no page scroll and the floor inside its cell at 1920×1080 and 1366×768, the stacked column at 820×1180 and 390×844, Auto optimize finding nothing, expand with the clicked agent selected, zoom, mouse-drag pan, room inspection, Escape returning focus, the selection kept after close, hide and restore without overlap, a hidden office opened once by `?office=open`, the link waiting out customise mode, the test account left on the default layout |
| Live update | One real chat turn as the same user: only the agent that handled it changed, Idle → "Just finished" with its check and green screen, on the open dashboard, with no reload |

**Starting the dev server on Windows.** Start the stack from PowerShell, not Git Bash. Started from Git Bash, `next dev` compiled the repository under both `D:` and `d:`, loaded Next's router-context module twice, and every page failed to hydrate with `Invariant: Missing ActionQueueContext` — a launch fault, not a code one.

**Saved layouts are kept.** A layout saved before the office existed is restored exactly as saved. The office, at its default size, takes the first free space that overlaps no visible widget, scanning rows top to bottom, then columns left to right; if there is none, it goes directly below the lowest widget (`placeNewWidget`). A fully tiled layout therefore grows to seventeen shorter rows until the person rearranges or resets it. A layout too deep for "below" gets the office hidden rather than placed on top of anything.

**Showing a hidden widget never overlaps either.** Hiding keeps the placement, and a widget shown again comes back where it was whenever that space is still free. When it is not — something was moved into its slot while it was hidden, or it was parked hidden by the rule above — `setHidden` re-places it by the same rule as a new widget: the first free space, else below everything, moving nothing else. If the layout already reaches the storable bottom it stays hidden and the layout is returned unchanged, so the toggle does not read as an edit.

**One subscription.** `useOfficeData` (`components/office/use-office-data.ts`) holds the three reads and the live feed. The widget calls it once and hands the result to the dialog, so opening the office starts no second socket and no second round of reads.

**Nothing is read before the layout is known.** The dashboard draws `DEFAULT_LAYOUT` until `GET /preferences` answers, and the office is visible in that default. `OfficeWidget` therefore takes the dashboard's own `dash.loaded` as a REQUIRED `layoutLoaded` prop and, until it is true, renders its frame alone — no reads, no socket, no expand control, nothing to click. The gate is a wrapper (`OfficeWidgetPending` / `OfficeWidgetLive`) rather than an early return inside the widget, because `useOfficeData` must not be mounted at all: a hook cannot be called conditionally. The command centre mounts `OfficeDeepLink` only after the layout has loaded too, so a widget the saved layout hides never reads, and a hidden office plus `?office=open` opens exactly once, when the layout says it is hidden.

**The expanded office** (`components/office/office-expanded.tsx`) is a full-screen modal dialog: rendered through a portal to `<body>` (a grid cell's CSS transform would otherwise trap a fixed element), above the chat surface layer, labelled, with focus moved in on open and given back on close, Tab kept inside, and Escape, the close button or a press on the backdrop closing it. Escape is not passed on to anything beneath. An agent clicked on the widget opens the office with that agent selected, and the selection survives closing.

**Opening it.** The widget's expand control, an agent on its floor, or `?office=open` in the URL; closing removes the parameter. While the widget is hidden, the command centre mounts `OfficeDeepLink`, which opens the office only when the URL asks and reads nothing otherwise. In customise mode nothing opens, whether the widget is visible or hidden, so arranging the dashboard never opens a dialog; a `?office=open` that arrives meanwhile is kept in the URL and honoured the moment customise mode ends. Closing the office then removes the parameter as usual.

## The living office (VO-3.1)

**Two layers, never mixed.** An agent's REAL state and its AMBIENT activity are separate: the real layer is derived from durable rows and always wins; the ambient layer is decoration, is a pure function of time, and records nothing.

**The real layer.** `office-lifecycle.ts` is the one derivation, in three pure steps: `parseAgentWork` validates the server's per-agent read field by field (an older or newer API never puts an unknown field on screen); `overlayAgentWork` applies live task events newer than the read (newest per task, so a start or a finish shows at once and a stale event changes nothing); `deriveLifecycle` turns one agent's facts into one state. The states and their only sources:

| State | Source |
|---|---|
| Working / researching / using a tool | A RUNNING task assigned to the agent. "Researching" when its tool's declared risk is `READ_ONLY`, "using a tool" when the tool is known and not read-only, "working" when the row names no tool |
| Waiting for approval | A PENDING, unexpired approval the agent asked for (the Approval table, via the read), or — while that read is unavailable — the agent's own fresh `pending` audit row |
| Assigned | A PENDING assigned task the scheduler has claimed |
| Queued | A PENDING assigned task due now or within ten minutes |
| Completed / failed | The agent's newest finished task, or its newest audit row, inside the ten-minute window |
| Idle | None of the above |

There is no paused state, because the task engine has none. A task is assigned to an agent when it is scheduled, claimed and run: `agentId`, `assignedAt` and `toolId` are written on the task row, and `assignAgentForTool` (`packages/agents/src/task-assignment.ts`) is the one chooser. A task run's audit row names no agent, so it is attributed through its `executionId`, which the task row carries. A run with no registered agent remains JARVIS system work.

**The ambient layer.** `pixel/ambient.ts` decides what an idle agent does: coffee, water, lunch, the sofa, a chat, a stretch, a walk, the washroom. Each agent has a fixed cycle of slots whose lengths come from a hash of its id, and what each slot holds is drawn from its own weighted preferences; conversations are global pair events chosen per window. It reads no task, no audit row and no approval, and writes nothing: there is no fake task, no fake event and no progress. `pixel/agent-motion.ts` turns that schedule and the real state into a position: real work interrupts the activity at once, walks the figure back from wherever it actually is by the shortest route through the doors ("returning to desk"), and seats it. When the work ends the figure waits for the NEXT slot, so it never jumps back into a break that began while it worked. A page load with work is simply seated — a page load is not a return. Typing is drawn only for the three executing states AND only while the figure is seated; a returning figure shows a walk, never a keyboard. `OfficeScene`'s `ambient` prop turns the layer off (the tests pass `false`), and reduced motion does too.

**The panel.** The selected-actor panel shows the lifecycle, the current task (title, status, tool and the time that matters), the next scheduled task, the queued count, a waiting approval, the agent's tool names with their declared risk, and its last recorded activity. An idle agent's note says its walks and breaks are decorative; a working agent's note says the state came from its assigned task and that a task is shown as running only while the task engine says RUNNING. The roster and the room panel use the same lifecycle labels and tones (`office-lifecycle-tone.ts`).

**Name tags and the floor (VO-3.1 audit, 2026-11-15).** Measured in the running app, the first VO-3.1 floor drew every tag at one fixed offset under its figure, so neighbours' names ran into each other and into the room's wall, a hallway walker's tag landed on the sign below, JARVIS's tag and queue markers were drawn through its room's wall, the empty-room note was written across the meeting table, a room close-up cut the hallway (and anyone in it) in half, and the zoom controls lay over the floor's corner. `pixel/tag-layout.ts` now places every tag in one pure pass: it tries under, a second row, beside and above; keeps a tag inside the space its figure is in (decided from the figure's whole height, so a figure in a doorway gets the room and the hallway together); never over another tag, another figure, a sign or JARVIS; and, while the figure is in view, inside the view. Seated tags never move for a passer-by; a walker's yields. Tags are drawn on a plate at the width the layout measured (`textLength`). A walker whose tag has nowhere clean to go carries none for that moment; its name is still its title and accessible label. `roomViewport` includes the hallway its door opens onto. In the expanded view the zoom controls are a strip under the floor's own box, not a layer over it.

**Ambient occupancy (VO-3.1.1).** Every break place has distinct spots (`AmbientPlace.spots` in `pixel/floor-plan.ts`): two at the coffee machine, the water cooler, the sofa and each hallway stroll point, one on each side of the lunch table, one at the washroom and one each at the meeting table. No two spots anywhere overlap. `allocateSpots` (`pixel/ambient.ts`) hands them out in arrival order — earlier start, then agent id — and a spot is held for its holder's whole slot, walking included, and free again for any slot that starts at or after its end. A full place sends the agent to an alternative of the same kind (the other side of the lunch table, another stroll point) or, when there is none, keeps it at its desk. To stay a pure, bounded function of time the allocation is made per 30-minute epoch (`OCCUPANCY_EPOCH_MS`), and a break that would cross into the next epoch is spent at the desk. `ambientSlotAt` says where (`at`) and, for a break spent at the desk, why (`yielded`: `conversation`, `boundary` or `full`). Real work still wins at once, from whichever spot the figure stood at. Occupancy reads and writes nothing.

**Nothing is cut at the edge (VO-3.1.1).** A close-up letterboxes its viewBox into the floor's box, so neighbouring rooms show at the sides. `useOfficeViewport` measures the box and reports `visible`, the scene area actually on screen. A figure is drawn only when everything it draws — selection ring, state glyph, speech bubble (`FIGURE_EXTENT`) — fits inside it, where it is now and where its walk takes it by the next tick; otherwise it is not drawn at all (`display: none`, `data-offview`) and reappears once it fits. JARVIS follows the same rule. A drawn figure's tag must fit the visible area before any other rule is considered. With no viewport (the widget) and in the whole office nothing is hidden.

**Tests.** `apps/web/test/office-vo31.test.tsx` pins the lifecycle parse, derive and overlay, the ambient engine's determinism and chat pairing, the interrupt/return/resume rules, the desk-bound typing gate, the model's task and tool attribution, and the panel's content. `packages/agents/test/task-assignment-vo31.test.ts` pins the chooser, `apps/api/test/office-agent-work-vo31.test.ts` the per-agent read, and `packages/db/test/task-agent-work-vo31-pg.integration.test.ts` the assignment columns (database-backed). `apps/web/test/office-tags-vo31.test.tsx` pins the tag layout, the room close-up, the zoom strip and the edge rule; `apps/web/test/office-ambient-occupancy-vo311.test.tsx` the spots, the allocator, six hours of real schedules with no two figures on one spot, every reason a break is spent at the desk, and the interruption from a second spot.

**Live WORKING and USING_TOOL (VO-3.1.1, 2026-11-15).** Seen in the browser from real executions on a throwaway database. The office stream flushes task events every 500 ms and keeps the newest per task (`use-office-stream.ts`), so a run is painted as RUNNING only when its start and its finish reach the page in different flushes. A run of a few milliseconds usually is not, and that is the truth, not a gap: the task's durable rows and its events are the record. `task.create` (LOW_IMPACT, internal) ran 80 times, 7–39 ms each; the browser received 80 RUNNING frames and painted "Using task.create" once. `data.csv.analyze` — on the Analytics Agent's policy but not registered in that process, so its risk is unknown — ran 4 times, 8–11 ms each, before the executor refused it ("Tool not found"); the browser painted "Working on a task" twice. Since VO-3.1 a claim always records its tool, so a run of a registered tool can never show "Working"; it is reached only by a tool with no declared risk.

## The rules

**A window.** The page's only controls select an actor, clear the selection and refresh. `office:subscribe` and `office:unsubscribe` are `READ_ONLY` in `SOCKET_EVENT_POLICY`, take no parameters and start no work. Tool execution and approval decisions stay `FORBIDDEN` over the socket.

**An allowlist, built in core.** `officeActivityEvent` and `officeTaskEvent` (`packages/core/src/office-stream.ts`) are the only way an audit row or a task row becomes an event. Each is built field by field: no title, description, error, parameters or `createdBy`; from an audit row's metadata only `executionId` and `durationMs`. The browser rebuilds every received event through `parseOfficeStreamEvent` and drops anything else. An activity event carries exactly the fields `GET /activity` returns, so the stream shows nothing that read does not.

**One owner, one audience.** An event carries no user id. The bus publishes to the row's owner, and the socket layer delivers only to that owner's sockets that subscribed, re-checking the identity the server resolved at the handshake. A payload cannot name another user (`SOCKET_IDENTITY_OVERRIDE`).

**After the write, never before.** The `AuditLogger` observer runs only after the durable row is stored, and `TaskService` announces a task only after its write succeeded. Neither can fail the write. The container installs them as `officeAuditObserver` and `officeTaskObserver` (`apps/api/src/services/office-events.ts`).

**No history, no replay.** Events go to whoever is subscribed at that moment. After any reconnect the page re-reads its three sources; missed events are recovered from the durable rows.

**Claims follow facts.** An agent is never shown as working, paused or with a percentage: there is no durable start row for a conversational turn and a task records no agent. JARVIS is "working" only while a task is `RUNNING`. An audit row is attributed to an agent only when it names a registered one. Since VO-2.1 the running, queued and completed counts are the server's totals, not the length of the capped list; when an API sends no totals, the page counts the listed rows and says so.

**A session ends with its token (VO-2.1).** A socket is verified once, at its handshake. The server records the token's expiry (`verifyAccessToken` returns `expiresAt`) and disconnects the socket at that instant; a socket whose token states no expiry is ended after `SOCKET_MAX_SESSION_MS` (15 minutes). A token already past its expiry is refused at the handshake. Every stream on the socket stops on that disconnect.

**The client renews (VO-2.1).** Both live streams (office and system metrics) open their socket through `openAuthenticatedSocket` (`apps/web/src/lib/authenticated-socket.ts`). It reads the access token for every connection attempt. When the server refuses the credential or ends the session, it first presents a newer token if the page already holds one (the HTTP client usually refreshed at the same expiry); otherwise it refreshes through `refreshAccessToken` — the same single-flight refresh the HTTP client uses, so a socket and a burst of `401`s rotate the refresh cookie once — and connects again. A failed refresh is "Not signed in"; a throttled handshake is not retried by itself; refusals of fresh tokens stop after `MAX_SOCKET_AUTH_RENEWALS` (3) in a row and report "Offline". The page's **Refresh** re-reads everything and calls `reconnect()`, so "Offline" is never a state only a page reload can leave.

## VO-2.1 hardening (2026-11-12)

From the post-merge audit of VO-1 and VO-2 (`main` at `82e6d71`). The scope was approved by the owner as listed below.

| Finding | What changed | Where |
|---|---|---|
| **M2** — Running and Queued were counted over `GET /tasks`, capped at 50 rows with completed ones included, so they undercounted past the cap | `PrismaTaskRepository.countByStatus` (one `GROUP BY status`, every state present, owner filter unconditional, creator filter narrows); `TaskService.countTasks` (JARVIS work only); `GET /api/v1/tasks` returns `statusCounts` beside the list, independent of the cap and of `?status=`. The page validates the totals (`parseTaskStatusCounts`, all or nothing), applies live moves of listed tasks (`overlayTaskCounts`), and says when it could only count listed rows | `packages/db/src/repositories/task-repository.ts`, `apps/api/src/services/tasks/task-service.ts`, `apps/api/src/routes/tasks.ts`, `apps/web/src/components/office/office-model.ts`, `apps/web/src/app/office/page.tsx` |
| **M1** — a socket's authorization outlived its token | `VerifiedAccessToken.expiresAt` from the verified JWT; the handshake records it and refuses one already past; the connection is disconnected at that instant (`socket_session_expired`), re-armed past `setTimeout`'s ceiling, cleared on disconnect | `packages/core/src/types/auth.ts`, `packages/security/src/tokens.ts`, `apps/api/src/socket/socket-auth.ts` |
| **H1** — after 15 minutes a dropped office stream could not come back | `openAuthenticatedSocket` (token per attempt, renew, bounded retries, `reconnect()`); `useOfficeStream` uses it and exposes `reconnect`; Refresh calls it | `apps/web/src/lib/authenticated-socket.ts`, `apps/web/src/lib/use-office-stream.ts`, `apps/web/src/lib/api.ts` (`refreshAccessToken`) |
| **D1** — the system metrics stream had the same defect | `useSystemStream` opens its socket through the same helper; "reconnecting" reads as "connecting" in that widget's vocabulary | `apps/web/src/lib/use-system-stream.ts` |
| **M4** — no test drove a real Socket.IO server | `office-stream-e2e-vo21`: real HTTP server on loopback, real Socket.IO server and client, real JWTs, `secureSocketServer` then `installOfficeStream`, and the container's own observers behind a real `AuditLogger` and `TaskService`. It also pins, against the real client library, that a refused or server-ended session is not reconnected by socket.io-client itself and that `connect()` reads the `auth` callback again. `socket.io-client` is now a dev dependency of `@jarvis/api` (the version `apps/web` already locks, 4.8.3) | `apps/api/test/office-stream-e2e-vo21.test.ts`, `apps/api/package.json`, `pnpm-lock.yaml` |

### Tests added

| File | Pins |
|---|---|
| `packages/db/test/task-status-counts-vo21-pg.integration.test.ts` | The `GROUP BY` against PostgreSQL: past the list cap, owner only, creator narrows (a NULL creator is not JARVIS), zeros for absent states, out-of-lifecycle values counted nowhere |
| `apps/api/test/task-status-counts-vo21.test.ts` | `countTasks` asks for JARVIS work only; `statusCounts` beside a capped list; a status filter narrows the list, never the totals; a refused request counts nothing |
| `apps/api/test/socket-session-expiry-vo21.test.ts` | Expiry recorded at the handshake, an expired token refused, disconnect at expiry and not before, the 15-minute bound, no timer left behind, no `setTimeout` overflow, identifiers only in the log line |
| `packages/security/test/token-expiry-vo21.test.ts` | `verifyAccessToken` reports the signed `exp`; an expired or foreign token is still refused |
| `apps/api/test/office-stream-e2e-vo21.test.ts` | See M4 above |
| `apps/web/test/authenticated-socket-vo21.test.ts` | Every branch of the client helper |
| `apps/web/test/system-stream-vo21.test.tsx` | The system stream renews and subscribes again |
| `apps/web/test/office-model.test.ts`, `office-page.test.tsx`, `office-stream.test.tsx` | Added cases for totals, the counts note, malformed totals, live moves, Refresh reconnecting, and the hook's renewal |

`apps/api/test/helpers/count-task-rows.ts` is the in-memory twin of `countByStatus` that the task tests' fake stores share.

### Evidence (2026-11-12, Windows, from the working tree, not committed)

Every turbo run used `--force`, so no result is a cache replay.

| Check | Command | Result |
|---|---|---|
| Build | `pnpm build --force` | 22/22 tasks |
| Typecheck | `pnpm typecheck --force` | 40/40 |
| Test typecheck | `pnpm typecheck:tests --force` | 23/23 |
| Lint | `pnpm lint --force` | 22/22 |
| Web, again after the last change (the client presents a token it already holds before refreshing) | `pnpm exec turbo run <build\|typecheck\|lint\|test> --filter=@jarvis/web --force`, one at a time | build 2/2, typecheck 2/2, lint 1/1, tests 991/991 (48 files) |
| Full suite, no database | `pnpm exec turbo run test --concurrency=1 --continue --force` | 22 workspaces: **11,676 passed, 2 failed, 792 skipped**. The 2 failures are the MCP timing tests below, not regressions. The skips are the database suites, which ran separately |
| Database, CI's steps | a throwaway `pgvector/pgvector:pg16@sha256:ccc6e83d…` (CI's digest) on `127.0.0.1:55433` with its own named volume, removed afterwards; `prisma migrate deploy`, then CI's four steps with `JARVIS_REQUIRE_POSTGRES=1` and `assert-no-skipped-tests.mjs` | 38 migrations applied. `@jarvis/db` 478/478 (34 files, the six VO-2.1 tests among them), `@jarvis/memory` 93/93, `@jarvis/api` 319/319, quality evaluation 13/13, **0 not run** |
| Mutation | a scratch vitest config that rewrites one guard in memory per run; no file changed | **13/13 caught**: 6 in the API (no session end, an expired token accepted, the audit wiring dropped, counts over every creator, delivery to any audience, the route counting from the list) and 7 in the web (the token read once, no renewal after a server-ended session, no give-up limit, counts from the list, negative totals accepted, Refresh not reconnecting, always rotating the cookie). The unmutated controls passed 47/47 and 98/98 |

The repo-wide build, typecheck, test-typecheck and lint ran before that last change, which touched only `apps/web`; the web gates were then run again. The full suite and the database steps ran on the final code.

### MCP timeout tests: environment timing, not a regression

Three MCP tests start a real Node child process and allow it 500 ms. On this Windows machine that process often takes longer, so they fail on code VO-2.1 never touched:

| Test | Failure |
|---|---|
| `apps/api/test/mcp-integration-s8.test.ts` › "is ERROR — timed out — when a running server stops answering" | line 394, `expected 'ERROR' to be 'CONNECTED'`: the server did not connect within `connectTimeoutMs: 500`, before the timeout behaviour is even reached |
| `apps/api/test/mcp-pilot-failures-s8.test.ts` › "timeout: ToolExecutor's deadline ends the call and the stuck server is stopped" | line 203, `expected 'connecting' to be 'failed'`: the connection was still starting when the 500 ms deadline fired |
| `packages/mcp/test/verify-s8.test.ts` › "times out a server that stopped answering, and stops it" | failed once under full-suite load with `INITIALIZATION_FAILED` |

The same commands were run alone, five rounds each, alternating between this tree and a clean worktree of `f004eca` (before the Virtual Office), on an otherwise idle machine. `packages/mcp`, both API test files and `ToolExecutor` are byte-identical in the two trees.

| Test | VO-2.1 tree | Clean `f004eca` |
|---|---|---|
| `mcp-integration-s8` › timed out | 1 passed, 4 failed | 0 passed, 5 failed |
| `mcp-pilot-failures-s8` › ToolExecutor deadline | 1 passed, 4 failed | 0 passed, 5 failed |
| `verify-s8` › times out a stopped server | 5 passed | 5 passed |

Both trees fail on the same lines with the same messages. Failing runs end at about 520–530 ms; the rare passing run takes about 1,020 ms, because the server connected in time and the timeout path then ran. The one-in-five passes in this tree against none in the clean one are chance at that failure rate: the code under test is the same. These are the timing-sensitive tests already named in AGENTS.md's test record and in `docs/phases/phase-15.md` §15. Neither the MCP implementation nor these tests were changed to make them pass.

## Known limitations

- **"Waiting for approval" has a fallback, not a second source.** With the per-agent read (`GET /office/agent-work`) it comes from the Approval table and an unexpired request. When that read fails or an older API has no such route, the office falls back to the VO-1 audit heuristic: a `pending` audit row under two minutes old, because approve and reject rows carry no agent. An agent waiting longer then shows Idle.
- **Some audit rows never stream** (L1). Rows written straight to the database — `outcome.*`, `recommendation.*`, marketing settle decisions, the tenant-admin CLI — reach the office only on a re-read.
- **One API instance** (L2). The event bus lives in the API process and there is no Socket.IO adapter. A second instance would not deliver the first one's events. Compose runs one.
- **The office reads the newest 40 audit rows** (L3). "No activity recorded for this agent yet" can be untrue when its last row is older.
- **First load** (L4). An event committed between the first reads and the subscription is missed until the next re-read.
- **FAILED and UNRESOLVED tasks are not shown** (L5), though `statusCounts` now counts them.
- **A row naming an agent that is no longer registered** is shown as JARVIS system work (L6).
- **A renewal every 15 minutes.** Each open live feed's socket (the Virtual Office, or the dashboard's system widget) is ended when its token expires and connects again with a fresh one: the office shows "Reconnecting" for a moment and re-reads its sources, the system widget shows its data as delayed, and the API logs `socket_session_expired`.
- **Access tokens are not revocable**, on either transport. A logout revokes the refresh token; an access token, and since VO-2.1 a socket opened with it, lasts until its expiry, at most 15 minutes.
- **Deploy the API and the web app together**, and reload open dashboards afterwards: a page from an earlier release cannot renew its socket session ([DEPLOYMENT.md](./DEPLOYMENT.md), section 5).
- **Customise mode remounts every widget.** `WidgetFrame` wraps a widget in a different tree while customising, so toggling customise mode remounts the office (and every other widget): it re-reads its three sources and reconnects its feed. Older than VO-2.2, and harmless; not changed because it is shared dashboard code.
- **Signing in drops `?office=open`.** The auth gate sends an unauthenticated visitor to `/login` without the query, so a signed-out `/office` bookmark lands on the dashboard with the office closed.
- **Typing waits for the walk back (VO-3.1).** A task can be RUNNING while its agent is still walking to its desk from a break: the panel shows the real state at once, but the figure types only once it is seated. That is deliberate — a figure that typed from across the room would be a claim about where the work is happening.
- **The per-agent read is a separate request (VO-3.1).** If `GET /office/agent-work` is unavailable (an older API) or fails, the office keeps working from `/agents`, `/tasks` and `/activity` alone, as in VO-1: agents then show only the audit-derived states, with no current task, queued count, approvals or tool risk.
- **The widget preview letterboxes (Stage 2).** The office is 2:1; the default 8×5 cell is about 4:1, so the preview is drawn at the cell's height with corridor floor either side. At 1366×768 the rooms are small but legible; the expanded view is the place to read them.
- **One layout for every size (Stage 2).** Six rooms in a 3×2 block at every size; a wide one-row arrangement for very wide cells was considered and not built, because at the default cell it draws rooms at about the same size.
