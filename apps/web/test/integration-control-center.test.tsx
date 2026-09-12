// ---------------------------------------------------------------------------
// Integration Control Center — the page.
//
// What this suite is really guarding:
//
//   1. A CARD NEVER CLAIMS MORE THAN THE SERVER SAID. "Credentials present but
//      unverified" renders as "Not checked", not as connected. Only a real test
//      result turns it green, and `connection` (is it set up?) is shown
//      separately from `health` (does it work?) so neither implies the other.
//
//   2. EVERY MANUAL CONTROL POSTS TO THE SHARED BACKEND. Test, Connect,
//      Reconnect, Enable, Disable, Configure, Validate and Disconnect each call
//      the endpoint that the identically-named JARVIS tool also reaches. The
//      page holds no business logic, so there is nothing here for the voice
//      path to be missing.
//
//   3. NOTHING SECRET IS RENDERED. The server sends no credential, and the page
//      has nowhere to put one; both halves are asserted, including that an
//      untouched secret field posts the MASK back rather than blanking a
//      working token.
//
//   4. AN IRREVERSIBLE ACTION ASKS FIRST. Disconnect revokes at the provider,
//      so it confirms in place and names the consequence.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within, configure } from "@testing-library/react";

// The suite runs alongside nineteen other files; the default 1s wait is enough
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
    getIntegration: vi.fn(),
    testIntegration: vi.fn(),
    connectIntegration: vi.fn(),
    reconnectIntegration: vi.fn(),
    setIntegrationEnabled: vi.fn(),
    configureIntegration: vi.fn(),
    validateIntegrationConfig: vi.fn(),
    disconnectIntegration: vi.fn(),
    getIntegrationAudit: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import IntegrationsPage from "../src/app/integrations/page";
import { sinceLabel } from "../src/components/integrations/integration-card";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();

const ALL_COMMANDS: api.IntegrationCommand[] = [
  "status",
  "configure",
  "validateConfig",
  "testConnection",
  "getPermissions",
  "reconnect",
  "enable",
  "disable",
  "disconnect",
  "getHealth",
  "getAudit",
];

function integration(over: Partial<api.Integration> = {}): api.Integration {
  return {
    id: "meta",
    name: "Meta Ads",
    subtitle: "Marketing API — reads open, writes approval-gated",
    category: "advertising",
    configKind: "form",
    connection: "CONNECTED",
    health: "UNVERIFIED",
    detail: "Credentials present. Test to verify them.",
    account: { label: "act_999" },
    config: [
      {
        name: "accessToken",
        label: "Access token",
        kind: "secret",
        required: true,
        hasValue: true,
        masked: "••••••••••••",
        value: null,
        serverManaged: false,
      },
      {
        name: "adAccountId",
        label: "Ad account ID",
        kind: "text",
        required: true,
        hasValue: true,
        masked: null,
        value: "act_999",
        serverManaged: false,
      },
    ],
    configComplete: true,
    missingConfig: [],
    permissions: [
      { id: "ads_read", label: "Read ad accounts and insights", granted: true, access: "read" },
      { id: "ads_management", label: "Change budgets", granted: true, access: "write" },
    ],
    actions: [
      { id: "meta.insights", label: "Insights", available: true, writesExternally: false },
      {
        id: "meta.campaign.budget.update",
        label: "Budget & status changes",
        available: true,
        writesExternally: true,
      },
    ],
    enabledServices: [],
    usage: null,
    lastTestedAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    effectiveSource: "stored",
    supportedCommands: ALL_COMMANDS,
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
  mocked.getIntegrationAudit.mockResolvedValue({
    success: true,
    data: { entries: [], message: "" },
    timestamp: ts(),
  } as never);
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

  it("shows setup state separately from health, so neither implies the other", async () => {
    render(<IntegrationsPage />);
    const card = await screen.findByTestId("integration-card-meta");

    // Set up AND unverified is a real, common combination.
    expect(within(card).getByTestId("integration-connection-meta")).toHaveTextContent("Set up");
    expect(card).toHaveAttribute("data-health", "UNVERIFIED");
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
      success: false,
      error: { code: "PROVIDER_ERROR", message: "Meta Ads: Error validating access token" },
      timestamp: ts(),
    } as never);
    mocked.getIntegration.mockResolvedValue({
      success: true,
      data: integration({ health: "ERROR", lastError: "Error validating access token" }),
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-test-meta"));

    // The reason the server gave is the most useful thing on screen.
    await waitFor(() =>
      expect(screen.getByTestId("integration-notice")).toHaveTextContent("access token")
    );
    expect(screen.getByTestId("integration-card-meta")).not.toHaveAttribute(
      "data-health",
      "CONNECTED"
    );
  });

  it("says 'never' rather than inventing a check time", async () => {
    render(<IntegrationsPage />);
    expect(await screen.findByTestId("integration-checked-meta")).toHaveTextContent("never");
  });

  it("distinguishes last test from last successful sync", async () => {
    render(<IntegrationsPage />);
    // Two different questions: "did we check?" and "did data actually flow?"
    expect(await screen.findByTestId("integration-checked-meta")).toBeInTheDocument();
    expect(screen.getByTestId("integration-sync-meta")).toBeInTheDocument();
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
        name: "Google",
        category: "google",
        configKind: "oauth",
        connection: "NOT_CONNECTED",
        health: "NOT_CONNECTED",
        account: null,
        supportedCommands: [...ALL_COMMANDS, "connect"],
      }),
    ]);

    render(<IntegrationsPage />);
    expect(await screen.findByTestId("integration-connect-google")).toBeInTheDocument();
  });

  it("offers Reauthorize INSTEAD of Test when the grant is gone", async () => {
    // A Test button here would just fail again; offering it invites the user to
    // retry something that cannot succeed.
    respond([
      integration({
        id: "google",
        name: "Google",
        category: "google",
        configKind: "oauth",
        connection: "NEEDS_REAUTH",
        health: "NEEDS_REAUTH",
        supportedCommands: [...ALL_COMMANDS, "connect"],
      }),
    ]);

    render(<IntegrationsPage />);
    expect(await screen.findByTestId("integration-reconnect-google")).toBeInTheDocument();
    expect(screen.queryByTestId("integration-test-google")).toBeNull();
    expect(screen.queryByTestId("integration-connect-google")).toBeNull();
  });

  it("renders a CONFIG_REQUIRED integration with its unmet requirements ticked off", async () => {
    respond([
      integration({
        id: "whatsapp",
        name: "WhatsApp Business",
        category: "communication",
        configKind: "server-managed",
        connection: "NOT_CONNECTED",
        health: "CONFIG_REQUIRED",
        detail: "Not configured on the server.",
        account: null,
        actions: [
          { id: "whatsapp.send", label: "Send a message", available: false, writesExternally: true },
        ],
        config: [],
        permissions: [],
      }),
    ]);

    render(<IntegrationsPage />);
    const card = await screen.findByTestId("integration-card-whatsapp");
    expect(card).toHaveAttribute("data-health", "CONFIG_REQUIRED");
    // Availability is conveyed as text too, not only by a tick glyph.
    expect(within(card).getAllByText("unavailable").length).toBe(1);
  });

  it("names what is missing rather than only saying 'incomplete'", async () => {
    respond([
      integration({
        configComplete: false,
        missingConfig: ["accessToken"],
        connection: "PARTIAL",
        health: "CONFIG_REQUIRED",
      }),
    ]);

    render(<IntegrationsPage />);
    expect(await screen.findByTestId("integration-missing-meta")).toHaveTextContent("accessToken");
  });

  it("renders a DISABLED integration without offering a Test it would refuse", async () => {
    respond([
      integration({
        connection: "DISABLED",
        health: "DISABLED",
        detail: "Switched off. Credentials are kept.",
      }),
    ]);

    render(<IntegrationsPage />);
    const card = await screen.findByTestId("integration-card-meta");
    expect(within(card).getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByTestId("integration-test-meta")).toBeNull();
    // And it offers the way back on.
    expect(screen.getByTestId("integration-toggle-meta")).toHaveTextContent("Enable");
  });

  it("renders usage with a percentage when the integration has a ceiling", async () => {
    respond([
      integration({
        id: "google-maps",
        name: "Google Maps",
        category: "maps",
        configKind: "server-managed",
        health: "CONNECTED",
        usage: { used: 12438, limit: 70000, percentUsed: 17.8, level: "OK", blocked: false },
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

describe("manual controls reach the shared backend", () => {
  it("Test posts to the integration test endpoint", async () => {
    mocked.testIntegration.mockResolvedValue({
      success: true,
      data: { health: "CONNECTED", detail: "ok", checkedAt: ts() },
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-test-meta"));

    // The SAME endpoint the JARVIS `integration.test` tool reaches through its
    // port. This is the frontend half of the parity claim.
    await waitFor(() => expect(mocked.testIntegration).toHaveBeenCalledWith("meta"));
  });

  it("Connect asks the server for the authorization URL rather than building one", async () => {
    respond([
      integration({
        id: "google",
        name: "Google",
        category: "google",
        configKind: "oauth",
        connection: "NOT_CONNECTED",
        health: "NOT_CONNECTED",
        supportedCommands: [...ALL_COMMANDS, "connect"],
      }),
    ]);
    mocked.connectIntegration.mockResolvedValue({
      success: true,
      data: { authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1", services: ["ads"], message: "" },
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-connect-google"));

    // Scope selection is a SERVER decision. The page never composes a consent
    // URL, so it cannot ask for more access than the server intends.
    await waitFor(() => expect(mocked.connectIntegration).toHaveBeenCalledWith("google"));
  });

  it("Disable posts the enable/disable command and keeps credentials", async () => {
    mocked.setIntegrationEnabled.mockResolvedValue({
      success: true,
      data: { enabled: false, message: "Meta Ads disabled. Its credentials are kept.", view: integration({ connection: "DISABLED", health: "DISABLED" }) },
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-toggle-meta"));

    await waitFor(() => expect(mocked.setIntegrationEnabled).toHaveBeenCalledWith("meta", false));
    await waitFor(() =>
      expect(screen.getByTestId("integration-notice")).toHaveTextContent(/credentials are kept/i)
    );
  });

  it("Reconnect posts the reconnect command and shows what the server said", async () => {
    mocked.reconnectIntegration.mockResolvedValue({
      success: true,
      data: { refreshed: true, message: "Google access token refreshed. No re-consent was needed." },
      timestamp: ts(),
    } as never);
    mocked.getIntegration.mockResolvedValue({
      success: true,
      data: integration(),
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));
    fireEvent.click(await screen.findByTestId("drawer-reconnect"));

    await waitFor(() => expect(mocked.reconnectIntegration).toHaveBeenCalledWith("meta"));
  });
});

// ---------------------------------------------------------------------------

describe("the page cannot execute anything ungated", () => {
  it("marks actions that change something outside JARVIS", async () => {
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
        configKind: "server-managed",
        health: "CONNECTED",
        config: [],
        actions: [
          { id: "whatsapp.send", label: "Send a message", available: true, writesExternally: true },
        ],
      }),
    ]);

    render(<IntegrationsPage />);
    await screen.findByTestId("integration-card-whatsapp");

    for (const button of screen.getAllByRole("button")) {
      // Management verbs only. Execution goes through ToolExecutor and the
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

  it("renders a stored secret as a mask with a Replace control, not a filled box", async () => {
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));

    // A pre-filled password box would imply the value is present in the page.
    // It is not — the browser was never given it.
    const masked = await screen.findByTestId("config-masked-accessToken");
    expect(masked).toHaveTextContent("••••");
    expect(screen.getByTestId("config-replace-accessToken")).toBeInTheDocument();
    expect(screen.queryByTestId("config-input-accessToken")).toBeNull();
  });

  it("posts the MASK back for an untouched secret, so saving does not blank it", async () => {
    mocked.configureIntegration.mockResolvedValue({
      success: true,
      data: { saved: ["adAccountId"], missing: [], message: "Saved." },
      timestamp: ts(),
    } as never);
    mocked.getIntegration.mockResolvedValue({
      success: true,
      data: integration(),
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));

    // Change ONLY the non-secret field.
    fireEvent.change(await screen.findByTestId("config-input-adAccountId"), {
      target: { value: "act_111" },
    });
    fireEvent.click(screen.getByTestId("drawer-save"));

    await waitFor(() => expect(mocked.configureIntegration).toHaveBeenCalled());
    const [, payload] = mocked.configureIntegration.mock.calls[0]!;
    // The classic way an edit-in-place form destroys the secret it was
    // displaying is to post the mask as a literal new value. The server reads
    // this sentinel as "unchanged".
    expect(payload.accessToken).toBe("••••••••••••");
    expect(payload.adAccountId).toBe("act_111");
  });

  it("shows a server-managed secret as set/not set, never as an editable field", async () => {
    respond([
      integration({
        id: "n8n",
        name: "n8n Automations",
        category: "automation",
        configKind: "server-managed",
        config: [
          {
            name: "apiKey",
            label: "API key",
            kind: "secret",
            required: true,
            hasValue: true,
            masked: "••••••••••••",
            value: null,
            serverManaged: true,
          },
        ],
      }),
    ]);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-n8n"));

    const config = await screen.findByTestId("drawer-config");
    expect(within(config).getByText(/environment variables/i)).toBeInTheDocument();
    expect(within(config).getByText("set")).toBeInTheDocument();
    expect(screen.queryByTestId("config-input-apiKey")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("configuration form", () => {
  it("validates without saving", async () => {
    mocked.validateIntegrationConfig.mockResolvedValue({
      success: true,
      data: { valid: true, missing: [], message: "Configuration is valid and complete." },
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));
    fireEvent.click(await screen.findByTestId("drawer-validate"));

    await waitFor(() => expect(mocked.validateIntegrationConfig).toHaveBeenCalled());
    expect(mocked.configureIntegration).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("drawer-config-notice")).toHaveTextContent(/valid/i)
    );
  });

  it("shows the server's rejection rather than a generic failure", async () => {
    mocked.configureIntegration.mockResolvedValue({
      success: false,
      error: { code: "INVALID_CONFIG", message: "Ad account ID must be act_ followed by digits." },
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));
    fireEvent.change(await screen.findByTestId("config-input-adAccountId"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByTestId("drawer-save"));

    await waitFor(() =>
      expect(screen.getByTestId("drawer-config-notice")).toHaveTextContent(/act_ followed by digits/)
    );
  });
});

// ---------------------------------------------------------------------------

describe("permissions are visible", () => {
  it("lists granted permissions with their access level", async () => {
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));

    const panel = await screen.findByTestId("drawer-permissions");
    expect(within(panel).getByText(/Read ad accounts/i)).toBeInTheDocument();
    expect(within(panel).getByText("write")).toBeInTheDocument();
  });

  it("says plainly when nothing is granted", async () => {
    respond([integration({ permissions: [], connection: "NOT_CONNECTED", health: "NOT_CONNECTED" })]);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));

    const panel = await screen.findByTestId("drawer-permissions");
    expect(within(panel).getByText(/None\./i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe("disconnect asks before it acts", () => {
  it("confirms in place and names the consequence", async () => {
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));
    fireEvent.click(await screen.findByTestId("drawer-disconnect"));

    const confirm = await screen.findByTestId("drawer-disconnect-confirm");
    expect(confirm).toHaveTextContent(/revokes the token/i);
    expect(confirm).toHaveTextContent(/consent again/i);
    // And it points at the reversible alternative.
    expect(confirm).toHaveTextContent(/Disable/);
    // Nothing has happened yet.
    expect(mocked.disconnectIntegration).not.toHaveBeenCalled();
  });

  it("only disconnects once confirmed", async () => {
    mocked.disconnectIntegration.mockResolvedValue({
      success: true,
      data: { disconnected: true, message: "Meta Ads credentials removed." },
      timestamp: ts(),
    } as never);
    mocked.getIntegration.mockResolvedValue({
      success: true,
      data: integration({ connection: "NOT_CONNECTED", health: "NOT_CONNECTED", account: null }),
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));
    fireEvent.click(await screen.findByTestId("drawer-disconnect"));
    fireEvent.click(await screen.findByTestId("drawer-disconnect-yes"));

    await waitFor(() => expect(mocked.disconnectIntegration).toHaveBeenCalledWith("meta"));
    // The card is re-read rather than guessed at.
    await waitFor(() => expect(mocked.getIntegration).toHaveBeenCalledWith("meta"));
  });

  it("can be cancelled", async () => {
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));
    fireEvent.click(await screen.findByTestId("drawer-disconnect"));
    fireEvent.click(await screen.findByText("Cancel"));

    await waitFor(() => expect(screen.queryByTestId("drawer-disconnect-confirm")).toBeNull());
    expect(mocked.disconnectIntegration).not.toHaveBeenCalled();
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
      configKind: "server-managed",
      health: "CONFIG_REQUIRED",
    }),
    integration({
      id: "google-maps",
      name: "Google Maps",
      category: "maps",
      configKind: "server-managed",
      health: "UNVERIFIED",
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

  it("counts a NEEDS_REAUTH integration as needing attention", async () => {
    respond([integration({ health: "NEEDS_REAUTH", connection: "NEEDS_REAUTH" })]);
    render(<IntegrationsPage />);
    await screen.findByTestId("integration-card-meta");

    fireEvent.click(screen.getByTestId("integration-filter-attention"));
    await waitFor(() =>
      expect(screen.getByTestId("integration-card-meta")).toBeInTheDocument()
    );
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

  it("searches by name, category and action", async () => {
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

  it("states the security posture, including the two-path guarantee", async () => {
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));

    const drawer = await screen.findByTestId("integration-drawer");
    expect(within(drawer).getByText(/never sent back to this browser/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/same backend service/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/cannot be authorized by voice/i)).toBeInTheDocument();
  });

  it("shows recent activity from the audit log", async () => {
    mocked.getIntegrationAudit.mockResolvedValue({
      success: true,
      data: {
        entries: [
          { id: "a1", integration: "meta", command: "testConnection", result: "success", at: ts() },
        ],
        message: "",
      },
      timestamp: ts(),
    } as never);

    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId("integration-manage-meta"));

    const audit = await screen.findByTestId("drawer-audit");
    await waitFor(() => expect(within(audit).getByText("testConnection")).toBeInTheDocument());
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
