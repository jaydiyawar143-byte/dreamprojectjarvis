export { AuthService } from "./auth.js";
export { PermissionService } from "./permissions.js";
export {
  authorizeAutomationOperation,
  classifyAutomationRisk,
  capabilityKindForRisk,
  grantsForAutomationRole,
  AUTOMATION_PERMISSIONS,
  type AutomationSurface,
  type AutomationPermission,
  type AutomationCallSubject,
  type AutomationResourceScope,
  type AutomationAuthzInput,
  type AutomationAuthzDecision,
  type AutomationAuthzDenyCode,
} from "./automation-authz.js";
export { AuditLogger, redactAuditParams } from "./audit.js";
export { ApprovalService } from "./approval.js";
export { ToolApprovalService } from "./tool-approval.js";
export type { ToolApprovalConfig } from "./tool-approval.js";
export { PasswordHasher } from "./password.js";
export { TokenService } from "./tokens.js";
export { AuthService as AuthManager } from "./auth-service.js";
export {
  EncryptionService,
  EncryptionError,
  parseKey,
  generateKey,
  safeEqual,
  type EncryptionKey,
  type EncryptionErrorCode,
} from "./crypto.js";
