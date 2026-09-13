export {
  createGoogleConfig,
  isGoogleConfigured,
  createGoogleOAuthConfig,
  isGoogleOAuthConfigured,
  googleOAuthPresence,
  normalizeCustomerId,
  buildAdsBaseUrl,
  GOOGLE_ADS_SCOPE,
  GOOGLE_IDENTITY_SCOPES,
  ACCOUNT_IDENTITY_SCOPES,
  canonicalScope,
  grantCovers,
  REQUIRED_SCOPES,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_OAUTH_REVOKE_URL,
  GOOGLE_USERINFO_URL,
  GOOGLE_ADS_API_HOST,
  GOOGLE_ADS_DEFAULT_API_VERSION,
  type GoogleConfig,
  type GoogleConfigInput,
  type GoogleOAuthPresence,
} from "./config.js";

export {
  createPkcePair,
  createState,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  fetchUserInfo,
  hasRequiredScopes,
  hasIdentityScopes,
  GoogleOAuthError,
  type GoogleTokenSet,
  type PkcePair,
  type AuthUrlInput,
  type FetchLike,
} from "./oauth.js";

export {
  createGoogleAdsHttpClient,
  isSuccessResponse,
  extractError,
  GoogleRequestAbortedError,
  type GoogleAdsHttpClient,
  type GoogleHttpResponse,
  type GoogleSearchRequest,
  type GoogleAbortPhase,
} from "./client.js";

export {
  classifyGoogleError,
  toJarvisError,
  redactSensitiveInfo,
  type ClassifiedGoogleError,
  type GoogleErrorCode,
} from "./error-handler.js";

export {
  parseCustomer,
  parseCampaign,
  parseMetrics,
  extractRows,
  extractNextPageToken,
  microsToDecimal,
} from "./response-validator.js";

export {
  GoogleAdsGraphProvider,
  createGoogleAdsProvider,
  type GoogleAdsProviderConfig,
} from "./provider.js";
