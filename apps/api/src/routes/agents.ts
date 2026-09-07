import { Router } from "express";
import type { Response } from "express";

import { AGENT_POLICIES } from "@jarvis/agents";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import type { Container } from "../services/container.js";

// ---------------------------------------------------------------------------
// UI V2 — GET /api/v1/agents
//
// The agent registry has been server-authoritative since Sprint 6 and complete
// since Sprint 7, but its only exit was a startup `console.log`. A client could
// pass `agentId` to POST /chat yet had no way to discover which ids were valid,
// which were selectable, or which needed approval.
//
// This is a READ of static, server-owned policy plus live registration state.
// It grants nothing: naming an agent here does not widen what that agent may
// do, because the Orchestrator reads the policy from the registry on every
// step, never from the request.
//
// TWO SOURCES, DELIBERATELY JOINED:
//
//   AGENT_POLICIES  — what an agent is ALLOWED to do. Static, compiled in.
//   agentRegistry   — which agents actually REGISTERED in this process.
//
// Four of the eight register conditionally (google-ads needs `google.accounts`,
// automation needs `n8n.trigger`, communication needs `whatsapp.send`, browser
// needs `browser.navigate`). Reporting policy alone would tell the UI this
// deployment has capabilities it does not have, which is the specific failure
// the "do not fabricate" rule exists to prevent.
//
// WHAT IS NOT RETURNED: no tool parameter schemas, no provider names, no
// credentials, no model ids, no prompt text. `allowedTools` is a list of tool
// IDS, which are already visible to any user who reads a tool result.
// ---------------------------------------------------------------------------

/** One agent as the UI sees it. */
export interface AgentSummary {
  agentId: string;
  domain: string;
  description: string;
  /** Registry tool ids this agent may execute. Empty is meaningful. */
  allowedTools: string[];
  toolCount: number;
  /** True when every non-read action this agent takes stops at a human. */
  writesRequireApproval: boolean;
  /** Whether a client may name this agent on a chat request. */
  clientSelectable: boolean;
  /** Whether this process actually constructed the agent. */
  registered: boolean;
  /** What the UI should show as a status chip. */
  availability: "AVAILABLE" | "UNAVAILABLE";
}

export function createAgentsRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  router.get(
    "/",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!req.auth) {
        res.status(401).json({
          success: false,
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const registeredIds = new Set(container.agentRegistry.getAll().map((agent) => agent.id));

      const agents: AgentSummary[] = Object.values(AGENT_POLICIES).map((policy) => {
        const registered = registeredIds.has(policy.agentId);
        return {
          agentId: policy.agentId,
          domain: policy.domain,
          description: policy.description,
          allowedTools: [...policy.allowedTools],
          toolCount: policy.allowedTools.length,
          writesRequireApproval: policy.writesRequireApproval,
          clientSelectable: policy.clientSelectable,
          registered,
          availability: registered ? "AVAILABLE" : "UNAVAILABLE",
        };
      });

      // Available first, then alphabetical — a deployment's usable agents
      // should not be buried under ones it cannot reach.
      agents.sort((a, b) => {
        if (a.registered !== b.registered) return a.registered ? -1 : 1;
        return a.agentId.localeCompare(b.agentId);
      });

      res.status(200).json({
        success: true,
        data: {
          agents,
          total: agents.length,
          registeredCount: agents.filter((agent) => agent.registered).length,
        },
        timestamp: new Date().toISOString(),
      });
    })
  );

  return router;
}
