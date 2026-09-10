export { ToolRegistry, type ToolHealth, type ToolFilter } from "./registry.js";
export { BaseTool } from "./base-tool.js";
export { ToolExecutor } from "./executor.js";
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
  createAmbientTools,
} from "./tools/ambient-tools.js";
export type {
  WeatherPort,
  MarketPort,
  SystemPort,
  AmbientOutcome,
  WeatherReading,
  MarketQuote,
  SystemReading,
} from "./tools/ambient-tools.js";
