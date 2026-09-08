import { randomBytes } from "crypto";
import type {
  RegisterInput,
  LoginInput,
  TokenPair,
  SafeUser,
  IPasswordHasher,
  ITokenService,
  IRefreshTokenRepository,
  IUserRepository,
} from "@jarvis/core";
import {
  JarvisError,
  RegisterInputSchema,
  LoginInputSchema,
} from "@jarvis/core";

export class AuthService {
  constructor(
    private passwordHasher: IPasswordHasher,
    private tokenService: ITokenService,
    private refreshTokenRepo: IRefreshTokenRepository,
    private userRepo: IUserRepository
  ) {}

  async register(
    input: RegisterInput,
    meta?: { userAgent?: string; ipAddress?: string }
  ): Promise<{ user: SafeUser; tokens: TokenPair }> {
    const parsed = RegisterInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "Invalid registration input",
        { errors: parsed.error.flatten().fieldErrors }
      );
    }

    const existing = await this.userRepo.findByEmail(parsed.data.email);
    if (existing) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "An account with this email already exists"
      );
    }

    const hashedPassword = await this.passwordHasher.hash(parsed.data.password);

    const user = await this.userRepo.create({
      email: parsed.data.email,
      name: parsed.data.name,
      password: hashedPassword,
      role: "member",
    });

    const tokens = await this.issueTokens(user.id, user.role, user.email, meta);

    return {
      user: this.toSafeUser(user),
      tokens,
    };
  }

  async login(
    input: LoginInput,
    meta?: { userAgent?: string; ipAddress?: string }
  ): Promise<{ user: SafeUser; tokens: TokenPair }> {
    const parsed = LoginInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new JarvisError(
        "INVALID_REQUEST",
        "Invalid login input",
        { errors: parsed.error.flatten().fieldErrors }
      );
    }

    const user = await this.userRepo.findByEmail(parsed.data.email);

    if (!user) {
      throw new JarvisError(
        "AUTHENTICATION_REQUIRED",
        "Invalid email or password"
      );
    }

    const valid = await this.passwordHasher.compare(
      parsed.data.password,
      user.password
    );

    if (!valid) {
      throw new JarvisError(
        "AUTHENTICATION_REQUIRED",
        "Invalid email or password"
      );
    }

    await this.userRepo.updateLastLogin(user.id);

    const tokens = await this.issueTokens(
      user.id,
      user.role,
      user.email,
      meta
    );

    return {
      user: this.toSafeUser(user),
      tokens,
    };
  }

  async refresh(
    refreshToken: string,
    meta?: { userAgent?: string; ipAddress?: string }
  ): Promise<TokenPair> {
    const tokenHash = this.tokenService.hashToken(refreshToken);
    const stored = await this.refreshTokenRepo.findByTokenHash(tokenHash);

    if (!stored) {
      throw new JarvisError(
        "AUTHENTICATION_REQUIRED",
        "Invalid refresh token"
      );
    }

    if (stored.revokedAt) {
      await this.refreshTokenRepo.revokeAllForUser(stored.userId);
      throw new JarvisError(
        "AUTHENTICATION_REQUIRED",
        "Refresh token has been revoked"
      );
    }

    if (new Date() > stored.expiresAt) {
      await this.refreshTokenRepo.revoke(stored.id);
      throw new JarvisError(
        "AUTHENTICATION_REQUIRED",
        "Refresh token has expired"
      );
    }

    await this.refreshTokenRepo.revoke(stored.id);

    const user = await this.userRepo.findById(stored.userId);
    if (!user) {
      throw new JarvisError(
        "AUTHENTICATION_REQUIRED",
        "User not found"
      );
    }

    const tokens = await this.issueTokens(
      user.id,
      user.role,
      user.email,
      meta
    );

    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.tokenService.hashToken(refreshToken);
    const stored = await this.refreshTokenRepo.findByTokenHash(tokenHash);

    if (stored && !stored.revokedAt) {
      await this.refreshTokenRepo.revoke(stored.id);
    }
  }

  async getMe(userId: string): Promise<SafeUser> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new JarvisError("INVALID_REQUEST", "User not found");
    }
    return this.toSafeUser(user);
  }

  // ---------------------------------------------------------------------------
  // UI V2 — sign-in with an identity a federated provider has already verified.
  //
  // The CALLER is responsible for proving the identity (verifying the Google ID
  // token signature, issuer, audience and email_verified claim) before calling
  // this. Nothing here re-checks that, so it must never be reachable from user
  // input — only from a completed OAuth callback.
  //
  // ACCOUNT LINKING is by verified email. A user who registered with a password
  // and later signs in with the same Google address gets their EXISTING account
  // rather than a duplicate. That is safe only because the provider asserted the
  // address belongs to them; linking on an unverified email would let anyone who
  // can name an address take over its account.
  //
  // A user created this way gets a random, unguessable password rather than a
  // null one: `password` is NOT NULL in the schema, and a random 32-byte secret
  // nobody holds is equivalent to having no password — password login for the
  // account simply cannot succeed. It is never returned or logged.
  // ---------------------------------------------------------------------------
  async loginWithVerifiedIdentity(
    identity: { email: string; name?: string },
    meta?: { userAgent?: string; ipAddress?: string }
  ): Promise<{ user: SafeUser; tokens: TokenPair; created: boolean }> {
    const email = identity.email.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      throw new JarvisError("INVALID_REQUEST", "A verified email address is required");
    }

    const existing = await this.userRepo.findByEmail(email);

    if (existing) {
      await this.userRepo.updateLastLogin(existing.id);
      const tokens = await this.issueTokens(
        existing.id,
        existing.role,
        existing.email,
        meta
      );
      return { user: this.toSafeUser(existing), tokens, created: false };
    }

    const unusablePassword = await this.passwordHasher.hash(
      randomBytes(32).toString("hex")
    );

    const user = await this.userRepo.create({
      email,
      // Falling back to the local part keeps `name` non-empty when the provider
      // withheld a profile name; the schema requires one.
      name: identity.name?.trim() || email.split("@")[0] || "Operator",
      password: unusablePassword,
      role: "member",
    });

    const tokens = await this.issueTokens(user.id, user.role, user.email, meta);
    return { user: this.toSafeUser(user), tokens, created: true };
  }

  private async issueTokens(
    userId: string,
    role: string,
    email: string,
    meta?: { userAgent?: string; ipAddress?: string }
  ): Promise<TokenPair> {
    const accessToken = this.tokenService.generateAccessToken({
      userId,
      role,
      email,
    });

    const refreshToken = this.tokenService.generateRefreshToken();
    const tokenHash = this.tokenService.hashToken(refreshToken);
    const expiresAt = this.tokenService.getRefreshTokenExpiry();

    await this.refreshTokenRepo.create({
      userId,
      tokenHash,
      userAgent: meta?.userAgent,
      ipAddress: meta?.ipAddress,
      expiresAt,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 900,
    };
  }

  private toSafeUser(
    user: { id: string; email: string; name: string; role: string; createdAt: Date; updatedAt: Date }
  ): SafeUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }
}
