// ---------------------------------------------------------------------------
// Phase 19.6 — the Computer Control page.
//
// What the page must never do as much as what it does: it never offers to
// start control (consent happens on the computer), never implies it can see
// the screen (D4), never lets a fingerprint be confirmed without the person
// typing what the computer shows, and says Windows Hello will be asked before
// anything is typed. When the server has desktop control off, it says so and
// draws no control. lib/api is mocked — no network.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import ComputerControlPage from "../src/app/computer-control/page";
import * as api from "../src/lib/api";
import type { DesktopDevice } from "../src/lib/api";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    listDesktopDevices: vi.fn(),
    listDesktopOrganizations: vi.fn(),
    createDesktopPairingCode: vi.fn(),
    confirmDesktopDevice: vi.fn(),
    revokeDesktopDevice: vi.fn(),
    endDesktopSession: vi.fn(),
    requestDesktopCommand: vi.fn(),
    confirmDesktopCommand: vi.fn(),
    listDesktopCommands: vi.fn(),
  };
});
const mocked = vi.mocked(api);
const ok = <T,>(data: T) => ({ success: true, data, timestamp: new Date().toISOString() });
const refused = (code: string, message: string) => ({ success: false, error: { code, message }, timestamp: "" });
const ONE = { id: "org-1", name: "Analytical Engines" };
const TWO = { id: "org-2", name: "Difference Engines" };
const PAIRING = { code: "7K3M-Q9X2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01", expiresAt: new Date(Date.now() + 600_000).toISOString(), organizationId: "org-1", serverKeyId: "2c69a77366fe3e5b" };

function device(overrides: Partial<DesktopDevice> = {}): DesktopDevice {
  return {
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
    grant: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listDesktopCommands.mockResolvedValue(ok([]));
  mocked.listDesktopOrganizations.mockResolvedValue(ok([ONE]));
});

describe("Phase 19.6 — Computer Control page", () => {
  it("says desktop control is off when the server has no such routes, and draws no control", async () => {
    mocked.listDesktopDevices.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: "Route not found" }, timestamp: "" });
    render(<ComputerControlPage />);
    expect(await screen.findByText("Desktop control is switched off")).toBeInTheDocument();
    expect(screen.queryByTestId("generate-pairing-code")).toBeNull();
    expect(mocked.listDesktopOrganizations).not.toHaveBeenCalled();
  });

  it("confirms a pending computer only with the fingerprint the person typed", async () => {
    mocked.listDesktopDevices.mockResolvedValue(ok([device({ status: "pending", confirmedAt: null })]));
    mocked.confirmDesktopDevice.mockResolvedValue(ok(device()));
    render(<ComputerControlPage />);
    const button = await screen.findByTestId("confirm-fingerprint");
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Fingerprint shown on the computer"), { target: { value: "3F2A-9C01-77B4-0E1D-AB12-CD34" } });
    fireEvent.click(button);
    await waitFor(() => expect(mocked.confirmDesktopDevice).toHaveBeenCalledWith(device().id, "3F2A-9C01-77B4-0E1D-AB12-CD34"));
  });

  it("offers no way to start control — only to see it is not allowed", async () => {
    mocked.listDesktopDevices.mockResolvedValue(ok([device()]));
    render(<ComputerControlPage />);
    expect(await screen.findByText(/can only be allowed on the computer itself/)).toBeInTheDocument();
    expect(screen.queryByTestId("command-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: /allow|start/i })).toBeNull();
  });

  it("asks for typing as an approval, says Windows Hello comes next, and never shows the text back", async () => {
    mocked.listDesktopDevices.mockResolvedValue(
      ok([device({ grant: { scope: ["desktop.input.type", "desktop.input.click"], durationMinutes: 15, expiresAt: new Date(Date.now() + 900_000).toISOString() } })])
    );
    mocked.requestDesktopCommand.mockResolvedValue(
      ok({
        approvalId: "apr-00000001",
        action: "desktop.input.type" as const,
        summary: "Type into the focused window on the paired Windows desktop.",
        detailLines: [{ label: "Characters", value: "13" }, { label: "Text", value: "not shown" }],
        requiresHello: true,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      })
    );
    mocked.confirmDesktopCommand.mockResolvedValue(
      ok({ id: "c1", action: "desktop.input.type", status: "issued" as const, requiresHello: true, issuedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), completedAt: null, resultCode: null })
    );
    render(<ComputerControlPage />);
    const field = (await screen.findByLabelText("Text to type")) as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "hunter2-TYPED" } });
    fireEvent.click(screen.getByTestId("request-command"));
    expect(await screen.findByTestId("hello-notice")).toHaveTextContent("Windows Hello");
    expect(document.body.textContent).not.toContain("hunter2-TYPED");
    fireEvent.click(screen.getByTestId("approve-command"));
    await waitFor(() => expect(mocked.confirmDesktopCommand).toHaveBeenCalledWith(device().id, "apr-00000001"));
  });

  it("shows the pairing code once, with the server key the computer must show too", async () => {
    mocked.listDesktopDevices.mockResolvedValue(ok([]));
    mocked.createDesktopPairingCode.mockResolvedValue(ok(PAIRING));
    render(<ComputerControlPage />);
    fireEvent.click(await screen.findByTestId("generate-pairing-code"));
    const shown = await screen.findByTestId("pairing-code");
    expect(shown).toHaveTextContent("7K3M-Q9X2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01");
    expect(shown).toHaveTextContent("2c69a77366fe3e5b");
  });

  it("names the one Organization a person administers, and pairs with it", async () => {
    mocked.listDesktopDevices.mockResolvedValue(ok([]));
    mocked.createDesktopPairingCode.mockResolvedValue(ok(PAIRING));
    render(<ComputerControlPage />);
    expect(await screen.findByTestId("pairing-organization")).toHaveTextContent("Analytical Engines");
    expect(screen.queryByLabelText("Organization")).toBeNull();
    fireEvent.click(screen.getByTestId("generate-pairing-code"));
    await waitFor(() => expect(mocked.createDesktopPairingCode).toHaveBeenCalledWith("org-1"));
  });

  it("makes someone who administers several choose before a code can be generated", async () => {
    mocked.listDesktopDevices.mockResolvedValue(ok([]));
    mocked.listDesktopOrganizations.mockResolvedValue(ok([ONE, TWO]));
    mocked.createDesktopPairingCode.mockResolvedValue(ok({ ...PAIRING, organizationId: "org-2" }));
    render(<ComputerControlPage />);
    const button = await screen.findByTestId("generate-pairing-code");
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "org-2" } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(mocked.createDesktopPairingCode).toHaveBeenCalledWith("org-2"));
  });

  it("draws no pairing control for someone who administers nothing, and says who can pair", async () => {
    mocked.listDesktopDevices.mockResolvedValue(ok([]));
    mocked.listDesktopOrganizations.mockResolvedValue(ok([]));
    render(<ComputerControlPage />);
    expect(await screen.findByText(/Only an owner or admin of an Organization can pair/)).toBeInTheDocument();
    expect(screen.queryByTestId("generate-pairing-code")).toBeNull();
    expect(screen.queryByLabelText("Organization")).toBeNull();
  });

  it("offers to retry when the Organizations cannot be read, and draws no pairing control", async () => {
    mocked.listDesktopDevices.mockResolvedValue(ok([]));
    mocked.listDesktopOrganizations.mockResolvedValueOnce(refused("UNAVAILABLE", "Desktop control is not available right now; nothing was done."));
    render(<ComputerControlPage />);
    const retry = await screen.findByTestId("error-retry");
    expect(screen.queryByTestId("generate-pairing-code")).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByTestId("generate-pairing-code")).toBeEnabled();
    expect(mocked.listDesktopOrganizations).toHaveBeenCalledTimes(2);
  });

  it("catches up when the server refuses: the message stays and the choice goes", async () => {
    mocked.listDesktopDevices.mockResolvedValue(ok([]));
    mocked.listDesktopOrganizations.mockResolvedValueOnce(ok([ONE])).mockResolvedValue(ok([]));
    mocked.createDesktopPairingCode.mockResolvedValue(refused("NOT_AUTHORIZED", "You are not allowed to do this."));
    render(<ComputerControlPage />);
    fireEvent.click(await screen.findByTestId("generate-pairing-code"));
    expect(await screen.findByText("You are not allowed to do this.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("generate-pairing-code")).toBeNull());
    expect(screen.getByText("You are not allowed to do this.")).toBeInTheDocument();
  });

  it("says click positions count from the top-left corner of the whole desktop", async () => {
    mocked.listDesktopDevices.mockResolvedValue(
      ok([device({ grant: { scope: ["desktop.input.click"], durationMinutes: 15, expiresAt: new Date(Date.now() + 900_000).toISOString() } })])
    );
    render(<ComputerControlPage />);
    expect(await screen.findByTestId("command-panel")).toHaveTextContent(/top-left corner of that computer's whole desktop/);
  });

  it("revokes only after a second, explicit step", async () => {
    mocked.listDesktopDevices.mockResolvedValue(ok([device()]));
    mocked.revokeDesktopDevice.mockResolvedValue(ok(null));
    render(<ComputerControlPage />);
    fireEvent.click(await screen.findByTestId("revoke"));
    expect(mocked.revokeDesktopDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-revoke"));
    await waitFor(() => expect(mocked.revokeDesktopDevice).toHaveBeenCalledWith(device().id));
  });

  it("never implies it can see the screen", async () => {
    mocked.listDesktopDevices.mockResolvedValue(
      ok([device({ grant: { scope: ["desktop.input.click"], durationMinutes: 15, expiresAt: new Date(Date.now() + 900_000).toISOString() } })])
    );
    render(<ComputerControlPage />);
    await screen.findByTestId("command-panel");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/screenshot|view (the )?screen|live view|screen share|see the screen now/i);
    expect(screen.queryByRole("button", { name: /screen/i })).toBeNull();
    expect(text).toMatch(/cannot see/i);
  });
});
