// S8.6 — a scripted OpenAI upstream for driving the REAL General Assistant.
//
// The container's real OpenAIAdapter is pointed here through OPENAI_BASE_URL
// (as agent-recovery-after-provider-failure.test.ts does), so the model-facing
// tool definitions, the tool-call round trip and the tool-result envelope are
// exactly what OpenAI itself would receive. Every request body is kept, so a
// test can read what the model was shown.
//
// The script: a request that offers tools and carries no tool result gets the
// queued tool call; a request carrying a tool result gets a final answer built
// from it; anything else gets a plain reply. Embeddings answer with a zero
// vector. Nothing here reaches a network.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>;
}

export interface ScriptedOpenAI {
  baseURL: string;
  /** Every chat request, in order. */
  chats: ChatRequest[];
  /** The next answer to a tool-offering request: this tool, these arguments. */
  callTool(name: string, args: Record<string, unknown>): void;
  close(): Promise<void>;
}

const completion = (message: Record<string, unknown>, finishReason: string) => ({
  id: "chatcmpl-s8-6",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

/** The model's final answer: it repeats what the tool result said, or that there was none. */
export function finalAnswer(toolResult: string): string {
  const days = /(-?\d+) days from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(toolResult);
  if (days) return `There are ${days[1]} days from ${days[2]} to ${days[3]}.`;
  const weekday = /(\d{4}-\d{2}-\d{2}) is a (\w+day)/.exec(toolResult);
  if (weekday) return `${weekday[1]} is a ${weekday[2]}.`;
  const converted = /(-?[\d.]+) (\w+) is (-?[\d.]+) (\w+)\./.exec(toolResult);
  if (converted) return `${converted[1]} ${converted[2]} is ${converted[3]} ${converted[4]}.`;
  return "I could not get that answer from the dates tool.";
}

export async function startScriptedOpenAI(): Promise<ScriptedOpenAI> {
  const chats: ChatRequest[] = [];
  let next: { name: string; args: Record<string, unknown> } | null = null;

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const send = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify(payload));
      };
      if (req.url?.endsWith("/embeddings")) {
        return send({ object: "list", data: [{ object: "embedding", index: 0, embedding: new Array(1536).fill(0) }], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } });
      }
      // Anything that is not a chat completion — the SDK's availability check
      // lists models — gets a model list.
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        return send({ object: "list", data: [{ id: "gpt-4o-mini", object: "model", created: 1, owned_by: "s8-6" }] });
      }
      const chat = JSON.parse(body) as ChatRequest;
      chats.push(chat);
      const results = chat.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");
      if (results.length > 0) return send(completion({ content: finalAnswer(results.join("\n")) }, "stop"));
      // Called whenever tools are offered at all — offered or not, as a model
      // that names a tool it was never given would.
      if (next && chat.tools && chat.tools.length > 0) {
        const call = next;
        next = null;
        return send(
          completion(
            {
              content: null,
              tool_calls: [{ id: "call_s8_6", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }],
            },
            "tool_calls"
          )
        );
      }
      return send(completion({ content: "OK." }, "stop"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    chats,
    callTool(name, args) {
      next = { name, args };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
