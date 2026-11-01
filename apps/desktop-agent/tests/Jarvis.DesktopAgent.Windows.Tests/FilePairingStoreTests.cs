// ---------------------------------------------------------------------------
// Phase 19.6 — a revoked computer deletes its key even when its pairing file
// will not go. The delete is always injected here: the real one acts on this
// person's real device key, which no test may touch.
// ---------------------------------------------------------------------------

using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jarvis.DesktopAgent.Core;
using Jarvis.DesktopAgent.Windows;
using Xunit;

namespace Jarvis.DesktopAgent.Windows.Tests;

public sealed class FilePairingStoreTests : IDisposable
{
    private static readonly Uri Origin = new("https://jarvis.test/");
    private const string DeviceId = "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c";

    private readonly string directory = Directory.CreateTempSubdirectory("jarvis-store-").FullName;

    private string PairingFile => Path.Combine(directory, "pairing.json");

    /// <summary>A software key. The real device key is never opened here.</summary>
    private sealed class SoftwareKey : IDeviceKey, IDisposable
    {
        private readonly ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        public string PublicKeySpki => Convert.ToBase64String(key.ExportSubjectPublicKeyInfo());

        public byte[] Sign(byte[] data) => key.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

        public void Dispose() => key.Dispose();
    }

    /// <summary>The server's pairing answer, signed as the real one is. Nothing here listens or connects.</summary>
    private sealed class PairingServer(SoftwareKey serverKey, IDeviceKey deviceKey) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = JsonSerializer.Serialize(new Dictionary<string, string>
            {
                ["version"] = ProtocolConstants.ProtocolVersion,
                ["deviceId"] = DeviceId,
                ["fingerprint"] = Fingerprint.Of(deviceKey.PublicKeySpki),
                ["status"] = "pending",
                ["serverKeyId"] = Fingerprint.ServerKeyId(serverKey.PublicKeySpki),
                ["serverPublicKey"] = serverKey.PublicKeySpki,
                ["userLabel"] = "Ada Lovelace",
                ["organizationLabel"] = "Analytical Engines",
            });
            var nonce = request.Headers.GetValues("x-jarvis-nonce").Single();
            var signature = Signatures.Sign(serverKey, Canonical.Response(nonce, 200, Canonical.Sha256Hex(body)));
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            response.Headers.Add("x-jarvis-response-signature", signature);
            response.Headers.Add("x-jarvis-response-key", Fingerprint.ServerKeyId(serverKey.PublicKeySpki));
            return Task.FromResult(response);
        }
    }

    private AgentLog Log() => new(new FileLogSink(directory), new SystemClock());

    private FilePairingStore Store(Action? deleteKey = null) =>
        new(directory, deleteKey ?? (() => throw new InvalidOperationException("nothing here may delete a key")));

    private async Task<Pairing> PairThroughTheRealStore()
    {
        using var serverKey = new SoftwareKey();
        using var deviceKey = new SoftwareKey();
        using var handler = new PairingServer(serverKey, deviceKey);
        using var http = new HttpClient(handler);
        var state = new PairingState(Store(), Log(), (_, _) => { });
        var client = new AgentClient(http, Origin, deviceKey, new SystemClock());
        var (paired, error) = await state.PairAsync(client, "7K3M-Q9X2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01", new DeviceFacts("PC", 26100, "x64"), CancellationToken.None);
        Assert.Null(error);
        Assert.NotNull(paired);
        return state.Current!;
    }

    [Fact]
    public async Task A_paired_computer_is_paired_on_disk_with_its_window_still_open()
    {
        await PairThroughTheRealStore();
        Assert.True(File.Exists(PairingFile));
        Assert.False(File.Exists(PairingFile + ".tmp"));
    }

    [Fact]
    public async Task A_restart_brings_back_exactly_what_pairing_kept()
    {
        var kept = await PairThroughTheRealStore();

        // A new process: a new store and state over the same folder.
        var store = Store();
        Uri? server = null;
        Pairing? polling = null;
        var restarted = new PairingState(store, Log(), (origin, pairing) => (server, polling) = (origin, pairing));
        restarted.Restore(() => true);

        Assert.Equal(kept, restarted.Current);
        Assert.Equal(kept, polling);
        Assert.Equal(Origin, server);
    }

    [Fact]
    public async Task The_tray_shows_a_restarted_computer_as_paired_and_then_as_confirmed()
    {
        await PairThroughTheRealStore();

        var restarted = new PairingState(Store(), Log(), (_, _) => { });
        Assert.Equal("Not paired", TrayView.Of(restarted.Current is not null, restarted.DeviceStatus, restarted.Connected, false, false).Status);
        restarted.Restore(() => true);
        Assert.Equal("Not connected", TrayView.Of(restarted.Current is not null, restarted.DeviceStatus, restarted.Connected, false, false).Status);

        // What the poll loop reports once the server answers.
        restarted.Reached(true);
        restarted.Heard("active");
        var view = TrayView.Of(restarted.Current is not null, restarted.DeviceStatus, restarted.Connected, false, false);
        Assert.Equal("Paired — control not allowed", view.Status);
        Assert.True(view.CanAllow);
    }

    [Fact]
    public async Task A_restart_leaves_the_pairing_file_alone()
    {
        await PairThroughTheRealStore();
        var written = File.ReadAllBytes(PairingFile);
        new PairingState(Store(), Log(), (_, _) => { }).Restore(() => true);
        Assert.Equal(written, File.ReadAllBytes(PairingFile));
    }

    public void Dispose()
    {
        foreach (var file in Directory.EnumerateFiles(directory)) File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(directory, recursive: true);
    }

    [Fact]
    public void Deletes_the_pairing_file_and_then_the_key()
    {
        File.WriteAllText(PairingFile, "{}");
        var tried = 0;
        new FilePairingStore(directory, () => tried++).Clear();
        Assert.False(File.Exists(PairingFile));
        Assert.Equal(1, tried);
    }

    [Fact]
    public void Tries_the_key_even_when_the_pairing_file_refuses_to_go()
    {
        File.WriteAllText(PairingFile, "{}");
        File.SetAttributes(PairingFile, FileAttributes.ReadOnly);
        var tried = 0;
        new FilePairingStore(directory, () => tried++).Clear();
        Assert.True(File.Exists(PairingFile));
        Assert.Equal(1, tried);
    }

    [Fact]
    public void Tries_the_key_when_the_pairing_file_is_in_use()
    {
        File.WriteAllText(PairingFile, "{}");
        using var open = new FileStream(PairingFile, FileMode.Open, FileAccess.Read, FileShare.None);
        var tried = 0;
        new FilePairingStore(directory, () => tried++).Clear();
        Assert.Equal(1, tried);
    }

    [Fact]
    public void Tries_the_key_when_there_is_no_pairing_file()
    {
        var tried = 0;
        new FilePairingStore(directory, () => tried++).Clear();
        Assert.Equal(1, tried);
    }

    [Fact]
    public void Forgets_the_server_even_when_the_key_delete_fails()
    {
        File.WriteAllText(PairingFile, """{"Server":"https://jarvis.test/","Pairing":{}}""");
        var store = new FilePairingStore(directory, () => throw new InvalidOperationException("no key store"));
        store.Remember(new Uri("https://jarvis.test/"));
        Assert.Throws<InvalidOperationException>(store.Clear);
        Assert.Null(store.Server);
    }
}
