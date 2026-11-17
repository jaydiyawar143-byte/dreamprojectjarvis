// ---------------------------------------------------------------------------
// VO-2.2 Stage 2 — pixel art, as data.
//
// Every sprite in the office is a small matrix of characters: one character
// per pixel, `.` for transparent, every other character a key into the
// sprite's palette. A sprite is turned into SVG paths — ONE path per colour,
// built from the horizontal runs of that colour — so a 10×14 character is a
// handful of path elements rather than a hundred and forty rects. The paths
// are memoised per sprite object, so a frame that is painted for every agent
// on every render is computed once.
//
// This file is PURE: no React, no DOM, no clock. It defines what the office
// looks like, never what it claims; the claims come from `office-model.ts`,
// and `floor-plan.ts` is the only place a state is turned into a look.
//
// Characters are composed from parts — a head (hair style), a body, a frame
// pose — and recoloured through a palette per agent, so every registered
// agent gets a distinct, stable figure without a hand-drawn sprite each. A new
// agent the server registers tomorrow gets a figure from the same parts,
// chosen by a hash of its id, so it is never a blank.
// ---------------------------------------------------------------------------

export interface PixelSprite {
  /** Rows of equal width; `.` is transparent, anything else keys `palette`. */
  readonly rows: readonly string[];
  readonly palette: Readonly<Record<string, string>>;
}

export interface SpritePath {
  fill: string;
  d: string;
}

export interface SpriteSize {
  width: number;
  height: number;
}

export function spriteSize(sprite: PixelSprite): SpriteSize {
  return { width: sprite.rows[0]?.length ?? 0, height: sprite.rows.length };
}

const PATH_CACHE = new WeakMap<PixelSprite, SpritePath[]>();

/**
 * The SVG paths of a sprite: one `<path d>` per palette colour, each a union
 * of unit-high rectangles over that colour's horizontal runs.
 *
 * A character the palette does not name is painted with a loud magenta, so a
 * typo in a sprite is visible in the office rather than silently transparent.
 */
export function spritePaths(sprite: PixelSprite): SpritePath[] {
  const cached = PATH_CACHE.get(sprite);
  if (cached) return cached;

  const runs = new Map<string, string[]>();
  sprite.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const key = row[x]!;
      if (key === ".") {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === key) end += 1;
      const width = end - x;
      const fill = sprite.palette[key] ?? "#ff00ff";
      const list = runs.get(fill) ?? [];
      list.push(`M${x} ${y}h${width}v1h-${width}z`);
      runs.set(fill, list);
      x = end;
    }
  });

  const paths = [...runs.entries()].map(([fill, segments]) => ({ fill, d: segments.join("") }));
  PATH_CACHE.set(sprite, paths);
  return paths;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export type HairStyle = "short" | "long" | "spiky" | "cap";
export type Accessory = "none" | "glasses" | "headset";

/** What makes one agent's figure differ from another's. */
export interface CharacterLook {
  hair: HairStyle;
  hairColor: string;
  skin: string;
  accessory: Accessory;
}

/**
 * Every pose a figure has. `stand`/`breathe` are the idle pair; `sit` and the
 * two typing frames are for a desk; the walk pairs are by view (`side` faces
 * right and is mirrored for left by the renderer); `cup` and `stretch` are
 * decorative break poses.
 */
export type CharacterPose =
  | "stand"
  | "breathe"
  | "type"
  | "sit"
  | "typeA"
  | "typeB"
  | "walkDownA"
  | "walkDownB"
  | "walkUpA"
  | "walkUpB"
  | "walkSideA"
  | "walkSideB"
  | "cup"
  | "stretch"
  | "sitBreathe";

type HeadView = "front" | "back" | "side";

function viewOf(pose: CharacterPose): HeadView {
  if (pose === "walkUpA" || pose === "walkUpB") return "back";
  if (pose === "walkSideA" || pose === "walkSideB") return "side";
  return "front";
}

/** Palette keys a character sprite uses. Documented so a part is readable. */
//   H hair   S skin   E eye   O outfit   o outfit shade   L legs   B boots
//   A accessory (glasses, headset)   K cap   T trim (collar / badge)

const HEADS: Record<HairStyle, readonly string[]> = {
  short: [
    "...HHHH...",
    "..HHHHHH..",
    "..HSSSSH..",
  ],
  long: [
    "...HHHH...",
    "..HHHHHH..",
    ".HHSSSSHH.",
  ],
  spiky: [
    "..H.HH.H..",
    "..HHHHHH..",
    "..HSSSSH..",
  ],
  cap: [
    "..KKKKKK..",
    ".KKKKKKKK.",
    "..HSSSSH..",
  ],
};

/** Rows 3–5: the face. `long` hair continues down the sides. */
const FACE_PLAIN: readonly string[] = ["..SESSES..", "..SSSSSS..", "...SSSS..."];
const FACE_LONG: readonly string[] = [".HSESSESH.", ".HSSSSSSH.", "...SSSS..."];
const FACE_GLASSES: readonly string[] = ["..AEAAEA..", "..SSSSSS..", "...SSSS..."];
const FACE_GLASSES_LONG: readonly string[] = [".HAEAAEAH.", ".HSSSSSSH.", "...SSSS..."];
const FACE_HEADSET: readonly string[] = [".ASESSESA.", ".ASSSSSSA.", "...SSSS..."];

/** Rows 6–13: torso, arms, legs. Three poses. */
const BODY_STAND: readonly string[] = [
  "..OTOOTO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  ".o.OOOO.o.",
  "...LLLL...",
  "...LLLL...",
  "...LL.LL..",
  "...BB.BB..",
];
const BODY_BREATHE: readonly string[] = [
  "..........",
  "..OTOOTO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  ".o.LLLL.o.",
  "...LLLL...",
  "...LL.LL..",
  "...BB.BB..",
];
const BODY_TYPE: readonly string[] = [
  "..OTOOTO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  "..oSSSSo..",
  "...LLLL...",
  "...LLLL...",
  "...LL.LL..",
  "...BB.BB..",
];

/** Sitting: the legs are bent and mostly behind the desk front. */
const BODY_SIT: readonly string[] = [
  "..OTOOTO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  ".o.OOOO.o.",
  "..LLLLLL..",
  "..LL..LL..",
  "..BB..BB..",
  "..........",
];
/** Typing, two frames: the hands rise and fall over the keyboard. */
const BODY_TYPE_A: readonly string[] = [
  "..OTOOTO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  ".oOOOOOOo.",
  ".S.LLLL.S.",
  "..LL..LL..",
  "..BB..BB..",
  "..........",
];
const BODY_TYPE_B: readonly string[] = [
  "..OTOOTO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  ".SOOOOOOS.",
  "..LLLLLL..",
  "..LL..LL..",
  "..BB..BB..",
  "..........",
];
const BODY_WALK_DOWN_A: readonly string[] = [
  "..OTOOTO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  "...OOOO.o.",
  "...LLLL...",
  "...LL.LL..",
  "..LL...LL.",
  "..BB...BB.",
];
const BODY_WALK_DOWN_B: readonly string[] = [
  "..OTOOTO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  ".o.OOOO...",
  "...LLLL...",
  "...LL.LL..",
  "...LL.LL..",
  "...BB.BB..",
];
const BODY_WALK_UP_A: readonly string[] = [
  "..OOOOOO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  "...OOOO.o.",
  "...LLLL...",
  "...LL.LL..",
  "..LL...LL.",
  "..BB...BB.",
];
const BODY_WALK_UP_B: readonly string[] = [
  "..OOOOOO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  ".o.OOOO...",
  "...LLLL...",
  "...LL.LL..",
  "...LL.LL..",
  "...BB.BB..",
];
/** Profile, facing right. */
const BODY_WALK_SIDE_A: readonly string[] = [
  "...OTOO...",
  "..OOOOOO..",
  "..OOoOOO..",
  "...OoOO...",
  "...LLLL...",
  "..LL..LL..",
  ".LL....LL.",
  ".BB....BB.",
];
const BODY_WALK_SIDE_B: readonly string[] = [
  "...OTOO...",
  "..OOOOOO..",
  "..OOOOoO..",
  "...OOOo...",
  "...LLLL...",
  "...LLLL...",
  "....LL....",
  "...BBBB...",
];
/** Standing with a mug in the right hand (`c` is the mug). */
const BODY_CUP: readonly string[] = [
  "..OTOOTO..",
  ".OOOOOOOO.",
  ".oOOOOOOo.",
  ".o.OOOO.Sc",
  "...LLLL..c",
  "...LLLL...",
  "...LL.LL..",
  "...BB.BB..",
];
/** Arms up; the arms themselves are drawn over the head rows (see below). */
const BODY_STRETCH: readonly string[] = [
  "..OTOOTO..",
  "..OOOOOO..",
  "..OOOOOO..",
  "...OOOO...",
  "...LLLL...",
  "...LLLL...",
  "...LL.LL..",
  "...BB.BB..",
];

function faceRows(look: CharacterLook): readonly string[] {
  if (look.accessory === "headset") return FACE_HEADSET;
  if (look.accessory === "glasses") return look.hair === "long" ? FACE_GLASSES_LONG : FACE_GLASSES;
  return look.hair === "long" ? FACE_LONG : FACE_PLAIN;
}

/** The back of the head: hair over the face, the neck below. */
function backHeadRows(look: CharacterLook): readonly string[] {
  const top = look.hair === "cap" ? ["..KKKKKK..", ".KKKKKKKK."] : HEADS[look.hair].slice(0, 2);
  const wide = look.hair === "long";
  return [
    ...top,
    wide ? ".HHHHHHHH." : "..HHHHHH..",
    wide ? ".HHHHHHHH." : "..HHHHHH..",
    wide ? ".HHHHHHHH." : "..HHHHHH..",
    "...SSSS...",
  ];
}

/** Profile, facing right. */
function sideHeadRows(look: CharacterLook): readonly string[] {
  const top = look.hair === "cap" ? ["...KKKK...", "..KKKKKKK."] : ["...HHHH...", "..HHHHHH.."];
  const long = look.hair === "long";
  const eye = look.accessory === "glasses" ? "..HHSAEA.." : "..HHSSES..";
  return [
    ...top,
    long ? ".HHHHSSS.." : "..HHHSSS..",
    long ? `.${eye.slice(1)}` : eye,
    long ? ".HHSSSSSS." : "..HSSSSSS.",
    "...SSSS...",
  ];
}

/** Arms raised past the head for `stretch`: patched over the head rows. */
function raiseArms(rows: readonly string[]): string[] {
  return rows.map((row, y) => {
    if (y > 5) return row;
    const left = y === 0 ? "S" : "o";
    return `${left}${row.slice(1, 9)}${left}`;
  });
}

function bodyRows(pose: CharacterPose): readonly string[] {
  switch (pose) {
    case "breathe":
      return BODY_BREATHE;
    case "type":
      return BODY_TYPE;
    case "sit":
      return BODY_SIT;
    case "typeA":
      return BODY_TYPE_A;
    case "typeB":
      return BODY_TYPE_B;
    case "walkDownA":
      return BODY_WALK_DOWN_A;
    case "walkDownB":
      return BODY_WALK_DOWN_B;
    case "walkUpA":
      return BODY_WALK_UP_A;
    case "walkUpB":
      return BODY_WALK_UP_B;
    case "walkSideA":
      return BODY_WALK_SIDE_A;
    case "walkSideB":
      return BODY_WALK_SIDE_B;
    case "cup":
      return BODY_CUP;
    case "stretch":
      return BODY_STRETCH;
    default:
      return BODY_STAND;
  }
}

export const CHARACTER_SIZE: SpriteSize = { width: 10, height: 14 };

const CHARACTER_CACHE = new Map<string, PixelSprite>();

/**
 * A character frame. Memoised by its parts, so the same look in the same pose
 * is one sprite object everywhere — which is what makes `spritePaths` cheap.
 */
export function characterSprite(
  look: CharacterLook,
  outfit: string,
  pose: CharacterPose
): PixelSprite {
  const key = [look.hair, look.hairColor, look.skin, look.accessory, outfit, pose].join("|");
  const cached = CHARACTER_CACHE.get(key);
  if (cached) return cached;

  // A breathing frame drops the head one pixel: the top row is given up and
  // the body rows shift. Same height, so the figure never jumps.
  const view = viewOf(pose);
  const upper =
    view === "back"
      ? backHeadRows(look)
      : view === "side"
        ? sideHeadRows(look)
        : [...HEADS[look.hair], ...faceRows(look)];
  // `sitBreathe` is the seated figure one pixel lower (its last row is empty),
  // the seated counterpart of `breathe`.
  const rows =
    pose === "breathe"
      ? [".........." as string, ...upper, ...bodyRows(pose).slice(1)]
      : pose === "sitBreathe"
        ? [".........." as string, ...upper, ...BODY_SIT.slice(0, -1)]
        : pose === "stretch"
          ? [...raiseArms(upper), ...bodyRows(pose)]
          : [...upper, ...bodyRows(pose)];

  const sprite: PixelSprite = {
    rows,
    palette: {
      H: look.hairColor,
      S: look.skin,
      E: "#10131a",
      O: outfit,
      o: shade(outfit),
      L: "#1f2a38",
      B: "#0f1621",
      A: look.accessory === "headset" ? "#1b2230" : "#0c1118",
      K: shade(outfit),
      T: "#e9f6ff",
      c: "#efe6d2",
    },
  };
  CHARACTER_CACHE.set(key, sprite);
  return sprite;
}

/** A darker companion of a colour, for the shaded side of an outfit. */
export function shade(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const value = parseInt(match[1]!, 16);
  const channel = (shift: number) => Math.max(0, Math.round(((value >> shift) & 0xff) * 0.62));
  return `#${[channel(16), channel(8), channel(0)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Who looks like what
// ---------------------------------------------------------------------------

const HAIR_COLORS = ["#2b2118", "#5a3825", "#c98a3a", "#d8c27a", "#8d8f95", "#b64a4a", "#3d4a8a"] as const;
const SKIN_TONES = ["#f2c9a0", "#d9a06f", "#b4733f", "#7a4a2a"] as const;
const HAIR_STYLES: readonly HairStyle[] = ["short", "long", "spiky", "cap"];
const ACCESSORIES: readonly Accessory[] = ["none", "glasses", "headset"];

/**
 * The eleven agents the server publishes today (`AGENT_IDS` in
 * `packages/agents/src/agent-policy.ts`), each given a figure by hand so the
 * office's regulars are recognisable at a glance. Anyone else gets a figure
 * from `hashedLook`, which is stable for a given id.
 */
const KNOWN_LOOKS: Record<string, CharacterLook> = {
  "conversational-assistant": { hair: "cap", hairColor: "#2b2118", skin: "#d9a06f", accessory: "headset" },
  "location-agent": { hair: "cap", hairColor: "#5a3825", skin: "#f2c9a0", accessory: "none" },
  "meta-ads-agent": { hair: "long", hairColor: "#d8c27a", skin: "#f2c9a0", accessory: "none" },
  "google-ads-agent": { hair: "short", hairColor: "#b64a4a", skin: "#d9a06f", accessory: "glasses" },
  "marketing-agent": { hair: "long", hairColor: "#c98a3a", skin: "#7a4a2a", accessory: "none" },
  "knowledge-agent": { hair: "long", hairColor: "#8d8f95", skin: "#b4733f", accessory: "glasses" },
  "analytics-agent": { hair: "spiky", hairColor: "#2b2118", skin: "#f2c9a0", accessory: "none" },
  "automation-agent": { hair: "short", hairColor: "#5a3825", skin: "#b4733f", accessory: "headset" },
  "browser-agent": { hair: "spiky", hairColor: "#3d4a8a", skin: "#d9a06f", accessory: "glasses" },
  "desktop-agent": { hair: "short", hairColor: "#d8c27a", skin: "#7a4a2a", accessory: "glasses" },
  "communication-agent": { hair: "long", hairColor: "#2b2118", skin: "#d9a06f", accessory: "headset" },
};

/** FNV-1a, 32-bit. Small, stable and dependency-free. */
export function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function hashedLook(id: string): CharacterLook {
  const hash = hashId(id);
  return {
    hair: HAIR_STYLES[hash % HAIR_STYLES.length]!,
    hairColor: HAIR_COLORS[(hash >>> 3) % HAIR_COLORS.length]!,
    skin: SKIN_TONES[(hash >>> 7) % SKIN_TONES.length]!,
    accessory: ACCESSORIES[(hash >>> 11) % ACCESSORIES.length]!,
  };
}

export function lookForAgent(agentId: string): CharacterLook {
  return KNOWN_LOOKS[agentId] ?? hashedLook(agentId);
}

// ---------------------------------------------------------------------------
// Furniture and fixtures
// ---------------------------------------------------------------------------

const WOOD = "#5b3f2a";
const WOOD_DARK = "#3a2619";
const WOOD_LIGHT = "#7a573a";
const METAL = "#2a3645";
const METAL_LIGHT = "#405166";
const METAL_DARK = "#1a2330";
const SCREEN_DIM = "#132033";
const LEAF = "#2f9e5a";
const LEAF_DARK = "#1f6b3c";
const POT = "#8a4b2f";

/**
 * A desk with a monitor. The screen (`m`) is the one pixel group the office
 * recolours by state — see `deskSprite`.
 *
 * The monitor stands at the RIGHT end of the desk, and the agent works at the
 * left (`DESK_SEAT_X`), so the figure and its screen never cover each other:
 * a status-coloured screen drawn across a figure read as a block on its body.
 */
const DESK_ROWS: readonly string[] = [
  "..........MMMMMM",
  "..........MmmmmM",
  "..........MmmmmM",
  "..........MMMMMM",
  "............MM..",
  "DDDDDDDDDDDDDDDD",
  "dKKKKKdddddddddd",
  "d..............d",
];

/**
 * Where a seated figure is drawn, relative to its desk's origin. Seven rows up
 * puts the desk's top edge across the figure's legs (its rows 12-13 are behind
 * the desk front), so it reads as sitting at the desk, hands over the keyboard.
 */
export const DESK_SEAT_X = 0;
export const DESK_SEAT_Y = -7;

const DESK_CACHE = new Map<string, PixelSprite>();

export function deskSprite(screen: string): PixelSprite {
  const cached = DESK_CACHE.get(screen);
  if (cached) return cached;
  const sprite: PixelSprite = {
    rows: DESK_ROWS,
    palette: { M: METAL_DARK, m: screen, D: WOOD_LIGHT, d: WOOD_DARK, K: METAL_LIGHT },
  };
  DESK_CACHE.set(screen, sprite);
  return sprite;
}

export const SCREEN_COLORS = {
  dim: SCREEN_DIM,
  ok: "#48e3ad",
  warn: "#f5b74a",
  danger: "#ff5d6c",
  cyan: "#3ee0f2",
} as const;

export const CHAIR: PixelSprite = {
  rows: [".CCCC.", ".cccc.", "CCCCCC", "cCCCCc", "..cc..", ".c..c."],
  palette: { C: "#2c3a4d", c: "#1a2330" },
};

export const PLANT: PixelSprite = {
  rows: ["..gg..", ".gGGg.", "gGGGGg", ".gGGg.", "..GG..", ".PPPP.", ".pPPp.", ".pppp.", "......"],
  palette: { g: LEAF_DARK, G: LEAF, P: POT, p: "#5e3220" },
};

/** `l` pixels are the rack's status lights, blinked by CSS. */
export const SERVER_RACK: PixelSprite = {
  rows: [
    "RRRRRRRR",
    "RrrrrrrR",
    "Rl.rrr.R",
    "RrrrrrrR",
    "Rl.rrr.R",
    "RrrrrrrR",
    "Rl.rrr.R",
    "RrrrrrrR",
    "Rl.rrr.R",
    "RrrrrrrR",
    "R.l.rr.R",
    "RrrrrrrR",
    "RRRRRRRR",
    "R......R",
  ],
  palette: { R: METAL_DARK, r: METAL, l: "#48e3ad" },
};

export const BOOKSHELF: PixelSprite = {
  rows: [
    "WWWWWWWWWWWW",
    "WaBcAbCaBbcW",
    "WaBcAbCaBbcW",
    "WWWWWWWWWWWW",
    "WbAacBbcAaBW",
    "WbAacBbcAaBW",
    "WWWWWWWWWWWW",
    "WcBbaACbBacW",
    "WcBbaACbBacW",
    "WWWWWWWWWWWW",
    "W..........W",
    "W..........W",
  ],
  palette: { W: WOOD_DARK, a: "#b64a4a", b: "#3d6fb0", c: "#d8c27a", A: "#2f9e5a", B: "#8a5fb0", C: "#e07a3a" },
};

export const WHITEBOARD: PixelSprite = {
  rows: [
    "FFFFFFFFFFFFFF",
    "FwwwwwwwwwwwwF",
    "FwiiiwwwiiwwwF",
    "FwwwwwwwwwwwwF",
    "FwiiiiiwwiiiwF",
    "FwwwwwwwwwwwwF",
    "FwiiwwwiiiiwwF",
    "FwwwwwwwwwwwwF",
    "FFFFFFFFFFFFFF",
  ],
  palette: { F: METAL_LIGHT, w: "#dfe7ef", i: "#3d6fb0" },
};

/** A wall display with a bar chart. `b` bars are recoloured per room. */
export const CHART_SCREEN: PixelSprite = {
  rows: [
    "FFFFFFFFFFFFFFFFFF",
    "FssssssssssssssssF",
    "Fsssssssssssbss..F",
    "FssssbssssssbssbsF",
    "FssbsbssbsssbssbsF",
    "FssbsbssbsbsbssbsF",
    "FsbbbbbbbbbbbbbbsF",
    "FssssssssssssssssF",
    "FFFFFFFFFFFFFFFFFF",
    ".......FF.........",
  ],
  palette: { F: METAL_DARK, s: SCREEN_DIM, b: "#e879f9" },
};

export const CONFERENCE_TABLE: PixelSprite = {
  rows: [
    "..TTTTTTTTTTTTTTTTTTTT..",
    ".TTTTTTTTTTTTTTTTTTTTTT.",
    "TTTTTTTTTTTTTTTTTTTTTTTT",
    "TTTTTTTTTTTTTTTTTTTTTTTT",
    "TTTTTTTTTTTTTTTTTTTTTTTT",
    "TTTTTTTTTTTTTTTTTTTTTTTT",
    ".TtttttttttttttttttttTT.",
    "..tttttttttttttttttttt..",
    "....t..............t....",
    "....t..............t....",
  ],
  palette: { T: WOOD, t: WOOD_DARK },
};

export const COFFEE_MACHINE: PixelSprite = {
  rows: ["MMMMMMM", "MmmmmmM", "MmrmmmM", "MMMMMMM", "MM...MM", "MM.c.MM", "MM.c.MM", "MMMMMMM", "MMMMMMM", "M.....M"],
  palette: { M: METAL, m: METAL_LIGHT, r: "#ff5d6c", c: "#f2c9a0" },
};

export const SOFA: PixelSprite = {
  rows: [
    ".SSSSSSSSSSSS.",
    "SSSSSSSSSSSSSS",
    "SssssssssssssS",
    "SssssssssssssS",
    "SSSSSSSSSSSSSS",
    "Ss..........sS",
    ".s..........s.",
  ],
  palette: { S: "#5a3f8a", s: "#3b2a5c" },
};

export const VENDING: PixelSprite = {
  rows: [
    "VVVVVVVV",
    "VggggggV",
    "VgabcagV",
    "VggggggV",
    "VgcabcgV",
    "VggggggV",
    "VgbcabgV",
    "VVVVVVVV",
    "VvvvvvvV",
    "Vvv..vvV",
    "VVVVVVVV",
    "V......V",
  ],
  palette: { V: "#8a2a4a", g: SCREEN_DIM, a: "#48e3ad", b: "#3ee0f2", c: "#f5b74a", v: METAL_DARK },
};

export const WINDOW: PixelSprite = {
  rows: [
    "FFFFFFFFFFF",
    "FnnnnFnnnnF",
    "FnnnnFnnnnF",
    "FnNnnFnnNnF",
    "FFFFFFFFFFF",
    "FnnnnFnnnnF",
    "FnnnnFnnnnF",
    "FFFFFFFFFFF",
  ],
  palette: { F: METAL_LIGHT, n: "#0b1f3a", N: "#e9f6ff" },
};

export const RUG: PixelSprite = {
  rows: [
    "rrrrrrrrrrrrrr",
    "rRRRRRRRRRRRRr",
    "rRrrrrrrrrrrRr",
    "rRrRRRRRRRRrRr",
    "rRrRRRRRRRRrRr",
    "rRrrrrrrrrrrRr",
    "rRRRRRRRRRRRRr",
    "rrrrrrrrrrrrrr",
  ],
  palette: { r: "#2a1f3d", R: "#3b2a5c" },
};

/**
 * The JARVIS core: a pedestal and a column of light. Three frames of the
 * column, cycled by CSS while a task is RUNNING; the first frame alone when
 * nothing runs. `c` is the light, `C` its bright centre.
 */
const CORE_BASE: readonly string[] = [
  "..........",
  "..........",
  "...PPPP...",
  "..PppppP..",
  ".PppppppP.",
  ".PPPPPPPP.",
  "..pppppp..",
];

function coreColumn(frame: number): readonly string[] {
  const column = [
    ["....cc....", "...cCCc...", "...cCCc...", "..cCCCCc..", "..cCCCCc..", "...cCCc...", "...cCCc...", "....cc....", "...c..c..."],
    ["...cCCc...", "..cCCCCc..", "...cCCc...", "...cCCc...", "..cCCCCc..", "...cCCc...", "....cc....", "...c..c...", "....cc...."],
    ["....cc....", "...c..c...", "..cCCCCc..", "...cCCc...", "...cCCc...", "..cCCCCc..", "...cCCc...", "....cc....", "...cCCc..."],
  ];
  return column[frame % 3]!;
}

const CORE_CACHE = new Map<string, PixelSprite>();

export function coreSprite(frame: number, light: string): PixelSprite {
  const key = `${frame % 3}|${light}`;
  const cached = CORE_CACHE.get(key);
  if (cached) return cached;
  const sprite: PixelSprite = {
    rows: [...coreColumn(frame), ...CORE_BASE],
    palette: { c: shade(light), C: light, P: METAL_LIGHT, p: METAL_DARK },
  };
  CORE_CACHE.set(key, sprite);
  return sprite;
}

export const CORE_SIZE: SpriteSize = { width: 10, height: 16 };

/** Small status glyphs drawn above a character. */
export const GLYPH_CHECK: PixelSprite = {
  rows: ["....k", "...kk", "k.kk.", "kkk..", ".k..."],
  palette: { k: "#48e3ad" },
};
export const GLYPH_ALERT: PixelSprite = {
  rows: [".k.", ".k.", ".k.", "...", ".k."],
  palette: { k: "#ff5d6c" },
};
export const GLYPH_WAIT: PixelSprite = {
  rows: ["kkkkk", ".kkk.", "..k..", ".kkk.", "kkkkk"],
  palette: { k: "#f5b74a" },
};

// ---------------------------------------------------------------------------
// VO-3.1 — break facilities, the hallway, and activity overlays
// ---------------------------------------------------------------------------

/** A water cooler: blue bottle, white body. */
export const WATER_COOLER: PixelSprite = {
  rows: [
    "..bb..",
    ".bBBb.",
    ".bBBb.",
    ".bBBb.",
    "WWWWWW",
    "WwwwwW",
    "WwrbwW",
    "WwwwwW",
    "WWWWWW",
    "Ww..wW",
    "Ww..wW",
    "W....W",
  ],
  palette: { b: "#2f6fb0", B: "#7cc4f2", W: "#d7dee6", w: "#aeb8c4", r: "#ff5d6c" },
};

/** A lunch table with two stools, seen from the front. */
export const LUNCH_TABLE: PixelSprite = {
  rows: [
    "....................",
    "TTTTTTTTTTTTTTTTTTTT",
    "TttttttttttttttttttT",
    "..t..............t..",
    "..t..............t..",
    "SSS..............SSS",
    "s.s..............s.s",
    "s.s..............s.s",
  ],
  palette: { T: "#b07a4a", t: "#6e4628", S: "#3b2a5c", s: "#2a1f3d" },
};

/** The washroom door at the end of the hallway, with its sign. */
export const WC_DOOR: PixelSprite = {
  rows: [
    "FFFFFFFFFF",
    "FDDDDDDDDF",
    "FDwwwwwwDF",
    "FDwWwWwwDF",
    "FDwWWWwwDF",
    "FDwwwwwwDF",
    "FDDDDDDDDF",
    "FDDDDDDDDF",
    "FDDDDDDkDF",
    "FDDDDDDDDF",
    "FDDDDDDDDF",
    "FDDDDDDDDF",
    "FDDDDDDDDF",
    "FFFFFFFFFF",
  ],
  palette: { F: "#405166", D: "#4b5c70", w: "#e9f6ff", W: "#2f6fb0", k: "#d8c27a" },
};

/** A speech bubble with three dots, drawn above a talking figure. */
export const SPEECH_BUBBLE: PixelSprite = {
  rows: [".WWWWW.", "WWWWWWW", "WkWkWkW", "WWWWWWW", ".WWWWW.", "..WW...", "..W...."],
  palette: { W: "#e9f6ff", k: "#14212f" },
};

/** Two rising wisps over a mug. Decorative. */
export const STEAM: PixelSprite = {
  rows: [".s.", "s.s", ".s."],
  palette: { s: "#c3d3e0" },
};

/** Lines of output on a busy monitor (4x2, the screen's inside). */
export const SCREEN_ACTIVITY: PixelSprite = {
  rows: ["aa.a", "a.aa"],
  palette: { a: "#e9f6ff" },
};

/** VO-3.1 — glyphs for the task states, drawn beside the head. */
export const GLYPH_QUEUED: PixelSprite = {
  rows: ["kkkkk", ".....", "kkkk.", ".....", "kkk.."],
  palette: { k: "#f5b74a" },
};
export const GLYPH_ASSIGNED: PixelSprite = {
  rows: ["..k..", "..k..", "k.k.k", ".kkk.", "..k.."],
  palette: { k: "#3ee0f2" },
};
export const GLYPH_RESEARCH: PixelSprite = {
  rows: [".kk..", "k..k.", "k..k.", ".kkk.", "....k"],
  palette: { k: "#818cf8" },
};
export const GLYPH_TOOL: PixelSprite = {
  rows: ["k...k", "kk.kk", ".kkk.", "..k..", "..k.."],
  palette: { k: "#48e3ad" },
};
export const GLYPH_WORK: PixelSprite = {
  rows: [".k.k.", "kkkkk", ".k.k.", "kkkkk", ".k.k."],
  palette: { k: "#48e3ad" },
};
