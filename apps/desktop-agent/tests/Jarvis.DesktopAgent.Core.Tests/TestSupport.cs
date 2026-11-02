// ---------------------------------------------------------------------------
// Phase 19.6 — fakes for the agent's tests. A software key (tests only — the
// agent's own key lives in Windows' key storage and cannot be exported), a
// clock that moves when told, a server that signs its answers with the TEST
// key from the shared vectors, and stand-ins for everything Windows does.
// ---------------------------------------------------------------------------

using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jarvis.DesktopAgent.Core;

namespace Jarvis.DesktopAgent.Core.Tests;

internal static class Contract
{
    private static string Path(string name) => System.IO.Path.Combine(AppContext.BaseDirectory, "contract", name);

    public static JsonElement Load(string name)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(Path(name)));
        return document.RootElement.Clone();
    }

    public static JsonElement Vectors { get; } = Load("vectors.json");

    public static string ServerSpki => Vectors.GetProperty("serverKey").GetProperty("spki").GetString()!;

    public static string ServerKeyId => Vectors.GetProperty("serverKey").GetProperty("keyId").GetString()!;

    public static ECDsa ServerKey()
    {
        var key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(Convert.FromBase64String(Vectors.GetProperty("serverKey").GetProperty("pkcs8").GetString()!), out _);
        return key;
    }

    public static string ServerSign(string canonical)
    {
        using var key = ServerKey();
        return System.Buffers.Text.Base64Url.EncodeToString(
            key.SignData(Encoding.UTF8.GetBytes(canonical), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
    }
}

/// <summary>A software P-256 key. Tests only.</summary>
internal sealed class TestDeviceKey : IDeviceKey, IDisposable
{
    private readonly ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public string PublicKeySpki => Convert.ToBase64String(key.ExportSubjectPublicKeyInfo());

    public byte[] Sign(byte[] data) => key.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    public void Dispose() => key.Dispose();
}

/// <summary>A key that fails on the calls it is told to, counting from one.</summary>
internal sealed class FlakyDeviceKey(IDeviceKey inner, Func<int, bool> fails) : IDeviceKey
{
    private int calls;

    public string PublicKeySpki => inner.PublicKeySpki;

    public byte[] Sign(byte[] data) => fails(Interlocked.Increment(ref calls)) ? throw new CryptographicException("busy") : inner.Sign(data);
}

/// <summary>A key Windows has stopped answering for.</summary>
internal sealed class BrokenDeviceKey : IDeviceKey
{
    public string PublicKeySpki => "";

    public byte[] Sign(byte[] data) => throw new CryptographicException("the key is gone");
}

internal sealed class TestClock(long start = 1_767_225_600_000) : IClock
{
    private long now = start;
    private Stopwatch? running;

    public long NowMs
    {
        get => now + (running?.ElapsedMilliseconds ?? 0);
        set => now = value;
    }

    public void Advance(long ms) => now += ms;

    /// <summary>From here on real time passes too, for what waits on a real timer.</summary>
    public void Run() => running = Stopwatch.StartNew();
}

internal sealed class MemorySink : ILogSink
{
    public List<string> Lines { get; } = [];

    public void Append(string line)
    {
        lock (Lines) Lines.Add(line);
    }

    public string All
    {
        get
        {
            lock (Lines) return string.Join('\n', Lines);
        }
    }
}

/// <summary>What the fake server saw of one request.</summary>
internal sealed record SeenRequest(string Path, Dictionary<string, string> Headers, byte[] Body)
{
    public JsonElement Json
    {
        get
        {
            using var document = JsonDocument.Parse(Body);
            return document.RootElement.Clone();
        }
    }
}

/// <summary>
/// The server, as far as the agent can tell: answers signed with the test
/// server key for the request's nonce. A test can tamper with any part.
/// </summary>
internal sealed class FakeServer : HttpMessageHandler
{
    public List<SeenRequest> Requests { get; } = [];

    /// <summary>Answers by path; the default is 404.</summary>
    public Func<SeenRequest, (int Status, string Body)> Respond { get; set; } = _ => (404, "{}");

    /// <summary>Changes what is signed or sent, to test that the agent notices.</summary>
    public Func<string, string>? NonceOverride { get; set; }

    public Func<string, string>? BodyAfterSigning { get; set; }

    public string? SignatureOverride { get; set; }

    public string KeyId { get; set; } = Contract.ServerKeyId;

    public bool Unreachable { get; set; }

    /// <summary>What the failure says. A real one names the address it tried.</summary>
    public string UnreachableMessage { get; set; } = "unreachable";

    /// <summary>Answers as something in front of the server would: no signature headers at all.</summary>
    public bool Unsigned { get; set; }

    /// <summary>Never answers; the client has to give up.</summary>
    public bool Hang { get; set; }

    /// <summary>Holds each request this long before answering, as the real server holds a poll.</summary>
    public TimeSpan Hold { get; set; }

    /// <summary>Sends the body as a stream of these bytes instead of a body of known length.</summary>
    public Func<byte[], Stream>? BodyStream { get; set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (Unreachable) throw new HttpRequestException(UnreachableMessage);
        if (Hang) await Task.Delay(Timeout.Infinite, cancellationToken);
        if (Hold > TimeSpan.Zero) await Task.Delay(Hold, cancellationToken);
        var headers = request.Headers.ToDictionary(h => h.Key.ToLowerInvariant(), h => string.Join(",", h.Value));
        var body = await request.Content!.ReadAsByteArrayAsync(cancellationToken);
        var seen = new SeenRequest(request.RequestUri!.AbsolutePath, headers, body);
        lock (Requests) Requests.Add(seen);
        var (status, text) = Respond(seen);
        var nonce = NonceOverride?.Invoke(headers["x-jarvis-nonce"]) ?? headers["x-jarvis-nonce"];
        var signature = SignatureOverride ?? Contract.ServerSign(Canonical.Response(nonce, status, Canonical.Sha256Hex(text)));
        var sent = BodyAfterSigning?.Invoke(text) ?? text;
        var response = new HttpResponseMessage((HttpStatusCode)status)
        {
            Content = BodyStream is { } stream ? new StreamContent(stream(Encoding.UTF8.GetBytes(sent))) : new StringContent(sent, Encoding.UTF8, "application/json"),
        };
        if (Unsigned) return response;
        response.Headers.Add("x-jarvis-response-signature", signature);
        response.Headers.Add("x-jarvis-response-key", KeyId);
        return response;
    }

    public static string Error(string code) => $$$"""{"version":"jarvis-desktop/1","error":{"code":"{{{code}}}"}}""";
}

/// <summary>A body of no declared length. When broken, it fails after its bytes, as a dropped connection does.</summary>
internal sealed class WireStream(byte[] bytes, bool broken) : Stream
{
    private int position;

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (position == bytes.Length)
        {
            if (broken) throw new IOException("The connection was reset.");
            return 0;
        }
        var read = Math.Min(count, bytes.Length - position);
        Array.Copy(bytes, position, buffer, offset, read);
        position += read;
        return read;
    }

    public override void Flush() => throw new NotSupportedException();

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

internal sealed class FakeInspector : IDesktopInspector
{
    public ScreenArea VirtualScreen { get; set; } = new(-1920, 0, 3840, 1080);

    public WindowTarget? ForegroundWindow { get; set; } = Notepad;

    public Func<int, int, WindowTarget?> AtPoint { get; set; } = (_, _) => Notepad;

    public List<(int X, int Y)> Probed { get; } = [];

    /// <summary>Called each time the foreground is read — lets a test change it mid-command.</summary>
    public Action<int>? OnForegroundRead { get; set; }

    private int reads;

    public WindowTarget? Foreground()
    {
        OnForegroundRead?.Invoke(++reads);
        return ForegroundWindow;
    }

    public WindowTarget? At(int screenX, int screenY)
    {
        Probed.Add((screenX, screenY));
        return AtPoint(screenX, screenY);
    }

    public static readonly WindowTarget Notepad = new(0x1001, 4242, "notepad.exe", "Untitled - Notepad", Elevated: false, Protected: false);
    public static readonly WindowTarget Admin = new(0x2002, 777, "regedit.exe", "Registry Editor", Elevated: true, Protected: false);
    public static readonly WindowTarget Agent = new(0x3003, 999, "Jarvis.DesktopAgent.exe", "JARVIS", Elevated: false, Protected: true);
}

internal sealed class FakeInjector : IInputInjector
{
    public List<string> Sent { get; } = [];

    public Func<string, InjectionResult> Result { get; set; } = _ => InjectionResult.Completed;

    public InjectionResult Click(int screenX, int screenY, string button) => Record($"click:{screenX},{screenY},{button}");

    public InjectionResult Key(string key) => Record($"key:{key}");

    public InjectionResult Type(string text) => Record($"type:{text}");

    private InjectionResult Record(string what)
    {
        var result = Result(what);
        if (result != InjectionResult.NothingSent) Sent.Add(what);
        return result;
    }
}

internal sealed class FakeLauncher : IAppLauncher
{
    public List<string> Opened { get; } = [];

    public LaunchResult Result { get; set; } = LaunchResult.Started;

    /// <summary>Thrown instead of answering, as something no step expected.</summary>
    public Exception? Throws { get; set; }

    public LaunchResult Launch(string app)
    {
        lock (Opened) Opened.Add(app);
        if (Throws is not null) throw Throws;
        return Result;
    }
}

internal sealed class FakeHello : IHelloVerifier
{
    public HelloResult Result { get; set; } = HelloResult.Verified;

    public List<string> Prompts { get; } = [];

    /// <summary>Runs while the prompt is "open" — a test can end the grant, move time, change the window.</summary>
    public Func<CancellationToken, Task>? WhileOpen { get; set; }

    public async Task<HelloResult> VerifyAsync(string message, CancellationToken cancellationToken)
    {
        Prompts.Add(message);
        if (WhileOpen is not null) await WhileOpen(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        return Result;
    }
}

internal sealed class FakeSession : ISessionState
{
    public bool IsLocked { get; set; }
}

internal sealed class MemoryPairingStore : IPairingStore
{
    public Pairing? Stored { get; set; }

    public bool Cleared { get; private set; }

    public bool ClearThrows { get; set; }

    /// <summary>What saving fails with, when it fails.</summary>
    public Exception? SaveFails { get; set; }

    public Uri? Server { get; private set; }

    public Pairing? Load() => Stored;

    public void Remember(Uri server) => Server = server;

    public void Save(Pairing pairing)
    {
        if (SaveFails is not null) throw SaveFails;
        Stored = pairing;
    }

    public void Clear()
    {
        if (ClearThrows) throw new UnauthorizedAccessException("denied");
        Stored = null;
        Server = null;
        Cleared = true;
    }
}

internal sealed class RecordingEvents : IAgentEvents
{
    public List<string> Seen { get; } = [];

    public void DeviceStatusChanged(string status) => Seen.Add($"status:{status}");

    public void ConnectionChanged(bool connected) => Seen.Add($"connected:{connected}");

    public void Stopped(string reason) => Seen.Add($"stopped:{reason}");
}

/// <summary>A body that starts and then stops, as a link does when it dies quietly: the read waits until it is cancelled.</summary>
internal sealed class StalledStream(byte[] bytes) : Stream
{
    private int position;

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (position < bytes.Length)
        {
            var read = Math.Min(buffer.Length, bytes.Length - position);
            bytes.AsMemory(position, read).CopyTo(buffer);
            position += read;
            return read;
        }
        await Task.Delay(Timeout.Infinite, cancellationToken);
        return 0;
    }

    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    public override void Flush() => throw new NotSupportedException();

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

/// <summary>A body that arrives one byte at a time, a little later each time. With no bytes given it never finishes.</summary>
internal sealed class DrippingStream(byte[]? bytes = null) : Stream
{
    private int position;

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        await Task.Delay(10, cancellationToken);
        if (bytes is not null && position == bytes.Length) return 0;
        buffer.Span[0] = bytes is null ? (byte)'a' : bytes[position++];
        return 1;
    }

    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    public override void Flush() => throw new NotSupportedException();

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

/// <summary>Builds commands as the server signs them.</summary>
internal static class Commands
{
    public const string DeviceId = "8f14e45f-ceea-467a-9ad1-0e9a5b0b7d2c";

    public static CommandEnvelope Sign(CommandParams parameters, string grantId, long issuedAt, string? commandId = null, string deviceId = DeviceId, bool? requiresHello = null, long lifetime = 30_000)
    {
        var unsigned = new CommandEnvelope(
            commandId ?? Guid.NewGuid().ToString("D"),
            deviceId,
            grantId,
            parameters,
            issuedAt,
            issuedAt + lifetime,
            requiresHello ?? ProtocolConstants.HelloActions.Contains(parameters.Action),
            "");
        return unsigned with { Signature = Contract.ServerSign(Canonical.Command(unsigned)) };
    }

    public static string Json(CommandEnvelope c)
    {
        var parameters = c.Params switch
        {
            ClickParams p => new Dictionary<string, object> { ["x"] = p.X, ["y"] = p.Y, ["button"] = p.Button },
            KeyParams p => new Dictionary<string, object> { ["key"] = p.Key },
            TypeParams p => new Dictionary<string, object> { ["text"] = p.Text },
            LaunchParams p => new Dictionary<string, object> { ["app"] = p.App },
            _ => throw new ArgumentException("params"),
        };
        return JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["commandId"] = c.CommandId,
            ["deviceId"] = c.DeviceId,
            ["grantId"] = c.GrantId,
            ["action"] = c.Action,
            ["params"] = parameters,
            ["issuedAt"] = c.IssuedAt,
            ["expiresAt"] = c.ExpiresAt,
            ["requiresHello"] = c.RequiresHello,
            ["signature"] = c.Signature,
        });
    }
}
