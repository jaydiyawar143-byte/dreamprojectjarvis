export type EventType =
  | "agent:message"
  | "agent:status"
  | "approval:pending"
  | "approval:resolved"
  | "notification:new"
  | "system:health";

export interface WebSocketEvent<T = unknown> {
  type: EventType;
  payload: T;
  timestamp: string;
}

export interface AgentMessageEvent {
  agentId: string;
  conversationId: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalEvent {
  approvalId: string;
  toolId: string;
  agentId: string;
  userId: string;
  params: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
}
