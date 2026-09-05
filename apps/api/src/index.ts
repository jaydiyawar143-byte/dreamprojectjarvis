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
import { createGoogleAuthRouter } from "./routes/google-auth.js";
import { createWhatsAppRouter } from "./routes/whatsapp.js";
import { createN8nRouter } from "./routes/n8n.js";
import { getContainer } from "./services/container.js";
import { EncryptionService } from "@jarvis/security";
import { prisma, PrismaGoogleConnectionRepository, PrismaOAuthStateRepository, PrismaWhatsAppRepository, PrismaN8nRepository } from "@jarvis/db";
import { createWhatsAppConfig, isWhatsAppConfigured } from "@jarvis/whatsapp";
import { createN8nConfig, isN8nConfigured } from "@jarvis/n8n";
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
});

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(compression());
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

app.use("/api/v1/health", createHealthRouter(lifecycle));
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
// Sprint 5.2 — Google OAuth connection management (read-only Ads integration).
//
// Mounted only when an encryption key is present. Without one no Google token
// could be stored, and EncryptionService.fromEnv() throws by design rather than
// silently degrading to plaintext — so the route is omitted instead of taking
// the whole API down at startup. Deployments without the key keep every other
// route and simply have no /api/v1/google surface.
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

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    // Phase 10.4 decision preserved: CLIENT DISCONNECT ≠ EXECUTION
    // CANCELLATION. Executions are journal-backed; no abort happens here.
  });
});

app.set("io", io);

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
