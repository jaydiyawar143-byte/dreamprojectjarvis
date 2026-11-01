// ---------------------------------------------------------------------------
// Phase 19.6 — consent at the device, and how it ends (U5a, U5b).
//
// A grant exists only in this process's memory: it starts only from the local
// consent screen, lasts 15 minutes unless the person chooses otherwise (at most
// 60), and ends on expiry, on the kill switch, on lock or sign-out, when the
// agent stops, or when the server has not answered for 30 seconds. Extending
// is fresh consent, never a quiet renewal. Nothing about a grant is written to
// disk, so a restart cannot resume one.
// ---------------------------------------------------------------------------

namespace Jarvis.DesktopAgent.Core;

public interface IClock
{
    long NowMs { get; }
}

public sealed class SystemClock : IClock
{
    public long NowMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

public sealed record LocalGrant(string GrantId, IReadOnlyList<string> Scope, int DurationMinutes, long GrantedAt, long ExpiresAt, string ConsentTextSha256);

/// <summary>Why a grant ended here, when the server is not told: it already knows, or it said so.</summary>
public static class LocalEndReasons
{
    public const string Replaced = "replaced";
    public const string Server = "server";
    public const string Revoked = "revoked";
}

public sealed class GrantManager(IClock clock) : IDisposable
{
    private readonly object gate = new();
    private LocalGrant? current;
    private CancellationTokenSource? running;
    private long lastServerContact;

    /// <summary>Raised once whenever the grant ends, with the reason.</summary>
    public event Action<LocalGrant, string>? Ended;

    /// <summary>
    /// A grant from consent the person just gave on this computer, not yet in
    /// force. The duration is 1–60 minutes; anything else is refused, never
    /// clamped. Its clock starts now — when they chose Allow.
    /// </summary>
    public LocalGrant Prepare(IReadOnlyCollection<string> scope, int durationMinutes, string consentTextSha256)
    {
        if (durationMinutes < 1 || durationMinutes > ProtocolConstants.GrantMaxMinutes)
            throw new ArgumentOutOfRangeException(nameof(durationMinutes), "A grant lasts 1 to 60 minutes.");
        var canonical = ConsentText.CanonicalScope(scope) ?? throw new ArgumentException("Not a valid scope.", nameof(scope));
        var now = clock.NowMs;
        return new LocalGrant(Guid.NewGuid().ToString("D"), canonical, durationMinutes, now, now + (durationMinutes * 60_000L), consentTextSha256);
    }

    /// <summary>
    /// Puts a prepared grant in force once the server accepted it. It replaces
    /// only the grant it was prepared to replace; otherwise there must be none.
    /// </summary>
    public bool Activate(LocalGrant grant, string? replacesGrantId)
    {
        LocalGrant? replaced;
        CancellationTokenSource? previous;
        lock (gate)
        {
            if (current?.GrantId != replacesGrantId) return false;
            if (clock.NowMs >= grant.ExpiresAt) return false;
            replaced = current;
            previous = running;
            current = grant;
            running = new CancellationTokenSource();
            lastServerContact = clock.NowMs;
        }
        Finish(replaced, previous, LocalEndReasons.Replaced);
        return true;
    }

    /// <summary>The active grant, or null. An expired grant ends here, as it is asked about.</summary>
    public LocalGrant? Active
    {
        get
        {
            LocalGrant? expired;
            CancellationTokenSource? source;
            lock (gate)
            {
                if (current is null) return null;
                if (clock.NowMs < current.ExpiresAt) return current;
                expired = current;
                source = running;
                current = null;
                running = null;
            }
            Finish(expired, source, "expired");
            return null;
        }
    }

    /// <summary>Cancelled the moment this grant ends — by the kill switch, a lock, anything.</summary>
    public CancellationToken TokenFor(string grantId)
    {
        lock (gate)
        {
            return current?.GrantId == grantId && running is not null ? running.Token : new CancellationToken(canceled: true);
        }
    }

    /// <summary>Ends the grant, if there is one; true when it did.</summary>
    public bool End(string reason)
    {
        LocalGrant? ended;
        CancellationTokenSource? source;
        lock (gate)
        {
            ended = current;
            source = running;
            current = null;
            running = null;
        }
        return Finish(ended, source, reason);
    }

    /// <summary>Ends the grant only if it is still this one — an answer about an older grant changes nothing.</summary>
    public bool EndIf(string grantId, string reason)
    {
        LocalGrant? ended;
        CancellationTokenSource? source;
        lock (gate)
        {
            if (current?.GrantId != grantId) return false;
            ended = current;
            source = running;
            current = null;
            running = null;
        }
        return Finish(ended, source, reason);
    }

    public void ServerContact()
    {
        lock (gate) lastServerContact = clock.NowMs;
    }

    /// <summary>
    /// How long an exchange may stay open before <see cref="CheckReconnectGrace"/>
    /// would end the grant: one past the grace, which ends only once exceeded.
    /// Null with no grant, when nothing depends on the server answering.
    /// </summary>
    public TimeSpan? GraceLeft
    {
        get
        {
            lock (gate)
            {
                if (current is null) return null;
                return TimeSpan.FromMilliseconds(Math.Max(0, ProtocolConstants.ReconnectGraceMs - (clock.NowMs - lastServerContact) + 1));
            }
        }
    }

    /// <summary>U5b: past 30 seconds without the server, control ends; the grant's clock never paused.</summary>
    public void CheckReconnectGrace()
    {
        string? grantId;
        lock (gate) grantId = current is not null && clock.NowMs - lastServerContact > ProtocolConstants.ReconnectGraceMs ? current.GrantId : null;
        if (grantId is not null) EndIf(grantId, "disconnected");
    }

    private bool Finish(LocalGrant? ended, CancellationTokenSource? source, string reason)
    {
        // Cancelled, never disposed: a token already handed out must stay
        // safe to read and to link to after its grant is gone.
        source?.Cancel();
        if (ended is null) return false;
        Ended?.Invoke(ended, reason);
        return true;
    }

    public void Dispose() => End("shutdown");
}
