import type { Request, Response, NextFunction } from "express";
import type { TokenService } from "@jarvis/security";
import type { AuthContext } from "@jarvis/core";

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

export function createAuthMiddleware(tokenService: TokenService) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
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

    const token = authHeader.slice(7);
    const payload = tokenService.verifyAccessToken(token);

    if (!payload) {
      res.status(401).json({
        success: false,
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Invalid or expired token",
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    req.auth = {
      userId: payload.userId,
      role: payload.role as AuthContext["role"],
      email: payload.email,
    };

    next();
  };
}
