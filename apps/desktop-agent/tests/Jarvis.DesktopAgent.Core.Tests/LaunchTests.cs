// ---------------------------------------------------------------------------
// Phase 19.7 — how an approved application is opened, with the launcher faked:
// no process is started anywhere. A launch runs only under everything a click
// runs under, by an id the server signed; it asks for no Windows Hello and
// types nothing; what it reports is what Windows said.
// ---------------------------------------------------------------------------

using System.Text.Json;
using Jarvis.DesktopAgent.Core;
using Xunit;

namespace Jarvis.DesktopAgent.Core.Tests;

public sealed class LaunchTests : IDisposable
{
    private readonly TestClock clock = new();
    private readonly GrantManager grants;
    private readonly CommandVerifier verifier;
    private readonly FakeInspector inspector = new();
    private readonly FakeInjector injector = new();
    private readonly FakeHello hello = new();
    private readonly FakeSession session = new();
    private readonly FakeLauncher launcher = new();
    private readonly MemorySink sink = new();
    private readonly CommandRunner runner;

    public LaunchTests()
        : this(null)
    {
    }

    private LaunchTests(TimeSpan? focusWait)
    {
        grants = new GrantManager(clock);
        verifier = new CommandVerifier(Contract.ServerSpki, Commands.DeviceId, grants, clock);
        runner = new CommandRunner(verifier, grants, inspector, injector, hello, session, new AgentLog(sink, clock), launcher, focusWait ?? TimeSpan.Zero);
    }

    public void Dispose() => grants.Dispose();

    private LocalGrant Allow(params string[] scope)
    {
        var grant = grants.Prepare(scope.Length > 0 ? scope : ProtocolConstants.CommandActions, 15, new string('a', 64));
        Assert.True(grants.Activate(grant, null));
        return grant;
    }

    private async Task<CommandOutcome> Run(LocalGrant grant, string app = "notepad")
    {
        var command = Commands.Sign(new LaunchParams(app), grant.GrantId, clock.NowMs);
        Assert.True(verifier.Check(command, clock.NowMs).Accepted);
        return await runner.RunAsync(command, clock.NowMs, grants.TokenFor(grant.GrantId));
    }

    [Theory]
    [InlineData("notepad")]
    [InlineData("calculator")]
    [InlineData("edge")]
    [InlineData("chrome")]
    [InlineData("explorer")]
    public async Task Opens_each_approved_application_once(string app)
    {
        Assert.Equal(CommandOutcome.Succeeded, await Run(Allow(), app));
        Assert.Equal([app], launcher.Opened);
    }

    [Fact]
    public async Task Types_nothing_and_asks_no_windows_hello()
    {
        await Run(Allow());
        Assert.Empty(injector.Sent);
        Assert.Empty(hello.Prompts);
    }

    [Fact]
    public async Task Says_when_the_application_is_not_installed()
    {
        launcher.Result = LaunchResult.NotInstalled;
        Assert.Equal(CommandOutcome.NotExecuted("APP_NOT_INSTALLED"), await Run(Allow()));
    }

    [Fact]
    public async Task Says_when_windows_would_not_start_it()
    {
        launcher.Result = LaunchResult.Failed;
        Assert.Equal(CommandOutcome.NotExecuted("LAUNCH_FAILED"), await Run(Allow()));
    }

    [Fact]
    public async Task Refuses_an_id_off_the_list_even_with_a_good_signature()
    {
        Assert.Equal(CommandOutcome.NotExecuted("INVALID_COMMAND"), await Run(Allow(), "cmd"));
        Assert.Empty(launcher.Opened);
    }

    [Fact]
    public async Task Does_nothing_while_the_session_is_locked()
    {
        var grant = Allow();
        session.IsLocked = true;
        Assert.Equal(CommandOutcome.NotExecuted("SESSION_LOCKED"), await Run(grant));
        Assert.Empty(launcher.Opened);
    }

    [Fact]
    public void Refuses_a_launch_the_grant_does_not_cover()
    {
        var grant = Allow(ProtocolConstants.Click, ProtocolConstants.Key);
        var verdict = verifier.Check(Commands.Sign(new LaunchParams("notepad"), grant.GrantId, clock.NowMs), clock.NowMs);
        Assert.Equal(CommandOutcome.NotExecuted("GRANT_INACTIVE"), verdict.Refusal);
    }

    [Fact]
    public void Refuses_a_launch_with_no_grant_after_a_restart()
    {
        // A new process starts with no grant: what an earlier one was allowed is gone.
        var verdict = verifier.Check(Commands.Sign(new LaunchParams("notepad"), Guid.NewGuid().ToString("D"), clock.NowMs), clock.NowMs);
        Assert.Equal(CommandOutcome.NotExecuted("GRANT_INACTIVE"), verdict.Refusal);
    }

    [Fact]
    public async Task Stops_the_moment_control_ends()
    {
        var grant = Allow();
        var command = Commands.Sign(new LaunchParams("notepad"), grant.GrantId, clock.NowMs);
        Assert.True(verifier.Check(command, clock.NowMs).Accepted);
        var token = grants.TokenFor(grant.GrantId);
        grants.End("kill-switch");
        Assert.Equal(CommandOutcome.NotExecuted("GRANT_INACTIVE"), await runner.RunAsync(command, clock.NowMs, token));
        Assert.Empty(launcher.Opened);
    }

    [Fact]
    public async Task Refuses_a_command_past_its_life()
    {
        var grant = Allow();
        var command = Commands.Sign(new LaunchParams("notepad"), grant.GrantId, clock.NowMs);
        var received = clock.NowMs;
        Assert.True(verifier.Check(command, received).Accepted);
        clock.Advance(ProtocolConstants.CommandTtlMs + 1);
        Assert.Equal(CommandOutcome.NotExecuted("COMMAND_EXPIRED"), await runner.RunAsync(command, received, grants.TokenFor(grant.GrantId)));
        Assert.Empty(launcher.Opened);
    }

    [Fact]
    public void Refuses_a_signature_for_another_application()
    {
        var grant = Allow();
        var signed = Commands.Sign(new LaunchParams("notepad"), grant.GrantId, clock.NowMs);
        var swapped = signed with { Params = new LaunchParams("chrome") };
        Assert.Equal(CommandOutcome.NotExecuted("INVALID_COMMAND"), verifier.Check(swapped, clock.NowMs).Refusal);
    }

    [Fact]
    public void Refuses_a_command_signed_in_the_old_format()
    {
        var grant = Allow();
        var current = Commands.Sign(new LaunchParams("notepad"), grant.GrantId, clock.NowMs);
        var old = Canonical.Command(current).Replace(ProtocolConstants.CommandFormatVersion, "jarvis-desktop-command/1", StringComparison.Ordinal);
        var signed = current with { Signature = Contract.ServerSign(old) };
        Assert.Equal(CommandOutcome.NotExecuted("INVALID_COMMAND"), verifier.Check(signed, clock.NowMs).Refusal);
    }

    [Fact]
    public void Refuses_a_launch_that_claims_to_need_no_hello_when_it_says_it_does()
    {
        var grant = Allow();
        var command = Commands.Sign(new LaunchParams("notepad"), grant.GrantId, clock.NowMs, requiresHello: true);
        Assert.Equal(CommandOutcome.NotExecuted("INVALID_COMMAND"), verifier.Check(command, clock.NowMs).Refusal);
    }

    [Fact]
    public void Ignores_a_command_it_has_already_seen()
    {
        var grant = Allow();
        var command = Commands.Sign(new LaunchParams("notepad"), grant.GrantId, clock.NowMs);
        Assert.True(verifier.Check(command, clock.NowMs).Accepted);
        Assert.Same(Verdict.Ignore, verifier.Check(command, clock.NowMs));
    }

    [Fact]
    public async Task Runs_one_action_at_a_time()
    {
        var grant = Allow();
        using var release = new SemaphoreSlim(0);
        hello.WhileOpen = async token => await release.WaitAsync(token);
        var typing = Commands.Sign(new TypeParams("hello"), grant.GrantId, clock.NowMs);
        Assert.True(verifier.Check(typing, clock.NowMs).Accepted);
        var busy = runner.RunAsync(typing, clock.NowMs, grants.TokenFor(grant.GrantId));
        for (var i = 0; i < 100 && hello.Prompts.Count == 0; i++) await Task.Delay(5);

        Assert.Equal(CommandOutcome.NotExecuted("BUSY"), await Run(grant));
        Assert.Empty(launcher.Opened);
        release.Release();
        await busy;
    }

    [Fact]
    public async Task Logs_the_action_and_the_outcome_and_no_path()
    {
        await Run(Allow(), "chrome");
        Assert.Contains("action=desktop.app.launch outcome=succeeded", sink.All, StringComparison.Ordinal);
        Assert.DoesNotContain(".exe", sink.All, StringComparison.Ordinal);
    }

    private static string Envelope(string parameters) => $$"""
        {"commandId":"11111111-1111-4111-8111-111111111111","deviceId":"{{Commands.DeviceId}}","grantId":"33333333-3333-4333-8333-333333333333",
         "action":"desktop.app.launch","params":{{parameters}},"issuedAt":1,"expiresAt":2,"requiresHello":false,"signature":"{{new string('A', 86)}}"}
        """;

    [Theory]
    [InlineData("""{"app":"cmd"}""")]
    [InlineData("""{"app":"C:\\Windows\\System32\\cmd.exe"}""")]
    [InlineData("""{"app":"Notepad"}""")]
    [InlineData("""{"app":"notepad","args":"/c calc"}""")]
    [InlineData("""{"app":"notepad","path":"x"}""")]
    [InlineData("""{}""")]
    public void The_parser_refuses_anything_but_an_id_on_the_list(string parameters)
    {
        using var document = JsonDocument.Parse(Envelope(parameters));
        Assert.Throws<ProtocolViolationException>(() => MessageParser.ParseCommand(document.RootElement));
    }

    [Fact]
    public void The_parser_accepts_an_id_on_the_list()
    {
        using var document = JsonDocument.Parse(Envelope("""{"app":"notepad"}"""));
        Assert.Equal(new LaunchParams("notepad"), MessageParser.ParseCommand(document.RootElement).Params);
    }

    [Theory]
    [InlineData("a\u202Eb")]
    [InlineData("a\u200Bb")]
    [InlineData("a\uFEFFb")]
    [InlineData("a\tb")]
    [InlineData("a\nb")]
    public void Refuses_text_the_person_could_not_have_read(string text)
    {
        Assert.False(TypeableText.IsValid(text));
    }

    [Fact]
    public void The_consent_screen_says_what_a_launch_can_and_cannot_do()
    {
        var text = ConsentText.Render("Ada", "Org", 15, ProtocolConstants.CommandActions);
        Assert.Contains("- open approved applications: Notepad, Calculator, Microsoft Edge, Google Chrome, File Explorer", text, StringComparison.Ordinal);
        Assert.Contains("You approve every action in JARVIS before it runs", text, StringComparison.Ordinal);
        Assert.Contains("JARVIS cannot see your screen.", text, StringComparison.Ordinal);
        Assert.Contains("It cannot run any other program, shell command or script", text, StringComparison.Ordinal);
    }
}
