// ---------------------------------------------------------------------------
// The Computer Control page reads a computer's commands — how often.
//
// The page once read them as fast as the API could answer (about 167 times a
// second): the effect that polled depended on the list it set, so every answer
// re-ran it. The earlier page tests never saw it because a mock that resolves
// the SAME array each time lets React skip the re-render; `fetch` never gives
// the same array twice. Every answer here is a fresh array, as from the network.
//
// The rules: read once; read again every two seconds only while a command is
// still on its way to the computer; one read at a time; none while the tab is
// hidden, after the panel is gone, or once the server refuses. lib/api is
// mocked — no network.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

import ComputerControlPage from "../src/app/computer-control/page";
import * as api from "../src/lib/api";
import type { ApiResponse, DesktopCommand, DesktopDevice } from "../src/lib/api";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    listDesktopDevices: vi.fn(),
    listDesktopOrganizations: vi.fn(),
    requestDesktopCommand: vi.fn(),
    confirmDesktopCommand: vi.fn(),
    listDesktopCommands: vi.fn(),
  };
});
const mocked = vi.mocked(api);
const ok = <T,>(data: T): ApiResponse<T> => ({ success: true, data, timestamp: new Date().toISOString() });
const refused = (code: string): ApiResponse<DesktopCommand[]> => ({ success: false, error: { code, message: "refused" }, timestamp: "" });

const DEVICE: DesktopDevice = {
  id: "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c",
  displayName: "WORKSTATION",
  userLabel: "Ada Lovelace",
  organizationLabel: "Analytical Engines",
  status: "active",
  agentVersion: "1.0.0",
  windowsBuild: 26100,
  fingerprint: "3F2A-9C01-77B4-0E1D-AB12-CD34",
  createdAt: new Date().toISOString(),
  confirmedAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  mine: true,
  canRevoke: true,
  grant: { scope: ["desktop.input.key"], durationMinutes: 15, expiresAt: new Date(Date.now() + 900_000).toISOString() },
};

function command(status: DesktopCommand["status"], id = "c1"): DesktopCommand {
  return { id, action: "desktop.input.key", status, requiresHello: false, issuedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), completedAt: null, resultCode: null };
}

/**
 * Every call answers a NEW array, as `fetch` does. Past RUNAWAY reads it stops
 * answering, so a read loop fails its count instead of hanging the run.
 */
const RUNAWAY = 50;
function answering(...rows: DesktopCommand[]) {
  mocked.listDesktopCommands.mockImplementation(() =>
    reads() > RUNAWAY ? new Promise<never>(() => undefined) : Promise.resolve(ok(rows.map((r) => ({ ...r }))))
  );
}

/** A read that answers only when the test says so. */
function held() {
  let answer!: (res: ApiResponse<DesktopCommand[]>) => void;
  mocked.listDesktopCommands.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  return (res: ApiResponse<DesktopCommand[]>) => act(async () => answer(res));
}

const reads = () => mocked.listDesktopCommands.mock.calls.length;
const elapse = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

let visibility: DocumentVisibilityState = "visible";
function show(state: DocumentVisibilityState) {
  visibility = state;
  act(() => void document.dispatchEvent(new Event("visibilitychange")));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  mocked.listDesktopDevices.mockResolvedValue(ok([DEVICE]));
  mocked.listDesktopOrganizations.mockResolvedValue(ok([]));
});

afterEach(() => {
  vi.useRealTimers();
});

async function opened() {
  const view = render(<ComputerControlPage />);
  await screen.findByTestId("command-panel");
  await elapse(0);
  return view;
}

describe("Computer Control — reading a computer's commands", () => {
  it("reads once, and not again, while no command is on its way", async () => {
    answering(command("succeeded"), command("expired", "c2"));
    await opened();
    await elapse(30_000);
    expect(reads()).toBe(1);
  });

  it("reads every two seconds while a command is on its way, and stops once it is done", async () => {
    answering(command("issued"));
    await opened();
    expect(reads()).toBe(1);
    await elapse(1_800);
    expect(reads()).toBe(1);
    await elapse(200);
    expect(reads()).toBe(2);
    await elapse(2_000);
    expect(reads()).toBe(3);

    answering(command("succeeded"));
    await elapse(2_000);
    expect(reads()).toBe(4);
    expect(screen.getByText("Done")).toBeInTheDocument();
    await elapse(30_000);
    expect(reads()).toBe(4);
  });

  it("never starts a read while one is unanswered, and waits two seconds after the answer", async () => {
    answering(command("issued"));
    const answer = held();
    await opened();
    await elapse(20_000);
    expect(reads()).toBe(1);

    await answer(ok([command("delivered")]));
    expect(screen.getByText("On the computer")).toBeInTheDocument();
    expect(reads()).toBe(1);
    await elapse(2_000);
    expect(reads()).toBe(2);
  });

  it("keeps a refresh asked for during a read, and runs it once that read answers", async () => {
    answering();
    const answer = held();
    mocked.requestDesktopCommand.mockResolvedValue(
      ok({ approvalId: "apr-1", action: "desktop.input.key" as const, summary: "Press Enter.", detailLines: [], requiresHello: false, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    );
    mocked.confirmDesktopCommand.mockResolvedValue(ok(command("issued", "c9")));
    await opened();

    fireEvent.click(screen.getByTestId("request-command"));
    fireEvent.click(await screen.findByTestId("approve-command"));
    await elapse(0);
    expect(mocked.confirmDesktopCommand).toHaveBeenCalledTimes(1);
    expect(reads()).toBe(1);

    answering(command("issued", "c9"));
    await answer(ok([]));
    await elapse(0);
    expect(reads()).toBe(2);
    expect(screen.getByText("Waiting for the computer")).toBeInTheDocument();
  });

  it("cancels the scheduled read when an approval reads at once — one loop goes on, never two", async () => {
    answering(command("issued"));
    mocked.requestDesktopCommand.mockResolvedValue(
      ok({ approvalId: "apr-2", action: "desktop.input.key" as const, summary: "Press Enter.", detailLines: [], requiresHello: false, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    );
    mocked.confirmDesktopCommand.mockResolvedValue(ok(command("issued", "c9")));
    await opened();
    await elapse(1_000);
    expect(reads()).toBe(1);

    fireEvent.click(screen.getByTestId("request-command"));
    fireEvent.click(await screen.findByTestId("approve-command"));
    await elapse(0);
    expect(mocked.confirmDesktopCommand).toHaveBeenCalledTimes(1);
    expect(reads()).toBe(2);

    // A second on is when the read scheduled before the approval was due.
    await elapse(1_000);
    expect(reads()).toBe(2);
    await elapse(1_000);
    expect(reads()).toBe(3);
    await elapse(10_000);
    expect(reads()).toBe(8);
  });

  it("reads nothing after the panel is gone, even when a read answers late", async () => {
    answering(command("issued"));
    const answer = held();
    const view = await opened();
    view.unmount();
    await answer(ok([command("issued")]));
    await elapse(30_000);
    expect(reads()).toBe(1);
  });

  it("stops its timer when the panel is gone", async () => {
    answering(command("issued"));
    const view = await opened();
    expect(reads()).toBe(1);
    view.unmount();
    await elapse(30_000);
    expect(reads()).toBe(1);
  });

  it("removes its tab listener when the panel is gone — no tab switch or late answer reads again", async () => {
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    answering(command("issued"));
    const view = await opened();
    const listeners = added.mock.calls.filter(([type]) => type === "visibilitychange").map(([, listener]) => listener);
    expect(listeners).toHaveLength(1);

    const answer = held();
    await elapse(2_000);
    expect(reads()).toBe(2);
    view.unmount();
    expect(removed).toHaveBeenCalledWith("visibilitychange", listeners[0]);

    // Acting on this answer would schedule the next read.
    await answer(ok([command("issued")]));
    show("hidden");
    show("visible");
    await elapse(30_000);
    expect(reads()).toBe(2);

    added.mockRestore();
    removed.mockRestore();
  });

  it("reads nothing while the tab is hidden, and reads at once when it is shown again", async () => {
    answering(command("issued"));
    await opened();
    show("hidden");
    await elapse(30_000);
    expect(reads()).toBe(1);

    show("visible");
    await elapse(0);
    expect(reads()).toBe(2);
    await elapse(2_000);
    expect(reads()).toBe(3);
  });

  it("schedules nothing for a read that answers while the tab is hidden", async () => {
    answering(command("issued"));
    await opened();
    const answer = held();
    await elapse(2_000);
    expect(reads()).toBe(2);
    show("hidden");
    await answer(ok([command("issued")]));
    await elapse(30_000);
    expect(reads()).toBe(2);
  });

  it("stops when the server refuses — the computer was revoked or control switched off", async () => {
    answering(command("issued"));
    await opened();
    mocked.listDesktopCommands.mockResolvedValue(refused("NOT_FOUND"));
    await elapse(2_000);
    expect(reads()).toBe(2);
    await elapse(30_000);
    expect(reads()).toBe(2);
  });

  it("keeps its two-second pace through a dropped connection while a command is on its way", async () => {
    answering(command("issued"));
    await opened();
    mocked.listDesktopCommands.mockResolvedValue(refused("NETWORK_ERROR"));
    await elapse(10_000);
    expect(reads()).toBe(6);
  });
});
