// ---------------------------------------------------------------------------
// R-30 — an explicit, ordered chain of model providers.
//
// Provider health belongs to the provider, not to the agent that happened to
// call it. Before this, a rejected key or an unknown model took the calling
// AGENT out of service, and the orchestrator then answered plain requests with
// whichever other agent was ready — the Meta Ads agent in production.
//
// The chain tries its providers in the order it was given, each at most once
// per request, and never retries by itself: every provider keeps its own retry
// policy (R-26) and circuit breaker (R-27), and the chain only reads their
// classified result.
//
//   success                        answered; later providers are not called
//   permanent (rejected key,       the provider is skipped for a cooldown, then
//   no access, unknown model)      probed by one request at a time; the next
//                                  provider is tried now
//   transient, circuit open        the next provider is tried now, no cooldown
//   not configured                 the next provider is tried now
//   request (context length,       returned as-is: another provider would fail
//   invalid request)               the same request the same way
//   aborted, unexpected            returned as-is
//   nothing usable                 503 AI_PROVIDER_UNAVAILABLE with a fixed
//                                  message and the first cause code
//
// Pure apart from the default clock, which callers can replace.
// ---------------------------------------------------------------------------

import type { AICompletionRequest, AICompletionResponse, IAIProvider } from "./types/ai-provider.js";
import { JarvisError } from "./types/errors.js";

/** What a provider failure says about the provider that produced it. */
export type ProviderFailureKind =
  | "not_configured"
  | "aborted"
  | "unavailable"
  | "transient"
  | "permanent"
  | "request"
  | "unexpected";

/** Failures that will repeat, whatever is asked, until configuration changes. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  "AI_PROVIDER_AUTH_FAILED", // the provider rejected the server's key (R-29)
  "AUTHENTICATION_REQUIRED", // the same, reported the older way
  "AUTHORIZATION_FAILED", // the key has no access to the model or project
]);

/**
 * Classifies a provider failure from its `code` and `details`, which the
 * provider adapters set in `toJarvisError`: `transient`, `aborted`, and
 * `scope: "provider"` for an unknown model.
 *
 * Fields are read rather than testing `instanceof JarvisError`, so a second
 * copy of this package in the module graph cannot change the answer.
 */
export function classifyProviderFailure(error: unknown): ProviderFailureKind {
  const { code, details } = (error ?? {}) as {
    code?: unknown;
    details?: { transient?: unknown; aborted?: unknown; scope?: unknown };
  };

  if (code === "AI_PROVIDER_NOT_CONFIGURED") return "not_configured";
  if (details?.aborted === true) return "aborted";
  if (code === "AI_PROVIDER_UNAVAILABLE") return "unavailable";
  if (code === "RATE_LIMITED" || details?.transient === true) return "transient";
  if ((typeof code === "string" && PERMANENT_CODES.has(code)) || details?.scope === "provider") {
    return "permanent";
  }
  if (code === "CONTEXT_LENGTH_EXCEEDED" || code === "INVALID_REQUEST") return "request";
  return "unexpected";
}

/**
 * What the user sees when no provider can answer. Fixed, so no provider's own
 * text, URL or key fragment can reach a response through it.
 */
const RECOVERY_MESSAGE =
  "The AI provider is temporarily unavailable. JARVIS is attempting to recover, using a fallback provider where one is configured. Please try again shortly.";

export interface FallbackProviderOptions {
  /** How long a permanently failed provider is skipped before one probe. */
  permanentCooldownMs: number;
}

export const DEFAULT_FALLBACK_PROVIDER_OPTIONS: Readonly<FallbackProviderOptions> = Object.freeze({
  permanentCooldownMs: 5 * 60_000,
});

/** One chain event: a provider id and an error code, never a message. */
export interface ProviderChainEvent {
  event:
    | "provider_failed_permanently"
    | "provider_skipped"
    | "provider_fallback_used"
    | "provider_recovered"
    | "providers_exhausted";
  provider: string;
  cause?: string;
}

interface ProviderHealth {
  /** Null while usable; otherwise skipped until this time, then probed. */
  disabledUntil: number | null;
  /** The code that disabled it, reported as the cause while it is skipped. */
  cause: string | null;
  probing: boolean;
}

type Admission = "use" | "probe" | "skip";

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "INTERNAL_ERROR";
}

export class FallbackAIProvider implements IAIProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  /** The providers, in the order they are tried. */
  readonly providers: readonly IAIProvider[];

  private readonly options: FallbackProviderOptions;
  private readonly now: () => number;
  private readonly onEvent?: (event: ProviderChainEvent) => void;
  private readonly health: ProviderHealth[];

  constructor(
    providers: IAIProvider[],
    options: Partial<FallbackProviderOptions> = {},
    deps: { now?: () => number; onEvent?: (event: ProviderChainEvent) => void } = {}
  ) {
    const primary = providers[0];
    if (!primary) {
      throw new Error("FallbackAIProvider needs at least one provider");
    }
    this.providers = Object.freeze([...providers]);
    // The primary's identity: agents read `defaultModel`, logs read `id`.
    this.id = primary.id;
    this.name = primary.name;
    this.defaultModel = primary.defaultModel;
    this.options = { ...DEFAULT_FALLBACK_PROVIDER_OPTIONS, ...options };
    this.now = deps.now ?? Date.now;
    this.onEvent = deps.onEvent;
    this.health = providers.map(() => ({ disabledUntil: null, cause: null, probing: false }));
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    let cause: string | undefined;
    let notConfigured: unknown;

    for (let index = 0; index < this.providers.length; index++) {
      if (request.signal?.aborted) {
        throw new JarvisError("INTERNAL_ERROR", "Request was aborted", { aborted: true });
      }

      const provider = this.providers[index]!;
      const health = this.health[index]!;
      const admission = this.admit(health);

      if (admission === "skip") {
        cause ??= health.cause ?? "AI_PROVIDER_UNAVAILABLE";
        this.emit("provider_skipped", provider, health.cause ?? undefined);
        continue;
      }

      // A model id chosen for the primary means nothing to another provider.
      const attempt = index === 0 ? request : { ...request, model: undefined };

      try {
        const response = await provider.complete(attempt);
        this.restore(health, provider);
        if (index > 0) this.emit("provider_fallback_used", provider);
        return response;
      } catch (error) {
        switch (classifyProviderFailure(error)) {
          case "request":
            // The provider answered; the request is what failed.
            this.restore(health, provider);
            throw error;
          case "aborted":
          case "unexpected":
            this.releaseProbe(health, admission);
            throw error;
          case "permanent":
            cause ??= codeOf(error);
            this.disable(health, provider, codeOf(error));
            break;
          case "not_configured":
            this.releaseProbe(health, admission);
            notConfigured ??= error;
            break;
          case "transient":
          case "unavailable":
            cause ??= codeOf(error);
            this.releaseProbe(health, admission);
            break;
        }
      }
    }

    // Nothing is configured at all: keep R-21's answer exactly.
    if (cause === undefined && notConfigured !== undefined) {
      throw notConfigured;
    }

    const finalCause = cause ?? "AI_PROVIDER_UNAVAILABLE";
    this.emit("providers_exhausted", this.providers[0]!, finalCause);
    throw new JarvisError("AI_PROVIDER_UNAVAILABLE", RECOVERY_MESSAGE, { transient: true, cause: finalCause });
  }

  async listModels(): Promise<string[]> {
    return this.providers[0]!.listModels();
  }

  /** Whether any provider that is not being skipped reports itself available. */
  async isAvailable(): Promise<boolean> {
    for (let index = 0; index < this.providers.length; index++) {
      const health = this.health[index]!;
      const skipped =
        health.disabledUntil !== null && (this.now() < health.disabledUntil || health.probing);
      if (!skipped && (await this.providers[index]!.isAvailable())) return true;
    }
    return false;
  }

  private admit(health: ProviderHealth): Admission {
    if (health.disabledUntil === null) return "use";
    if (this.now() < health.disabledUntil || health.probing) return "skip";
    health.probing = true;
    return "probe";
  }

  private disable(health: ProviderHealth, provider: IAIProvider, cause: string): void {
    health.disabledUntil = this.now() + this.options.permanentCooldownMs;
    health.cause = cause;
    health.probing = false;
    this.emit("provider_failed_permanently", provider, cause);
  }

  private restore(health: ProviderHealth, provider: IAIProvider): void {
    if (health.disabledUntil !== null) this.emit("provider_recovered", provider);
    health.disabledUntil = null;
    health.cause = null;
    health.probing = false;
  }

  private releaseProbe(health: ProviderHealth, admission: Admission): void {
    if (admission === "probe") health.probing = false;
  }

  private emit(event: ProviderChainEvent["event"], provider: IAIProvider, cause?: string): void {
    this.onEvent?.({ event, provider: provider.id, ...(cause ? { cause } : {}) });
  }
}
