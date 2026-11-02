// ---------------------------------------------------------------------------
// Phase 19.6 — how a verified command runs (M4), with every Windows part
// faked: no input is sent anywhere. Typing never happens without Windows
// Hello; Hello unavailable is a refusal; elevated and agent windows are never
// targets; a change of window stops typing; interrupted is uncertain, never
// retried.
// ---------------------------------------------------------------------------

using Jarvis.DesktopAgent.Core;
using Xunit;

namespace Jarvis.DesktopAgent.Core.Tests;

public sealed class ExecutionTests : IDisposable
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
    private readonly LocalGrant grant;

    public ExecutionTests()
    {
        grants = new GrantManager(clock);
        verifier = new CommandVerifier(Contract.ServerSpki, Commands.DeviceId, grants, clock);
        runner = new CommandRunner(verifier, grants, inspector, injector, hello, session, new AgentLog(sink, clock), launcher, TimeSpan.Zero);
        grant = grants.Prepare(ProtocolConstants.CommandActions, 15, new string('a', 64));
        Assert.True(grants.Activate(grant, null));
    }

    public void Dispose() => grants.Dispose();

    private Task<CommandOutcome> Run(CommandParams parameters)
    {
        var command = Commands.Sign(parameters, grant.GrantId, clock.NowMs);
        Assert.True(verifier.Check(command, clock.NowMs).Accepted);
        return runner.RunAsync(command, clock.NowMs, grants.TokenFor(grant.GrantId));
    }

    [Fact]
    public async Task Clicks_at_the_point_counted_from_the_desktops_top_left_corner()
    {
        Assert.Equal(CommandOutcome.Succeeded, await Run(new ClickParams(100, 50, "right")));
        Assert.Equal(["click:-1820,50,right"], injector.Sent);
    }

    [Fact]
    public async Task Refuses_a_point_outside_the_desktop()
    {
        Assert.Equal(CommandOutcome.NotExecuted("OUT_OF_BOUNDS"), await Run(new ClickParams(3840, 10, "left")));
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public async Task Never_acts_in_an_elevated_window_or_the_agents_own()
    {
        inspector.AtPoint = (_, _) => FakeInspector.Admin;
        Assert.Equal(CommandOutcome.NotExecuted("ELEVATED_TARGET"), await Run(new ClickParams(1, 1, "left")));
        inspector.AtPoint = (_, _) => FakeInspector.Agent;
        Assert.Equal(CommandOutcome.NotExecuted("NO_TARGET"), await Run(new ClickParams(1, 1, "left")));
        inspector.ForegroundWindow = FakeInspector.Admin;
        Assert.Equal(CommandOutcome.NotExecuted("ELEVATED_TARGET"), await Run(new KeyParams("enter")));
        inspector.ForegroundWindow = null;
        Assert.Equal(CommandOutcome.NotExecuted("NO_TARGET"), await Run(new KeyParams("enter")));
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public async Task Does_nothing_while_the_session_is_locked()
    {
        session.IsLocked = true;
        Assert.Equal(CommandOutcome.NotExecuted("SESSION_LOCKED"), await Run(new KeyParams("enter")));
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public async Task Types_only_after_windows_hello_names_the_program_and_the_count_never_the_text()
    {
        Assert.Equal(CommandOutcome.Succeeded, await Run(new TypeParams("s3cret-PASSWORD")));
        var prompt = Assert.Single(hello.Prompts);
        Assert.Contains("15 characters", prompt);
        Assert.Contains("notepad.exe", prompt);
        Assert.DoesNotContain("s3cret", prompt);
        Assert.Equal(["type:s3cret-PASSWORD"], injector.Sent);
    }

    [Fact]
    public async Task Refuses_typing_when_hello_is_unavailable_or_fails()
    {
        hello.Result = HelloResult.Unavailable;
        Assert.Equal(CommandOutcome.NotExecuted("HELLO_UNAVAILABLE"), await Run(new TypeParams("abc")));
        hello.Result = HelloResult.Failed;
        Assert.Equal(CommandOutcome.NotExecuted("HELLO_FAILED"), await Run(new TypeParams("abc")));
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public async Task Refuses_typing_into_an_elevated_window_before_asking_for_hello()
    {
        inspector.ForegroundWindow = FakeInspector.Admin;
        Assert.Equal(CommandOutcome.NotExecuted("ELEVATED_TARGET"), await Run(new TypeParams("abc")));
        Assert.Empty(hello.Prompts);
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public async Task Types_nothing_when_the_window_changed_while_hello_was_open()
    {
        hello.WhileOpen = _ =>
        {
            inspector.ForegroundWindow = FakeInspector.Notepad with { Handle = 0x9999 };
            return Task.CompletedTask;
        };
        Assert.Equal(CommandOutcome.NotExecuted("NO_TARGET"), await Run(new TypeParams("abc")));
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public async Task Types_nothing_when_the_kill_switch_ends_the_grant_during_hello()
    {
        hello.WhileOpen = _ =>
        {
            grants.End("kill-switch");
            return Task.CompletedTask;
        };
        Assert.Equal(CommandOutcome.NotExecuted("GRANT_INACTIVE"), await Run(new TypeParams("abc")));
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public async Task Hello_slower_than_the_command_lives_is_an_expiry_and_types_nothing()
    {
        hello.WhileOpen = _ =>
        {
            clock.Advance(30_001);
            return Task.CompletedTask;
        };
        Assert.Equal(CommandOutcome.NotExecuted("COMMAND_EXPIRED"), await Run(new TypeParams("abc")));
        Assert.Empty(injector.Sent);
    }

    [Fact]
    public async Task Hello_is_closed_when_the_command_expires()
    {
        var closed = false;
        hello.WhileOpen = async token =>
        {
            try
            {
                await Task.Delay(Timeout.Infinite, token);
            }
            catch (OperationCanceledException)
            {
                closed = true;
                throw;
            }
        };
        var command = Commands.Sign(new TypeParams("abc"), grant.GrantId, clock.NowMs, lifetime: 50);
        Assert.True(verifier.Check(command, clock.NowMs).Accepted);
        var outcome = await runner.RunAsync(command, clock.NowMs, grants.TokenFor(grant.GrantId));
        Assert.True(closed);
        Assert.Equal(CommandOutcome.NotExecuted("COMMAND_EXPIRED"), outcome);
    }

    [Fact]
    public async Task Stops_and_reports_uncertain_when_the_window_changes_part_way_through()
    {
        var text = new string('x', 100);
        inspector.OnForegroundRead = reads =>
        {
            // Read 1 fixes the target, read 2 checks before the first piece;
            // after that piece the person switches windows.
            if (reads == 3) inspector.ForegroundWindow = FakeInspector.Notepad with { Handle = 0x9999 };
        };
        Assert.Equal(CommandOutcome.Uncertain, await Run(new TypeParams(text)));
        Assert.Equal(["type:" + new string('x', CommandRunner.TypeChunkLength)], injector.Sent);
    }

    [Fact]
    public async Task Reports_uncertain_when_input_was_only_partly_inserted_and_busy_when_none_was()
    {
        injector.Result = _ => InjectionResult.Partial;
        Assert.Equal(CommandOutcome.Uncertain, await Run(new KeyParams("enter")));
        injector.Result = _ => InjectionResult.NothingSent;
        Assert.Equal(CommandOutcome.NotExecuted("BUSY"), await Run(new KeyParams("tab")));
    }

    [Fact]
    public void Splits_text_without_ever_splitting_a_surrogate_pair()
    {
        var text = new string('a', CommandRunner.TypeChunkLength - 1) + "👋" + "tail";
        var chunks = CommandRunner.Chunks(text).ToList();
        Assert.Equal(text, string.Concat(chunks));
        Assert.All(chunks, c => Assert.True(TypeableText.IsValid(c)));
    }

    [Fact]
    public async Task Runs_one_command_at_a_time()
    {
        var release = new TaskCompletionSource();
        hello.WhileOpen = _ => release.Task;
        var first = Run(new TypeParams("abc"));
        Assert.Equal(CommandOutcome.NotExecuted("BUSY"), await Run(new KeyParams("enter")));
        release.SetResult();
        Assert.Equal(CommandOutcome.Succeeded, await first);
        Assert.Equal(["type:abc"], injector.Sent);
    }

    [Fact]
    public async Task Logs_outcomes_and_never_what_was_typed_or_where()
    {
        await Run(new TypeParams("s3cret-PASSWORD"));
        await Run(new ClickParams(123, 456, "left"));
        var log = sink.All;
        Assert.Contains("outcome=succeeded", log);
        Assert.DoesNotContain("s3cret", log);
        Assert.DoesNotContain("notepad", log, StringComparison.OrdinalIgnoreCase);
        // Every field on every line is one of the listed ones — coordinates have none.
        foreach (var line in sink.Lines)
            foreach (var field in line.Split(' ').Skip(2))
                Assert.Contains(field.Split('=')[0], AgentLog.Fields);
    }
}

public class GrantTests
{
    private readonly TestClock clock = new();

    [Fact]
    public void Lasts_what_the_person_chose_from_one_to_sixty_minutes_and_nothing_else()
    {
        using var grants = new GrantManager(clock);
        Assert.Equal(15 * 60_000, grants.Prepare([ProtocolConstants.Click], ProtocolConstants.GrantDefaultMinutes, "h").ExpiresAt - clock.NowMs);
        Assert.Equal(60 * 60_000, grants.Prepare([ProtocolConstants.Click], 60, "h").ExpiresAt - clock.NowMs);
        Assert.Throws<ArgumentOutOfRangeException>(() => grants.Prepare([ProtocolConstants.Click], 61, "h"));
        Assert.Throws<ArgumentOutOfRangeException>(() => grants.Prepare([ProtocolConstants.Click], 0, "h"));
        Assert.Throws<ArgumentException>(() => grants.Prepare(["desktop.screen.read"], 15, "h"));
        Assert.Throws<ArgumentException>(() => grants.Prepare([], 15, "h"));
    }

    [Fact]
    public void Ends_at_expiry_and_says_so_once()
    {
        using var grants = new GrantManager(clock);
        var ended = new List<string>();
        grants.Ended += (_, reason) => ended.Add(reason);
        var grant = grants.Prepare([ProtocolConstants.Click], 1, "h");
        Assert.True(grants.Activate(grant, null));
        clock.Advance(60_000);
        Assert.Null(grants.Active);
        Assert.Null(grants.Active);
        Assert.Equal(["expired"], ended);
    }

    [Fact]
    public void Ends_after_thirty_seconds_without_the_server_and_the_clock_never_pauses()
    {
        using var grants = new GrantManager(clock);
        var grant = grants.Prepare([ProtocolConstants.Click], 15, "h");
        Assert.True(grants.Activate(grant, null));
        clock.Advance(30_000);
        grants.CheckReconnectGrace();
        Assert.NotNull(grants.Active);
        grants.ServerContact();
        clock.Advance(30_001);
        grants.CheckReconnectGrace();
        Assert.Null(grants.Active);
    }

    [Fact]
    public void Says_how_long_an_exchange_may_stay_open_before_the_grace_runs_out()
    {
        using var grants = new GrantManager(clock);
        Assert.Null(grants.GraceLeft);
        Assert.True(grants.Activate(grants.Prepare([ProtocolConstants.Click], 15, "h"), null));
        clock.Advance(10_000);
        // One past the 30 seconds: at exactly 30 the grace has not run out.
        Assert.Equal(TimeSpan.FromMilliseconds(20_001), grants.GraceLeft);
        grants.ServerContact();
        Assert.Equal(TimeSpan.FromMilliseconds(30_001), grants.GraceLeft);
        clock.Advance(90_000);
        Assert.Equal(TimeSpan.Zero, grants.GraceLeft);
    }

    [Fact]
    public void Extends_only_by_replacing_the_grant_it_names()
    {
        using var grants = new GrantManager(clock);
        var first = grants.Prepare([ProtocolConstants.Click], 15, "h");
        Assert.True(grants.Activate(first, null));
        var second = grants.Prepare([ProtocolConstants.Click], 30, "h");
        Assert.False(grants.Activate(second, null));
        Assert.False(grants.Activate(second, Guid.NewGuid().ToString("D")));
        var token = grants.TokenFor(first.GrantId);
        Assert.True(grants.Activate(second, first.GrantId));
        Assert.True(token.IsCancellationRequested);
        Assert.Equal(second.GrantId, grants.Active?.GrantId);
    }

    [Fact]
    public void Cancels_work_under_the_grant_the_moment_it_ends()
    {
        using var grants = new GrantManager(clock);
        var grant = grants.Prepare([ProtocolConstants.Click], 15, "h");
        Assert.True(grants.Activate(grant, null));
        var token = grants.TokenFor(grant.GrantId);
        Assert.False(token.IsCancellationRequested);
        Assert.True(grants.End("kill-switch"));
        Assert.True(token.IsCancellationRequested);
        Assert.True(grants.TokenFor(grant.GrantId).IsCancellationRequested);
        Assert.False(grants.End("kill-switch"));
    }

    [Fact]
    public void Never_activates_a_grant_whose_time_already_ran_out()
    {
        using var grants = new GrantManager(clock);
        var grant = grants.Prepare([ProtocolConstants.Click], 1, "h");
        clock.Advance(60_000);
        Assert.False(grants.Activate(grant, null));
    }
}

public class AgentLogTests
{
    [Fact]
    public void Writes_only_listed_fields_and_withholds_anything_that_is_not_an_identifier()
    {
        var sink = new MemorySink();
        var log = new AgentLog(sink, new TestClock());
        log.Write("command.finished", ("commandId", "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c"), ("text", "hunter2"), ("code", "has spaces and secrets"), ("attempt", 2));
        var line = Assert.Single(sink.Lines);
        Assert.Contains("commandId=8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c", line);
        Assert.Contains("code=[withheld]", line);
        Assert.Contains("attempt=2", line);
        Assert.DoesNotContain("hunter2", line);
        Assert.DoesNotContain("secrets", line);
    }

    private static string LoggedLine(params (string Field, object? Value)[] fields)
    {
        var sink = new MemorySink();
        new AgentLog(sink, new TestClock()).Write("poll.failed", fields);
        return Assert.Single(sink.Lines);
    }

    [Theory]
    [InlineData("code", "7K3M-Q9X2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01")]
    [InlineData("reason", "7K3M-Q9X2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01")]
    [InlineData("code", "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c")]
    [InlineData("reason", "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c")]
    [InlineData("deviceIdHash", "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c")]
    [InlineData("deviceIdHash", "8CAEFA6B4FA9A023")]
    [InlineData("httpStatus", "bad-gateway")]
    [InlineData("retryInMs", "soon")]
    [InlineData("code", "SERVER_REFUSAL\n")]
    [InlineData("reason", "revoked\n")]
    [InlineData("outcome", "succeeded\n")]
    [InlineData("deviceIdHash", "8caefa6b4fa9a023\n")]
    public void Withholds_a_value_that_is_not_the_shape_of_its_field(string field, string value)
    {
        var line = LoggedLine((field, value));
        Assert.Contains($"{field}=[withheld]", line);
        Assert.DoesNotContain(value, line);
    }

    [Theory]
    [InlineData("httpStatus", 99)]
    [InlineData("httpStatus", 600)]
    [InlineData("retryInMs", -1)]
    [InlineData("code", 123456)]
    [InlineData("reason", 123456)]
    [InlineData("deviceIdHash", 123456)]
    public void Withholds_a_number_that_cannot_belong_to_its_field(string field, int value)
    {
        Assert.Contains($"{field}=[withheld]", LoggedLine((field, value)));
    }

    [Theory]
    [InlineData("code", "TRANSPORT_ERROR")]
    [InlineData("reason", "DEVICE_REVOKED")]
    [InlineData("reason", "kill-switch")]
    [InlineData("deviceIdHash", "8caefa6b4fa9a023")]
    public void Writes_a_value_of_the_right_shape(string field, string value)
    {
        Assert.Contains($"{field}={value}", LoggedLine((field, value)));
    }

    [Theory]
    [InlineData("httpStatus", 100)]
    [InlineData("httpStatus", 599)]
    [InlineData("retryInMs", 0)]
    [InlineData("attempt", 3)]
    public void Writes_a_number_its_field_can_hold(string field, int value)
    {
        Assert.Contains($"{field}={value}", LoggedLine((field, value)));
    }

    [Fact]
    public void Leaves_out_an_empty_value()
    {
        Assert.DoesNotContain("httpStatus", LoggedLine(("code", "TRANSPORT_ERROR"), ("httpStatus", (int?)null)));
    }

    [Fact]
    public void Has_no_field_for_a_full_device_id()
    {
        Assert.DoesNotContain("deviceId=", LoggedLine(("deviceId", "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c")));
    }

    [Fact]
    public void Hashes_a_device_id_as_the_server_does()
    {
        // The first 16 hex characters of its SHA-256, derived outside this code.
        // The API's refusal test pins the same value for the same id.
        Assert.Equal("8caefa6b4fa9a023", AgentLog.DeviceIdHash(Commands.DeviceId));
    }

    [Fact]
    public void Shows_people_only_printable_bounded_text()
    {
        Assert.Equal("ab", AgentLog.Printable("a\u0000\u202eb\n", 10));
        Assert.Equal("abc", AgentLog.Printable("abcdef", 3));
        Assert.Equal("a", AgentLog.Printable("a👋", 2));
    }
}
