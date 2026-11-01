// ---------------------------------------------------------------------------
// Phase 19.6 — what the agent checks before it acts, and how it acts (M4).
//
// A command runs only when every one of these holds, in this order, each
// checked again after anything that waits:
//   the server signed exactly this command, for this device and this grant;
//   it has not been seen before and has not expired, on either clock;
//   the grant is active here and covers the action;
//   the session is not locked;
//   there is a window to act in, it is not elevated, and it is not this agent;
//   for typing, the person had a moment to choose the window, verified with
//   Windows Hello, for this command and that window, and it is still that window.
// Only click, key, type and opening an approved application exist. A command
// that was refused before input was sent is "not-executed" with a reason; one
// interrupted after input was sent is "uncertain" — the server records it
// UNKNOWN and nothing retries it. Opening an application never types: typing is
// a command of its own, with its own approval and its own Windows Hello.
// ---------------------------------------------------------------------------

namespace Jarvis.DesktopAgent.Core;

/// <summary>A window the agent might send input to.</summary>
/// <param name="Handle">The top-level window's handle.</param>
/// <param name="Elevated">Its process runs at a higher integrity level than the agent's.</param>
/// <param name="Protected">It is the agent's own window, or system UI no command may reach.</param>
public sealed record WindowTarget(long Handle, int ProcessId, string ProcessName, string Title, bool Elevated, bool Protected);

public sealed record ScreenArea(int Left, int Top, int Width, int Height);

public interface IDesktopInspector
{
    /// <summary>All monitors together. Command coordinates count from its top-left corner.</summary>
    ScreenArea VirtualScreen { get; }

    WindowTarget? Foreground();

    /// <summary>The top-level window under a point on the screen (absolute screen coordinates).</summary>
    WindowTarget? At(int screenX, int screenY);
}

public enum InjectionResult
{
    /// <summary>Every input event was inserted.</summary>
    Completed,

    /// <summary>None was inserted: nothing reached any window.</summary>
    NothingSent,

    /// <summary>Some were inserted and some were not: what reached the window cannot be known.</summary>
    Partial,
}

/// <summary>Sends input. No other capability: nothing here reads or opens anything.</summary>
public interface IInputInjector
{
    InjectionResult Click(int screenX, int screenY, string button);

    InjectionResult Key(string key);

    InjectionResult Type(string text);
}

public enum LaunchResult
{
    /// <summary>Windows created the process. Whether a window appeared cannot be seen from here.</summary>
    Started,

    /// <summary>The application is not at any place the agent may open it from. Nothing ran.</summary>
    NotInstalled,

    /// <summary>Windows refused to create the process. Nothing ran.</summary>
    Failed,
}

/// <summary>Opens one application from the fixed list. It takes an id: a path, an argument or a command line cannot be expressed.</summary>
public interface IAppLauncher
{
    LaunchResult Launch(string app);
}

public enum HelloResult
{
    Verified,
    Unavailable,
    Failed,
}

/// <summary>Windows Hello at the device. Unavailable is a refusal, never a pass.</summary>
public interface IHelloVerifier
{
    Task<HelloResult> VerifyAsync(string message, CancellationToken cancellationToken);
}

public interface ISessionState
{
    bool IsLocked { get; }
}

public sealed record CommandOutcome(string Outcome, string? Code)
{
    public static readonly CommandOutcome Succeeded = new("succeeded", null);
    public static readonly CommandOutcome Uncertain = new("uncertain", null);

    public static CommandOutcome NotExecuted(string code) =>
        ProtocolConstants.NotExecutedCodes.Contains(code) ? new("not-executed", code) : throw new ArgumentException("Unknown code.", nameof(code));
}

/// <summary>What the verifier decided about a command, before anything runs.</summary>
/// <param name="Report">False when the command must not even be answered — a replay of one already seen.</param>
public sealed record Verdict(bool Accepted, CommandOutcome? Refusal, bool Report)
{
    public static readonly Verdict Accept = new(true, null, true);

    public static Verdict Refuse(string code) => new(false, CommandOutcome.NotExecuted(code), true);

    public static readonly Verdict Ignore = new(false, null, false);
}

public sealed class CommandVerifier(string serverPublicKey, string deviceId, GrantManager grants, IClock clock)
{
    private readonly Dictionary<string, long> seen = new(StringComparer.Ordinal);
    private readonly object gate = new();

    /// <param name="receivedAt">When this agent received the command, by its own clock.</param>
    public Verdict Check(CommandEnvelope command, long receivedAt)
    {
        if (!Signatures.Verify(serverPublicKey, Canonical.Command(command), command.Signature)) return Verdict.Refuse("INVALID_COMMAND");
        if (!string.Equals(command.DeviceId, deviceId, StringComparison.Ordinal)) return Verdict.Refuse("INVALID_COMMAND");
        if (command.RequiresHello != ProtocolConstants.HelloActions.Contains(command.Action)) return Verdict.Refuse("INVALID_COMMAND");
        var lifetime = command.ExpiresAt - command.IssuedAt;
        if (lifetime <= 0 || lifetime > ProtocolConstants.CommandTtlMs) return Verdict.Refuse("INVALID_COMMAND");

        lock (gate)
        {
            var now = clock.NowMs;
            foreach (var stale in seen.Where(s => s.Value < now).Select(s => s.Key).ToList()) seen.Remove(stale);
            if (seen.ContainsKey(command.CommandId)) return Verdict.Ignore;
            seen[command.CommandId] = command.ExpiresAt + ProtocolConstants.ClockSkewMs + lifetime;
        }

        if (IsExpired(command, receivedAt)) return Verdict.Refuse("COMMAND_EXPIRED");
        var grant = grants.Active;
        if (grant is null || !string.Equals(grant.GrantId, command.GrantId, StringComparison.Ordinal) || !grant.Scope.Contains(command.Action))
            return Verdict.Refuse("GRANT_INACTIVE");
        return Verdict.Accept;
    }

    /// <summary>
    /// Expired by the server's own clock (allowing the agreed skew), or by the
    /// command's lifetime counted on this computer from when it arrived — so a
    /// clock that runs slow here never stretches a command past 30 seconds of
    /// real time.
    /// </summary>
    public bool IsExpired(CommandEnvelope command, long receivedAt) =>
        command.IssuedAt > clock.NowMs + ProtocolConstants.ClockSkewMs || RemainingMs(command, receivedAt) < 0;

    /// <summary>How long the command may still run, by the stricter of the two clocks.</summary>
    public long RemainingMs(CommandEnvelope command, long receivedAt)
    {
        var now = clock.NowMs;
        return Math.Min(
            command.ExpiresAt + ProtocolConstants.ClockSkewMs - now,
            receivedAt + (command.ExpiresAt - command.IssuedAt) - now);
    }
}

public sealed class CommandRunner(
    CommandVerifier verifier,
    GrantManager grants,
    IDesktopInspector inspector,
    IInputInjector injector,
    IHelloVerifier hello,
    ISessionState session,
    AgentLog log,
    IAppLauncher launcher,
    TimeSpan typeFocusWait)
{
    /// <summary>Text is typed in pieces, and the window is checked between them.</summary>
    internal const int TypeChunkLength = 32;

    /// <summary>How long the window may take to get the focus back when Windows Hello closes.</summary>
    internal const int FocusReturnMs = 2_000;

    private const int FocusPollMs = 100;

    private int busy;

    /// <summary>Runs one accepted command. Never throws for a refusal; never retries.</summary>
    public async Task<CommandOutcome> RunAsync(CommandEnvelope command, long receivedAt, CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref busy, 1) == 1) return CommandOutcome.NotExecuted("BUSY");
        try
        {
            var outcome = await RunOnceAsync(command, receivedAt, cancellationToken).ConfigureAwait(false);
            log.Write("command.finished", ("commandId", command.CommandId), ("action", command.Action), ("outcome", outcome.Outcome), ("code", outcome.Code));
            return outcome;
        }
        finally
        {
            Volatile.Write(ref busy, 0);
        }
    }

    /// <summary>Everything that must still be true at the moment input is sent.</summary>
    private string? Recheck(CommandEnvelope command, long receivedAt, CancellationToken cancellationToken)
    {
        if (cancellationToken.IsCancellationRequested) return "GRANT_INACTIVE";
        var grant = grants.Active;
        if (grant is null || grant.GrantId != command.GrantId || !grant.Scope.Contains(command.Action)) return "GRANT_INACTIVE";
        if (verifier.IsExpired(command, receivedAt)) return "COMMAND_EXPIRED";
        if (session.IsLocked) return "SESSION_LOCKED";
        return null;
    }

    private static string? Refusal(WindowTarget? target) =>
        target is null || target.Protected ? "NO_TARGET" : target.Elevated ? "ELEVATED_TARGET" : null;

    private static bool Same(WindowTarget? a, WindowTarget? b) =>
        a is not null && b is not null && a.Handle == b.Handle && a.ProcessId == b.ProcessId;

    private async Task<CommandOutcome> RunOnceAsync(CommandEnvelope command, long receivedAt, CancellationToken cancellationToken)
    {
        if (Recheck(command, receivedAt, cancellationToken) is { } early) return CommandOutcome.NotExecuted(early);

        switch (command.Params)
        {
            case ClickParams click:
            {
                var screen = inspector.VirtualScreen;
                if (click.X >= screen.Width || click.Y >= screen.Height) return CommandOutcome.NotExecuted("OUT_OF_BOUNDS");
                int x = screen.Left + click.X, y = screen.Top + click.Y;
                if (Refusal(inspector.At(x, y)) is { } refused) return CommandOutcome.NotExecuted(refused);
                return Report(injector.Click(x, y, click.Button));
            }

            case KeyParams key:
            {
                if (Refusal(inspector.Foreground()) is { } refused) return CommandOutcome.NotExecuted(refused);
                return Report(injector.Key(key.Key));
            }

            case TypeParams type:
                return await TypeAsync(command, type.Text, receivedAt, cancellationToken).ConfigureAwait(false);

            case LaunchParams launch:
                return Report(launch);

            default:
                return CommandOutcome.NotExecuted("INVALID_COMMAND");
        }
    }

    private CommandOutcome Report(LaunchParams launch)
    {
        if (!ProtocolConstants.AppIds.Contains(launch.App)) return CommandOutcome.NotExecuted("INVALID_COMMAND");
        return launcher.Launch(launch.App) switch
        {
            LaunchResult.Started => CommandOutcome.Succeeded,
            LaunchResult.NotInstalled => CommandOutcome.NotExecuted("APP_NOT_INSTALLED"),
            _ => CommandOutcome.NotExecuted("LAUNCH_FAILED"),
        };
    }

    private static CommandOutcome Report(InjectionResult result) => result switch
    {
        InjectionResult.Completed => CommandOutcome.Succeeded,
        // The operating system inserted nothing: the input stream was held.
        InjectionResult.NothingSent => CommandOutcome.NotExecuted("BUSY"),
        _ => CommandOutcome.Uncertain,
    };

    private async Task<CommandOutcome> TypeAsync(CommandEnvelope command, string text, long receivedAt, CancellationToken cancellationToken)
    {
        // The person usually approves in a browser on this computer, so right now
        // the browser has the focus, and typing there would put the text in the
        // chat. This is their moment to click where it should go. Control ending
        // cuts it short, and everything is checked again after it.
        if (typeFocusWait > TimeSpan.Zero)
        {
            try
            {
                await Task.Delay(typeFocusWait, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return CommandOutcome.NotExecuted("GRANT_INACTIVE");
            }
            if (Recheck(command, receivedAt, cancellationToken) is { } after) return CommandOutcome.NotExecuted(after);
        }

        // D1: never typed on the approval alone. The target is fixed before
        // Hello and named in its prompt; the text itself is never shown.
        var target = inspector.Foreground();
        if (Refusal(target) is { } refused) return CommandOutcome.NotExecuted(refused);
        var characters = text.EnumerateRunes().Count();
        var message = HelloPrompt(target!, characters);

        // Hello waits no longer than the command lives: the prompt closes when
        // the command expires or the grant ends, whichever is first.
        HelloResult verified;
        using (var window = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
        {
            window.CancelAfter(TimeSpan.FromMilliseconds(Math.Max(0, verifier.RemainingMs(command, receivedAt))));
            try
            {
                verified = await hello.VerifyAsync(message, window.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return CommandOutcome.NotExecuted(cancellationToken.IsCancellationRequested ? "GRANT_INACTIVE" : "COMMAND_EXPIRED");
            }
        }
        if (verified == HelloResult.Unavailable) return CommandOutcome.NotExecuted("HELLO_UNAVAILABLE");
        if (verified != HelloResult.Verified) return CommandOutcome.NotExecuted("HELLO_FAILED");

        var sent = false;
        foreach (var chunk in Chunks(text))
        {
            // Again, after Hello and between pieces: the grant, the clock, the
            // lock, and the very same window, still not elevated.
            var now = sent ? inspector.Foreground() : await FocusAfterHelloAsync(target!, cancellationToken).ConfigureAwait(false);
            var stop = Recheck(command, receivedAt, cancellationToken);
            stop ??= !Same(now, target) ? "NO_TARGET" : Refusal(now);
            if (stop is not null) return sent ? CommandOutcome.Uncertain : CommandOutcome.NotExecuted(stop);

            var result = injector.Type(chunk);
            if (result == InjectionResult.NothingSent) return sent ? CommandOutcome.Uncertain : CommandOutcome.NotExecuted("BUSY");
            if (result == InjectionResult.Partial) return CommandOutcome.Uncertain;
            sent = true;
        }
        return CommandOutcome.Succeeded;
    }

    /// <summary>
    /// The window with the focus just after Windows Hello. Hello's own window held
    /// it, and it goes back a moment after that closes. A window that does not get
    /// it back in time is a window that changed, and nothing is typed.
    /// </summary>
    private async Task<WindowTarget?> FocusAfterHelloAsync(WindowTarget target, CancellationToken cancellationToken)
    {
        var now = inspector.Foreground();
        for (var waited = 0; !Same(now, target) && waited < FocusReturnMs; waited += FocusPollMs)
        {
            try
            {
                await Task.Delay(FocusPollMs, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return now;
            }
            now = inspector.Foreground();
        }
        return now;
    }

    /// <summary>What Windows Hello shows: which program will receive the typing and how much — never the text.</summary>
    internal static string HelloPrompt(WindowTarget target, int characters)
    {
        var title = AgentLog.Printable(target.Title, 60);
        var program = AgentLog.Printable(target.ProcessName, 40);
        return $"JARVIS will type {characters} character{(characters == 1 ? "" : "s")} into {program}{(title.Length > 0 ? $" — \"{title}\"" : "")}. Verify only if you asked for this.";
    }

    /// <summary>Pieces of at most <see cref="TypeChunkLength"/> UTF-16 units that never split a surrogate pair.</summary>
    internal static IEnumerable<string> Chunks(string text)
    {
        var start = 0;
        while (start < text.Length)
        {
            var length = Math.Min(TypeChunkLength, text.Length - start);
            if (start + length < text.Length && char.IsHighSurrogate(text[start + length - 1])) length--;
            yield return text.Substring(start, length);
            start += length;
        }
    }
}
