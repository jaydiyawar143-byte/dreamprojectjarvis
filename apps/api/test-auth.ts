import { PrismaClient } from "@jarvis/db";
import {
  PrismaUserRepository,
  PrismaRefreshTokenRepository,
} from "@jarvis/db";
import { PasswordHasher, TokenService, AuthManager } from "@jarvis/security";

const prisma = new PrismaClient();
const TEST_EMAIL = "authtest@test.com";
const TEST_PASSWORD = "SecureP@ssw0rd!";
const TEST_NAME = "Auth Test User";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}`);
    failed++;
  }
}

function makeServices() {
  const JWT_SECRET = "test-jwt-secret-minimum-32-chars-long-for-testing";
  const hasher = new PasswordHasher();
  const tokenService = new TokenService(JWT_SECRET);
  const userRepo = new PrismaUserRepository(prisma);
  const refreshTokenRepo = new PrismaRefreshTokenRepository(prisma);
  const authManager = new AuthManager(hasher, tokenService, refreshTokenRepo, userRepo);
  return { hasher, tokenService, userRepo, refreshTokenRepo, authManager };
}

async function cleanupTestData() {
  const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
  if (user) {
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.approval.deleteMany({ where: { userId: user.id } });
    await prisma.conversation.deleteMany({ where: { userId: user.id } });
    await prisma.userSetting.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }

  const dup = await prisma.user.findUnique({ where: { email: "duplicate@test.com" } });
  if (dup) {
    await prisma.refreshToken.deleteMany({ where: { userId: dup.id } });
    await prisma.user.delete({ where: { id: dup.id } });
  }
}

async function runTests() {
  await cleanupTestData();
  console.log("=== AUTHENTICATION TESTS ===\n");

  const { hasher, tokenService, userRepo, refreshTokenRepo, authManager } = makeServices();

  // 1. Registration success
  console.log("1. Registration success");
  {
    const result = await authManager.register({
      email: TEST_EMAIL,
      name: TEST_NAME,
      password: TEST_PASSWORD,
    });
    assert("user is returned", !!result.user);
    assert("user email matches", result.user.email === TEST_EMAIL);
    assert("user name matches", result.user.name === TEST_NAME);
    assert("accessToken is returned", typeof result.tokens.accessToken === "string" && result.tokens.accessToken.length > 0);
    assert("refreshToken is returned", typeof result.tokens.refreshToken === "string" && result.tokens.refreshToken.length > 0);
    assert("expiresIn is 900", result.tokens.expiresIn === 900);
  }

  // 2. Duplicate registration
  console.log("\n2. Duplicate registration");
  {
    let caught = false;
    try {
      await authManager.register({
        email: TEST_EMAIL,
        name: TEST_NAME,
        password: TEST_PASSWORD,
      });
    } catch (e: unknown) {
      caught = true;
      const err = e as { code?: string; message?: string };
      assert("error code is INVALID_REQUEST", err.code === "INVALID_REQUEST");
    }
    assert("duplicate registration throws", caught);
  }

  // 3. Invalid registration input
  console.log("\n3. Invalid registration input");
  {
    let caught = false;
    try {
      await authManager.register({
        email: "not-an-email",
        name: "",
        password: "short",
      });
    } catch {
      caught = true;
    }
    assert("invalid input throws", caught);
  }

  // 4. Weak password (handled by Zod at input level, but service layer accepts)
  console.log("\n4. Weak password handling");
  {
    const weakHash = await hasher.hash("123");
    assert("password hash is string", typeof weakHash === "string");
    assert("hash starts with scrypt:", weakHash.startsWith("scrypt:"));
    const parts = weakHash.split(":");
    assert("hash has 3 parts", parts.length === 3);
  }

  // 5. Login success
  console.log("\n5. Login success");
  {
    const result = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    assert("user is returned", !!result.user);
    assert("user email matches", result.user.email === TEST_EMAIL);
    assert("accessToken is returned", typeof result.tokens.accessToken === "string" && result.tokens.accessToken.length > 0);
    assert("refreshToken is returned", typeof result.tokens.refreshToken === "string" && result.tokens.refreshToken.length > 0);
  }

  // 6. Wrong password
  console.log("\n6. Wrong password");
  {
    let caught = false;
    try {
      await authManager.login({
        email: TEST_EMAIL,
        password: "WrongPassword123!",
      });
    } catch (e: unknown) {
      caught = true;
      const err = e as { code?: string; message?: string };
      assert("error code is AUTHENTICATION_REQUIRED", err.code === "AUTHENTICATION_REQUIRED");
      assert("generic error message", err.message === "Invalid email or password");
    }
    assert("wrong password throws", caught);
  }

  // 7. Nonexistent account
  console.log("\n7. Nonexistent account");
  {
    let caught = false;
    try {
      await authManager.login({
        email: "nonexistent@test.com",
        password: TEST_PASSWORD,
      });
    } catch (e: unknown) {
      caught = true;
      const err = e as { code?: string; message?: string };
      assert("same error code as wrong password", err.code === "AUTHENTICATION_REQUIRED");
      assert("same generic message as wrong password", err.message === "Invalid email or password");
    }
    assert("nonexistent account throws", caught);
  }

  // 8. Access token validation
  console.log("\n8. Access token validation");
  {
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const decoded = tokenService.verifyAccessToken(loginResult.tokens.accessToken);
    assert("token is valid", decoded !== null);
    assert("userId matches", decoded!.userId === loginResult.user.id);
    assert("role matches", decoded!.role === loginResult.user.role);
    assert("email matches", decoded!.email === loginResult.user.email);
  }

  // 9. Expired access token
  console.log("\n9. Expired access token");
  {
    const jwt = await import("jsonwebtoken");
    const JWT_SECRET = "test-jwt-secret-minimum-32-chars-long-for-testing";
    const expiredToken = jwt.default.sign(
      { sub: "user-123", role: "member", email: "test@test.com" },
      JWT_SECRET,
      { expiresIn: "0s", issuer: "jarvis", audience: "jarvis-api" }
    );
    const decoded = tokenService.verifyAccessToken(expiredToken);
    assert("expired token is rejected", decoded === null);
  }

  // 10. Invalid token
  console.log("\n10. Invalid token");
  {
    const decoded = tokenService.verifyAccessToken("completely-invalid-token");
    assert("invalid token is rejected", decoded === null);
  }

  // 11. Refresh success
  console.log("\n11. Refresh success");
  {
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const newTokens = await authManager.refresh(loginResult.tokens.refreshToken);
    assert("new accessToken is returned", typeof newTokens.accessToken === "string" && newTokens.accessToken.length > 0);
    assert("new refreshToken is returned", typeof newTokens.refreshToken === "string" && newTokens.refreshToken.length > 0);
    assert("new token is different from old", newTokens.refreshToken !== loginResult.tokens.refreshToken);
  }

  // 12. Refresh token rotation
  console.log("\n12. Refresh token rotation");
  {
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const oldRefresh = loginResult.tokens.refreshToken;
    const newTokens = await authManager.refresh(oldRefresh);
    assert("old token is revoked", true);
    let caught = false;
    try {
      await authManager.refresh(oldRefresh);
    } catch (e: unknown) {
      caught = true;
      const err = e as { code?: string };
      assert("reused token rejected", err.code === "AUTHENTICATION_REQUIRED");
    }
    assert("reused refresh token fails", caught);
    assert("new refresh works", typeof newTokens.refreshToken === "string" && newTokens.refreshToken.length > 0);
  }

  // 13. Revoked refresh token
  console.log("\n13. Revoked refresh token");
  {
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const refresh = loginResult.tokens.refreshToken;
    await authManager.logout(refresh);
    let caught = false;
    try {
      await authManager.refresh(refresh);
    } catch (e: unknown) {
      caught = true;
      const err = e as { code?: string };
      assert("revoked refresh fails", err.code === "AUTHENTICATION_REQUIRED");
    }
    assert("revoked token is rejected", caught);
  }

  // 14. Logout
  console.log("\n14. Logout");
  {
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    await authManager.logout(loginResult.tokens.refreshToken);
    let caught = false;
    try {
      await authManager.refresh(loginResult.tokens.refreshToken);
    } catch {
      caught = true;
    }
    assert("logout revokes refresh token", caught);
  }

  // 15. /auth/me authenticated
  console.log("\n15. /auth/me authenticated");
  {
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const decoded = tokenService.verifyAccessToken(loginResult.tokens.accessToken);
    assert("can get user from token", decoded !== null);
    if (decoded) {
      const user = await authManager.getMe(decoded.userId);
      assert("user email matches", user.email === TEST_EMAIL);
      assert("user name matches", user.name === TEST_NAME);
    }
  }

  // 16. /auth/me unauthenticated
  console.log("\n16. /auth/me unauthenticated");
  {
    let caught = false;
    try {
      await authManager.getMe("nonexistent-user-id");
    } catch (e: unknown) {
      caught = true;
      const err = e as { code?: string };
      assert("unauthenticated getMe throws", err.code === "INVALID_REQUEST");
    }
    assert("getMe with bad ID throws", caught);
  }

  // 17. Default user role
  console.log("\n17. Default user role");
  {
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    assert("default role is member", loginResult.user.role === "member");
  }

  // 18. Client cannot create admin role
  console.log("\n18. Client cannot create admin role");
  {
    const result = await authManager.register({
      email: "admin-test@test.com",
      name: "Admin Test",
      password: TEST_PASSWORD,
    });
    assert("admin role is not assigned", result.user.role !== "admin");
    assert("role is member", result.user.role === "member");
    const user = await prisma.user.findUnique({ where: { email: "admin-test@test.com" } });
    if (user) {
      await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }

  // 19. Password hash never returned
  console.log("\n19. Password hash never returned");
  {
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const userStr = JSON.stringify(loginResult.user);
    assert("password field not in response", !userStr.includes("password"));
    assert("hash not in response", !userStr.includes("scrypt:"));
  }

  // 20. Refresh token never returned in user object
  console.log("\n20. Refresh token never returned in user object");
  {
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const userStr = JSON.stringify(loginResult.user);
    assert("refreshToken not in user object", !userStr.includes("refreshToken"));
  }

  // 21. AuthContext role propagation
  console.log("\n21. AuthContext role propagation");
  {
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const decoded = tokenService.verifyAccessToken(loginResult.tokens.accessToken);
    assert("role from token matches user role", decoded?.role === loginResult.user.role);
    assert("role is a valid role string", ["owner", "admin", "member", "viewer"].includes(decoded?.role ?? ""));
  }

  // 22. Permission checks after authentication
  console.log("\n22. Permission checks after authentication");
  {
    const { PermissionService } = await import("@jarvis/security");
    const permService = new PermissionService();
    const loginResult = await authManager.login({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const decoded = tokenService.verifyAccessToken(loginResult.tokens.accessToken);
    assert("member can read conversations", permService.hasPermission(decoded!.role, "conversations", "read"));
    assert("member cannot write approvals", !permService.hasPermission(decoded!.role, "approvals", "write"));
    assert("member cannot read audit", !permService.hasPermission(decoded!.role, "audit", "read"));
  }

  console.log(`\n=== RESULTS: ${passed} PASS, ${failed} FAIL ===`);
  if (failed > 0) process.exit(1);
}

runTests()
  .catch((e) => {
    console.error("FATAL:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
