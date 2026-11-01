// ---------------------------------------------------------------------------
// Phase 19, Stage 19.1 — Computer & Browser Control contracts.
//
// CONTRACT ONLY. Nothing in this file starts a browser, launches an
// application, opens a socket or reaches a provider. It fixes the vocabulary
// the future `ComputerControlService`, the model-facing tools and the Windows
// desktop agent must share, and the policy those surfaces read:
//
//   • a browser or desktop action is a closed set with bounded parameters;
//   • an unknown action, an extra field, an oversized value or a malformed
//     identifier is refused before anything can execute;
//   • no request can carry a raw Playwright object, CDP command, arbitrary
//     JavaScript, a shell command or a filesystem path;
//   • the Organization that owns the connection is resolved by the server,
//     never named by a request (Phase 17, `SHARED_CONNECTION_TOOLS`);
//   • a sensitive action is refused for a spoken turn;
//   • an approval summary names the action, the normalized origin and field
//     names, and never a typed value.
//
// Browser control is a deployment-wide, Organization-owned connection, so the
// ten existing browser tools are catalogued in `SHARED_CONNECTION_TOOLS`
// (`types/tenant.ts`). They therefore already pass through
// `authorizeSharedConnection` and the approval store's tenant binding when the
// browser is enabled — this stage adds no second authorization path.
//
// The Windows desktop agent is planned for Stage 19.6. Its actions are defined
// here so the vocabulary is fixed early, but its connector is deliberately NOT
// in `SHARED_CONNECTOR_KEYS`: no registered tool or route reads that owner
// record yet, and the catalog lists a connection only once one does.
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  BROWSER_INPUT_TEXT_MAX_LENGTH,
  BROWSER_MAX_EXTRACT_FIELDS,
  BROWSER_SELECTOR_MAX_LENGTH,
  BROWSER_TOOL_IDS,
  BrowserInputTextSchema,
  BrowserSelectorSchema,
} from "./types/browser.js";
import {
  SHARED_CONNECTION_TOOLS,
  SHARED_INTEGRATION_CONNECTORS,
  type SharedConnectionScope,
  type SharedConnectorKey,
} from "./types/tenant.js";
import { computeParamsHash } from "./utils/params-hash.js";

// ---------------------------------------------------------------------------
// Closed action sets
// ---------------------------------------------------------------------------

export const COMPUTER_CONTROL_SURFACES = ["browser", "desktop"] as const;
export type ComputerControlSurface = (typeof COMPUTER_CONTROL_SURFACES)[number];

/**
 * The browser actions are exactly the ten existing browser tools. A tool id is
 * the action id, so an approval, an audit row, the existing executor gate and
 * the future service all name the same thing.
 */
export const BROWSER_CONTROL_ACTION_IDS = Object.freeze([
  BROWSER_TOOL_IDS.navigate,
  BROWSER_TOOL_IDS.inspect,
  BROWSER_TOOL_IDS.extract,
  BROWSER_TOOL_IDS.screenshot,
  BROWSER_TOOL_IDS.click,
  BROWSER_TOOL_IDS.type,
  BROWSER_TOOL_IDS.select,
  BROWSER_TOOL_IDS.submit,
  BROWSER_TOOL_IDS.download,
  BROWSER_TOOL_IDS.upload,
] as const);

/**
 * The Windows desktop actions. There is deliberately no "run command", "read
 * file" or "write file" action: a capability that has no contract cannot be
 * talked into existence later. `desktop.app.launch` (Stage 19.7, by the owner's
 * decision) opens one application from a fixed list; it takes an id, never a
 * path, an argument or a command line.
 *
 * `desktop.session.start` is intentionally absent. A session starts only from
 * the consent surface on the person's own machine, never from a model tool.
 */
export const DESKTOP_CONTROL_ACTION_IDS = Object.freeze([
  "desktop.screen.read",
  "desktop.input.click",
  "desktop.input.type",
  "desktop.input.key",
  "desktop.app.launch",
  "desktop.session.end",
] as const);

export const COMPUTER_CONTROL_ACTION_IDS = Object.freeze([
  ...BROWSER_CONTROL_ACTION_IDS,
  ...DESKTOP_CONTROL_ACTION_IDS,
] as const);

export type BrowserControlActionId = (typeof BROWSER_CONTROL_ACTION_IDS)[number];
export type DesktopControlActionId = (typeof DESKTOP_CONTROL_ACTION_IDS)[number];
export type ComputerControlActionId = (typeof COMPUTER_CONTROL_ACTION_IDS)[number];

const ACTION_SET: ReadonlySet<string> = new Set<string>(COMPUTER_CONTROL_ACTION_IDS);

export function isComputerControlAction(value: unknown): value is ComputerControlActionId {
  return typeof value === "string" && ACTION_SET.has(value);
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** The same URL bound the existing browser tools enforce. */
export const COMPUTER_CONTROL_URL_MAX_LENGTH = 2_048;
/** Bound on a desktop press key; a fixed set, not an arbitrary chord. */
export const DESKTOP_KEY_NAMES = Object.freeze([
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
] as const);
export type DesktopKeyName = (typeof DESKTOP_KEY_NAMES)[number];
/**
 * Phase 19.7 — the applications a command may open, by fixed id. The agent
 * holds the same list and resolves each id to a path it chose itself: nothing
 * that travels in a command ever names a file.
 */
export const DESKTOP_APP_IDS = Object.freeze(["notepad", "calculator", "edge", "chrome", "explorer"] as const);
export type DesktopAppId = (typeof DESKTOP_APP_IDS)[number];
export const DESKTOP_APP_LABELS: Readonly<Record<DesktopAppId, string>> = Object.freeze({
  notepad: "Notepad",
  calculator: "Calculator",
  edge: "Microsoft Edge",
  chrome: "Google Chrome",
  explorer: "File Explorer",
});
/** Coordinates are bounded so a malformed payload cannot carry an absurd int. */
export const DESKTOP_COORDINATE_MAX = 100_000;
/** The highest display index a future agent may address. */
export const DESKTOP_DISPLAY_MAX = 15;
/** A browser artifact id is an opaque UUID, never a path. */
export const ComputerControlArtifactIdSchema = z.string().uuid("artifact id must be an opaque id");

/**
 * A file name reported by a page is a NAME, never a path. A service that keeps
 * a download must still sanitize it; refusing separators and control
 * characters here means a traversal segment cannot even be represented in the
 * contract a caller reads.
 */
export const ComputerControlFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => {
    if (value === "." || value === "..") return false;
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (character === "\\" || character === "/" || code < 0x20) return false;
    }
    return true;
  }, "file name must not be a path");

const PrototypeSafeRecord = <T extends z.ZodTypeAny>(value: T) =>
  z.record(z.string(), value)
    .refine(
      (record) =>
        Object.keys(record).every((key) => BrowserSelectorSchema.safeParse(key).success),
      "field names must be valid selectors"
    )
    .refine(
      (record) =>
        Object.keys(record).every(
          (key) => key !== "__proto__" && key !== "constructor" && key !== "prototype"
        ),
      "field names must be ordinary selectors"
    );

function boundedSelectorMap(value: z.ZodTypeAny) {
  return PrototypeSafeRecord(value).refine(
    (record) => Object.keys(record).length <= BROWSER_MAX_EXTRACT_FIELDS,
    `at most ${BROWSER_MAX_EXTRACT_FIELDS} fields`
  );
}

/**
 * A navigation target. Shape only: whether the host may actually be opened is
 * the navigation and egress policy's decision, made with DNS at the boundary.
 *
 * Credentials in the URL are refused here, because a URL is copied into
 * approvals, audits and logs; `https://user:password@host` would place a secret
 * in all three.
 */
export const BrowserControlUrlSchema = z
  .string()
  .trim()
  .min(1, "url is required")
  .max(COMPUTER_CONTROL_URL_MAX_LENGTH, "url is too long")
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "url must be absolute" });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "url must use http or https" });
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "url must not contain credentials" });
    }
  });

const BrowserPageSchema = z
  .object({
    url: z.string().max(COMPUTER_CONTROL_URL_MAX_LENGTH),
    title: z.string().max(500),
    status: z.number().int().min(100).max(599).nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const BrowserNavigateRequestSchema = z
  .object({ action: z.literal(BROWSER_TOOL_IDS.navigate), url: BrowserControlUrlSchema })
  .strict();

const BrowserInspectRequestSchema = z
  .object({ action: z.literal(BROWSER_TOOL_IDS.inspect), url: BrowserControlUrlSchema })
  .strict();

const BrowserExtractRequestSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.extract),
    url: BrowserControlUrlSchema,
    selectors: boundedSelectorMap(BrowserSelectorSchema).optional(),
  })
  .strict();

const BrowserScreenshotRequestSchema = z
  .object({ action: z.literal(BROWSER_TOOL_IDS.screenshot), url: BrowserControlUrlSchema })
  .strict();

const BrowserClickRequestSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.click),
    url: BrowserControlUrlSchema,
    selector: BrowserSelectorSchema,
  })
  .strict();

const BrowserTypeRequestSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.type),
    url: BrowserControlUrlSchema,
    selector: BrowserSelectorSchema,
    text: BrowserInputTextSchema,
  })
  .strict();

const BrowserSelectRequestSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.select),
    url: BrowserControlUrlSchema,
    selector: BrowserSelectorSchema,
    value: BrowserInputTextSchema,
  })
  .strict();

const BrowserSubmitRequestSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.submit),
    url: BrowserControlUrlSchema,
    selector: BrowserSelectorSchema,
    fields: boundedSelectorMap(BrowserInputTextSchema).optional(),
  })
  .strict();

const BrowserDownloadRequestSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.download),
    url: BrowserControlUrlSchema,
    selector: BrowserSelectorSchema,
  })
  .strict();

const BrowserUploadRequestSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.upload),
    url: BrowserControlUrlSchema,
    selector: BrowserSelectorSchema,
    downloadId: ComputerControlArtifactIdSchema,
  })
  .strict();

export const BrowserControlRequestSchema = z.discriminatedUnion("action", [
  BrowserNavigateRequestSchema,
  BrowserInspectRequestSchema,
  BrowserExtractRequestSchema,
  BrowserScreenshotRequestSchema,
  BrowserClickRequestSchema,
  BrowserTypeRequestSchema,
  BrowserSelectRequestSchema,
  BrowserSubmitRequestSchema,
  BrowserDownloadRequestSchema,
  BrowserUploadRequestSchema,
]);

const DesktopScreenReadRequestSchema = z
  .object({
    action: z.literal("desktop.screen.read"),
    display: z.number().int().min(0).max(DESKTOP_DISPLAY_MAX).optional(),
  })
  .strict();

/**
 * Phase 19.6 — the paired device a desktop command is for. An approval is bound
 * to its parameters' hash, so naming the device here binds the approval to it:
 * an approval for one device can never be spent on another.
 */
const DesktopDeviceIdSchema = z.string().uuid("device id must be an opaque id").optional();

const DesktopClickRequestSchema = z
  .object({
    action: z.literal("desktop.input.click"),
    deviceId: DesktopDeviceIdSchema,
    x: z.number().int().min(0).max(DESKTOP_COORDINATE_MAX),
    y: z.number().int().min(0).max(DESKTOP_COORDINATE_MAX),
    button: z.enum(["left", "right", "middle"]).optional(),
  })
  .strict();

const DesktopTypeRequestSchema = z
  .object({
    action: z.literal("desktop.input.type"),
    deviceId: DesktopDeviceIdSchema,
    text: BrowserInputTextSchema,
  })
  .strict();

const DesktopKeyRequestSchema = z
  .object({
    action: z.literal("desktop.input.key"),
    deviceId: DesktopDeviceIdSchema,
    key: z.enum(DESKTOP_KEY_NAMES),
  })
  .strict();

const DesktopAppLaunchRequestSchema = z
  .object({
    action: z.literal("desktop.app.launch"),
    deviceId: DesktopDeviceIdSchema,
    app: z.enum(DESKTOP_APP_IDS),
  })
  .strict();

const DesktopSessionEndRequestSchema = z.object({ action: z.literal("desktop.session.end") }).strict();

export const DesktopControlRequestSchema = z.discriminatedUnion("action", [
  DesktopScreenReadRequestSchema,
  DesktopClickRequestSchema,
  DesktopTypeRequestSchema,
  DesktopKeyRequestSchema,
  DesktopAppLaunchRequestSchema,
  DesktopSessionEndRequestSchema,
]);

export const ComputerControlRequestSchema = z.union([
  BrowserControlRequestSchema,
  DesktopControlRequestSchema,
]);

export type BrowserControlRequest = z.infer<typeof BrowserControlRequestSchema>;
export type DesktopControlRequest = z.infer<typeof DesktopControlRequestSchema>;
export type ComputerControlRequest = z.infer<typeof ComputerControlRequestSchema>;

export type ComputerControlParseCode = "UNKNOWN_ACTION" | "INVALID_REQUEST";

export type ComputerControlParseResult =
  | { ok: true; value: ComputerControlRequest }
  | { ok: false; code: ComputerControlParseCode };

/**
 * Parse one request, telling "we do not know this action" apart from "this
 * action's payload is wrong". Both are refusals; neither reaches a runtime.
 *
 * An unknown action is checked before the union so a future or misspelled verb
 * is a stable `UNKNOWN_ACTION`, not a generic schema failure.
 */
export function parseComputerControlRequest(input: unknown): ComputerControlParseResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const action = (input as { action?: unknown }).action;
  if (typeof action !== "string" || !ACTION_SET.has(action)) {
    return { ok: false, code: "UNKNOWN_ACTION" };
  }
  const parsed = ComputerControlRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID_REQUEST" };
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Stable error codes. A result never carries a provider's free text: a typed
 * value, a page's words or an upstream message cannot become part of the
 * contract, and the caller renders its own fixed sentence.
 */
export const COMPUTER_CONTROL_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "NOT_AUTHORIZED",
  "NOT_AVAILABLE",
  "NAVIGATION_REFUSED",
  "TIMEOUT",
  "PROVIDER_ERROR",
  "UNKNOWN_OUTCOME",
  "SESSION_ENDED",
] as const);

export type ComputerControlErrorCode = (typeof COMPUTER_CONTROL_ERROR_CODES)[number];

const BrowserElementSummarySchema = z
  .object({
    selector: z.string().max(BROWSER_SELECTOR_MAX_LENGTH),
    tag: z.string().max(32),
    label: z.string().max(200),
    type: z.string().max(32).optional(),
    href: z.string().max(COMPUTER_CONTROL_URL_MAX_LENGTH).optional(),
  })
  .strict();

const BrowserNavigateResultSchema = z
  .object({ action: z.literal(BROWSER_TOOL_IDS.navigate), ok: z.literal(true), page: BrowserPageSchema, redirected: z.boolean() })
  .strict();

const BrowserInspectResultSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.inspect),
    ok: z.literal(true),
    page: BrowserPageSchema,
    elements: z.array(BrowserElementSummarySchema).max(200),
    truncated: z.boolean(),
  })
  .strict();

const BrowserExtractResultSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.extract),
    ok: z.literal(true),
    page: BrowserPageSchema,
    text: z.string().max(BROWSER_INPUT_TEXT_MAX_LENGTH),
    fields: boundedSelectorMap(z.string().max(BROWSER_INPUT_TEXT_MAX_LENGTH)),
    truncated: z.boolean(),
  })
  .strict();

const BrowserScreenshotResultSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.screenshot),
    ok: z.literal(true),
    page: BrowserPageSchema,
    screenshotId: ComputerControlArtifactIdSchema,
    byteSize: z.number().int().min(0),
    format: z.literal("png"),
  })
  .strict();

const BrowserActionResultSchema = z
  .object({
    action: z.enum([
      BROWSER_TOOL_IDS.click,
      BROWSER_TOOL_IDS.type,
      BROWSER_TOOL_IDS.select,
      BROWSER_TOOL_IDS.submit,
    ]),
    ok: z.literal(true),
    page: BrowserPageSchema,
    selector: z.string().max(BROWSER_SELECTOR_MAX_LENGTH),
    navigated: z.boolean(),
  })
  .strict();

const BrowserDownloadResultSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.download),
    ok: z.literal(true),
    downloadId: ComputerControlArtifactIdSchema,
    fileName: ComputerControlFileNameSchema,
    byteSize: z.number().int().min(0),
    mimeType: z.string().max(127),
    sourceOrigin: z.string().max(COMPUTER_CONTROL_URL_MAX_LENGTH),
  })
  .strict();

const BrowserUploadResultSchema = z
  .object({
    action: z.literal(BROWSER_TOOL_IDS.upload),
    ok: z.literal(true),
    page: BrowserPageSchema,
    selector: z.string().max(BROWSER_SELECTOR_MAX_LENGTH),
    downloadId: ComputerControlArtifactIdSchema,
    fileName: ComputerControlFileNameSchema,
  })
  .strict();

export const BrowserControlResultSchema = z.union([
  BrowserNavigateResultSchema,
  BrowserInspectResultSchema,
  BrowserExtractResultSchema,
  BrowserScreenshotResultSchema,
  BrowserActionResultSchema,
  BrowserDownloadResultSchema,
  BrowserUploadResultSchema,
]);

const DesktopScreenReadResultSchema = z
  .object({
    action: z.literal("desktop.screen.read"),
    ok: z.literal(true),
    artifactId: ComputerControlArtifactIdSchema,
    width: z.number().int().min(1).max(DESKTOP_COORDINATE_MAX),
    height: z.number().int().min(1).max(DESKTOP_COORDINATE_MAX),
  })
  .strict();

const DesktopInputResultSchema = z
  .object({
    action: z.enum(["desktop.input.click", "desktop.input.type", "desktop.input.key", "desktop.app.launch"]),
    ok: z.literal(true),
  })
  .strict();

const DesktopSessionEndResultSchema = z
  .object({ action: z.literal("desktop.session.end"), ok: z.literal(true) })
  .strict();

export const DesktopControlResultSchema = z.union([
  DesktopScreenReadResultSchema,
  DesktopInputResultSchema,
  DesktopSessionEndResultSchema,
]);

export const ComputerControlFailureSchema = z
  .object({
    action: z.enum(COMPUTER_CONTROL_ACTION_IDS),
    ok: z.literal(false),
    code: z.enum(COMPUTER_CONTROL_ERROR_CODES),
  })
  .strict();

export const ComputerControlResultSchema = z.union([
  BrowserControlResultSchema,
  DesktopControlResultSchema,
  ComputerControlFailureSchema,
]);

export type BrowserControlResult = z.infer<typeof BrowserControlResultSchema>;
export type DesktopControlResult = z.infer<typeof DesktopControlResultSchema>;
export type ComputerControlResult = z.infer<typeof ComputerControlResultSchema>;

// ---------------------------------------------------------------------------
// Action policy
// ---------------------------------------------------------------------------

/**
 * The browser service is one deployment-wide connection, assigned to one
 * Organization by the operator (Phase 17). The desktop agent will have its own
 * key once a route enforces it (Stage 19.6).
 */
export const DESKTOP_AGENT_CONNECTOR: SharedConnectorKey = Object.freeze({
  providerId: "desktop",
  connector: "agent",
});

export interface ComputerControlActionPolicy {
  readonly action: ComputerControlActionId;
  readonly surface: ComputerControlSurface;
  /** The tool id an action reaches; equal to `action`. */
  readonly toolId: ComputerControlActionId;
  readonly access: "read" | "write";
  readonly requiresApproval: boolean;
  readonly voice: "allowed" | "refused";
  readonly connector: SharedConnectorKey;
  /**
   * True once the action is in `SHARED_CONNECTION_TOOLS`, so the existing gate
   * and approval store enforce the owning Organization. Desktop stays false
   * until its tool exists (Stage 19.6).
   */
  readonly organizationMapped: boolean;
  /** True when a parameter may carry a value a person would not want stored. */
  readonly carriesSensitiveInput: boolean;
}

function browserAccess(action: BrowserControlActionId): "read" | "write" {
  return SHARED_CONNECTION_TOOLS[action]!.access;
}

const BROWSER_CONNECTOR = SHARED_INTEGRATION_CONNECTORS.browser;

export const COMPUTER_CONTROL_ACTION_POLICY: Readonly<
  Record<ComputerControlActionId, ComputerControlActionPolicy>
> = Object.freeze({
  [BROWSER_TOOL_IDS.navigate]: {
    action: BROWSER_TOOL_IDS.navigate,
    surface: "browser",
    toolId: BROWSER_TOOL_IDS.navigate,
    access: browserAccess(BROWSER_TOOL_IDS.navigate),
    requiresApproval: false,
    voice: "allowed",
    connector: BROWSER_CONNECTOR,
    organizationMapped: true,
    carriesSensitiveInput: false,
  },
  [BROWSER_TOOL_IDS.inspect]: {
    action: BROWSER_TOOL_IDS.inspect,
    surface: "browser",
    toolId: BROWSER_TOOL_IDS.inspect,
    access: browserAccess(BROWSER_TOOL_IDS.inspect),
    requiresApproval: false,
    voice: "allowed",
    connector: BROWSER_CONNECTOR,
    organizationMapped: true,
    carriesSensitiveInput: false,
  },
  [BROWSER_TOOL_IDS.extract]: {
    action: BROWSER_TOOL_IDS.extract,
    surface: "browser",
    toolId: BROWSER_TOOL_IDS.extract,
    access: browserAccess(BROWSER_TOOL_IDS.extract),
    requiresApproval: false,
    voice: "allowed",
    connector: BROWSER_CONNECTOR,
    organizationMapped: true,
    carriesSensitiveInput: false,
  },
  [BROWSER_TOOL_IDS.screenshot]: {
    action: BROWSER_TOOL_IDS.screenshot,
    surface: "browser",
    toolId: BROWSER_TOOL_IDS.screenshot,
    access: browserAccess(BROWSER_TOOL_IDS.screenshot),
    requiresApproval: false,
    voice: "allowed",
    connector: BROWSER_CONNECTOR,
    organizationMapped: true,
    carriesSensitiveInput: false,
  },
  [BROWSER_TOOL_IDS.click]: {
    action: BROWSER_TOOL_IDS.click,
    surface: "browser",
    toolId: BROWSER_TOOL_IDS.click,
    access: browserAccess(BROWSER_TOOL_IDS.click),
    requiresApproval: true,
    voice: "refused",
    connector: BROWSER_CONNECTOR,
    organizationMapped: true,
    carriesSensitiveInput: false,
  },
  [BROWSER_TOOL_IDS.type]: {
    action: BROWSER_TOOL_IDS.type,
    surface: "browser",
    toolId: BROWSER_TOOL_IDS.type,
    access: browserAccess(BROWSER_TOOL_IDS.type),
    requiresApproval: true,
    voice: "refused",
    connector: BROWSER_CONNECTOR,
    organizationMapped: true,
    carriesSensitiveInput: true,
  },
  [BROWSER_TOOL_IDS.select]: {
    action: BROWSER_TOOL_IDS.select,
    surface: "browser",
    toolId: BROWSER_TOOL_IDS.select,
    access: browserAccess(BROWSER_TOOL_IDS.select),
    requiresApproval: true,
    voice: "refused",
    connector: BROWSER_CONNECTOR,
    organizationMapped: true,
    carriesSensitiveInput: true,
  },
  [BROWSER_TOOL_IDS.submit]: {
    action: BROWSER_TOOL_IDS.submit,
    surface: "browser",
    toolId: BROWSER_TOOL_IDS.submit,
    access: browserAccess(BROWSER_TOOL_IDS.submit),
    requiresApproval: true,
    voice: "refused",
    connector: BROWSER_CONNECTOR,
    organizationMapped: true,
    carriesSensitiveInput: true,
  },
  [BROWSER_TOOL_IDS.download]: {
    action: BROWSER_TOOL_IDS.download,
    surface: "browser",
    toolId: BROWSER_TOOL_IDS.download,
    access: browserAccess(BROWSER_TOOL_IDS.download),
    requiresApproval: true,
    voice: "refused",
    connector: BROWSER_CONNECTOR,
    organizationMapped: true,
    carriesSensitiveInput: false,
  },
  [BROWSER_TOOL_IDS.upload]: {
    action: BROWSER_TOOL_IDS.upload,
    surface: "browser",
    toolId: BROWSER_TOOL_IDS.upload,
    access: browserAccess(BROWSER_TOOL_IDS.upload),
    requiresApproval: true,
    voice: "refused",
    connector: BROWSER_CONNECTOR,
    organizationMapped: true,
    carriesSensitiveInput: true,
  },
  "desktop.screen.read": {
    action: "desktop.screen.read",
    surface: "desktop",
    toolId: "desktop.screen.read",
    access: "read",
    requiresApproval: false,
    voice: "refused",
    connector: DESKTOP_AGENT_CONNECTOR,
    organizationMapped: false,
    carriesSensitiveInput: false,
  },
  "desktop.input.click": {
    action: "desktop.input.click",
    surface: "desktop",
    toolId: "desktop.input.click",
    access: "write",
    requiresApproval: true,
    voice: "refused",
    connector: DESKTOP_AGENT_CONNECTOR,
    organizationMapped: false,
    carriesSensitiveInput: false,
  },
  "desktop.input.type": {
    action: "desktop.input.type",
    surface: "desktop",
    toolId: "desktop.input.type",
    access: "write",
    requiresApproval: true,
    voice: "refused",
    connector: DESKTOP_AGENT_CONNECTOR,
    organizationMapped: false,
    carriesSensitiveInput: true,
  },
  "desktop.input.key": {
    action: "desktop.input.key",
    surface: "desktop",
    toolId: "desktop.input.key",
    access: "write",
    requiresApproval: true,
    voice: "refused",
    connector: DESKTOP_AGENT_CONNECTOR,
    organizationMapped: false,
    carriesSensitiveInput: false,
  },
  "desktop.app.launch": {
    action: "desktop.app.launch",
    surface: "desktop",
    toolId: "desktop.app.launch",
    access: "write",
    requiresApproval: true,
    voice: "refused",
    connector: DESKTOP_AGENT_CONNECTOR,
    organizationMapped: false,
    carriesSensitiveInput: false,
  },
  "desktop.session.end": {
    action: "desktop.session.end",
    surface: "desktop",
    toolId: "desktop.session.end",
    access: "write",
    // Ending a session revokes access; it is never a reason to keep one open.
    // When Stage 19.6 catalogs this action, it must not be gated as a shared
    // Organization write: revoking one's own session is not a shared change.
    requiresApproval: false,
    voice: "allowed",
    connector: DESKTOP_AGENT_CONNECTOR,
    organizationMapped: false,
    carriesSensitiveInput: false,
  },
});

/** The reviewed policy for one action, or null for anything unrecognized. */
export function computerControlActionPolicy(
  action: string
): ComputerControlActionPolicy | null {
  return isComputerControlAction(action) ? COMPUTER_CONTROL_ACTION_POLICY[action] : null;
}

/**
 * The server-side answer a browser write tool needs before it may run: the
 * Organization that currently owns the deployment's browser connection.
 *
 * A tool never learns this from its parameters. `ToolContext` has no tenant
 * field and none may be added; the API composition root implements this port
 * from `SharedConnectionAccess` and `sharedWriteScope`, so the owner record is
 * read on the server for every sensitive action.
 *
 * A refusal carries a fixed, value-free sentence. A tool that cannot resolve a
 * scope must not execute, and must not invent one: the approval store refuses
 * an Organization-bound approval consumed without its scope.
 */
export type BrowserWriteScopeResolution =
  | { readonly ok: true; readonly tenantScope: SharedConnectionScope }
  | { readonly ok: false; readonly message: string };

export interface BrowserWriteScopePort {
  resolveWriteScope(userId: string): Promise<BrowserWriteScopeResolution>;
}

// ---------------------------------------------------------------------------
// Voice refusal
// ---------------------------------------------------------------------------

/**
 * Phase 19, ADR-19-006 — the sensitive actions a spoken turn may not start.
 *
 * Read-only browser actions stay allowed. Every browser action that changes a
 * page, stores a file or sends data is refused, because the sentence that
 * proposed it can be misheard and the result cannot be reviewed by ear.
 *
 * Desktop screen reading and input are refused. A desktop session begins from
 * explicit on-screen consent; voice may not start one or act inside one. The
 * exception is `desktop.session.end`: revoking control must always be possible,
 * including by speech.
 */
export const COMPUTER_CONTROL_VOICE_REFUSED_TOOLS: Readonly<Record<string, string>> =
  Object.freeze({
    [BROWSER_TOOL_IDS.click]:
      "That browser action cannot be started by voice. Open Browser Control on screen and review it there.",
    [BROWSER_TOOL_IDS.type]:
      "Typing into a web page cannot be started by voice. Open Browser Control on screen and review it there.",
    [BROWSER_TOOL_IDS.select]:
      "Choosing a value on a web page cannot be started by voice. Open Browser Control on screen and review it there.",
    [BROWSER_TOOL_IDS.submit]:
      "Submitting a form cannot be started by voice. Open Browser Control on screen and review it there.",
    [BROWSER_TOOL_IDS.download]:
      "A download cannot be started by voice. Open Browser Control on screen and review it there.",
    [BROWSER_TOOL_IDS.upload]:
      "Uploading a file cannot be started by voice. Open Browser Control on screen and review it there.",
    "desktop.screen.read":
      "Reading the desktop screen cannot be started by voice. Open Computer Control on screen and grant a session there.",
    "desktop.input.click":
      "Controlling the desktop cannot be started by voice. Open Computer Control on screen and grant a session there.",
    "desktop.input.type":
      "Controlling the desktop cannot be started by voice. Open Computer Control on screen and grant a session there.",
    "desktop.input.key":
      "Controlling the desktop cannot be started by voice. Open Computer Control on screen and grant a session there.",
    "desktop.app.launch":
      "Opening an application cannot be started by voice. Ask in the chat on screen, or use Computer Control.",
  });

// ---------------------------------------------------------------------------
// Approval summary — names and origins, never values
// ---------------------------------------------------------------------------

export interface ComputerControlApprovalSummary {
  readonly actionSummary: string;
  readonly targetResource?: string;
  readonly detailLines: ReadonlyArray<{ label: string; value: string }>;
}

/**
 * The normalized origin of a browser target: scheme, host and explicit port,
 * with any path, query and fragment dropped. A query can carry a token, and a
 * fragment can carry anything; neither belongs in an approval summary.
 */
export function normalizeBrowserOrigin(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * A selector shown in a summary is a FIELD NAME, not a typed value.
 *
 * Attribute value literals are removed, so `input[name="password"]` is shown
 * as `input[name=…]` and `input[value="secret"]` cannot smuggle a value into
 * the summary. The result is bounded.
 */
function describeField(selector: string): string {
  const withoutValues = selector.replace(/=("[^"]*"|'[^']*'|[^\]\s]+)/g, "=…");
  return withoutValues.length <= 80 ? withoutValues : `${withoutValues.slice(0, 77)}…`;
}

function describeFields(selectors: readonly string[]): string {
  if (selectors.length === 0) return "none";
  const shown = selectors.slice(0, 5).map(describeField).join(", ");
  return selectors.length > 5 ? `${shown}, +${selectors.length - 5} more` : shown;
}

function originOf(url: string): string {
  return normalizeBrowserOrigin(url) ?? "an unrecognized site";
}

/**
 * The deterministic, value-free approval representation for a browser or
 * desktop action. It is a pure function of the parsed request.
 *
 * What may appear: the action, the normalized origin, sanitized field names,
 * counts, coordinates and a fixed key name. What may never appear: typed text,
 * a selected value, a cookie, a token, a password, a file's bytes or a URL's
 * path/query.
 */
export function computerControlApprovalSummary(
  request: ComputerControlRequest
): ComputerControlApprovalSummary {
  switch (request.action) {
    case BROWSER_TOOL_IDS.navigate: {
      const origin = originOf(request.url);
      return {
        actionSummary: `Open ${origin} in the browser.`,
        targetResource: origin,
        detailLines: [{ label: "Site", value: origin }],
      };
    }
    case BROWSER_TOOL_IDS.inspect: {
      const origin = originOf(request.url);
      return {
        actionSummary: `Inspect the page at ${origin}.`,
        targetResource: origin,
        detailLines: [{ label: "Site", value: origin }],
      };
    }
    case BROWSER_TOOL_IDS.extract: {
      const origin = originOf(request.url);
      const names = Object.keys(request.selectors ?? {});
      return {
        actionSummary: `Read the page at ${origin}.`,
        targetResource: origin,
        detailLines: [
          { label: "Site", value: origin },
          { label: "Fields", value: names.length > 0 ? describeFields(names) : "whole page" },
        ],
      };
    }
    case BROWSER_TOOL_IDS.screenshot: {
      const origin = originOf(request.url);
      return {
        actionSummary: `Capture a screenshot of ${origin}.`,
        targetResource: origin,
        detailLines: [{ label: "Site", value: origin }],
      };
    }
    case BROWSER_TOOL_IDS.click: {
      const origin = originOf(request.url);
      return {
        actionSummary: `Click an element on ${origin}.`,
        targetResource: origin,
        detailLines: [
          { label: "Site", value: origin },
          { label: "Element", value: describeField(request.selector) },
        ],
      };
    }
    case BROWSER_TOOL_IDS.type: {
      const origin = originOf(request.url);
      return {
        actionSummary: `Type into a field on ${origin}.`,
        targetResource: origin,
        detailLines: [
          { label: "Site", value: origin },
          { label: "Field", value: describeField(request.selector) },
          { label: "Characters", value: String(request.text.length) },
        ],
      };
    }
    case BROWSER_TOOL_IDS.select: {
      const origin = originOf(request.url);
      return {
        actionSummary: `Choose an option in a dropdown on ${origin}.`,
        targetResource: origin,
        detailLines: [
          { label: "Site", value: origin },
          { label: "Field", value: describeField(request.selector) },
          { label: "Option value", value: "not shown" },
        ],
      };
    }
    case BROWSER_TOOL_IDS.submit: {
      const origin = originOf(request.url);
      const names = Object.keys(request.fields ?? {});
      return {
        actionSummary: `Fill and submit a form on ${origin}. This sends data to ${origin} and may not be reversible.`,
        targetResource: origin,
        detailLines: [
          { label: "Site", value: origin },
          { label: "Fields", value: describeFields(names) },
          { label: "Submit control", value: describeField(request.selector) },
          { label: "Reversible", value: "No" },
        ],
      };
    }
    case BROWSER_TOOL_IDS.download: {
      const origin = originOf(request.url);
      return {
        actionSummary: `Download a file from ${origin}.`,
        targetResource: origin,
        detailLines: [
          { label: "Site", value: origin },
          { label: "Control", value: describeField(request.selector) },
        ],
      };
    }
    case BROWSER_TOOL_IDS.upload: {
      const origin = originOf(request.url);
      return {
        actionSummary: `Upload a file previously downloaded through JARVIS to ${origin}.`,
        targetResource: origin,
        detailLines: [
          { label: "Site", value: origin },
          { label: "Field", value: describeField(request.selector) },
          { label: "File", value: "a previously downloaded file" },
          { label: "Reversible", value: "No" },
        ],
      };
    }
    case "desktop.screen.read":
      return {
        actionSummary: "Read the screen of the paired Windows desktop.",
        targetResource: "paired Windows desktop",
        detailLines: [
          { label: "Device", value: "paired Windows desktop" },
          {
            label: "Display",
            value: request.display === undefined ? "primary" : String(request.display),
          },
        ],
      };
    case "desktop.input.click":
      return {
        actionSummary: `Click at (${request.x}, ${request.y}) on the paired Windows desktop.`,
        targetResource: "paired Windows desktop",
        detailLines: [
          { label: "Device", value: "paired Windows desktop" },
          { label: "Position", value: `${request.x}, ${request.y}` },
          { label: "Button", value: request.button ?? "left" },
        ],
      };
    case "desktop.input.type":
      return {
        actionSummary: "Type into the focused window on the paired Windows desktop.",
        targetResource: "paired Windows desktop",
        detailLines: [
          { label: "Device", value: "paired Windows desktop" },
          { label: "Characters", value: String(request.text.length) },
          { label: "Text", value: "not shown" },
        ],
      };
    case "desktop.input.key":
      return {
        actionSummary: `Press ${request.key} on the paired Windows desktop.`,
        targetResource: "paired Windows desktop",
        detailLines: [
          { label: "Device", value: "paired Windows desktop" },
          { label: "Key", value: request.key },
        ],
      };
    case "desktop.app.launch": {
      const label = DESKTOP_APP_LABELS[request.app];
      return {
        actionSummary: `Open ${label} on the paired Windows desktop.`,
        targetResource: "paired Windows desktop",
        detailLines: [
          { label: "Device", value: "paired Windows desktop" },
          { label: "Application", value: label },
          { label: "Typing", value: "None. Typing is a separate request." },
        ],
      };
    }
    case "desktop.session.end":
      return {
        actionSummary: "End the desktop control session.",
        targetResource: "paired Windows desktop",
        detailLines: [{ label: "Effect", value: "Control is revoked immediately." }],
      };
  }
}

// ---------------------------------------------------------------------------
// UNKNOWN outcomes — Phase 19.5 (S8)
// ---------------------------------------------------------------------------

/**
 * The one answer to a browser or desktop write whose outcome is not known —
 * the action may have reached the other side. The same sentence the remote
 * browser service gives (`@jarvis/browser-protocol`, UNKNOWN_OUTCOME), so a
 * person is told the same thing wherever the browser runs. Never "failed":
 * that would invite asking again.
 */
export const COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE = "The outcome of the action is unknown; it was not retried.";

/**
 * The answer to the same action asked for again while an earlier attempt's
 * outcome is unknown. Nothing is opened or sent, and the new approval is not
 * spent; whether the first attempt happened is for a person to find out.
 */
export const COMPUTER_CONTROL_ALREADY_UNKNOWN_MESSAGE =
  "This exact action was already attempted and its outcome is unknown, so it was not run again. Check the site before asking for anything that would repeat it.";

// ---------------------------------------------------------------------------
// Value-free records — Phase 19.5 (S3, F3)
// ---------------------------------------------------------------------------

/**
 * The value-free form of a browser or desktop request: what the audit trail
 * and the approval record keep in place of its parameters. The action, the
 * fixed summary sentence, the normalized origin and the summary's detail
 * lines — sanitized field names and counts — and nothing a person typed,
 * selected or submitted, no path, query or fragment, and no artifact id.
 *
 * A request that does not parse keeps only its action and the refusal code:
 * nothing it carried is recorded.
 */
export type ComputerControlValueFreeParams =
  | {
      action: ComputerControlActionId;
      summary: string;
      targetResource?: string;
      details: Array<{ label: string; value: string }>;
    }
  | { action: ComputerControlActionId; refused: true; reason: ComputerControlParseCode };

/** Null for anything that is not a browser or desktop action. */
export function computerControlValueFreeParams(
  action: string,
  params: Record<string, unknown>
): ComputerControlValueFreeParams | null {
  if (!isComputerControlAction(action)) return null;
  const parsed = parseComputerControlRequest({ ...params, action });
  if (!parsed.ok) return { action, refused: true, reason: parsed.code };
  const summary = computerControlApprovalSummary(parsed.value);
  return {
    action,
    summary: summary.actionSummary,
    ...(summary.targetResource ? { targetResource: summary.targetResource } : {}),
    details: summary.detailLines.map(({ label, value }) => ({ label, value })),
  };
}

/** The marker an approval record carries where a request's parameters were. */
export const COMPUTER_CONTROL_APPROVAL_RECORD = "computer-control/v1" as const;

export type ComputerControlApprovalRecord = { withheld: typeof COMPUTER_CONTROL_APPROVAL_RECORD } & ComputerControlValueFreeParams;

/**
 * Whether an approval for this tool keeps its exact parameters out of the
 * approval record (S3). Every browser and desktop action does: even a click's
 * URL can carry a token in its query.
 */
export function sealsApprovalParams(toolId: string): boolean {
  return isComputerControlAction(toolId);
}

/**
 * What an approval record stores for a computer-control action in place of
 * its parameters. Null for any other tool, whose parameters are its own.
 */
export function computerControlApprovalRecord(
  toolId: string,
  params: Record<string, unknown>
): ComputerControlApprovalRecord | null {
  const projection = computerControlValueFreeParams(toolId, params);
  return projection ? { withheld: COMPUTER_CONTROL_APPROVAL_RECORD, ...projection } : null;
}

const STORED_SUMMARY_MAX = 500;
const STORED_LABEL_MAX = 40;
const STORED_VALUE_MAX = 300;
const STORED_DETAILS_MAX = 10;

const StoredApprovalRecordSchema = z
  .object({
    withheld: z.literal(COMPUTER_CONTROL_APPROVAL_RECORD),
    action: z.string(),
    summary: z.string().min(1).max(STORED_SUMMARY_MAX),
    targetResource: z.string().max(STORED_VALUE_MAX).optional(),
    details: z
      .array(z.object({ label: z.string().max(STORED_LABEL_MAX), value: z.string().max(STORED_VALUE_MAX) }).strict())
      .max(STORED_DETAILS_MAX),
  })
  .strict();

/**
 * The one reader of a stored approval record: the summary it was made from,
 * for the approval's own tool, or null. A record is read from the database,
 * so it is checked as untrusted input — its marker, its action, its exact
 * fields and their bounds. A refused request's record, a record for another
 * action, the exact parameters and anything malformed are all null.
 */
export function readComputerControlApprovalRecord(
  toolId: string,
  value: unknown
): ComputerControlApprovalSummary | null {
  const parsed = StoredApprovalRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.action !== toolId || !isComputerControlAction(toolId)) return null;
  return {
    actionSummary: parsed.data.summary,
    ...(parsed.data.targetResource !== undefined ? { targetResource: parsed.data.targetResource } : {}),
    detailLines: parsed.data.details.map(({ label, value: detail }) => ({ label, value: detail })),
  };
}

/**
 * Phase 19.5 — seals a computer-control approval's exact parameters apart
 * from its record, so they can be executed once approved and are never stored
 * in the clear. The API implements it with `EncryptionService` (AES-256-GCM);
 * the store that holds the sealed text deletes it once the approval is
 * rejected, consumed or expired. `unseal` throws on anything it did not seal.
 */
export interface ApprovalParamsSealer {
  seal(plaintext: string): string;
  unseal(sealed: string): string;
}

// ---------------------------------------------------------------------------
// Approval binding — Organization + user + action + canonical hash
// ---------------------------------------------------------------------------

export interface ComputerControlApprovalBinding {
  readonly action: ComputerControlActionId;
  readonly surface: ComputerControlSurface;
  readonly toolId: ComputerControlActionId;
  readonly userId: string;
  /** The owning Organization, resolved by the server from the owner record. */
  readonly tenantId: string;
  /** SHA-256 of the canonical action parameters; no parameter values are here. */
  readonly paramsHash: string;
  readonly summary: ComputerControlApprovalSummary;
}

export type ComputerControlBindingFailureCode =
  | "USER_REQUIRED"
  | "ORGANIZATION_REQUIRED";

export type ComputerControlApprovalBindingResult =
  | { ok: true; value: ComputerControlApprovalBinding }
  | { ok: false; code: ComputerControlBindingFailureCode };

/**
 * Bind a future action's approval to the four facts it must carry.
 *
 * `tenantId` is NOT read from the request. The caller must pass the ID it read
 * from the connection's owner record (`AutomationConnectorOwner`) for this
 * request, exactly as `SharedConnectionAccess` does. A missing or empty ID is
 * refused here as well, so an approval can never be created unbound.
 *
 * The hash covers the action's parameters WITHOUT the `action` key, because
 * that is exactly what a tool receives and what `computeParamsHash(params)`
 * will recompute at execution. The action identity is carried separately by
 * `action`/`toolId`, as the existing `Approval` row carries `toolId`.
 *
 * The returned object contains no parameter values: only the hash and the
 * value-free summary.
 */
export function bindComputerControlApproval(input: {
  request: ComputerControlRequest;
  userId: string;
  tenantId: string;
}): ComputerControlApprovalBindingResult {
  if (typeof input.userId !== "string" || input.userId.trim().length === 0) {
    return { ok: false, code: "USER_REQUIRED" };
  }
  if (typeof input.tenantId !== "string" || input.tenantId.trim().length === 0) {
    return { ok: false, code: "ORGANIZATION_REQUIRED" };
  }

  const policy = COMPUTER_CONTROL_ACTION_POLICY[input.request.action];
  // The action identity is bound separately. The hash must cover exactly the
  // parameters a tool receives, so it matches `computeParamsHash(params)` when
  // the tool consumes the approval.
  const params: Record<string, unknown> = { ...input.request };
  delete params.action;

  return {
    ok: true,
    value: Object.freeze({
      action: input.request.action,
      surface: policy.surface,
      toolId: input.request.action,
      userId: input.userId,
      tenantId: input.tenantId,
      paramsHash: computeParamsHash(params),
      summary: computerControlApprovalSummary(input.request),
    }),
  };
}
