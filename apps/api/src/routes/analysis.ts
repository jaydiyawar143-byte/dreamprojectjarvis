// ---------------------------------------------------------------------------
// Phase 11.10 — On-demand Analysis API Route
//
//   POST /api/v1/analysis     run full read + diagnosis + PROPOSED generation
//                             { dryRun?: boolean } — accountId NEVER accepted
//
// The JARVIS arm of the ONE shared AnalysisGenerator (the `meta.analyze` tool
// is the other). Both paths call the SAME container.analysisService instance,
// so a dashboard button and a spoken request run identical authorization,
// safety caps, in-flight guarding and persistence. See
// apps/api/test/analysis-parity.test.ts, which instruments one service and
// proves both arms reach it.
//
// Security architecture:
//  - All work scoped to req.auth.userId (+ the token's own meta.accounts
//    read inside the generator) — IDOR-safe by construction.
//  - The ad account id ALWAYS comes from process.env.META_AD_ACCOUNT_ID.
//    A client-supplied accountId is ignored: a client can never redirect
//    analysis at an account the token does not own.
//  - Dry-run exists and is honored: it stops exactly at the generate boundary
//    and creates no durable row.
//  - Expected provider/config failures are deterministic HTTP codes, never a
//    500: ACCOUNT_NOT_CONFIGURED(503), AI_PROVIDER_NOT_CONFIGURED(503),
//    META_READ_FAILED(502), AI_PROVIDER_UNAVAILABLE(503).
//  - ZERO secrets in any response: the analysis outcome carries scan summary,
//    diagnosis and recommendation verdict only.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import type { AnalysisNoAnalysisReason, AnalysisOutcome } from "@jarvis/tools";

function fail(
  res: Response,
  status: number,
  code: string,
  message: string
): void {
  res.status(status).json({
    success: false,
    error: { code, message },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Deterministic NO_ANALYSIS → HTTP mapping. A request that RAN and found
 * nothing actionable is a 200 carrying the verdict; a request that could not
 * run is an error code naming the failure.
 */
function mapNoAnalysis(
  reason: AnalysisNoAnalysisReason
): { status: number; code: string } {
  switch (reason) {
    case "INVALID_INPUT":
      return { status: 400, code: "INVALID_INPUT" };
    case "ACCOUNT_UNAUTHORIZED":
      return { status: 403, code: "ACCOUNT_UNAUTHORIZED" };
    case "ALREADY_RUNNING":
      return { status: 409, code: "ANALYSIS_ALREADY_RUNNING" };
    case "READ_FAILED":
      return { status: 502, code: "META_READ_FAILED" };
    case "DIAGNOSIS_UNAVAILABLE":
      return { status: 503, code: "AI_PROVIDER_UNAVAILABLE" };
    case "PERSIST_FAILED":
      return { status: 500, code: "RECOMMENDATION_PERSIST_FAILED" };
    // NO_SAFE_TARGET / INSUFFICIENT_DATA — legitimate negative answers.
    default:
      return { status: 200, code: "OK" };
  }
}

export function createAnalysisRouter(container: Container): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  router.post("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTH_REQUIRED", "Authentication required");
    const { userId, role } = req.auth;

    const service = container.analysisService;
    if (!service) {
      if (!process.env.META_ACCESS_TOKEN || !process.env.META_AD_ACCOUNT_ID) {
        return fail(
          res,
          503,
          "ACCOUNT_NOT_CONFIGURED",
          "Meta ad account not configured on this server"
        );
      }
      return fail(
        res,
        503,
        "AI_PROVIDER_NOT_CONFIGURED",
        "AI provider not configured on this server"
      );
    }

    // Dry-run only. Note what is NOT read here: `accountId`. The ad account is
    // the server-configured one, always — a client cannot redirect analysis.
    const dryRun = req.body?.dryRun === true;
    const traceId = crypto.randomUUID();

    let outcome: AnalysisOutcome;
    try {
      outcome = await service.analyze({ dryRun }, {
        userId,
        role,
        traceId,
        ipAddress: req.ip,
      });
    } catch {
      // Unexpected internal failure. Deliberately generic: the analysis path
      // turns every EXPECTED failure (provider, Meta, config) into a typed
      // NO_ANALYSIS outcome mapped above, so anything that throws here is
      // either a bug or a DB fault — and its message must not leave the box.
      return fail(res, 500, "INTERNAL_ERROR", "Analysis failed unexpectedly");
    }

    if (outcome.status === "NO_ANALYSIS") {
      const mapped = mapNoAnalysis(outcome.reason);
      if (mapped.status === 200) {
        res.json({ success: true, analysis: outcome, timestamp: new Date().toISOString() });
        return;
      }
      return fail(res, mapped.status, mapped.code, outcome.message);
    }

    res.json({ success: true, analysis: outcome, timestamp: new Date().toISOString() });
  });

  return router;
}