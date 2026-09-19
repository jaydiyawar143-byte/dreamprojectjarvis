import type { Request, Response, NextFunction } from "express";
import type { AuthContext, ITokenService } from "@jarvis/core";

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

/**
 * Takes the INTERFACE, not the concrete `TokenService` class.
 *
 * Production passes the same `TokenService` instance it always did — the
 * object graph is unchanged. What changes is that the dependency is now stated
 * as the capability this middleware actually needs (`verifyAccessToken`)
 * rather than as one particular implementation of it. `TokenService` has
 * private fields, and a class with private members is only assignable from
 * instances of that class, so the old signature made an honest test double
 * impossible and forced a cast at every call site that wanted one.
 */
export function createAuthMiddleware(tokenService: ITokenService) {
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
