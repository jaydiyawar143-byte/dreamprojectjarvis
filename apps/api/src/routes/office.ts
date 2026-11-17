// ---------------------------------------------------------------------------
// VO-3.1 — the office's per-agent read.
//
//   GET /api/v1/office/agent-work   what each agent is doing, for the caller
//
// Read-only. The caller is the authenticated user and nothing else: there is
// no user, tenant or agent parameter, so there is nothing a request could set
// to read someone else's work. See `OfficeAgentWorkService` for what it holds.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";

import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import type { Container } from "../services/container.js";
import { OfficeAgentWorkService } from "../services/office/agent-work-service.js";

export function createOfficeRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  const service = new OfficeAgentWorkService({
    tasks: container.taskService,
    approvals: container.approvalRepo,
    // The SAME registry the executor consults, so a tool's risk here cannot
    // drift from the risk that gates it. Unknown tool: no risk, not a guess.
    toolRisk: (toolId) => {
      try {
        return container.toolRegistry.get(toolId)?.risk;
      } catch {
        return undefined;
      }
    },
  });

  router.get(
    "/agent-work",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.auth?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const data = await service.forUser(userId);
      res.status(200).json({ success: true, data, timestamp: new Date().toISOString() });
    })
  );

  return router;
}
