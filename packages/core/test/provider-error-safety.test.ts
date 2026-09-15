// ---------------------------------------------------------------------------
// R-31 — what may leave the server when a model provider fails.
//
//   PROVIDER_ERROR_MESSAGES   fixed text for each failure category
//   provider diagnostic       the provider's own account of the failure,
//                             readable on the server, invisible to serialisation
//   redactProviderText        that account, with keys removed and length capped
//   toClientErrorDetails      `details.cause` only when it is an error code
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import { JarvisError } from "../src/types/errors.js";
import {
  PROVIDER_ERROR_MESSAGES,
  attachProviderDiagnostic,
  getProviderDiagnostic,
  providerFailureLogRecord,
  redactProviderText,
  toClientErrorDetails,
} from "../src/provider-error-safety.js";

const FAKE_KEY = "sk-test-r31-not-a-real-key";

const DIAGNOSTIC = {
  status: 400,
  type: "invalid_request_error",
  providerCode: "integer_above_max_value",
  providerRequestId: "req_r31",
  message: "Invalid value for 'temperature'",
};

describe("R-31 — a provider diagnostic stays on the server", () => {
  it("is readable where the error is handled", () => {
    const error = attachProviderDiagnostic(new JarvisError("INVALID_REQUEST", "fixed"), DIAGNOSTIC);

    expect(getProviderDiagnostic(error)).toEqual(DIAGNOSTIC);
  });

  it("is invisible to JSON, to spreading and to the fields a response copies", () => {
    const error = attachProviderDiagnostic(new JarvisError("INVALID_REQUEST", "fixed", { transient: false }), DIAGNOSTIC);

    expect(JSON.stringify(error)).not.toContain("temperature");
    expect(JSON.stringify({ ...error })).not.toContain("temperature");
    expect(JSON.stringify({ code: error.code, message: error.message, details: error.details })).not.toContain("req_r31");
  });

  it("is absent from anything that was given none", () => {
    expect(getProviderDiagnostic(new Error("plain"))).toBeUndefined();
    expect(getProviderDiagnostic(null)).toBeUndefined();
    expect(getProviderDiagnostic("text")).toBeUndefined();
  });
});

describe("R-31 — provider text kept for the log", () => {
  it("has keys and bearer tokens removed", () => {
    const text = redactProviderText(
      `Incorrect API key provided: ${FAKE_KEY}. Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123`
    );

    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  it("is capped, so no complete payload is ever logged", () => {
    expect(redactProviderText("x".repeat(5000)).length).toBeLessThanOrEqual(320);
  });
});

describe("R-31 — details.cause in a response", () => {
  it("keeps R-30's structured cause, an error code, exactly", () => {
    expect(toClientErrorDetails({ transient: true, cause: "AI_PROVIDER_AUTH_FAILED" })).toEqual({
      transient: true,
      cause: "AI_PROVIDER_AUTH_FAILED",
    });
  });

  it.each([
    ["provider text", "The model `gpt-r31-secret` does not exist at https://internal-gateway.example/v1"],
    ["a key", FAKE_KEY],
    ["an object", { status: 401, body: "Incorrect API key provided" }],
    ["a stack trace", "Error: boom\n    at handler (/srv/jarvis/index.js:1:1)"],
  ])("drops a cause that is %s and keeps the rest", (_label, cause) => {
    expect(toClientErrorDetails({ transient: true, cause })).toEqual({ transient: true });
  });

  it("leaves no details when the cause was all there was", () => {
    expect(toClientErrorDetails({ cause: "raw provider text" })).toBeUndefined();
  });

  it("leaves details without a cause untouched", () => {
    const details = { surface: { type: "map" }, maxDepth: 5 };

    expect(toClientErrorDetails(details)).toBe(details);
    expect(toClientErrorDetails(undefined)).toBeUndefined();
  });
});

describe("R-31 — the log record of a provider failure", () => {
  it("carries the code, whether it is transient, and the diagnostic — nothing else", () => {
    const error = attachProviderDiagnostic(new JarvisError("INVALID_REQUEST", "fixed message"), DIAGNOSTIC);

    expect(providerFailureLogRecord("openai", error)).toEqual({
      level: "warn",
      event: "ai_provider_error",
      provider: "openai",
      code: "INVALID_REQUEST",
      transient: false,
      ...DIAGNOSTIC,
    });
  });

  it("is not written for a cancelled call, which is not a provider failure", () => {
    const aborted = new JarvisError("INTERNAL_ERROR", "Request was aborted", { aborted: true });

    expect(providerFailureLogRecord("openai", aborted)).toBeUndefined();
  });
});

describe("R-31 — the fixed messages", () => {
  it("name no provider, model, URL or key", () => {
    for (const message of Object.values(PROVIDER_ERROR_MESSAGES)) {
      expect(message).not.toMatch(/openai|anthropic|claude|gpt|https?:|sk-|api key/i);
    }
  });
});
