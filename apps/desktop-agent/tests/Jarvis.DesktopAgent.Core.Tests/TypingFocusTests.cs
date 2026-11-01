// ---------------------------------------------------------------------------
// Phase 19.7 — where typed text goes.
//
// The person usually approves in a browser on the same computer, so when a
// typing command arrives that browser has the focus. Without a moment to choose,
// the text would go into the chat. These pin that the window is fixed only after
// that moment, that Windows Hello names the window it was fixed on, and that
// nothing is typed anywhere else. Every Windows part is faked: no input is sent.
// ---------------------------------------------------------------------------

using Jarvis.DesktopAgent.Core;
using Xunit;

namespace Jarvis.DesktopAgent.Core.Tests;

public sealed class TypingFocusTests : IDisposable
{
    private static readonly WindowTarget Browser = new(0x4004, 5555, "chrome.exe", "JARVIS - Chat", Elevated: false, Protected: false);
    private static readonly TimeSpan Moment = TimeSpan.FromMilliseconds(120);

    private readonly TestClock clock = new();
    private readonly GrantManager grants;
    private readonly CommandVerifier verifier;
    private readonly FakeInspector inspector = new() { ForegroundWindow = Browser };
    private readonly FakeInjector injector = new();
    private readonly FakeHello hello = new();
    private readonly FakeSession session = new();
    private readonly MemorySink sink = new();
    private readonly CommandRunner runner;
    private readonly LocalGrant grant;

    public TypingFocusTests()
    {
        clock.Run();
        grants = new GrantManager(clock);
        verifier = new CommandVerifier(Contract.ServerSpki, Commands.DeviceId, grants, clock);
        runner = new CommandRunner(verifier, grants, inspector, injector, hello, session, new AgentLog(sink, clock), new FakeLauncher(), Moment);
        grant = grants.Prepare(ProtocolConstants.CommandActions, 15, new string('a', 64));
        Assert.True(grants.Activate(grant, null));
    }

    public void Dispose() => grants.Dispose();

    private Task<CommandOutcome> Type(string text = "Hello Sirish, JARVIS is online.")
    {
        var command = Commands.Sign(new TypeParams(text), grant.GrantId, clock.NowMs);
        Assert.True(verifier.Check(command, clock.NowMs).Accepted);
        return runner.RunAsync(command, clock.NowMs, grants.TokenFor(grant.GrantId));
    }

    [Fact]
    public async Task Types_into_the_window_the_person_clicked_after_approving_and_not_the_browser()
    {
        var typing = Type();
        await Task.Delay(30);
        Assert.Empty(hello.Prompts);
        inspector.ForegroundWindow = FakeInspector.Notepad;

        Assert.Equal(CommandOutcome.Succeeded, await typing);
        Assert.Contains("notepad.exe", Assert.Single(hello.Prompts), StringComparison.Ordinal);
        Assert.Equal(["type:Hello Sirish, JARVIS is online."], injector.Sent);
    }

    [Fact]
    public async Task Names_the_browser_in_windows_hello_when_the_person_did_not_move()
    {
        Assert.Equal(CommandOutcome.Succeeded, await Type());
        Assert.Contains("chrome.exe", Assert.Single(hello.Prompts), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Asks_for_windows_hello_only_after_the_moment_has_passed()
    {
        var started = clock.NowMs;
        long promptedAt = 0;
        hello.WhileOpen = _ =>
        {
            promptedAt = clock.NowMs;
            return Task.CompletedTask;
        };
        await Type();
        Assert.True(promptedAt - started >= Moment.TotalMilliseconds - 20, $"asked after {promptedAt - started} ms");
    }

    [Fact]
    public async Task Sends_nothing_when_the_person_clicked_somewhere_it_may_not_type()
    {
        var typing = Type();
        await Task.Delay(30);
        inspector.ForegroundWindow = FakeInspector.Admin;
        Assert.Equal(CommandOutcome.NotExecuted("ELEVATED_TARGET"), await typing);
        Assert.Empty(hello.Prompts);
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public async Task Stops_at_once_when_control_ends_during_the_moment()
    {
        var typing = Type();
        await Task.Delay(30);
        grants.End("kill-switch");
        Assert.Equal(CommandOutcome.NotExecuted("GRANT_INACTIVE"), await typing);
        Assert.Empty(hello.Prompts);
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public async Task Does_nothing_when_the_computer_was_locked_during_the_moment()
    {
        var typing = Type();
        await Task.Delay(30);
        session.IsLocked = true;
        Assert.Equal(CommandOutcome.NotExecuted("SESSION_LOCKED"), await typing);
        Assert.Empty(hello.Prompts);
    }

    [Fact]
    public async Task Refuses_a_command_that_expired_during_the_moment()
    {
        var typing = Type();
        await Task.Delay(30);
        clock.Advance(ProtocolConstants.CommandTtlMs + 1);
        Assert.Equal(CommandOutcome.NotExecuted("COMMAND_EXPIRED"), await typing);
        Assert.Empty(hello.Prompts);
    }

    [Fact]
    public async Task Waits_for_the_focus_to_come_back_from_windows_hello()
    {
        inspector.ForegroundWindow = FakeInspector.Notepad;
        Task? focusReturns = null;
        hello.WhileOpen = token =>
        {
            // Windows Hello's own window has the focus when it closes.
            inspector.ForegroundWindow = FakeInspector.Agent;
            focusReturns = Task.Run(
                async () =>
                {
                    await Task.Delay(250, CancellationToken.None);
                    inspector.ForegroundWindow = FakeInspector.Notepad;
                },
                token);
            return Task.CompletedTask;
        };
        Assert.Equal(CommandOutcome.Succeeded, await Type());
        Assert.Single(injector.Sent);
        await focusReturns!;
    }

    [Fact]
    public async Task Types_nothing_when_a_different_window_is_left_with_the_focus_after_windows_hello()
    {
        inspector.ForegroundWindow = FakeInspector.Notepad;
        hello.WhileOpen = _ =>
        {
            inspector.ForegroundWindow = Browser;
            return Task.CompletedTask;
        };
        Assert.Equal(CommandOutcome.NotExecuted("NO_TARGET"), await Type());
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public void Leaves_windows_hello_most_of_a_commands_life()
    {
        Assert.True(ProtocolConstants.CommandTtlMs - ProtocolConstants.TypeFocusWaitMs >= 20_000);
    }
}
