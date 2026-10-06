// Phase 13 — the confirmation rules, over a store.
//
// A confirmation used to live in a Map inside one process. It now lives in a
// store every API instance shares, so these rules are stated against the store
// contract: what is written, what a token is worth, and what is never kept.
// The store here is an in-memory double; the same rules are proven against
// PostgreSQL, with real concurrency, in `confirmation-durable-pg.integration`.
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { IConfirmationRepository, IntegrationId } from "@jarvis/core";
import {
  CONFIRMATION_RETENTION_MS,
  CONFIRMATION_TTL_MS,
  createConfirmationService,
  hashConfirmationToken,
} from "../src/services/integrations/confirmations.js";
import { createOperationalLog } from "../src/services/observability/operational-log.js";
import { memoryConfirmationStore } from "./helpers/memory-confirmation-store.js";

const START = new Date("2026-10-06T08:00:00.000Z");

const PAUSE = {
  userId: "user-1",
  integration: "meta" as IntegrationId,
  actionId: "meta.campaign.pause",
  params: { campaignId: "campaign-A", note: "phone +91 98765 43210" },
};

function setup(overrides: Partial<IConfirmationRepository> = {}) {
  const { store, rows } = memoryConfirmationStore();
  let current = START;
  const lines: string[] = [];
  const service = createConfirmationService(
    { ...store, ...overrides },
    {
      now: () => current,
      log: createOperationalLog({ service: "jarvis-api", write: (line) => lines.push(line) }),
    }
  );
  return {
    service,
    store,
    rows,
    lines,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    issue: () =>
      service.issue({ ...PAUSE, summary: "Pause a campaign on Meta (campaignId=campaign-A)", irreversible: true }),
  };
}

describe("issuing a confirmation", () => {
  it("describes the write and gives a token that is good for two minutes", async () => {
    const { issue } = setup();
    const confirmation = await issue();

    expect(confirmation).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      summary: "Pause a campaign on Meta (campaignId=campaign-A)",
      integration: "meta",
      actionId: "meta.campaign.pause",
      expiresAt: new Date(START.getTime() + CONFIRMATION_TTL_MS).toISOString(),
      irreversible: true,
    });
    expect(CONFIRMATION_TTL_MS).toBe(2 * 60 * 1000);
  });

  it("gives a different token every time", async () => {
    const { issue } = setup();
    expect((await issue()).token).not.toBe((await issue()).token);
  });

  it("stores a hash of the token — never the token, the parameters or the summary", async () => {
    const { issue, rows } = setup();
    const { token } = await issue();

    const stored = [...rows.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: "user-1",
      integration: "meta",
      actionId: "meta.campaign.pause",
      expiresAt: new Date(START.getTime() + CONFIRMATION_TTL_MS),
      consumedAt: null,
    });
    expect(hashConfirmationToken(token)).toBe(stored[0]!.tokenHash);

    const everything = JSON.stringify(stored);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("campaign-A");
    expect(everything).not.toContain("98765");
    expect(everything).not.toContain("Pause a campaign");
  });

  it("clears out what expired longer ago than the retention, and nothing newer", async () => {
    const { issue, rows, advance } = setup();
    const firstExpiry = START.getTime() + CONFIRMATION_TTL_MS;
    const expiries = () => [...rows.values()].map((row) => row.expiresAt.getTime());

    await issue();
    // One millisecond short of the first one's retention running out.
    advance(CONFIRMATION_TTL_MS + CONFIRMATION_RETENTION_MS - 1);
    await issue();
    expect(expiries()).toContain(firstExpiry);
    expect(rows.size).toBe(2);

    advance(2);
    await issue();
    expect(expiries()).not.toContain(firstExpiry);
    expect(rows.size).toBe(2);
  });

  it("still issues when that clear-out fails", async () => {
    const { issue } = setup({
      deleteExpiredBefore: async () => {
        throw new Error("lock timeout");
      },
    });
    await expect(issue()).resolves.toMatchObject({ actionId: "meta.campaign.pause" });
  });

  it("hands out no token when the confirmation cannot be saved", async () => {
    const { issue, lines } = setup({
      create: async () => {
        throw new Error("database is unreachable");
      },
    });

    // It rejects: the command service refuses the write and reports the error.
    await expect(issue()).rejects.toThrow("database is unreachable");
    expect(lines.join(" ")).not.toContain("confirmation_issued");
  });
});

describe("consuming a confirmation", () => {
  it("accepts the token for exactly the write that was described", async () => {
    const { service, issue, rows } = setup();
    const { token } = await issue();

    await expect(service.consume({ ...PAUSE, token })).resolves.toEqual({ ok: true });
    expect([...rows.values()][0]!.consumedAt).toEqual(START);
  });

  it("is single use: the same token a second time is refused", async () => {
    const { service, issue } = setup();
    const { token } = await issue();

    expect(await service.consume({ ...PAUSE, token })).toEqual({ ok: true });
    expect(await service.consume({ ...PAUSE, token })).toEqual({ ok: false, reason: "unknown" });
  });

  it("refuses a token it never issued", async () => {
    const { service } = setup();
    expect(await service.consume({ ...PAUSE, token: "made-up" })).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("refuses an expired token, at the expiry instant and after it", async () => {
    const first = setup();
    const a = await first.issue();
    first.advance(CONFIRMATION_TTL_MS);
    expect(await first.service.consume({ ...PAUSE, token: a.token })).toEqual({
      ok: false,
      reason: "expired",
    });

    const second = setup();
    const b = await second.issue();
    second.advance(CONFIRMATION_TTL_MS - 1);
    expect(await second.service.consume({ ...PAUSE, token: b.token })).toEqual({ ok: true });
  });

  it.each([
    ["another user", { userId: "user-2" }],
    ["another integration", { integration: "whatsapp" as IntegrationId }],
    ["another action", { actionId: "meta.campaign.budget.update" }],
    ["other parameters", { params: { campaignId: "campaign-B", note: "phone +91 98765 43210" } }],
  ])("refuses a token presented for %s", async (_what, change) => {
    const { service, issue } = setup();
    const { token } = await issue();

    expect(await service.consume({ ...PAUSE, ...change, token })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("is spent by a misuse: the right call afterwards is refused too", async () => {
    const { service, issue } = setup();
    const { token } = await issue();

    await service.consume({ ...PAUSE, params: { campaignId: "campaign-B" }, token });
    expect(await service.consume({ ...PAUSE, token })).toEqual({ ok: false, reason: "unknown" });
  });

  it("lets exactly one of many simultaneous attempts through", async () => {
    const { service, issue } = setup();
    const { token } = await issue();

    const outcomes = await Promise.all(
      Array.from({ length: 25 }, () => service.consume({ ...PAUSE, token }))
    );

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(24);
  });

  it("does not answer when the store cannot be asked — the caller must fail closed", async () => {
    const { service, issue, lines } = setup({
      consume: async () => {
        throw new Error("connection reset");
      },
    });
    const { token } = await issue();

    await expect(service.consume({ ...PAUSE, token })).rejects.toThrow("connection reset");
    // Neither verdict was written: it did not decide.
    expect(lines.join(" ")).not.toMatch(/confirmation_consumed|confirmation_refused/);
  });
});

describe("what a confirmation writes to the log", () => {
  it("records each step by id, never by token, parameter or summary", async () => {
    const { service, issue, lines } = setup();
    const { token } = await service.issue({
      ...PAUSE,
      summary: "Pause a campaign on Meta (campaignId=campaign-A)",
      irreversible: true,
      traceId: "trace-7",
    });
    await service.consume({ ...PAUSE, token, traceId: "trace-8" });
    await service.consume({ ...PAUSE, token, traceId: "trace-9" });
    const other = await issue();
    await service.consume({ ...PAUSE, userId: "user-2", token: other.token });

    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => [event.level, event.event, event.reason])).toEqual([
      ["info", "confirmation_issued", undefined],
      ["info", "confirmation_consumed", undefined],
      ["warn", "confirmation_refused", "unknown"],
      ["info", "confirmation_issued", undefined],
      ["warn", "confirmation_refused", "mismatch"],
    ]);
    expect(events[0]).toMatchObject({
      component: "confirmations",
      confirmationId: "confirmation-1",
      userId: "user-1",
      integration: "meta",
      actionId: "meta.campaign.pause",
      traceId: "trace-7",
    });
    expect(events[1]).toMatchObject({ confirmationId: "confirmation-1", traceId: "trace-8" });

    const everything = lines.join("\n");
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(other.token);
    expect(everything).not.toContain(hashConfirmationToken(token));
    expect(everything).not.toContain("campaign-A");
    expect(everything).not.toContain("98765");
    expect(everything).not.toContain("Pause a campaign");
  });

  it("works without a log", async () => {
    const { store } = memoryConfirmationStore();
    const service = createConfirmationService(store);
    const { token } = await service.issue({ ...PAUSE, summary: "s", irreversible: true });
    expect(await service.consume({ ...PAUSE, token })).toEqual({ ok: true });
  });
});
