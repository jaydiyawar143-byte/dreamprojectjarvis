import type { IAIProvider, AICompletionResponse } from "@jarvis/core";
import { JarvisError } from "@jarvis/core";

// ---------------------------------------------------------------------------
// R-21 — the chat provider for a server that has no OpenAI key.
//
// The composition root used to construct OpenAIAdapter unconditionally, and its
// constructor throws without a key, so a development server without one never
// opened its port — health checks and every non-AI route included. This stands
// in for the adapter instead: the API starts, and each conversation gets an
// answer the user can act on.
//
// Production never reaches it: `checkProductionConfig` refuses to start a
// production process without the key.
//
// It creates no SDK client and makes no network call. The message is shown to
// every signed-in user, so it names neither the environment variable nor any
// key; the startup log names the variable for the operator.
// ---------------------------------------------------------------------------

const NOT_CONFIGURED_MESSAGE =
  "AI chat is not configured on this server. An administrator needs to set the OpenAI API key and restart the API.";

export class NotConfiguredAIProvider implements IAIProvider {
  readonly id = "openai";
  readonly name = "OpenAI (not configured)";
  readonly defaultModel = process.env.OPENAI_DEFAULT_MODEL || "gpt-4o";

  async complete(): Promise<AICompletionResponse> {
    throw new JarvisError("AI_PROVIDER_NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE);
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}
