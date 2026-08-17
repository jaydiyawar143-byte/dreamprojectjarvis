import { z } from "zod";

export const AgentCategorySchema = z.enum([
  "communication",
  "marketing",
  "advertising",
  "research",
  "content",
  "productivity",
  "technical",
  "knowledge",
  "ai-core",
]);

export type AgentCategory = z.infer<typeof AgentCategorySchema>;

export const AgentStatusSchema = z.enum([
  "idle",
  "initializing",
  "ready",
  "processing",
  "error",
  "disabled",
]);

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentConfigSchema = z.object({
  model: z.string().default("gpt-4"),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().positive().default(4096),
  systemPrompt: z.string().optional(),
  customSettings: z.record(z.unknown()).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AgentInputSchema = z.object({
  message: z.string(),
  conversationId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type AgentInput = z.infer<typeof AgentInputSchema>;

export const AgentOutputSchema = z.object({
  message: z.string(),
  actions: z
    .array(
      z.object({
        toolId: z.string(),
        params: z.record(z.unknown()),
      })
    )
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;

export interface AgentContext {
  userId: string;
  conversationId?: string;
  memoryManager: unknown;
  toolRegistry: unknown;
  auditLogger: unknown;
}

export interface IAgent {
  id: string;
  name: string;
  description: string;
  category: AgentCategory;
  tools: string[];
  config: AgentConfig;

  initialize(context: AgentContext): Promise<void>;
  process(input: AgentInput): Promise<AgentOutput>;
  getStatus(): AgentStatus;
  shutdown(): Promise<void>;
}
