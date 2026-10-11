// ---------------------------------------------------------------------------
// Phase 14 — the memory API, behind the memory screen.
//
//   GET   /api/v1/memories                  the caller's memories, paged
//   GET   /api/v1/memories/status           the controls, and how much is stored
//   GET   /api/v1/memories/:id              one memory
//   POST  /api/v1/memories/learning/pause   stop learning
//   POST  /api/v1/memories/learning/resume  start learning again
//   POST  /api/v1/memories/:id/forget       ASK for it to be forgotten
//   POST  /api/v1/memories/:id/correction   ASK for it to be changed: { statement }
//
// THIS ROUTE DECIDES NOTHING AND DELETES NOTHING. It is the second way of
// reaching the one service the chat's memory commands already use
// (MemoryManagementService), and it obeys the same rules:
//
//   - `req.auth.userId` is the owner, always. No handler reads a user id from
//     the body, the query or the path. A memory or a project that is not the
//     caller's answers 404, exactly as an unknown one does.
//
//   - Forgetting and correcting are REQUESTS. Each creates the same
//     HIGH_IMPACT pending action the chat creates, and nothing changes until
//     the user confirms it through the existing endpoint
//     (POST /api/v1/pending-actions/:id/confirm), which runs `memory.forget` or
//     `memory.correct` through ToolExecutor. There is no endpoint here, or
//     anywhere, that deletes a memory directly.
//
//   - The screen's requests live in ONE conversation of the user's own,
//     "Memory controls". A confirmation needs a conversation to belong to; and
//     a correction's new value is saved there as a USER message, so the
//     corrected memory points at a real saved message like every other memory.
//
//   - What is returned is `MemoryDetail`: content, type, confidence, dates,
//     project and a provenance summary. Never the vector, the raw metadata, or
//     a message, conversation or trace id.
//
// Whether a statement may become a memory is the memory writer's answer
// (`memoryCorrections.check`); this route only asks before it bothers the user
// with a confirmation that could not succeed.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import type { Conversation, ConversationMessage, ITokenService, MemoryScopeFilter, MemoryView, Project } from "@jarvis/core";
import { MEMORY_CORRECTION_MAX_LENGTH } from "@jarvis/core";
import type { PendingActionService } from "@jarvis/agents";
import type { MemoryManagementService } from "@jarvis/memory";
import { MEMORY_PAGE_LIMIT } from "@jarvis/memory";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import {
  proposeMemoryCorrection,
  proposeMemoryForget,
  type MemoryCorrectionCheckPort,
  type MemoryTurn,
} from "./memory-commands.js";

/** The one conversation, per user, that the memory screen's requests are kept in. */
export const MEMORY_SCREEN_CONVERSATION_TITLE = "Memory controls";

export interface MemoryRouterDeps {
  tokenService: ITokenService;
  /** Reads, the two learning switches and the audit record. Nothing here can delete. */
  memoryManagement: Pick<MemoryManagementService, "details" | "detail" | "views" | "status" | "pauseLearning" | "resumeLearning" | "recordCommand">;
  projects: { list(userId: string): Promise<Project[]>; findOwned(userId: string, projectId: string): Promise<Project | null> };
  conversationRepo: {
    findOrCreateTitled(userId: string, title: string): Promise<Conversation>;
    addMessage(input: { conversationId: string; role: string; content: string; metadata?: Record<string, unknown> }): Promise<ConversationMessage>;
  };
  /** Absent: requests to forget or correct are refused; reading and pausing still work. */
  pendingActionService?: Pick<PendingActionService, "createPendingAction" | "getActivePendingAction" | "rejectPendingAction">;
  /** Absent: corrections are unavailable (no memory writer is configured). */
  memoryCorrections?: MemoryCorrectionCheckPort;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function createMemoryRouter(container: MemoryRouterDeps): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  function ok(res: Response, data: unknown, status = 200): void {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
  }

  function fail(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({ success: false, error: { code, message }, timestamp: new Date().toISOString() });
  }

  /** The caller, or null after answering 401. The only identity any handler uses. */
  function callerOf(req: AuthenticatedRequest, res: Response): string | null {
    if (!req.auth) {
      fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      return null;
    }
    return req.auth.userId;
  }

  async function projectNamesOf(userId: string): Promise<Map<string, string>> {
    return new Map((await container.projects.list(userId)).map((p) => [p.id, p.name]));
  }

  /** The caller's own memory, as the chat's safe view, or null after answering 404. */
  async function ownMemory(userId: string, id: string, res: Response): Promise<MemoryView | null> {
    const [view] = ID.test(id) ? await container.memoryManagement.views(userId, [id]) : [];
    if (!view) fail(res, 404, "MEMORY_NOT_FOUND", "Memory not found.");
    return view ?? null;
  }

  /**
   * The screen's conversation, with nothing left waiting in it: a request the
   * user never confirmed is cancelled when they make another. Cancelling is
   * the safe direction — it can only stop a change, never make one.
   */
  async function screenConversation(userId: string): Promise<string> {
    const conversation = await container.conversationRepo.findOrCreateTitled(userId, MEMORY_SCREEN_CONVERSATION_TITLE);
    if (await container.pendingActionService!.getActivePendingAction(conversation.id, userId)) {
      await container.pendingActionService!.rejectPendingAction(conversation.id, userId);
    }
    return conversation.id;
  }

  function proposed(res: Response, conversationId: string, turn: MemoryTurn): void {
    ok(res, { pendingAction: turn.pendingAction, conversationId, summary: turn.reply }, 202);
  }

  // -------------------------------------------------------------------------
  // GET / — the caller's memories
  //   ?limit=1..50  ?offset=0..  ?project=all|personal|<project id>
  //   ?q=<text>     ?includeExpired=true
  // -------------------------------------------------------------------------
  router.get(
    "/",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;

      const limit = Number(req.query.limit ?? 20);
      const offset = Number(req.query.offset ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_PAGE_LIMIT) {
        return fail(res, 400, "INVALID_REQUEST", `limit must be a whole number from 1 to ${MEMORY_PAGE_LIMIT}.`);
      }
      if (!Number.isInteger(offset) || offset < 0) return fail(res, 400, "INVALID_REQUEST", "offset must be a whole number, 0 or more.");

      const project = typeof req.query.project === "string" ? req.query.project : "all";
      let scope: MemoryScopeFilter | undefined;
      if (project === "personal") {
        scope = { kind: "PERSONAL" };
      } else if (project !== "all") {
        // Another user's project is the same 404 as one that does not exist.
        const owned = ID.test(project) ? await container.projects.findOwned(userId, project) : null;
        if (!owned) return fail(res, 404, "PROJECT_NOT_FOUND", "Project not found.");
        scope = { kind: "PROJECT", projectId: owned.id };
      }

      const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const page = await container.memoryManagement.details(
        userId,
        { limit, offset, includeExpired: req.query.includeExpired === "true", ...(scope ? { scope } : {}), ...(search ? { search } : {}) },
        await projectNamesOf(userId)
      );
      ok(res, { ...page, limit, offset });
    })
  );

  // -------------------------------------------------------------------------
  // GET /status — the controls, and how much is stored
  // -------------------------------------------------------------------------
  router.get(
    "/status",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;
      ok(res, { ...(await container.memoryManagement.status(userId)), correctionAvailable: !!container.memoryCorrections && !!container.pendingActionService });
    })
  );

  // -------------------------------------------------------------------------
  // POST /learning/pause, /learning/resume — the user's own switch
  // -------------------------------------------------------------------------
  for (const action of ["pause", "resume"] as const) {
    router.post(
      `/learning/${action}`,
      requireAuth,
      asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
        const userId = callerOf(req, res);
        if (!userId) return;
        if (action === "pause") await container.memoryManagement.pauseLearning(userId);
        else await container.memoryManagement.resumeLearning(userId);
        ok(res, await container.memoryManagement.status(userId));
      })
    );
  }

  // -------------------------------------------------------------------------
  // GET /:id — one memory
  // -------------------------------------------------------------------------
  router.get(
    "/:id",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;
      const id = String(req.params.id);
      const memory = ID.test(id) ? await container.memoryManagement.detail(userId, id, await projectNamesOf(userId)) : null;
      if (!memory) return fail(res, 404, "MEMORY_NOT_FOUND", "Memory not found.");
      ok(res, { memory });
    })
  );

  // -------------------------------------------------------------------------
  // POST /:id/forget — ask for one memory to be forgotten
  // -------------------------------------------------------------------------
  router.post(
    "/:id/forget",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;
      const memory = await ownMemory(userId, String(req.params.id), res);
      if (!memory) return;
      if (!container.pendingActionService) return fail(res, 503, "CONFIRMATION_UNAVAILABLE", "Confirmations aren't available on this server.");

      const conversationId = await screenConversation(userId);
      const turn = await proposeMemoryForget(container.pendingActionService, { conversationId, userId, memories: [memory] });
      await container.memoryManagement.recordCommand(userId, "FORGET", "PROPOSED", 1);
      proposed(res, conversationId, turn);
    })
  );

  // -------------------------------------------------------------------------
  // POST /:id/correction — ask for one memory to be changed: { statement }
  // -------------------------------------------------------------------------
  router.post(
    "/:id/correction",
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      const userId = callerOf(req, res);
      if (!userId) return;

      const raw = (req.body ?? {}) as { statement?: unknown };
      const statement = typeof raw.statement === "string" ? raw.statement.trim() : "";
      if (statement.length === 0 || statement.length > MEMORY_CORRECTION_MAX_LENGTH) {
        return fail(res, 400, "INVALID_REQUEST", `statement must be 1 to ${MEMORY_CORRECTION_MAX_LENGTH} characters.`);
      }

      const memory = await ownMemory(userId, String(req.params.id), res);
      if (!memory) return;
      if (!container.pendingActionService) return fail(res, 503, "CONFIRMATION_UNAVAILABLE", "Confirmations aren't available on this server.");
      if (!container.memoryCorrections) return fail(res, 503, "MEMORY_CORRECTION_UNAVAILABLE", "Memory correction isn't available on this server.");

      const conversationId = await screenConversation(userId);

      // Asked BEFORE anything is saved or proposed. The ids are placeholders —
      // the answer does not depend on them — and the writer asks again, with
      // the real ones, when the confirmed action runs.
      const learnable = container.memoryCorrections.check({ statement, userMessage: statement, conversationId, messageId: "unsaved" }).ok;
      if (!learnable) {
        await container.memoryManagement.recordCommand(userId, "CORRECT", "NOT_LEARNABLE", 1);
        return fail(
          res,
          422,
          "MEMORY_NOT_LEARNABLE",
          "That can't be saved as a memory. A memory is a lasting preference, a fact about you or a way you work, in your own words — for example “I prefer short captions”."
        );
      }

      // The new value, as the user wrote it: a USER message of their own, so
      // the corrected memory has a real source to point at.
      const source = await container.conversationRepo.addMessage({
        conversationId,
        role: "user",
        content: statement,
        metadata: { traceId: randomUUID(), origin: "memory-screen" },
      });

      const turn = await proposeMemoryCorrection(container.pendingActionService, { conversationId, userId, memory, statement, sourceMessageId: source.id });
      await container.memoryManagement.recordCommand(userId, "CORRECT", "PROPOSED", 1);
      proposed(res, conversationId, turn);
    })
  );

  return router;
}
