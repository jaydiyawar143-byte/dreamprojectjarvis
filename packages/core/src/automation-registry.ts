// ---------------------------------------------------------------------------
// The Automation Registry — one normalized view over every automation JARVIS
// can reach, whichever connector discovered it.
//
// PURE. This module performs no I/O and holds no provider SDK: it takes records
// that a connector already collected and answers two questions about them —
// "which automations exist?" and "which connector should run this?".
//
// WHY IT EXISTS. n8n is reachable through two surfaces that describe the same
// instance differently:
//
//   • the Public REST API — workflows, pagination, metadata, management;
//   • the MCP server      — the tools an agent may discover and invoke.
//
// Without one shared shape a workflow discovered over REST and the same
// workflow exposed as an MCP tool would appear twice, and a caller would have
// to know which connector to ask. Here they normalize to one `AutomationRecord`
// and route by operation instead of by surface.
//
// HONESTY. A record says only what its connector actually reported. `available`
// is the provider's own answer (a workflow's `active`, whether a tool was
// listed); a connector that could not be reached contributes NO records — the
// caller reports it unread rather than inventing an empty list. `observedVia`
// exists so a UI can show that one automation was seen through both surfaces
// and never imply that a tool was reviewed when it was merely discovered.
// ---------------------------------------------------------------------------

/** The connector that observed an automation. One per external surface. */
export type AutomationConnectorId = "rest" | "mcp";

/**
 * What a caller wants to DO. Routing is by operation, not by connector: a
 * capability is answered by whichever surface genuinely supports it.
 *
 * Deliberately separate from the presentation `CapabilityGroup` in
 * `capability-catalog.ts` — that vocabulary is what a person reads, this one is
 * what a connector supports.
 */
export type AutomationOperation = "list" | "describe" | "monitor" | "manage" | "execute";

export const AUTOMATION_OPERATIONS: readonly AutomationOperation[] = [
  "list",
  "describe",
  "monitor",
  "manage",
  "execute",
];

/** An automation is either a provider workflow or a discoverable tool. */
export type AutomationKind = "workflow" | "tool";

/**
 * One automation, normalized.
 *
 * `externalId` is the provider's own identifier (an n8n workflow id, an MCP
 * tool name) and the only stable handle. `handles` maps a connector to the id
 * IT needs, so an automation seen through both surfaces carries both — the REST
 * workflow id and the MCP tool name — without either being confused for the
 * other.
 */
export interface AutomationRecord {
  /** The provider that owns it: "n8n", and later a self-hosted instance's id. */
  providerId: string;
  kind: AutomationKind;
  /** Stable within `providerId` + `kind`. */
  externalId: string;
  name: string;
  description: string | null;
  /** The provider's own answer — never assumed from mere discovery. */
  available: boolean;
  operations: readonly AutomationOperation[];
  /** Connectors that observed this automation, sorted and de-duplicated. */
  observedVia: readonly AutomationConnectorId[];
  /** Per-connector action handles. Ids only — never workflow text or a URL. */
  handles: Readonly<Partial<Record<AutomationConnectorId, string>>>;
  /** Flat, string-valued provider metadata. Never a credential or a payload. */
  metadata: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Normalization inputs — the minimal shapes a connector must supply. Kept
// structural, so core never imports a provider package.
// ---------------------------------------------------------------------------

/** The fields of a REST workflow the registry keeps. */
export interface RestWorkflowInput {
  id: string;
  name: string;
  active: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** The fields of a discovered MCP tool the registry keeps. */
export interface McpToolInput {
  name: string;
  description?: string | null;
  /** Whether the tool's own annotations claim it does not write. */
  readOnly?: boolean;
  /** The provider workflow the tool targets, when the tool names one. */
  workflowId?: string | null;
}

/**
 * A workflow's operations. REST is the surface for listing, describing,
 * monitoring and managing; execution is offered too, but routing prefers MCP
 * for it when MCP can genuinely execute.
 */
const REST_WORKFLOW_OPERATIONS: readonly AutomationOperation[] = [
  "list",
  "describe",
  "monitor",
  "manage",
  "execute",
];

/**
 * A discovered tool's operations. Discovery lists and describes; invocation is
 * `execute`. A tool carries NO `monitor` or `manage`: nothing has shown that the
 * MCP surface exposes execution history or workflow editing, and inventing those
 * operations would let a router claim a capability the endpoint lacks.
 *
 * A tool whose annotations claim it writes is still only `execute` here — the
 * approval boundary is decided by the tool's risk classification, not by a
 * provider's self-description.
 */
const MCP_TOOL_OPERATIONS: readonly AutomationOperation[] = ["list", "describe", "execute"];

function sortUnique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort() as T[];
}

/** An object with its keys in sorted order, so two runs serialize identically. */
function sortKeys<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key]!;
  return out;
}

/** Bounds a metadata value; never a credential, and never unbounded. */
const MAX_METADATA_LENGTH = 200;

function metaValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value);
  if (text.length === 0) return null;
  return text.length <= MAX_METADATA_LENGTH ? text : `${text.slice(0, MAX_METADATA_LENGTH)}…[truncated]`;
}

function addMeta(
  meta: Record<string, string>,
  key: string,
  value: unknown
): void {
  const bounded = metaValue(value);
  if (bounded !== null) meta[key] = bounded;
}

/** One REST workflow as a record. */
export function automationRecordFromRestWorkflow(
  providerId: string,
  workflow: RestWorkflowInput
): AutomationRecord {
  const metadata: Record<string, string> = {};
  addMeta(metadata, "createdAt", workflow.createdAt);
  addMeta(metadata, "updatedAt", workflow.updatedAt);
  return {
    providerId,
    kind: "workflow",
    externalId: workflow.id,
    name: workflow.name,
    description: null,
    available: workflow.active === true,
    operations: sortUnique(REST_WORKFLOW_OPERATIONS),
    observedVia: ["rest"],
    handles: { rest: workflow.id },
    metadata: sortKeys(metadata),
  };
}

/** One discovered MCP tool as a record. */
export function automationRecordFromMcpTool(
  providerId: string,
  tool: McpToolInput
): AutomationRecord {
  const metadata: Record<string, string> = {};
  if (tool.readOnly === true) metadata.readOnly = "true";
  addMeta(metadata, "workflowId", tool.workflowId);
  return {
    providerId,
    kind: "tool",
    externalId: tool.name,
    name: tool.name,
    description: tool.description ?? null,
    // A tool the server listed is available; nothing else is claimed.
    available: true,
    operations: sortUnique(MCP_TOOL_OPERATIONS),
    observedVia: ["mcp"],
    handles: { mcp: tool.name },
    metadata: sortKeys(metadata),
  };
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/** The identity of a record within its provider. */
export function automationIdentity(record: AutomationRecord): string {
  return `${record.providerId}:${record.kind}:${record.externalId}`;
}

/**
 * Alias keys under which two records may be the SAME automation.
 *
 * The primary key is provider+kind+externalId. The second is the CROSS-CONNECTOR
 * link: a REST workflow and an MCP tool that names the same provider workflow id
 * are one automation observed through two surfaces, not two automations. Only an
 * explicit `workflowId` bridges them — names, descriptions or fuzzy matching
 * never could, and a wrong merge would let a write aimed at one workflow land on
 * another.
 */
function aliasKeys(record: AutomationRecord): string[] {
  const keys = [automationIdentity(record)];
  const workflowId = record.metadata.workflowId;
  if (workflowId && workflowId.length > 0) {
    keys.push(`${record.providerId}:workflow:${workflowId}`);
  }
  return keys;
}

function mergeGroup(group: readonly AutomationRecord[]): AutomationRecord {
  const first = group[0]!;
  const operations = sortUnique(group.flatMap((r) => r.operations));
  const observedVia = sortUnique(group.flatMap((r) => r.observedVia));

  const handles: Partial<Record<AutomationConnectorId, string>> = {};
  for (const record of group) {
    for (const [connector, handle] of Object.entries(record.handles)) {
      if (handle !== undefined) handles[connector as AutomationConnectorId] = handle;
    }
  }

  const metadata: Record<string, string> = {};
  for (const record of group) {
    // First writer wins, so a stable sort makes this deterministic.
    for (const [key, value] of Object.entries(record.metadata)) {
      if (!(key in metadata)) metadata[key] = value;
    }
  }

  // A linked group takes the workflow's identity: the REST workflow is the
  // canonical automation, and the tool is one way to reach it.
  const canonical = group.find((r) => r.kind === "workflow") ?? first;
  const name = canonical.name.length > 0 ? canonical.name : (group.find((r) => r.name.length > 0)?.name ?? "");
  const description =
    group.find((r) => r.description !== null && r.description.length > 0)?.description ?? null;

  return {
    providerId: canonical.providerId,
    kind: canonical.kind,
    externalId: canonical.externalId,
    name,
    description,
    available: group.some((r) => r.available),
    operations,
    observedVia,
    handles: sortKeys(handles),
    metadata: sortKeys(metadata),
  };
}

/**
 * Collapses records that describe the same automation.
 *
 * Groups are unioned by alias key (see `aliasKeys`), then merged with a
 * deterministic result: sorted operations and connectors, a fixed metadata
 * precedence, and the workflow as the canonical identity of a cross-connector
 * pair. The output is sorted by identity, so two collections of the same
 * automations always produce byte-identical results.
 */
export function mergeAutomationRecords(records: readonly AutomationRecord[]): AutomationRecord[] {
  if (records.length === 0) return [];

  const parent = records.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    // Path compression.
    let walk = index;
    while (parent[walk] !== root) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const seen = new Map<string, number>();
  records.forEach((record, index) => {
    for (const key of aliasKeys(record)) {
      const existing = seen.get(key);
      if (existing === undefined) seen.set(key, index);
      else union(existing, index);
    }
  });

  const groups = new Map<number, AutomationRecord[]>();
  records.forEach((record, index) => {
    const root = find(index);
    const bucket = groups.get(root);
    if (bucket) bucket.push(record);
    else groups.set(root, [record]);
  });

  return [...groups.values()]
    .map((group) => mergeGroup(group))
    .sort((a, b) => (automationIdentity(a) < automationIdentity(b) ? -1 : automationIdentity(a) > automationIdentity(b) ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** What one connector reports about itself: reachable, and what it can do. */
export interface AutomationConnectorStatus {
  connector: AutomationConnectorId;
  /** Reachable AND configured. A connector that failed a check is not available. */
  available: boolean;
  /** The operations this connector's surface genuinely supports. */
  operations: readonly AutomationOperation[];
}

/**
 * The preferred connector for each operation, best first.
 *
 * REST leads for listing, describing, monitoring and managing — it is the
 * documented, paginated surface for workflow metadata and management. MCP leads
 * for execution, because invoking a discovered tool is what MCP is for; REST is
 * only a fallback if MCP genuinely cannot execute. `monitor` and `manage` list
 * only REST: nothing has shown the MCP surface exposes execution history or
 * workflow editing.
 */
const OPERATION_PREFERENCE: Record<AutomationOperation, readonly AutomationConnectorId[]> = {
  list: ["rest", "mcp"],
  describe: ["rest", "mcp"],
  monitor: ["rest"],
  manage: ["rest"],
  execute: ["mcp", "rest"],
};

export type AutomationRoute =
  | { ok: true; connector: AutomationConnectorId; reason: string }
  | { ok: false; reason: string };

/**
 * Picks the connector that should run an operation.
 *
 * Fallback is allowed ONLY to a connector that both is available and declares
 * the operation — never merely because it is the other one. When nothing can do
 * it, the reason names the operation and what was reachable, so a caller can say
 * why instead of guessing.
 */
export function resolveAutomationRoute(
  operation: AutomationOperation,
  connectors: readonly AutomationConnectorStatus[]
): AutomationRoute {
  const preferred = OPERATION_PREFERENCE[operation];
  for (const connector of preferred) {
    const status = connectors.find((c) => c.connector === connector);
    if (status && status.available && status.operations.includes(operation)) {
      return {
        ok: true,
        connector,
        reason: `${connector} supports ${operation}`,
      };
    }
  }
  const reachable = connectors
    .filter((c) => c.available)
    .map((c) => c.connector)
    .sort();
  return {
    ok: false,
    reason:
      reachable.length === 0
        ? `No n8n connector is reachable, so "${operation}" cannot be answered.`
        : `No reachable connector supports "${operation}" (reachable: ${reachable.join(", ")}).`,
  };
}

/**
 * The connector statuses a route is resolved against, from what was observed.
 *
 * A connector appears ONLY when it was actually reached. A REST listing that
 * succeeded and an MCP discovery that was not attempted does not silently
 * promote MCP to "available": an unavailable connector is present-but-false so a
 * caller can distinguish "we did not try" from "we tried and it failed".
 */
export function connectorStatus(
  connector: AutomationConnectorId,
  reachable: boolean,
  operations: readonly AutomationOperation[]
): AutomationConnectorStatus {
  return { connector, available: reachable, operations };
}
