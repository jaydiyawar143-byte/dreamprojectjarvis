export {
  createOmniRouteConfig,
  isOmniRouteConfigured,
  OMNIROUTE_API_PATH,
  OMNIROUTE_DEFAULT_TIMEOUT_MS,
  type OmniRouteConfig,
  type OmniRouteConfigInput,
} from "./config.js";

export {
  checkOmniRouteConnection,
  omniRouteModelsUrl,
  OMNIROUTE_MAX_RESPONSE_CHARS,
  type OmniRouteCheckResult,
  type OmniRouteClientOptions,
  type OmniRouteFailureReason,
} from "./client.js";
