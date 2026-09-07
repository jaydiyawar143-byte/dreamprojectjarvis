import { Router } from "express";
import type { Request, Response } from "express";
import {
  RegisterInputSchema,
  LoginInputSchema,
  RefreshInputSchema,
} from "@jarvis/core";
import type { AuthManager, TokenService } from "@jarvis/security";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  IpRateLimiter,
  IP_RATE_LIMITS,
  clientKey,
  type IpRateLimitRule,
} from "../services/ip-rate-limiter.js";

export function createAuthRouter(
  authService: AuthManager,
  tokenService: TokenService
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(tokenService);

  // -------------------------------------------------------------------------
  // Sprint 9.7 — throttle the unauthenticated endpoints.
  //
  // These had NO limit of any kind: no lockout, no backoff, no captcha. A
  // password could be guessed as fast as the network allowed. The DB-backed
  // limiter cannot serve them because it counts audit rows keyed on a userId
  // that does not exist until login succeeds, so this is keyed on the client
  // address instead. Per-process — see ip-rate-limiter.ts.
  // -------------------------------------------------------------------------
  const ipLimiter = new IpRateLimiter();

  /** Returns true when the caller has been refused and a response is already sent. */
  function throttled(
    req: Request,
    res: Response,
    bucket: string,
    rule: IpRateLimitRule
  ): boolean {
    const decision = ipLimiter.check(`${bucket}:${clientKey(req)}`, rule);
    if (decision.allowed) return false;

    res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    res.status(429).json({
      success: false,
      // Deliberately says nothing about whether the account exists or the
      // password was close. A throttle response is not an oracle.
      error: { code: "RATE_LIMITED", message: "Too many attempts. Try again shortly." },
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  router.post("/register", async (req: Request, res: Response) => {
    if (throttled(req, res, "register", IP_RATE_LIMITS.register)) return;

    try {
      const parsed = RegisterInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid registration input",
            details: parsed.error.flatten().fieldErrors,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const result = await authService.register(parsed.data, {
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      res.status(201).json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
      const message = (error as Error).message ?? "Internal server error";
      res.status(statusCode).json({
        success: false,
        error: { code, message },
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post("/login", async (req: Request, res: Response) => {
    if (throttled(req, res, "login", IP_RATE_LIMITS.login)) return;

    try {
      const parsed = LoginInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid login input",
            details: parsed.error.flatten().fieldErrors,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const result = await authService.login(parsed.data, {
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      res.status(200).json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
      const message = (error as Error).message ?? "Internal server error";
      res.status(statusCode).json({
        success: false,
        error: { code, message },
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post("/refresh", async (req: Request, res: Response) => {
    if (throttled(req, res, "refresh", IP_RATE_LIMITS.refresh)) return;

    try {
      const parsed = RefreshInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid refresh input",
            details: parsed.error.flatten().fieldErrors,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const tokens = await authService.refresh(parsed.data.refreshToken, {
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      res.status(200).json({
        success: true,
        data: tokens,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
      const message = (error as Error).message ?? "Internal server error";
      res.status(statusCode).json({
        success: false,
        error: { code, message },
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post("/logout", async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Refresh token is required",
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      await authService.logout(refreshToken);

      res.status(200).json({
        success: true,
        data: { message: "Logged out successfully" },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.get(
    "/me",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!req.auth) {
          res.status(401).json({
            success: false,
            error: {
              code: "AUTHENTICATION_REQUIRED",
              message: "Authentication required",
            },
            timestamp: new Date().toISOString(),
          });
          return;
        }

        const user = await authService.getMe(req.auth.userId);

        res.status(200).json({
          success: true,
          data: user,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
        const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
        const message = (error as Error).message ?? "Internal server error";
        res.status(statusCode).json({
          success: false,
          error: { code, message },
          timestamp: new Date().toISOString(),
        });
      }
    }
  );

  return router;
}
