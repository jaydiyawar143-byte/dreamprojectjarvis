// ---------------------------------------------------------------------------
// Phase 19.6 — the agent as the person sees it: a tray icon.
//
// From the tray the person pairs the computer, allows control (the consent
// screen), extends it (fresh consent), and stops it. While control is allowed
// the indicator bar is on screen. Nothing here takes control on its own: a
// grant starts only from the consent screen, and the server's poll loop only
// runs commands under one.
// ---------------------------------------------------------------------------

using Jarvis.DesktopAgent.Core;
using Jarvis.DesktopAgent.Windows;

namespace Jarvis.DesktopAgent.UI;

internal sealed class TrayApp : ApplicationContext, IAgentEvents
{
    private readonly SynchronizationContext ui;
    private readonly SystemClock clock = new();
    private readonly GrantManager grants;
    private readonly InputHooks hooks;
    private readonly SessionMonitor session;
    private readonly IndicatorForm indicator;
    private readonly AgentLog log;
    private readonly FilePairingStore store;
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem status = new("Not paired") { Enabled = false };
    private readonly ToolStripMenuItem pairItem = new("Pair this computer…");
    private readonly ToolStripMenuItem allowItem = new("Allow control…");
    private readonly ToolStripMenuItem extendItem = new("Extend control…");
    private readonly ToolStripMenuItem stopItem = new("Stop control");
    private readonly HttpClient http;
    private readonly nint helloOwner;

    private CngDeviceKey? key;
    private Pairing? pairing;
    private AgentLoop? loop;
    private CancellationTokenSource? running;
    private string deviceStatus = "pending";
    private bool connected;

    public TrayApp()
    {
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        grants = new GrantManager(clock);
        log = new AgentLog(new FileLogSink(Platform.DataDirectory), clock);
        store = new FilePairingStore(Platform.DataDirectory);
        // Off the hook thread at once: a low-level hook must return quickly, and
        // ending the grant cancels any command in progress immediately.
        hooks = new InputHooks(() => ThreadPool.QueueUserWorkItem(_ => grants.End("kill-switch")));
        session = new SessionMonitor(grants);
        indicator = new IndicatorForm(clock, () => grants.Active, () => grants.End("user"));
        indicator.CreateControl();
        helloOwner = indicator.Handle;
        http = new HttpClient(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectTimeout = TimeSpan.FromSeconds(10),
        })
        {
            Timeout = TimeSpan.FromMilliseconds(ProtocolConstants.PollHoldMs + 25_000),
        };

        grants.Ended += (_, _) => ui.Post(_ => Refresh(), null);

        var menu = new ContextMenuStrip();
        menu.Items.AddRange([status, new ToolStripSeparator(), pairItem, allowItem, extendItem, stopItem, new ToolStripSeparator(), new ToolStripMenuItem("Quit", null, (_, _) => Quit())]);
        pairItem.Click += (_, _) => ShowPairing();
        allowItem.Click += async (_, _) => await ConsentAsync(extend: false).ConfigureAwait(true);
        extendItem.Click += async (_, _) => await ConsentAsync(extend: true).ConfigureAwait(true);
        stopItem.Click += (_, _) => grants.End("user");
        tray = new NotifyIcon { Icon = SystemIcons.Shield, Text = "JARVIS desktop agent", ContextMenuStrip = menu, Visible = true };

        log.Write("agent.started", ("agentVersion", ProtocolConstants.AgentVersion), ("windowsBuild", Platform.WindowsBuild));
        pairing = store.Load();
        if (pairing is not null && store.Server is not null)
        {
            // A pairing without its key is no pairing: the key never comes back.
            key = CngDeviceKey.TryOpen();
            if (key is null)
            {
                store.Clear();
                pairing = null;
            }
            else
            {
                Start(store.Server, pairing);
            }
        }
        Refresh();
    }

    // ---- Pairing -----------------------------------------------------------

    private void ShowPairing()
    {
        if (pairing is not null)
        {
            var answer = MessageBox.Show("This computer is already paired. Pair it again? The current pairing stops working.", "JARVIS", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (answer != DialogResult.Yes) return;
            StopLoop();
            grants.End("user");
            store.Clear();
            pairing = null;
            key?.Dispose();
            key = null;
        }
        key ??= CngDeviceKey.OpenOrCreate();
        using var form = new PairingForm(async (origin, code) =>
        {
            var client = new AgentClient(http, origin, key, clock);
            try
            {
                return await client.PairAsync(code, new DeviceFacts(Environment.MachineName, Platform.WindowsBuild, "x64"), CancellationToken.None).ConfigureAwait(true);
            }
            catch (AgentTransportException)
            {
                return (null, null);
            }
        });
        form.ShowDialog();
        if (form.Paired is { } paired && form.Server is { } origin)
        {
            pairing = new Pairing(paired.DeviceId, paired.ServerPublicKey, paired.ServerKeyId, paired.UserLabel, paired.OrganizationLabel);
            store.Remember(origin);
            store.Save(pairing);
            log.Write("device.paired", ("deviceId", paired.DeviceId));
            Start(origin, pairing);
        }
        Refresh();
    }

    // ---- Consent -----------------------------------------------------------

    private async Task ConsentAsync(bool extend)
    {
        if (pairing is null || loop is null || deviceStatus != "active") return;
        using var form = new ConsentForm(pairing, hooks, extend);
        if (form.ShowDialog() != DialogResult.OK) return;
        var error = await loop.StartGrantAsync(form.Scope, form.Minutes, form.ShownText, extend, CancellationToken.None).ConfigureAwait(true);
        if (error is not null)
        {
            tray.ShowBalloonTip(5000, "JARVIS", error switch
            {
                "GRANT_CONFLICT" => "Control is already allowed. Use Extend to change it.",
                "CONSENT_MISMATCH" => "The consent text no longer matches the server's. Update the agent.",
                "UNAVAILABLE" => "The server could not be reached. Control was not allowed.",
                _ => "Control was not allowed.",
            }, ToolTipIcon.Warning);
        }
        Refresh();
    }

    // ---- The loop ----------------------------------------------------------

    private void Start(Uri origin, Pairing paired)
    {
        StopLoop();
        var client = new AgentClient(http, origin, key!, clock);
        var verifier = new CommandVerifier(paired.ServerPublicKey, paired.DeviceId, grants, clock);
        var runner = new CommandRunner(verifier, grants, new DesktopInspector(), new SendInputInjector(), new WindowsHelloVerifier(() => helloOwner), session, log);
        loop = new AgentLoop(client, paired, grants, verifier, runner, store, this, log, clock, Platform.WindowsBuild);
        running = new CancellationTokenSource();
        var token = running.Token;
        var current = loop;
        _ = Task.Run(async () =>
        {
            try
            {
                await current.RunAsync(token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        });
    }

    private void StopLoop()
    {
        running?.Cancel();
        running?.Dispose();
        running = null;
        loop?.Dispose();
        loop = null;
    }

    public void DeviceStatusChanged(string value) => ui.Post(_ =>
    {
        deviceStatus = value;
        Refresh();
    }, null);

    public void ConnectionChanged(bool value) => ui.Post(_ =>
    {
        connected = value;
        Refresh();
    }, null);

    public void Stopped(string reason) => ui.Post(_ =>
    {
        StopLoop();
        if (reason == "revoked")
        {
            pairing = null;
            key?.Dispose();
            key = null;
        }
        tray.ShowBalloonTip(8000, "JARVIS", reason switch
        {
            "revoked" => "This computer was removed from JARVIS. Pair it again to use it.",
            "unsupported" => "This agent or this version of Windows is no longer supported. Update to continue.",
            _ => "This computer's owner can no longer use it with JARVIS.",
        }, ToolTipIcon.Warning);
        Refresh();
    }, null);

    private void Refresh()
    {
        var grant = grants.Active;
        indicator.ShowGrant(grant);
        status.Text = pairing is null ? "Not paired"
            : deviceStatus == "pending" ? "Waiting for confirmation in JARVIS"
            : !connected ? "Not connected"
            : grant is null ? "Paired — control not allowed"
            : "Control allowed";
        pairItem.Enabled = grant is null;
        allowItem.Enabled = pairing is not null && deviceStatus == "active" && connected && grant is null;
        extendItem.Enabled = grant is not null;
        stopItem.Enabled = grant is not null;
    }

    private void Quit()
    {
        grants.End("shutdown");
        StopLoop();
        tray.Visible = false;
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            grants.End("shutdown");
            StopLoop();
            hooks.Dispose();
            session.Dispose();
            indicator.Dispose();
            tray.Dispose();
            http.Dispose();
            key?.Dispose();
            grants.Dispose();
        }
        base.Dispose(disposing);
    }
}
