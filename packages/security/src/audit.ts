import type { AuditEntry, AuditQueryFilters, IAuditRepository } from "@jarvis/core";

export class AuditLogger {
  constructor(private repository: IAuditRepository) {}

  async log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void> {
    const fullEntry = await this.repository.create(entry);
    console.log("[AUDIT]", fullEntry.action, fullEntry.result, fullEntry.id);
  }

  async query(filters: AuditQueryFilters): Promise<AuditEntry[]> {
    return this.repository.query(filters);
  }
}
