import { Router } from "express";
import type { Request, Response } from "express";
import {
  RegisterInputSchema,
  LoginInputSchema,
  RefreshInputSchema,
} from "@jarvis/core";
import type { AuthManager, TokenService } from "@jarvis/security";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";

export function createAuthRouter(
  authService: AuthManager,
  tokenService: TokenService
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(tokenService);

  router.post("/register", async (req: Request, res: Response) => {
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
