// ---------------------------------------------------------------------------
// Sprint 5.3 — WhatsApp Business Cloud API webhook + history
//
//   GET  /api/v1/whatsapp/webhook    Meta verification handshake (public)
//   POST /api/v1/whatsapp/webhook    inbound messages + statuses (public, signed)
//   GET  /api/v1/whatsapp/messages   tenant-scoped history (bearer token)
//
// Security model — the two webhook routes are deliberately UNAUTHENTICATED,
// because Meta calls them, not a logged-in user. Their protection is different
// in kind from the rest of the API:
//
//  - Authenticity comes from X-Hub-Signature-256, an HMAC over the RAW body
//    keyed with the app secret. The router therefore installs its own
//    express.raw() parser: the app-wide express.json() would discard the exact
//    bytes and the digest would never match.
//  - Ownership comes from the WhatsAppAccount claim table. A payload for an
//    unclaimed phone_number_id is dropped, never attributed to a guessed user.
//  - Replay is blocked twice: a freshness window on the provider timestamp, and
//    a unique constraint on provider_message_id in the database.
//
// The webhook always answers 200 once the signature is valid, including for
// duplicates and unclaimed numbers. Meta retries any non-200 indefinitely, so
// returning an error for a permanently undeliverable event creates a redelivery
// loop. Rejections that matter (bad signature) return 401 on purpose.
// ---------------------------------------------------------------------------

import { Router, raw } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error-handler.js";
import type { Container } from "../services/container.js";
import type { IWhatsAppRepository } from "@jarvis/core";
import {
  verifyWebhookSignature,
  verifyWebhookChallenge,
  parseWebhookPayload,
  isFresh,
  maskPhoneNumber,
  type WhatsAppConfig,
} from "@jarvis/whatsapp";

export interface WhatsAppRouterDeps {
  repo: IWhatsAppRepository;
  config: WhatsAppConfig;
  now?: () => Date;
}

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    success: false,
    error: { code, message },
    timestamp: new Date().toISOString(),
  });
}

/** Structured server-side log. Bodies are never logged; numbers are masked. */
function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

export function createWhatsAppRouter(container: Container, deps: WhatsAppRouterDeps): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const now = deps.now ?? (() => new Date());

  // Raw parser scoped to the webhook path only. Registered on the router so it
  // cannot alter body parsing for any other route in the application.
  const rawJson = raw({ type: "application/json", limit: "1mb" });

  // -------------------------------------------------------------------------
  // GET /webhook — Meta verification handshake
  // -------------------------------------------------------------------------
  router.get("/webhook", (req: AuthenticatedRequest, res: Response) => {
    const result = verifyWebhookChallenge(
      req.query as Record<string, unknown>,
      deps.config.verifyToken
    );
    if (!result.ok) {
      logEvent("whatsapp_webhook_verification_failed");
      // A single opaque 403 — never explain which part did not match.
      return fail(res, 403, "AUTHORIZATION_FAILED", "Verification failed");
    }
    logEvent("whatsapp_webhook_verified");
    // Meta requires the bare challenge string, not a JSON envelope.
    res.status(200).type("text/plain").send(result.challenge);
  });

  // -------------------------------------------------------------------------
  // POST /webhook — inbound messages and delivery statuses
  // -------------------------------------------------------------------------
  router.post("/webhook", rawJson, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const rawBody: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;

    const signature = verifyWebhookSignature(
      rawBody,
      req.headers["x-hub-signature-256"] as string | undefined,
      deps.config.appSecret
    );
    if (!signature.valid) {
      // reason is logged, never returned: the response must not become an
      // oracle explaining how to forge a valid request.
      logEvent("whatsapp_webhook_signature_rejected", { reason: signature.reason });
      return fail(res, 401, "AUTHENTICATION_REQUIRED", "Invalid signature");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody!.toString("utf8"));
    } catch {
      // Signed but unparseable. 200 stops a pointless redelivery loop.
      logEvent("whatsapp_webhook_unparseable");
      return ok(res, { processed: 0, duplicates: 0, skipped: 0 });
    }

    const event = parseWebhookPayload(payload);
    let processed = 0;
    let duplicates = 0;
    let skipped = 0;

    for (const message of event.messages) {
      // Replay guard 1 — freshness. A valid signature proves authenticity, not
      // recency; without this a captured payload replays forever.
      if (!isFresh(message.timestamp, deps.config.maxEventAgeMs, now())) {
        skipped++;
        logEvent("whatsapp_message_stale", {
          providerMessageId: message.providerMessageId,
          from: maskPhoneNumber(message.from),
        });
        continue;
      }

      // Tenant resolution — the only thing that makes an inbound row owned.
      const userId = await deps.repo.findUserForPhoneNumber(message.phoneNumberId);
      if (!userId) {
        skipped++;
        logEvent("whatsapp_unclaimed_phone_number", { phoneNumberId: message.phoneNumberId });
        continue;
      }

      // Replay guard 2 — the unique constraint on provider_message_id.
      const result = await deps.repo.recordInbound({ userId, message });
      if (result.duplicate) {
        duplicates++;
        logEvent("whatsapp_duplicate_message", {
          providerMessageId: message.providerMessageId,
        });
        continue;
      }
      processed++;
      logEvent("whatsapp_message_recorded", {
        providerMessageId: message.providerMessageId,
        from: maskPhoneNumber(message.from),
        type: message.type,
      });
    }

    for (const status of event.statuses) {
      await deps.repo.applyStatus(status);
    }

    // Counts only — never message content.
    ok(res, { processed, duplicates, skipped, statuses: event.statuses.length });
  }));

  // -------------------------------------------------------------------------
  // GET /messages — authenticated, tenant-scoped history
  // -------------------------------------------------------------------------
  router.get("/messages", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const waIdParam = typeof req.query.waId === "string" ? req.query.waId : undefined;
    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) ? limitParam : undefined;

    // userId comes from the verified token, never from the query string.
    const messages = await deps.repo.listForUser(req.auth.userId, { waId: waIdParam, limit });

    ok(res, {
      messages: messages.map((m) => ({
        id: m.id,
        providerMessageId: m.providerMessageId,
        waId: m.waId,
        direction: m.direction,
        type: m.type,
        body: m.body,
        status: m.status,
        timestamp: m.providerTimestamp.toISOString(),
      })),
      count: messages.length,
    });
  }));

  return router;
}
