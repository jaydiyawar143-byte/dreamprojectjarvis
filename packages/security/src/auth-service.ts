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
