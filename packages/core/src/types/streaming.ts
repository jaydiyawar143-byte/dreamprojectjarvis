import { z } from "zod";

export const StreamEventTypeSchema = z.enum([
  "message.start",
  "message.delta",
  "message.stop",
  "tool.call",
  "tool.result",
  "error",
  "done",
]);

export type StreamEventType = z.infer<typeof StreamEventTypeSchema>;

export const StreamChunkSchema = z.object({
  type: StreamEventTypeSchema,
  data: z.record(z.unknown()),
  traceId: z.string().uuid(),
  timestamp: z.string().datetime(),
});

export type StreamChunk = z.infer<typeof StreamChunkSchema>;
