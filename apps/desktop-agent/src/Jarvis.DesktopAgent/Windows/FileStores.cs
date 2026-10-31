// ---------------------------------------------------------------------------
// Phase 19.6 — the only two files the agent writes.
//
// pairing.json: the server's address, the device id, the pinned server key and
// the two labels the consent screen shows. Nothing secret — the private key is
// in Windows' key storage — but the agent trusts nothing it did not write: a
// file that does not parse is no pairing at all.
// agent.log: AgentLog's value-free lines, rotated at 1 MB, one old file kept.
// The agent reads and writes no other file.
// ---------------------------------------------------------------------------

using System.Text.Json;
using Jarvis.DesktopAgent.Core;

namespace Jarvis.DesktopAgent.Windows;

internal sealed record StoredPairing(string Server, Pairing Pairing);

internal sealed class FilePairingStore(string directory) : IPairingStore
{
    private string FilePath => Path.Combine(directory, "pairing.json");

    /// <summary>The server's address, saved with the pairing.</summary>
    public Uri? Server { get; private set; }

    public Pairing? Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            var stored = JsonSerializer.Deserialize<StoredPairing>(File.ReadAllText(FilePath));
            if (stored is null || !Uri.TryCreate(stored.Server, UriKind.Absolute, out var server) || server.Scheme != Uri.UriSchemeHttps) return null;
            var p = stored.Pairing;
            if (!Guid.TryParseExact(p.DeviceId, "D", out _) || Fingerprint.ServerKeyId(p.ServerPublicKey) != p.ServerKeyId) return null;
            Server = server;
            return p;
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException or FormatException or NotSupportedException)
        {
            return null;
        }
    }

    public void Remember(Uri server) => Server = server;

    public void Save(Pairing pairing)
    {
        if (Server is null) throw new InvalidOperationException("The server address is not known.");
        var temporary = FilePath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(new StoredPairing(Server.ToString(), pairing)));
        File.Move(temporary, FilePath, overwrite: true);
    }

    public void Clear()
    {
        try
        {
            File.Delete(FilePath);
        }
        catch (IOException)
        {
            // Gone already, or in use: the key below is what matters.
        }
        CngDeviceKey.Delete();
        Server = null;
    }
}

internal sealed class FileLogSink(string directory) : ILogSink
{
    private const long MaxBytes = 1024 * 1024;
    private readonly object gate = new();

    public void Append(string line)
    {
        lock (gate)
        {
            var path = Path.Combine(directory, "agent.log");
            var info = new FileInfo(path);
            if (info.Exists && info.Length > MaxBytes) File.Move(path, path + ".1", overwrite: true);
            File.AppendAllText(path, line + Environment.NewLine);
        }
    }
}
