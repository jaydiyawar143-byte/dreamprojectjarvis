import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";
import type { ITokenService } from "@jarvis/core";

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_LENGTH = 64;
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

export class TokenService implements ITokenService {
  constructor(
    private secret: string,
    private issuer: string = "jarvis"
  ) {}

  generateAccessToken(payload: {
    userId: string;
    role: string;
    email: string;
  }): string {
    return jwt.sign(
      {
        sub: payload.userId,
        role: payload.role,
        email: payload.email,
      },
      this.secret,
      {
        expiresIn: ACCESS_TOKEN_EXPIRY,
        issuer: this.issuer,
        audience: "jarvis-api",
      }
    );
  }

  generateRefreshToken(): string {
    return randomBytes(REFRESH_TOKEN_LENGTH).toString("hex");
  }

  verifyAccessToken(
    token: string
  ): { userId: string; role: string; email: string } | null {
    try {
      const decoded = jwt.verify(token, this.secret, {
        issuer: this.issuer,
        audience: "jarvis-api",
      }) as jwt.JwtPayload;

      if (!decoded.sub || !decoded.role || !decoded.email) {
        return null;
      }

      return {
        userId: decoded.sub,
        role: decoded.role,
        email: decoded.email,
      };
    } catch {
      return null;
    }
  }

  hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  getRefreshTokenExpiry(): Date {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);
    return expiry;
  }
}
