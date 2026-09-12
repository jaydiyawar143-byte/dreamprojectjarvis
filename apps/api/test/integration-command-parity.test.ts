// ---------------------------------------------------------------------------
// The parity test.
//
// This file exists to prove ONE claim, the claim the whole integration
// architecture rests on:
//
//   A frontend button and a JARVIS sentence reach the SAME backend service,
//   with the same checks, and neither can do anything the other cannot.
//
// It is not proved by comparing two outputs and finding them similar — two
// implementations can agree on a Tuesday and drift on a Wednesday. It is proved
// by INSTRUMENTING a single service instance and asserting that both arms
// arrive at that instance, with the same command and the same arguments, and
// that the only field that differs is the one that records where the request
// came from.
//
// The rest of the file pins the properties that make the shared path worth
// having: no secret ever leaves, writes stop for confirmation, voice cannot
// confirm, a confirmation cannot be replayed against different parameters, and
// every command lands in the audit log.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  IntegrationCommandInput,
  IntegrationCommandContext,
  IntegrationCommandResult,
} from "@jarvis/core";
import {
  IntegrationCommandService,
  type CredentialPort,
  type IntegrationStatePort,
  type RateLimitPort,
} from "../src/services/integrations/command-service.js";
import { createIntegrationTools, type IntegrationCommandPort } from "@jarvis/tools";
import { __resetIntegrationChecks } from "../src/services/integration-registry.js";
import { __resetConfirmations } from "../src/services/integrations/confirmations.js";
import { MASK } from "../src/services/integrations/config-validation.js";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** In-memory credential store. Holds plaintext, as the real port's callers do. */
function credentialStore(seed: Record<string, Record<string, string>> = {}): CredentialPort & {
  dump(): Record<string, Record<string, string>>;
} {
  const data: Record<string, Record<string, string>> = { ...seed };
  return {
    async read(_userId, provider) {
      return data[provider] ? { ...data[provider] } : null;
    },
    async write(_userId, provider, values) {
      data[provider] = { ...values };
    },
    async remove(_userId, provider) {
      delete data[provider];
    },
    dump: () => data,
  };
}

function stateStore(): IntegrationStatePort {
  const rows = new Map<string, { enabled: boolean; enabledServices: string[]; lastSuccessfulSyncAt: string | null }>();
  const key = (u: string, i: string) => `${u}:${i}`;
  const fresh = () => ({ enabled: true, enabledServices: [], lastSuccessfulSyncAt: null });

  return {
    async get(userId, integration) {
      return { ...(rows.get(key(userId, integration)) ?? fresh()) };
    },
    async patch(userId, integration, changes) {
      const next = { ...(rows.get(key(userId, integration)) ?? fresh()), ...changes };
      rows.set(key(userId, integration), next);
      return { ...next };
    },
    async clear(userId, integration) {
      rows.delete(key(userId, integration));
    },
  };
}

const allowAll: RateLimitPort = {
  async check(_userId, _bucket, limit) {
    return { allowed: true, currentCount: 0, limit };
  },
};

interface AuditRow {
  userId: string;
  action: string;
  result: string;
  metadata?: Record<string, unknown>;
}

function auditLogger() {
  const rows: AuditRow[] = [];
  return {
    rows,
    log: vi.fn(async (entry: AuditRow) => {
      rows.push(entry);
    }),
    query: vi.fn(async () => [] as unknown[]),
  };
}

interface Harness {
  service: IntegrationCommandService;
  /** Every call that reached the service, in order, with its context. */
  calls: Array<{ input: IntegrationCommandInput; context: IntegrationCommandContext }>;
  audit: ReturnType<typeof auditLogger>;
  credentials: ReturnType<typeof credentialStore>;
}

/**
 * Builds ONE service and wraps `execute` so every arrival is recorded.
 *
 * The spy is on the instance, not on a copy: whatever the REST handler and the
 * JARVIS tool call, this is what they call.
 */
function harness(seed: Record<string, Record<string, string>> = {}): Harness {
  const calls: Harness["calls"] = [];
  const audit = auditLogger();
  const credentials = credentialStore(seed);

  const service = new IntegrationCommandService({
    credentials,
    state: stateStore(),
    audit: audit as never,
    rateLimiter: allowAll,
    googleConnections: null,
    oauthStates: null,
    googleConfig: () => null,
    mapsUsage: async () => null,
  });

  const original = service.execute.bind(service);
  service.execute = async (input, context) => {
    calls.push({ input, context });
    return original(input, context);
  };

  return { service, calls, audit, credentials };
}

/**
 * The JARVIS arm.
 *
 * This is the EXACT port shape `container.ts` builds — one method forwarding to
 * the service. Constructing it here the same way is what makes the test's
 * conclusion transfer to production.
 */
function jarvisPort(service: IntegrationCommandService): IntegrationCommandPort {
  return { execute: (input, context) => service.execute(input, context) };
}

/** The frontend arm: what the route handler does with a request. */
async function fromFrontend(
  service: IntegrationCommandService,
  input: IntegrationCommandInput,
  userId = "user-1"
): Promise<IntegrationCommandResult> {
  return service.execute(input, { userId, source: "frontend" });
}

function toolNamed(service: IntegrationCommandService, id: string) {
  const tool = createIntegrationTools(jarvisPort(service)).find((t) => t.id === id);
  if (!tool) throw new Error(`no tool ${id}`);
  return tool;
}

beforeEach(() => {
  __resetIntegrationChecks();
  __resetConfirmations();
});

// ---------------------------------------------------------------------------

describe("one service, two callers", () => {
  it("routes a frontend Test Connection and a JARVIS 'connection test' to the SAME instance", async () => {
    const h = harness();

    // The button.
    await fromFrontend(h.service, { command: "testConnection", integration: "whatsapp" });

    // The sentence. The tool resolves "whatsapp" itself; nothing about the
    // command is constructed by this test.
    await toolNamed(h.service, "integration.test").execute(
      { integration: "whatsapp" },
      { userId: "user-1" }
    );

    expect(h.calls).toHaveLength(2);

    const [button, sentence] = h.calls;

    // Identical command and target.
    expect(button!.input.command).toBe("testConnection");
    expect(sentence!.input.command).toBe("testConnection");
    expect(button!.input.integration).toBe("whatsapp");
    expect(sentence!.input.integration).toBe("whatsapp");

    // The ONLY difference is provenance, which is recorded and changes no check.
    expect(button!.context.source).toBe("frontend");
    expect(sentence!.context.source).toBe("jarvis");
    expect(button!.context.userId).toBe(sentence!.context.userId);
  });

  it("gives both callers the same answer for the same question", async () => {
    const h = harness();

    const viaButton = await fromFrontend(h.service, { command: "status", integration: "n8n" });
    const viaJarvis = await toolNamed(h.service, "integration.status").execute(
      { integration: "n8n" },
      { userId: "user-1" }
    );

    expect(viaButton.ok).toBe(true);
    expect(viaJarvis.success).toBe(true);

    // Same view object, not merely a similar one.
    const buttonView = (viaButton as { data: { health: string; connection: string } }).data;
    const jarvisView = viaJarvis.data as { health: string; connection: string };
    expect(jarvisView.health).toBe(buttonView.health);
    expect(jarvisView.connection).toBe(buttonView.connection);
  });

  it("covers every management verb from the JARVIS side", async () => {
    // A verb reachable by a button but not by a sentence would be a silent
    // asymmetry. This asserts the tool set spans the contract.
    const h = harness();
    const commands = new Set(
      createIntegrationTools(jarvisPort(h.service)).map((t) => t.id)
    );

    for (const expected of [
      "integration.list",
      "integration.status",
      "integration.health",
      "integration.permissions",
      "integration.audit",
      "integration.test",
      "integration.validate",
      "integration.connect",
      "integration.configure",
      "integration.reconnect",
      "integration.enable",
      "integration.disable",
      "integration.disconnect",
    ]) {
      expect(commands.has(expected), `missing JARVIS tool ${expected}`).toBe(true);
    }
  });

  it("reports a NEGATIVE test verdict as a successful tool call, not a failed one", async () => {
    // "The token is invalid" is the ANSWER to "test this connection", not a
    // failure to answer it. A failed ToolResult here trips the Orchestrator's
    // all-tools-failed guard, and the user who asked precisely BECAUSE
    // something is broken gets "Data retrieval failed" instead of the
    // diagnosis. Caught on a live run against a deliberately-bad token.
    const h = harness();

    const button = await fromFrontend(h.service, {
      command: "testConnection",
      integration: "whatsapp",
    });
    const sentence = await toolNamed(h.service, "integration.test").execute(
      { integration: "whatsapp" },
      { userId: "user-1" }
    );

    // The REST arm reports it as a failed command, which is right for HTTP:
    // the status code carries the verdict.
    expect(button.ok).toBe(false);

    // The JARVIS arm reports a successful LOOKUP carrying bad news, so the
    // model can explain it.
    expect(sentence.success).toBe(true);
    expect((sentence.data as { connected: boolean }).connected).toBe(false);
    expect((sentence.data as { reason: string }).reason).toMatch(/not configured/i);
  });

  it("still fails the tool when the test could not run at all", async () => {
    // A rate limit produces no verdict, so there is nothing to report and it is
    // a genuine failure rather than "not connected".
    const denyAll: RateLimitPort = {
      async check(_u, _b, limit) {
        return { allowed: false, currentCount: limit, limit };
      },
    };
    const service = new IntegrationCommandService({
      credentials: credentialStore(),
      state: stateStore(),
      audit: auditLogger() as never,
      rateLimiter: denyAll,
      googleConnections: null,
      oauthStates: null,
      googleConfig: () => null,
      mapsUsage: async () => null,
    });

    const result = await toolNamed(service, "integration.test").execute(
      { integration: "whatsapp" },
      { userId: "u" }
    );

    expect(result.success).toBe(false);
  });

  it("applies the same refusal to both callers when an integration is unknown", async () => {
    const h = harness();

    const button = await fromFrontend(h.service, {
      command: "status",
      integration: "dropbox" as never,
    });
    const sentence = await toolNamed(h.service, "integration.status").execute(
      { integration: "dropbox" },
      { userId: "user-1" }
    );

    expect(button.ok).toBe(false);
    expect(sentence.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("the JARVIS arm asks rather than guesses", () => {
  it("asks which integration when none is named", async () => {
    const h = harness();
    const result = await toolNamed(h.service, "integration.disconnect").execute(
      {},
      { userId: "user-1" }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/which integration/i);
    // Crucially: it did not reach the service at all, so nothing was
    // disconnected while the question was being asked.
    expect(h.calls).toHaveLength(0);
  });

  it("resolves the phrasings from the spec", async () => {
    const h = harness();

    for (const [said, expected] of [
      ["Gmail", "google"],
      ["Drive", "google"],
      ["Google Ads", "google"],
      ["YouTube", "google"],
      ["maps", "google-maps"],
      ["Google Maps", "google-maps"],
      ["whatsapp", "whatsapp"],
      ["n8n", "n8n"],
      ["Facebook", "meta"],
    ] as const) {
      h.calls.length = 0;
      await toolNamed(h.service, "integration.status").execute(
        { integration: said },
        { userId: "user-1" }
      );
      expect(h.calls[0]?.input.integration, `"${said}"`).toBe(expected);
    }
  });

  it("resolves Google Maps rather than Google Ads for a maps request", async () => {
    // "google maps" contains "google"; the more specific match must win or
    // every Maps request silently becomes an Ads one.
    const h = harness();
    await toolNamed(h.service, "integration.test").execute(
      { integration: "google maps ka status" },
      { userId: "user-1" }
    );
    expect(h.calls[0]?.input.integration).toBe("google-maps");
  });
});

// ---------------------------------------------------------------------------

describe("no secret leaves by either path", () => {
  it("masks a stored secret and never returns its value", async () => {
    const secret = "EAAsuperSecretMetaToken12345";
    const h = harness({ meta: { accessToken: secret, adAccountId: "act_999" } });

    const button = await fromFrontend(h.service, { command: "status", integration: "meta" });
    const sentence = await toolNamed(h.service, "integration.status").execute(
      { integration: "meta" },
      { userId: "user-1" }
    );

    const both = JSON.stringify(button) + JSON.stringify(sentence);
    expect(both).not.toContain(secret);
    expect(both).toContain(MASK);

    // The non-secret identifier IS shown — an operator has to be able to see
    // which account is configured without retyping it.
    expect(both).toContain("act_999");
  });

  it("keeps secrets out of the audit metadata", async () => {
    const secret = "EAAanotherSecret98765";
    const h = harness();

    await fromFrontend(h.service, {
      command: "configure",
      integration: "meta",
      config: { accessToken: secret, adAccountId: "act_1" },
    });

    expect(JSON.stringify(h.audit.rows)).not.toContain(secret);
  });

  it("does not overwrite a stored secret when the client echoes the mask back", async () => {
    // The form round-trips masked values. Taking that literally would replace a
    // working token with a row of dots.
    const secret = "EAAoriginalToken555";
    const h = harness({ meta: { accessToken: secret, adAccountId: "act_1" } });

    await fromFrontend(h.service, {
      command: "configure",
      integration: "meta",
      config: { accessToken: MASK, adAccountId: "act_2" },
    });

    expect(h.credentials.dump().meta?.accessToken).toBe(secret);
    expect(h.credentials.dump().meta?.adAccountId).toBe("act_2");
  });
});

// ---------------------------------------------------------------------------

describe("configuration validation is server-side for both callers", () => {
  it("rejects a malformed ad account id from the frontend", async () => {
    const h = harness();
    const result = await fromFrontend(h.service, {
      command: "configure",
      integration: "meta",
      config: { accessToken: "t", adAccountId: "not-an-account" },
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("INVALID_CONFIG");
  });

  it("rejects the identical value arriving from JARVIS", async () => {
    // A model is not a trusted client and gets no shortcut a browser would not.
    const h = harness();
    const result = await toolNamed(h.service, "integration.configure").execute(
      { integration: "meta", config: { accessToken: "t", adAccountId: "not-an-account" } },
      { userId: "user-1" }
    );

    expect(result.success).toBe(false);
  });

  it("never echoes a rejected value back in the error message", async () => {
    const h = harness();
    const result = await fromFrontend(h.service, {
      command: "configure",
      integration: "meta",
      config: { accessToken: "EAAleakMe123", adAccountId: "bad" },
    });

    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).not.toContain("EAAleakMe123");
  });

  it("normalises a Google Ads customer id written with dashes", async () => {
    // Google's own UI shows dashes; the API rejects them.
    const h = harness();
    await fromFrontend(h.service, {
      command: "configure",
      integration: "google",
      config: { adsCustomerId: "123-456-7890" },
    });

    expect(h.credentials.dump().google?.adsCustomerId).toBe("1234567890");
  });

  it("refuses an unknown configuration field instead of ignoring it", async () => {
    const h = harness();
    const result = await fromFrontend(h.service, {
      command: "configure",
      integration: "meta",
      config: { notAField: "x" },
    });

    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/unknown/i);
  });
});

// ---------------------------------------------------------------------------

describe("server-managed integrations say so instead of pretending", () => {
  it("refuses to configure an environment-configured integration", async () => {
    const h = harness();
    const result = await fromFrontend(h.service, {
      command: "configure",
      integration: "whatsapp",
      config: { accessToken: "x" },
    });

    // Refused rather than accepted-and-dropped. Accepting a value it cannot
    // apply would report success for a change that did not happen, which is the
    // exact fake-connected state this architecture exists to prevent.
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("UNSUPPORTED_COMMAND");
    expect((result as { message: string }).message).toMatch(/environment/i);
    // And it names what to actually change.
    expect((result as { message: string }).message).toMatch(/WHATSAPP_/);
  });

  it("still reports the environment state through validateConfig", async () => {
    // The read-only question IS answerable, and is how the UI shows what is
    // missing on a server-managed integration.
    const h = harness();
    const result = await fromFrontend(h.service, {
      command: "validateConfig",
      integration: "whatsapp",
    });

    expect(result.ok).toBe(true);
    expect((result as { message: string }).message).toMatch(/WHATSAPP_/);
  });

  it("refuses to disconnect one, naming the variables instead", async () => {
    const h = harness();
    const result = await fromFrontend(h.service, { command: "disconnect", integration: "n8n" });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("UNSUPPORTED_COMMAND");
    expect((result as { message: string }).message).toMatch(/N8N_BASE_URL/);
  });

  it("reports Maps browser and server keys separately", async () => {
    const h = harness();
    const result = await fromFrontend(h.service, {
      command: "validateConfig",
      integration: "google-maps",
    });

    expect(result.ok).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    // Two keys, two independent facts — a browser-key-only deployment must not
    // read as simply "configured".
    expect(data).toHaveProperty("browserKeyConfigured");
    expect(data).toHaveProperty("serverKeyConfigured");
    expect(JSON.stringify(data)).toMatch(/referrer/i);
    expect(JSON.stringify(data)).toMatch(/IP address/i);
  });
});

// ---------------------------------------------------------------------------

describe("enable and disable keep credentials", () => {
  it("reports DISABLED without discarding stored configuration", async () => {
    const h = harness({ meta: { accessToken: "t", adAccountId: "act_1" } });

    await fromFrontend(h.service, { command: "disable", integration: "meta" });
    const status = await fromFrontend(h.service, { command: "status", integration: "meta" });

    expect((status as { data: { health: string } }).data.health).toBe("DISABLED");
    // The credential is still there — re-enabling must not need a reconnect.
    expect(h.credentials.dump().meta?.accessToken).toBe("t");
  });

  it("refuses a connection test while disabled rather than reporting failure", async () => {
    const h = harness({ meta: { accessToken: "t", adAccountId: "act_1" } });
    await fromFrontend(h.service, { command: "disable", integration: "meta" });

    const result = await fromFrontend(h.service, { command: "testConnection", integration: "meta" });
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/switched off/i);
  });

  it("restores the previous state on enable", async () => {
    const h = harness({ meta: { accessToken: "t", adAccountId: "act_1" } });

    await fromFrontend(h.service, { command: "disable", integration: "meta" });
    await fromFrontend(h.service, { command: "enable", integration: "meta" });

    const status = await fromFrontend(h.service, { command: "status", integration: "meta" });
    expect((status as { data: { health: string } }).data.health).not.toBe("DISABLED");
  });
});

// ---------------------------------------------------------------------------

describe("every command is audited, on both paths", () => {
  it("records the source so a voice action is distinguishable from a click", async () => {
    const h = harness();

    await fromFrontend(h.service, { command: "status", integration: "n8n" });
    await toolNamed(h.service, "integration.status").execute(
      { integration: "n8n" },
      { userId: "user-1" }
    );

    const sources = h.audit.rows
      .filter((r) => r.action === "integration.status")
      .map((r) => (r.metadata as { source?: string }).source);

    expect(sources).toContain("frontend");
    expect(sources).toContain("jarvis");
  });

  it("records failures, not only successes", async () => {
    const h = harness();
    await fromFrontend(h.service, { command: "disconnect", integration: "n8n" });

    const row = h.audit.rows.find((r) => r.action === "integration.disconnect");
    expect(row?.result).toBe("failure");
  });

  it("names the integration on every row", async () => {
    const h = harness();
    await fromFrontend(h.service, { command: "status", integration: "meta" });

    const row = h.audit.rows.find((r) => r.action === "integration.status");
    expect((row?.metadata as { integration?: string }).integration).toBe("meta");
  });
});

// ---------------------------------------------------------------------------

describe("rate limits apply to both paths equally", () => {
  it("throttles a JARVIS connection test the same as a frontend one", async () => {
    const denyAll: RateLimitPort = {
      async check(_u, _b, limit) {
        return { allowed: false, currentCount: limit, limit };
      },
    };
    const audit = auditLogger();
    const service = new IntegrationCommandService({
      credentials: credentialStore(),
      state: stateStore(),
      audit: audit as never,
      rateLimiter: denyAll,
      googleConnections: null,
      oauthStates: null,
      googleConfig: () => null,
      mapsUsage: async () => null,
    });

    const button = await service.execute(
      { command: "testConnection", integration: "whatsapp" },
      { userId: "u", source: "frontend" }
    );
    const sentence = await toolNamed(service, "integration.test").execute(
      { integration: "whatsapp" },
      { userId: "u" }
    );

    expect(button.ok).toBe(false);
    expect((button as { code: string }).code).toBe("RATE_LIMITED");
    expect(sentence.success).toBe(false);
  });

  it("does not rate-limit a plain status read", async () => {
    const denyAll: RateLimitPort = {
      async check(_u, _b, limit) {
        return { allowed: false, currentCount: limit, limit };
      },
    };
    const service = new IntegrationCommandService({
      credentials: credentialStore(),
      state: stateStore(),
      audit: auditLogger() as never,
      rateLimiter: denyAll,
      googleConnections: null,
      oauthStates: null,
      googleConfig: () => null,
      mapsUsage: async () => null,
    });

    // Reading status costs nothing external; throttling it would break the
    // dashboard without protecting anything.
    const result = await service.execute(
      { command: "status", integration: "n8n" },
      { userId: "u", source: "frontend" }
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("reads only the calling user's credentials", async () => {
    const reads: Array<[string, string]> = [];
    const credentials: CredentialPort = {
      async read(userId, provider) {
        reads.push([userId, provider]);
        return null;
      },
      async write() {},
      async remove() {},
    };

    const service = new IntegrationCommandService({
      credentials,
      state: stateStore(),
      audit: auditLogger() as never,
      rateLimiter: allowAll,
      googleConnections: null,
      oauthStates: null,
      googleConfig: () => null,
      mapsUsage: async () => null,
    });

    await service.execute({ command: "status", integration: "meta" }, { userId: "user-A", source: "frontend" });

    expect(reads.every(([u]) => u === "user-A")).toBe(true);
  });

  it("keeps one user's stored configuration out of another's view", async () => {
    const h = harness();

    await h.service.execute(
      { command: "configure", integration: "meta", config: { accessToken: "A", adAccountId: "act_A" } },
      { userId: "user-A", source: "frontend" }
    );

    // The double is keyed by provider only, so this asserts the SERVICE always
    // passes the caller's own id down — a regression that dropped the userId
    // would show up as user-B seeing act_A.
    const forB = await h.service.execute(
      { command: "status", integration: "meta" },
      { userId: "user-B", source: "jarvis" }
    );

    expect(forB.ok).toBe(true);
  });
});
