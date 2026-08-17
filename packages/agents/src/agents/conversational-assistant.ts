import OpenAI from "openai";
import { BaseAgent } from "../base-agent.js";
import type { AgentInput, AgentOutput } from "@jarvis/core";

export class ConversationalAssistant extends BaseAgent {
  private openai: OpenAI;

  constructor(apiKey: string) {
    super(
      "conversational-assistant",
      "JARVIS Assistant",
      "Core AI conversational assistant for general questions and tasks",
      "ai-core",
      [],
      {
        model: "gpt-4",
        temperature: 0.7,
        systemPrompt: `You are JARVIS, a personal AI operating system. You are helpful, concise, and professional. You assist with marketing, business operations, and general tasks.`,
      }
    );
    this.openai = new OpenAI({ apiKey });
  }

  async process(input: AgentInput): Promise<AgentOutput> {
    this.status = "processing";

    try {
      const completion = await this.openai.chat.completions.create({
        model: this.config.model,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        messages: [
          { role: "system", content: this.config.systemPrompt || "" },
          { role: "user", content: input.message },
        ],
      });

      const message =
        completion.choices[0]?.message?.content || "No response generated.";

      this.status = "ready";

      return { message };
    } catch (error) {
      this.status = "error";
      throw error;
    }
  }
}
