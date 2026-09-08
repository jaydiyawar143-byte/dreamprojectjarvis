// ---------------------------------------------------------------------------
// V3 — the widget registry.
//
// Widgets are DATA, not markup. Adding one means appending an entry here; the
// grid, the ordering, the enable/disable toggles and the persisted preference
// all follow from that automatically.
//
// This is what makes the customisation the brief asked for a small later change
// rather than a rewrite: order and visibility are already expressed as a list of
// ids that round-trips through the preferences API. Drag-and-drop, when it is
// built, only has to reorder that list — nothing else has to know.
//
// `capability` is the honest gate. A widget whose backing provider this
// deployment cannot serve is not rendered at all, rather than rendered
// permanently reporting "unavailable".
// ---------------------------------------------------------------------------

import type { CommandCenterCapabilities } from "@/lib/api";

export type WidgetId = "clock" | "weather" | "system" | "tasks" | "markets" | "map";

export interface WidgetDefinition {
  id: WidgetId;
  label: string;
  /** Which server capability must be present. Omitted = always available. */
  capability?: keyof CommandCenterCapabilities;
  /** Relative width in the grid. Kept coarse on purpose. */
  span: "one" | "two";
  /**
   * Whether it is shown by default.
   *
   * The map is off by default: it is the only widget that does nothing until
   * you type into it, so a fresh dashboard would otherwise open with an empty
   * form occupying a slot.
   */
  defaultOn: boolean;
}

export const WIDGETS: WidgetDefinition[] = [
  { id: "clock", label: "Time", span: "one", defaultOn: true },
  { id: "weather", label: "Weather", capability: "weather", span: "one", defaultOn: true },
  { id: "system", label: "System", capability: "system", span: "one", defaultOn: true },
  { id: "tasks", label: "Tasks", capability: "tasks", span: "one", defaultOn: true },
  { id: "markets", label: "Markets", capability: "crypto", span: "one", defaultOn: true },
  { id: "map", label: "Location", capability: "geo", span: "one", defaultOn: false },
];

export const WIDGET_IDS: WidgetId[] = WIDGETS.map((w) => w.id);

export function isWidgetId(value: string): value is WidgetId {
  return (WIDGET_IDS as string[]).includes(value);
}

/**
 * Resolves what to render, from the registry plus the user's preference plus
 * what the server can actually serve.
 *
 * Order comes from `preferredOrder` when present, and unknown ids are dropped —
 * a preference written by an older build must not resurrect a widget that no
 * longer exists. Widgets missing from the preference are appended in registry
 * order, so a NEW widget appears for existing users instead of being invisible
 * because their saved list predates it.
 */
export function resolveWidgets(
  capabilities: CommandCenterCapabilities | null,
  preferredOrder?: string[],
  hidden?: string[]
): WidgetDefinition[] {
  const hiddenSet = new Set((hidden ?? []).filter(isWidgetId));

  const available = WIDGETS.filter((w) => {
    if (hiddenSet.has(w.id)) return false;
    if (!w.capability) return true;
    // Before capabilities load, assume yes: the widget renders its own loading
    // state, which is better than the grid visibly reflowing a moment later.
    if (!capabilities) return true;
    return capabilities[w.capability] === true;
  });

  const explicit = (preferredOrder ?? []).filter(isWidgetId);
  if (explicit.length === 0) {
    return available.filter((w) => w.defaultOn);
  }

  const ordered: WidgetDefinition[] = [];
  for (const id of explicit) {
    const found = available.find((w) => w.id === id);
    if (found && !ordered.includes(found)) ordered.push(found);
  }
  // Anything the stored preference has never heard of, in registry order.
  for (const w of available) {
    if (w.defaultOn && !explicit.includes(w.id) && !ordered.includes(w)) ordered.push(w);
  }
  return ordered;
}
