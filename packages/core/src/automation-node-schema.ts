// ---------------------------------------------------------------------------
// Phase 18, Stage 18.5 — the trusted n8n node-schema snapshot: what it is, how
// it is verified, and what a draft's settings may say about it.
//
// WHAT THIS IS. A reduced, offline copy of n8n's own parameter schemas, for
// exactly the node types a JARVIS draft may hold (core's `DRAFT_NODE_CATALOG`
// — twenty-eight types, and no others). It is generated once from a pinned
// upstream package whose hash is checked before it is opened
// (`packages/n8n/scripts/generate-node-schema-snapshot.mjs`), and committed as
// plain data. At run time JARVIS reads that data and nothing else: no network,
// no n8n instance, no credentials, no second schema source.
//
// WHY IT MAY BE TRUSTED. Three things hold, and each of them fails closed:
//   1. INTEGRITY. The snapshot carries the hash of its own reduced content. A
//      file changed by hand does not match, and is refused whole — never
//      partially trusted, never "close enough".
//   2. SHAPE. Everything a rule relies on is checked: bounded counts, bounded
//      text, primitives only, no unknown field reaching a rule.
//   3. SILENCE. A parameter whose options n8n loads dynamically has no option
//      list here, and JARVIS then never claims a value was one of the options.
//
// WHAT IT IS NOT. It is not n8n's behaviour. It says what a parameter is
// called, what shape a value has, whether the upstream schema requires it, and
// which literal values it may take. It runs no node, builds no workflow, and
// never reaches an n8n instance.
//
// ONE PARAMETER, MANY DECLARATIONS. n8n lists a node's properties once per
// operation, so one name is declared several times — `channelId` five times in
// Slack, `operation` four times in Telegram, with a different type and a
// different list of allowed values each time. The rules below therefore read
// one name as the UNION of its declarations: a value is refused only when n8n
// could accept it in no configuration of that parameter, and a name whose
// declarations disagree about the type places no claim at all.
//
// THE ONE IMPLEMENTATION. These rules are core's, so the Automations page's
// router and the model-facing tools answer a draft alike: there is no second
// path that could check a draft more generously than the other.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { DraftContent, DraftIssue } from "./automation-draft.js";
import { containsSecret } from "./utils/redact-secrets.js";

// ---------------------------------------------------------------------------
// The snapshot's shape.
//
// A DECLARATION is one entry of n8n's property list. A PARAMETER is one name,
// read as the union of its declarations — that is what the rules work with.
// ---------------------------------------------------------------------------

/** Where the pinned data came from, and what it must match. */
export interface NodeSchemaSource {
  package: string;
  version: string;
  tarballUrl: string;
  sha512: string;
  sha256: string;
  provenanceUrl: string;
  license: string;
  licenseFile: string;
  /** The hash of the reduced content, over the data itself. */
  contentHash: string;
}

/** One parameter, as n8n declares it once. */
export interface NodeParameterDeclaration {
  name: string;
  type: string;
  /** n8n requires it in the configuration this declaration belongs to. */
  required: boolean;
  /** n8n shows it only in some configurations. */
  conditional: boolean;
  displayName?: string;
  /** The literal values the parameter may take. Absent when n8n loads them dynamically. */
  options?: Array<string | number | boolean>;
  /** Numeric bounds, when the upstream schema declares them. */
  min?: number;
  max?: number;
}

/** One parameter, as the rules read it: one name, every declaration merged. */
export interface NodeParameterSchema {
  name: string;
  /** The type n8n declares, or "mixed" when its declarations disagree. */
  type: string;
  /** n8n requires it in some configuration. */
  required: boolean;
  /** n8n requires it in every configuration it declares. */
  requiredAlways: boolean;
  /** n8n shows it only in some configurations. */
  conditional: boolean;
  displayName?: string;
  /** The literal values the parameter may take, over every declaration. Absent when any declaration loads them dynamically. */
  options?: Array<string | number | boolean>;
  /** The lowest bound any declaration declares. */
  min?: number;
  /** The highest bound any declaration declares. */
  max?: number;
}

/** One node type, as the snapshot holds it. */
export interface NodeTypeDeclaration {
  type: string;
  label: string;
  /** Every version the node declares. */
  versions: string[];
  /** The version this snapshot describes. */
  defaultVersion?: string;
  parameters: NodeParameterDeclaration[];
}

/** One node type, as the rules read it. */
export interface NodeTypeSchema {
  type: string;
  label: string;
  versions: string[];
  defaultVersion?: string;
  /** One entry per parameter name, in n8n's order. */
  parameters: NodeParameterSchema[];
}

/** A node type that could not be reduced. Its validation stays not run. */
export interface NodeSchemaUnsupported {
  type: string;
  reason: string;
}

export interface NodeSchemaSnapshot {
  source: NodeSchemaSource;
  nodes: Record<string, NodeTypeDeclaration>;
  unsupported: NodeSchemaUnsupported[];
}

export interface NodeSchemaRegistry {
  readonly source: NodeSchemaSource;
  readonly nodes: Readonly<Record<string, NodeTypeSchema>>;
  readonly unsupported: readonly NodeSchemaUnsupported[];
  /** The node's pinned schema, or null when the snapshot does not cover it. */
  node(type: string): NodeTypeSchema | null;
  /** The parameter of that node, or null when the node, the version or the parameter is not covered. */
  parameter(type: string, version: string | null, name: string): NodeParameterSchema | null;
}

export const NODE_SCHEMA_LIMITS = {
  /** How many node types one snapshot may hold. */
  nodesMax: 64,
  /** How many declarations one node may hold. */
  declarationsMax: 600,
  /** How many parameters one node may hold after merging. */
  parametersMax: 600,
  /** How many literal options one parameter may hold. */
  optionsMax: 400,
  /** How many versions one node may declare. */
  versionsMax: 64,
  /** How many node types may be listed as unsupported. */
  unsupportedMax: 64,
  /** How long any single piece of text may be. */
  textMax: 240,
  /** How long a URL may be. */
  urlMax: 512,
  /** How many settings one message may name. */
  namedMax: 5,
  /** How many parameters a hint may list. */
  hintParametersMax: 24,
  /** How many option values a hint may carry. */
  hintOptionsMax: 8,
  /** How long an option value in a hint may be. */
  hintOptionMax: 60,
} as const;

/** The prefix the content hash is taken over. Changing it changes every hash. */
export const NODE_SCHEMA_HASH_PREFIX = "n8n-node-schema:v1:";

const NODE_TYPE = /^[a-z0-9][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9]*$/;
const PARAMETER_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const VERSION = /^[0-9]+(\.[0-9]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isPrimitive = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** The messages the check speaks. They say what was checked and what was not. */
export const NODE_SCHEMA_MESSAGES = {
  unavailable: "Not run: no trusted n8n node schema is available to JARVIS, so the settings could not be checked against one.",
  nothingToCheck: "Not run: no setting names a parameter of its node, so there was nothing to check against a schema.",
  uncovered: (types: string[]) => `Not run: ${types.join(", ")} has no pinned schema in JARVIS, so those settings could not be checked.`,
  uncheckedSettings: (names: string[], count: number) =>
    `Not run: ${count} setting${count === 1 ? " names" : "s name"} no parameter of ${count === 1 ? "its" : "their"} node, so ${count === 1 ? "it was" : "they were"} not checked: ${names.join("; ")}.`,
  notAnswered: (names: string[], count: number) =>
    `Not run: ${count} setting${count === 1 ? " has" : "s have"} no answer yet, so ${count === 1 ? "it" : "they"} could not be checked: ${names.join("; ")}.`,
  missing: (names: string[]) => `Not run: the draft does not say ${names.join("; ")}, which n8n's schema requires.`,
  passed: (checked: number, pkg: string, version: string) =>
    `Checked ${checked} setting${checked === 1 ? "" : "s"} against ${pkg} ${version}'s parameter schemas.`,
} as const;

// ---------------------------------------------------------------------------
// Reading the snapshot.
//
// The hash is taken over the data as it was written, before anything is
// interpreted: that is what makes a hand-edited file fail. The shape is then
// checked, and what survives is frozen — a rule can never change the data it
// reads.
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** `messageType` and `message_type` are the same parameter; `chatId` and `chatid` are too. */
function toSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

interface NodeLookup {
  byLower: Map<string, NodeParameterSchema | null>;
  bySnake: Map<string, NodeParameterSchema | null>;
}

/** Two names that differ only in case are ambiguous: neither is used. */
function addTo(map: Map<string, NodeParameterSchema | null>, key: string, parameter: NodeParameterSchema): void {
  if (map.has(key)) {
    map.set(key, null);
    return;
  }
  map.set(key, parameter);
}

function buildLookup(node: NodeTypeSchema): NodeLookup {
  const byLower = new Map<string, NodeParameterSchema | null>();
  const bySnake = new Map<string, NodeParameterSchema | null>();
  for (const parameter of node.parameters) {
    addTo(byLower, parameter.name.toLowerCase(), parameter);
    addTo(bySnake, toSnake(parameter.name), parameter);
  }
  return { byLower, bySnake };
}

/**
 * One parameter name, read as the union of the declarations n8n makes of it.
 *
 * A name is declared once per operation, and each declaration may name a
 * different type and a different list of allowed values. The union is read so
 * that a value is refused only when n8n could accept it in none of them:
 * which operation is in play is what the draft has not said, and the rules do
 * not guess.
 */
function mergeDeclarations(declarations: NodeParameterDeclaration[]): NodeParameterSchema {
  const first = declarations[0]!;
  const types = [...new Set(declarations.map((declaration) => declaration.type))];
  const merged: NodeParameterSchema = {
    name: first.name,
    type: types.length === 1 ? types[0]! : "mixed",
    // Required in some configuration — the person may still have to answer it.
    required: declarations.some((declaration) => declaration.required),
    // Required in every configuration: then it is required of the draft.
    requiredAlways: declarations.every((declaration) => declaration.required),
    // Shown only in some configurations: which one is in play is not said.
    conditional: declarations.some((declaration) => declaration.conditional),
  };
  const displayName = declarations.find((declaration) => declaration.displayName)?.displayName;
  if (displayName !== undefined) merged.displayName = displayName;
  // The allowed values are the union of the declared ones. A declaration that
  // loads its values at run time has no list, and then nothing is claimed
  // about any of them.
  if (declarations.every((declaration) => declaration.options !== undefined)) {
    const union: Array<string | number | boolean> = [];
    for (const declaration of declarations) {
      for (const value of declaration.options!) {
        if (!union.some((seen) => seen === value)) union.push(value);
      }
    }
    if (union.length > 0) merged.options = union;
  }
  const mins = declarations.map((declaration) => declaration.min).filter((value): value is number => typeof value === "number");
  const maxs = declarations.map((declaration) => declaration.max).filter((value): value is number => typeof value === "number");
  if (mins.length > 0) merged.min = Math.min(...mins);
  if (maxs.length > 0) merged.max = Math.max(...maxs);
  return merged;
}

export type NodeSchemaLoadResult = { ok: true; registry: NodeSchemaRegistry } | { ok: false; reason: string };

/**
 * Read a snapshot and decide whether it may be trusted.
 *
 * A snapshot that fails any of these is refused whole: a corrupt file is never
 * half-trusted, because half-trusted would mean claiming a check that did not
 * really run.
 */
export function loadNodeSchemaRegistry(raw: unknown): NodeSchemaLoadResult {
  if (!isObject(raw)) return { ok: false, reason: "the snapshot is not an object" };
  const source = raw.source;
  if (!isObject(source)) return { ok: false, reason: "the snapshot names no source" };

  const sourceFields: Array<[string, number]> = [
    ["package", NODE_SCHEMA_LIMITS.textMax],
    ["version", 32],
    ["tarballUrl", NODE_SCHEMA_LIMITS.urlMax],
    ["sha512", NODE_SCHEMA_LIMITS.urlMax],
    ["sha256", 128],
    ["provenanceUrl", NODE_SCHEMA_LIMITS.urlMax],
    ["license", NODE_SCHEMA_LIMITS.textMax],
    ["licenseFile", NODE_SCHEMA_LIMITS.textMax],
    ["contentHash", 128],
  ];
  for (const [key, max] of sourceFields) {
    if (!isText(source[key], max)) return { ok: false, reason: `the snapshot's source is missing ${key}` };
  }
  if (!SHA256.test(source.contentHash as string)) return { ok: false, reason: "the snapshot's content hash is not a sha-256 digest" };

  const rawNodes = raw.nodes;
  if (!isObject(rawNodes)) return { ok: false, reason: "the snapshot holds no nodes" };
  const nodeKeys = Object.keys(rawNodes);
  if (nodeKeys.length === 0) return { ok: false, reason: "the snapshot holds no node types" };
  if (nodeKeys.length > NODE_SCHEMA_LIMITS.nodesMax) return { ok: false, reason: "the snapshot holds too many node types" };

  const rawUnsupported = raw.unsupported ?? [];
  if (!Array.isArray(rawUnsupported)) return { ok: false, reason: "the snapshot's unsupported list is not a list" };
  if (rawUnsupported.length > NODE_SCHEMA_LIMITS.unsupportedMax) return { ok: false, reason: "the snapshot lists too many unsupported node types" };

  // INTEGRITY, before anything is interpreted: the hash is over the data as it
  // was written. A file that was changed does not match.
  const expected = createHash("sha256").update(`${NODE_SCHEMA_HASH_PREFIX}${JSON.stringify({ nodes: rawNodes, unsupported: rawUnsupported })}`).digest("hex");
  if (expected !== source.contentHash) return { ok: false, reason: "the snapshot's content hash does not match its content" };

  // SHAPE, declaration by declaration.
  const nodes: Record<string, NodeTypeSchema> = {};
  const lookups = new Map<string, NodeLookup>();
  for (const key of nodeKeys) {
    const rawNode = rawNodes[key];
    if (!isObject(rawNode)) return { ok: false, reason: `the snapshot's node ${key} is not an object` };
    if (!isText(rawNode.type, NODE_SCHEMA_LIMITS.textMax) || !NODE_TYPE.test(rawNode.type)) {
      return { ok: false, reason: `the snapshot's node ${key} has no usable type` };
    }
    if (rawNode.type !== key) return { ok: false, reason: `the snapshot's node ${key} names another type` };
    if (!isText(rawNode.label, NODE_SCHEMA_LIMITS.textMax)) return { ok: false, reason: `the snapshot's node ${key} has no label` };
    if (!Array.isArray(rawNode.versions) || rawNode.versions.length > NODE_SCHEMA_LIMITS.versionsMax) {
      return { ok: false, reason: `the snapshot's node ${key} has no usable version list` };
    }
    if (!rawNode.versions.every((version) => typeof version === "string" && VERSION.test(version))) {
      return { ok: false, reason: `the snapshot's node ${key} has an unusable version` };
    }
    if (rawNode.defaultVersion !== undefined && !isText(rawNode.defaultVersion, 32)) {
      return { ok: false, reason: `the snapshot's node ${key} has an unusable default version` };
    }
    if (!Array.isArray(rawNode.parameters) || rawNode.parameters.length > NODE_SCHEMA_LIMITS.declarationsMax) {
      return { ok: false, reason: `the snapshot's node ${key} has no usable parameter list` };
    }
    const declarations: NodeParameterDeclaration[] = [];
    for (const rawParameter of rawNode.parameters) {
      if (!isObject(rawParameter)) return { ok: false, reason: `the snapshot's node ${key} has an unusable parameter` };
      if (!isText(rawParameter.name, 64) || !PARAMETER_NAME.test(rawParameter.name)) {
        return { ok: false, reason: `the snapshot's node ${key} has a parameter with no usable name` };
      }
      if (!isText(rawParameter.type, 64)) return { ok: false, reason: `the snapshot's node ${key} has a parameter with no usable type` };
      if (typeof rawParameter.required !== "boolean" || typeof rawParameter.conditional !== "boolean") {
        return { ok: false, reason: `the snapshot's node ${key} has a parameter with no usable requirement` };
      }
      const declaration: NodeParameterDeclaration = {
        name: rawParameter.name,
        type: rawParameter.type,
        required: rawParameter.required,
        conditional: rawParameter.conditional,
      };
      if (rawParameter.displayName !== undefined) {
        if (!isText(rawParameter.displayName, NODE_SCHEMA_LIMITS.textMax)) {
          return { ok: false, reason: `the snapshot's node ${key} has a parameter with an unusable name` };
        }
        declaration.displayName = rawParameter.displayName;
      }
      if (rawParameter.options !== undefined) {
        if (!Array.isArray(rawParameter.options) || rawParameter.options.length > NODE_SCHEMA_LIMITS.optionsMax) {
          return { ok: false, reason: `the snapshot's node ${key} has a parameter with an unusable option list` };
        }
        if (!rawParameter.options.every(isPrimitive)) {
          return { ok: false, reason: `the snapshot's node ${key} has a parameter with a non-literal option` };
        }
        declaration.options = [...(rawParameter.options as Array<string | number | boolean>)];
      }
      if (rawParameter.min !== undefined) {
        if (typeof rawParameter.min !== "number" || !Number.isFinite(rawParameter.min)) {
          return { ok: false, reason: `the snapshot's node ${key} has a parameter with an unusable lower bound` };
        }
        declaration.min = rawParameter.min;
      }
      if (rawParameter.max !== undefined) {
        if (typeof rawParameter.max !== "number" || !Number.isFinite(rawParameter.max)) {
          return { ok: false, reason: `the snapshot's node ${key} has a parameter with an unusable upper bound` };
        }
        declaration.max = rawParameter.max;
      }
      declarations.push(declaration);
    }

    // One name, many declarations: merged into the parameter the rules read.
    const byName = new Map<string, NodeParameterDeclaration[]>();
    for (const declaration of declarations) {
      const group = byName.get(declaration.name);
      if (group) group.push(declaration);
      else byName.set(declaration.name, [declaration]);
    }
    const parameters: NodeParameterSchema[] = [];
    for (const group of byName.values()) parameters.push(mergeDeclarations(group));
    if (parameters.length > NODE_SCHEMA_LIMITS.parametersMax) {
      return { ok: false, reason: `the snapshot's node ${key} holds too many parameters` };
    }

    const node: NodeTypeSchema = {
      type: rawNode.type,
      label: rawNode.label,
      versions: [...(rawNode.versions as string[])],
      parameters,
    };
    if (rawNode.defaultVersion !== undefined) node.defaultVersion = rawNode.defaultVersion;
    nodes[key] = node;
    lookups.set(key, buildLookup(node));
  }

  const unsupported: NodeSchemaUnsupported[] = [];
  for (const entry of rawUnsupported) {
    if (!isObject(entry) || !isText(entry.type, NODE_SCHEMA_LIMITS.textMax) || !isText(entry.reason, NODE_SCHEMA_LIMITS.textMax)) {
      return { ok: false, reason: "the snapshot's unsupported list is unusable" };
    }
    unsupported.push({ type: entry.type, reason: entry.reason });
  }

  const frozenSource = deepFreeze({ ...(source as unknown as NodeSchemaSource) });
  const frozenNodes = deepFreeze(nodes);
  const frozenUnsupported = deepFreeze(unsupported);

  const registry: NodeSchemaRegistry = {
    source: frozenSource,
    nodes: frozenNodes,
    unsupported: frozenUnsupported,
    node(type: string): NodeTypeSchema | null {
      return Object.prototype.hasOwnProperty.call(frozenNodes, type) ? frozenNodes[type]! : null;
    },
    parameter(type: string, version: string | null, name: string): NodeParameterSchema | null {
      const node = registry.node(type);
      if (!node) return null;
      // The snapshot describes one version. A version it does not describe is
      // not covered, and is never guessed at.
      if (version !== null && node.defaultVersion !== undefined && version !== node.defaultVersion) return null;
      const lookup = lookups.get(node.type);
      if (!lookup) return null;
      const key = name.toLowerCase();
      return lookup.bySnake.get(key) ?? lookup.byLower.get(key) ?? null;
    },
  };
  deepFreeze(registry);
  return { ok: true, registry };
}

// ---------------------------------------------------------------------------
// What a value may be.
//
// A draft holds plain words. These rules are the second line: the parser has
// already refused an expression, a secret or a link, and a value that reaches
// here from anywhere else is refused again.
// ---------------------------------------------------------------------------

const EXPRESSION = /\{\{|\}\}|\$(?:env|secrets|vars|execution|workflow|json|node|input)\b|^\s*=/i;

/** The type whose options are the values the parameter may take. */
const VALUE_LIST_TYPE = "options";

/**
 * The types that hold a credential.
 *
 * A credential is chosen in n8n, never written down. A draft that carries a
 * value for one of these is refused outright — there is nothing to validate
 * and nothing to keep.
 */
const CREDENTIAL_TYPES = new Set(["credentials", "credentialsSelect"]);

/**
 * Check one value against one parameter.
 *
 * The rules are only as strong as the evidence: a parameter whose options n8n
 * loads dynamically has no list here, and then nothing is claimed about the
 * value's membership. A name whose declarations disagree about the type
 * places no claim about the type either.
 */
export function validateParameterValue(parameter: NodeParameterSchema, value: string, path: string): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const label = parameter.displayName ?? parameter.name;
  if (EXPRESSION.test(value)) {
    issues.push({
      code: "EXPRESSION_REFUSED",
      path,
      message: `«${label}» holds an n8n expression. Drafts hold plain words; expressions are written in n8n.`,
    });
    return issues;
  }
  // A credential is chosen in n8n, never written down. A draft that carries a
  // value for one of these is refused outright — there is nothing to validate
  // and nothing to keep.
  if (CREDENTIAL_TYPES.has(parameter.type)) {
    issues.push({
      code: "CREDENTIAL_REFUSED",
      path,
      message: `«${label}» is a credential. A draft never holds a credential; choose it in n8n.`,
    });
    return issues;
  }
  if (containsSecret(value)) {
    issues.push({
      code: "SECRET_REFUSED",
      path,
      message: `«${label}» holds something shaped like a secret or a credential. Drafts hold no secrets.`,
    });
    return issues;
  }

  const text = value.trim();
  if (parameter.type === "number") {
    const parsed = Number(text);
    if (text.length === 0 || !Number.isFinite(parsed)) {
      issues.push({ code: "INVALID_PARAMETER_TYPE", path, message: `«${label}» is a number, and "${value}" is not one.` });
      return issues;
    }
    if (typeof parameter.min === "number" && parsed < parameter.min) {
      issues.push({ code: "PARAMETER_OUT_OF_RANGE", path, message: `«${label}» must be ${parameter.min} or more.` });
    }
    if (typeof parameter.max === "number" && parsed > parameter.max) {
      issues.push({ code: "PARAMETER_OUT_OF_RANGE", path, message: `«${label}» must be ${parameter.max} or less.` });
    }
    return issues;
  }

  if (parameter.type === "boolean") {
    if (!/^(true|false)$/i.test(text)) {
      issues.push({ code: "INVALID_PARAMETER_TYPE", path, message: `«${label}» is true or false, and "${value}" is neither.` });
    }
    return issues;
  }

  if (parameter.type === VALUE_LIST_TYPE) {
    const options = parameter.options;
    // No list means n8n loads the options at run time. Nothing is claimed.
    if (!options) return issues;
    if (!options.some((option) => String(option) === text)) {
      const shown = options.slice(0, 8).map((option) => String(option));
      issues.push({
        code: "INVALID_PARAMETER_OPTION",
        path,
        message: `«${label}» is one of: ${shown.join(", ")}${options.length > shown.length ? ", …" : ""}.`,
      });
    }
    return issues;
  }

  // `multiOptions` holds several values, and a draft holds one plain answer:
  // membership is not claimed. `collection`, `fixedCollection`, `json` and
  // `resourceLocator` hold a structure, which a draft does not hold: nothing is
  // claimed about them either. A plain text parameter has nothing to check
  // beyond the draft's own rules. A name whose declarations disagree about the
  // type places no claim at all.
  return issues;
}

// ---------------------------------------------------------------------------
// The check.
//
// A SETTING IS A CLAIM when its key names a parameter of its own node. That is
// the only thing a draft says about a node's configuration, so that is the
// only thing that can be checked.
//
// A claim that names no parameter is not a defect — it may be a question a
// person has to answer — but it is not checked either, and the check then says
// so instead of passing.
// ---------------------------------------------------------------------------

/** The keys JARVIS itself uses. They are not n8n parameters. */
const INTERNAL_SETTING_KEYS = new Set(["credential", "which_node"]);

export type DraftSchemaStatus = "passed" | "failed" | "pending" | "not_run";

export interface DraftSchemaResult {
  status: DraftSchemaStatus;
  message: string;
  issues: DraftIssue[];
  /** Settings that named a parameter and were checked against it. */
  checked: number;
  /** Settings that named no parameter, and so were not checked. */
  unchecked: number;
}

/**
 * Check a draft's settings against the pinned schemas.
 *
 * The outcomes, in the order they are decided:
 *   failed    a value is not valid for the parameter it names.
 *   not_run   a node type has no pinned schema, so the check could not run
 *             for it at all.
 *   not_run   a setting names no parameter, has no answer yet, or a parameter
 *             n8n always requires is not said at all: the configuration is
 *             not described, so it could not be checked.
 *   passed    every claim was checked, every always-required parameter was
 *             said, and every one of the values holds.
 *
 * A check that did not run is never reported as passed.
 */
export function checkDraftConfiguration(content: DraftContent, registry: NodeSchemaRegistry | null): DraftSchemaResult {
  const issues: DraftIssue[] = [];
  if (!registry) return { status: "not_run", message: NODE_SCHEMA_MESSAGES.unavailable, issues, checked: 0, unchecked: 0 };

  const live = content.nodes.filter((node) => !node.remove);
  if (live.length === 0) return { status: "not_run", message: NODE_SCHEMA_MESSAGES.nothingToCheck, issues, checked: 0, unchecked: 0 };

  const uncovered: string[] = [];
  const uncheckedNames: string[] = [];
  const unansweredNames: string[] = [];
  const missing: string[] = [];
  let checked = 0;
  let unchecked = 0;
  let unanswered = 0;

  for (const node of live) {
    const schema = registry.node(node.type);
    if (!schema) {
      if (!uncovered.includes(node.type)) uncovered.push(node.type);
      continue;
    }
    // A node of the source workflow keeps the configuration it already has;
    // only what the draft proposes is checked here.
    if (node.origin !== "added") continue;

    const claimed = new Set<string>();
    for (const setting of node.settings) {
      // A credential and an "in n8n" setting hold no value here, and JARVIS's
      // own keys are not n8n parameters.
      if (setting.kind !== "value") continue;
      if (INTERNAL_SETTING_KEYS.has(setting.key)) continue;
      const parameter = registry.parameter(node.type, schema.defaultVersion ?? null, setting.key);
      if (!parameter) {
        // It may be a question a person has to answer. It is not a defect,
        // but it is not checked either.
        unchecked += 1;
        if (uncheckedNames.length < NODE_SCHEMA_LIMITS.namedMax) uncheckedNames.push(`${node.label}: ${setting.key}`);
        continue;
      }
      claimed.add(parameter.name);
      if (setting.value === null) {
        // Nothing to check until it is answered. A parameter n8n requires in
        // some configuration is one the person still owes an answer.
        if (parameter.required) {
          unanswered += 1;
          if (unansweredNames.length < NODE_SCHEMA_LIMITS.namedMax) unansweredNames.push(`${node.label}: ${setting.key}`);
        }
        continue;
      }
      issues.push(...validateParameterValue(parameter, setting.value, `${node.key}.${setting.key}`));
      checked += 1;
    }
    // A parameter n8n requires in every configuration it declares, and the
    // draft does not say: this node's configuration is not described, so it
    // could not be checked.
    for (const parameter of schema.parameters) {
      if (!parameter.requiredAlways || parameter.conditional) continue;
      if (claimed.has(parameter.name)) continue;
      missing.push(`${node.label}: ${parameter.displayName ?? parameter.name}`);
    }
  }

  if (issues.length > 0) {
    return { status: "failed", message: issues[0]!.message, issues, checked, unchecked };
  }
  if (uncovered.length > 0) {
    return { status: "not_run", message: NODE_SCHEMA_MESSAGES.uncovered(uncovered.slice(0, NODE_SCHEMA_LIMITS.namedMax)), issues, checked, unchecked };
  }
  if (unchecked > 0) {
    return { status: "not_run", message: NODE_SCHEMA_MESSAGES.uncheckedSettings(uncheckedNames, unchecked), issues, checked, unchecked };
  }
  if (unanswered > 0) {
    return { status: "not_run", message: NODE_SCHEMA_MESSAGES.notAnswered(unansweredNames, unanswered), issues, checked, unchecked };
  }
  if (checked === 0) {
    return { status: "not_run", message: NODE_SCHEMA_MESSAGES.nothingToCheck, issues, checked, unchecked };
  }
  if (missing.length > 0) {
    return { status: "not_run", message: NODE_SCHEMA_MESSAGES.missing(missing.slice(0, NODE_SCHEMA_LIMITS.namedMax)), issues, checked, unchecked };
  }
  return {
    status: "passed",
    message: NODE_SCHEMA_MESSAGES.passed(checked, registry.source.package, registry.source.version),
    issues,
    checked,
    unchecked,
  };
}

// ---------------------------------------------------------------------------
// The bounded summary.
//
// What a surface may show: which parameters a node has, by name, and the
// literal values the ones n8n requires may take. Never the whole schema, never
// an option list of any length, never a bound.
// ---------------------------------------------------------------------------

export interface DraftSchemaHint {
  /** The draft's node key. */
  nodeKey: string;
  type: string;
  label: string;
  /** The version the pinned schema describes, when it has one. */
  version: string | null;
  /** How many parameters the schema holds. */
  parameterCount: number;
  /** The parameters a setting may name. Bounded. */
  parameters: Array<{ name: string; type: string; required: boolean; options?: string[] }>;
}

/** The hint for one node, or null when the snapshot does not cover it. */
export function summarizeNodeSchema(
  registry: NodeSchemaRegistry | null,
  type: string
): { label: string; version: string | null; parameterCount: number; parameters: DraftSchemaHint["parameters"] } | null {
  if (!registry) return null;
  const node = registry.node(type);
  if (!node) return null;
  const parameters: DraftSchemaHint["parameters"] = [];
  for (const parameter of node.parameters) {
    if (parameters.length >= NODE_SCHEMA_LIMITS.hintParametersMax) break;
    const hint: DraftSchemaHint["parameters"][number] = { name: parameter.name, type: parameter.type, required: parameter.required };
    if (parameter.options && parameter.options.length > 0 && parameter.type === VALUE_LIST_TYPE) {
      hint.options = parameter.options
        .slice(0, NODE_SCHEMA_LIMITS.hintOptionsMax)
        .map((option) => String(option).slice(0, NODE_SCHEMA_LIMITS.hintOptionMax));
    }
    parameters.push(hint);
  }
  return { label: node.label, version: node.defaultVersion ?? null, parameterCount: node.parameters.length, parameters };
}

/** The hints for a draft's live nodes. Bounded: one per node, each bounded. */
export function draftSchemaHints(content: DraftContent, registry: NodeSchemaRegistry | null): DraftSchemaHint[] {
  if (!registry) return [];
  const hints: DraftSchemaHint[] = [];
  for (const node of content.nodes) {
    if (node.remove) continue;
    const summary = summarizeNodeSchema(registry, node.type);
    if (!summary) continue;
    hints.push({ nodeKey: node.key, type: node.type, label: summary.label, version: summary.version, parameterCount: summary.parameterCount, parameters: summary.parameters });
  }
  return hints;
}
