// ---------------------------------------------------------------------------
// Integration Control Center — the page.
//
// What this suite is really guarding:
//
//   1. A CARD NEVER CLAIMS MORE THAN THE SERVER SAID. "Credentials present but
//      unverified" renders as "Not checked", not as connected. Only a real test
//      result turns it green.
//
//   2. THE PAGE CANNOT EXECUTE. There is no button that sends, triggers or
//      changes anything outside JARVIS — those are tools behind the approval
//      boundary, and the cards say so.
//
//   3. NOTHING SECRET IS RENDERED. The server sends no credential, and the page
//      has nowhere to put one; both halves are asserted.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within, configure } from "@testing-library/react";

// The suite runs alongside thirteen other files; the default 1s wait is enough
// on an idle machine and intermittently is not under that load.
configure({ asyncUtilTimeout: 5000 });

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/integrations",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    listIntegrations: vi.fn(),
    testIntegration: vi.fn(),
    refreshIntegration: vi.fn(),
    connectGoogle: vi.fn(),
    disconnectGoogle: vi.fn(),
    removeCredentials: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import IntegrationsPage from "../src/app/integrations/page";
import { sinceLabel } from "../src/components/integrations/integration-card";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();

function integration(over: Partial<api.Integration> = {}): api.Integration {
  return {
    id: "meta",
    name: "Meta Ads",
    subtitle: "Marketing API — reads open, writes approval-gated",
    category: "advertising",
    health: "UNVERIFIED",
    detail: "Credentials present. Test to verify them.",
    capabilities: [
      { id: "meta.insights", label: "Insights", available: true },
      { id: "meta.writes", label: "Budget & status changes", available: true, requiresApproval: true },
    ],
    account: { label: "act_999" },
    usage: null,
    lastCheckedAt: null,
    lastError: null,
    effectiveSource: "server environment",
    actions: { testable: true, configureUrl: "/credentials/meta" },
    ...over,
  };
}

function respond(integrations: api.Integration[]) {
  mocked.listIntegrations.mockResolvedValue({
    success: true,
    data: { integrations },
    timestamp: ts(),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  respond([integration()]);
});

// ---------------------------------------------------------------------------

describe("status honesty", () => {
  it("renders 'Not checked' for credentials that exist but were never verified", async () => {
    render(<IntegrationsPage />);
    const card = await screen.findByTestId("integration-card-meta");

    // The load-bearing assertion of the whole page.
    expect(card).toHaveAttribute("data-health", "UNVERIFIED");
    expect(within(card).getByText("Not checked")).toBeInTheDocument();
    expect(within(card).queryByText("Connected")).toBeNull();
  });

  it("shows Connected only after a test returns CONNECTED", async () => {
    mocked.testIntegration.mockResolvedValue({
      success: true,
      data: { health: "CONNECTED", detail: "Verified against the Graph API.", checkedAt: ts() },
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    const card = await screen.findByTestId("integration-card-meta");
    fireEvent.click(within(card).getByTestId("integration-test-meta"));

    await waitFor(() =>
      expect(screen.getByTestId("integration-card-meta")).toHaveAttribute("data-health", "CONNECTED")
    );
    expect(screen.getByTestId("integration-checked-meta")).not.toHaveTextContent("never");
  });

  it("shows the failure reason when a test fails, and does not go green", async () => {
    mocked.testIntegration.mockResolvedValue({
      success: true,
      data: { health: "ERROR", detail: "Error validating access token", checkedAt: ts() },
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-test-meta"));

    await waitFor(() =>
      expect(screen.getByTestId("integration-card-meta")).toHaveAttribute("data-health", "ERROR")
    );
    expect(screen.getByTestId("integration-error-meta")).toHaveTextContent("access token");
  });

  it("says 'never' rather than inventing a check time", async () => {
    render(<IntegrationsPage />);
    expect(await screen.findByTestId("integration-checked-meta")).toHaveTextContent("never");
  });

  it("reports when the whole status read fails, instead of an empty page", async () => {
    mocked.listIntegrations.mockResolvedValue({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Could not read integration status" },
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    await waitFor(() => expect(screen.getByText(/Integrations unavailable/i)).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------

describe("states", () => {
  it("offers Connect only when there is something to connect", async () => {
    respond([
      integration({
        id: "google",
        name: "Google Ads",
        category: "google",
        health: "NOT_CONNECTED",
        actions: { testable: false, connectUrl: "/google/connect" },
        account: null,
      }),
    ]);

    render(<IntegrationsPage />);
    expect(await screen.findByTestId("integration-connect-google")).toBeInTheDocument();
    expect(screen.queryByTestId("integration-test-google")).toBeNull();
  });

  it("renders a CONFIG_REQUIRED integration with its unmet requirements ticked off", async () => {
    respond([
      integration({
        id: "whatsapp",
        name: "WhatsApp Business",
        category: "communication",
        health: "CONFIG_REQUIRED",
        detail: "Not configured on the server.",
        capabilities: [
          { id: "whatsapp.inbound", label: "Inbound messages", available: false },
          { id: "whatsapp.send", label: "Outbound send", available: false, requiresApproval: true },
        ],
        account: null,
        actions: { testable: false },
      }),
    ]);

    render(<IntegrationsPage />);
    const card = await screen.findByTestId("integration-card-whatsapp");
    expect(card).toHaveAttribute("data-health", "CONFIG_REQUIRED");
    // Availability is conveyed as text too, not only by a tick glyph.
    expect(within(card).getAllByText("unavailable").length).toBe(2);
  });

  it("renders a DISABLED integration without offering actions it cannot perform", async () => {
    respond([
      integration({
        id: "google",
        name: "Google Ads",
        category: "google",
        health: "DISABLED",
        detail: "No Google OAuth client is configured on the server.",
        account: null,
        actions: { testable: false },
      }),
    ]);

    render(<IntegrationsPage />);
    const card = await screen.findByTestId("integration-card-google");
    expect(within(card).getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByTestId("integration-test-google")).toBeNull();
    expect(screen.queryByTestId("integration-connect-google")).toBeNull();
  });

  it("renders usage with a percentage when the integration has a ceiling", async () => {
    respond([
      integration({
        id: "google-maps",
        name: "Google Maps",
        category: "maps",
        health: "CONNECTED",
        usage: { used: 12438, limit: 70000, percentUsed: 17.8, level: "OK", blocked: false },
        actions: { testable: true },
      }),
    ]);

    render(<IntegrationsPage />);
    const usage = await screen.findByTestId("integration-usage-google-maps");
    expect(usage).toHaveTextContent("12,438");
    expect(usage).toHaveTextContent("70,000");
    expect(usage).toHaveTextContent("17.8%");
  });
});

// ---------------------------------------------------------------------------

describe("the page cannot execute anything", () => {
  it("marks approval-gated capabilities on the card", async () => {
    render(<IntegrationsPage />);
    const caps = await screen.findByTestId("integration-capabilities-meta");
    // A connected card must not read as "this dashboard can change budgets".
    expect(within(caps).getByText("Approval")).toBeInTheDocument();
  });

  it("offers no send, trigger or run control anywhere on the page", async () => {
    respond([
      integration({
        id: "whatsapp",
        name: "WhatsApp Business",
        category: "communication",
        health: "CONNECTED",
        capabilities: [
          { id: "whatsapp.send", label: "Outbound send", available: true, requiresApproval: true },
        ],
        actions: { testable: true },
      }),
    ]);

    render(<IntegrationsPage />);
    await screen.findByTestId("integration-card-whatsapp");

    for (const button of screen.getAllByRole("button")) {
      // Configuration verbs only. Execution goes through ToolExecutor and the
      // approval boundary, never through a dashboard button.
      expect(button.textContent ?? "").not.toMatch(/\b(send|trigger|execute|run)\b/i);
    }
  });
});

// ---------------------------------------------------------------------------

describe("no secret is rendered", () => {
  it("shows the safe account identifier and nothing resembling a credential", async () => {
    render(<IntegrationsPage />);
    const card = await screen.findByTestId("integration-card-meta");

    expect(within(card).getByTestId("integration-account-meta")).toHaveTextContent("act_999");
    // Belt and braces: the DOM is searched for anything key-shaped.
    expect(document.body.textContent ?? "").not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
    expect(document.body.textContent ?? "").not.toMatch(/Bearer\s/);
  });
});

// ---------------------------------------------------------------------------

describe("search, filter and grouping", () => {
  const many = () => [
    integration({ id: "meta", name: "Meta Ads", category: "advertising", health: "CONNECTED" }),
    integration({
      id: "n8n",
      name: "n8n Automations",
      category: "automation",
      health: "CONFIG_REQUIRED",
      actions: { testable: false },
    }),
    integration({
      id: "google-maps",
      name: "Google Maps",
      category: "maps",
      health: "UNVERIFIED",
      actions: { testable: true },
    }),
  ];

  it("filters to the ones that need attention", async () => {
    respond(many());
    render(<IntegrationsPage />);
    await screen.findByTestId("integration-card-meta");

    fireEvent.click(screen.getByTestId("integration-filter-attention"));

    await waitFor(() => expect(screen.queryByTestId("integration-card-meta")).toBeNull());
    expect(screen.getByTestId("integration-card-n8n")).toBeInTheDocument();
    // "Not checked" is not attention — it is simply unverified.
    expect(screen.queryByTestId("integration-card-google-maps")).toBeNull();
  });

  it("filters to verified connections only", async () => {
    respond(many());
    render(<IntegrationsPage />);
    await screen.findByTestId("integration-card-meta");

    fireEvent.click(screen.getByTestId("integration-filter-connected"));

    await waitFor(() => expect(screen.queryByTestId("integration-card-n8n")).toBeNull());
    expect(screen.getByTestId("integration-card-meta")).toBeInTheDocument();
    // UNVERIFIED must not be counted as connected.
    expect(screen.queryByTestId("integration-card-google-maps")).toBeNull();
  });

  it("searches by name, category and capability", async () => {
    respond(many());
    render(<IntegrationsPage />);
    await screen.findByTestId("integration-card-meta");

    fireEvent.change(screen.getByTestId("integration-search"), { target: { value: "maps" } });
    await waitFor(() => expect(screen.queryByTestId("integration-card-meta")).toBeNull());
    expect(screen.getByTestId("integration-card-google-maps")).toBeInTheDocument();
  });

  it("says so when nothing matches instead of rendering an empty grid", async () => {
    respond(many());
    render(<IntegrationsPage />);
    await screen.findByTestId("integration-card-meta");

    fireEvent.change(screen.getByTestId("integration-search"), { target: { value: "dropbox" } });
    await waitFor(() => expect(screen.getByText(/No integrations match/i)).toBeInTheDocument());
  });

  it("counts only VERIFIED connections in the summary", async () => {
    respond(many());
    render(<IntegrationsPage />);
    const summary = await screen.findByTestId("integration-summary");
    expect(summary).toHaveTextContent("1 of 3 verified connected");
    expect(summary).toHaveTextContent("1 need attention");
  });
});

// ---------------------------------------------------------------------------

describe("manage drawer", () => {
  it("opens over the page rather than navigating away", async () => {
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));

    const drawer = await screen.findByTestId("integration-drawer");
    expect(drawer).toBeInTheDocument();
    // The list is still mounted behind it.
    expect(screen.getByTestId("integration-card-meta")).toBeInTheDocument();
  });

  it("states the security posture, including that no secret was sent", async () => {
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));

    const drawer = await screen.findByTestId("integration-drawer");
    expect(within(drawer).getByText(/Secrets in this response/i)).toBeInTheDocument();
    expect(within(drawer).getByText("none")).toBeInTheDocument();
    expect(within(drawer).getByText(/approval boundary/i)).toBeInTheDocument();
  });

  it("links to the one place credentials are actually entered", async () => {
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));

    const link = await screen.findByTestId("integration-drawer-configure");
    // A second credential form here would be a second write path to the
    // encrypted store.
    expect(link).toHaveAttribute("href", "/settings/connections");
  });

  it("closes on Escape", async () => {
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));
    await screen.findByTestId("integration-drawer");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("integration-drawer")).toBeNull());
  });
});

// ---------------------------------------------------------------------------

describe("disconnect", () => {
  it("goes through the existing endpoint and then re-reads the status", async () => {
    respond([
      integration({
        health: "CONNECTED",
        actions: { testable: true, configureUrl: "/credentials/meta", disconnectUrl: "/credentials/meta" },
      }),
    ]);
    mocked.removeCredentials.mockResolvedValue({ success: true, data: {}, timestamp: ts() } as never);
    mocked.refreshIntegration.mockResolvedValue({
      success: true,
      data: integration({ health: "NOT_CONNECTED", account: null, lastCheckedAt: null }),
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-disconnect-meta"));

    await waitFor(() => expect(mocked.removeCredentials).toHaveBeenCalledWith("meta"));
    // The cached verdict must not survive the credential being removed.
    expect(mocked.refreshIntegration).toHaveBeenCalledWith("meta");
    await waitFor(() =>
      expect(screen.getByTestId("integration-card-meta")).toHaveAttribute(
        "data-health",
        "NOT_CONNECTED"
      )
    );
  });
});

// ---------------------------------------------------------------------------

describe("sinceLabel", () => {
  it("says 'never' for no check at all", () => {
    expect(sinceLabel(null)).toBe("never");
  });

  it("reads in the units a person would use", () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    expect(sinceLabel("2026-09-09T11:59:50Z", now)).toBe("just now");
    expect(sinceLabel("2026-09-09T11:58:00Z", now)).toBe("2 min ago");
    expect(sinceLabel("2026-09-09T09:00:00Z", now)).toBe("3 h ago");
    expect(sinceLabel("2026-09-07T12:00:00Z", now)).toBe("2 d ago");
  });
});
