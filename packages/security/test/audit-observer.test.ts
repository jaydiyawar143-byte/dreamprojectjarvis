// ---------------------------------------------------------------------------
// VO-2 — the audit logger's post-write observer.
//
// The observer is how the Virtual Office learns that an audit row exists. Two
// properties matter and each has a failure mode this file pins:
//
//   1. AFTER, NOT BEFORE. The observer must never run when the durable write
//      failed, or the office would announce work that did not happen.
//   2. IT CANNOT BREAK THE WRITE. A throwing or rejecting observer must not
//      turn a successful audit write into a failed request.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AuditEntry, IAuditRepository } from "@jarvis/core";

import { AuditLogger } from "../src/audit.js";

class RecordingRepository implements IAuditRepository {
  readonly created: Array<Omit<AuditEntry, "id" | "timestamp">> = [];
  failNext = false;

  async create(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry> {
    if (this.failNext) throw new Error("database unavailable");
    this.created.push(entry);
    return {
      ...entry,
      id: `audit-${this.created.length}`,
      timestamp: new Date("2026-11-01T10:00:00.000Z"),
    };
  }

  async query(): Promise<AuditEntry[]> {
    return [];
  }
}

const base = {
  userId: "user-alice",
  action: "tool.execute",
  result: "success" as const,
};

let repository: RecordingRepository;

beforeEach(() => {
  repository = new RecordingRepository();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VO-2 — audit observer", () => {
  it("is handed the durable row after the repository write", async () => {
    const seen: AuditEntry[] = [];
    const logger = new AuditLogger(repository, (entry) => {
      // The row must already be durable at this point.
      expect(repository.created).toHaveLength(1);
      seen.push(entry);
    });

    await logger.log(base);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: "audit-1",
      userId: "user-alice",
      action: "tool.execute",
      result: "success",
    });
    expect(seen[0].timestamp).toBeInstanceOf(Date);
  });

  it("is not called when the durable write fails", async () => {
    repository.failNext = true;
    const seen: AuditEntry[] = [];
    const logger = new AuditLogger(repository, (entry) => {
      seen.push(entry);
    });

    await expect(logger.log(base)).rejects.toThrow("database unavailable");
    expect(seen).toHaveLength(0);
  });

  it("cannot fail the write by throwing", async () => {
    const logger = new AuditLogger(repository, () => {
      throw new Error("observer failed");
    });

    await expect(logger.log(base)).resolves.toBeUndefined();
    expect(repository.created).toHaveLength(1);
  });

  it("cannot fail the write by rejecting", async () => {
    const logger = new AuditLogger(repository, async () => {
      throw new Error("observer rejected");
    });

    await expect(logger.log(base)).resolves.toBeUndefined();
    expect(repository.created).toHaveLength(1);
  });

  it("sees the redacted copy, never the raw parameters", async () => {
    let observed: AuditEntry | null = null;
    const logger = new AuditLogger(repository, (entry) => {
      observed = entry;
    });

    await logger.log({
      ...base,
      toolId: "meta.get.campaigns",
      parameters: { accessToken: "EAAB-secret", campaignId: "c-1" },
      metadata: { executionId: "exec-1", password: "hunter2" },
    });

    expect(JSON.stringify(observed)).not.toContain("EAAB-secret");
    expect(JSON.stringify(observed)).not.toContain("hunter2");
    expect(observed).toMatchObject({
      metadata: { executionId: "exec-1" },
    });
  });

  it("works with no observer at all", async () => {
    const logger = new AuditLogger(repository);

    await expect(logger.log(base)).resolves.toBeUndefined();
    expect(repository.created).toHaveLength(1);
  });
});
