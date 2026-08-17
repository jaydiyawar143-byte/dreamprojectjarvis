import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { createServer, type Server } from "http";
import { Server as SocketIOServer } from "socket.io";
import { loadEnvironment } from "./config/env.js";
import { healthRouter } from "./routes/health.js";

const env = loadEnvironment();

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

app.use("/api/v1/health", healthRouter);

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

app.set("io", io);

httpServer.listen(env.PORT, () => {
  console.log(
    `JARVIS API running on port ${env.PORT} [${env.NODE_ENV}]`
  );
});

export { app, io };
