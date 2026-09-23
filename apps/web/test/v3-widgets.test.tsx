// ---------------------------------------------------------------------------
// V3 — Command Center widgets.
//
// The through-line of this suite is the same product rule the providers enforce
// on the server: a widget may never present a value JARVIS does not have, and
// may never present an old value as current. Here that is checked at the point
// it reaches the screen.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    getWeather: vi.fn(),
    getCrypto: vi.fn(),
    getIndices: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    getRoute: vi.fn(),
    searchPlaces: vi.fn(),
    getMapsConfig: vi.fn(),
    reverseGeocode: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import { WidgetShell, FreshnessBadge, formatAge } from "../src/components/widgets/widget-shell";
import { ClockWidget, handAngles } from "../src/components/widgets/clock-widget";
import { WeatherWidget, describeWeatherCode } from "../src/components/widgets/weather-widget";
import { MarketsWidget } from "../src/components/widgets/markets-widget";
import { TasksWidget, bucketFor, workStatusOf } from "../src/components/widgets/tasks-widget";
import { MapWidget } from "../src/components/widgets/map-widget";
import { resolveWidgets, WIDGETS } from "../src/components/widgets/registry";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();

const liveMeta = (over: Partial<api.ProviderMeta> = {}): api.ProviderMeta => ({
  freshness: "LIVE",
  observedAt: ts(),
  ageSeconds: 5,
  source: "Test",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getCrypto.mockResolvedValue({ success: true, data: { value: [], meta: liveMeta() }, timestamp: ts() } as never);
  mocked.getIndices.mockResolvedValue({ success: true, data: { value: null, meta: liveMeta({ freshness: "UNAVAILABLE", reason: "No provider" }) }, timestamp: ts() } as never);
  mocked.listTasks.mockResolvedValue({ success: true, data: { tasks: [] }, timestamp: ts() } as never);
  mocked.getWeather.mockResolvedValue({ success: true, data: { value: null, meta: liveMeta({ freshness: "UNAVAILABLE", reason: "No location set." }) }, timestamp: ts() } as never);
});

// ---------------------------------------------------------------------------
// The shared shell
// ---------------------------------------------------------------------------

describe("widget shell", () => {
  it("shows every value alongside how current it is", () => {
    render(
      <WidgetShell title="Test" meta={liveMeta()}>
        <p>content</p>
      </WidgetShell>
    );
    expect(screen.getByTestId("freshness-badge")).toHaveAttribute("data-freshness", "LIVE");
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("REPLACES the content when a provider is unavailable", () => {
    // The important one. Rendering empty rows under an "Unavailable" badge is
    // how a reader ends up believing a dash is a measurement.
    render(
      <WidgetShell title="Test" meta={liveMeta({ freshness: "UNAVAILABLE", reason: "No sensor fitted" })}>
        <p>should not be shown</p>
      </WidgetShell>
    );
    expect(screen.getByTestId("widget-unavailable")).toHaveTextContent("No sensor fitted");
    expect(screen.queryByText("should not be shown")).toBeNull();
  });

  it("distinguishes a transport failure from an unavailable provider", () => {
    const onRetry = vi.fn();
    render(
      <WidgetShell title="Test" error="Network request failed" onRetry={onRetry}>
        <p>content</p>
      </WidgetShell>
    );
    expect(screen.getByTestId("widget-error")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("describes age in words a person reads at a glance", () => {
    expect(formatAge(10)).toBe("just now");
    expect(formatAge(120)).toBe("2 min ago");
    expect(formatAge(7200)).toBe("2 h ago");
    expect(formatAge(172800)).toBe("2 d ago");
  });

  it("labels delayed and stale data as such", () => {
    const { rerender } = render(<FreshnessBadge meta={liveMeta({ freshness: "DELAYED", ageSeconds: 300 })} />);
    expect(screen.getByTestId("freshness-badge")).toHaveTextContent(/Delayed/);
    rerender(<FreshnessBadge meta={liveMeta({ freshness: "STALE", ageSeconds: 9000 })} />);
    expect(screen.getByTestId("freshness-badge")).toHaveTextContent(/Stale/);
  });
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

describe("clock", () => {
  it("renders no time on the SERVER, so hydration cannot mismatch", () => {
    // The real guarantee, checked where it actually applies. Rendering a time
    // during SSR guarantees a mismatch, because the server's "now" is a
    // different instant from the client's. Testing-library flushes effects, so
    // this has to be observed through a server render rather than a mounted one.
    const html = renderToString(<ClockWidget />);
    expect(html).not.toContain("clock-time");
    expect(html).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("shows the real local time and date once mounted", async () => {
    render(<ClockWidget />);
    await waitFor(() => expect(screen.getByTestId("clock-time")).toBeInTheDocument());

    const shown = screen.getByTestId("clock-time").textContent ?? "";
    const expected = new Date().toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    // Compare to the minute: a second may tick between render and assertion.
    expect(shown.slice(0, 5)).toBe(expected.slice(0, 5));
  });

  it("honours the 12-hour preference", async () => {
    render(<ClockWidget hourFormat="12" />);
    await waitFor(() => expect(screen.getByTestId("clock-time")).toBeInTheDocument());
    expect(screen.getByTestId("clock-time").textContent).toMatch(/AM|PM/i);
  });

  it("switches to the analog face and reports the change", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ClockWidget mode="DIGITAL" onToggleMode={onToggle} />);
    await waitFor(() => expect(screen.getByTestId("clock-time")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("clock-mode-toggle"));
    expect(onToggle).toHaveBeenCalledWith("ANALOG");

    rerender(<ClockWidget mode="ANALOG" onToggleMode={onToggle} />);
    // The analog face has no digital readout, but still shows the date.
    expect(screen.queryByTestId("clock-time")).toBeNull();
    expect(screen.getByTestId("clock-date")).toBeInTheDocument();
  });

  it("places the hands where the time actually is", () => {
    // 3:00:00 — hour hand at 90°, minute and second at 0.
    const three = new Date(2026, 0, 1, 3, 0, 0);
    expect(handAngles(three)).toEqual({ hour: 90, minute: 0, second: 0 });

    // 6:30 — the hour hand must have crept half way past 6, not sit on it.
    const halfPastSix = new Date(2026, 0, 1, 6, 30, 0);
    expect(handAngles(halfPastSix).hour).toBe(195);
    expect(handAngles(halfPastSix).minute).toBe(180);
  });
});

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

describe("weather", () => {
  it("says what to do when no location is set, rather than showing zeros", async () => {
    render(<WeatherWidget location={null} />);
    await waitFor(() => expect(screen.getByTestId("widget-unavailable")).toBeInTheDocument());
    expect(screen.getByTestId("widget-unavailable")).toHaveTextContent(/No location set/i);
    expect(screen.queryByTestId("weather-temp")).toBeNull();
  });

  it("renders a real reading with its freshness", async () => {
    mocked.getWeather.mockResolvedValue({
      success: true,
      data: {
        value: {
          temperatureC: 29.6,
          feelsLikeC: 31.2,
          humidityPct: 72,
          windKph: 8,
          precipitationMm: 0,
          code: 2,
          isDay: true,
          sunrise: "2026-09-08T06:12:00",
          sunset: "2026-09-08T18:30:00",
          location: { latitude: 21.81, longitude: 80.18, timezone: "Asia/Kolkata", label: "Balaghat" },
          forecast: [
            { date: "2026-09-08", minC: 24, maxC: 31, code: 2 },
            { date: "2026-09-09", minC: 23, maxC: 30, code: 61 },
          ],
        },
        meta: liveMeta({ source: "Open-Meteo", ageSeconds: 800 }),
      },
      timestamp: ts(),
    } as never);

    render(<WeatherWidget location={{ latitude: 21.81, longitude: 80.18 }} />);
    await waitFor(() => expect(screen.getByTestId("weather-temp")).toHaveTextContent("30°"));
    // The label shares its paragraph with "· feels 31°", so match a substring.
    expect(screen.getByText(/Balaghat/)).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(screen.getByTestId("freshness-badge")).toHaveAttribute("data-freshness", "LIVE");
  });

  it("omits a figure the provider did not return", async () => {
    mocked.getWeather.mockResolvedValue({
      success: true,
      data: {
        value: {
          temperatureC: 18, feelsLikeC: null, humidityPct: null, windKph: null,
          precipitationMm: null, code: 0, isDay: true, sunrise: null, sunset: null,
          location: { latitude: 1, longitude: 1, timezone: "UTC" }, forecast: [],
        },
        meta: liveMeta(),
      },
      timestamp: ts(),
    } as never);

    render(<WeatherWidget location={{ latitude: 1, longitude: 1 }} />);
    await waitFor(() => expect(screen.getByTestId("weather-temp")).toBeInTheDocument());
    // No humidity row at all, rather than "0%".
    expect(screen.queryByText("Humidity")).toBeNull();
  });

  it("maps WMO codes to words", () => {
    expect(describeWeatherCode(0)).toBe("Clear");
    expect(describeWeatherCode(3)).toBe("Overcast");
    expect(describeWeatherCode(63)).toBe("Rain");
    expect(describeWeatherCode(95)).toBe("Thunderstorm");
  });
});

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

describe("markets", () => {
  it("shows the real top coins by market-cap rank", async () => {
    mocked.getCrypto.mockResolvedValue({
      success: true,
      data: {
        value: [
          { id: "bitcoin", symbol: "BTC", name: "Bitcoin", price: 78592, changePct24h: -0.97, marketCapRank: 1 },
          { id: "tether", symbol: "USDT", name: "Tether", price: 0.9996, changePct24h: -0.03, marketCapRank: 3 },
        ],
        meta: liveMeta({ source: "CoinGecko" }),
      },
      timestamp: ts(),
    } as never);

    render(<MarketsWidget />);
    await waitFor(() => expect(screen.getByTestId("crypto-list")).toBeInTheDocument());
    expect(screen.getByText("BTC")).toBeInTheDocument();
    // USDT, not a hard-coded SOL: the ranking is whatever the provider reports.
    expect(screen.getByText("USDT")).toBeInTheDocument();
  });

  it("states why NIFTY has no value instead of inventing one", async () => {
    render(<MarketsWidget indicesEnabled />);
    await waitFor(() => expect(screen.getByTestId("indices-unavailable")).toBeInTheDocument());
    expect(screen.queryByTestId("indices-list")).toBeNull();
  });

  it("does not even ask for indices when the server cannot serve them", async () => {
    render(<MarketsWidget indicesEnabled={false} />);
    await waitFor(() => expect(mocked.getCrypto).toHaveBeenCalled());
    expect(mocked.getIndices).not.toHaveBeenCalled();
  });

  it("gives crypto and indices their OWN freshness", async () => {
    mocked.getCrypto.mockResolvedValue({
      success: true,
      data: { value: [{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", price: 1, changePct24h: 0, marketCapRank: 1 }], meta: liveMeta() },
      timestamp: ts(),
    } as never);

    render(<MarketsWidget indicesEnabled />);
    // One card, two verdicts: crypto is live while indices are unavailable, and
    // a single shared badge would necessarily be wrong about one of them.
    await waitFor(() => expect(screen.getAllByTestId("freshness-badge").length).toBe(2));
    const values = screen.getAllByTestId("freshness-badge").map((n) => n.getAttribute("data-freshness"));
    expect(values).toContain("LIVE");
    expect(values).toContain("UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

describe("tasks", () => {
  const task = (over: Partial<api.TaskRecord> = {}): api.TaskRecord => ({
    id: "t1", title: "Call the client", description: null, dueAt: null,
    priority: "NORMAL", completedAt: null, createdAt: ts(), ...over,
  });

  it("buckets by when a task is actually due", () => {
    const now = new Date(2026, 8, 8, 12, 0, 0);
    expect(bucketFor(task({ dueAt: new Date(2026, 8, 7).toISOString() }), now)).toBe("OVERDUE");
    expect(bucketFor(task({ dueAt: new Date(2026, 8, 8, 18).toISOString() }), now)).toBe("TODAY");
    expect(bucketFor(task({ dueAt: new Date(2026, 8, 10).toISOString() }), now)).toBe("UPCOMING");
    // No due date is never overdue.
    expect(bucketFor(task({ dueAt: null }), now)).toBe("SOMEDAY");
  });

  it("lists what is due, grouped", async () => {
    mocked.listTasks.mockResolvedValue({
      success: true,
      data: { tasks: [task({ dueAt: new Date(Date.now() - 86400000).toISOString() })] },
      timestamp: ts(),
    } as never);

    render(<TasksWidget />);
    await waitFor(() => expect(screen.getByTestId("task-bucket-OVERDUE")).toBeInTheDocument());
    expect(screen.getByText("Call the client")).toBeInTheDocument();
  });

  it("creates a task through the server, not just on screen", async () => {
    mocked.createTask.mockResolvedValue({
      success: true, data: { task: task({ id: "new", title: "Review ads" }) }, timestamp: ts(),
    } as never);

    render(<TasksWidget />);
    await waitFor(() => expect(mocked.listTasks).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("task-add-toggle"));
    fireEvent.change(screen.getByTestId("task-title-input"), { target: { value: "Review ads" } });
    fireEvent.submit(screen.getByTestId("task-title-input").closest("form")!);

    // Persisted server-side — a reminder that lives in a tab is not a reminder.
    await waitFor(() => expect(mocked.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Review ads" })));
    await waitFor(() => expect(screen.getByText("Review ads")).toBeInTheDocument());
  });

  it("completes a task and stops showing it", async () => {
    mocked.listTasks.mockResolvedValue({ success: true, data: { tasks: [task()] }, timestamp: ts() } as never);
    mocked.updateTask.mockResolvedValue({ success: true, data: { task: task({ completedAt: ts() }) }, timestamp: ts() } as never);

    render(<TasksWidget />);
    await waitFor(() => expect(screen.getByText("Call the client")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("task-complete"));
    await waitFor(() => expect(mocked.updateTask).toHaveBeenCalledWith("t1", { completed: true }));
    await waitFor(() => expect(screen.queryByText("Call the client")).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// JARVIS work tasks
//
// A work task answers a different question from a todo. A todo asks WHEN IS
// THIS DUE; a work task asks DID IT RUN, AND DID IT WORK. They were previously
// hidden from this widget altogether, which protected them by making them
// invisible — so a task JARVIS had scheduled or run did not exist as far as
// the dashboard was concerned.
//
// They are now visible and READ-ONLY. The read-only part is rendered as an
// ABSENT control rather than a disabled one, because the server answers a
// PATCH or DELETE on these rows with a 404: a button that cannot do anything
// is a lie about what the page can change.
// ---------------------------------------------------------------------------

describe("tasks — JARVIS work", () => {
  const work = (over: Partial<api.TaskRecord> = {}): api.TaskRecord => ({
    id: "w1", title: "Check my system status", description: null, dueAt: null,
    priority: "NORMAL", completedAt: null, createdAt: ts(),
    createdBy: "jarvis", status: "PENDING", scheduledAt: null,
    startedAt: null, error: null, ...over,
  });

  const todo = (over: Partial<api.TaskRecord> = {}): api.TaskRecord => ({
    id: "t1", title: "Call the client", description: null, dueAt: null,
    priority: "NORMAL", completedAt: null, createdAt: ts(), createdBy: null, ...over,
  });

  const listing = (tasks: api.TaskRecord[]) =>
    mocked.listTasks.mockResolvedValue({ success: true, data: { tasks }, timestamp: ts() } as never);

  it("shows a JARVIS work task, in its own section, with a badge", async () => {
    listing([work()]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-jarvis-section")).toBeInTheDocument());
    expect(screen.getByTestId("task-jarvis-badge")).toHaveTextContent("JARVIS");
    expect(screen.getByText("Check my system status")).toBeInTheDocument();
  });

  it("asks the server for completed rows, so a finished run is visible", async () => {
    listing([work({ status: "COMPLETED", completedAt: ts() })]);
    render(<TasksWidget />);

    await waitFor(() => expect(mocked.listTasks).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByTestId("task-work-COMPLETED")).toBeInTheDocument());
  });

  it("groups by lifecycle state, not by due date", async () => {
    listing([
      work({ id: "a", title: "Running one", status: "RUNNING" }),
      work({ id: "b", title: "Pending one", status: "PENDING" }),
      work({ id: "c", title: "Failed one", status: "FAILED", error: "nope" }),
      work({ id: "d", title: "Done one", status: "COMPLETED", completedAt: ts() }),
    ]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-work-RUNNING")).toBeInTheDocument());
    for (const status of ["RUNNING", "PENDING", "FAILED", "COMPLETED"]) {
      expect(screen.getByTestId(`task-work-${status}`)).toBeInTheDocument();
    }
    // None of them fell into the due-date buckets.
    expect(screen.queryByTestId("task-bucket-SOMEDAY")).toBeNull();
  });

  it("shows the scheduled time, labelled as such", async () => {
    const at = new Date();
    at.setHours(at.getHours() + 2, 45, 0, 0);
    listing([work({ scheduledAt: at.toISOString() })]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-work-detail")).toBeInTheDocument());
    const detail = screen.getByTestId("task-work-detail").textContent ?? "";
    expect(detail).toMatch(/^Scheduled /);
    expect(detail).toMatch(/\d/);
  });

  it("says UNSCHEDULED for a pending task that will never run", async () => {
    // The historical rows: recorded before the scheduler stopped folding the
    // time phrase into the goal, so PENDING with no scheduledAt. Nothing will
    // pick them up, and plain "Pending" would imply a run that is coming.
    listing([work({ title: "In 3 minutes check my system status", scheduledAt: null })]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-work-detail")).toBeInTheDocument());
    expect(screen.getByTestId("task-work-detail")).toHaveTextContent("Unscheduled");
    // It is still PENDING — this is a label, not a state change.
    expect(screen.getByTestId("task-work-PENDING")).toBeInTheDocument();
  });

  it("shows no detail line for a completed run with no schedule", async () => {
    listing([work({ status: "COMPLETED", completedAt: ts(), scheduledAt: null })]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-work-COMPLETED")).toBeInTheDocument());
    expect(screen.queryByTestId("task-work-detail")).toBeNull();
  });

  it("renders NO complete and NO delete control for work", async () => {
    listing([work()]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-jarvis-section")).toBeInTheDocument());
    expect(screen.queryByTestId("task-complete")).toBeNull();
    expect(screen.queryByLabelText(/^Delete "Check my system status"$/)).toBeNull();
    expect(screen.queryByLabelText(/^Mark "Check my system status" complete$/)).toBeNull();
  });

  it("states the status for a reader who cannot see colour", async () => {
    listing([work({ status: "FAILED", error: "could not be planned" })]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-work-FAILED")).toBeInTheDocument());
    expect(screen.getByTestId("task-work-row").textContent).toContain("Failed");
  });

  it("shows WHY a run failed, not just that it did", async () => {
    listing([work({ status: "FAILED", error: "could not be planned" })]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-work-detail")).toBeInTheDocument());
    expect(screen.getByTestId("task-work-detail")).toHaveTextContent("could not be planned");
  });

  it("still marks a failure when no reason was recorded", async () => {
    listing([work({ status: "FAILED", error: null })]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-work-detail")).toBeInTheDocument());
    expect(screen.getByTestId("task-work-detail")).toHaveTextContent("Failed");
  });

  it("renders the two halves under their own headings, work FIRST", async () => {
    listing([work(), todo()]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-jarvis-heading")).toBeInTheDocument());
    expect(screen.getByTestId("task-jarvis-heading")).toHaveTextContent(/JARVIS/);
    expect(screen.getByTestId("task-mine-heading")).toHaveTextContent(/My Tasks/i);

    // Order on the page, not just presence: work is above the todo buckets.
    const jarvis = screen.getByTestId("task-jarvis-section");
    const mine = screen.getByTestId("task-mine-heading");
    expect(jarvis.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the counts each group actually holds", async () => {
    listing([
      work({ id: "a", status: "PENDING" }),
      work({ id: "b", status: "PENDING" }),
      work({ id: "c", status: "COMPLETED", completedAt: ts() }),
    ]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-work-PENDING")).toBeInTheDocument());
    expect(screen.getByTestId("task-work-PENDING").textContent).toMatch(/Pending · 2/);
    expect(screen.getByTestId("task-work-COMPLETED").textContent).toMatch(/Done · 1/);
  });

  it("renders NO group for a state with nothing in it", async () => {
    listing([work({ status: "PENDING" })]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-work-PENDING")).toBeInTheDocument());
    for (const empty of ["RUNNING", "FAILED", "COMPLETED"]) {
      expect(screen.queryByTestId(`task-work-${empty}`)).toBeNull();
    }
  });

  it("omits the MY TASKS heading when there is no work to distinguish it from", async () => {
    // A dashboard that never uses JARVIS keeps exactly the widget it had.
    listing([todo()]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByText("Call the client")).toBeInTheDocument());
    expect(screen.queryByTestId("task-mine-heading")).toBeNull();
    expect(screen.queryByTestId("task-jarvis-heading")).toBeNull();
  });

  it("leaves ordinary todos with their controls, beside the work section", async () => {
    listing([work(), todo()]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-jarvis-section")).toBeInTheDocument());

    // Both visible…
    expect(screen.getByText("Check my system status")).toBeInTheDocument();
    expect(screen.getByText("Call the client")).toBeInTheDocument();

    // …and exactly ONE complete button: the todo's.
    expect(screen.getAllByTestId("task-complete")).toHaveLength(1);
    expect(screen.getByLabelText('Mark "Call the client" complete')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete "Call the client"')).toBeInTheDocument();
  });

  it("completing a todo still reaches the server when work is on screen too", async () => {
    listing([work(), todo()]);
    mocked.updateTask.mockResolvedValue({ success: true, data: { task: todo() }, timestamp: ts() } as never);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByText("Call the client")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("task-complete"));

    await waitFor(() => expect(mocked.updateTask).toHaveBeenCalledWith("t1", { completed: true }));
  });

  it("hides completed TODOS, as it always did", async () => {
    // The widget now fetches completed rows for the work section; a completed
    // todo must still not reappear in the buckets.
    listing([todo({ completedAt: ts() })]);
    render(<TasksWidget />);

    await waitFor(() => expect(mocked.listTasks).toHaveBeenCalled());
    expect(screen.queryByText("Call the client")).toBeNull();
  });

  it("shows no work section at all when there is no work", async () => {
    listing([todo()]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByText("Call the client")).toBeInTheDocument());
    expect(screen.queryByTestId("task-jarvis-section")).toBeNull();
  });

  it("falls back to completedAt for a row written before `status` existed", () => {
    expect(workStatusOf({ ...work(), status: undefined })).toBe("PENDING");
    expect(workStatusOf({ ...work(), status: undefined, completedAt: ts() })).toBe("COMPLETED");
    expect(workStatusOf({ ...work(), status: "running" })).toBe("RUNNING");
    // An unknown value must render, not crash.
    expect(workStatusOf({ ...work(), status: "SOMETHING_NEW" })).toBe("PENDING");
  });

  it("orders the groups RUNNING, PENDING, FAILED, COMPLETED", async () => {
    listing([
      work({ id: "d", status: "COMPLETED", completedAt: ts() }),
      work({ id: "c", status: "FAILED" }),
      work({ id: "b", status: "PENDING" }),
      work({ id: "a", status: "RUNNING" }),
    ]);
    render(<TasksWidget />);

    await waitFor(() => expect(screen.getByTestId("task-work-RUNNING")).toBeInTheDocument());
    // Seeded in the OPPOSITE order, so this cannot pass by accident.
    const onPage = screen
      .getAllByTestId(/^task-work-(RUNNING|PENDING|FAILED|COMPLETED)$/)
      .map((el) => el.getAttribute("data-testid"));
    expect(onPage).toEqual([
      "task-work-RUNNING",
      "task-work-PENDING",
      "task-work-FAILED",
      "task-work-COMPLETED",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

describe("map", () => {
  // With no Google browser key — this deployment's real state — the widget must
  // stay on the dashboard, explain what is missing, and draw NO map. There is
  // no honest substitute for an interactive Google map, so it does not invent
  // one.
  beforeEach(() => {
    mocked.getMapsConfig.mockResolvedValue({
      success: true,
      data: {
        browserKey: null,
        mapsAvailable: false,
        serverGeoAvailable: false,
        reason: "No Google Maps keys are set",
      },
      timestamp: ts(),
    } as never);
  });

  it("stays on the dashboard when Google Maps is unconfigured", async () => {
    render(<MapWidget />);
    await waitFor(() =>
      expect(screen.getByTestId("map-config-required")).toBeInTheDocument()
    );
    expect(screen.getByTestId("widget-map")).toBeInTheDocument();
  });

  it("draws NO map rather than a substitute", async () => {
    render(<MapWidget />);
    await waitFor(() => expect(screen.getByTestId("map-config-required")).toBeInTheDocument());
    // The absence of this element is the point: a hand-drawn map inside a
    // widget labelled Google Maps would be exactly the fake being avoided.
    expect(screen.queryByTestId("google-map")).toBeNull();
  });

  it("names the variables that would switch it on, and links to settings", async () => {
    render(<MapWidget />);
    await waitFor(() => expect(screen.getByTestId("map-config-required")).toBeInTheDocument());

    const panel = screen.getByTestId("map-config-required");
    expect(panel).toHaveTextContent("GOOGLE_MAPS_BROWSER_KEY");
    expect(panel.querySelector('a[href="/settings/connections"]')).not.toBeNull();
  });

  it("says JARVIS can still answer distance questions meanwhile", async () => {
    // Geocoding and routing fall back to OpenStreetMap, so the honest message
    // is "the map needs a key", not "location does not work".
    render(<MapWidget />);
    await waitFor(() => expect(screen.getByTestId("map-config-required")).toBeInTheDocument());
    expect(screen.getByTestId("map-config-required")).toHaveTextContent(/OpenStreetMap/i);
  });

  it("offers a retry when the SDK itself fails to load", async () => {
    mocked.getMapsConfig.mockResolvedValue({
      success: false,
      error: { code: "NETWORK_ERROR", message: "Network request failed" },
      timestamp: ts(),
    } as never);

    render(<MapWidget />);
    await waitFor(() => expect(screen.getByTestId("map-load-error")).toBeInTheDocument());
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("widget registry", () => {
  const caps = (over: Partial<api.CommandCenterCapabilities> = {}): api.CommandCenterCapabilities => ({
    weather: true, crypto: true, indices: false, geo: true, system: true, tasks: true, ...over,
  });

  it("shows the default set when the user has no preference", () => {
    const ids = resolveWidgets(caps()).map((w) => w.id);
    expect(ids).toContain("clock");
    expect(ids).toContain("system");
    // The map does nothing until typed into, so it is off until asked for.
    expect(ids).not.toContain("map");
  });

  it("hides a widget whose provider this deployment cannot serve", () => {
    // Better than a widget permanently reporting "unavailable".
    const ids = resolveWidgets(caps({ weather: false })).map((w) => w.id);
    expect(ids).not.toContain("weather");
  });

  it("honours the user's order", () => {
    const ids = resolveWidgets(caps(), ["system", "clock"]).map((w) => w.id);
    expect(ids.slice(0, 2)).toEqual(["system", "clock"]);
  });

  it("drops ids a newer build no longer knows", () => {
    // A preference written by an older build must not resurrect a dead widget.
    const ids = resolveWidgets(caps(), ["clock", "stock-ticker-2019"]).map((w) => w.id);
    expect(ids).toContain("clock");
    expect(ids).not.toContain("stock-ticker-2019" as never);
  });

  it("shows a NEW widget to a user whose saved list predates it", () => {
    // Appended rather than hidden, or shipping a widget would make it invisible
    // to every existing user.
    const ids = resolveWidgets(caps(), ["clock"]).map((w) => w.id);
    expect(ids).toContain("clock");
    expect(ids.length).toBeGreaterThan(1);
  });

  it("respects an explicitly hidden widget", () => {
    const ids = resolveWidgets(caps(), undefined, ["system"]).map((w) => w.id);
    expect(ids).not.toContain("system");
  });

  it("declares a capability for every widget that needs a provider", () => {
    for (const widget of WIDGETS) {
      if (widget.id === "clock") continue; // reads the local clock, needs nothing
      expect(widget.capability, `${widget.id} must declare its provider`).toBeTruthy();
    }
  });
});
