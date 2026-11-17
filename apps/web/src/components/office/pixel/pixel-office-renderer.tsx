"use client";

// ---------------------------------------------------------------------------
// VO-2.2 Stage 2 / VO-3.1 — the pixel-art renderer.
//
// One SVG, drawn in scene units and scaled by the browser with crisp edges,
// so the same office is the widget's preview and the expanded view's floor.
// Everything in it is a sprite from `sprites.ts` placed by `floor-plan.ts` and
// moved by `agent-motion.ts`; this file only paints.
//
// WHAT MOVES, AND WHY.
//   * Frame animation (breathing, typing, blinking) is CSS over pre-painted
//     frames: no timer and no React state ticks for it.
//   * Walking is a CSS transform transition between where a figure is and
//     where it will be one scene tick later (`use-office-motion.ts`). The
//     scene's single clock wakes only when something is due.
//   * Typing is drawn ONLY for a figure that is seated AND whose lifecycle comes
//     from a RUNNING task. A figure walking back to its desk is shown walking,
//     not working, whatever the server says.
//   * Ambient activity is drawn only for agents with no real state, and the
//     panel labels it decorative.
//   * Reduced motion: no walking, no ambient trips, no frame loops; figures sit
//     at their desks and the scene reports `data-motion="reduced"`.
//
// LAYERS, bottom to top: the corridor and hallway; each room (walls, floor,
// fixtures, the JARVIS core, seated figures, desks and front furniture); the
// walking layer (every figure not at its desk); the location hotspots; the
// signs. A figure's glyph, tag, bubble and selection ring move with it.
//
// It runs nothing, approves nothing and writes nothing.
// ---------------------------------------------------------------------------

import {
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SVGProps,
} from "react";

import type { DepartmentId, OfficeAgentActor } from "../office-model";
import { EXECUTING } from "../office-lifecycle";
import type { OfficeRendererProps } from "../office-renderer";
import {
  DOOR_W,
  DOOR_X,
  HALLWAY,
  LOCATION_HOTSPOTS,
  ROOMS,
  SCENE,
  SIGN_W,
  WALL_H,
  WC_DOOR_AT,
  MAX_QUEUE_MARKERS,
  agentVisual,
  placeAgents,
  roomActivity,
  roomAt,
  systemVisual,
  type AgentGlyph,
  type PlacedAgent,
  type Rect,
  type Room,
} from "./floor-plan";
import {
  CHARACTER_SIZE,
  GLYPH_ALERT,
  GLYPH_ASSIGNED,
  GLYPH_CHECK,
  GLYPH_QUEUED,
  GLYPH_RESEARCH,
  GLYPH_TOOL,
  GLYPH_WAIT,
  GLYPH_WORK,
  SCREEN_ACTIVITY,
  SCREEN_COLORS,
  SPEECH_BUBBLE,
  STEAM,
  WC_DOOR,
  characterSprite,
  coreSprite,
  deskSprite,
  lookForAgent,
  spritePaths,
  spriteSize,
  type CharacterPose,
  type PixelSprite,
} from "./sprites";
import { AMBIENT_LABEL } from "./ambient";
import { TAG_FONT_SIZE, figureFitsView, layoutTags, type TagPlacement } from "./tag-layout";
import type { FigureMotion } from "./use-office-motion";
import type { OfficeViewport } from "./use-office-viewport";

export interface PixelOfficeRendererProps extends OfficeRendererProps {
  /** A room to show close up; every other room is dimmed. */
  focusDepartment?: DepartmentId | null;
  /** When given, a room's sign (and a location hotspot) is a control that inspects the room. */
  onSelectDepartment?: (id: DepartmentId) => void;
  /** Pan and zoom, from `useOfficeViewport`. Without it the whole office is shown. */
  viewport?: OfficeViewport | null;
  reducedMotion?: boolean;
  /** The widget's small preview: name tags are dropped, signs stay. */
  compact?: boolean;
  /** Each figure's motion, from `useFigureMotion`. Without it everyone is at their desk. */
  motions?: ReadonlyMap<string, FigureMotion> | null;
}

// SCREEN_COLORS has no cyan standby tone of its own name; map the visual tones.
const SCREEN_TONE = {
  dim: SCREEN_COLORS.dim,
  ok: SCREEN_COLORS.ok,
  warn: SCREEN_COLORS.warn,
  danger: SCREEN_COLORS.danger,
  cyan: SCREEN_COLORS.cyan,
} as const;

const GLYPHS: Partial<Record<AgentGlyph, PixelSprite>> = {
  check: GLYPH_CHECK,
  wait: GLYPH_WAIT,
  alert: GLYPH_ALERT,
  queued: GLYPH_QUEUED,
  assigned: GLYPH_ASSIGNED,
  research: GLYPH_RESEARCH,
  tool: GLYPH_TOOL,
  work: GLYPH_WORK,
};

/**
 * Where "no agent stationed here" is written, room-relative: under the desk
 * row, above the furniture along the front of the room. At the foot of the
 * room it was written across the meeting table.
 */
export const EMPTY_NOTE_Y = 40;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Sprite({ sprite, x = 0, y = 0, className, flip = false }: { sprite: PixelSprite; x?: number; y?: number; className?: string; flip?: boolean }) {
  const { width } = spriteSize(sprite);
  const transform = flip ? `translate(${x + width} ${y}) scale(-1 1)` : `translate(${x} ${y})`;
  return (
    <g transform={transform} className={className}>
      {spritePaths(sprite).map((path) => (
        <path key={path.fill} d={path.d} fill={path.fill} />
      ))}
    </g>
  );
}

function activate(event: KeyboardEvent<SVGGElement>, action: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

/**
 * "Meta Ads Agent" → "Meta Ads", "Conversational Assistant" → "Conversational":
 * the tag under a figure is the name without its role suffix. The full name is
 * the figure's accessible label and title.
 */
export function tagFor(actor: Pick<OfficeAgentActor, "label">): string {
  const trimmed = actor.label.replace(/\s+(Agent|Assistant)$/i, "");
  return trimmed.length > 14 ? `${trimmed.slice(0, 13)}…` : trimmed;
}

/**
 * Moves its children with a CSS transform. On first paint it is placed where
 * the figure IS; every later render hands it where the figure will be one tick
 * on, with a transition that long — so walking is smooth and nothing jumps.
 */
function Mover({
  startPoint,
  endPoint,
  ms,
  children,
  ...rest
}: {
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  ms: number;
  children: ReactNode;
} & Omit<SVGProps<SVGGElement>, "ref" | "children">) {
  const ref = useRef<SVGGElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!placed.current) {
      placed.current = true;
      el.style.transition = "none";
      el.style.transform = `translate(${startPoint.x}px, ${startPoint.y}px)`;
      if (ms > 0) void el.getBoundingClientRect();
    }
    el.style.transition = ms > 0 ? `transform ${ms}ms linear` : "none";
    el.style.transform = `translate(${endPoint.x}px, ${endPoint.y}px)`;
  });

  return (
    <g ref={ref} data-x={Math.round(startPoint.x)} data-y={Math.round(startPoint.y)} {...rest}>
      {children}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------

/** The two frames a figure alternates between, and whether to mirror it (walking left). */
function framesFor(
  actor: OfficeAgentActor,
  motion: FigureMotion["now"] | null,
  seatedAtDesk: boolean
): { frames: [CharacterPose, CharacterPose]; flip: boolean; anim: string } {
  const phase = motion?.phase ?? "seated";
  if (phase === "walking" || phase === "returning") {
    const facing = motion!.facing;
    if (facing === "up") return { frames: ["walkUpA", "walkUpB"], flip: false, anim: "walk" };
    if (facing === "down") return { frames: ["walkDownA", "walkDownB"], flip: false, anim: "walk" };
    return { frames: ["walkSideA", "walkSideB"], flip: facing === "left", anim: "walk" };
  }
  if (phase === "away") {
    switch (motion!.ambient) {
      case "coffee":
        return { frames: ["cup", "cup"], flip: false, anim: "still" };
      case "lunch":
      case "sofa":
        return { frames: ["sit", "sitBreathe"], flip: false, anim: "idle" };
      default:
        return { frames: ["stand", "breathe"], flip: false, anim: "idle" };
    }
  }
  // At the workstation.
  if (seatedAtDesk && EXECUTING.has(actor.lifecycle)) {
    return { frames: ["typeA", "typeB"], flip: false, anim: "typing" };
  }
  if (motion?.ambient === "stretch") return { frames: ["stretch", "sit"], flip: false, anim: "idle" };
  const sit: CharacterPose = seatedAtDesk ? "sit" : "stand";
  const breathe: CharacterPose = seatedAtDesk ? "sitBreathe" : "breathe";
  return actor.lifecycle === "idle"
    ? { frames: [sit, breathe], flip: false, anim: "idle" }
    : { frames: [sit, sit], flip: false, anim: "still" };
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export function PixelOfficeRenderer({
  model,
  selectedActorId,
  onSelectActor,
  focusDepartment = null,
  onSelectDepartment,
  viewport = null,
  reducedMotion = false,
  compact = false,
  motions = null,
}: PixelOfficeRendererProps): ReactElement {
  const uid = useId().replace(/:/g, "");
  const placed = placeAgents(model);
  const box: Rect = viewport?.viewBox ?? SCENE;
  const interactive = viewport !== null;

  const select = (id: string) => {
    // A drag that ended on a figure is not a click on it.
    if (viewport?.consumeDrag()) return;
    onSelectActor(id);
  };

  const systemLook = systemVisual(model.system);
  const commandCenter = ROOMS[0]!;
  const core = commandCenter.core!;
  const coreLight = systemLook.animation === "idle" ? "#2b6f7a" : SCREEN_COLORS.cyan;

  const motionOf = (id: string): FigureMotion | null => motions?.get(id) ?? null;
  const atDesk = (entry: PlacedAgent): boolean => {
    const phase = motionOf(entry.actor.id)?.now.phase ?? "seated";
    return phase === "seated";
  };

  // Who is where among the decorative places, for the hotspots.
  const atPlace = new Map<string, string[]>();
  for (const entry of placed) {
    const m = motionOf(entry.actor.id)?.now;
    if (m && m.phase === "away" && m.place) {
      atPlace.set(m.place, [...(atPlace.get(m.place) ?? []), entry.actor.label]);
    }
  }

  // VO-3.1.1 — what is on screen. With a viewport (the expanded office) a
  // figure is drawn only when it fits inside the visible area, where it is now
  // AND where its walk takes it by the next tick, so the edge of a close-up
  // never cuts a figure, a glyph or a name in half. It reappears once it fits.
  const visibleArea = viewport?.visible ?? null;
  const offView = (entry: PlacedAgent): boolean => {
    if (!visibleArea) return false;
    const m = motionOf(entry.actor.id);
    const points = m ? [m.now.point, m.next.point] : [{ x: entry.x, y: entry.y }];
    return !points.every((point) => figureFitsView(point, visibleArea));
  };

  const figure = (entry: PlacedAgent, accent: string, seated: boolean, dimmed: boolean) => (
    <AgentFigure
      key={entry.actor.id}
      entry={entry}
      accent={accent}
      motion={motionOf(entry.actor.id)}
      seatedAtDesk={seated && entry.desk !== null}
      selected={selectedActorId === entry.actor.id}
      compact={compact}
      offView={offView(entry)}
      tag={tags?.get(entry.actor.id) ?? null}
      dimmed={dimmed}
      partnerPresent={(() => {
        const m = motionOf(entry.actor.id)?.now;
        if (!m || m.ambient !== "chat" || m.phase !== "away" || !m.partner) return false;
        const other = motionOf(m.partner)?.now;
        return other?.phase === "away" && other.ambient === "chat";
      })()}
      onSelect={() => select(entry.actor.id)}
    />
  );

  const walkers = placed.filter((entry) => !atDesk(entry));

  // Every name tag, placed in one pass so no tag covers another tag, a figure,
  // a sign or a wall, and none is cut off by the edge of the view. The widget's
  // preview draws no tags at all.
  const tags = compact
    ? null
    : layoutTags(
        placed
          .filter((entry) => !(motionOf(entry.actor.id)?.now.hidden ?? false) && !offView(entry))
          .map((entry) => {
            const now = motionOf(entry.actor.id)?.now ?? null;
            const phase = now?.phase ?? "seated";
            return {
              id: entry.actor.id,
              point: now?.point ?? { x: entry.x, y: entry.y },
              text: tagFor(entry.actor),
              seated: phase === "seated" && entry.desk !== null,
              moving: phase === "walking" || phase === "returning",
            };
          }),
        { view: visibleArea }
      );

  return (
    <svg
      ref={viewport?.svgRef}
      data-testid="office-floor-plan"
      data-motion={reducedMotion ? "reduced" : "full"}
      data-scale={viewport ? viewport.scale.toFixed(2) : "1.00"}
      data-focused-department={focusDepartment ?? undefined}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      preserveAspectRatio="xMidYMid meet"
      shapeRendering="crispEdges"
      className={`px-office ${interactive ? "px-office-interactive" : ""}`}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? "Office floor. Drag to pan; plus, minus and zero zoom; arrow keys pan." : undefined}
      style={{ touchAction: interactive ? "none" : "auto" }}
      {...(viewport ? viewport.handlers : {})}
    >
      <defs>
        {ROOMS.map((room) => (
          <pattern key={room.id} id={`${uid}-floor-${room.id}`} width="4" height="4" patternUnits="userSpaceOnUse">
            <rect width="4" height="4" fill={room.theme.floor} />
            <rect width="2" height="2" fill={room.theme.floorAlt} />
            <rect x="2" y="2" width="2" height="2" fill={room.theme.floorAlt} />
          </pattern>
        ))}
        <pattern id={`${uid}-corridor`} width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="#080d15" />
          <rect width="1" height="6" fill="#0b121c" />
          <rect width="6" height="1" fill="#0b121c" />
        </pattern>
        <pattern id={`${uid}-hall`} width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" fill="#0d141f" />
          <rect width="4" height="4" fill="#101927" />
          <rect x="4" y="4" width="4" height="4" fill="#101927" />
        </pattern>
      </defs>

      {/* The corridor runs far past the scene on every side: when the box is
          wider or taller than the scene, the letterbox shows more building. */}
      <rect
        data-testid="office-corridor"
        x={SCENE.x - SCENE.w * 4}
        y={SCENE.y - SCENE.h * 4}
        width={SCENE.w * 9}
        height={SCENE.h * 9}
        fill={`url(#${uid}-corridor)`}
        className="px-passive"
      />
      <rect x={SCENE.x + 1} y={SCENE.y + 1} width={SCENE.w - 2} height={SCENE.h - 2} fill="none" stroke="#14212f" strokeWidth={1} className="px-passive" />

      {/* The hallway between the rows, with a runner down its middle. */}
      <g className="px-passive" data-testid="office-hallway">
        <rect x={HALLWAY.x + 1} y={HALLWAY.y} width={HALLWAY.w - 2} height={HALLWAY.h} fill={`url(#${uid}-hall)`} />
        <rect x={HALLWAY.x + 4} y={HALLWAY.y + 7} width={HALLWAY.w - 22} height={4} fill="#1d3245" opacity={0.55} />
        <Sprite sprite={WC_DOOR} x={WC_DOOR_AT.x} y={WC_DOOR_AT.y} />
      </g>

      {ROOMS.map((room) => {
        const department = model.departments.find((candidate) => candidate.id === room.id)!;
        const activity = roomActivity(department, model.system);
        const dimmed = focusDepartment !== null && focusDepartment !== room.id;
        const focused = focusDepartment === room.id;
        const inRoom = placed.filter((entry) => entry.actor.department === room.id);
        const isCommandCenter = room.id === "command-center";
        const usedDesks = inRoom.filter((entry) => entry.desk).length;

        return (
          <g
            key={room.id}
            data-testid="office-department"
            data-department-id={room.id}
            data-live={activity.live ? "true" : "false"}
            data-active-count={activity.active}
            data-focused={focused ? "true" : undefined}
            data-dimmed={dimmed ? "true" : undefined}
            aria-label={room.label}
            opacity={dimmed ? 0.3 : 1}
          >
            <RoomShell room={room} uid={uid} />

            <g className="px-passive">
              {room.fixtures
                .filter((fixture) => !fixture.front)
                .map((fixture, index) => (
                  <Sprite key={index} sprite={fixture.sprite} x={room.x + fixture.x} y={room.y + fixture.y} />
                ))}
            </g>

            {isCommandCenter && (
              <CoreActor
                x={commandCenter.x + core.x}
                y={commandCenter.y + core.y}
                light={coreLight}
                animation={systemLook.animation}
                queueMarkers={systemLook.queueMarkers}
                stateLabel={model.system.stateLabel}
                selected={selectedActorId === model.system.id}
                onSelect={() => select(model.system.id)}
                view={visibleArea}
              />
            )}

            {/* Seated figures, then their desks over their legs. */}
            {inRoom.filter((entry) => atDesk(entry)).map((entry) => figure(entry, room.theme.accent, true, false))}

            <g className="px-passive">
              {inRoom.map((entry) => {
                if (!entry.desk) return null;
                const visual = agentVisual(entry.actor);
                const seatedHere = atDesk(entry);
                return (
                  <g key={`desk-${entry.actor.id}`}>
                    <Sprite sprite={deskSprite(SCREEN_TONE[visual.screen])} x={entry.desk.x} y={entry.desk.y} />
                    {visual.screenBusy && seatedHere && (
                      <g data-testid="office-screen-activity" className="px-screen-busy">
                        <Sprite sprite={SCREEN_ACTIVITY} x={entry.desk.x + 11} y={entry.desk.y + 1} />
                      </g>
                    )}
                  </g>
                );
              })}
              {room.desks.slice(usedDesks).map((desk, index) => (
                <Sprite key={`empty-desk-${index}`} sprite={deskSprite(SCREEN_COLORS.dim)} x={room.x + desk.x} y={room.y + desk.y} />
              ))}
              {room.fixtures
                .filter((fixture) => fixture.front)
                .map((fixture, index) => (
                  <Sprite key={`front-${index}`} sprite={fixture.sprite} x={room.x + fixture.x} y={room.y + fixture.y} />
                ))}
            </g>

            {inRoom.length === 0 && !isCommandCenter && room.desks.length > 0 && (
              <text
                data-testid="office-empty-desk"
                x={room.x + room.w / 2}
                y={room.y + EMPTY_NOTE_Y}
                textAnchor="middle"
                fontSize={3.5}
                fill="#8fa3b5"
                opacity={0.75}
                className="px-passive"
              >
                no agent stationed here
              </text>
            )}

            {/* The plaque belongs to its room, so inspecting the room's DOM
                node finds it. It is drawn last within the room so the room's
                own furniture never covers it; walkers use the walkway and the
                hallway below the wall band, so they never cross it. */}
            <RoomSign
              room={room}
              count={department.actors.length + (isCommandCenter ? 1 : 0)}
              live={activity.live}
              onInspect={onSelectDepartment ? () => onSelectDepartment(room.id) : undefined}
              consumeDrag={viewport ? viewport.consumeDrag : undefined}
            />
          </g>
        );
      })}

      {/* Everyone away from their desk: walking, on a break, or returning. */}
      <g data-testid="office-walking-layer">
        {walkers.map((entry) => {
          const home = ROOMS.find((candidate) => candidate.id === entry.actor.department)!;
          const point = motionOf(entry.actor.id)?.now.point;
          const here = point ? roomAt(point) : null;
          const dimmed = focusDepartment !== null && (here?.id ?? null) !== focusDepartment;
          return figure(entry, home.theme.accent, false, dimmed);
        })}
      </g>

      {/* The break facilities and the meeting table: who is there, and a way in. */}
      {LOCATION_HOTSPOTS.map((spot) => {
        const here = spot.places.flatMap((place) => atPlace.get(place) ?? []);
        const label =
          here.length === 0
            ? `${spot.label}: nobody here`
            : `${spot.label}: ${here.join(", ")} (decorative break)`;
        const inspect = onSelectDepartment
          ? () => {
              if (viewport?.consumeDrag()) return;
              onSelectDepartment(spot.room);
            }
          : null;
        return (
          <g
            key={spot.id}
            data-testid="office-hotspot"
            data-hotspot-id={spot.id}
            data-occupants={here.length}
            {...(inspect
              ? {
                  role: "button" as const,
                  tabIndex: 0,
                  "aria-label": label,
                  onClick: inspect,
                  onKeyDown: (event: KeyboardEvent<SVGGElement>) => activate(event, inspect),
                  className: "px-hotspot px-hotspot-interactive",
                }
              : { className: "px-hotspot px-passive", "aria-hidden": true })}
          >
            <title>{label}</title>
            <rect x={spot.rect.x} y={spot.rect.y} width={spot.rect.w} height={spot.rect.h} fill="transparent" />
            <rect className="px-hotspot-ring" x={spot.rect.x + 0.5} y={spot.rect.y + 0.5} width={spot.rect.w - 1} height={spot.rect.h - 1} fill="none" stroke="#c3d3e0" strokeWidth={0.5} strokeDasharray="1.5 1" />
          </g>
        );
      })}

      {/* Signs are part of their room's group (above), not a separate pass:
          `within(room)` must find a room's plaque. */}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function RoomShell({ room, uid }: { room: Room; uid: string }) {
  const doorX = room.x + DOOR_X;
  const doorY = room.row === "top" ? room.y + room.h - 1 : room.y;
  const doorH = room.row === "top" ? 1 : WALL_H;
  return (
    <g className="px-passive">
      {/* Walls, then the floor inside them. */}
      <rect x={room.x - 1} y={room.y - 1} width={room.w + 2} height={room.h + 2} fill="#03060b" />
      <rect x={room.x} y={room.y} width={room.w} height={room.h} fill={room.theme.wall} />
      <rect x={room.x + 1} y={room.y + WALL_H} width={room.w - 2} height={room.h - WALL_H - 1} fill={`url(#${uid}-floor-${room.id})`} />
      {/* The skirting under the wall band. */}
      <rect x={room.x + 1} y={room.y + WALL_H - 1} width={room.w - 2} height={1} fill="#03060b" opacity={0.6} />
      {/* The door, on the hallway side. */}
      <rect
        data-testid="office-door"
        x={doorX}
        y={doorY - (room.row === "top" ? 0 : 1)}
        width={DOOR_W}
        height={doorH + 1}
        fill={room.theme.floor}
      />
      <rect x={doorX - 1} y={doorY - (room.row === "top" ? 0 : 1)} width={1} height={doorH + 1} fill={room.theme.accent} opacity={0.5} />
      <rect x={doorX + DOOR_W} y={doorY - (room.row === "top" ? 0 : 1)} width={1} height={doorH + 1} fill={room.theme.accent} opacity={0.5} />
    </g>
  );
}

function RoomSign({
  room,
  count,
  live,
  onInspect,
  consumeDrag,
}: {
  room: Room;
  count: number;
  live: boolean;
  onInspect?: () => void;
  consumeDrag?: () => boolean;
}) {
  const inspect = () => {
    if (!onInspect) return;
    if (consumeDrag?.()) return;
    onInspect();
  };
  const interactiveProps = onInspect
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": `Inspect ${room.label}`,
        onClick: inspect,
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => activate(event, inspect),
        className: "px-sign px-sign-interactive",
      }
    : { className: "px-sign px-passive" };

  return (
    <g data-testid="office-department-sign" {...interactiveProps}>
      <rect x={room.x + 2} y={room.y + 1} width={SIGN_W} height={WALL_H - 3} fill="#03060b" opacity={0.78} />
      <rect className="px-sign-focus" x={room.x + 1.5} y={room.y + 0.5} width={SIGN_W + 1} height={WALL_H - 2} fill="none" stroke={room.theme.accent} strokeWidth={0.5} />
      <text x={room.x + 5} y={room.y + 6.3} fontSize={4.2} fill={room.theme.accent} letterSpacing={0.4}>
        {room.label.toUpperCase()}
      </text>
      <text x={room.x + SIGN_W - 5} y={room.y + 6.3} fontSize={3.6} fill="#8fa3b5" textAnchor="end">
        {count}
      </text>
      {/* The door light: steady when the room is quiet, blinking while anything in it is not idle. */}
      <rect
        data-testid="office-department-light"
        x={room.x + SIGN_W - 2}
        y={room.y + 3}
        width={2}
        height={2}
        fill={live ? room.theme.accent : "#2a3441"}
        className={live ? "px-led" : undefined}
      />
    </g>
  );
}

function AgentFigure({
  entry,
  accent,
  motion,
  seatedAtDesk,
  selected,
  compact,
  offView,
  tag,
  dimmed,
  partnerPresent,
  onSelect,
}: {
  entry: PlacedAgent;
  accent: string;
  motion: FigureMotion | null;
  seatedAtDesk: boolean;
  selected: boolean;
  compact: boolean;
  /**
   * VO-3.1.1 — the figure does not fit inside the visible area, so it is not
   * drawn at all (`display: none`: the frame animations set `visibility` on
   * their own, which a hidden parent could not overrule).
   */
  offView: boolean;
  /** Where the name tag goes, from `layoutTags`. Null: no tag (the widget, or behind a door). */
  tag: TagPlacement | null;
  dimmed: boolean;
  partnerPresent: boolean;
  onSelect: () => void;
}) {
  const { actor } = entry;
  const look = lookForAgent(actor.id);
  const visual = agentVisual(actor);
  const now = motion?.now ?? null;
  const phase = now?.phase ?? "seated";
  const { frames, flip, anim } = framesFor(actor, now, seatedAtDesk);
  const at = now?.point ?? { x: entry.x, y: entry.y };
  const to = motion?.next.point ?? at;
  const glyph = visual.glyph === "none" ? null : GLYPHS[visual.glyph] ?? null;
  const ambient = actor.lifecycle === "idle" ? now?.ambient ?? null : null;
  const hidden = now?.hidden ?? false;
  const motionLabel =
    phase === "returning"
      ? "returning to desk"
      : ambient && ambient !== "desk"
        ? `${AMBIENT_LABEL[ambient].toLowerCase()} (decorative)`
        : null;

  return (
    <Mover
      startPoint={at}
      endPoint={to}
      ms={motion?.transitionMs ?? 0}
      data-testid="office-actor"
      data-agent-id={actor.id}
      data-department-id={actor.department}
      data-state={actor.state}
      data-lifecycle={actor.lifecycle}
      data-decorative={actor.decorative ? "true" : "false"}
      data-animation={anim}
      data-phase={phase}
      data-ambient={ambient ?? undefined}
      data-glyph={visual.glyph}
      data-hidden={hidden ? "true" : undefined}
      data-offview={offView ? "true" : undefined}
      display={offView ? "none" : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${actor.label}, ${actor.lifecycleLabel}${motionLabel ? `, ${motionLabel}` : ""}`}
      className={`px-actor px-anim-${anim}`}
      opacity={hidden ? 0 : dimmed ? 0.3 : 1}
      onClick={onSelect}
      onKeyDown={(event: KeyboardEvent<SVGGElement>) => activate(event, onSelect)}
    >
      <title>{`${actor.label} — ${actor.lifecycleLabel}${motionLabel ? ` (${motionLabel})` : ""}`}</title>
      <desc data-testid="office-actor-name">{actor.label}</desc>
      <desc data-testid="office-actor-state">{actor.lifecycleLabel}</desc>
      {/* The hit area, so a click between pixels still lands. */}
      <rect x={-1} y={-2} width={CHARACTER_SIZE.width + 2} height={CHARACTER_SIZE.height + 3} fill="transparent" />
      <rect className="px-focus-ring" x={-1.5} y={-2.5} width={CHARACTER_SIZE.width + 3} height={CHARACTER_SIZE.height + 4} fill="none" stroke="#3ee0f2" strokeWidth={0.6} />
      {actor.decorative && phase !== "walking" && (
        <ellipse data-testid="office-idle-pulse" className="px-idle-pulse" cx={CHARACTER_SIZE.width / 2} cy={CHARACTER_SIZE.height} rx={5} ry={1.4} fill={accent} opacity={0.3} />
      )}
      <g className="px-frame px-f0">
        <Sprite sprite={characterSprite(look, accent, frames[0])} flip={flip} />
      </g>
      <g className="px-frame px-f1">
        <Sprite sprite={characterSprite(look, accent, frames[1])} flip={flip} />
      </g>
      {ambient === "coffee" && phase === "away" && (
        <g data-testid="office-steam" className="px-steam">
          <Sprite sprite={STEAM} x={8} y={6} />
        </g>
      )}
      {ambient === "chat" && phase === "away" && partnerPresent && (
        <g data-testid="office-speech" className="px-speech">
          <Sprite sprite={SPEECH_BUBBLE} x={1} y={-9} />
        </g>
      )}
      {selected && (
        <rect data-testid="office-actor-selection" className="px-selection" x={-2} y={-3} width={CHARACTER_SIZE.width + 4} height={CHARACTER_SIZE.height + 5} fill="none" stroke="#3ee0f2" strokeWidth={0.8} />
      )}
      {glyph && (
        <g
          // A new completion replays the pop; the same one does not.
          key={visual.completion ? actor.currentTask?.finishedAt ?? actor.lastActivityAt ?? "done" : visual.glyph}
          data-testid="office-actor-glyph"
          data-glyph={visual.glyph}
          transform={`translate(${CHARACTER_SIZE.width - 2} -4)`}
        >
          {/* The animation is on an inner group: a CSS transform on the same
              element would override the translate above and snap the glyph to
              the figure's origin for the length of the pop. */}
          <g className={`px-glyph px-glyph-${visual.glyph} ${visual.completion ? "px-pop" : ""}`}>
            <Sprite sprite={glyph} />
          </g>
        </g>
      )}
      {/* A figure away from its desk whose tag has nowhere clean to go — half a
          second in a doorway, beside a sign, several agents crowding the
          break room (VO-3.1.1) — carries none until it does: its name is still
          its title and its accessible label. A seated tag always has a clean
          place (office-tags-vo31) and is always drawn. */}
      {!compact && tag && tag.inView && (tag.clear || phase === "seated") && (
        <g data-testid="office-actor-tag" data-tag-side={tag.side} data-tag-clear={tag.clear ? "true" : "false"}>
          {/* The plate keeps the name readable over whatever floor or furniture is behind it. */}
          <rect
            data-testid="office-actor-tag-plate"
            x={tag.plate.x}
            y={tag.plate.y}
            width={tag.plate.w}
            height={tag.plate.h}
            fill="#03060b"
            opacity={0.72}
          />
          {/* Drawn at exactly the width the layout measured, whatever the font. */}
          <text
            className="px-name"
            x={tag.x}
            y={tag.y}
            textAnchor="middle"
            fontSize={TAG_FONT_SIZE}
            textLength={tag.width}
            lengthAdjust="spacingAndGlyphs"
            fill={selected ? "#e9f6ff" : "#c3d3e0"}
          >
            {tagFor(actor)}
          </text>
        </g>
      )}
      {compact && selected && <rect x={-2} y={CHARACTER_SIZE.height + 1} width={CHARACTER_SIZE.width + 4} height={1} fill={accent} />}
    </Mover>
  );
}

function CoreActor({
  x,
  y,
  light,
  animation,
  queueMarkers,
  stateLabel,
  selected,
  onSelect,
  view,
}: {
  x: number;
  y: number;
  light: string;
  animation: "idle" | "queued" | "working";
  queueMarkers: number;
  stateLabel: string;
  selected: boolean;
  onSelect: () => void;
  /** VO-3.1.1 — the visible area; JARVIS is drawn only when all of it fits. */
  view: Rect | null;
}) {
  const frames = [0, 1, 2].map((frame) => coreSprite(frame, light));
  const size = spriteSize(frames[0]!);
  // Its focus ring, its name above the column and the widest row of queue markers.
  const extent = { x: x - 3.5, y: y - 5, w: size.width + 1 + MAX_QUEUE_MARKERS * 3 + 3.5, h: size.height + 9 };
  const offView =
    view !== null &&
    !(extent.x >= view.x && extent.y >= view.y && extent.x + extent.w <= view.x + view.w && extent.y + extent.h <= view.y + view.h);

  return (
    <g
      data-testid="office-system-actor"
      data-state={animation}
      data-queue-markers={queueMarkers}
      data-offview={offView ? "true" : undefined}
      display={offView ? "none" : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`JARVIS, ${stateLabel}`}
      transform={`translate(${x} ${y})`}
      className={`px-core px-core-${animation}`}
      onClick={onSelect}
      onKeyDown={(event) => activate(event, onSelect)}
    >
      <title>{`JARVIS — ${stateLabel}`}</title>
      <desc data-testid="office-system-actor-state">{stateLabel}</desc>
      <rect x={-3} y={-3} width={size.width + 6} height={size.height + 8} fill="transparent" />
      <rect className="px-focus-ring" x={-3} y={-3} width={size.width + 6} height={size.height + 7} fill="none" stroke="#3ee0f2" strokeWidth={0.6} />
      {selected && (
        <rect data-testid="office-actor-selection" className="px-selection" x={-3.5} y={-3.5} width={size.width + 7} height={size.height + 8} fill="none" stroke="#3ee0f2" strokeWidth={0.8} />
      )}
      <ellipse className="px-core-glow" cx={size.width / 2} cy={size.height - 2} rx={9} ry={3.5} fill={light} opacity={animation === "idle" ? 0.12 : 0.3} />
      {frames.map((frame, index) => (
        <g key={index} className={`px-frame px-f${index}`}>
          <Sprite sprite={frame} />
        </g>
      ))}
      {/* Queue markers: one amber block per pending task, capped. Only drawn from a real count. */}
      {/* Beside the pedestal, not under it: under it they were drawn through the room's wall. */}
      {Array.from({ length: queueMarkers }, (_, index) => (
        <rect key={index} data-testid="office-queue-marker" x={size.width + 1 + index * 3} y={size.height - 4} width={2} height={2} fill="#f5b74a" />
      ))}
      {/* Above the column, inside the room: under the pedestal it sat in the hallway. */}
      <text x={size.width / 2} y={-1.6} textAnchor="middle" fontSize={3.2} fill="#7ceaf7" stroke="#03060b" strokeWidth={0.6} paintOrder="stroke">
        JARVIS
      </text>
    </g>
  );
}
