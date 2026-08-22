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
import { getContainer } from "./services/container.js";
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
app.use(express.json({ limit: "10mb" }));

app.use("/api/v1/health", createHealthRouter(lifecycle));
app.use("/api/v1/auth", createAuthRouter(container.authService, container.tokenService));
app.use("/api/v1/chat", createChatRouter(container));
app.use("/api/v1/conversations", createConversationsRouter(container));
app.use("/api/v1/approvals", createApprovalsRouter(container));

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
