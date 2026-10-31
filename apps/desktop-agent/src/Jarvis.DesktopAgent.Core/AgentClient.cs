// ---------------------------------------------------------------------------
// Phase 19.6 — the agent's only way to talk: outbound HTTPS, signed both ways.
//
// Every request is signed by the device key over its method, path, time, a
// fresh nonce, the device and the hash of the exact body bytes. Every answer
// is read only after the server's signature over (that nonce, the status, the
// hash of the exact body bytes) verifies against the key pinned at pairing —
// an answer for another request, an altered body or an unsigned error is
// discarded as if nothing had arrived. The agent opens no port.
// ---------------------------------------------------------------------------

using System.Buffers.Text;
using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;

namespace Jarvis.DesktopAgent.Core;

/// <summary>The transport failed, or the answer could not be proven to be the server's: treat as no contact.</summary>
public sealed class AgentTransportException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>A verified answer. Either a body to parse, or a stable error code.</summary>
public sealed record AgentAnswer(int Status, JsonElement Body, string? ErrorCode)
{
    public bool Ok => Status is >= 200 and < 300 && ErrorCode is null;
}

public sealed record DeviceFacts(string DeviceName, int WindowsBuild, string Architecture);

public sealed class AgentClient
{
    internal const int MaxResponseBytes = 64 * 1024;
    private const string Prefix = "/api/v1/desktop-agent/";

    private readonly HttpClient http;
    private readonly Uri server;
    private readonly IDeviceKey key;
    private readonly IClock clock;

    public AgentClient(HttpClient http, Uri server, IDeviceKey key, IClock clock)
    {
        ArgumentNullException.ThrowIfNull(server);
        // Outbound HTTPS only — there is no setting that allows anything else.
        if (!server.IsAbsoluteUri || server.Scheme != Uri.UriSchemeHttps || server.AbsolutePath != "/" || !string.IsNullOrEmpty(server.Query) || !string.IsNullOrEmpty(server.UserInfo))
            throw new ArgumentException("The server must be an https:// origin.", nameof(server));
        this.http = http;
        this.server = server;
        this.key = key;
        this.clock = clock;
    }

    public Uri Server => server;

    // ------------------------------------------------------------------
    // Messages
    // ------------------------------------------------------------------

    /// <summary>Pairs with a code. The pinned server key comes from this answer, which must be signed by it.</summary>
    public async Task<(PairResponse? Paired, string? ErrorCode)> PairAsync(string pairingCode, DeviceFacts facts, CancellationToken cancellationToken)
    {
        var body = Json(w =>
        {
            w.WriteString("version", ProtocolConstants.ProtocolVersion);
            w.WriteString("pairingCode", pairingCode);
            w.WriteString("publicKey", key.PublicKeySpki);
            w.WriteString("deviceName", facts.DeviceName);
            w.WriteString("agentVersion", ProtocolConstants.AgentVersion);
            w.WriteNumber("windowsBuild", facts.WindowsBuild);
            w.WriteString("architecture", facts.Architecture);
        });
        var (status, bytes, headers, nonce) = await SendAsync("pair", ProtocolConstants.PairingDevice, body, cancellationToken).ConfigureAwait(false);
        JsonElement root;
        try
        {
            root = Parse(bytes);
        }
        catch (AgentTransportException)
        {
            return (null, null);
        }
        if (status != 200)
        {
            // Nothing is pinned yet, so a refusal cannot be proven; it changes
            // nothing and is only ever shown as "not paired".
            return (null, MessageParser.ParseErrorCode(root));
        }
        PairResponse paired;
        try
        {
            paired = MessageParser.ParsePairResponse(root);
        }
        catch (Exception e) when (e is ProtocolViolationException or KeyNotFoundException or InvalidOperationException)
        {
            throw new AgentTransportException("The pairing answer did not have the declared shape.", e);
        }
        if (headers.KeyId != paired.ServerKeyId || !Signatures.Verify(paired.ServerPublicKey, Canonical.Response(nonce, status, Canonical.Sha256Hex(bytes)), headers.Signature))
            throw new AgentTransportException("The pairing answer was not signed by the key it named.");
        if (paired.Fingerprint != Fingerprint.Of(key.PublicKeySpki))
            throw new AgentTransportException("The server recorded a different key for this computer.");
        return (paired, null);
    }

    public Task<AgentAnswer> PollAsync(Pairing pairing, string agentInstanceId, int windowsBuild, string? grantId, CancellationToken cancellationToken) =>
        SignedAsync(pairing, "poll", Json(w =>
        {
            w.WriteString("version", ProtocolConstants.ProtocolVersion);
            w.WriteString("agentInstanceId", agentInstanceId);
            w.WriteString("agentVersion", ProtocolConstants.AgentVersion);
            w.WriteNumber("windowsBuild", windowsBuild);
            if (grantId is null) w.WriteNull("grantId");
            else w.WriteString("grantId", grantId);
        }), cancellationToken);

    public Task<AgentAnswer> StartGrantAsync(Pairing pairing, string agentInstanceId, LocalGrant grant, string? replacesGrantId, CancellationToken cancellationToken) =>
        SignedAsync(pairing, "grants", Json(w =>
        {
            w.WriteString("version", ProtocolConstants.ProtocolVersion);
            w.WriteString("agentInstanceId", agentInstanceId);
            w.WriteString("grantId", grant.GrantId);
            w.WriteNumber("durationMinutes", grant.DurationMinutes);
            w.WriteStartArray("scope");
            foreach (var action in grant.Scope) w.WriteStringValue(action);
            w.WriteEndArray();
            w.WriteString("consentTextVersion", ProtocolConstants.ConsentTextVersion);
            w.WriteString("consentTextSha256", grant.ConsentTextSha256);
            if (replacesGrantId is null) w.WriteNull("replacesGrantId");
            else w.WriteString("replacesGrantId", replacesGrantId);
        }), cancellationToken);

    public Task<AgentAnswer> EndSessionAsync(Pairing pairing, string agentInstanceId, string grantId, string reason, CancellationToken cancellationToken)
    {
        if (!ProtocolConstants.SessionEndReasons.Contains(reason)) throw new ArgumentException("Not a session end reason.", nameof(reason));
        return SignedAsync(pairing, "session/end", Json(w =>
        {
            w.WriteString("version", ProtocolConstants.ProtocolVersion);
            w.WriteString("agentInstanceId", agentInstanceId);
            w.WriteString("grantId", grantId);
            w.WriteString("reason", reason);
        }), cancellationToken);
    }

    public Task<AgentAnswer> SubmitResultAsync(Pairing pairing, string commandId, CommandOutcome outcome, CancellationToken cancellationToken)
    {
        if (!Guid.TryParseExact(commandId, "D", out _)) throw new ArgumentException("Not a command id.", nameof(commandId));
        return SignedAsync(pairing, $"commands/{commandId}/result", Json(w =>
        {
            w.WriteString("version", ProtocolConstants.ProtocolVersion);
            w.WriteString("outcome", outcome.Outcome);
            if (outcome.Code is not null) w.WriteString("code", outcome.Code);
        }), cancellationToken);
    }

    // ------------------------------------------------------------------
    // Signing and verification
    // ------------------------------------------------------------------

    private async Task<AgentAnswer> SignedAsync(Pairing pairing, string route, byte[] body, CancellationToken cancellationToken)
    {
        var (status, bytes, headers, nonce) = await SendAsync(route, pairing.DeviceId, body, cancellationToken).ConfigureAwait(false);
        if (headers.KeyId != pairing.ServerKeyId || !Signatures.Verify(pairing.ServerPublicKey, Canonical.Response(nonce, status, Canonical.Sha256Hex(bytes)), headers.Signature))
            throw new AgentTransportException("The answer was not signed by the pinned server key.");
        var root = Parse(bytes);
        if (status is >= 200 and < 300) return new AgentAnswer(status, root, null);
        return new AgentAnswer(status, root, MessageParser.ParseErrorCode(root) ?? "INVALID_REQUEST");
    }

    private sealed record ResponseHeaders(string? Signature, string? KeyId);

    private async Task<(int Status, byte[] Body, ResponseHeaders Headers, string Nonce)> SendAsync(string route, string device, byte[] body, CancellationToken cancellationToken)
    {
        var path = Prefix + route;
        var timestamp = clock.NowMs.ToString(CultureInfo.InvariantCulture);
        var nonce = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(18));
        var bodySha256 = Canonical.Sha256Hex(body);
        var signature = Signatures.Sign(key, Canonical.Request("POST", path, timestamp, nonce, device, bodySha256));

        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(server, path));
        request.Content = new ByteArrayContent(body);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.Add("x-jarvis-desktop-version", ProtocolConstants.ProtocolVersion);
        request.Headers.Add("x-jarvis-device", device);
        request.Headers.Add("x-jarvis-timestamp", timestamp);
        request.Headers.Add("x-jarvis-nonce", nonce);
        request.Headers.Add("x-jarvis-content-sha256", bodySha256);
        request.Headers.Add("x-jarvis-signature", signature);

        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            var status = (int)response.StatusCode;
            if (status is >= 300 and < 400) throw new AgentTransportException("Redirects are not followed.");
            var bytes = await ReadBoundedAsync(response, cancellationToken).ConfigureAwait(false);
            return (status, bytes, new ResponseHeaders(Single(response, "x-jarvis-response-signature"), Single(response, "x-jarvis-response-key")), nonce);
        }
        catch (HttpRequestException e)
        {
            throw new AgentTransportException("The server could not be reached.", e);
        }
        catch (TaskCanceledException e) when (!cancellationToken.IsCancellationRequested)
        {
            throw new AgentTransportException("The server did not answer in time.", e);
        }
    }

    private static string? Single(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) && values.Count() == 1 ? values.First() : null;

    private static async Task<byte[]> ReadBoundedAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.Content.Headers.ContentLength > MaxResponseBytes) throw new AgentTransportException("The answer is too large.");
        using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellationToken).ConfigureAwait(false)) > 0)
        {
            if (buffer.Length + read > MaxResponseBytes) throw new AgentTransportException("The answer is too large.");
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    private static JsonElement Parse(byte[] bytes)
    {
        try
        {
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
            return document.RootElement.Clone();
        }
        catch (JsonException e)
        {
            throw new AgentTransportException("The answer was not JSON.", e);
        }
    }

    private static byte[] Json(Action<Utf8JsonWriter> write)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            write(writer);
            writer.WriteEndObject();
        }
        return buffer.ToArray();
    }
}
