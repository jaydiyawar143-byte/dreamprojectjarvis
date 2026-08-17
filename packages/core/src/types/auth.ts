import { z } from "zod";

export const RegisterInputSchema = z.object({
  email: z.string().email("Invalid email address"),
  name: z.string().min(1, "Name is required").max(100),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
});

export type RegisterInput = z.infer<typeof RegisterInputSchema>;

export const LoginInputSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof LoginInputSchema>;

export const RefreshInputSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

export type RefreshInput = z.infer<typeof RefreshInputSchema>;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface IPasswordHasher {
  hash(password: string): Promise<string>;
  compare(password: string, hash: string): Promise<boolean>;
}

export interface ITokenService {
  generateAccessToken(payload: { userId: string; role: string; email: string }): string;
  generateRefreshToken(): string;
  verifyAccessToken(token: string): { userId: string; role: string; email: string } | null;
  hashToken(token: string): string;
  getRefreshTokenExpiry(): Date;
}

export interface IRefreshTokenRepository {
  create(data: {
    userId: string;
    tokenHash: string;
    userAgent?: string;
    ipAddress?: string;
    expiresAt: Date;
  }): Promise<{ id: string }>;
  findByTokenHash(tokenHash: string): Promise<{
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
  } | null>;
  revoke(id: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
  deleteExpired(): Promise<number>;
}

export interface IUserRepository {
  create(data: {
    email: string;
    name: string;
    password: string;
    role?: string;
  }): Promise<{ id: string; email: string; name: string; role: string; createdAt: Date; updatedAt: Date }>;
  findByEmail(email: string): Promise<{
    id: string;
    email: string;
    name: string;
    password: string;
    role: string;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  findById(id: string): Promise<{
    id: string;
    email: string;
    name: string;
    role: string;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  updateLastLogin(id: string): Promise<void>;
}
