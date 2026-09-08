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
import {
  clearRefreshCookie,
  readRefreshToken,
  setRefreshCookie,
  wantsCookieAuth,
} from "../lib/auth-cookies.js";

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

  // ---------------------------------------------------------------------------
  // UI V2 — one place that decides how the refresh token leaves the process.
  //
  // A browser (X-Auth-Mode: cookie) gets it as an HttpOnly cookie and NOT in
  // the body, so page scripts can never read it. Every other client keeps the
  // original body contract. Returning both would defeat the point.
  // ---------------------------------------------------------------------------
  function issueSession<T extends { tokens: { refreshToken: string } }>(
    req: Request,
    res: Response,
    result: T,
    status: number
  ): void {
    if (!wantsCookieAuth(req)) {
      res.status(status).json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Absent or falsey "rememberMe" means a session cookie: gone when the
    // browser closes. Present and true pins it to the refresh token's lifetime.
    const remember = (req.body as { rememberMe?: unknown } | undefined)?.rememberMe === true;
    setRefreshCookie(res, result.tokens.refreshToken, { remember });

    const { refreshToken: _omitted, ...safeTokens } = result.tokens;
    res.status(status).json({
      success: true,
      data: { ...result, tokens: safeTokens },
      timestamp: new Date().toISOString(),
    });
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

      issueSession(req, res, result, 201);
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

      issueSession(req, res, result, 200);
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
      // Cookie first: a browser session carries no token in the body, and a
      // stale body value must never take precedence over the live cookie.
      const presented = readRefreshToken(req, (req.body as { refreshToken?: unknown })?.refreshToken);
      if (!presented) {
        // A browser asking "do I have a session?" on a cold load presents no
        // cookie and no body. That is not a malformed request — it is an
        // unauthenticated one, and answering 400 made every visit to the login
        // page log a console error for a completely normal condition.
        //
        // Body-mode callers that genuinely sent a malformed payload still get
        // the field-level detail they had before.
        const malformed = req.body != null && Object.keys(req.body as object).length > 0;
        if (malformed) {
          const parsed = RefreshInputSchema.safeParse(req.body);
          if (!parsed.success && (req.body as { refreshToken?: unknown }).refreshToken !== undefined) {
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
        }

        res.status(401).json({
          success: false,
          error: {
            code: "AUTHENTICATION_REQUIRED",
            message: "No session to refresh",
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const tokens = await authService.refresh(presented, {
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      // NOTE: this route returns the token pair at the TOP level of `data`,
      // unlike login/register which nest it under `tokens`. That shape is part
      // of the existing contract, so it is preserved rather than normalised.
      if (!wantsCookieAuth(req)) {
        res.status(200).json({
          success: true,
          data: tokens,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Refresh ROTATES the token, so the cookie must be replaced or the next
      // refresh would present a revoked one.
      //
      // The client re-states `rememberMe` on every refresh because the server
      // cannot observe it: an HttpOnly cookie does not report back whether the
      // browser is holding it as a session or a persistent one. Defaulting to
      // a session cookie means a caller that says nothing can never silently
      // UPGRADE a deliberately-temporary session into a week-long one.
      const remember = (req.body as { rememberMe?: unknown } | undefined)?.rememberMe === true;
      setRefreshCookie(res, tokens.refreshToken, { remember });

      const { refreshToken: _omitted, ...safeTokens } = tokens;
      res.status(200).json({
        success: true,
        data: safeTokens,
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
      const presented = readRefreshToken(req, (req.body as { refreshToken?: unknown })?.refreshToken);
      if (!presented) {
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

      await authService.logout(presented);

      // Always clear, regardless of transport. Revoking the token server-side
      // while leaving the cookie in the browser would make every later request
      // present a credential that can only fail.
      clearRefreshCookie(res);

      res.status(200).json({
        success: true,
        data: { message: "Logged out successfully" },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // The session is being torn down; the cookie should not outlive the
      // attempt even if revocation failed.
      clearRefreshCookie(res);
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
