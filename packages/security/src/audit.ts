import type { AuditEntry } from "@jarvis/core";

export class AuditLogger {
  private logs: AuditEntry[] = [];

  async log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void> {
    const fullEntry: AuditEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };

    this.logs.push(fullEntry);

    // In production, persist to database
    console.log("[AUDIT]", JSON.stringify(fullEntry));
  }

  async query(filters: {
    userId?: string;
    agentId?: string;
    toolId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<AuditEntry[]> {
    return this.logs.filter((log) => {
      if (filters.userId && log.userId !== filters.userId) return false;
      if (filters.agentId && log.agentId !== filters.agentId) return false;
      if (filters.toolId && log.toolId !== filters.toolId) return false;
      if (filters.startDate && log.timestamp < filters.startDate) return false;
      if (filters.endDate && log.timestamp > filters.endDate) return false;
      return true;
    });
  }
}

export const auditLogger = new AuditLogger();
