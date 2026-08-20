/**
 * @deprecated This interface is superseded by IMemoryStore from ./memory.js.
 * Kept for backward compatibility. New code should use IMemoryStore.
 */

export interface MemoryStoreRequest {
  conversationId: string;
  content: string;
  role?: "user" | "assistant" | "system";
  metadata?: Record<string, unknown>;
}

export interface MemoryRecallRequest {
  conversationId: string;
  query: string;
  limit?: number;
}

export interface MemoryEntry {
  id: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface IMemoryProvider {
  readonly id: string;
  readonly name: string;

  store(request: MemoryStoreRequest): Promise<void>;
  recall(request: MemoryRecallRequest): Promise<MemoryEntry[]>;
  delete(conversationId: string, entryIds?: string[]): Promise<void>;
  isAvailable(): Promise<boolean>;
}
