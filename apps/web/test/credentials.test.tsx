// ---------------------------------------------------------------------------
// UI V2 — Agent Credential Center.
//
// These assert the properties that make the feature safe rather than merely
// functional:
//
//   * a stored secret is never rendered, and cannot be revealed;
//   * nothing secret is written to browser storage;
//   * "Connected" comes only from a real test call, never from saving;
//   * providers the backend cannot accept credentials for get no form.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/settings/connections",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    listCredentials: vi.fn(),
    saveCredentials: vi.fn(),
    testCredentials: vi.fn(),
    removeCredentials: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import ConnectionsPage from "../src/app/settings/connections/page";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();

/** The mask the server sends in place of a stored secret. */
const MASK = "••••••••••••";

const metaProvider = (over: Partial<api.CredentialProvider> = {}): api.CredentialProvider => ({
  id: "meta",
  label: "Meta Ads",
  kind: "form",
  description: "Marketing API access.",
  testable: true,
  fields: [
    { name: "accessToken", label: "Access Token", kind: "secret", required: true },
    { name: "adAccountId", label: "Ad Account ID", kind: "text", required: true },
  ],
  status: "CONFIGURED",
  detail: "Stored and encrypted.",
  effectiveSource: "stored (applies at next service restart)",
  // The server sends a MASK for the secret and the real value for the id.
  values: { accessToken: MASK, adAccountId: "act_999" },
  ...over,
});

const serverManaged = (): api.CredentialProvider => ({
  id: "n8n",
  label: "n8n Automations",
  kind: "server-managed",
  description: "Configured from server environment.",
  testable: false,
  fields: [],
  status: "CONFIGURATION_REQUIRED",
  detail: "Not configured on the server.",
  effectiveSource: "server environment",
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  mocked.listCredentials.mockResolvedValue({
    success: true,
    data: { providers: [metaProvider(), serverManaged()] },
    timestamp: ts(),
  } as never);
});

describe("credential center", () => {
  it("never renders a stored secret, only a mask", async () => {
    render(<ConnectionsPage />);

    const token = (await screen.findByTestId("credential-input-accessToken")) as HTMLInputElement;

    // The box is EMPTY — the mask is a placeholder, not a value. A real token
    // would be neither, because the server never sends one.
    expect(token.value).toBe("");
    expect(token.type).toBe("password");
    expect(token.placeholder).toContain("stored");

    // The non-secret account id may be shown, so the operator can see which
    // account is configured without retyping it.
    const account = screen.getByTestId("credential-input-adAccountId") as HTMLInputElement;
    expect(account.placeholder).toBe("act_999");
  });

  it("cannot reveal a secret it does not have", async () => {
    render(<ConnectionsPage />);
    await screen.findByTestId("credential-input-accessToken");

    // Show/Hide is disabled while the box is empty: there is nothing to show,
    // and enabling it would imply the stored secret could be recovered.
    const toggle = screen.getByRole("button", { name: /show access token/i });
    expect(toggle).toBeDisabled();

    fireEvent.change(screen.getByTestId("credential-input-accessToken"), {
      target: { value: "typed-secret" },
    });
    expect(toggle).toBeEnabled();

    // It reveals only what was just typed.
    fireEvent.click(toggle);
    const token = screen.getByTestId("credential-input-accessToken") as HTMLInputElement;
    expect(token.type).toBe("text");
    expect(token.value).toBe("typed-secret");
  });

  it("writes no credential to browser storage when saving", async () => {
    mocked.saveCredentials.mockResolvedValue({
      success: true,
      data: metaProvider({ status: "CONFIGURED" }),
      timestamp: ts(),
    } as never);

    render(<ConnectionsPage />);
    await screen.findByTestId("credential-input-accessToken");

    fireEvent.change(screen.getByTestId("credential-input-accessToken"), {
      target: { value: "super-secret-token" },
    });
    fireEvent.click(screen.getByText("Save configuration"));

    await waitFor(() => expect(mocked.saveCredentials).toHaveBeenCalled());

    // The secret went to the server and nowhere else.
    const everything = [
      ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)),
      ...Object.keys(localStorage).map((k) => localStorage.getItem(k)),
    ].join("|");
    expect(everything).not.toContain("super-secret-token");
  });

  it("saving does not claim a connection — only a passing test does", async () => {
    mocked.saveCredentials.mockResolvedValue({
      success: true,
      data: metaProvider({ status: "CONFIGURED", detail: "Stored and encrypted." }),
      timestamp: ts(),
    } as never);

    render(<ConnectionsPage />);
    await screen.findByTestId("credential-input-accessToken");

    fireEvent.change(screen.getByTestId("credential-input-accessToken"), {
      target: { value: "tok" },
    });
    fireEvent.click(screen.getByText("Save configuration"));

    // Saved, but explicitly NOT connected.
    await waitFor(() => expect(screen.getByTestId("credential-status-CONFIGURED")).toBeInTheDocument());
    expect(screen.queryByTestId("credential-status-CONNECTED")).toBeNull();

    // Now a real test call comes back green.
    mocked.testCredentials.mockResolvedValue({
      success: true,
      data: { status: "CONNECTED", detail: "Verified against the Meta Graph API.", checkedAt: ts() },
      timestamp: ts(),
    } as never);

    fireEvent.click(screen.getByTestId("credential-test"));
    await waitFor(() => expect(screen.getByTestId("credential-status-CONNECTED")).toBeInTheDocument());
  });

  it("shows a failing test as invalid, with the provider's own reason", async () => {
    mocked.testCredentials.mockResolvedValue({
      success: true,
      data: {
        status: "INVALID",
        detail: "Invalid OAuth access token - Cannot parse access token",
        checkedAt: ts(),
      },
      timestamp: ts(),
    } as never);

    render(<ConnectionsPage />);
    await screen.findByTestId("credential-test");
    fireEvent.click(screen.getByTestId("credential-test"));

    await waitFor(() =>
      expect(screen.getByTestId("credential-message").textContent).toContain(
        "Cannot parse access token"
      )
    );
    expect(screen.getByTestId("credential-status-INVALID")).toBeInTheDocument();
  });

  it("surfaces field validation from the server", async () => {
    mocked.saveCredentials.mockResolvedValue({
      success: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid credentials",
        details: { adAccountId: ["Ad account ID must be digits, optionally prefixed with act_"] },
      },
      timestamp: ts(),
    } as never);

    render(<ConnectionsPage />);
    await screen.findByTestId("credential-input-adAccountId");

    fireEvent.change(screen.getByTestId("credential-input-adAccountId"), {
      target: { value: "not-an-id" },
    });
    fireEvent.click(screen.getByText("Save configuration"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("must be digits")
    );
  });

  it("gives a server-managed integration no form at all", async () => {
    render(<ConnectionsPage />);
    await screen.findByText("n8n Automations");

    // Only Meta's inputs exist. Rendering boxes for n8n would invite an
    // operator to type a secret the backend cannot accept from the browser.
    expect(screen.queryByTestId("credential-input-apiKey")).toBeNull();
    expect(
      screen.getByText(/reads its configuration from the server environment/i)
    ).toBeInTheDocument();
  });

  it("explains when credential storage is switched off server-side", async () => {
    mocked.listCredentials.mockResolvedValue({
      success: false,
      error: { code: "NOT_FOUND", message: "Route not found" },
      timestamp: ts(),
    } as never);

    render(<ConnectionsPage />);
    await waitFor(() =>
      expect(screen.getByText(/no encryption key is configured/i)).toBeInTheDocument()
    );
  });
});
