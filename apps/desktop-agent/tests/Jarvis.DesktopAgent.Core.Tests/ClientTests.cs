// ---------------------------------------------------------------------------
// Phase 19.6 — the signed HTTPS client and the poll loop, against a fake
// server that signs with the TEST key. Each request is signed over the exact
// bytes sent; an answer is used only when signed by the pinned key for that
// very request; a revoked device forgets itself; consent starts a grant only
// with the exact text; nothing is replayed or retried.
// ---------------------------------------------------------------------------

using System.Net;
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
    private readonly MemoryPairingStore store = new() { Stored = ClientTests.Paired };
    private readonly RecordingEvents events = new();
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
        var log = new AgentLog(new MemorySink(), clock);
        var runner = new CommandRunner(verifier, grants, new FakeInspector(), injector, hello, new FakeSession(), log);
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

    private async Task RunLoop()
    {
        try
        {
            await loop.RunAsync(stop.Token);
        }
        catch (OperationCanceledException)
        {
        }
    }

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
            new CommandRunner(verifier, grants, new FakeInspector(), injector, hello, new FakeSession(), new AgentLog(new MemorySink(), clock)),
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
    public void Backs_off_but_always_retries_within_the_grace()
    {
        Assert.Equal(TimeSpan.FromSeconds(1), AgentLoop.Backoff(1));
        Assert.True(Enumerable.Range(1, 20).All(n => AgentLoop.Backoff(n) <= TimeSpan.FromSeconds(15)));
        _ = HttpStatusCode.OK;
    }
}
