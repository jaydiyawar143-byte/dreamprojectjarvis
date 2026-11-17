export {
  createN8nConfig,
  isN8nConfigured,
  validateWebhookPath,
  buildWebhookUrl,
  truncateSummary,
  N8N_MAX_SUMMARY_LENGTH,
  N8N_DEFAULT_CALLBACK_MAX_AGE_MS,
  type N8nConfig,
  type N8nConfigInput,
} from "./config.js";

export {
  verifyCallbackSignature,
  signCallback,
  hashPayload,
  buildIdempotencyKey,
  type CallbackSignatureResult,
  type CallbackFailureReason,
} from "./signature.js";

export {
  parseCallbackPayload,
  isCallbackFresh,
  type CallbackParseResult,
  type CallbackParseFailure,
} from "./callback-parser.js";

export {
  createN8nHttpClient,
  isSuccessResponse,
  extractError,
  N8nRequestError,
  type N8nHttpClient,
  type N8nHttpResponse,
  type N8nTriggerRequest,
} from "./client.js";

export {
  extractWorkflowTriggerTarget,
  WEBHOOK_NODE_TYPE,
  type N8nWorkflowTriggerTarget,
} from "./trigger-target.js";

export {
  createN8nApiClient,
  N8N_MAX_PAGE_SIZE,
  N8N_MAX_LIST_PAGES,
  type N8nApiClient,
  type N8nApiResult,
  type N8nRemoteWorkflow,
  type N8nWorkflowPage,
  type N8nRemoteExecution,
  type N8nExecutionPage,
  type N8nListWorkflowsParams,
  type N8nListExecutionsParams,
  type N8nListAllWorkflowsOptions,
  type N8nWorkflowTraversal,
} from "./api-client.js";

export {
  classifyN8nError,
  classifyTransportError,
  toJarvisError,
  redactSensitiveInfo,
  type ClassifiedN8nError,
  type N8nErrorCode,
} from "./error-handler.js";

// Phase 18, Stage 18.5 — the pinned, reduced copy of n8n's own parameter
// schemas. Plain data, generated once from a verified upstream package; the
// rules that read it are core's (`loadNodeSchemaRegistry`).
export { N8N_NODE_SCHEMA_SNAPSHOT } from "./node-schema.js";

export {
  N8nCloudProvider,
  createN8nProvider,
  type N8nProvider,
  type N8nApiProvider,
  type N8nCloudProviderConfig,
  type N8nProviderCallOptions,
} from "./provider.js";

export {
  createN8nMcpConfig,
  resolveN8nMcpEndpoint,
  isN8nMcpEnabled,
  isN8nMcpConfigured,
  N8N_MCP_DEFAULT_TIMEOUT_MS,
  N8N_MCP_ENDPOINT_PATH,
  type N8nMcpConfig,
  type N8nMcpConfigInput,
} from "./mcp-config.js";

export {
  createN8nMcpConnector,
  n8nMcpAutomationRecords,
  type N8nMcpConnector,
  type N8nMcpConnectorOptions,
  type N8nMcpDiscovery,
  type N8nMcpResult,
  type N8nMcpServerInfo,
  type N8nMcpTool,
  type N8nMcpTransport,
} from "./mcp-connector.js";

// Phase 18, Stage 18.1 — one page of the workflow list, for the Automation Library.
export { createN8nLibraryPageSource, createN8nLibraryTriggerTargetSource } from "./library-source.js";

export {
  buildAutomationCatalog,
  type AutomationCatalog,
  type AutomationCatalogInput,
  type AutomationSource,
  type AutomationSourceReport,
} from "./automation-catalog.js";

// ---------------------------------------------------------------------------
// n8n Sandbox Service (additive; unrelated to the Public REST API above)
// ---------------------------------------------------------------------------
// A third n8n surface. These exports do not change the behaviour of any
// existing one: `api-client.ts`, `client.ts`, `provider.ts`, `config.ts` and
// `mcp-connector.ts` are untouched. Building a client is not exposure — no
// route, tool or agent receives one unless a later change wires it.
export {
  createN8nSandboxConfig,
  isN8nSandboxConfigured,
  describeN8nSandboxStatus,
  N8N_SANDBOX_DEFAULT_REQUEST_TIMEOUT_MS,
  N8N_SANDBOX_MAX_REQUEST_TIMEOUT_MS,
  N8N_SANDBOX_DEFAULT_EXECUTION_TIMEOUT_MS,
  N8N_SANDBOX_MAX_EXECUTION_TIMEOUT_MS,
  N8N_SANDBOX_EXECUTION_GRACE_MS,
  N8N_SANDBOX_DEFAULT_MAX_OUTPUT_BYTES,
  N8N_SANDBOX_MAX_OUTPUT_BYTES,
  type N8nSandboxConfig,
  type N8nSandboxConfigInput,
} from "./sandbox-config.js";

export {
  N8nSandboxError,
  classifySandboxHttpError,
  classifySandboxTransportError,
  redactSandboxText,
  malformedSandboxResponseError,
  incompleteSandboxStreamError,
  type N8nSandboxErrorCode,
  type N8nSandboxErrorOptions,
  type N8nSandboxResult,
} from "./sandbox-error.js";

export {
  parseN8nSandboxEvent,
  createN8nSandboxNdjsonDecoder,
  isTerminalSandboxEvent,
  N8N_SANDBOX_MAX_NDJSON_LINE_LENGTH,
  type N8nSandboxEvent,
  type N8nSandboxStartedEvent,
  type N8nSandboxOutputEvent,
  type N8nSandboxExitEvent,
  type N8nSandboxErrorEvent,
  type N8nSandboxNdjsonDecoder,
} from "./sandbox-ndjson.js";

export {
  createN8nSandboxClient,
  type N8nSandboxClient,
  type N8nSandboxClientOptions,
  type N8nSandboxFetch,
  type N8nSandbox,
  type N8nSandboxCreateOptions,
  type N8nSandboxExecutionRequest,
  type N8nSandboxExecutionResult,
  type N8nSandboxExecutionSnapshot,
  type N8nSandboxRequestOptions,
  type N8nSandboxResumeOptions,
} from "./sandbox-client.js";

