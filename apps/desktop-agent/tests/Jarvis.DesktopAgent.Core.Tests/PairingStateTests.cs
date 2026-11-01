// ---------------------------------------------------------------------------
// Phase 19.6 — a pairing as the tray shows it: from the server's answer, through
// the person confirming in the browser, to the agent being started again.
//
// The person confirms with the pairing window still open, so no step here closes
// a window: everything these tests expect must already be true while it is open.
// The client, the signed answers and the poll loop are the real ones; each
// RunningAgent is what one run of TrayApp holds, without the tray.
// ---------------------------------------------------------------------------

using Xunit;

namespace Jarvis.DesktopAgent.Core.Tests;

public sealed class PairingStateTests : IDisposable
{
    private const string Code = "7K3M-Q9X2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01";
    private const string Waiting = "Waiting for confirmation in JARVIS";
    private const string Confirmed = "Paired — control not allowed";
    private static readonly DeviceFacts Facts = new("PC", 26100, "x64");

    private readonly FakeServer server = new();
    private readonly HttpClient http;
    private readonly TestDeviceKey key = new();
    private readonly TestClock clock = new();
    private readonly MemorySink sink = new();
    private readonly MemoryPairingStore store = new();
    private readonly AgentLog log;
    private readonly List<RunningAgent> runs = [];

    /// <summary>What the server would say about the device; the browser's confirmation changes it.</summary>
    private string deviceOnServer = "pending";

    public PairingStateTests()
    {
        http = new HttpClient(server);
        log = new AgentLog(sink, clock);
        server.Respond = request => request.Path.EndsWith("/pair", StringComparison.Ordinal)
            ? (200, PairAnswer())
            : (200, $$"""{"version":"jarvis-desktop/1","device":{"status":"{{deviceOnServer}}"},"grant":null,"command":null}""");
    }

    public void Dispose()
    {
        foreach (var run in runs) run.Dispose();
        http.Dispose();
        key.Dispose();
    }

    private string PairAnswer() => System.Text.Json.JsonSerializer.Serialize(new Dictionary<string, string>
    {
        ["version"] = ProtocolConstants.ProtocolVersion,
        ["deviceId"] = Commands.DeviceId,
        ["fingerprint"] = Fingerprint.Of(key.PublicKeySpki),
        ["status"] = "pending",
        ["serverKeyId"] = Contract.ServerKeyId,
        ["serverPublicKey"] = Contract.ServerSpki,
        ["userLabel"] = "Ada Lovelace",
        ["organizationLabel"] = "Analytical Engines",
    });

    private AgentClient Client() => new(http, ClientTests.Origin, key, clock);

    private RunningAgent Run()
    {
        var run = new RunningAgent(this);
        runs.Add(run);
        return run;
    }

    /// <summary>One run of the agent: everything TrayApp wires together, except the windows.</summary>
    private sealed class RunningAgent : IAgentEvents, IDisposable
    {
        private readonly PairingStateTests test;
        private readonly GrantManager grants;
        private AgentLoop? loop;
        private CancellationTokenSource? stop;

        public RunningAgent(PairingStateTests test)
        {
            this.test = test;
            grants = new GrantManager(test.clock);
            State = new PairingState(test.store, test.log, Start);
        }

        public PairingState State { get; }

        public List<(Uri Server, Pairing Pairing)> Started { get; } = [];

        public TrayView View => TrayView.Of(State.Current is not null, State.DeviceStatus, State.Connected, halted: false, grants.Active is not null);

        private void Start(Uri server, Pairing paired)
        {
            Started.Add((server, paired));
            var verifier = new CommandVerifier(paired.ServerPublicKey, paired.DeviceId, grants, test.clock);
            var runner = new CommandRunner(verifier, grants, new FakeInspector(), new FakeInjector(), new FakeHello(), new FakeSession(), test.log, new FakeLauncher(), TimeSpan.Zero);
            loop?.Dispose();
            loop = new AgentLoop(new AgentClient(test.http, server, test.key, test.clock), paired, grants, verifier, runner, test.store, this, test.log, test.clock, 26100, (_, _) =>
            {
                stop!.Cancel();
                return Task.CompletedTask;
            });
        }

        /// <summary>One exchange with the server, ending at the loop's first wait.</summary>
        public async Task PollOnce()
        {
            stop?.Dispose();
            stop = new CancellationTokenSource();
            await loop!.RunAsync(stop.Token);
        }

        public void DeviceStatusChanged(string status) => State.Heard(status);

        public void ConnectionChanged(bool connected) => State.Reached(connected);

        public void Stopped(string reason)
        {
        }

        public void Dispose()
        {
            loop?.Dispose();
            stop?.Dispose();
            grants.Dispose();
        }
    }

    [Fact]
    public async Task Shows_a_paired_device_through_confirmation_and_a_restart()
    {
        // The window has said "Paired, and waiting for confirmation." It stays open.
        var first = Run();
        var (paired, error) = await first.State.PairAsync(Client(), Code, Facts, CancellationToken.None);
        Assert.Null(error);
        Assert.Equal(Commands.DeviceId, paired!.DeviceId);
        Assert.Equal(Waiting, first.View.Status);

        await first.PollOnce();
        Assert.Equal(Waiting, first.View.Status);
        Assert.False(first.View.CanAllow);

        // The person confirms the fingerprint in the browser.
        deviceOnServer = "active";
        await first.PollOnce();
        Assert.Equal(Confirmed, first.View.Status);
        Assert.True(first.View.CanAllow);

        // The agent is started again.
        var second = Run();
        Assert.Equal("Not paired", second.View.Status);
        second.State.Restore(() => true);
        Assert.Equal("Not connected", second.View.Status);
        await second.PollOnce();
        Assert.Equal(Confirmed, second.View.Status);
        Assert.True(second.View.CanAllow);
        Assert.False(store.Cleared);
    }

    [Fact]
    public async Task Keeps_the_pairing_as_soon_as_the_answer_verifies()
    {
        var run = Run();
        await run.State.PairAsync(Client(), Code, Facts, CancellationToken.None);

        Assert.Equal(Commands.DeviceId, store.Stored?.DeviceId);
        Assert.Equal(Contract.ServerSpki, store.Stored?.ServerPublicKey);
        Assert.Equal("Ada Lovelace", store.Stored?.UserLabel);
        Assert.Equal(ClientTests.Origin, store.Server);
        Assert.Equal(store.Stored, run.State.Current);
    }

    [Fact]
    public async Task Starts_polling_as_soon_as_the_answer_verifies()
    {
        var run = Run();
        await run.State.PairAsync(Client(), Code, Facts, CancellationToken.None);

        var (origin, pairing) = Assert.Single(run.Started);
        Assert.Equal(ClientTests.Origin, origin);
        Assert.Equal(Commands.DeviceId, pairing.DeviceId);
    }

    [Fact]
    public async Task Logs_a_kept_pairing_by_its_hash_only()
    {
        await Run().State.PairAsync(Client(), Code, Facts, CancellationToken.None);

        Assert.Contains($"device.paired deviceIdHash={AgentLog.DeviceIdHash(Commands.DeviceId)}", sink.All, StringComparison.Ordinal);
        Assert.DoesNotContain(Commands.DeviceId, sink.All, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_restarted_agent_never_says_a_confirmed_device_is_waiting()
    {
        await Run().State.PairAsync(Client(), Code, Facts, CancellationToken.None);
        deviceOnServer = "active";

        // Nothing is known of the device until the server answers, so nothing is claimed.
        server.Unreachable = true;
        var restarted = Run();
        restarted.State.Restore(() => true);
        await restarted.PollOnce();
        Assert.Equal("Not connected", restarted.View.Status);
        Assert.False(restarted.View.CanAllow);
    }

    [Fact]
    public async Task An_answer_that_says_nothing_of_the_device_confirms_nothing()
    {
        await Run().State.PairAsync(Client(), Code, Facts, CancellationToken.None);
        deviceOnServer = "active";

        // A signed refusal: the server is there, and it has not said what the device is.
        server.Respond = _ => (429, FakeServer.Error("RATE_LIMITED"));
        var restarted = Run();
        restarted.State.Restore(() => true);
        await restarted.PollOnce();
        Assert.True(restarted.State.Connected);
        Assert.Null(restarted.State.DeviceStatus);
        Assert.False(restarted.View.CanAllow);
    }

    [Fact]
    public async Task A_restart_before_confirmation_is_still_waiting_once_the_server_says_so()
    {
        await Run().State.PairAsync(Client(), Code, Facts, CancellationToken.None);

        var restarted = Run();
        restarted.State.Restore(() => true);
        await restarted.PollOnce();
        Assert.Equal(Waiting, restarted.View.Status);
    }

    [Fact]
    public async Task Restarts_with_the_address_the_pairing_was_made_with()
    {
        await Run().State.PairAsync(Client(), Code, Facts, CancellationToken.None);

        var restarted = Run();
        restarted.State.Restore(() => true);
        Assert.Equal(ClientTests.Origin, Assert.Single(restarted.Started).Server);
    }

    [Fact]
    public async Task A_new_pairing_owes_nothing_to_the_device_before_it()
    {
        var run = Run();
        await run.State.PairAsync(Client(), Code, Facts, CancellationToken.None);
        deviceOnServer = "active";
        await run.PollOnce();
        Assert.Equal(Confirmed, run.View.Status);

        run.State.Forget();
        Assert.Equal("Not paired", run.View.Status);
        Assert.Null(run.State.DeviceStatus);
        Assert.False(run.State.Connected);

        run.State.Heard("active");
        run.State.Reached(true);
        await run.State.PairAsync(Client(), Code, Facts, CancellationToken.None);
        Assert.Equal(Waiting, run.View.Status);
        Assert.Equal("pending", run.State.DeviceStatus);
        Assert.False(run.State.Connected);
        Assert.False(run.View.CanAllow);
    }

    public static TheoryData<Exception> SaveFailures => new()
    {
        new IOException("the disk is full"),
        new UnauthorizedAccessException("the folder refused"),
    };

    [Theory]
    [MemberData(nameof(SaveFailures))]
    public async Task A_pairing_that_cannot_be_saved_is_not_a_pairing(Exception failure)
    {
        store.SaveFails = failure;
        var run = Run();
        var (paired, error) = await run.State.PairAsync(Client(), Code, Facts, CancellationToken.None);

        Assert.Null(paired);
        Assert.Equal(PairingState.NotSaved, error);
        Assert.Null(run.State.Current);
        Assert.Empty(run.Started);
        Assert.Equal("Not paired", run.View.Status);
        Assert.Contains("pair.save.failed", sink.All, StringComparison.Ordinal);
        Assert.DoesNotContain("device.paired", sink.All, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Gives_up_the_key_of_a_pairing_it_could_not_save()
    {
        // The server never accepts a key twice, so a retry needs a new one.
        store.SaveFails = new IOException("the disk is full");
        await Run().State.PairAsync(Client(), Code, Facts, CancellationToken.None);
        Assert.True(store.Cleared);
        Assert.Null(store.Server);
    }

    [Fact]
    public async Task Still_says_not_saved_when_the_clearing_fails_too()
    {
        store.SaveFails = new IOException("the disk is full");
        store.ClearThrows = true;
        var (paired, error) = await Run().State.PairAsync(Client(), Code, Facts, CancellationToken.None);
        Assert.Null(paired);
        Assert.Equal(PairingState.NotSaved, error);
        Assert.Contains("pairing.clear.failed", sink.All, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_refused_code_keeps_nothing()
    {
        server.Respond = _ => (403, FakeServer.Error("PAIRING_CODE_INVALID"));
        var run = Run();
        var (paired, error) = await run.State.PairAsync(Client(), Code, Facts, CancellationToken.None);

        Assert.Null(paired);
        Assert.Equal("PAIRING_CODE_INVALID", error);
        Assert.Null(store.Stored);
        Assert.False(store.Cleared);
        Assert.Empty(run.Started);
    }

    [Fact]
    public async Task An_answer_that_does_not_verify_keeps_nothing()
    {
        server.SignatureOverride = new string('A', 86);
        var run = Run();
        var (paired, error) = await run.State.PairAsync(Client(), Code, Facts, CancellationToken.None);

        Assert.Null(paired);
        Assert.Null(error);
        Assert.Null(store.Stored);
        Assert.False(store.Cleared);
        Assert.Empty(run.Started);
        Assert.Contains($"pair.failed code={AgentFailure.ResponseNotSigned}", sink.All, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_pairing_without_its_key_is_no_pairing()
    {
        await Run().State.PairAsync(Client(), Code, Facts, CancellationToken.None);

        var restarted = Run();
        restarted.State.Restore(() => false);
        Assert.Equal("Not paired", restarted.View.Status);
        Assert.Empty(restarted.Started);
        Assert.True(store.Cleared);
    }

    [Fact]
    public void Looks_for_no_key_when_nothing_was_kept()
    {
        var run = Run();
        run.State.Restore(() => throw new InvalidOperationException("no pairing, so no key to open"));
        Assert.Equal("Not paired", run.View.Status);
        Assert.Empty(run.Started);
        Assert.False(store.Cleared);
    }
}
