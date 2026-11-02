// ---------------------------------------------------------------------------
// Phase 19.6 — this computer's pairing, as the running agent knows it.
//
// The person confirms in the browser with the pairing window still open, so the
// server's verified answer is kept the moment it arrives: saved, and polling
// started. Nothing waits for a window to close. A process that ended before then
// would leave the server an active device this computer knows nothing about.
// After a restart nothing is assumed about the device: only the server says it
// is confirmed.
// ---------------------------------------------------------------------------

namespace Jarvis.DesktopAgent.Core;

public sealed class PairingState(IPairingStore store, AgentLog log, Action<Uri, Pairing> start)
{
    /// <summary>The server accepted this computer, and the pairing could not be kept here.</summary>
    public const string NotSaved = "NOT_SAVED";

    public Pairing? Current { get; private set; }

    /// <summary>"pending" or "active", as last heard. Null until the server has said, after a restart.</summary>
    public string? DeviceStatus { get; private set; }

    public bool Connected { get; private set; }

    /// <summary>Takes up what an earlier run kept. A pairing without its key is no pairing: the key never comes back.</summary>
    public void Restore(Func<bool> keyExists)
    {
        var kept = store.Load();
        if (kept is null || store.Server is not { } server) return;
        if (!keyExists())
        {
            store.Clear();
            return;
        }
        Current = kept;
        start(server, kept);
    }

    /// <summary>Pairs, and keeps a verified answer before returning. Stays on the caller's thread: the tray's.</summary>
    public async Task<(PairResponse? Paired, string? Error)> PairAsync(AgentClient client, string code, DeviceFacts facts, CancellationToken cancellationToken)
    {
        PairResponse? paired;
        string? error;
        try
        {
            (paired, error) = await client.PairAsync(code, facts, cancellationToken).ConfigureAwait(true);
        }
        catch (AgentTransportException e)
        {
            log.Write("pair.failed", ("code", e.Code), ("httpStatus", e.HttpStatus));
            return (null, null);
        }
        if (paired is null) return (null, error);
        return Keep(client.Server, paired) ? (paired, null) : (null, NotSaved);
    }

    private bool Keep(Uri server, PairResponse paired)
    {
        var kept = new Pairing(paired.DeviceId, paired.ServerPublicKey, paired.ServerKeyId, paired.UserLabel, paired.OrganizationLabel);
        try
        {
            store.Remember(server);
            store.Save(kept);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            log.Write("pair.save.failed", ("code", AgentFailure.UnknownError));
            GiveUpKey();
            return false;
        }
        Current = kept;
        DeviceStatus = "pending";
        Connected = false;
        log.Write("device.paired", ("deviceIdHash", AgentLog.DeviceIdHash(paired.DeviceId)));
        start(server, kept);
        return true;
    }

    /// <summary>The server never accepts a key twice, so the next attempt needs a new one.</summary>
    private void GiveUpKey()
    {
        try
        {
            store.Clear();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.Write("pairing.clear.failed", ("code", AgentFailure.UnknownError));
        }
    }

    public void Heard(string deviceStatus) => DeviceStatus = deviceStatus;

    public void Reached(bool connected) => Connected = connected;

    public void Forget()
    {
        Current = null;
        DeviceStatus = null;
        Connected = false;
    }
}
