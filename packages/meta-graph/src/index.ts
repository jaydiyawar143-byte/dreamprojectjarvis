export { createMetaGraphProvider, type MetaGraphProvider, type MetaGraphProviderConfig } from "./provider.js";
export { createMetaConfig, normalizeAccountId, buildBaseUrl, isPagePublishingEnabled, META_GRAPH_API_HOST, META_DEFAULT_API_VERSION, type MetaConfig, type MetaConfigInput } from "./config.js";
export { createMetaHttpClient, isSuccessResponse, extractError, MetaRequestAbortedError, type MetaHttpClient, type MetaHttpRequest, type MetaHttpResponse, type MetaAbortPhase } from "./client.js";
export { classifyMetaError, toJarvisError, type ClassifiedMetaError, type MetaErrorCode } from "./error-handler.js";
export {
  parseAdAccount,
  parseCampaign,
  parseAdSet,
  parseAd,
  parseInsights,
  extractNextPage,
  type MetaListResponse,
} from "./response-validator.js";
export { MetaCampaignReconciler, type MetaCampaignReconcilerOptions } from "./reconciler.js";
// Phase 15 — publishing a text post to a Facebook Page, behind the
// ContentPublisher contract. Reached only through the approval-gated
// marketing.content.publish tool.
export { createMetaPagePublisher, META_PAGE_PUBLISHER_ID, type MetaPagePublisherConfig } from "./page-publisher.js";
