// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — what a workflow draft may hold, how it is checked,
// and what it changes. Pure rules; named `automation-library*` so CI's core
// slice runs it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  DRAFT_CHECK_MESSAGES,
  DRAFT_NODE_CATALOG,
  applyDraftAnswers,
  buildDraftContent,
  draftContentHash,
  draftDiff,
  evaluateDraft,
  parseDraftGraph,
  validateAutomationRequest,
  validateDraftCreateInput,
  validateDraftReviseInput,
  type AutomationRequest,
  type DraftContent,
  type DraftSource,
} from "../src/index.js";

function request(input: Record<string, unknown>): AutomationRequest {
  const read = validateAutomationRequest(input);
  if (!read.ok) throw new Error(read.code);
  return read.value;
}

const ASK = request({ goal: "When a lead form is submitted, post it to Slack and add a row to Google Sheets", inputs: ["email"], outcome: "The team sees each lead" });

function newDraft(graph: { nodes: unknown; connections: unknown } | null = null): DraftContent {
  const built = buildDraftContent({ kind: "new", title: "Leads", request: ASK, source: null, graph });
  if (!built.ok) throw new Error(JSON.stringify(built.issues));
  return built.content;
}

const SOURCE: DraftSource = {
  entryId: "wf-1",
  versionId: "v-1",
  name: "Form alerts",
  nodeTypes: ["n8n-nodes-base.formTrigger", "n8n-nodes-base.slack", "n8n-nodes-base.set"],
  nodeCount: 3,
};

const issuesOf = (graph: { nodes: unknown; connections: unknown }, kind: "new" | "customization" = "new", source: DraftSource | null = null) => {
  const parsed = parseDraftGraph(graph, { kind, source });
  return parsed.ok ? [] : parsed.issues.map((i) => i.code);
};

const node = (key: string, type: string, extra: Record<string, unknown> = {}) => ({ key, type, ...extra });
const edge = (from: string, to: string, output?: number) => ({ from, to, ...(output !== undefined ? { output } : {}) });

describe("a new draft from a request", () => {
  it("holds the trigger and the named apps, chained in order, with each account as a reference to configure in n8n", () => {
    const content = newDraft();
    expect(content.nodes.map((n) => [n.key, n.type, n.origin])).toEqual([
      ["trigger", "n8n-nodes-base.formTrigger", "added"],
      ["slack", "n8n-nodes-base.slack", "added"],
      ["googlesheets", "n8n-nodes-base.googleSheets", "added"],
    ]);
    expect(content.connections).toEqual([edge("trigger", "slack", 0), edge("slack", "googlesheets", 0)]);
    expect(content.nodes[1]!.settings).toEqual([{ key: "credential", label: "Slack account", kind: "credential", value: null }]);
    expect(JSON.stringify(content)).not.toMatch(/parameters|"credentials"|typeVersion/);
  });

  it("is never reported validated: the configuration check cannot run without n8n's schemas", () => {
    const content = newDraft();
    const { status, checks } = evaluateDraft(content, { scopeVerified: true });
    expect(status).toBe("unverified");
    expect(checks.find((c) => c.id === "configuration_schema")).toEqual({ id: "configuration_schema", status: "not_run", message: DRAFT_CHECK_MESSAGES.configurationSchema });
    expect(checks.filter((c) => c.status === "passed").map((c) => c.id)).toEqual(["node_types", "graph", "triggers", "safety", "credentials", "requirements", "scope"]);
    // Without the scope read, that is not passed either.
    expect(evaluateDraft(content).checks.find((c) => c.id === "scope")!.status).toBe("not_run");
  });

  it("asks for what is open, and says what it could not hold", () => {
    const vague = buildDraftContent({ kind: "new", title: "x", request: request({ goal: "When a payment arrives, refund it with Stripe" }), source: null, graph: null });
    if (!vague.ok) throw new Error("refused");
    expect(vague.content.nodes).toEqual([]);
    expect(vague.content.notes).toEqual(["Stripe is not a node drafts can hold yet; plan that step in n8n."]);
    const evaluated = evaluateDraft(vague.content, { scopeVerified: true });
    expect(evaluated.status).toBe("needs_input");
    expect(evaluated.requirements.filter((r) => r.state === "needs_input").map((r) => r.kind)).toEqual(["question", "question", "structure"]);

    const stripe = buildDraftContent({ kind: "new", title: "x", request: request({ goal: "Every day refund with Stripe" }), source: null, graph: null });
    if (!stripe.ok) throw new Error("refused");
    expect(stripe.content.notes).toEqual(["Stripe is not a node drafts can hold yet; plan that step in n8n."]);
  });
});

describe("the structure is checked, and an invalid one is refused — never stored", () => {
  const trigger = node("start", "n8n-nodes-base.webhook");

  it("refuses node types it cannot vouch for, including Code", () => {
    expect(issuesOf({ nodes: [trigger, node("x", "n8n-nodes-base.code")], connections: [edge("start", "x")] })).toEqual(["UNSUPPORTED_NODE_TYPE"]);
    expect(issuesOf({ nodes: [trigger, node("x", "community.thing")], connections: [] })).toEqual(["UNSUPPORTED_NODE_TYPE"]);
    expect(issuesOf({ nodes: [trigger, node("x", "<script>")], connections: [] })).toEqual(["UNSUPPORTED_NODE_TYPE"]);
    expect(Object.keys(DRAFT_NODE_CATALOG)).not.toEqual(expect.arrayContaining(["n8n-nodes-base.code", "n8n-nodes-base.switch", "n8n-nodes-base.merge"]));
  });

  it("refuses an n8n definition field outright, and any field it does not know", () => {
    for (const field of ["parameters", "credentials", "typeVersion", "pinData", "staticData"]) {
      expect(issuesOf({ nodes: [{ ...trigger, [field]: { token: "x" } }], connections: [] }), field).toEqual(["N8N_FIELD_REFUSED"]);
    }
    expect(issuesOf({ nodes: [{ ...trigger, colour: "red" }], connections: [] })).toEqual(["INVALID_NODE"]);
  });

  it("refuses duplicate and disconnected nodes, and connections that cannot exist", () => {
    const slack = node("slack", "n8n-nodes-base.slack");
    const check = node("check", "n8n-nodes-base.if");
    expect(issuesOf({ nodes: [trigger, trigger], connections: [] })).toEqual(["DUPLICATE_NODE"]);
    expect(issuesOf({ nodes: [trigger, slack], connections: [] })).toEqual(["DISCONNECTED_NODE"]);
    expect(issuesOf({ nodes: [trigger, slack], connections: [edge("start", "ghost")] })).toEqual(["UNKNOWN_NODE"]);
    expect(issuesOf({ nodes: [trigger, slack], connections: [edge("start", "slack"), edge("slack", "slack")] })).toEqual(["SELF_LOOP"]);
    expect(issuesOf({ nodes: [trigger, slack], connections: [edge("start", "slack", 1)] })).toEqual(["INVALID_OUTPUT"]);
    expect(issuesOf({ nodes: [trigger, slack], connections: [edge("start", "slack"), edge("slack", "start")] })).toEqual(["TRIGGER_HAS_INPUT"]);
    expect(issuesOf({ nodes: [trigger, slack], connections: [edge("start", "slack"), edge("start", "slack")] })).toEqual(["DUPLICATE_CONNECTION"]);
    expect(issuesOf({ nodes: [trigger, check, slack], connections: [edge("start", "check"), edge("check", "slack"), edge("slack", "check")] })).toEqual(["CYCLE"]);
    expect(issuesOf({ nodes: [slack], connections: [] })).toEqual(["DISCONNECTED_NODE", "NO_TRIGGER"]);
    // If has a true and a false output; both may be used.
    expect(issuesOf({ nodes: [trigger, check, slack, node("noop", "n8n-nodes-base.noOp")], connections: [edge("start", "check"), edge("check", "slack", 0), edge("check", "noop", 1)] })).toEqual([]);
  });

  it("refuses a secret, an expression, a link or a credential value anywhere it would be stored", () => {
    const withSetting = (setting: Record<string, unknown>) =>
      issuesOf({ nodes: [trigger, node("slack", "n8n-nodes-base.slack", { settings: [setting] })], connections: [edge("start", "slack")] });
    expect(withSetting({ key: "channel", label: "Channel", value: "xoxb-1234567890-abcdefghijkl" })).toEqual(["SECRET_REFUSED"]);
    expect(withSetting({ key: "channel", label: "Channel", value: "{{ $env.CHANNEL }}" })).toEqual(["INVALID_TEXT"]);
    expect(withSetting({ key: "channel", label: "Channel", value: "=$json.channel" })).toEqual(["INVALID_TEXT"]);
    expect(withSetting({ key: "url", label: "Where", value: "https://hooks.example/abc" })).toEqual(["INVALID_TEXT"]);
    expect(withSetting({ key: "account", label: "Slack token", kind: "credential", value: "anything" })).toEqual(["CREDENTIAL_VALUE_REFUSED"]);
    expect(withSetting({ key: "url", label: "Endpoint", kind: "in_n8n", value: "x" })).toEqual(["IN_N8N_VALUE_REFUSED"]);
    expect(withSetting({ key: "channel", label: "Channel {{ $secrets.x }}" })).toEqual(["INVALID_TEXT"]);
    expect(issuesOf({ nodes: [{ ...trigger, label: "password=hunter2" }], connections: [] })).toEqual(["SECRET_REFUSED"]);
    // A plain answer is fine.
    expect(withSetting({ key: "channel", label: "Which channel?", value: "#sales-leads" })).toEqual([]);
  });
});

describe("a customization is bound to its source", () => {
  const ref = (type: string, extra: Record<string, unknown> = {}) => node(type.split(".")[1]!.toLowerCase(), type, { source: true, ...extra });

  it("refers only to node types the source has, once each, and removes only those", () => {
    expect(issuesOf({ nodes: [ref("n8n-nodes-base.gmail")], connections: [] }, "customization", SOURCE)).toEqual(["NOT_IN_SOURCE"]);
    expect(issuesOf({ nodes: [ref("n8n-nodes-base.slack"), { ...ref("n8n-nodes-base.slack"), key: "again" }], connections: [] }, "customization", SOURCE)).toEqual(["DUPLICATE_SOURCE_REF"]);
    expect(issuesOf({ nodes: [ref("n8n-nodes-base.slack")], connections: [] }, "new")).toEqual(["SOURCE_REF_IN_NEW"]);
    expect(issuesOf({ nodes: [node("x", "n8n-nodes-base.slack", { remove: true })], connections: [] }, "customization", SOURCE)).toEqual(["REMOVE_NOT_SOURCE"]);
    expect(
      issuesOf({ nodes: [ref("n8n-nodes-base.slack", { remove: true }), ref("n8n-nodes-base.formtrigger".replace("formtrigger", "formTrigger"))], connections: [edge("formtrigger", "slack")] }, "customization", SOURCE)
    ).toEqual(["CONNECTS_REMOVED"]);
    expect(issuesOf({ nodes: [ref("n8n-nodes-base.formTrigger", { remove: true })], connections: [] }, "customization", SOURCE)).toEqual(["NO_TRIGGER"]);
  });

  it("asks which node is meant only when a type could occur more than once", () => {
    const parse = (source: DraftSource) => parseDraftGraph({ nodes: [ref("n8n-nodes-base.slack")], connections: [] }, { kind: "customization", source });
    const unique = parse(SOURCE);
    const ambiguous = parse({ ...SOURCE, nodeCount: 5 });
    expect(unique.ok && unique.nodes[0]!.settings).toEqual([]);
    expect(ambiguous.ok && ambiguous.nodes[0]!.settings.map((s) => s.key)).toEqual(["which_node"]);
  });

  it("goes stale when the source moves on — and says so, with the reason", () => {
    const built = buildDraftContent({ kind: "customization", title: "x", request: ASK, source: SOURCE, graph: null });
    if (!built.ok) throw new Error("refused");
    const content = built.content;
    expect(content.nodes.map((n) => [n.key, n.origin])).toEqual([
      ["source-trigger", "source"],
      ["googlesheets", "added"],
    ]);
    const check = (source: Parameters<typeof evaluateDraft>[1]["source"]) => evaluateDraft(content, { source, scopeVerified: true });
    expect(check({ versionId: "v-1", presence: "present" }).checks.find((c) => c.id === "source_version")!.status).toBe("passed");
    expect(check({ versionId: "v-1", presence: "present" }).checks.find((c) => c.id === "source_graph")).toEqual({ id: "source_graph", status: "not_run", message: DRAFT_CHECK_MESSAGES.sourceGraph });
    for (const [source, reason] of [
      [{ versionId: "v-2", presence: "present" }, /changed in n8n/],
      [{ versionId: "v-1", presence: "missing" }, /last complete scan/],
      [null, /no longer in the library/],
    ] as const) {
      const evaluated = check(source);
      expect(evaluated.status).toBe("stale");
      expect(evaluated.checks.find((c) => c.id === "source_version")!.message).toMatch(reason);
    }
    expect(evaluateDraft(content, { scopeVerified: true }).checks.find((c) => c.id === "source_version")!.status).toBe("not_run");
  });
});

describe("answers, hashes and the diff", () => {
  it("answers a question or a value setting on a copy — never a credential, never an unknown key", () => {
    // This request answered everything, so it has no outcome question to answer.
    expect(applyDraftAnswers(newDraft(), { "question.outcome": "x" })).toMatchObject({ ok: false, issues: [{ code: "UNKNOWN_ANSWER" }] });
    const vague = buildDraftContent({ kind: "new", title: "x", request: request({ goal: "Tidy up our invoices" }), source: null, graph: null });
    if (!vague.ok) throw new Error("refused");
    const answered = applyDraftAnswers(vague.content, { "question.trigger": "Every Monday morning" });
    expect(answered.ok && answered.content.questions.find((q) => q.key === "trigger")!.answer).toBe("Every Monday morning");
    expect(vague.content.questions.find((q) => q.key === "trigger")!.answer).toBeNull();
    const withValue = newDraft({
      nodes: [node("start", "n8n-nodes-base.formTrigger"), node("slack", "n8n-nodes-base.slack", { settings: [{ key: "channel", label: "Which channel?" }] })],
      connections: [edge("start", "slack")],
    });
    const before = draftContentHash(withValue);
    const next = applyDraftAnswers(withValue, { "slack.channel": "#leads" });
    expect(next.ok && next.content.nodes[1]!.settings[0]!.value).toBe("#leads");
    expect(withValue.nodes[1]!.settings[0]!.value).toBeNull();
    expect(draftContentHash(withValue)).toBe(before);
    expect(next.ok && draftContentHash(next.content)).not.toBe(before);
    expect(applyDraftAnswers(withValue, { "slack.credential": "xoxb" })).toMatchObject({ ok: false, issues: [{ code: "CREDENTIAL_VALUE_REFUSED" }] });
    expect(applyDraftAnswers(withValue, { "slack.nothing": "x" })).toMatchObject({ ok: false, issues: [{ code: "UNKNOWN_ANSWER" }] });
    expect(applyDraftAnswers(withValue, { "slack.channel": "token: abcdefghijkl" })).toMatchObject({ ok: false, issues: [{ code: "SECRET_REFUSED" }] });
  });

  it("hashes the canonical content: the same content always, any change never", () => {
    expect(draftContentHash(newDraft())).toBe(draftContentHash(newDraft()));
    expect(draftContentHash(newDraft())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("describes additions, removals, connections, triggers and configuration", () => {
    const built = buildDraftContent({
      kind: "customization",
      title: "x",
      request: ASK,
      source: SOURCE,
      graph: {
        nodes: [
          node("form", "n8n-nodes-base.formTrigger", { source: true }),
          node("old", "n8n-nodes-base.set", { source: true, remove: true }),
          node("check", "n8n-nodes-base.if"),
          node("sheet", "n8n-nodes-base.googleSheets", { settings: [{ key: "sheet", label: "Which sheet?" }] }),
          node("hook", "n8n-nodes-base.webhook"),
        ],
        connections: [edge("form", "check"), edge("check", "sheet", 1), edge("hook", "sheet")],
      },
    });
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const diff = draftDiff(built.content);
    expect(diff.nodesAdded.map((n) => [n.key, n.kind])).toEqual([
      ["check", "logic"],
      ["sheet", "action"],
      ["hook", "trigger"],
    ]);
    expect(diff.nodesRemoved).toEqual([{ key: "old", type: "n8n-nodes-base.set", label: "Edit fields" }]);
    expect(diff.connectionsAdded[1]).toEqual({ from: "check", fromLabel: "If", to: "sheet", toLabel: "Google Sheets", output: 1, outputName: "false" });
    expect(diff.triggersAdded).toEqual([{ key: "hook", label: "Webhook" }]);
    expect(diff.triggersRemoved).toEqual([]);
    expect(diff.configurationChanges.map((c) => [c.nodeKey, c.setting, c.state])).toEqual([
      ["sheet", "Which sheet?", "needs_input"],
      ["sheet", "Google account", "configure_in_n8n"],
    ]);
    expect(diff.untouchedSourceTypes).toEqual(["n8n-nodes-base.slack"]);
  });

  it("re-checks stored content instead of trusting it", () => {
    const tampered = newDraft();
    tampered.nodes[1]!.type = "n8n-nodes-base.executeCommand";
    expect(evaluateDraft(tampered, { scopeVerified: true })).toMatchObject({ status: "invalid" });
    const leaked = newDraft();
    leaked.nodes[1]!.settings[0]!.value = "xoxb-1234567890-abcdefghijkl";
    expect(evaluateDraft(leaked, { scopeVerified: true }).status).toBe("invalid");
  });
});

describe("the requests both surfaces accept", () => {
  it("takes a request plus the draft's own fields, and nothing the server decides", () => {
    expect(validateDraftCreateInput({ goal: "Every day email the report with Gmail", kind: "new" })).toMatchObject({ ok: true, value: { kind: "new", graph: null, overrideReuse: false } });
    expect(validateDraftCreateInput({ goal: "x to Slack", kind: "customization", sourceEntryId: "wf-1" })).toMatchObject({ ok: true, value: { sourceEntryId: "wf-1" } });
    expect(validateDraftCreateInput({ goal: "x to Slack", kind: "new", tenantId: "org-2" })).toMatchObject({ ok: false, code: "REQUEST_SCOPE_REFUSED" });
    for (const bad of [
      { goal: "x", kind: "rewrite" },
      { goal: "x", kind: "customization" },
      { goal: "x", kind: "new", sourceEntryId: "wf-1" },
      { goal: "x", kind: "new", nodes: [] },
      { goal: "x", kind: "new", overrideReuse: "yes" },
      { goal: "x", kind: "new", status: "validated" },
    ]) {
      expect(validateDraftCreateInput(bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    }
  });

  it("revises from a named version only, and never sets its own number, hash or status", () => {
    expect(validateDraftReviseInput({ baseVersion: "2", answers: { "question.outcome": "x" } })).toMatchObject({ ok: true, value: { baseVersion: 2 } });
    for (const field of ["version", "contentHash", "status", "tenantId"]) {
      expect(validateDraftReviseInput({ baseVersion: 1, answers: { "question.x": "y" }, [field]: 1 }), field).toMatchObject({ ok: false, code: "REQUEST_SCOPE_REFUSED" });
    }
    for (const bad of [{ answers: { "question.x": "y" } }, { baseVersion: 0, answers: { "question.x": "y" } }, { baseVersion: 1 }, { baseVersion: 1, nodes: [] }, { baseVersion: 1, answers: { "Bad Key": "y" } }]) {
      expect(validateDraftReviseInput(bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    }
  });
});
