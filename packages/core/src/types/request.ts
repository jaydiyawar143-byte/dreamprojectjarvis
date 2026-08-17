import { z } from "zod";

export const JarvisRequestSchema = z.object({
  message: z.string().min(1, "Message cannot be empty"),
  conversationId: z.string().optional(),
  agentId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  stream: z.boolean().default(false),
});

export type JarvisRequest = z.infer<typeof JarvisRequestSchema>;

export const JarvisResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      message: z.string(),
      conversationId: z.string(),
      agentId: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.unknown()).optional(),
    })
    .optional(),
  traceId: z.string().uuid(),
  timestamp: z.string().datetime(),
});

export type JarvisResponse = z.infer<typeof JarvisResponseSchema>;
