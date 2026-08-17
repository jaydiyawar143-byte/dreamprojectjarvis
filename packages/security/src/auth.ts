import jwt from "jsonwebtoken";
import type { Role } from "@jarvis/core";

export class AuthService {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  generateToken(userId: string, role: Role): string {
    return jwt.sign({ userId, role }, this.secret, { expiresIn: "24h" });
  }

  verifyToken(
    token: string
  ): { userId: string; role: Role } | null {
    try {
      const decoded = jwt.verify(token, this.secret) as {
        userId: string;
        role: Role;
      };
      return decoded;
    } catch {
      return null;
    }
  }

  extractTokenFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader?.startsWith("Bearer ")) {
      return null;
    }
    return authHeader.slice(7);
  }
}
