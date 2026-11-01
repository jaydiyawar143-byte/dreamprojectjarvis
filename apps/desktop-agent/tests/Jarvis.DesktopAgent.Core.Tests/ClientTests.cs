// ---------------------------------------------------------------------------
// Phase 19.6 — the signed HTTPS client and the poll loop, against a fake
// server that signs with the TEST key. Each request is signed over the exact
// bytes sent; an answer is used only when signed by the pinned key for that
// very request; a revoked device forgets itself; consent starts a grant only
// with the exact text; nothing is replayed or retried. A failure says which
// kind it was, by a stable code, and never in the server's words.
// ---------------------------------------------------------------------------

using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Jarvis.DesktopAgent.Core;
using Xunit;

namespace Jarvis.DesktopAgent.Core.Tests;

public sealed class ClientTests : IDisposable
{
    internal static readonly Uri Origin = new("https://jarvis.test/");
    private static readonly JsonElement Schemas = Contract.Load("schemas.json");

    private readonly FakeServer server = new();
    private readonly HttpClient http;
    private readonly TestDeviceKey key = new();
    private readonly TestClock clock = new();
    private readonly AgentClient client;

    internal static Pairing Paired => new(Commands.DeviceId, Contract.ServerSpki, Contract.ServerKeyId, "Ada Lovelace", "Analytical Engines");

    public ClientTests()
    {
        http = new HttpClient(server);
        client = new AgentClient(http, Origin, key, clock);
    }

    public void Dispose()
    {
        http.Dispose();
        key.Dispose();
    }

    private static string Ack => """{"version":"jarvis-desktop/1","ok":true}""";

    private static void AssertMatchesSchema(string message, JsonElement body)
    {
        var schema = Schemas.GetProperty(message);
        var variants = schema.TryGetProperty("anyOf", out var anyOf) ? anyOf.EnumerateArray().ToList() : [schema];
        var names = body.EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToList();
        Assert.Contains(variants, v =>
            v.GetProperty("properties").EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).SequenceEqual(names)
            && v.GetProperty("required").EnumerateArray().All(r => names.Contains(r.GetString()!)));
    }

    [Fact]
    public async Task Signs_each_request_over_the_exact_bytes_it_sends()
    {
        server.Respond = _ => (200, Ack);
        await client.SubmitResultAsync(Paired, "11111111-1111-4111-8111-111111111111", CommandOutcome.Succeeded, CancellationToken.None);
        var seen = Assert.Single(server.Requests);
        Assert.Equal("/api/v1/desktop-agent/commands/11111111-1111-4111-8111-111111111111/result", seen.Path);
        Assert.Equal(Canonical.Sha256Hex(seen.Body), seen.Headers["x-jarvis-content-sha256"]);
        Assert.Equal(Commands.DeviceId, seen.Headers["x-jarvis-device"]);
        Assert.Equal(ProtocolConstants.ProtocolVersion, seen.Headers["x-jarvis-desktop-version"]);
        var canonical = Canonical.Request("POST", seen.Path, seen.Headers["x-jarvis-timestamp"], seen.Headers["x-jarvis-nonce"], Commands.DeviceId, Canonical.Sha256Hex(seen.Body));
        Assert.True(Signatures.Verify(key.PublicKeySpki, canonical, seen.Headers["x-jarvis-signature"]));
        Assert.False(Signatures.Verify(key.PublicKeySpki, canonical.Replace("/result", "/other", StringComparison.Ordinal), seen.Headers["x-jarvis-signature"]));
    }

    [Fact]
    public async Task Sends_exactly_the_fields_each_message_declares()
    {
        server.Respond = r => r.Path.EndsWith("/pair", StringComparison.Ordinal) ? (400, FakeServer.Error("PAIRING_CODE_INVALID")) : (200, Ack);
        var grant = new GrantManager(clock).Prepare(ProtocolConstants.CommandActions, 15, new string('a', 64));
        await client.PairAsync("7K3M-Q9X2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01", new DeviceFacts("PC", 26100, "x64"), CancellationToken.None);
        await client.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None);
        await client.StartGrantAsync(Paired, Guid.NewGuid().ToString("D"), grant, null, CancellationToken.None);
        await client.EndSessionAsync(Paired, Guid.NewGuid().ToString("D"), grant.GrantId, "kill-switch", CancellationToken.None);
        await client.SubmitResultAsync(Paired, Guid.NewGuid().ToString("D"), CommandOutcome.NotExecuted("HELLO_UNAVAILABLE"), CancellationToken.None);
        string[] messages = ["PairRequest", "PollRequest", "GrantRequest", "SessionEndRequest", "CommandResult"];
        Assert.Equal(messages.Length, server.Requests.Count);
        for (var i = 0; i < messages.Length; i++) AssertMatchesSchema(messages[i], server.Requests[i].Json);
    }

    [Fact]
    public async Task Never_reuses_a_nonce()
    {
        server.Respond = _ => (200, Ack);
        for (var i = 0; i < 20; i++) await client.SubmitResultAsync(Paired, Guid.NewGuid().ToString("D"), CommandOutcome.Succeeded, CancellationToken.None);
        var nonces = server.Requests.Select(r => r.Headers["x-jarvis-nonce"]).ToList();
        Assert.Equal(nonces.Count, nonces.Distinct().Count());
        Assert.All(nonces, n => Assert.Matches("^[A-Za-z0-9_-]{24}$", n));
    }

    [Theory]
    [InlineData("http://jarvis.test/")]
    [InlineData("https://jarvis.test/api/")]
    [InlineData("https://user:pass@jarvis.test/")]
    [InlineData("https://jarvis.test/?x=1")]
    public void Talks_only_to_an_https_origin(string origin)
    {
        Assert.Throws<ArgumentException>(() => new AgentClient(http, new Uri(origin), key, clock));
    }

    [Fact]
    public async Task Discards_an_answer_signed_for_another_request()
    {
        server.Respond = _ => (200, Ack);
        server.NonceOverride = _ => "AAAAAAAAAAAAAAAAAAAAAAAA";
        await Assert.ThrowsAsync<AgentTransportException>(() => client.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None));
    }

    [Fact]
    public async Task Discards_an_answer_altered_after_signing()
    {
        server.Respond = _ => (403, FakeServer.Error("NOT_FOUND"));
        server.BodyAfterSigning = _ => FakeServer.Error("DEVICE_REVOKED");
        await Assert.ThrowsAsync<AgentTransportException>(() => client.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None));
    }

    [Fact]
    public async Task Discards_an_answer_signed_by_another_key_or_naming_another()
    {
        using var other = new TestDeviceKey();
        server.Respond = _ => (200, Ack);
        server.SignatureOverride = Signatures.Sign(other, "anything");
        await Assert.ThrowsAsync<AgentTransportException>(() => client.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None));
        server.SignatureOverride = null;
        server.KeyId = "0000000000000000";
        await Assert.ThrowsAsync<AgentTransportException>(() => client.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None));
    }

    [Fact]
    public async Task Refuses_an_oversized_answer_and_never_follows_a_redirect()
    {
        server.Respond = _ => (200, "{\"pad\":\"" + new string('a', AgentClient.MaxResponseBytes) + "\"}");
        await Assert.ThrowsAsync<AgentTransportException>(() => client.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None));
        server.Respond = _ => (302, "{}");
        await Assert.ThrowsAsync<AgentTransportException>(() => client.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None));
    }

    private Task<AgentTransportException> FailedPoll(AgentClient? through = null) =>
        Assert.ThrowsAsync<AgentTransportException>(() => (through ?? client).PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None));

    [Fact]
    public async Task Says_the_transport_failed_when_the_server_cannot_be_reached()
    {
        server.Unreachable = true;
        var failure = await FailedPoll();
        Assert.Equal("TRANSPORT_ERROR", failure.Code);
        Assert.Null(failure.HttpStatus);
    }

    [Fact]
    public async Task Says_the_transport_failed_when_the_server_does_not_answer_in_time()
    {
        server.Hang = true;
        using var impatient = new HttpClient(server, disposeHandler: false) { Timeout = TimeSpan.FromMilliseconds(50) };
        var failure = await FailedPoll(new AgentClient(impatient, Origin, key, clock));
        Assert.Equal("TRANSPORT_ERROR", failure.Code);
        Assert.Null(failure.HttpStatus);
    }

    [Fact]
    public async Task Says_the_transport_failed_when_the_connection_drops_during_the_answer()
    {
        server.Respond = _ => (200, Ack);
        server.BodyStream = bytes => new WireStream(bytes[..4], broken: true);
        var failure = await FailedPoll();
        Assert.Equal("TRANSPORT_ERROR", failure.Code);
        Assert.Null(failure.HttpStatus);
    }

    [Fact]
    public async Task Leaves_the_agents_own_cancellation_unclassified()
    {
        server.Hang = true;
        using var cancelled = new CancellationTokenSource(TimeSpan.FromMilliseconds(20));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, cancelled.Token));
    }

    [Theory]
    [InlineData(200, "<html>Sign in to this network</html>")]
    [InlineData(403, "")]
    public async Task Says_a_signed_answer_was_not_json(int status, string body)
    {
        server.Respond = _ => (status, body);
        var failure = await FailedPoll();
        Assert.Equal("RESPONSE_NOT_JSON", failure.Code);
        Assert.Equal(status, failure.HttpStatus);
    }

    [Theory]
    [InlineData(200)]
    [InlineData(403)]
    public async Task Says_a_signature_that_does_not_verify_is_not_signed(int status)
    {
        server.Respond = _ => (status, FakeServer.Error("DEVICE_REVOKED"));
        server.SignatureOverride = new string('A', 86);
        var failure = await FailedPoll();
        Assert.Equal("RESPONSE_NOT_SIGNED", failure.Code);
        Assert.Equal(status, failure.HttpStatus);
    }

    [Fact]
    public async Task Says_a_signature_naming_another_key_is_not_signed()
    {
        server.Respond = _ => (403, FakeServer.Error("DEVICE_REVOKED"));
        server.KeyId = "0000000000000000";
        var failure = await FailedPoll();
        Assert.Equal("RESPONSE_NOT_SIGNED", failure.Code);
        Assert.Equal(403, failure.HttpStatus);
    }

    [Fact]
    public async Task Says_a_success_with_no_signature_is_not_signed()
    {
        server.Respond = _ => (200, Ack);
        server.Unsigned = true;
        var failure = await FailedPoll();
        Assert.Equal("RESPONSE_NOT_SIGNED", failure.Code);
        Assert.Equal(200, failure.HttpStatus);
    }

    [Theory]
    [InlineData(404)]
    [InlineData(502)]
    [InlineData(503)]
    public async Task Says_a_failure_status_with_no_signature_is_an_http_error(int status)
    {
        server.Respond = _ => (status, "<html>Bad Gateway</html>");
        server.Unsigned = true;
        var failure = await FailedPoll();
        Assert.Equal("HTTP_STATUS_ERROR", failure.Code);
        Assert.Equal(status, failure.HttpStatus);
    }

    [Fact]
    public async Task Says_a_redirect_is_an_http_error()
    {
        server.Respond = _ => (302, "{}");
        var failure = await FailedPoll();
        Assert.Equal("HTTP_STATUS_ERROR", failure.Code);
        Assert.Equal(302, failure.HttpStatus);
    }

    [Fact]
    public async Task Says_an_answer_is_too_large_when_it_declares_its_size()
    {
        server.Respond = _ => (200, "{\"pad\":\"" + new string('a', AgentClient.MaxResponseBytes) + "\"}");
        var failure = await FailedPoll();
        Assert.Equal("RESPONSE_TOO_LARGE", failure.Code);
        Assert.Equal(200, failure.HttpStatus);
    }

    [Fact]
    public async Task Says_an_answer_is_too_large_when_it_grows_past_the_limit()
    {
        server.Respond = _ => (200, "{\"pad\":\"" + new string('a', AgentClient.MaxResponseBytes) + "\"}");
        server.BodyStream = bytes => new WireStream(bytes, broken: false);
        var failure = await FailedPoll();
        Assert.Equal("RESPONSE_TOO_LARGE", failure.Code);
        Assert.Equal(200, failure.HttpStatus);
    }

    /// <summary>The client's own timeout is short, so a bound that honours it needs no long wait here.</summary>
    private async Task<AgentTransportException> FailureOfASlowBody(Func<byte[], Stream> body)
    {
        server.Respond = _ => (200, Ack);
        server.BodyStream = body;
        using var impatient = new HttpClient(server, disposeHandler: false) { Timeout = TimeSpan.FromMilliseconds(100) };
        using var abandon = new CancellationTokenSource();
        var poll = new AgentClient(impatient, Origin, key, clock).PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, abandon.Token);
        try
        {
            Assert.Same(poll, await Task.WhenAny(poll, Task.Delay(TimeSpan.FromSeconds(3))));
            return await Assert.ThrowsAsync<AgentTransportException>(() => poll);
        }
        finally
        {
            await abandon.CancelAsync();
        }
    }

    [Fact]
    public async Task Gives_up_on_a_body_that_stalls()
    {
        var failure = await FailureOfASlowBody(bytes => new StalledStream(bytes[..4]));
        Assert.Equal("TRANSPORT_ERROR", failure.Code);
    }

    [Fact]
    public async Task Gives_up_on_a_body_that_only_drips()
    {
        var failure = await FailureOfASlowBody(_ => new DrippingStream());
        Assert.Equal("TRANSPORT_ERROR", failure.Code);
    }

    [Fact]
    public async Task Bounds_the_body_when_the_client_would_wait_far_longer()
    {
        server.Respond = _ => (200, Ack);
        server.BodyStream = bytes => new StalledStream(bytes[..4]);
        var bounded = new AgentClient(http, Origin, key, clock) { MaxBodyRead = TimeSpan.FromMilliseconds(100) };
        var poll = bounded.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None);
        Assert.Same(poll, await Task.WhenAny(poll, Task.Delay(TimeSpan.FromSeconds(3))));
        var failure = await Assert.ThrowsAsync<AgentTransportException>(() => poll);
        Assert.Equal("TRANSPORT_ERROR", failure.Code);
    }

    [Fact]
    public async Task Reads_a_slow_body_that_finishes_inside_the_bound_and_checks_its_signature()
    {
        server.Respond = _ => (200, Ack);
        server.BodyStream = bytes => new DrippingStream(bytes);
        using var patient = new HttpClient(server, disposeHandler: false) { Timeout = TimeSpan.FromSeconds(5) };
        var answer = await new AgentClient(patient, Origin, key, clock).PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None);
        Assert.True(answer.Ok);

        server.SignatureOverride = new string('A', 86);
        var failure = await Assert.ThrowsAsync<AgentTransportException>(() => new AgentClient(patient, Origin, key, clock).PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None));
        Assert.Equal("RESPONSE_NOT_SIGNED", failure.Code);
    }

    [Fact]
    public async Task Gives_up_on_a_pairing_answer_that_stalls()
    {
        server.Respond = _ => (200, Ack);
        server.BodyStream = bytes => new StalledStream(bytes[..4]);
        using var impatient = new HttpClient(server, disposeHandler: false) { Timeout = TimeSpan.FromMilliseconds(100) };
        var pair = new AgentClient(impatient, Origin, key, clock).PairAsync("code", new DeviceFacts("PC", 26100, "x64"), CancellationToken.None);
        Assert.Same(pair, await Task.WhenAny(pair, Task.Delay(TimeSpan.FromSeconds(3))));
        var failure = await Assert.ThrowsAsync<AgentTransportException>(() => pair);
        Assert.Equal("TRANSPORT_ERROR", failure.Code);
    }

    [Fact]
    public async Task Leaves_cancellation_during_a_stalled_body_to_the_agent()
    {
        server.Respond = _ => (200, Ack);
        server.BodyStream = bytes => new StalledStream(bytes[..4]);
        using var cancelled = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, cancelled.Token));
    }

    [Fact]
    public async Task Answers_a_signed_refusal_rather_than_failing()
    {
        server.Respond = _ => (403, FakeServer.Error("DEVICE_REVOKED"));
        var answer = await client.PollAsync(Paired, Guid.NewGuid().ToString("D"), 26100, null, CancellationToken.None);
        Assert.Equal(403, answer.Status);
        Assert.Equal("DEVICE_REVOKED", answer.ErrorCode);
    }

    [Fact]
    public async Task Classifies_a_pairing_answer_that_cannot_be_used()
    {
        var facts = new DeviceFacts("PC", 26100, "x64");

        server.Respond = _ => (200, Ack);
        var shape = await Assert.ThrowsAsync<AgentTransportException>(() => client.PairAsync("code", facts, CancellationToken.None));
        Assert.Equal("RESPONSE_INVALID", shape.Code);
        Assert.Equal(200, shape.HttpStatus);

        server.Respond = _ => (200, PairAnswer(fingerprint: new string('0', 64)));
        var otherKey = await Assert.ThrowsAsync<AgentTransportException>(() => client.PairAsync("code", facts, CancellationToken.None));
        Assert.Equal("RESPONSE_INVALID", otherKey.Code);

        server.Respond = _ => (200, PairAnswer());
        server.SignatureOverride = new string('A', 86);
        var unsigned = await Assert.ThrowsAsync<AgentTransportException>(() => client.PairAsync("code", facts, CancellationToken.None));
        Assert.Equal("RESPONSE_NOT_SIGNED", unsigned.Code);
        Assert.Equal(200, unsigned.HttpStatus);
    }

    private string PairAnswer(string? fingerprint = null, string? keyId = null) => JsonSerializer.Serialize(new Dictionary<string, object>
    {
        ["version"] = ProtocolConstants.ProtocolVersion,
        ["deviceId"] = Commands.DeviceId,
        ["fingerprint"] = fingerprint ?? Fingerprint.Of(key.PublicKeySpki),
        ["status"] = "pending",
        ["serverKeyId"] = keyId ?? Contract.ServerKeyId,
        ["serverPublicKey"] = Contract.ServerSpki,
        ["userLabel"] = "Ada Lovelace",
        ["organizationLabel"] = "Analytical Engines",
    });

    [Fact]
    public async Task Pairs_and_pins_the_key_that_signed_the_answer()
    {
        server.Respond = _ => (200, PairAnswer());
        var (paired, error) = await client.PairAsync("7K3M-Q9X2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01", new DeviceFacts("PC", 26100, "x64"), CancellationToken.None);
        Assert.Null(error);
        Assert.Equal(Contract.ServerSpki, paired!.ServerPublicKey);
        Assert.Equal(ProtocolConstants.PairingDevice, server.Requests[0].Headers["x-jarvis-device"]);
    }

    [Fact]
    public async Task Refuses_a_pairing_answer_for_another_key_or_with_a_key_id_that_is_not_its_key()
    {
        server.Respond = _ => (200, PairAnswer(fingerprint: new string('0', 64)));
        await Assert.ThrowsAsync<AgentTransportException>(() => client.PairAsync("code", new DeviceFacts("PC", 26100, "x64"), CancellationToken.None));
        server.Respond = _ => (200, PairAnswer(keyId: "0123456789abcdef"));
        await Assert.ThrowsAsync<AgentTransportException>(() => client.PairAsync("code", new DeviceFacts("PC", 26100, "x64"), CancellationToken.None));
    }

    [Fact]
    public async Task A_refused_pairing_pins_nothing()
    {
        server.Respond = _ => (400, FakeServer.Error("PAIRING_CODE_INVALID"));
        var (paired, error) = await client.PairAsync("code", new DeviceFacts("PC", 26100, "x64"), CancellationToken.None);
        Assert.Null(paired);
        Assert.Equal("PAIRING_CODE_INVALID", error);
    }
}

public sealed class LoopTests : IDisposable
{
    private readonly FakeServer server = new();
    private readonly HttpClient http;
    private readonly TestDeviceKey key = new();
    private readonly TestClock clock = new();
    private readonly GrantManager grants;
    private readonly CommandVerifier verifier;
    private readonly FakeInjector injector = new();
    private readonly FakeHello hello = new();
    private readonly FakeLauncher launcher = new();
    private readonly MemoryPairingStore store = new() { Stored = ClientTests.Paired };
    private readonly RecordingEvents events = new();
    private readonly MemorySink sink = new();
    private readonly AgentLog log;
    private readonly AgentLoop loop;
    private readonly CancellationTokenSource stop = new();
    private readonly List<string> results = [];

    /// <summary>Answers to successive polls; when they run out, the loop is stopped.</summary>
    private readonly Queue<Func<SeenRequest, (int, string)>> polls = new();

    public LoopTests()
    {
        http = new HttpClient(server);
        grants = new GrantManager(clock);
        verifier = new CommandVerifier(Contract.ServerSpki, Commands.DeviceId, grants, clock);
        log = new AgentLog(sink, clock);
        var runner = new CommandRunner(verifier, grants, new FakeInspector(), injector, hello, new FakeSession(), log, launcher, TimeSpan.Zero);
        loop = new AgentLoop(new AgentClient(http, ClientTests.Origin, key, clock), ClientTests.Paired, grants, verifier, runner, store, events, log, clock, 26100, (_, _) => Task.CompletedTask);
        server.Respond = request =>
        {
            if (request.Path.EndsWith("/poll", StringComparison.Ordinal))
            {
                if (polls.Count == 0)
                {
                    // The last answer agrees with whatever grant the agent named.
                    stop.Cancel();
                    var named = request.Json.GetProperty("grantId");
                    return (200, Poll(named.ValueKind == JsonValueKind.String ? named.GetString() : null, null));
                }
                return polls.Dequeue()(request);
            }
            if (request.Path.EndsWith("/grants", StringComparison.Ordinal))
            {
                var grantId = request.Json.GetProperty("grantId").GetString()!;
                return (200, $$$"""{"version":"jarvis-desktop/1","grant":{"grantId":"{{{grantId}}}","status":"active","expiresAt":{{{clock.NowMs + 900_000}}}}}""");
            }
            if (request.Path.EndsWith("/result", StringComparison.Ordinal))
            {
                lock (results) results.Add(request.Json.GetRawText());
                return (200, """{"version":"jarvis-desktop/1","ok":true}""");
            }
            return (200, """{"version":"jarvis-desktop/1","ok":true}""");
        };
    }

    public void Dispose()
    {
        loop.Dispose();
        http.Dispose();
        key.Dispose();
        stop.Dispose();
        grants.Dispose();
    }

    private static string Poll(string? grantId, CommandEnvelope? command, string status = "active") =>
        $$"""{"version":"jarvis-desktop/1","device":{"status":"{{status}}"},"grant":{{(grantId is null ? "null" : $$"""{"grantId":"{{grantId}}","status":"active","expiresAt":9999999999999}""")}},"command":{{(command is null ? "null" : Commands.Json(command))}}}""";

    private static string Consent(int minutes, IReadOnlyCollection<string> scope) =>
        ConsentText.Render(ClientTests.Paired.UserLabel, ClientTests.Paired.OrganizationLabel, minutes, scope);

    private async Task<string> Grant(IReadOnlyCollection<string>? scope = null)
    {
        scope ??= ProtocolConstants.CommandActions;
        Assert.Null(await loop.StartGrantAsync(scope, 15, Consent(15, scope), extend: false, CancellationToken.None));
        return grants.Active!.GrantId;
    }

    private async Task RunLoop(AgentLoop? other = null)
    {
        try
        {
            await (other ?? loop).RunAsync(stop.Token);
        }
        catch (OperationCanceledException)
        {
        }
    }

    /// <summary>
    /// A loop that waits through `delay`, and through `signingKey` when given, logging to the
    /// same sink. `minPollWindow` stands for the real floor, a held poll's 22 seconds.
    /// </summary>
    private AgentLoop LoopWith(Func<TimeSpan, CancellationToken, Task> delay, IDeviceKey? signingKey = null, TimeSpan? minPollWindow = null)
    {
        var built = new AgentLoop(new AgentClient(http, ClientTests.Origin, signingKey ?? key, clock), ClientTests.Paired, grants, verifier,
            new CommandRunner(verifier, grants, new FakeInspector(), injector, hello, new FakeSession(), log, launcher, TimeSpan.Zero),
            store, events, log, clock, 26100, delay)
        {
            MinPollWindow = minPollWindow ?? TimeSpan.FromMilliseconds(ProtocolConstants.PollHoldMs + 2_000),
        };
        return built;
    }

    /// <summary>A loop that stops at its first wait.</summary>
    private AgentLoop StopsAtFirstWait(TimeSpan? minPollWindow = null) => LoopWith(
        (_, _) =>
        {
            stop.Cancel();
            return Task.CompletedTask;
        },
        minPollWindow: minPollWindow);

    /// <summary>What was logged under this event prefix, without the timestamps.</summary>
    private List<string> Logged(string prefix) =>
        sink.All.Split('\n').Select(l => l[(l.IndexOf(' ', StringComparison.Ordinal) + 1)..]).Where(l => l.StartsWith(prefix, StringComparison.Ordinal)).ToList();

    [Fact]
    public async Task Starts_a_grant_only_with_the_exact_consent_text_and_reports_its_hash()
    {
        Assert.Equal("CONSENT_MISMATCH", await loop.StartGrantAsync([ProtocolConstants.Click], 15, Consent(15, [ProtocolConstants.Click]) + " ", extend: false, CancellationToken.None));
        Assert.Equal("CONSENT_MISMATCH", await loop.StartGrantAsync([ProtocolConstants.Click], 15, Consent(30, [ProtocolConstants.Click]), extend: false, CancellationToken.None));
        Assert.Empty(server.Requests);
        await Grant([ProtocolConstants.Click]);
        var sent = Assert.Single(server.Requests).Json;
        Assert.Equal(ConsentText.Sha256(Consent(15, [ProtocolConstants.Click])), sent.GetProperty("consentTextSha256").GetString());
        Assert.Equal(JsonValueKind.Null, sent.GetProperty("replacesGrantId").ValueKind);
    }

    [Fact]
    public async Task Extends_only_by_fresh_consent_naming_the_grant_it_replaces()
    {
        var first = await Grant();
        Assert.Equal("GRANT_CONFLICT", await loop.StartGrantAsync(ProtocolConstants.CommandActions, 30, Consent(30, ProtocolConstants.CommandActions), extend: false, CancellationToken.None));
        Assert.Null(await loop.StartGrantAsync(ProtocolConstants.CommandActions, 30, Consent(30, ProtocolConstants.CommandActions), extend: true, CancellationToken.None));
        Assert.Equal(first, server.Requests[^1].Json.GetProperty("replacesGrantId").GetString());
        Assert.NotEqual(first, grants.Active!.GrantId);
    }

    [Fact]
    public async Task Leaves_no_grant_when_the_server_refuses_consent()
    {
        server.Respond = _ => (409, FakeServer.Error("GRANT_CONFLICT"));
        Assert.Equal("GRANT_CONFLICT", await loop.StartGrantAsync([ProtocolConstants.Click], 15, Consent(15, [ProtocolConstants.Click]), extend: false, CancellationToken.None));
        Assert.Null(grants.Active);
    }

    [Fact]
    public async Task Runs_a_delivered_command_once_and_reports_what_happened()
    {
        var grantId = await Grant();
        var command = Commands.Sign(new KeyParams("enter"), grantId, clock.NowMs);
        polls.Enqueue(_ => (200, Poll(grantId, command)));
        polls.Enqueue(_ => (200, Poll(grantId, command)));
        await RunLoop();
        Assert.Equal(["key:enter"], injector.Sent);
        Assert.Equal(["""{"version":"jarvis-desktop/1","outcome":"succeeded"}"""], results);
        var pollsSent = server.Requests.Where(r => r.Path.EndsWith("/poll", StringComparison.Ordinal)).ToList();
        Assert.All(pollsSent, p => Assert.Equal(grantId, p.Json.GetProperty("grantId").GetString()));
        Assert.All(pollsSent, p => Assert.Equal(loop.AgentInstanceId, p.Json.GetProperty("agentInstanceId").GetString()));
    }

    [Fact]
    public async Task Answers_a_refused_command_as_not_executed_and_sends_nothing()
    {
        var grantId = await Grant([ProtocolConstants.Click]);
        polls.Enqueue(_ => (200, Poll(grantId, Commands.Sign(new KeyParams("enter"), grantId, clock.NowMs))));
        await RunLoop();
        Assert.Empty(injector.Sent);
        Assert.Equal(["""{"version":"jarvis-desktop/1","outcome":"not-executed","code":"GRANT_INACTIVE"}"""], results);
    }

    [Fact]
    public async Task Types_nothing_without_hello_and_says_why()
    {
        hello.Result = HelloResult.Unavailable;
        var grantId = await Grant();
        polls.Enqueue(_ => (200, Poll(grantId, Commands.Sign(new TypeParams("secret"), grantId, clock.NowMs))));
        await RunLoop();
        Assert.Empty(injector.Sent);
        Assert.Equal(["""{"version":"jarvis-desktop/1","outcome":"not-executed","code":"HELLO_UNAVAILABLE"}"""], results);
    }

    [Fact]
    public async Task Ends_its_grant_when_the_server_no_longer_holds_it()
    {
        var grantId = await Grant();
        polls.Enqueue(_ => (200, Poll(null, null)));
        await RunLoop();
        Assert.Null(grants.Active);
    }

    [Fact]
    public async Task An_answer_to_a_poll_that_named_an_older_grant_does_not_end_the_new_one()
    {
        polls.Enqueue(request =>
        {
            // Consent is given while this poll (naming no grant) is out.
            _ = Task.Run(() => loop.StartGrantAsync(ProtocolConstants.CommandActions, 15, Consent(15, ProtocolConstants.CommandActions), extend: false, CancellationToken.None));
            return (200, Poll(null, null));
        });
        await RunLoop();
        // Whether consent landed before or after that answer, it was never ended by it.
        await Task.Delay(100);
        Assert.NotNull(grants.Active);
    }

    [Fact]
    public async Task A_revoked_device_forgets_its_pairing_and_stops()
    {
        var grantId = await Grant();
        polls.Enqueue(_ => (403, FakeServer.Error("DEVICE_REVOKED")));
        polls.Enqueue(_ => throw new InvalidOperationException("polled after revocation"));
        await loop.RunAsync(stop.Token);
        Assert.True(store.Cleared);
        Assert.Null(grants.Active);
        Assert.Contains("stopped:revoked", events.Seen);
        _ = grantId;
    }

    [Fact]
    public async Task An_unsigned_revocation_changes_nothing()
    {
        polls.Enqueue(_ =>
        {
            server.SignatureOverride = new string('A', 86);
            return (403, FakeServer.Error("DEVICE_REVOKED"));
        });
        polls.Enqueue(_ =>
        {
            server.SignatureOverride = null;
            return (200, Poll(null, null));
        });
        await RunLoop();
        Assert.False(store.Cleared);
        Assert.DoesNotContain("stopped:revoked", events.Seen);
        Assert.Contains("connected:False", events.Seen);
    }

    [Fact]
    public async Task Tells_the_server_when_the_kill_switch_ends_control()
    {
        var grantId = await Grant();
        grants.End("kill-switch");
        for (var i = 0; i < 50 && !server.Requests.Any(r => r.Path.EndsWith("/session/end", StringComparison.Ordinal)); i++) await Task.Delay(20);
        var ended = server.Requests.Single(r => r.Path.EndsWith("/session/end", StringComparison.Ordinal)).Json;
        Assert.Equal("kill-switch", ended.GetProperty("reason").GetString());
        Assert.Equal(grantId, ended.GetProperty("grantId").GetString());
    }

    [Fact]
    public async Task Ends_control_after_thirty_seconds_without_the_server()
    {
        await Grant();
        server.Unreachable = true;
        var attempts = 0;
        var loopWithClock = new AgentLoop(new AgentClient(http, ClientTests.Origin, key, clock), ClientTests.Paired, grants, verifier,
            new CommandRunner(verifier, grants, new FakeInspector(), injector, hello, new FakeSession(), new AgentLog(new MemorySink(), clock), launcher, TimeSpan.Zero),
            store, events, new AgentLog(new MemorySink(), clock), clock, 26100, (wait, _) =>
            {
                clock.Advance((long)wait.TotalMilliseconds);
                if (++attempts > 10) stop.Cancel();
                return Task.CompletedTask;
            });
        try
        {
            await loopWithClock.RunAsync(stop.Token);
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            loopWithClock.Dispose();
        }
        Assert.Null(grants.Active);
    }

    [Fact]
    public async Task Logs_why_each_poll_failed_and_the_wait_it_really_takes()
    {
        server.Unreachable = true;
        var waits = new List<TimeSpan>();
        using var failing = LoopWith((wait, _) =>
        {
            waits.Add(wait);
            if (waits.Count == 3) stop.Cancel();
            return Task.CompletedTask;
        });
        await RunLoop(failing);
        Assert.Equal(
            [
                "poll.failed attempt=1 code=TRANSPORT_ERROR retryInMs=1000",
                "poll.failed attempt=2 code=TRANSPORT_ERROR retryInMs=2000",
                "poll.failed attempt=3 code=TRANSPORT_ERROR retryInMs=4000",
            ],
            Logged("poll."));
        Assert.Equal([TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(4)], waits);
    }

    [Fact]
    public async Task Counts_attempts_again_after_the_server_answers()
    {
        polls.Enqueue(_ =>
        {
            server.Unsigned = true;
            return (502, "<html>Bad Gateway</html>");
        });
        polls.Enqueue(_ =>
        {
            server.Unsigned = false;
            return (200, Poll(null, null));
        });
        polls.Enqueue(_ =>
        {
            server.Unsigned = true;
            return (502, "<html>Bad Gateway</html>");
        });
        polls.Enqueue(_ =>
        {
            server.Unsigned = false;
            return (200, Poll(null, null));
        });
        await RunLoop();
        Assert.Equal(
            [
                "poll.failed attempt=1 code=HTTP_STATUS_ERROR httpStatus=502 retryInMs=1000",
                "poll.failed attempt=1 code=HTTP_STATUS_ERROR httpStatus=502 retryInMs=1000",
            ],
            Logged("poll."));
    }

    [Theory]
    [InlineData(502, "<html>Bad Gateway</html>", "unsigned", "poll.failed attempt=1 code=HTTP_STATUS_ERROR httpStatus=502 retryInMs=1000")]
    [InlineData(200, "{}", "unsigned", "poll.failed attempt=1 code=RESPONSE_NOT_SIGNED httpStatus=200 retryInMs=1000")]
    [InlineData(200, "{}", "forged", "poll.failed attempt=1 code=RESPONSE_NOT_SIGNED httpStatus=200 retryInMs=1000")]
    [InlineData(403, "{}", "forged", "poll.failed attempt=1 code=RESPONSE_NOT_SIGNED httpStatus=403 retryInMs=1000")]
    [InlineData(200, "<html>Sign in</html>", "signed", "poll.failed attempt=1 code=RESPONSE_NOT_JSON httpStatus=200 retryInMs=1000")]
    public async Task Logs_each_way_a_poll_can_fail(int status, string body, string signing, string expected)
    {
        server.Unsigned = signing == "unsigned";
        server.SignatureOverride = signing == "forged" ? new string('A', 86) : null;
        polls.Enqueue(_ => (status, body));
        using var failing = StopsAtFirstWait();
        await RunLoop(failing);
        Assert.Equal([expected], Logged("poll."));
        Assert.Contains("connected:False", events.Seen);
    }

    [Fact]
    public async Task Logs_a_signed_refusal_with_its_code_its_reason_and_its_status()
    {
        polls.Enqueue(_ => (503, FakeServer.Error("UNAVAILABLE")));
        await RunLoop();
        Assert.Equal(["server.refused code=SERVER_REFUSAL reason=UNAVAILABLE httpStatus=503"], Logged("server."));
        Assert.Empty(Logged("poll."));
    }

    [Fact]
    public async Task Logs_the_refusal_that_revoked_it()
    {
        polls.Enqueue(_ => (403, FakeServer.Error("DEVICE_REVOKED")));
        await loop.RunAsync(stop.Token);
        Assert.Equal(["server.refused code=SERVER_REFUSAL reason=DEVICE_REVOKED httpStatus=403"], Logged("server."));
    }

    [Fact]
    public async Task Logs_a_signed_answer_of_the_wrong_shape_and_the_idle_wait()
    {
        polls.Enqueue(_ => (200, """{"version":"jarvis-desktop/1"}"""));
        await RunLoop();
        Assert.Equal(["poll.malformed code=RESPONSE_INVALID httpStatus=200 retryInMs=3000"], Logged("poll."));
    }

    [Fact]
    public async Task Stops_for_good_after_five_unknown_failures_in_a_row()
    {
        var grantId = await Grant();
        var waits = new List<TimeSpan>();
        using var broken = LoopWith(
            (wait, _) =>
            {
                waits.Add(wait);
                return Task.CompletedTask;
            },
            new BrokenDeviceKey());
        await broken.RunAsync(stop.Token);
        Assert.Equal(
            [
                "poll.failed attempt=1 code=UNKNOWN_ERROR retryInMs=1000",
                "poll.failed attempt=2 code=UNKNOWN_ERROR retryInMs=2000",
                "poll.failed attempt=3 code=UNKNOWN_ERROR retryInMs=4000",
                "poll.failed attempt=4 code=UNKNOWN_ERROR retryInMs=8000",
                "poll.stopped code=UNKNOWN_ERROR",
            ],
            Logged("poll."));
        Assert.Equal([TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(4), TimeSpan.FromSeconds(8)], waits);
        Assert.Equal("stopped:failed", Assert.Single(events.Seen, e => e.StartsWith("stopped", StringComparison.Ordinal)));
        Assert.Null(grants.Active);
        Assert.Contains($"grant.ended grantId={grantId} reason=disconnected", Logged("grant.ended"));
    }

    [Fact]
    public async Task An_unknown_failure_is_not_contact_so_the_grace_keeps_running()
    {
        await Grant();
        var left = new List<TimeSpan?>();
        using var broken = LoopWith(
            (_, _) =>
            {
                left.Add(grants.GraceLeft);
                clock.Advance(1_000);
                return Task.CompletedTask;
            },
            new BrokenDeviceKey());
        await broken.RunAsync(stop.Token);
        Assert.Equal([TimeSpan.FromMilliseconds(30_001), TimeSpan.FromMilliseconds(29_001), TimeSpan.FromMilliseconds(28_001), TimeSpan.FromMilliseconds(27_001)], left);
    }

    [Fact]
    public async Task Tells_the_tray_it_lost_contact_while_retrying_an_unknown_failure()
    {
        await Grant();
        using var flaky = LoopWith((_, _) => Task.CompletedTask, new FlakyDeviceKey(key, call => call == 1));
        await RunLoop(flaky);
        Assert.Contains("connected:False", events.Seen);
    }

    [Fact]
    public async Task Retries_an_unknown_failure_and_keeps_polling_when_it_passes()
    {
        var grantId = await Grant();
        polls.Enqueue(_ => (200, Poll(grantId, null)));
        using var flaky = LoopWith((_, _) => Task.CompletedTask, new FlakyDeviceKey(key, call => call <= 2));
        await RunLoop(flaky);
        Assert.Equal(["poll.failed attempt=1 code=UNKNOWN_ERROR retryInMs=1000", "poll.failed attempt=2 code=UNKNOWN_ERROR retryInMs=2000"], Logged("poll."));
        Assert.NotNull(grants.Active);
        Assert.DoesNotContain("stopped:failed", events.Seen);
    }

    [Fact]
    public async Task Counts_unknown_failures_afresh_after_any_answer()
    {
        var grantId = await Grant();
        // Four failures, an answer, four more: eight in all, never five in a row.
        polls.Enqueue(_ => (200, Poll(grantId, null)));
        polls.Enqueue(_ => (200, Poll(grantId, null)));
        using var flaky = LoopWith((_, _) => Task.CompletedTask, new FlakyDeviceKey(key, call => call is (>= 1 and <= 4) or (>= 6 and <= 9)));
        await RunLoop(flaky);
        Assert.Equal(8, Logged("poll.failed").Count);
        Assert.DoesNotContain("stopped:failed", events.Seen);
    }

    [Fact]
    public async Task A_command_that_throws_is_answered_uncertain_and_never_run_again()
    {
        var grantId = await Grant();
        var attempts = 0;
        injector.Result = _ =>
        {
            attempts++;
            throw new InvalidOperationException("failed while acting");
        };
        var command = Commands.Sign(new KeyParams("enter"), grantId, clock.NowMs);
        polls.Enqueue(_ => (200, Poll(grantId, command)));
        polls.Enqueue(_ => (200, Poll(grantId, command)));
        await RunLoop();
        Assert.Equal(1, attempts);
        Assert.Equal(["""{"version":"jarvis-desktop/1","outcome":"uncertain"}"""], results);
        Assert.Equal([$"command.failed commandId={command.CommandId} code=UNKNOWN_ERROR"], Logged("command.failed"));
        Assert.DoesNotContain("stopped:failed", events.Seen);
    }

    [Fact]
    public async Task A_launch_that_throws_is_answered_uncertain_and_never_run_again()
    {
        var grantId = await Grant();
        launcher.Throws = new InvalidOperationException("failed while starting");
        var command = Commands.Sign(new LaunchParams("notepad"), grantId, clock.NowMs);
        polls.Enqueue(_ => (200, Poll(grantId, command)));
        polls.Enqueue(_ => (200, Poll(grantId, command)));
        await RunLoop();
        Assert.Equal(["notepad"], launcher.Opened);
        Assert.Equal(["""{"version":"jarvis-desktop/1","outcome":"uncertain"}"""], results);
        Assert.Equal([$"command.failed commandId={command.CommandId} code=UNKNOWN_ERROR"], Logged("command.failed"));
    }

    [Fact]
    public async Task Answers_a_launch_with_what_windows_said()
    {
        var grantId = await Grant();
        launcher.Result = LaunchResult.NotInstalled;
        var command = Commands.Sign(new LaunchParams("chrome"), grantId, clock.NowMs);
        polls.Enqueue(_ => (200, Poll(grantId, command)));
        await RunLoop();
        Assert.Equal(["""{"version":"jarvis-desktop/1","outcome":"not-executed","code":"APP_NOT_INSTALLED"}"""], results);
    }

    [Fact]
    public async Task Still_says_it_stopped_when_a_revoked_device_cannot_clear_its_pairing()
    {
        store.ClearThrows = true;
        polls.Enqueue(_ => (403, FakeServer.Error("DEVICE_REVOKED")));
        await loop.RunAsync(stop.Token);
        Assert.Contains("stopped:revoked", events.Seen);
        Assert.Equal(["pairing.clear.failed code=UNKNOWN_ERROR"], Logged("pairing."));
    }

    [Fact]
    public async Task A_stop_that_disposes_the_loop_is_not_a_failure()
    {
        server.Hang = true;
        var stopping = LoopWith((_, _) => Task.CompletedTask);
        var run = stopping.RunAsync(stop.Token);
        await Task.Delay(50);
        // As TrayApp does: cancel, then dispose at once, with the poll still unwinding.
        await stop.CancelAsync();
        stopping.Dispose();
        await Assert.ThrowsAnyAsync<Exception>(() => run);
        Assert.DoesNotContain("stopped:failed", events.Seen);
        Assert.Empty(Logged("poll."));
    }

    [Fact]
    public async Task Waits_no_longer_than_the_grace_has_left_and_logs_the_real_wait()
    {
        await Grant();
        clock.Advance(29_500);
        server.Unreachable = true;
        TimeSpan? waited = null;
        using var failing = LoopWith((wait, _) =>
        {
            waited = wait;
            stop.Cancel();
            return Task.CompletedTask;
        });
        await RunLoop(failing);
        Assert.Equal(TimeSpan.FromMilliseconds(501), waited);
        Assert.Equal(["poll.failed attempt=1 code=TRANSPORT_ERROR retryInMs=501"], Logged("poll."));
    }

    [Fact]
    public async Task Keeps_the_full_backoff_when_there_is_no_grant_to_lose()
    {
        server.Unreachable = true;
        TimeSpan? waited = null;
        using var failing = LoopWith((wait, _) =>
        {
            waited = wait;
            stop.Cancel();
            return Task.CompletedTask;
        });
        await RunLoop(failing);
        Assert.Equal(TimeSpan.FromSeconds(1), waited);
    }

    [Fact]
    public async Task Keeps_a_poll_open_for_a_whole_hold_even_late_in_the_grace()
    {
        await Grant();
        clock.Advance(29_500);
        clock.Run();
        // Half a second of grace left, on a healthy server that holds the poll for longer.
        server.Hold = TimeSpan.FromMilliseconds(900);
        using var held = LoopWith((_, _) => Task.CompletedTask, minPollWindow: TimeSpan.FromSeconds(3));
        await RunLoop(held);
        Assert.Empty(Logged("poll."));
        Assert.NotNull(grants.Active);
    }

    [Fact]
    public async Task Ends_control_at_the_floor_when_nothing_ever_answers()
    {
        await Grant();
        clock.Advance(29_500);
        clock.Run();
        server.Hang = true;
        var timer = System.Diagnostics.Stopwatch.StartNew();
        using var silent = StopsAtFirstWait(minPollWindow: TimeSpan.FromMilliseconds(900));
        var run = RunLoop(silent);
        var finished = await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(3)));
        var took = timer.Elapsed;
        await stop.CancelAsync();
        Assert.Same(run, finished);
        Assert.Null(grants.Active);
        // Held to the floor, not cut at the half second of grace that was left.
        Assert.InRange(took, TimeSpan.FromMilliseconds(800), TimeSpan.FromSeconds(3));
    }

    [Fact]
    public async Task A_late_answer_never_carries_a_grant_past_its_expiry()
    {
        var grantId = await Grant();
        var expires = grants.Active!.ExpiresAt;
        clock.NowMs = expires - 200;
        grants.ServerContact();
        clock.Run();
        server.Hold = TimeSpan.FromMilliseconds(500);
        await RunLoop();
        Assert.Null(grants.Active);
        Assert.Contains($"grant.ended grantId={grantId} reason=expired", Logged("grant.ended"));
    }

    [Fact]
    public async Task An_unanswered_poll_is_not_contact()
    {
        await Grant();
        clock.Advance(10_000);
        var left = grants.GraceLeft;
        clock.Run();
        server.Hang = true;
        stop.CancelAfter(TimeSpan.FromMilliseconds(100));
        await RunLoop();
        Assert.True(grants.GraceLeft < left);
    }

    [Fact]
    public async Task A_poll_that_waited_for_consent_names_the_grant_consent_started()
    {
        using var release = new ManualResetEventSlim();
        var respond = server.Respond;
        server.Respond = request =>
        {
            if (request.Path.EndsWith("/grants", StringComparison.Ordinal)) release.Wait(TimeSpan.FromSeconds(5));
            return respond(request);
        };
        var scope = ProtocolConstants.CommandActions;
        var consent = Task.Run(() => loop.StartGrantAsync(scope, 15, Consent(15, scope), extend: false, CancellationToken.None));
        for (var i = 0; i < 100 && !server.Requests.Any(r => r.Path.EndsWith("/grants", StringComparison.Ordinal)); i++) await Task.Delay(10);

        // Consent holds the exchange, so this poll waits for it, as it would in the agent.
        var run = RunLoop();
        await Task.Delay(100);
        release.Set();
        Assert.Null(await consent);
        await run;

        var poll = server.Requests.First(r => r.Path.EndsWith("/poll", StringComparison.Ordinal));
        Assert.Equal(grants.Active!.GrantId, poll.Json.GetProperty("grantId").GetString());
    }

    [Theory]
    [InlineData(true, "active", true, false, false, "Paired — control not allowed", true, true, false, false)]
    [InlineData(true, "active", true, false, true, "Control allowed", false, false, true, true)]
    [InlineData(true, "active", false, false, false, "Not connected", true, false, false, false)]
    [InlineData(true, "pending", true, false, false, "Waiting for confirmation in JARVIS", true, false, false, false)]
    [InlineData(false, "pending", false, false, false, "Not paired", true, false, false, false)]
    [InlineData(true, "active", true, true, false, "Stopped — quit and start the agent again", true, false, false, false)]
    [InlineData(true, "active", false, true, false, "Stopped — quit and start the agent again", true, false, false, false)]
    [InlineData(true, null, false, false, false, "Not connected", true, false, false, false)]
    [InlineData(true, null, true, false, false, "Paired — control not allowed", true, false, false, false)]
    public void Shows_the_tray_what_it_can_do(bool paired, string? deviceStatus, bool connected, bool halted, bool hasGrant, string status, bool canPair, bool canAllow, bool canExtend, bool canStop)
    {
        Assert.Equal(new TrayView(status, canPair, canAllow, canExtend, canStop), TrayView.Of(paired, deviceStatus, connected, halted, hasGrant));
    }

    [Theory]
    [InlineData(false, "pending", false)]
    [InlineData(true, "pending", true)]
    [InlineData(true, "active", true)]
    public void Offers_no_second_pairing_while_the_window_is_open(bool paired, string deviceStatus, bool connected)
    {
        var open = TrayView.Of(paired, deviceStatus, connected, halted: false, hasGrant: false, pairingOpen: true);
        Assert.False(open.CanPair);
        Assert.True(TrayView.Of(paired, deviceStatus, connected, halted: false, hasGrant: false, pairingOpen: false).CanPair);
    }

    [Fact]
    public void The_pairing_window_changes_nothing_else_the_tray_offers()
    {
        var closed = TrayView.Of(true, "active", true, false, false, pairingOpen: false);
        var open = TrayView.Of(true, "active", true, false, false, pairingOpen: true);
        Assert.Equal(closed with { CanPair = false }, open);
    }

    [Theory]
    [InlineData("revoked", "This computer was removed from JARVIS. Pair it again to use it.")]
    [InlineData("unsupported", "This agent or this version of Windows is no longer supported. Update to continue.")]
    [InlineData("not-authorized", "This computer's owner can no longer use it with JARVIS.")]
    [InlineData("failed", "JARVIS stopped contacting the server after repeated errors. Any control has ended. Quit and start the agent again.")]
    public void Says_why_the_agent_stopped(string reason, string message)
    {
        Assert.Equal(message, TrayView.StoppedMessage(reason));
    }

    [Fact]
    public async Task Ends_control_when_the_grace_runs_out_with_a_poll_still_open()
    {
        var grantId = await Grant();
        clock.Advance(29_800);
        clock.Run();
        server.Hang = true;
        using var waiting = StopsAtFirstWait(minPollWindow: TimeSpan.FromMilliseconds(50));
        var run = RunLoop(waiting);
        var finished = await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(3)));
        await stop.CancelAsync();
        Assert.Same(run, finished);
        Assert.Null(grants.Active);
        // Contains: this test's second loop hears the same grant end, so the line appears twice.
        Assert.Contains($"grant.ended grantId={grantId} reason=disconnected", Logged("grant.ended"));
        Assert.Equal(["poll.failed attempt=1 code=TRANSPORT_ERROR retryInMs=1000"], Logged("poll."));
        Assert.Contains("connected:False", events.Seen);
    }

    [Fact]
    public async Task Leaves_a_poll_open_when_no_grant_depends_on_it()
    {
        clock.Run();
        server.Hang = true;
        stop.CancelAfter(TimeSpan.FromMilliseconds(300));
        await RunLoop();
        Assert.Empty(Logged("poll."));
        Assert.DoesNotContain("connected:False", events.Seen);
    }

    [Fact]
    public async Task Does_not_call_stopping_the_agent_a_failure_while_control_is_allowed()
    {
        await Grant();
        server.Hang = true;
        stop.CancelAfter(TimeSpan.FromMilliseconds(20));
        await RunLoop();
        Assert.Empty(Logged("poll."));
        Assert.NotNull(grants.Active);
    }

    [Fact]
    public async Task Keeps_the_grant_through_a_hello_slower_than_the_grace()
    {
        var grantId = await Grant();
        hello.WhileOpen = _ =>
        {
            clock.Advance(31_000);
            return Task.CompletedTask;
        };
        polls.Enqueue(_ => (200, Poll(grantId, Commands.Sign(new TypeParams("abc"), grantId, clock.NowMs))));
        await RunLoop();
        Assert.NotNull(grants.Active);
        Assert.Equal(["""{"version":"jarvis-desktop/1","outcome":"not-executed","code":"COMMAND_EXPIRED"}"""], results);
    }

    [Fact]
    public async Task Lets_a_hello_outlast_the_deadline_on_the_poll_that_delivered_it()
    {
        var grantId = await Grant();
        // The delivering poll has one real second of grace left; Hello takes longer.
        clock.Advance(29_000);
        hello.WhileOpen = token => Task.Delay(TimeSpan.FromMilliseconds(1_500), token);
        polls.Enqueue(_ => (200, Poll(grantId, Commands.Sign(new TypeParams("abc"), grantId, clock.NowMs))));
        using var slow = LoopWith((_, _) => Task.CompletedTask, minPollWindow: TimeSpan.FromMilliseconds(50));
        await RunLoop(slow);
        Assert.Equal(["type:abc"], injector.Sent);
        Assert.Equal(["""{"version":"jarvis-desktop/1","outcome":"succeeded"}"""], results);
        Assert.NotNull(grants.Active);
    }

    [Fact]
    public async Task Ends_control_when_a_stalled_body_keeps_the_server_away()
    {
        await Grant();
        polls.Enqueue(_ =>
        {
            server.BodyStream = bytes => new StalledStream(bytes[..4]);
            return (200, Poll(null, null));
        });
        using var impatient = new HttpClient(server, disposeHandler: false) { Timeout = TimeSpan.FromMilliseconds(100) };
        using var stalled = new AgentLoop(new AgentClient(impatient, ClientTests.Origin, key, clock), ClientTests.Paired, grants, verifier,
            new CommandRunner(verifier, grants, new FakeInspector(), injector, hello, new FakeSession(), log, launcher, TimeSpan.Zero),
            store, events, log, clock, 26100, (wait, _) =>
            {
                clock.Advance(31_000);
                if (grants.Active is null) stop.Cancel();
                return Task.CompletedTask;
            });
        var run = RunLoop(stalled);
        var finished = await Task.WhenAny(run, Task.Delay(TimeSpan.FromSeconds(3)));
        await stop.CancelAsync();
        Assert.Same(run, finished);
        Assert.Null(grants.Active);
        Assert.Equal(["poll.failed attempt=1 code=TRANSPORT_ERROR retryInMs=1000"], Logged("poll."));
    }

    [Fact]
    public async Task Does_not_call_stopping_the_agent_a_failure()
    {
        server.Hang = true;
        stop.CancelAfter(TimeSpan.FromMilliseconds(20));
        await RunLoop();
        Assert.Empty(Logged("poll."));
    }

    [Fact]
    public async Task Logs_why_a_result_did_not_get_through_and_promises_no_retry_after_the_last()
    {
        var grantId = await Grant();
        var command = Commands.Sign(new KeyParams("enter"), grantId, clock.NowMs);
        polls.Enqueue(_ => (200, Poll(grantId, command)));
        var respond = server.Respond;
        server.Respond = request =>
        {
            server.Unsigned = request.Path.EndsWith("/result", StringComparison.Ordinal);
            return server.Unsigned ? (502, "<html>Bad Gateway</html>") : respond(request);
        };
        await RunLoop();
        Assert.Equal(
            [
                $"result.failed commandId={command.CommandId} attempt=1 code=HTTP_STATUS_ERROR httpStatus=502 retryInMs=1000",
                $"result.failed commandId={command.CommandId} attempt=2 code=HTTP_STATUS_ERROR httpStatus=502 retryInMs=2000",
                $"result.failed commandId={command.CommandId} attempt=3 code=HTTP_STATUS_ERROR httpStatus=502",
            ],
            Logged("result."));
    }

    [Fact]
    public async Task Logs_a_refused_result_with_its_code_its_reason_and_its_status()
    {
        var grantId = await Grant();
        var command = Commands.Sign(new KeyParams("enter"), grantId, clock.NowMs);
        polls.Enqueue(_ => (200, Poll(grantId, command)));
        var respond = server.Respond;
        server.Respond = request => request.Path.EndsWith("/result", StringComparison.Ordinal) ? (409, FakeServer.Error("CONFLICT")) : respond(request);
        await RunLoop();
        Assert.Equal([$"result.refused commandId={command.CommandId} code=SERVER_REFUSAL reason=CONFLICT httpStatus=409"], Logged("result."));
    }

    [Fact]
    public async Task Logs_why_consent_did_not_reach_the_server()
    {
        server.Unreachable = true;
        var scope = ProtocolConstants.CommandActions;
        Assert.Equal("UNAVAILABLE", await loop.StartGrantAsync(scope, 15, Consent(15, scope), extend: false, CancellationToken.None));
        Assert.Equal(["grant.failed code=TRANSPORT_ERROR"], Logged("grant.failed"));
    }

    [Fact]
    public async Task Logs_a_grant_answer_of_the_wrong_shape()
    {
        server.Respond = _ => (200, """{"version":"jarvis-desktop/1"}""");
        var scope = ProtocolConstants.CommandActions;
        Assert.Equal("INVALID_REQUEST", await loop.StartGrantAsync(scope, 15, Consent(15, scope), extend: false, CancellationToken.None));
        Assert.Equal(["grant.failed code=RESPONSE_INVALID"], Logged("grant.failed"));
    }

    [Fact]
    public async Task Logs_why_the_server_was_not_told_control_ended()
    {
        var grantId = await Grant();
        server.Unreachable = true;
        grants.End("kill-switch");
        for (var i = 0; i < 50 && Logged("session.").Count == 0; i++) await Task.Delay(20);
        Assert.Equal([$"session.end.unsent grantId={grantId} code=TRANSPORT_ERROR"], Logged("session."));
    }

    [Fact]
    public async Task Never_logs_a_secret_an_address_a_body_or_a_device_id()
    {
        const string Secret = "sk-proj-0123456789abcdefSECRET";
        const string PairingCode = "7K3M-Q9X2-ABCD-EFGH-JKMN-PQRS-TVWX-YZ01";
        var leaky = $"{Secret} {PairingCode} {Commands.DeviceId} https://jarvis.test/api/v1/desktop-agent/poll?token={Secret}";
        var loud = JsonSerializer.Serialize(new { version = ProtocolConstants.ProtocolVersion, error = new { code = leaky } });

        // Every way a poll can fail, each carrying the same words.
        polls.Enqueue(_ =>
        {
            server.Unsigned = true;
            return (502, leaky);
        });
        polls.Enqueue(_ =>
        {
            server.Unsigned = false;
            server.SignatureOverride = new string('A', 86);
            return (403, loud);
        });
        polls.Enqueue(_ =>
        {
            server.SignatureOverride = null;
            return (200, leaky);
        });
        polls.Enqueue(_ => (403, loud));
        polls.Enqueue(_ => (200, JsonSerializer.Serialize(new { version = ProtocolConstants.ProtocolVersion, note = leaky })));
        polls.Enqueue(_ =>
        {
            server.UnreachableMessage = leaky;
            server.Unreachable = true;
            return (200, Poll(null, null));
        });
        var waits = 0;
        using var failing = LoopWith((_, _) =>
        {
            // The good answer before the unreachable server waits too, and logs nothing.
            if (++waits == 7) stop.Cancel();
            return Task.CompletedTask;
        });
        await RunLoop(failing);

        Assert.Equal(6, sink.Lines.Count);
        foreach (var never in new[] { Secret, PairingCode, Commands.DeviceId, "jarvis.test", "https:", "?", "token", "note", key.PublicKeySpki })
            Assert.DoesNotContain(never, sink.All, StringComparison.OrdinalIgnoreCase);
        foreach (var line in sink.Lines)
            foreach (var field in line.Split(' ').Skip(2))
                Assert.Contains(field.Split('=')[0], AgentLog.Fields);
    }

    [Fact]
    public void Backs_off_but_always_retries_within_the_grace()
    {
        Assert.Equal(TimeSpan.FromSeconds(1), AgentLoop.Backoff(1));
        Assert.True(Enumerable.Range(1, 20).All(n => AgentLoop.Backoff(n) <= TimeSpan.FromSeconds(15)));
        _ = HttpStatusCode.OK;
    }
}
