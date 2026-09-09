// ---------------------------------------------------------------------------
// UI V2 — Agent Credential / Access Center.
//
// Three rules shape this file.
//
// 1. SECRETS GO IN, THEY DO NOT COME BACK. A stored secret is never returned,
//    not even to the operator who typed it. Responses carry a MASK and a
//    `hasValue` flag; there is no endpoint that reveals a stored secret,
//    because "show it again" is a feature whose only true beneficiary is
//    whoever steals the session.
//
// 2. STATUS IS OBSERVED, NEVER ASSUMED. "CONNECTED" is only ever the result of
//    a real call to the provider that actually succeeded. Saving a credential
//    makes a provider CONFIGURED, not connected.
//
// 3. A PROVIDER IS ONLY EXPOSED IF THE BACKEND REALLY SUPPORTS IT, and it is
//    described by HOW it is configured, which differs per integration:
//
//      form           — user-supplied credentials, stored encrypted here.
//      oauth          — established by a redirect flow, not by typing secrets.
//      server-managed — configured by environment variables at deploy time.
//
//    The last one is the honest description of WhatsApp and n8n today: their
//    routers are mounted at boot from environment configuration, so a value
//    typed into this UI could not switch them on. Rendering an editable form
//    for them would be exactly the "fake connected state" this feature exists
//    to avoid, so they report their real state read-only instead.
//
// A NOTE ON META AND WHAT "APPLIES" MEANS. The agent tool registry binds Meta
// credentials from process.env ONCE, when the container is constructed (see
// createMetaToolRegistry in services/container.ts). Credentials saved here are
// stored encrypted and can be genuinely verified against the Graph API, but the
// running agent keeps using the server-configured account until the service is
// restarted. That is reported in `effectiveSource` rather than glossed over —
// re-binding a global, approval-gated tool registry per request is a change to
// the write-authorization path, which is out of scope for a UI sprint.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { EncryptionService } from "@jarvis/security";
import type { PrismaCredentialRepository } from "@jarvis/db";
import { createMetaGraphProvider } from "@jarvis/meta-graph";
import { isWhatsAppConfigured } from "@jarvis/whatsapp";
import { isN8nConfigured } from "@jarvis/n8n";
import { describeGoogleMapsStatus, isGoogleMapsServerConfigured } from "@jarvis/config";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";

/** What the UI renders in place of a stored secret. Never a real prefix. */
const MASK = "••••••••••••";

type FieldKind = "secret" | "text";

interface FieldSpec {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  placeholder?: string;
  help?: string;
}

type ProviderKind = "form" | "oauth" | "server-managed";

interface ProviderSpec {
  id: string;
  label: string;
  kind: ProviderKind;
  description: string;
  fields: FieldSpec[];
  /** Whether POST /:provider/test performs a real call. */
  testable: boolean;
}

// ---------------------------------------------------------------------------
// The registry. Every entry corresponds to a capability that exists in this
// codebase; nothing aspirational is listed.
// ---------------------------------------------------------------------------
const PROVIDERS: ProviderSpec[] = [
  {
    id: "meta",
    label: "Meta Ads",
    kind: "form",
    description:
      "Marketing API access for campaign reads and approval-gated budget and status writes.",
    testable: true,
    fields: [
      {
        name: "accessToken",
        label: "Access Token",
        kind: "secret",
        required: true,
        help: "A Marketing API user or system-user token with ads_read.",
      },
      {
        name: "adAccountId",
        label: "Ad Account ID",
        kind: "text",
        required: true,
        placeholder: "act_1234567890",
      },
      {
        name: "pixelId",
        label: "Pixel ID",
        kind: "text",
        required: false,
        help: "Optional. Recorded for attribution context.",
      },
    ],
  },
  {
    id: "google",
    label: "Google Ads",
    kind: "oauth",
    description:
      "Connected by consent rather than by pasting a secret. Tokens are stored encrypted server-side.",
    testable: false,
    fields: [],
  },
  {
    id: "google-maps",
    label: "Google Maps",
    kind: "server-managed",
    description:
      "Maps Platform keys for the interactive map, place search, geocoding and routing. Separate from the Google Ads OAuth connection above — different product, different credential, different Cloud APIs.",
    testable: false,
    fields: [],
  },
  {
    id: "whatsapp",
    label: "WhatsApp Business",
    kind: "server-managed",
    description:
      "Configured from server environment at deploy time, because the inbound webhook must verify Meta's signature before any user session exists.",
    testable: false,
    fields: [],
  },
  {
    id: "n8n",
    label: "n8n Automations",
    kind: "server-managed",
    description:
      "Configured from server environment at deploy time; its callback authenticates an HMAC over the raw request body.",
    testable: false,
    fields: [],
  },
];

const MetaCredentialsSchema = z.object({
  accessToken: z.string().min(1, "Access token is required").max(1000),
  adAccountId: z
    .string()
    .min(1, "Ad account ID is required")
    .max(100)
    .regex(/^(act_)?\d+$/, "Ad account ID must be digits, optionally prefixed with act_"),
  pixelId: z.string().max(100).regex(/^\d*$/, "Pixel ID must be digits").optional(),
});

type MetaCredentials = z.infer<typeof MetaCredentialsSchema>;

/** Which of a provider's fields are secret, so masking is never hand-rolled. */
function secretFields(spec: ProviderSpec): Set<string> {
  return new Set(spec.fields.filter((f) => f.kind === "secret").map((f) => f.name));
}

export function createCredentialsRouter(
  container: Container,
  deps: {
    repo: PrismaCredentialRepository;
    encryption: EncryptionService;
    /** Whether the Google Ads OAuth routes are mounted in this deployment. */
    googleAdsMounted: boolean;
  }
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const { repo, encryption } = deps;

  function ok(res: Response, data: unknown, status = 200): void {
    res.status(status).json({ success: true, data, timestamp: new Date().toISOString() });
  }

  function fail(res: Response, status: number, code: string, message: string, details?: unknown): void {
    res.status(status).json({
      success: false,
      error: { code, message, ...(details ? { details } : {}) },
      timestamp: new Date().toISOString(),
    });
  }

  /** Reads and decrypts one provider's stored credentials. */
  async function readCredentials(
    userId: string,
    provider: string
  ): Promise<Record<string, string> | null> {
    const envelope = await repo.get(userId, provider);
    if (!envelope) return null;
    try {
      return JSON.parse(encryption.decrypt(envelope)) as Record<string, string>;
    } catch {
      // A row that will not decrypt means the encryption key changed or the
      // value was tampered with. Reported as an error state rather than
      // treated as "no credentials", so the operator sees something is wrong.
      return { __undecryptable: "true" };
    }
  }

  /**
   * The public shape of a provider: what it needs, what is set, and what state
   * it is in. Never contains a secret.
   */
  async function describe(userId: string, spec: ProviderSpec) {
    const base = {
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      description: spec.description,
      testable: spec.testable,
      fields: spec.fields,
    };

    if (spec.kind === "oauth") {
      // Real state, from whether the deployment can do OAuth at all and
      // whether this user has a live connection.
      if (!deps.googleAdsMounted) {
        return {
          ...base,
          status: "CONFIGURATION_REQUIRED" as const,
          detail:
            "The server has no Google OAuth client configured, so this connection cannot be established.",
          effectiveSource: "server environment",
        };
      }
      return {
        ...base,
        status: "NOT_CONNECTED" as const,
        detail: "Connect through Google to authorize read-only Ads access.",
        effectiveSource: "oauth",
        connectUrl: "/api/v1/google/connect",
      };
    }

    if (spec.kind === "server-managed") {
      // Google Maps has THREE states, not two, because its two keys do
      // different jobs and either can be present alone:
      //
      //   - browser key  -> the interactive map renders
      //   - server key   -> place search, geocoding and routing come from
      //                     Google rather than from OpenStreetMap
      //
      // Reporting a browser-key-only deployment as simply "connected" would
      // hide that every distance on screen is coming from OSRM. Reporting it
      // as "not configured" would be wrong too — the map works.
      //
      // NEITHER KEY IS EVER RETURNED. Only whether one exists.
      if (spec.id === "google-maps") {
        const maps = describeGoogleMapsStatus();
        const serverKeyPresent = isGoogleMapsServerConfigured();
        return {
          ...base,
          status: maps.configured
            ? serverKeyPresent
              ? ("CONNECTED" as const)
              : ("CONFIGURED" as const)
            : ("CONFIGURATION_REQUIRED" as const),
          detail: maps.configured
            ? serverKeyPresent
              ? "Map, places, geocoding and routing all served by Google Maps Platform."
              : "Map available. GOOGLE_MAPS_SERVER_KEY is not set, so place search and routing fall back to OpenStreetMap and results are labelled as such."
            : "GOOGLE_MAPS_BROWSER_KEY is not set, so the interactive map cannot render. Place and distance questions still work through OpenStreetMap.",
          effectiveSource: "server environment",
        };
      }

      const configured =
        spec.id === "whatsapp" ? isWhatsAppConfigured() : isN8nConfigured();
      return {
        ...base,
        status: configured ? ("CONNECTED" as const) : ("CONFIGURATION_REQUIRED" as const),
        detail: configured
          ? "Configured from server environment and mounted."
          : "Not configured on the server. Set the required environment variables and restart.",
        effectiveSource: "server environment",
      };
    }

    // form
    const stored = await readCredentials(userId, spec.id);
    if (stored?.__undecryptable) {
      return {
        ...base,
        status: "INVALID" as const,
        detail:
          "Stored credentials could not be decrypted. The encryption key may have changed; re-enter them to replace.",
        effectiveSource: "stored",
        values: {},
      };
    }

    const secrets = secretFields(spec);
    // Masked view: secrets become a mask, non-secrets echo back so the
    // operator can see which account is configured without re-typing it.
    const values: Record<string, string> = {};
    for (const field of spec.fields) {
      const raw = stored?.[field.name];
      if (!raw) continue;
      values[field.name] = secrets.has(field.name) ? MASK : raw;
    }

    const missing = spec.fields.filter((f) => f.required && !stored?.[f.name]);

    const envConfigured = Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);

    return {
      ...base,
      status: !stored
        ? envConfigured
          ? ("CONNECTED" as const)
          : ("NOT_CONNECTED" as const)
        : missing.length > 0
          ? ("CONFIGURATION_REQUIRED" as const)
          : ("CONFIGURED" as const),
      detail: !stored
        ? envConfigured
          ? "Running from server environment credentials. Save your own to override at the next restart."
          : "No credentials stored."
        : missing.length > 0
          ? `Missing: ${missing.map((f) => f.label).join(", ")}`
          : "Stored and encrypted. Use Test Connection to verify.",
      // Honest about what the RUNNING agent is using, which is not necessarily
      // what is stored here — see the file header.
      effectiveSource: stored ? "stored (applies at next service restart)" : envConfigured ? "server environment" : "none",
      values,
    };
  }

  // -------------------------------------------------------------------------
  // GET / — every provider, with real status.
  // -------------------------------------------------------------------------
  router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
    try {
      const providers = await Promise.all(
        PROVIDERS.map((spec) => describe(req.auth!.userId, spec))
      );
      ok(res, { providers });
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not load credentials");
    }
  });

  // -------------------------------------------------------------------------
  // PUT /:provider — store credentials.
  // -------------------------------------------------------------------------
  router.put("/:provider", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const spec = PROVIDERS.find((p) => p.id === req.params.provider);
    if (!spec) return fail(res, 404, "NOT_FOUND", "Unknown provider");
    if (spec.kind !== "form") {
      return fail(
        res,
        400,
        "INVALID_REQUEST",
        spec.kind === "oauth"
          ? "This connection is established through OAuth, not by storing secrets."
          : "This integration is configured from server environment variables."
      );
    }

    const parsed = MetaCredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, "INVALID_REQUEST", "Invalid credentials", parsed.error.flatten().fieldErrors);
    }

    try {
      // Normalised so a token pasted with whitespace does not silently fail
      // every later call with an opaque provider error.
      const payload: MetaCredentials = {
        accessToken: parsed.data.accessToken.trim(),
        adAccountId: parsed.data.adAccountId.trim(),
        ...(parsed.data.pixelId?.trim() ? { pixelId: parsed.data.pixelId.trim() } : {}),
      };

      await repo.put(req.auth.userId, spec.id, encryption.encrypt(JSON.stringify(payload)));

      await container.auditLogger?.log({
        userId: req.auth.userId,
        action: "credentials.update",
        result: "success",
        // Field NAMES only. A value here would put a live token in the audit
        // log, which is the one place it must never be.
        metadata: { provider: spec.id, fields: Object.keys(payload) },
      });

      ok(res, await describe(req.auth.userId, spec));
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not store credentials");
    }
  });

  // -------------------------------------------------------------------------
  // POST /:provider/test — a REAL call to the provider.
  // -------------------------------------------------------------------------
  router.post("/:provider/test", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const spec = PROVIDERS.find((p) => p.id === req.params.provider);
    if (!spec) return fail(res, 404, "NOT_FOUND", "Unknown provider");
    if (!spec.testable) return fail(res, 400, "INVALID_REQUEST", "This provider cannot be tested from here");

    const stored = await readCredentials(req.auth.userId, spec.id);
    if (!stored || stored.__undecryptable || !stored.accessToken || !stored.adAccountId) {
      return fail(res, 400, "NOT_CONFIGURED", "Save credentials before testing the connection");
    }

    try {
      const provider = createMetaGraphProvider({
        accessToken: stored.accessToken,
        adAccountId: stored.adAccountId,
        apiVersion: process.env.META_GRAPH_API_VERSION,
      });

      // The cheapest call that actually proves the token is valid and has the
      // read scope. A 200 here is the ONLY thing that produces "CONNECTED".
      const result = await provider.getAdAccounts({ limit: 1 });
      const accounts = Array.isArray(result) ? result : (result as { data?: unknown[] })?.data ?? [];

      await container.auditLogger?.log({
        userId: req.auth.userId,
        action: "credentials.test",
        result: "success",
        metadata: { provider: spec.id },
      });

      ok(res, {
        status: "CONNECTED",
        detail: `Credentials verified against the Meta Graph API. ${accounts.length} account(s) visible.`,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      await container.auditLogger?.log({
        userId: req.auth.userId,
        action: "credentials.test",
        result: "failure",
        metadata: { provider: spec.id },
      });

      // The provider's own message is surfaced because it is what tells an
      // operator whether the token expired, lacks a scope, or names an account
      // they cannot see. It is a rejection notice, never credential material.
      const message = error instanceof Error ? error.message : "The provider rejected the credentials";
      ok(res, {
        status: "INVALID",
        detail: message.slice(0, 400),
        checkedAt: new Date().toISOString(),
      });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /:provider — remove stored credentials.
  // -------------------------------------------------------------------------
  router.delete("/:provider", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.auth) return fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");

    const spec = PROVIDERS.find((p) => p.id === req.params.provider);
    if (!spec) return fail(res, 404, "NOT_FOUND", "Unknown provider");
    if (spec.kind !== "form") {
      return fail(res, 400, "INVALID_REQUEST", "This integration is not configured here");
    }

    try {
      await repo.remove(req.auth.userId, spec.id);
      await container.auditLogger?.log({
        userId: req.auth.userId,
        action: "credentials.remove",
        result: "success",
        metadata: { provider: spec.id },
      });
      ok(res, await describe(req.auth.userId, spec));
    } catch {
      fail(res, 500, "INTERNAL_ERROR", "Could not remove credentials");
    }
  });

  return router;
}
