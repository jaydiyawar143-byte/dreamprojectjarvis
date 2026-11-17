// ---------------------------------------------------------------------------
// VO-2.2 — the Virtual Office as a dashboard widget, and its expanded dialog.
//
// What is pinned here:
//
//   * the widget shows the floor (the existing DOM renderer), the live status
//     and the task totals;
//   * the expand control opens a full-screen, labelled, modal dialog rendered
//     at <body> (a portal: a grid cell's transform would trap a fixed element);
//   * close, Escape and a press on the backdrop close it, and focus goes back
//     to what opened it; Escape is not passed on to anything beneath;
//   * Tab and Shift+Tab stay inside the dialog;
//   * an agent clicked on the widget opens the office WITH that agent selected,
//     and the selection survives closing;
//   * opening the dialog starts no second round of reads (one subscription);
//   * customise mode opens nothing;
//   * `?office=open` opens it, closing removes the parameter, and it still
//     works when the widget is hidden.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";

const navigation = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: navigation.replace, prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, listAgents: vi.fn(), listWorkTasks: vi.fn(), listActivity: vi.fn() };
});

const officeStream = vi.hoisted(() => {
  const reconnect = vi.fn();
  // Fires once per MOUNTED office. A hook function runs on every render, so
  // only an effect can tell one subscription from three renders — and the
  // subscription is what this suite is about.
  const subscribe = vi.fn();
  return { reconnect, subscribe };
});

vi.mock("../src/lib/use-office-stream", async () => {
  const { useEffect } = await import("react");
  return {
    useOfficeStream: () => {
      useEffect(() => {
        officeStream.subscribe();
      }, []);
      return {
        status: "live" as const,
        events: [] as never[],
        taskUpdates: new Map<never, never>(),
        taskRevision: 0,
        reconnect: officeStream.reconnect,
      };
    },
  };
});

import * as api from "../src/lib/api";
import {
  OFFICE_DEEP_LINK,
  OfficeDeepLink,
  OfficeWidget,
} from "../src/components/office/office-widget";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();
const ok = <T,>(data: T) => ({ success: true as const, data, timestamp: ts() });

const AGENT = (over: Partial<api.AgentSummary> = {}): api.AgentSummary => ({
  agentId: "knowledge-agent",
  domain: "knowledge",
  description: "Knowledge agent",
  allowedTools: ["knowledge.search"],
  toolCount: 1,
  writesRequireApproval: false,
  clientSelectable: true,
  registered: true,
  availability: "AVAILABLE",
  ...over,
});

function resolveOffice(): void {
  mocked.listAgents.mockResolvedValue(
    ok({ agents: [AGENT(), AGENT({ agentId: "analytics-agent", domain: "analytics" })], total: 2, registeredCount: 2 })
  );
  mocked.listWorkTasks.mockResolvedValue(
    ok({
      tasks: [],
      count: 0,
      statusCounts: { PENDING: 3, RUNNING: 2, COMPLETED: 9, FAILED: 0, UNRESOLVED: 0 },
    })
  );
  mocked.listActivity.mockResolvedValue(ok({ entries: [], count: 0, limit: 40 }));
}

async function renderWidget(customizing = false) {
  const utils = render(<OfficeWidget customizing={customizing} layoutLoaded />);
  await screen.findByTestId("office-widget-counts");
  return utils;
}

const expandButton = () => screen.getByTestId("office-widget-expand");
const dialog = () => screen.queryByTestId("office-dialog");

beforeEach(() => {
  vi.clearAllMocks();
  navigation.search = "";
  resolveOffice();
});

// ---------------------------------------------------------------------------

describe("VO-2.2 — the widget", () => {
  it("shows the floor, the live status and the task engine's totals", async () => {
    await renderWidget();

    const widget = screen.getByTestId("office-widget");
    expect(within(widget).getByTestId("office-floor-plan")).toBeInTheDocument();
    expect(within(widget).getByTestId("office-stream-badge").dataset.status).toBe("live");
    expect(screen.getByTestId("office-widget-counts").textContent).toBe("2 running · 3 queued");
    expect(within(widget).getAllByTestId("office-actor")).toHaveLength(2);
    // Closed until asked.
    expect(dialog()).toBeNull();
  });

  it("runs, approves and writes nothing: its only controls are expand and the floor", async () => {
    await renderWidget();
    const widget = screen.getByTestId("office-widget");
    const labels = within(widget)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");
    for (const label of labels) {
      expect(label).not.toMatch(/approve|confirm|run|execute|delete/i);
    }
  });
});

describe("VO-2.2 — the expanded dialog", () => {
  it("opens as a labelled, full-screen modal dialog rendered at <body>", async () => {
    await renderWidget();

    fireEvent.click(expandButton());

    const opened = await screen.findByRole("dialog", { name: "Virtual Office" });
    expect(opened.getAttribute("aria-modal")).toBe("true");
    // A portal: not inside the widget, whose grid cell is transformed.
    expect(screen.getByTestId("office-widget").contains(opened)).toBe(false);
    expect(screen.getByTestId("office-dialog-backdrop").parentElement).toBe(document.body);
    // The whole office is inside it.
    expect(within(opened).getByTestId("office-view")).toBeInTheDocument();
    expect(within(opened).getByTestId("office-event-list")).toBeInTheDocument();
  });

  it("moves focus in on open and gives it back on close", async () => {
    await renderWidget();
    expandButton().focus();

    fireEvent.click(expandButton());
    await screen.findByTestId("office-dialog");
    expect(document.activeElement).toBe(screen.getByTestId("office-dialog-close"));

    fireEvent.click(screen.getByTestId("office-dialog-close"));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(expandButton());
  });

  it("closes on Escape, gives focus back, and does not pass Escape on", async () => {
    await renderWidget();
    // Something beneath that also answers Escape — as the chat surface layer does.
    const beneath = vi.fn();
    window.addEventListener("keydown", beneath);
    try {
      expandButton().focus();
      fireEvent.click(expandButton());
      await screen.findByTestId("office-dialog");

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(expandButton());
      expect(beneath).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", beneath);
    }
  });

  it("closes on a press on the backdrop, never on one inside the panel", async () => {
    await renderWidget();
    fireEvent.click(expandButton());
    const opened = await screen.findByTestId("office-dialog");

    fireEvent.mouseDown(opened);
    expect(dialog()).not.toBeNull();

    fireEvent.mouseDown(screen.getByTestId("office-dialog-backdrop"));
    expect(dialog()).toBeNull();
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    await renderWidget();
    fireEvent.click(expandButton());
    const opened = await screen.findByTestId("office-dialog");

    const focusable = Array.from(
      opened.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])")
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("opens with the agent clicked on the widget already selected, and keeps it", async () => {
    await renderWidget();
    const analytics = within(screen.getByTestId("office-widget"))
      .getAllByTestId("office-actor")
      .find((actor) => actor.dataset.agentId === "analytics-agent")!;

    fireEvent.click(analytics);

    const opened = await screen.findByTestId("office-dialog");
    // The selected-actor panel shows that agent, not the empty prompt.
    expect(within(opened).getByRole("heading", { name: "Analytics Agent" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("office-dialog-close"));
    const after = within(screen.getByTestId("office-widget"))
      .getAllByTestId("office-actor")
      .find((actor) => actor.dataset.agentId === "analytics-agent")!;
    expect(after.getAttribute("aria-pressed")).toBe("true");
  });

  it("shares the widget's data: opening it starts no second round of reads", async () => {
    await renderWidget();
    const calls = () => [
      mocked.listAgents.mock.calls.length,
      mocked.listWorkTasks.mock.calls.length,
      mocked.listActivity.mock.calls.length,
    ];
    const before = calls();

    fireEvent.click(expandButton());
    await screen.findByTestId("office-view");

    expect(calls()).toEqual(before);
    expect(before).toEqual([1, 1, 1]);
  });

  it("re-reads everything and reconnects the feed on Refresh", async () => {
    await renderWidget();
    fireEvent.click(expandButton());
    await screen.findByTestId("office-view");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(mocked.listWorkTasks).toHaveBeenCalledTimes(2));
    expect(mocked.listAgents).toHaveBeenCalledTimes(2);
    expect(mocked.listActivity).toHaveBeenCalledTimes(2);
    expect(officeStream.reconnect).toHaveBeenCalledTimes(1);
  });
});

describe("VO-2.2 — customise mode", () => {
  it("opens nothing while the dashboard is being arranged", async () => {
    await renderWidget(true);

    expect(expandButton()).toBeDisabled();
    expect(screen.getByTestId("office-widget-body").getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(expandButton());
    fireEvent.click(screen.getAllByTestId("office-actor")[0]!);
    fireEvent.click(screen.getByTestId("office-system-actor"));

    expect(dialog()).toBeNull();
  });
});

describe("VO-2.2 — ?office=open", () => {
  it("opens the office from the URL", async () => {
    navigation.search = "office=open";

    render(<OfficeWidget customizing={false} layoutLoaded />);

    expect(await screen.findByRole("dialog", { name: "Virtual Office" })).toBeInTheDocument();
  });

  it("removes the parameter on close, keeping any others", async () => {
    navigation.search = "tab=x&office=open";
    render(<OfficeWidget customizing={false} layoutLoaded />);
    await screen.findByTestId("office-dialog");

    fireEvent.click(screen.getByTestId("office-dialog-close"));

    expect(navigation.replace).toHaveBeenCalledWith("/dashboard?tab=x");
  });

  it("never touches the URL when it was opened from the widget", async () => {
    await renderWidget();
    fireEvent.click(expandButton());
    await screen.findByTestId("office-dialog");
    fireEvent.click(screen.getByTestId("office-dialog-close"));

    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("still opens the office when the widget is hidden", async () => {
    navigation.search = "office=open";

    render(<OfficeDeepLink />);

    const opened = await screen.findByRole("dialog", { name: "Virtual Office" });
    expect(within(opened).getByTestId("office-view")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("office-dialog-close"));
    expect(navigation.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("reads nothing at all when the hidden widget is not asked for", async () => {
    render(<OfficeDeepLink />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(dialog()).toBeNull();
    expect(mocked.listAgents).not.toHaveBeenCalled();
  });

  it("is the address the old /office route redirects to", () => {
    expect(OFFICE_DEEP_LINK).toBe("/dashboard?office=open");
  });
});

describe("VO-2.2 — nothing is read before the saved layout has loaded", () => {
  // The dashboard renders DEFAULT_LAYOUT until GET /preferences answers, and the
  // office is visible in that default. The widget is mounted with the layout
  // still unknown on every dashboard load, so the cost of reading early is paid
  // by everyone — including the people whose saved layout hides the office and
  // who would have seen none of it.

  const officeReads = () => [
    mocked.listAgents.mock.calls.length,
    mocked.listWorkTasks.mock.calls.length,
    mocked.listActivity.mock.calls.length,
  ];

  it("makes zero reads and opens zero subscriptions while the layout is loading", async () => {
    render(<OfficeWidget customizing={false} layoutLoaded={false} />);

    // Let every effect that could start a read run.
    await act(async () => {
      await Promise.resolve();
    });

    expect(officeReads()).toEqual([0, 0, 0]);
    expect(officeStream.subscribe).not.toHaveBeenCalled();
    // Nothing to click either: the expand control appears with the data.
    expect(screen.queryByTestId("office-widget-expand")).toBeNull();
    expect(screen.queryByTestId("office-actor")).toBeNull();
    expect(dialog()).toBeNull();
  });

  it("keeps the widget's frame while it waits, so the dashboard does not jump", () => {
    render(<OfficeWidget customizing={false} layoutLoaded={false} />);

    const widget = screen.getByTestId("office-widget");
    expect(widget.dataset.state).toBe("pending");
    expect(widget.getAttribute("aria-busy")).toBe("true");
    expect(within(widget).getByTestId("office-widget-body")).toBeInTheDocument();
  });

  it("starts exactly one round of reads and one subscription once the layout arrives", async () => {
    const { rerender } = render(<OfficeWidget customizing={false} layoutLoaded={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(officeReads()).toEqual([0, 0, 0]);

    rerender(<OfficeWidget customizing={false} layoutLoaded />);
    await screen.findByTestId("office-widget-counts");

    expect(officeReads()).toEqual([1, 1, 1]);
    expect(officeStream.subscribe).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("office-widget").dataset.state).toBe("ready");
  });

  it("honours ?office=open only after the layout has loaded", async () => {
    navigation.search = "office=open";

    const { rerender } = render(<OfficeWidget customizing={false} layoutLoaded={false} />);
    await act(async () => {
      await Promise.resolve();
    });

    // The request is not lost — but nothing opens, and nothing is read, until
    // it is known whether the office is on the dashboard at all.
    expect(dialog()).toBeNull();
    expect(officeReads()).toEqual([0, 0, 0]);

    rerender(<OfficeWidget customizing={false} layoutLoaded />);

    expect(await screen.findByRole("dialog", { name: "Virtual Office" })).toBeInTheDocument();
    expect(officeReads()).toEqual([1, 1, 1]);
    expect(screen.getAllByTestId("office-dialog")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ?office=open while the dashboard is being arranged. The request is kept in
// the URL, nothing opens mid-arrange, and it is honoured the moment customise
// mode ends — the same whether the widget is visible or hidden.
// ---------------------------------------------------------------------------

describe("VO-2.2 — ?office=open during customise mode", () => {
  it("does not open the office while customising, and keeps the request in the URL", async () => {
    navigation.search = "office=open";

    render(<OfficeWidget customizing layoutLoaded />);
    await screen.findByTestId("office-widget-counts");

    expect(dialog()).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("opens the office once customising ends, and closing then removes the parameter", async () => {
    navigation.search = "office=open";

    const { rerender } = render(<OfficeWidget customizing layoutLoaded />);
    await screen.findByTestId("office-widget-counts");
    expect(dialog()).toBeNull();

    rerender(<OfficeWidget customizing={false} layoutLoaded />);

    expect(await screen.findByRole("dialog", { name: "Virtual Office" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("office-dialog-close"));
    expect(dialog()).toBeNull();
    expect(navigation.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("with the widget hidden: waits through customise mode, reading nothing, then opens", async () => {
    navigation.search = "office=open";

    const { rerender } = render(<OfficeDeepLink customizing />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(dialog()).toBeNull();
    expect(mocked.listAgents).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();

    rerender(<OfficeDeepLink customizing={false} />);

    const opened = await screen.findByRole("dialog", { name: "Virtual Office" });
    expect(within(opened).getByTestId("office-view")).toBeInTheDocument();
    expect(mocked.listAgents).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("office-dialog-close"));
    expect(navigation.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("with the widget hidden: entering customise mode closes the office and keeps the request", async () => {
    navigation.search = "office=open";

    const { rerender } = render(<OfficeDeepLink customizing={false} />);
    await screen.findByRole("dialog", { name: "Virtual Office" });

    rerender(<OfficeDeepLink customizing />);

    expect(dialog()).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
