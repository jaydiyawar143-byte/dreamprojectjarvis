// Phase 10.6 — startup recovery lives in @jarvis/core (dependency-free);
// re-exported here so existing tools consumers keep their import path.
export {
  runStartupRecovery,
  type StartupRecoveryReport,
} from "@jarvis/core";
