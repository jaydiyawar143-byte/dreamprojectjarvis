export { ToolRegistry, type ToolHealth, type ToolFilter } from "./registry.js";
export { BaseTool } from "./base-tool.js";
export { ToolExecutor, DEFAULT_TOOL_EXECUTION_TIMEOUT_MS } from "./executor.js";
export { MemoryExecutionJournal, isAmbiguousWriteError, classifyWriteOutcome } from "./execution-journal.js";
export { SystemEchoTool } from "./tools/system-echo.js";
export { WebResearchTool, type SearchProvider, type WebSearchResult } from "./tools/web-research.js";
export { PdfGeneratorTool, type PdfGeneratorBackend, type PdfContent, type PdfSection } from "./tools/pdf-generator.js";
export { CsvAnalyzerTool } from "./tools/csv-analyzer.js";
export { DocumentAnalyzerTool, type DocumentExtractor } from "./tools/document-analyzer.js";
export {
  sanitizeToolResult,
  wrapToolResult,
  validateToolResultSchema,
  sanitizeOutputForModel,
  type SanitizeOptions,
  type SanitizedToolResult,
} from "./output-sanitizer.js";
export {
  MetaGetAccountsTool,
  MetaGetCampaignsTool,
  MetaGetAdSetsTool,
  MetaGetAdsTool,
  MetaGetInsightsTool,
} from "./tools/meta-ads-tools.js";
export {
  AnalysisGenerator,
  DEFAULT_MAX_ENTITIES_SCANNED,
  DEFAULT_MAX_INSIGHT_ROWS,
  DEFAULT_LOOKBACK_DAYS,
  type AnalysisCaller,
  type AnalysisConfig,
  type AnalysisExplanation,
  type AnalysisGeneratorDeps,
  type AnalysisInput,
  type AnalysisOutcome,
  type AnalysisScanSummary,
  type AnalysisTargetInfo,
  type AnalysisNoAnalysisReason,
} from "./analysis-generator.js";
export { MetaAnalyzeTool, type MetaAnalyzePort } from "./tools/meta-analysis-tool.js";
export {
  MetaPauseCampaignTool,
  MetaResumeCampaignTool,
  MetaPauseAdSetTool,
  MetaResumeAdSetTool,
  MetaPauseAdTool,
  MetaResumeAdTool,
  MetaUpdateCampaignBudgetTool,
  MetaUpdateAdSetBudgetTool,
  MetaCreateCampaignTool,
  validateCampaignProposal,
} from "./tools/meta-ads-write-tools.js";
export type { MetaExecutionState } from "./tools/meta-ads-write-tools.js";
export type { MetaAdsProvider, MetaAdsWriteProvider, MetaAdsBudgetProvider, MetaCampaignCreatorProvider, MetaAccountAuthorizer, ProviderCallOptions } from "./tools/meta-ads-provider.js";
export {
  createMockMetaProvider,
  createFailingMetaProvider,
  createEmptyMetaProvider,
  type MockMetaProviderConfig,
} from "./tools/meta-ads-mock.js";
export {
  validateAccountId,
  validateEntityId,
  validateDateRange,
  validateLimit,
  validateMetrics,
  validateBreakdown,
  META_ADS_CONSTANTS,
} from "./tools/meta-ads-validators.js";
export {
  DEFAULT_BUDGET_GUARDRAILS,
  validateBudgetAmount,
  validateBudgetTransition,
  buildBudgetChangeSummary,
  verifyBudgetResult,
} from "./tools/meta-ads-budget-guardrails.js";
export {
  ReconciliationService,
  parseCreateCampaignEvidence,
  type ReconciliationRequest,
  type ReconciliationAttemptResult,
  type ReconciliationServiceDeps,
} from "./reconciliation.js";
export {
  runStartupRecovery,
  type StartupRecoveryReport,
} from "./startup-recovery.js";
export {
  RecommendationExecutionService,
  createExecutorBackedExternalStatePort,
  resolveToolForAction,
  RECOMMENDATION_ACTION_TOOLS,
  type RecommendationExecutionDeps,
  type RecommendationExecutionInput,
  type RecommendationExecutionOutcome,
  type RecommendationExecutionStorePort,
  type AllowlistResolution,
  type StatePortContext,
} from "./recommendation-bridge.js";

// Sprint 5.2 — Google Ads (read-only)
export type { GoogleAdsProvider, GoogleAccountAuthorizer } from "./tools/google-ads-provider.js";
export {
  MockGoogleAdsProvider,
  DEFAULT_MOCK_CUSTOMERS,
  DEFAULT_MOCK_CAMPAIGNS,
  DEFAULT_MOCK_METRICS,
  type MockGoogleProviderConfig,
} from "./tools/google-ads-mock.js";
export {
  GoogleGetAccountsTool,
  GoogleGetCampaignsTool,
  GoogleGetInsightsTool,
  validateCustomerId,
  validateDateRange as validateGoogleDateRange,
} from "./tools/google-ads-tools.js";

// Sprint 5.3 — WhatsApp (outbound send, approval-gated)
export {
  WhatsAppSendMessageTool,
  RepositoryRecipientAuthorizer,
  validateWaId,
  validateMessageBody,
  type WhatsAppSendProvider,
  type WhatsAppRecipientAuthorizer,
  type WhatsAppSendOptions,
} from "./tools/whatsapp-tools.js";
export { MockWhatsAppProvider, type MockWhatsAppProviderConfig } from "./tools/whatsapp-mock.js";

// Sprint 5.4 — n8n workflow trigger (approval-gated)
export {
  N8nTriggerWorkflowTool,
  validateTriggerPayload,
  type N8nTriggerProvider,
  type N8nTriggerOptions,
  type N8nKeyDeriver,
} from "./tools/n8n-tools.js";
export { MockN8nProvider, mockKeyDeriver, type MockN8nProviderConfig } from "./tools/n8n-mock.js";

// Sprint 7.3 — controlled browser automation (reads open, actions approval-gated)
export {
  BrowserNavigateTool,
  BrowserInspectTool,
  BrowserExtractTool,
  BrowserScreenshotTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserSelectTool,
  BrowserDownloadTool,
  BrowserSubmitTool,
  BrowserUploadTool,
  createBrowserTools,
} from "./tools/browser-tools.js";

// Google Maps — all READ_ONLY. See tools/maps-tools.ts for why location is
// never a model-supplied parameter.
export {
  MapsSearchPlaceTool,
  MapsNearbySearchTool,
  MapsGeocodeTool,
  MapsReverseGeocodeTool,
  MapsCurrentLocationTool,
  MapsRouteTool,
  MapsDistanceTool,
  MapsGetPlaceTool,
  MAPS_TOOL_IDS,
  createMapsTools,
} from "./tools/maps-tools.js";
export type {
  MapsPort,
  CurrentLocationPort,
  MapsPlace,
  MapsRoute,
  MapsOutcome,
  Coordinates,
} from "./tools/maps-tools.js";

// Ambient capability — weather, markets, this machine. All READ_ONLY, all over
// the providers the dashboard widgets already use. See tools/ambient-tools.ts
// for why the assistant needed these to exist at all.
export {
  WeatherCurrentTool,
  MarketQuoteTool,
  SystemStatusTool,
  TimeNowTool,
  TasksListTool,
  createAmbientTools,
} from "./tools/ambient-tools.js";
export type {
  WeatherPort,
  MarketPort,
  SystemPort,
  TasksPort,
  TaskReading,
  AmbientOutcome,
  WeatherReading,
  MarketQuote,
  SystemReading,
} from "./tools/ambient-tools.js";

// Core V1 — the task lifecycle surface. Separate from `tasks.list` above:
// that one reads the user's todos for the dashboard, these manage the work
// JARVIS has been asked to hold on to. Both end up in the same table; see the
// Task model in schema.prisma for why that is one store and not two.
export {
  TaskCreateTool,
  TaskListTool,
  TaskGetTool,
  TaskUpdateStatusTool,
  createTaskTools,
  TASK_TOOL_IDS,
} from "./tools/task-tools.js";
export type { TaskPort, TaskView } from "./tools/task-tools.js";

// Integration management — the JARVIS arm of the universal integration
// contract. Every tool here delegates to IntegrationCommandPort, which the API
// implements over the SAME IntegrationCommandService the REST routes use.
export {
  ListIntegrationsTool,
  GetIntegrationStatusTool,
  GetIntegrationHealthTool,
  GetIntegrationPermissionsTool,
  GetIntegrationAuditTool,
  TestIntegrationConnectionTool,
  ValidateIntegrationConfigTool,
  ConnectIntegrationTool,
  ConfigureIntegrationTool,
  ReconnectIntegrationTool,
  EnableIntegrationTool,
  DisableIntegrationTool,
  DisconnectIntegrationTool,
  createIntegrationTools,
  INTEGRATION_TOOL_IDS,
} from "./tools/integration-tools.js";
export type { IntegrationCommandPort } from "./tools/integration-tools.js";

// Capability discovery — the answer to "what can you do?", derived from the
// live registry and real integration state rather than from a system prompt.
export {
  GetAvailableCapabilitiesTool,
  GetConnectedIntegrationsTool,
  GetIntegrationCapabilitiesTool,
  GetPermissionsOverviewTool,
  createCapabilityTools,
  CAPABILITY_TOOL_IDS,
  // Core V1 — the same question one level up: not what JARVIS can do, but
  // what JARVIS is.
  DescribeSelfTool,
  createSelfTools,
  SELF_TOOL_IDS,
} from "./tools/capability-tools.js";
export type { CapabilityPort, SelfKnowledgePort } from "./tools/capability-tools.js";

// Phase 12 — real read-only Gmail, Drive and Calendar tasks. Every tool routes
// to the SAME GoogleWorkspaceTaskService the dashboard panels call.
export {
  ListUnreadGmailTool,
  SearchGmailTool,
  GetGmailMessageTool,
  GetGmailThreadTool,
  SearchDriveFilesTool,
  ListRecentDriveFilesTool,
  GetDriveFileMetadataTool,
  ListUpcomingCalendarEventsTool,
  GetCalendarEventTool,
  createGoogleWorkspaceTools,
  GOOGLE_WORKSPACE_TOOL_IDS,
} from "./tools/google-workspace-tools.js";
export type { GoogleWorkspaceTaskPort } from "./tools/google-workspace-tools.js";

// Phase 13 — Google write PLANNING tools. Ten planners, zero executors: the
// port they hold has no `execute`, so a model cannot perform a Google write
// however it is prompted. Execution happens only via an approved approval.
export {
  CreateGmailDraftTool,
  UpdateGmailDraftTool,
  RequestSendGmailDraftTool,
  CreateDriveFolderTool,
  UploadDriveFileTool,
  MoveDriveFileTool,
  RenameDriveFileTool,
  CreateCalendarEventTool,
  UpdateCalendarEventTool,
  DeleteCalendarEventTool,
  createGoogleWriteTools,
  GOOGLE_WRITE_TOOL_IDS,
} from "./tools/google-write-tools.js";
export type { GoogleWritePlanPort } from "./tools/google-write-tools.js";
