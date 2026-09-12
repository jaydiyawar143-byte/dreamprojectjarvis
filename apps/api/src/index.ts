import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { createServer, type Server } from "http";
import { Server as SocketIOServer } from "socket.io";
import { loadEnvironment } from "./config/env.js";
import { createHealthRouter } from "./routes/health.js";
import { createAuthRouter } from "./routes/auth.js";
import { createChatRouter } from "./routes/chat.js";
import { createConversationsRouter } from "./routes/conversations.js";
import { createApprovalsRouter } from "./routes/approvals.js";
import { createPendingActionsRouter } from "./routes/pending-actions.js";
import { createRecommendationsRouter } from "./routes/recommendations.js";
import { createOutcomesRouter } from "./routes/outcomes.js";
import { createOpportunitiesRouter } from "./routes/opportunities.js";
import { createKnowledgeRouter } from "./routes/knowledge.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { createAgentsRouter } from "./routes/agents.js";
import { createActivityRouter } from "./routes/activity.js";
import { createGoogleAuthRouter } from "./routes/google-auth.js";
import { createWhatsAppRouter } from "./routes/whatsapp.js";
import { createN8nRouter } from "./routes/n8n.js";
import { createVoiceRouter } from "./routes/voice.js";
import {
  SOCKET_CONNECT_TIMEOUT_MS,
  SOCKET_MAX_BUFFER_BYTES,
  secureSocketServer,
} from "./socket/socket-auth.js";
import { getContainer, getBrowserRuntime } from "./services/container.js";
import { requestId } from "./middleware/request-id.js";
import {
  errorHandler,
  notFoundHandler,
  installProcessErrorHandlers,
} from "./middleware/error-handler.js";
import { EncryptionService } from "@jarvis/security";
import { prisma, PrismaGoogleConnectionRepository, PrismaOAuthStateRepository, PrismaWhatsAppRepository, PrismaN8nRepository, PrismaCredentialRepository, PrismaTaskRepository, PrismaPreferenceRepository, PrismaMapsUsageRepository } from "@jarvis/db";
import { createWhatsAppConfig, isWhatsAppConfigured } from "@jarvis/whatsapp";
import { createN8nConfig, isN8nConfigured } from "@jarvis/n8n";
import { createVoiceConfig, describeVoiceConfigStatus, isVoiceConfigured } from "@jarvis/config";
import { createGoogleSignInConfig, describeGoogleSignInStatus } from "@jarvis/config";
import { createGoogleSignInRouter } from "./routes/google-signin.js";
import { createCredentialsRouter } from "./routes/credentials.js";
import { createIntegrationsRouter } from "./routes/integrations.js";
import { createCapabilitiesRouter } from "./routes/capabilities.js";
import { createGoogleWorkspaceRouter } from "./routes/google-workspace.js";
import { createGoogleWritesRouter } from "./routes/google-writes.js";
import { createCommandCenterRouter } from "./routes/command-center.js";
import { installSystemStream } from "./socket/system-stream.js";
import { OpenAIVoiceProvider } from "@jarvis/ai-openai";
import {
  ShutdownLifecycle,
  type LifecycleState,
} from "@jarvis/core";
import { runStartupRecovery } from "@jarvis/tools";
import {
  createShutdownController,
  installSignalHandlers,
} from "./shutdown.js";

const env = loadEnvironment();

// ---------------------------------------------------------------------------
// Phase 10.6 — lifecycle + idempotent startup recovery.
//
// Recovery runs BEFORE the server accepts traffic: stale EXECUTING rows
// (expired leases) become UNKNOWN, stale RECONCILING rows re-enter the
// reconciliation pool, UNKNOWN records are preserved and never retried
// automatically. The pass is idempotent — running it twice is a no-op the
// second time (verified by integration tests).
//
// Windows note: signal delivery is unreliable on win32; handlers are
// registered best-effort and shutdown can also be triggered
// programmatically via jarvisShutdown.beginShutdown().
// ---------------------------------------------------------------------------
const lifecycle = new ShutdownLifecycle();
const container = getContainer({ lifecycle });

const startupRecovery = await runStartupRecovery(container.executionJournal);
console.log(
  `[startup] recovery complete ${JSON.stringify({
    staleExecutingRecovered: startupRecovery.staleExecutingRecovered,
    staleReconcilingRecovered: startupRecovery.staleReconcilingRecovered,
  })}`
);

const app: Express = express();
const httpServer: Server = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: env.CORS_ORIGIN,
    methods: ["GET", "POST"],
  },
  // Sprint 9 hotfix — bound what an UNAUTHENTICATED peer can hold or send.
  // Both limits apply before the handshake completes, which is the only window
  // in which an anonymous client exists at all.
  connectTimeout: SOCKET_CONNECT_TIMEOUT_MS,
  maxHttpBufferSize: SOCKET_MAX_BUFFER_BYTES,
});

// ---------------------------------------------------------------------------
// Sprint 9.7/9.12 — proxy trust.
//
// Off by default, because trusting X-Forwarded-For when nothing sets it lets
// any client claim any address — which would turn the per-IP rate limiter into
// a no-op. An operator behind a load balancer sets TRUST_PROXY to the number of
// proxies in front of this process (usually 1), and only then does `req.ip`
// mean the client rather than the proxy.
// ---------------------------------------------------------------------------
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy && trustProxy !== "false") {
  const hops = Number(trustProxy);
  app.set("trust proxy", Number.isInteger(hops) && hops > 0 ? hops : trustProxy);
}

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(compression());
// Sprint 9.2 — first, so every later middleware and every log line can name
// the request, including the ones that fail before reaching a route.
app.use(requestId());
app.use(morgan("combined"));
// ---------------------------------------------------------------------------
// Sprint 5.3 — WhatsApp webhook, mounted BEFORE the JSON body parser.
//
// This ordering is load-bearing, not stylistic. X-Hub-Signature-256 is an HMAC
// over the EXACT bytes Meta sent; express.json() consumes the request stream and
// leaves only a parsed object, and re-serialising that object changes key order
// and escaping, so the digest would never match. Mounting here lets the router
// apply its own express.raw() parser to the untouched body.
//
// Every other route keeps the app-wide JSON parser registered just below.
// ---------------------------------------------------------------------------
if (isWhatsAppConfigured()) {
  app.use(
    "/api/v1/whatsapp",
    createWhatsAppRouter(container, {
      repo: new PrismaWhatsAppRepository(prisma),
      config: createWhatsAppConfig(),
    })
  );
} else {
  console.log(JSON.stringify({
    level: "info",
    event: "whatsapp_routes_disabled",
    reason: "WhatsApp secrets are not fully configured",
  }));
}

// Sprint 5.4 — n8n router, mounted here for the same reason as WhatsApp above:
// its /callback route authenticates an HMAC over the RAW request body, so it
// must install its own express.raw() before the app-wide JSON parser consumes
// the stream. Its authenticated GET routes are unaffected by the placement.
if (isN8nConfigured()) {
  app.use(
    "/api/v1/n8n",
    createN8nRouter(container, {
      repo: new PrismaN8nRepository(prisma),
      config: createN8nConfig(),
      auditLogger: container.auditLogger,
    })
  );
} else {
  console.log(JSON.stringify({
    level: "info",
    event: "n8n_routes_disabled",
    reason: "n8n base URL, API key or callback secret is not configured",
  }));
}

app.use(express.json({ limit: "10mb" }));

app.use(
  "/api/v1/health",
  createHealthRouter(lifecycle, {
    // Sprint 9.10 — the cheapest query that proves the connection works.
    pingDatabase: async () => {
      const { prisma } = await import("@jarvis/db");
      return prisma.$queryRaw`SELECT 1`;
    },
  })
);
// ---------------------------------------------------------------------------
// UI V2 — Google sign-in, mounted BEFORE the general auth router so
// /api/v1/auth/google/* resolves to it.
//
// Gated on the OAuth client credentials being present, following the same rule
// the other integrations use: a button that cannot complete its exchange is
// worse than a channel the login screen openly reports as unprovisioned.
// ---------------------------------------------------------------------------
{
  const googleSignIn = describeGoogleSignInStatus();
  if (googleSignIn.configured) {
    app.use(
      "/api/v1/auth/google",
      createGoogleSignInRouter(
        container.authService,
        createGoogleSignInConfig(),
        env.JWT_SECRET
      )
    );
  }
  console.log(JSON.stringify({
    level: "info",
    event: googleSignIn.configured ? "google_signin_enabled" : "google_signin_disabled",
    reason: googleSignIn.reason,
  }));
}

app.use("/api/v1/auth", createAuthRouter(container.authService, container.tokenService));
app.use("/api/v1/chat", createChatRouter(container));
app.use("/api/v1/conversations", createConversationsRouter(container));
app.use("/api/v1/approvals", createApprovalsRouter(container));
app.use("/api/v1/pending-actions", createPendingActionsRouter(container));
app.use("/api/v1/recommendations", createRecommendationsRouter(container));
app.use("/api/v1", createOutcomesRouter(container));
app.use("/api/v1/opportunities", createOpportunitiesRouter(container));
app.use("/api/v1/knowledge", createKnowledgeRouter(container));
app.use("/api/v1/dashboard", createDashboardRouter(container));
// UI V2 — read-only windows on data the server already owns. Both are
// auth-gated; activity is scoped to the caller's own rows.
app.use("/api/v1/agents", createAgentsRouter(container));
// V3 — Command Center: weather, markets, geo, host metrics, tasks, preferences.
// Every response carries provider freshness metadata; nothing is fabricated.
app.use(
  "/api/v1/command-center",
  createCommandCenterRouter(container, {
    tasks: new PrismaTaskRepository(prisma),
    preferences: new PrismaPreferenceRepository(prisma),
    mapsUsage: new PrismaMapsUsageRepository(prisma),
  })
);
app.use("/api/v1/activity", createActivityRouter(container));

// ---------------------------------------------------------------------------
// Capability discovery — what this deployment can ACTUALLY do, per user.
//
// Mounted unconditionally so the route can explain its own unavailability
// rather than 404ing: a missing endpoint is not something a UI can act on,
// and "JARVIS_ENCRYPTION_KEY is not set" is.
// ---------------------------------------------------------------------------
app.use("/api/v1/capabilities", createCapabilitiesRouter(container));

// ---------------------------------------------------------------------------
// Phase 12 — real read-only Gmail, Drive and Calendar.
//
// Mounted unconditionally so the routes can explain their own unavailability
// with the reason rather than 404ing. Every handler is a GET; this phase
// performs no writes.
// ---------------------------------------------------------------------------
// Mounted at /workspace, NOT /google: the OAuth router already owns
// /api/v1/google (/connect, /callback, /status, /disconnect). Sharing a prefix
// would work only for as long as no path ever collided, and a future
// /google/status on either side would silently shadow the other.
app.use("/api/v1/workspace", createGoogleWorkspaceRouter(container));

// ---------------------------------------------------------------------------
// Phase 13 — approval-gated Google writes.
//
// Plan, read, execute. APPROVING is deliberately NOT here: it happens on the
// existing /approvals endpoints, so approval stays one concept with one store
// and one audit trail.
// ---------------------------------------------------------------------------
app.use("/api/v1/integrations/google/writes", createGoogleWritesRouter(container));
// Sprint 5.2 — Google OAuth connection management (read-only Ads integration).
//
// Mounted only when an encryption key is present. Without one no Google token
// could be stored, and EncryptionService.fromEnv() throws by design rather than
// silently degrading to plaintext — so the route is omitted instead of taking
// the whole API down at startup. Deployments without the key keep every other
// route and simply have no /api/v1/google surface.
// ---------------------------------------------------------------------------
// Sprint 8 — Voice interaction layer.
//
// Mounted only when an operator has switched it on AND a speech credential
// exists. Voice is never inferred from the presence of an OpenAI key: every
// existing deployment has one, and inferring would expose two new endpoints on
// upgrade with nobody having asked for them.
//
// These routes are a transport. They transcribe and they synthesize; the
// transcript then travels through the ordinary /api/v1/chat pipeline, which is
// what keeps agent routing, tool allowlists, approvals, tenant isolation and
// audit in one place rather than two.
// ---------------------------------------------------------------------------
if (isVoiceConfigured()) {
  try {
    const voiceConfig = createVoiceConfig();
    app.use(
      "/api/v1/voice",
      createVoiceRouter(container, {
        provider: new OpenAIVoiceProvider({
          sttModel: voiceConfig.sttModel,
          ttsModel: voiceConfig.ttsModel,
          defaultVoice: voiceConfig.ttsVoice,
        }),
        config: voiceConfig,
      })
    );
    console.log(JSON.stringify({
      level: "info",
      event: "voice_routes_enabled",
      sttModel: voiceConfig.sttModel,
      ttsModel: voiceConfig.ttsModel,
      voice: voiceConfig.ttsVoice,
    }));
  } catch (err) {
    // A misconfigured optional feature must not take the API down; the routes
    // stay unmounted and every other surface is unaffected.
    console.log(JSON.stringify({
      level: "warn",
      event: "voice_routes_disabled",
      reason: err instanceof Error ? err.message : "invalid voice configuration",
    }));
  }
} else {
  console.log(JSON.stringify({
    level: "info",
    event: "voice_routes_disabled",
    reason: describeVoiceConfigStatus().reason,
  }));
}

const googleAdsMounted = Boolean(process.env.JARVIS_ENCRYPTION_KEY);

// ---------------------------------------------------------------------------
// UI V2 — Agent Credential Center.
//
// Gated on the same key as the Google routes, and for the same reason: without
// it there is no way to store a third-party secret at rest, and storing one in
// plaintext is not an acceptable fallback. `googleAdsMounted` is passed through
// so the Credential Center reports Google's real availability rather than
// re-deriving it from an environment variable of its own.
// ---------------------------------------------------------------------------
if (process.env.JARVIS_ENCRYPTION_KEY) {
  app.use(
    "/api/v1/credentials",
    createCredentialsRouter(container, {
      repo: new PrismaCredentialRepository(prisma),
      encryption: EncryptionService.fromEnv(),
      googleAdsMounted,
    })
  );
} else {
  console.log(JSON.stringify({
    level: "info",
    event: "credentials_routes_disabled",
    reason: "JARVIS_ENCRYPTION_KEY is not set",
  }));
}

// ---------------------------------------------------------------------------
// Integration Control Center — unified status and connection testing.
//
// A FACADE over the routers above, not a replacement for them. It reads the
// same encrypted store, the same OAuth connection repository and the same
// environment configs, and it hands the browser the EXISTING endpoints to call
// for connect / configure / disconnect. There is deliberately no second write
// path to a credential here.
//
// Mounted unconditionally: with no encryption key there are no stored
// credentials to read, and the honest answer is a page saying so rather than a
// missing route the UI cannot explain.
// ---------------------------------------------------------------------------
app.use(
  "/api/v1/integrations",
  createIntegrationsRouter(container, {
    googleOAuthMounted: googleAdsMounted,
    googleConnections: process.env.JARVIS_ENCRYPTION_KEY
      ? new PrismaGoogleConnectionRepository(prisma, EncryptionService.fromEnv())
      : null,
    // Decryption stays behind this closure. The registry never receives the key,
    // and a credential only ever exists as plaintext inside the one call that
    // needs it to reach a provider.
    readMetaCredentials: async (userId: string) => {
      if (!process.env.JARVIS_ENCRYPTION_KEY) return null;
      const envelope = await new PrismaCredentialRepository(prisma).get(userId, "meta");
      if (!envelope) return null;
      try {
        return JSON.parse(EncryptionService.fromEnv().decrypt(envelope)) as {
          accessToken?: string;
          adAccountId?: string;
        };
      } catch {
        // A row that will not decrypt is not "no credentials" — it is a broken
        // one. Reported as absent here; the credentials route surfaces the
        // INVALID state with the explanation.
        return null;
      }
    },
  })
);

if (process.env.JARVIS_ENCRYPTION_KEY) {
  app.use(
    "/api/v1/google",
    createGoogleAuthRouter(container, {
      connections: new PrismaGoogleConnectionRepository(prisma, EncryptionService.fromEnv()),
      oauthStates: new PrismaOAuthStateRepository(prisma),
    })
  );
} else {
  console.log(JSON.stringify({
    level: "info",
    event: "google_routes_disabled",
    reason: "JARVIS_ENCRYPTION_KEY is not set",
  }));
}

// ---------------------------------------------------------------------------
// Sprint 9 hotfix — Socket.IO is authenticated.
//
// Previously every connection was accepted with no identity attached. Reusing
// the SAME TokenService the HTTP middleware uses means one identity model
// across both transports: a socket that cannot prove who it is never reaches a
// handler, and every event is checked against an explicit policy so the
// authorized surface cannot grow by accident.
//
// Tool execution and approval decisions are deliberately NOT reachable here.
// They stay on the HTTP routes, where ToolExecutor, the permission service and
// the approval boundary already live.
// ---------------------------------------------------------------------------
secureSocketServer(io, container.tokenService);
// V3 — realtime host metrics on the SAME authenticated socket. Installed after
// securing it, so the auth middleware and the event allowlist both apply.
installSystemStream(io);

app.set("io", io);

// ---------------------------------------------------------------------------
// Sprint 9.2 — terminal error handling. MUST stay last: Express picks the 404
// handler for anything no route claimed, and the error handler only for the
// four-argument signature, so both have to sit after every `app.use` above.
//
// With these mounted, Express's own default handler is never reached — which
// matters because it serialises `err.stack` into the response body whenever
// NODE_ENV is not "production", and NODE_ENV defaults to "development" here.
// ---------------------------------------------------------------------------
app.use(notFoundHandler());
app.use(errorHandler());
installProcessErrorHandlers();

// ---------------------------------------------------------------------------
// Graceful shutdown wiring. graceMs comes from the validated config layer
// (JARVIS_SHUTDOWN_GRACE_MS, safe default when absent). beginShutdown() is
// single-flight: a second SIGTERM/SIGINT or duplicate call cannot re-run
// cleanup. process.exit fires only after STOPPED via onStopped.
// ---------------------------------------------------------------------------
const jarvisShutdown = createShutdownController({
  lifecycle,
  server: httpServer,
  closeIo: () => io.close(),
  // Sprint 7 — close the shared Chrome, if browsing is switched on at all.
  releaseExternalResources: async () => {
    await getBrowserRuntime()?.shutdown();
  },
  disconnectDatabase: async () => {
    const { prisma } = await import("@jarvis/db");
    await prisma.$disconnect();
  },
  graceMs: env.SHUTDOWN_GRACE_MS,
  onStopped: () => process.exit(0),
});

installSignalHandlers(jarvisShutdown.beginShutdown);

httpServer.listen(env.PORT, () => {
  console.log(
    `JARVIS API running on port ${env.PORT} [${env.NODE_ENV}] state=${lifecycle.getState() satisfies LifecycleState}`
  );
});

export { app, io };
