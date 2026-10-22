// ---------------------------------------------------------------------------
// Phase 18, Stage 18.5 — the trusted n8n node-schema snapshot: how it is read,
// and what a draft's settings may say about it.
//
// Proven here:
//   - the snapshot is read only whole: a file whose content does not match its
//     own hash, or whose shape is not the shape the rules need, is refused and
//     nothing is checked against it;
//   - what survives is frozen, so no rule can change the data it reads;
//   - one name declared many times is read as the union of its declarations, and
//     a name whose declarations disagree places no claim;
//   - a value is refused when it is not one n8n could accept, and nothing is
//     claimed when n8n's list of values is not in the snapshot;
//   - a check that could not run is said, never passed: a node type with no
//     pinned schema, a setting that names no parameter, a setting with no
//     answer, a parameter n8n always requires that the draft does not say;
//   - an expression, a secret and a credential are refused wherever they come
//     from;
//   - the check is the same one the draft's own evaluation uses, and a draft
//     whose configuration fails is invalid, never validated.
//
// Pure rules; named `automation-library*` so CI's core slice runs it.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NODE_SCHEMA_HASH_PREFIX,
  NODE_SCHEMA_LIMITS,
  applyDraftAnswers,
  buildDraftContent,
  checkDraftConfiguration,
  draftSchemaHints,
  evaluateDraft,
  loadNodeSchemaRegistry,
  summarizeNodeSchema,
  validateAutomationRequest,
  validateParameterValue,
  type AutomationRequest,
  type DraftContent,
  type NodeParameterSchema,
  type NodeSchemaRegistry,
  type NodeSchemaSnapshot,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// A fixture: a snapshot small enough to reason about, built the way the
// generator builds the real one — the hash is taken over the data as written.
// ---------------------------------------------------------------------------

const FIXTURE_NODES = {
  "n8n-nodes-base.webhook": {
    type: "n8n-nodes-base.webhook",
    label: "Webhook",
    versions: ["2.1"],
    defaultVersion: "2.1",
    parameters: [{ name: "path", type: "string", required: false, conditional: false, displayName: "Path" }],
  },
  "n8n-nodes-base.slack": {
    type: "n8n-nodes-base.slack",
    label: "Slack",
    versions: ["1", "2.4"],
    defaultVersion: "2.4",
    parameters: [
      { name: "resource", type: "options", required: false, conditional: false, displayName: "Resource", options: ["message", "channel"] },
      // The same name, declared twice with different lists: one parameter.
      { name: "operation", type: "options", required: false, conditional: true, displayName: "Operation", options: ["post", "reply"] },
      { name: "operation", type: "options", required: false, conditional: true, displayName: "Operation", options: ["delete"] },
      // The same name, declared with two different types: no claim about either.
      { name: "channelId", type: "string", required: true, conditional: true, displayName: "Channel" },
      { name: "channelId", type: "resourceLocator", required: false, conditional: true },
      { name: "startIndex", type: "number", required: false, conditional: true, displayName: "Start index", min: 1 },
      { name: "startIndex", type: "string", required: false, conditional: true },
      { name: "limit", type: "number", required: false, conditional: true, displayName: "Limit", min: 1, max: 100 },
      { name: "notify", type: "boolean", required: false, conditional: false, displayName: "Notify" },
      { name: "slackApi", type: "credentials", required: false, conditional: false, displayName: "Slack account" },
      // A value n8n loads at run time: no list, so no claim about membership.
      { name: "select", type: "multiOptions", required: false, conditional: false, displayName: "Channel" },
    ],
  },
  "n8n-nodes-base.httpRequest": {
    type: "n8n-nodes-base.httpRequest",
    label: "HTTP request",
    versions: ["4.4"],
    defaultVersion: "4.4",
    parameters: [
      { name: "method", type: "options", required: false, conditional: false, displayName: "Method", options: ["GET", "POST"] },
      { name: "url", type: "string", required: true, conditional: false, displayName: "URL" },
    ],
  },
} as const;

function snapshotOf(nodes: unknown, unsupported: unknown = []): NodeSchemaSnapshot {
  const contentHash = createHash("sha256").update(`${NODE_SCHEMA_HASH_PREFIX}${JSON.stringify({ nodes, unsupported })}`).digest("hex");
  return {
    source: {
      package: "n8n-nodes-base",
      version: "2.15.1",
      tarballUrl: "https://registry.npmjs.org/n8n-nodes-base/-/n8n-nodes-base-2.15.1.tgz",
      sha512: "E4/vb8sBb4tzZSFoBAP2EigAHSc3uEn52RdfyTu1C7xPBNLYDfw5y5OxvMmHBQ8of9YQwcK9AQsoEsggyu7ztQ==",
      sha256: "43e200c1cbe1c4a9f967efa079facb00cc3cbe51ede23c9a3cfc66c9a4051406",
      provenanceUrl: "https://registry.npmjs.org/-/npm/v1/attestations/n8n-nodes-base@2.15.1",
      license: "Sustainable Use License v1.0",
      licenseFile: "node-schema-LICENSE.md",
      contentHash,
    },
    nodes: nodes as NodeSchemaSnapshot["nodes"],
    unsupported: unsupported as NodeSchemaSnapshot["unsupported"],
  };
}

function registryOf(nodes: unknown = FIXTURE_NODES, unsupported: unknown = []): NodeSchemaRegistry {
  const loaded = loadNodeSchemaRegistry(snapshotOf(nodes, unsupported));
  if (!loaded.ok) throw new Error(`the fixture was refused: ${loaded.reason}`);
  return loaded.registry;
}

// ---------------------------------------------------------------------------
// Drafts.
// ---------------------------------------------------------------------------

function request(input: Record<string, unknown>): AutomationRequest {
  const read = validateAutomationRequest(input);
  if (!read.ok) throw new Error(read.code);
  return read.value;
}

const ASK = request({ goal: "When a lead arrives, post it to Slack", services: ["Slack"] });

function draft(nodes: Array<Record<string, unknown>>): DraftContent {
  const built = buildDraftContent({
    kind: "new",
    title: "Leads",
    request: ASK,
    source: null,
    graph: {
      nodes,
      // The steps are chained, so every node is reached.
      connections: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.key, to: node.key })),
    },
  });
  if (!built.ok) throw new Error(built.issues.map((issue) => issue.code).join(", "));
  return built.content;
}

const TRIGGER = { key: "trigger", type: "n8n-nodes-base.webhook" };

function slackDraft(settings: Array<Record<string, unknown>>): DraftContent {
  return draft([TRIGGER, { key: "slack", type: "n8n-nodes-base.slack", settings }]);
}

const setting = (key: string, value: string | null): Record<string, unknown> => ({ key, label: key, kind: "value", value });

// ---------------------------------------------------------------------------

describe("the snapshot is read only whole", () => {
  it("refuses a file whose content does not match its own hash", () => {
    const snapshot = snapshotOf(FIXTURE_NODES);
    const tampered = {
      ...snapshot,
      nodes: {
        ...snapshot.nodes,
        "n8n-nodes-base.slack": { ...snapshot.nodes["n8n-nodes-base.slack"], label: "Somewhere else" },
      },
    };
    const loaded = loadNodeSchemaRegistry(tampered);
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? "" : loaded.reason).toMatch(/content hash/);
  });

  it("refuses a file whose hash is not a digest of its content", () => {
    const snapshot = snapshotOf(FIXTURE_NODES);
    const loaded = loadNodeSchemaRegistry({ ...snapshot, source: { ...snapshot.source, contentHash: "0".repeat(64) } });
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? "" : loaded.reason).toMatch(/content hash/);
  });

  it("refuses anything that is not a snapshot at all", () => {
    for (const bad of [null, undefined, "nope", 42, [], {}, { source: {} }, { source: snapshotOf(FIXTURE_NODES).source }]) {
      expect(loadNodeSchemaRegistry(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses a snapshot whose shape is not the shape the rules need", () => {
    const cases: Array<[string, unknown]> = [
      ["a node that is not an object", { "n8n-nodes-base.slack": "Slack" }],
      ["a node whose type does not match its key", { "n8n-nodes-base.slack": { ...FIXTURE_NODES["n8n-nodes-base.slack"], type: "n8n-nodes-base.gmail" } }],
      ["a node with no label", { "n8n-nodes-base.slack": { ...FIXTURE_NODES["n8n-nodes-base.slack"], label: "" } }],
      ["a node with an unusable version", { "n8n-nodes-base.slack": { ...FIXTURE_NODES["n8n-nodes-base.slack"], versions: ["two"] } }],
      ["a parameter with no name", { "n8n-nodes-base.slack": { ...FIXTURE_NODES["n8n-nodes-base.slack"], parameters: [{ type: "string", required: false, conditional: false }] } }],
      ["a parameter with no type", { "n8n-nodes-base.slack": { ...FIXTURE_NODES["n8n-nodes-base.slack"], parameters: [{ name: "text", required: false, conditional: false }] } }],
      ["a parameter with no requirement", { "n8n-nodes-base.slack": { ...FIXTURE_NODES["n8n-nodes-base.slack"], parameters: [{ name: "text", type: "string", conditional: false }] } }],
      ["a parameter with a non-literal option", { "n8n-nodes-base.slack": { ...FIXTURE_NODES["n8n-nodes-base.slack"], parameters: [{ name: "text", type: "options", required: false, conditional: false, options: [{ value: { nested: true } }] }] } }],
      ["a parameter with an unusable bound", { "n8n-nodes-base.slack": { ...FIXTURE_NODES["n8n-nodes-base.slack"], parameters: [{ name: "text", type: "number", required: false, conditional: false, min: "one" }] } }],
    ];
    for (const [name, nodes] of cases) {
      const loaded = loadNodeSchemaRegistry(snapshotOf(nodes));
      expect(loaded.ok, name).toBe(false);
    }
  });

  it("refuses a snapshot whose unsupported list is not a list", () => {
    const loaded = loadNodeSchemaRegistry(snapshotOf(FIXTURE_NODES, "nope"));
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? "" : loaded.reason).toMatch(/unsupported list/);
  });

  it("refuses a snapshot that holds no node type at all", () => {
    const loaded = loadNodeSchemaRegistry(snapshotOf({}));
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? "" : loaded.reason).toMatch(/no node types/);
  });

  it("holds what it read frozen, so no rule can change it", () => {
    const registry = registryOf();
    expect(Object.isFrozen(registry.nodes)).toBe(true);
    expect(Object.isFrozen(registry.nodes["n8n-nodes-base.slack"])).toBe(true);
    expect(Object.isFrozen(registry.nodes["n8n-nodes-base.slack"]!.parameters[0])).toBe(true);
    expect(Object.isFrozen(registry.source)).toBe(true);
  });
});

describe("one name, many declarations", () => {
  it("reads one name once, as the union of its declarations", () => {
    const registry = registryOf();
    const slack = registry.node("n8n-nodes-base.slack")!;
    const names = slack.parameters.map((parameter) => parameter.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("operation");
    // The values of one parameter are the union of the declared lists.
    expect(registry.parameter("n8n-nodes-base.slack", null, "operation")!.options).toEqual(["post", "reply", "delete"]);
  });

  it("places no claim about a name whose declarations disagree", () => {
    const registry = registryOf();
    const channelId = registry.parameter("n8n-nodes-base.slack", null, "channelId")!;
    expect(channelId.type).toBe("mixed");
    // A name n8n requires in one configuration is not required of the draft.
    expect(channelId.required).toBe(true);
    expect(channelId.requiredAlways).toBe(false);
    // A value of any shape is then accepted: nothing is claimed about it.
    expect(validateParameterValue(channelId, "C0123", "slack.channelId")).toEqual([]);
  });

  it("reads a parameter that is required in every configuration as required", () => {
    const registry = registryOf();
    const url = registry.parameter("n8n-nodes-base.httpRequest", null, "url")!;
    expect(url.required).toBe(true);
    expect(url.requiredAlways).toBe(true);
    expect(url.conditional).toBe(false);
  });

  it("finds a parameter by its name, in any case, and by its snake form", () => {
    const registry = registryOf();
    expect(registry.parameter("n8n-nodes-base.slack", null, "channelId")?.name).toBe("channelId");
    expect(registry.parameter("n8n-nodes-base.slack", null, "channelid")?.name).toBe("channelId");
    expect(registry.parameter("n8n-nodes-base.slack", null, "channel_id")?.name).toBe("channelId");
    expect(registry.parameter("n8n-nodes-base.slack", null, "nothing")?.name).toBeUndefined();
  });

  it("does not read a version the snapshot does not describe", () => {
    const registry = registryOf();
    expect(registry.parameter("n8n-nodes-base.slack", "2.4", "resource")?.name).toBe("resource");
    expect(registry.parameter("n8n-nodes-base.slack", "1", "resource")).toBeNull();
  });

  it("does not read a node type the snapshot does not cover", () => {
    const registry = registryOf();
    expect(registry.node("n8n-nodes-base.gmail")).toBeNull();
    expect(registry.parameter("n8n-nodes-base.gmail", null, "resource")).toBeNull();
  });
});

describe("what a value may be", () => {
  const registry = registryOf();
  const parameter = (name: string): NodeParameterSchema => registry.parameter("n8n-nodes-base.slack", null, name)!;

  it("refuses a value that is not one of the declared values", () => {
    const issues = validateParameterValue(parameter("resource"), "telegram", "slack.resource");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "INVALID_PARAMETER_OPTION", path: "slack.resource" });
    expect(issues[0]!.message).toMatch(/message, channel/);
  });

  it("accepts a value n8n declares, and only from the union of the declarations", () => {
    expect(validateParameterValue(parameter("resource"), "message", "slack.resource")).toEqual([]);
    expect(validateParameterValue(parameter("operation"), "delete", "slack.operation")).toEqual([]);
  });

  it("claims nothing about a value whose list n8n loads at run time", () => {
    expect(validateParameterValue(parameter("select"), "not-a-real-channel", "slack.select")).toEqual([]);
  });

  it("refuses a value that is not the shape the parameter asks for", () => {
    expect(validateParameterValue(parameter("limit"), "many", "slack.limit")[0]).toMatchObject({ code: "INVALID_PARAMETER_TYPE" });
    expect(validateParameterValue(parameter("notify"), "perhaps", "slack.notify")[0]).toMatchObject({ code: "INVALID_PARAMETER_TYPE" });
    expect(validateParameterValue(parameter("notify"), "true", "slack.notify")).toEqual([]);
  });

  it("refuses a value outside the bounds the schema declares", () => {
    expect(validateParameterValue(parameter("limit"), "0", "slack.limit")[0]).toMatchObject({ code: "PARAMETER_OUT_OF_RANGE" });
    expect(validateParameterValue(parameter("limit"), "500", "slack.limit")[0]).toMatchObject({ code: "PARAMETER_OUT_OF_RANGE" });
    expect(validateParameterValue(parameter("limit"), "50", "slack.limit")).toEqual([]);
  });

  it("refuses an expression, a secret and a credential, wherever they come from", () => {
    expect(validateParameterValue(parameter("resource"), "{{ $json.text }}", "slack.resource")[0]).toMatchObject({ code: "EXPRESSION_REFUSED" });
    expect(validateParameterValue(parameter("resource"), "=$env.TOKEN", "slack.resource")[0]).toMatchObject({ code: "EXPRESSION_REFUSED" });
    // A synthetic placeholder, not a credential: the label is what the
    // detector looks for, and the value says plainly that it is redacted.
    expect(validateParameterValue(parameter("resource"), "token=REDACTED", "slack.resource")[0]).toMatchObject({ code: "SECRET_REFUSED" });
    expect(validateParameterValue(parameter("slackApi"), "token=REDACTED", "slack.slackApi")[0]).toMatchObject({ code: "CREDENTIAL_REFUSED" });
  });
});

describe("the check", () => {
  const registry = registryOf();

  it("passes when every claim was checked and holds", () => {
    const result = checkDraftConfiguration(slackDraft([setting("resource", "message")]), registry);
    expect(result.status).toBe("passed");
    expect(result.checked).toBe(1);
    expect(result.unchecked).toBe(0);
    expect(result.message).toMatch(/Checked 1 setting against n8n-nodes-base 2\.15\.1/);
  });

  it("fails a value n8n could not accept", () => {
    const result = checkDraftConfiguration(slackDraft([setting("resource", "telegram")]), registry);
    expect(result.status).toBe("failed");
    expect(result.issues[0]).toMatchObject({ code: "INVALID_PARAMETER_OPTION" });
  });

  it("does not claim a check it could not run: a node type with no pinned schema", () => {
    const content = draft([TRIGGER, { key: "slack", type: "n8n-nodes-base.gmail", settings: [setting("resource", "message")] }]);
    const result = checkDraftConfiguration(content, registry);
    expect(result.status).toBe("not_run");
    expect(result.message).toMatch(/n8n-nodes-base\.gmail has no pinned schema/);
  });

  it("does not claim a check it could not run: a setting that names no parameter", () => {
    const result = checkDraftConfiguration(slackDraft([setting("channel", "#general")]), registry);
    expect(result.status).toBe("not_run");
    expect(result.unchecked).toBe(1);
    expect(result.checked).toBe(0);
    expect(result.message).toMatch(/names no parameter of its node/);
  });

  it("does not claim a check it could not run: a setting with no answer yet", () => {
    const result = checkDraftConfiguration(slackDraft([setting("channel_id", null)]), registry);
    expect(result.status).toBe("not_run");
    expect(result.message).toMatch(/no answer yet/);
  });

  it("does not claim a check it could not run: a parameter n8n always requires that the draft does not say", () => {
    const content = draft([
      TRIGGER,
      { key: "slack", type: "n8n-nodes-base.slack", settings: [setting("resource", "message")] },
      { key: "http", type: "n8n-nodes-base.httpRequest", settings: [setting("method", "GET")] },
    ]);
    const result = checkDraftConfiguration(content, registry);
    expect(result.status).toBe("not_run");
    expect(result.message).toMatch(/the draft does not say HTTP request: URL/);
  });

  it("says there was nothing to check when no setting names a parameter", () => {
    const result = checkDraftConfiguration(slackDraft([]), registry);
    expect(result.status).toBe("not_run");
    expect(result.message).toMatch(/there was nothing to check/);
  });

  it("has no schema at all to check against", () => {
    const result = checkDraftConfiguration(slackDraft([setting("resource", "message")]), null);
    expect(result.status).toBe("not_run");
    expect(result.message).toMatch(/no trusted n8n node schema/);
  });

  it("does not treat JARVIS's own keys as parameters", () => {
    const content = slackDraft([
      { key: "credential", label: "Slack account", kind: "credential", value: null },
      { key: "which_node", label: "Which node", kind: "value", value: null },
    ]);
    const result = checkDraftConfiguration(content, registry);
    expect(result.status).toBe("not_run");
    expect(result.unchecked).toBe(0);
    expect(result.checked).toBe(0);
  });

  it("checks what the draft proposes, and not the source workflow's own nodes", () => {
    const content: DraftContent = {
      ...slackDraft([setting("resource", "message")]),
      nodes: [
        { key: "trigger", type: "n8n-nodes-base.webhook", label: "Webhook", origin: "source", remove: false, settings: [] },
        { key: "slack", type: "n8n-nodes-base.slack", label: "Slack", origin: "added", remove: false, settings: [setting("resource", "message")] },
      ],
    };
    expect(checkDraftConfiguration(content, registry).status).toBe("passed");
  });
});

describe("the draft's own evaluation", () => {
  const registry = registryOf();

  /** The draft with every question answered, so nothing but the schema can hold it back. */
  function answered(content: DraftContent): DraftContent {
    const answers: Record<string, string> = {};
    for (const question of content.questions) answers[`question.${question.key}`] = "An answer";
    const applied = applyDraftAnswers(content, answers);
    if (!applied.ok) throw new Error(applied.issues.map((issue) => issue.code).join(", "));
    return applied.content;
  }

  it("runs the configuration check when the server holds the schema, and says so when it does not", () => {
    const content = answered(slackDraft([setting("resource", "message")]));
    const withSchema = evaluateDraft(content, { scopeVerified: true }, registry);
    expect(withSchema.checks.find((check) => check.id === "configuration_schema")).toMatchObject({ status: "passed" });
    const without = evaluateDraft(content, { scopeVerified: true });
    expect(without.checks.find((check) => check.id === "configuration_schema")).toMatchObject({ status: "not_run" });
  });

  it("never marks a draft validated while a check did not run", () => {
    const content = answered(slackDraft([setting("resource", "message")]));
    // Every other check passes; only the configuration check is missing.
    expect(evaluateDraft(content, { scopeVerified: true }, registry).status).toBe("validated");
    const without = evaluateDraft(content, { scopeVerified: true });
    expect(without.status).toBe("unverified");
    expect(without.status).not.toBe("validated");
  });

  it("makes a draft whose configuration is invalid invalid, never stored as valid", () => {
    const content = answered(slackDraft([setting("resource", "telegram")]));
    const evaluation = evaluateDraft(content, { scopeVerified: true }, registry);
    expect(evaluation.status).toBe("invalid");
    expect(evaluation.checks.find((check) => check.id === "configuration_schema")).toMatchObject({ status: "failed" });
  });

  it("keeps a draft whose configuration could not be checked unverified, never validated", () => {
    const content = answered(slackDraft([setting("channel", "#general")]));
    const evaluation = evaluateDraft(content, { scopeVerified: true }, registry);
    expect(evaluation.checks.find((check) => check.id === "configuration_schema")).toMatchObject({ status: "not_run" });
    expect(evaluation.status).toBe("unverified");
  });
});

describe("the bounded summary", () => {
  const registry = registryOf();

  it("names the parameters of a node, and nothing more", () => {
    const summary = summarizeNodeSchema(registry, "n8n-nodes-base.slack")!;
    expect(summary.label).toBe("Slack");
    expect(summary.version).toBe("2.4");
    expect(summary.parameters.length).toBeLessThanOrEqual(NODE_SCHEMA_LIMITS.hintParametersMax);
    for (const parameter of summary.parameters) {
      expect(parameter.name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      if (parameter.options) expect(parameter.options.length).toBeLessThanOrEqual(NODE_SCHEMA_LIMITS.hintOptionsMax);
    }
  });

  it("says nothing about a node type the snapshot does not cover", () => {
    expect(summarizeNodeSchema(registry, "n8n-nodes-base.gmail")).toBeNull();
    expect(summarizeNodeSchema(null, "n8n-nodes-base.slack")).toBeNull();
  });

  it("gives one hint per live node of a draft, and none for a removed one", () => {
    const content = slackDraft([setting("resource", "message")]);
    const hints = draftSchemaHints(content, registry);
    expect(hints.map((hint) => hint.nodeKey)).toEqual(["trigger", "slack"]);
    expect(hints[1]!.type).toBe("n8n-nodes-base.slack");
    expect(draftSchemaHints(content, null)).toEqual([]);
  });
});
