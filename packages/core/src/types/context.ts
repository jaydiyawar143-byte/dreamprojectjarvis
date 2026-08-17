import { z } from "zod";
import { RoleZodSchema } from "./common.js";

export const AuthContextSchema = z.object({
  userId: z.string(),
  role: RoleZodSchema,
  email: z.string().email(),
});

export type AuthContext = z.infer<typeof AuthContextSchema>;

export const TraceContextSchema = z.object({
  traceId: z.string().uuid(),
  spanId: z.string().uuid().optional(),
  parentSpanId: z.string().uuid().optional(),
});

export type TraceContext = z.infer<typeof TraceContextSchema>;

export const SessionContextSchema = z.object({
  auth: AuthContextSchema,
  conversationId: z.string().optional(),
  agentId: z.string().optional(),
  traceId: z.string().uuid(),
  ipAddress: z.string().optional(),
});

export type SessionContext = z.infer<typeof SessionContextSchema>;
