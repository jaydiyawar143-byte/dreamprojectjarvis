// ---------------------------------------------------------------------------
// Phase 19.6 — the agent's one conversation with the server (D3).
//
// The agent asks; the server answers. A poll carries the grant the agent holds;
// while a grant is active the server holds the poll until a command is ready.
// Each command is verified, run at most once, and answered; nothing queued is
// replayed after a reconnection, and an uncertain outcome is reported, never
// retried. Consent starts a grant only from this computer's own screen, and
// only while no poll is in flight that still names the previous one.
// ---------------------------------------------------------------------------

using System.Text.Json;

namespace Jarvis.DesktopAgent.Core;

/// <summary>What pairing left on this computer. Not secret: the key itself never leaves Windows' key storage.</summary>
public sealed record Pairing(string DeviceId, string ServerPublicKey, string ServerKeyId, string UserLabel, string OrganizationLabel);

public interface IPairingStore
{
    /// <summary>The server's address, known once a pairing is loaded or remembered.</summary>
    Uri? Server { get; }

    Pairing? Load();

    void Remember(Uri server);

    void Save(Pairing pairing);

    /// <summary>Forgets the pairing and deletes the device key: a revoked device starts over.</summary>
    void Clear();
}

/// <summary>What the person sees change. Called from the loop's thread; the UI marshals.</summary>
public interface IAgentEvents
{
    void DeviceStatusChanged(string status);

    void ConnectionChanged(bool connected);

    /// <summary>The agent stopped for good: "revoked", "unsupported", "not-authorized".</summary>
    void Stopped(string reason);
}

public sealed class AgentLoop : IDisposable
{
    internal static readonly TimeSpan IdleInterval = TimeSpan.FromSeconds(3);
    private const int ResultAttempts = 3;

    /// <summary>Unknown failures in a row before polling stops: with the backoff, about 15 seconds.</summary>
    internal const int UnknownFailureLimit = 5;

    /// <summary>
    /// The least time a poll gets while a grant is active: the server's hold and a
    /// margin. The server counts a poll's arrival as contact and the agent only an
    /// answer, so a poll begun late in the grace is healthy until a hold has passed.
    /// Only an answer renews the grace; this never does.
    /// </summary>
    internal TimeSpan MinPollWindow { get; init; } = TimeSpan.FromMilliseconds(ProtocolConstants.PollHoldMs + 2_000);

    private readonly AgentClient client;
    private readonly Pairing pairing;
    private readonly GrantManager grants;
    private readonly CommandVerifier verifier;
    private readonly CommandRunner runner;
    private readonly IPairingStore store;
    private readonly IAgentEvents events;
    private readonly AgentLog log;
    private readonly IClock clock;
    private readonly int windowsBuild;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly SemaphoreSlim exchange = new(1, 1);
    private int stopped;

    public AgentLoop(
        AgentClient client,
        Pairing pairing,
        GrantManager grants,
        CommandVerifier verifier,
        CommandRunner runner,
        IPairingStore store,
        IAgentEvents events,
        AgentLog log,
        IClock clock,
        int windowsBuild,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        this.client = client;
        this.pairing = pairing;
        this.grants = grants;
        this.verifier = verifier;
        this.runner = runner;
        this.store = store;
        this.events = events;
        this.log = log;
        this.clock = clock;
        this.windowsBuild = windowsBuild;
        this.delay = delay ?? Task.Delay;
        grants.Ended += OnGrantEnded;
    }

    /// <summary>A new one each time the agent starts: the server ends any grant held by an earlier process (U5b).</summary>
    public string AgentInstanceId { get; } = Guid.NewGuid().ToString("D");

    /// <summary>Polls until stopped. Whatever ends polling for its own reasons is logged and reaches the tray.</summary>
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        try
        {
            await PollUntilStoppedAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            // Out of retries, or something no step expected. The exchange is released by
            // now, so the tray may dispose this loop the moment it hears.
            log.Write("poll.stopped", ("code", AgentFailure.UnknownError));
            GiveUp();
        }
    }

    private void GiveUp()
    {
        if (Interlocked.Exchange(ref stopped, 1) == 1) return;
        grants.End("disconnected");
        events.Stopped("failed");
    }

    private async Task PollUntilStoppedAsync(CancellationToken cancellationToken)
    {
        var failures = 0;
        var unknownFailures = 0;
        while (!cancellationToken.IsCancellationRequested && Volatile.Read(ref stopped) == 0)
        {
            grants.CheckReconnectGrace();
            string? sent;
            AgentAnswer answer;
            await exchange.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                // Read with the exchange held: consent may have been starting a grant
                // while this waited, and a poll that names none would end it.
                sent = grants.Active?.GrantId;
                answer = await PollWithinGraceAsync(sent, cancellationToken).ConfigureAwait(false);
            }
            catch (AgentTransportException e)
            {
                failures++;
                await BackOffAsync(failures, e.Code, e.HttpStatus, cancellationToken).ConfigureAwait(false);
                continue;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // The agent is still running, so this was the poll's deadline:
                // control ends now, not whenever the poll would have returned.
                grants.CheckReconnectGrace();
                failures++;
                await BackOffAsync(failures, AgentFailure.TransportError, null, cancellationToken).ConfigureAwait(false);
                continue;
            }
            catch (Exception e) when (e is not OperationCanceledException && !cancellationToken.IsCancellationRequested)
            {
                // A failed signature sends nothing and a retry is a new signed request, so no
                // command can run twice. The type cannot say whether this lasts: a few tries decide.
                if (++unknownFailures >= UnknownFailureLimit) throw;
                failures++;
                await BackOffAsync(failures, AgentFailure.UnknownError, null, cancellationToken).ConfigureAwait(false);
                continue;
            }
            finally
            {
                exchange.Release();
            }

            failures = 0;
            unknownFailures = 0;
            grants.ServerContact();
            events.ConnectionChanged(true);
            if (!answer.Ok)
            {
                if (Refused(answer)) return;
                await delay(IdleInterval, cancellationToken).ConfigureAwait(false);
                continue;
            }

            PollResponse poll;
            try
            {
                poll = MessageParser.ParsePollResponse(answer.Body);
            }
            catch (Exception e) when (e is ProtocolViolationException or KeyNotFoundException or InvalidOperationException)
            {
                log.Write("poll.malformed", ("code", AgentFailure.ResponseInvalid), ("httpStatus", answer.Status), ("retryInMs", Milliseconds(IdleInterval)));
                await delay(IdleInterval, cancellationToken).ConfigureAwait(false);
                continue;
            }

            events.DeviceStatusChanged(poll.DeviceStatus);
            Agree(sent, poll.Grant);
            if (poll.Command is not null)
            {
                await HandleCommandAsync(poll.Command, cancellationToken).ConfigureAwait(false);
            }
            else if (grants.Active is null)
            {
                await delay(IdleInterval, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// One poll. While a grant is active it may not outlive the grant's grace, or
    /// <see cref="MinPollWindow"/> if that is longer. The deadline ends with the
    /// poll, so a command that follows, however long Windows Hello takes, runs
    /// under no deadline of this one's.
    /// </summary>
    private async Task<AgentAnswer> PollWithinGraceAsync(string? sent, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (grants.GraceLeft is { } left) deadline.CancelAfter(left > MinPollWindow ? left : MinPollWindow);
        return await client.PollAsync(pairing, AgentInstanceId, windowsBuild, sent, deadline.Token).ConfigureAwait(false);
    }

    /// <summary>Says the poll failed and why, then waits before the next one, never past the grace.</summary>
    private async Task BackOffAsync(int attempt, string code, int? httpStatus, CancellationToken cancellationToken)
    {
        events.ConnectionChanged(false);
        var wait = Backoff(attempt);
        if (grants.GraceLeft is { } left && left < wait) wait = left;
        log.Write("poll.failed", ("attempt", attempt), ("code", code), ("httpStatus", httpStatus), ("retryInMs", Milliseconds(wait)));
        await delay(wait, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// When the server no longer holds the grant this poll named, the agent's
    /// ends too. An answer to a poll that named an older grant says nothing
    /// about the current one.
    /// </summary>
    private void Agree(string? sent, GrantState? server)
    {
        if (sent is null || grants.Active?.GrantId != sent) return;
        if (server is null || server.GrantId != sent || server.Status != "active") grants.EndIf(sent, LocalEndReasons.Server);
    }

    private async Task HandleCommandAsync(CommandEnvelope command, CancellationToken cancellationToken)
    {
        var receivedAt = clock.NowMs;
        var verdict = verifier.Check(command, receivedAt);
        CommandOutcome outcome;
        if (!verdict.Accepted)
        {
            log.Write("command.refused", ("commandId", command.CommandId), ("code", verdict.Refusal?.Code));
            if (!verdict.Report) return;
            outcome = verdict.Refusal!;
        }
        else
        {
            try
            {
                outcome = await runner.RunAsync(command, receivedAt, grants.TokenFor(command.GrantId)).ConfigureAwait(false);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                // Whether input was sent is unknown, so that is the answer. It is never run again.
                log.Write("command.failed", ("commandId", command.CommandId), ("code", AgentFailure.UnknownError));
                outcome = CommandOutcome.Uncertain;
            }
        }
        await ReportAsync(command.CommandId, outcome, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Sends the answer — a few attempts, each a new signed request. The
    /// command itself is never run again; if no answer gets through, the
    /// server records it UNKNOWN.
    /// </summary>
    private async Task ReportAsync(string commandId, CommandOutcome outcome, CancellationToken cancellationToken)
    {
        for (var attempt = 1; attempt <= ResultAttempts; attempt++)
        {
            try
            {
                var answer = await client.SubmitResultAsync(pairing, commandId, outcome, cancellationToken).ConfigureAwait(false);
                grants.ServerContact();
                // CONFLICT means it was already answered, or recorded UNKNOWN; a
                // refusal that stops the agent is acted on by the next poll.
                if (!answer.Ok) log.Write("result.refused", ("commandId", commandId), ("code", AgentFailure.ServerRefusal), ("reason", answer.ErrorCode), ("httpStatus", answer.Status));
                return;
            }
            catch (AgentTransportException e)
            {
                var wait = TimeSpan.FromSeconds(attempt);
                log.Write("result.failed", ("commandId", commandId), ("attempt", attempt), ("code", e.Code), ("httpStatus", e.HttpStatus), ("retryInMs", attempt < ResultAttempts ? Milliseconds(wait) : (long?)null));
                await delay(wait, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Starts a grant from consent given on this computer. The text is the one
    /// the person saw, and must be exactly what the protocol renders; the
    /// server checks its hash again. Returns null, or the server's error code.
    /// </summary>
    public async Task<string?> StartGrantAsync(IReadOnlyCollection<string> scope, int durationMinutes, string shownText, bool extend, CancellationToken cancellationToken)
    {
        var expected = ConsentText.Render(pairing.UserLabel, pairing.OrganizationLabel, durationMinutes, scope);
        if (!string.Equals(expected, shownText, StringComparison.Ordinal)) return "CONSENT_MISMATCH";
        var replaces = extend ? grants.Active?.GrantId : null;
        if (extend && replaces is null) return "GRANT_INVALID";
        if (!extend && grants.Active is not null) return "GRANT_CONFLICT";
        var grant = grants.Prepare(scope, durationMinutes, ConsentText.Sha256(shownText));

        // No poll may be in flight that names another grant while this one starts.
        await exchange.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var answer = await client.StartGrantAsync(pairing, AgentInstanceId, grant, replaces, cancellationToken).ConfigureAwait(false);
            grants.ServerContact();
            if (!answer.Ok)
            {
                Refused(answer);
                return answer.ErrorCode;
            }
            var state = MessageParser.ParseGrantResponse(answer.Body);
            if (state.GrantId != grant.GrantId || state.Status != "active") return "GRANT_INVALID";
            if (!grants.Activate(grant, replaces)) return "GRANT_CONFLICT";
            log.Write("grant.started", ("grantId", grant.GrantId), ("durationMinutes", durationMinutes), ("scopeCount", grant.Scope.Count));
            return null;
        }
        catch (AgentTransportException e)
        {
            log.Write("grant.failed", ("code", e.Code), ("httpStatus", e.HttpStatus));
            return "UNAVAILABLE";
        }
        catch (Exception e) when (e is ProtocolViolationException or KeyNotFoundException or InvalidOperationException)
        {
            log.Write("grant.failed", ("code", AgentFailure.ResponseInvalid));
            return "INVALID_REQUEST";
        }
        finally
        {
            exchange.Release();
        }
    }

    /// <summary>A grant that ended here is reported, best effort; the next poll settles it either way.</summary>
    private void OnGrantEnded(LocalGrant grant, string reason)
    {
        log.Write("grant.ended", ("grantId", grant.GrantId), ("reason", reason));
        if (!ProtocolConstants.SessionEndReasons.Contains(reason)) return;
        _ = Task.Run(async () =>
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                await client.EndSessionAsync(pairing, AgentInstanceId, grant.GrantId, reason, timeout.Token).ConfigureAwait(false);
            }
            catch (Exception e) when (e is AgentTransportException or OperationCanceledException)
            {
                // A cancellation here is this request's own ten seconds running out.
                var failure = e as AgentTransportException;
                log.Write("session.end.unsent", ("grantId", grant.GrantId), ("code", failure?.Code ?? AgentFailure.TransportError), ("httpStatus", failure?.HttpStatus));
            }
        });
    }

    /// <summary>True when the refusal stops the agent for good.</summary>
    private bool Refused(AgentAnswer answer)
    {
        var code = answer.ErrorCode!;
        log.Write("server.refused", ("code", AgentFailure.ServerRefusal), ("reason", code), ("httpStatus", answer.Status));
        if (code is not ("DEVICE_REVOKED" or "AGENT_VERSION_UNSUPPORTED" or "WINDOWS_VERSION_UNSUPPORTED" or "NOT_AUTHORIZED")) return false;
        if (Interlocked.Exchange(ref stopped, 1) == 1) return true;
        switch (code)
        {
            case "DEVICE_REVOKED":
                grants.End(LocalEndReasons.Revoked);
                try
                {
                    store.Clear();
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    // Revoked, and something may be left behind: the runbook's checks exist for this.
                    log.Write("pairing.clear.failed", ("code", AgentFailure.UnknownError));
                }
                events.Stopped("revoked");
                return true;
            case "AGENT_VERSION_UNSUPPORTED":
            case "WINDOWS_VERSION_UNSUPPORTED":
                grants.End(LocalEndReasons.Server);
                events.Stopped("unsupported");
                return true;
            case "NOT_AUTHORIZED":
                grants.End(LocalEndReasons.Server);
                events.Stopped("not-authorized");
                return true;
            default:
                return false;
        }
    }

    public void Dispose()
    {
        grants.Ended -= OnGrantEnded;
        exchange.Dispose();
    }

    internal static TimeSpan Backoff(int failures) =>
        TimeSpan.FromSeconds(Math.Min(15, 1 << Math.Min(4, failures - 1)));

    private static long Milliseconds(TimeSpan wait) => (long)wait.TotalMilliseconds;
}
