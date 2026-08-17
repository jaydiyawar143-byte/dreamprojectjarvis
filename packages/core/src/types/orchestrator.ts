import type { JarvisRequest, JarvisResponse } from "./request.js";
import type { SessionContext } from "./context.js";

export interface OrchestratorConfig {
  maxToolExecutions?: number;
  maxOrchestrationDepth?: number;
  defaultTimeoutMs?: number;
}

export interface IOrchestrator {
  process(
    request: JarvisRequest,
    context: SessionContext
  ): Promise<JarvisResponse>;
}
