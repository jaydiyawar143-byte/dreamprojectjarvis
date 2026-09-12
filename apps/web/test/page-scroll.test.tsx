// ---------------------------------------------------------------------------
// No page-level scrollbar.
//
// THE BUG. The chat route put a vertical scrollbar on the DOCUMENT. The cause
// was not a missing `overflow` rule — `message-list` already had
// `overflow-y-auto`. It was the flexbox default `min-height: auto`: a flex
// child with `flex-1` refuses to shrink below its content, so the list grew
// instead of scrolling, pushed its `h-screen` ancestors past the viewport, and
// the overflow rule never engaged.
//
// So these tests assert the pairing — `overflow-y-auto` together with
// `min-h-0` — rather than either alone. Asserting only the overflow class would
// have passed on the broken code.
//
// They are source assertions because jsdom does no layout: `offsetHeight` is
// always 0 and `scrollHeight` never exceeds it, so a rendered-DOM test cannot
// observe a scrollbar. What CAN be pinned precisely is the class contract that
// produces one, and that is where the defect actually lived.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source with comments stripped.
 *
 * Necessary because these files now CARRY explanatory comments naming the very
 * classes under test ("`min-h-screen` let this grow past the viewport"). An
 * assertion that the source does not contain `min-h-screen` would otherwise
 * fail on the comment explaining why it was removed — a test failing on its own
 * documentation.
 */
const read = (relative: string) => {
  const raw = readFileSync(join(process.cwd(), relative), "utf-8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments, incl. JSX {/* */} bodies
    .replace(/^\s*\/\/.*$/gm, " "); // whole-line // comments
};

const LAYOUT = read("src/app/layout.tsx");
const GLOBALS = read("src/app/globals.css");
const CHAT_PAGE = read("src/app/chat/page.tsx");
const CHAT_AREA = read("src/components/chat-area.tsx");
const MESSAGE_LIST = read("src/components/message-list.tsx");
const SIDEBAR = read("src/components/sidebar.tsx");
const SHELL = read("src/components/dashboard/dashboard-shell.tsx");

/**
 * The class list of the element whose `className` contains `marker`.
 *
 * Scans every className attribute rather than walking backwards from the
 * marker, because a backwards walk lands on whichever attribute happened to
 * come earlier in the file and silently asserts against the wrong element.
 */
function hasElementWithAll(source: string, required: string[]): boolean {
  const attributes = [
    ...source.matchAll(/className="([^"]*)"/g),
    ...source.matchAll(/className=\{`([^`]*)`\}/g),
  ].map((m) => (m[1] ?? "").split(/\s+/));

  return attributes.some((classes) => required.every((r) => classes.includes(r)));
}

function classesNear(source: string, marker: string): Set<string> {
  const attributes = [
    ...source.matchAll(/className="([^"]*)"/g),
    ...source.matchAll(/className=\{`([^`]*)`\}/g),
  ].map((m) => m[1] ?? "");

  const owning = attributes.find((value) => value.split(/\s+/).includes(marker));
  return new Set((owning ?? "").split(/\s+/).filter(Boolean));
}

// ---------------------------------------------------------------------------

describe("the document itself does not scroll", () => {
  it("pins html and body to the viewport with overflow hidden", () => {
    expect(GLOBALS).toMatch(/html,\s*body\s*\{[^}]*height:\s*100%/);
    expect(GLOBALS).toMatch(/html,\s*body\s*\{[^}]*overflow:\s*hidden/);
  });

  it("gives html and body a real height in the layout", () => {
    // `overflow: hidden` without a height would clip instead of containing:
    // a child asking for 100% would resolve against `auto` and collapse.
    expect(LAYOUT).toMatch(/<html[^>]*className=\{`dark h-full/);
    expect(LAYOUT).toMatch(/<body className="h-full overflow-hidden/);
  });

  it("keeps the horizontal guard that already existed", () => {
    expect(GLOBALS).toContain("max-width: 100%");
  });
});

// ---------------------------------------------------------------------------

describe("the chat route is a fixed shell, not a growing document", () => {
  it("pins the chat page to the dynamic viewport height", () => {
    // `min-h-screen` was the bug: it permits growth. `dvh` rather than `vh` so
    // mobile browser chrome cannot push the composer off-screen.
    expect(CHAT_PAGE).toContain("h-[100dvh]");
    expect(CHAT_PAGE).not.toContain("min-h-screen");
  });

  it("contains overflow at the chat page root", () => {
    // Asserted as CO-OCCURRENCE on one element: the page has two `h-[100dvh]`
    // divs (a centred loading state and the real shell), and matching whichever
    // comes first would silently test the wrong one.
    expect(hasElementWithAll(CHAT_PAGE, ["h-[100dvh]", "overflow-hidden"])).toBe(true);
  });

  it("lets the chat column shrink instead of forcing the page taller", () => {
    const classes = classesNear(CHAT_AREA, "min-h-0");
    expect(classes).toContain("min-h-0");
    expect(classes).toContain("h-full");
    // `h-screen` on a child of an already-viewport-height parent is what
    // stacked two full viewports on top of each other.
    expect(CHAT_AREA).not.toContain("h-screen");
  });
});

// ---------------------------------------------------------------------------

describe("internal scrolling is preserved, not removed", () => {
  it("keeps the message list scrollable AND shrinkable", () => {
    // The pairing is the whole fix. `overflow-y-auto` alone was already there
    // and did nothing.
    const classes = classesNear(MESSAGE_LIST, "overflow-y-auto");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("min-h-0");
    expect(classes).toContain("flex-1");
  });

  it("keeps the conversation sidebar list scrollable AND shrinkable", () => {
    const classes = classesNear(SIDEBAR, "overflow-y-auto");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("min-h-0");
  });

  it("holds the sidebar to the viewport without letting it grow", () => {
    expect(SIDEBAR).toContain("h-full");
    expect(SIDEBAR).toContain("min-h-0");
    expect(SIDEBAR).not.toContain("h-screen");
  });
});

// ---------------------------------------------------------------------------

describe("long pages remain reachable", () => {
  it("makes the shell viewport-height on every route, not only the dashboard", () => {
    expect(SHELL).toContain("h-[100dvh]");
    // The old conditional is gone: with the document pinned, `min-h-screen`
    // would let content grow with nothing able to scroll it.
    expect(SHELL).not.toMatch(/fullscreen \? "h-\[100dvh\][^"]*" : "min-h-screen"/);
  });

  it("gives non-fullscreen routes an internal scroll region", () => {
    // THE critical companion to `overflow: hidden` on the body. Without this,
    // /integrations and /settings would simply clip and become unreachable.
    expect(SHELL).toContain('fullscreen ? "overflow-hidden" : "overflow-y-auto"');
  });

  it("keeps the dashboard itself contained, since it owns its own panes", () => {
    expect(SHELL).toContain('data-scroll={fullscreen ? "contained" : "internal"}');
  });

  it("lets the content column shrink so main can scroll", () => {
    expect(SHELL).toMatch(/flex min-w-0 flex-1 flex-col min-h-0/);
    expect(SHELL).toMatch(/min-h-0 flex-1 \$\{fullscreen/);
  });
});

// ---------------------------------------------------------------------------

describe("viewport independence", () => {
  // The layout is expressed entirely in viewport-relative units and flex
  // shrinking, so it holds at any size. These pin that no fixed pixel height
  // crept in at the sizes named in the report.
  const SIZES = [
    { label: "1280x720", w: 1280, h: 720 },
    { label: "1440x900", w: 1440, h: 900 },
    { label: "1920x1080", w: 1920, h: 1080 },
    { label: "mobile 390x844", w: 390, h: 844 },
  ];

  for (const size of SIZES) {
    it(`uses no fixed page height that would break at ${size.label}`, () => {
      for (const [name, source] of [
        ["chat page", CHAT_PAGE],
        ["chat area", CHAT_AREA],
        ["shell", SHELL],
      ] as const) {
        // A literal pixel height on a shell element is what stops a layout
        // adapting; every height here must be viewport- or flex-derived.
        expect(source, `${name} at ${size.label}`).not.toMatch(/\bh-\[\d+px\]/);
      }
    });
  }

  it("uses dvh rather than vh so mobile chrome does not clip the composer", () => {
    expect(CHAT_PAGE).toContain("dvh");
    expect(SHELL).toContain("dvh");
  });

  it("keeps the sidebar from being squeezed at narrow widths", () => {
    expect(SIDEBAR).toContain("shrink-0");
  });
});
