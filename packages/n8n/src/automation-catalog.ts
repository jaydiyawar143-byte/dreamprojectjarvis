// ---------------------------------------------------------------------------
// The unified, read-only automation view (Phase 16, Stage 2)
//
// One function that composes the two n8n surfaces into a single normalized list
// of `AutomationRecord`s, using `@jarvis/core`'s Automation Registry for the
// identity, provenance and deduplication rules.
//
// PURE AND READ-ONLY. It performs no I/O and invokes nothing: its inputs are
// records a connector has ALREADY collected (an MCP discovery's tools, a REST
// listing's workflows). It cannot execute a tool, because it never holds a
// connector. That is the property that keeps "a view" from becoming "a way to
// run things" — the only way to invoke an n8n MCP tool is through a
// ToolExecutor-mediated, approval-gated path (see
// docs/n8n-mcp-execution-architecture.md), and this module is not one.
//
// SOURCES ARE EXPLICIT, INCLUDING WHEN THEY ARE ABSENT. A caller says, per
// surface, whether it was READ (`available: true`) with the items it returned,
// or NOT read (`available: false`) with the reason. An unread surface
// contributes no records and is reported as unavailable — never as an empty
// list, which would read as "there is nothing there". This follows the
// registry's own rule: a connector that could not be reached contributes no
// records, and the caller says it was unread rather than inventing an empty
// result.
//
// THE MCP TOKEN IS NOT A REST KEY. This module takes no credential of any kind:
// REST records arrive as normalized workflows and MCP records as discovered
// tools. Nothing here reads `N8N_API_KEY` or `N8N_MCP_TOKEN`, and nothing could
// substitute one for the other.
// ---------------------------------------------------------------------------

import {
  automationRecordFromRestWorkflow,
  connectorStatus,
  mergeAutomationRecords,
  type AutomationConnectorId,
  type AutomationConnectorStatus,
  type AutomationOperation,
  type AutomationRecord,
  type RestWorkflowInput,
} from "@jarvis/core";
import { n8nMcpAutomationRecords, type N8nMcpTool } from "./mcp-connector.js";

/**
 * What a caller observed on one surface.
 *
 * `available: false` is a first-class outcome, not an empty list. `reason` is a
 * fixed sentence the caller supplies; it is echoed to a person, so it must not
 * carry a credential or a provider's raw error text.
 */
export type AutomationSource<TItem> =
  | { available: true; items: readonly TItem[] }
  | { available: false; reason: string };

export interface AutomationCatalogInput {
  /** The provider id records carry. "n8n" today; an instance id for a fleet. */
  providerId?: string;
  /** The Public REST API surface: workflows, when it was read. */
  rest: AutomationSource<RestWorkflowInput>;
  /** The MCP surface: the tools a discovery returned, when it was read. */
  mcp: AutomationSource<N8nMcpTool>;
}

/** Per-surface availability, for honest reporting. */
export interface AutomationSourceReport {
  connector: AutomationConnectorId;
  available: boolean;
  /** The reason a surface was not read; null when it was. */
  reason: string | null;
  /** How many records this surface contributed (before deduplication). */
  count: number;
}

export interface AutomationCatalog {
  providerId: string;
  /** The merged, sorted automations — one entry per real automation. */
  records: readonly AutomationRecord[];
  /** The registry's routing view: which connector can do each operation. */
  connectors: readonly AutomationConnectorStatus[];
  /** What each surface contributed, and why when it contributed nothing. */
  sources: { rest: AutomationSourceReport; mcp: AutomationSourceReport };
}

/** The union of the operations the records of one surface declared. */
function operationsOf(records: readonly AutomationRecord[]): AutomationOperation[] {
  const set = new Set<AutomationOperation>();
  for (const record of records) for (const op of record.operations) set.add(op);
  return [...set].sort();
}

function report<TItem>(
  connector: AutomationConnectorId,
  source: AutomationSource<TItem>,
  count: number
): AutomationSourceReport {
  return source.available
    ? { connector, available: true, reason: null, count }
    : { connector, available: false, reason: source.reason, count: 0 };
}

/**
 * Composes the two surfaces into one normalized view.
 *
 * The merge is `@jarvis/core`'s: a REST workflow and an MCP tool that names the
 * same provider workflow id collapse into ONE record with both handles and both
 * `observedVia` entries; two automations that merely share a name never do. The
 * result is sorted by identity, so the same inputs always produce the same
 * bytes.
 */
export function buildAutomationCatalog(input: AutomationCatalogInput): AutomationCatalog {
  const providerId = input.providerId ?? "n8n";

  const restRecords = input.rest.available
    ? input.rest.items.map((workflow) => automationRecordFromRestWorkflow(providerId, workflow))
    : [];

  const mcpRecords = input.mcp.available
    ? n8nMcpAutomationRecords(providerId, input.mcp.items)
    : [];

  const records = mergeAutomationRecords([...restRecords, ...mcpRecords]);

  return {
    providerId,
    records,
    connectors: [
      connectorStatus("rest", input.rest.available, operationsOf(restRecords)),
      connectorStatus("mcp", input.mcp.available, operationsOf(mcpRecords)),
    ],
    sources: {
      rest: report("rest", input.rest, restRecords.length),
      mcp: report("mcp", input.mcp, mcpRecords.length),
    },
  };
}
