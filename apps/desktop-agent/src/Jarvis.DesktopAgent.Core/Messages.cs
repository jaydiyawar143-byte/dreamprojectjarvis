// ---------------------------------------------------------------------------
// Phase 19.6 — signatures, and strict parsing of what the server sends.
//
// Every message the agent acts on is parsed field by field from JSON: an
// unknown property, an unknown action, a value of the wrong type or out of
// bounds is a refusal — never a default, never ignored. And nothing is acted
// on unless the server's signature over it verifies against the key pinned at
// pairing.
// ---------------------------------------------------------------------------

using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jarvis.DesktopAgent.Core;

/// <summary>The device's private key. Signs; never exports.</summary>
public interface IDeviceKey
{
    /// <summary>Base64 SubjectPublicKeyInfo of the ECDSA P-256 public key.</summary>
    string PublicKeySpki { get; }

    /// <summary>ECDSA P-256 over SHA-256, IEEE P1363 (64 bytes).</summary>
    byte[] Sign(byte[] data);
}

public static partial class Signatures
{
    [GeneratedRegex("^[A-Za-z0-9_-]{86}$")]
    private static partial Regex SignatureShape();

    /// <summary>Verifies a base64url IEEE P1363 signature against a P-256 public key. Anything malformed is false.</summary>
    public static bool Verify(string spkiBase64, string canonical, string? signature)
    {
        if (signature is null || !SignatureShape().IsMatch(signature)) return false;
        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(spkiBase64), out _);
            if (key.KeySize != 256) return false;
            return key.VerifyData(
                System.Text.Encoding.UTF8.GetBytes(canonical),
                System.Buffers.Text.Base64Url.DecodeFromChars(signature),
                HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (Exception e) when (e is CryptographicException or FormatException or ArgumentException)
        {
            return false;
        }
    }

    public static string Sign(IDeviceKey key, string canonical) =>
        System.Buffers.Text.Base64Url.EncodeToString(key.Sign(System.Text.Encoding.UTF8.GetBytes(canonical)));
}

/// <summary>A message that does not have exactly the declared shape.</summary>
public sealed class ProtocolViolationException(string message) : Exception(message);

public sealed record PairResponse(
    string DeviceId,
    string Fingerprint,
    string ServerKeyId,
    string ServerPublicKey,
    string UserLabel,
    string OrganizationLabel);

public sealed record GrantState(string GrantId, string Status, long ExpiresAt);

public sealed record PollResponse(string DeviceStatus, GrantState? Grant, CommandEnvelope? Command);

public static partial class MessageParser
{
    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")]
    private static partial Regex UuidShape();

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex Sha256Shape();

    [GeneratedRegex("^[0-9a-f]{16}$")]
    private static partial Regex KeyIdShape();

    private static JsonElement Object(JsonElement value, params string[] fields)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new ProtocolViolationException("not an object");
        var names = value.EnumerateObject().Select(p => p.Name).ToList();
        if (names.Count != names.Distinct(StringComparer.Ordinal).Count()) throw new ProtocolViolationException("duplicate field");
        foreach (var name in names) if (!fields.Contains(name)) throw new ProtocolViolationException("unknown field");
        foreach (var field in fields) if (!value.TryGetProperty(field, out _)) throw new ProtocolViolationException("missing field");
        return value;
    }

    private static string Text(JsonElement value, string name, int max = 512)
    {
        var element = value.GetProperty(name);
        if (element.ValueKind != JsonValueKind.String) throw new ProtocolViolationException("not a string");
        var text = element.GetString()!;
        if (text.Length == 0 || text.Length > max) throw new ProtocolViolationException("bad length");
        return text;
    }

    private static string Uuid(JsonElement value, string name)
    {
        var text = Text(value, name, 36);
        return UuidShape().IsMatch(text) ? text : throw new ProtocolViolationException("not a uuid");
    }

    private static long Integer(JsonElement value, string name, long min, long max)
    {
        var element = value.GetProperty(name);
        if (element.ValueKind != JsonValueKind.Number || !element.TryGetInt64(out var number)) throw new ProtocolViolationException("not an integer");
        return number >= min && number <= max ? number : throw new ProtocolViolationException("out of range");
    }

    private static bool Boolean(JsonElement value, string name)
    {
        var element = value.GetProperty(name);
        return element.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw new ProtocolViolationException("not a boolean"),
        };
    }

    private static string OneOf(JsonElement value, string name, IReadOnlyList<string> allowed)
    {
        var text = Text(value, name, 64);
        return allowed.Contains(text) ? text : throw new ProtocolViolationException("not allowed");
    }

    private static void Version(JsonElement value)
    {
        if (Text(value, "version", 32) != ProtocolConstants.ProtocolVersion) throw new ProtocolViolationException("unsupported version");
    }

    public static PairResponse ParsePairResponse(JsonElement root)
    {
        Object(root, "version", "deviceId", "fingerprint", "status", "serverKeyId", "serverPublicKey", "userLabel", "organizationLabel");
        Version(root);
        if (Text(root, "status", 16) != "pending") throw new ProtocolViolationException("unexpected status");
        var fingerprint = Text(root, "fingerprint", 64);
        var keyId = Text(root, "serverKeyId", 16);
        if (!Sha256Shape().IsMatch(fingerprint) || !KeyIdShape().IsMatch(keyId)) throw new ProtocolViolationException("bad key identity");
        var serverKey = Text(root, "serverPublicKey", 200);
        if (Fingerprint.ServerKeyId(serverKey) != keyId) throw new ProtocolViolationException("server key id does not match its key");
        return new PairResponse(Uuid(root, "deviceId"), fingerprint, keyId, serverKey, Text(root, "userLabel", 80), Text(root, "organizationLabel", 80));
    }

    public static string? ParseErrorCode(JsonElement root)
    {
        try
        {
            Object(root, "version", "error");
            Version(root);
            var error = Object(root.GetProperty("error"), "code");
            return OneOf(error, "code", ProtocolConstants.ErrorCodes);
        }
        catch (ProtocolViolationException)
        {
            return null;
        }
        catch (KeyNotFoundException)
        {
            return null;
        }
    }

    public static GrantState ParseGrantResponse(JsonElement root)
    {
        Object(root, "version", "grant");
        Version(root);
        return ParseGrantState(root.GetProperty("grant"));
    }

    private static GrantState ParseGrantState(JsonElement value)
    {
        Object(value, "grantId", "status", "expiresAt");
        return new GrantState(Uuid(value, "grantId"), OneOf(value, "status", ["active", "ended"]), Integer(value, "expiresAt", 0, long.MaxValue));
    }

    public static PollResponse ParsePollResponse(JsonElement root)
    {
        Object(root, "version", "device", "grant", "command");
        Version(root);
        var device = Object(root.GetProperty("device"), "status");
        var status = OneOf(device, "status", ["pending", "active"]);
        var grant = root.GetProperty("grant").ValueKind == JsonValueKind.Null ? null : ParseGrantState(root.GetProperty("grant"));
        var command = root.GetProperty("command").ValueKind == JsonValueKind.Null ? null : ParseCommand(root.GetProperty("command"));
        return new PollResponse(status, grant, command);
    }

    /// <summary>A command, only if it is exactly one of the three v1 shapes.</summary>
    public static CommandEnvelope ParseCommand(JsonElement value)
    {
        Object(value, "commandId", "deviceId", "grantId", "action", "params", "issuedAt", "expiresAt", "requiresHello", "signature");
        var action = OneOf(value, "action", ProtocolConstants.CommandActions);
        var parameters = value.GetProperty("params");
        CommandParams parsed = action switch
        {
            ProtocolConstants.Click => ParseClick(parameters),
            ProtocolConstants.Key => new KeyParams(OneOf(Object(parameters, "key"), "key", ProtocolConstants.KeyNames)),
            ProtocolConstants.Type => ParseType(parameters),
            ProtocolConstants.AppLaunch => new LaunchParams(OneOf(Object(parameters, "app"), "app", ProtocolConstants.AppIds)),
            _ => throw new ProtocolViolationException("unknown action"),
        };
        var signature = Text(value, "signature", 86);
        return new CommandEnvelope(
            Uuid(value, "commandId"),
            Uuid(value, "deviceId"),
            Uuid(value, "grantId"),
            parsed,
            Integer(value, "issuedAt", 0, long.MaxValue),
            Integer(value, "expiresAt", 0, long.MaxValue),
            Boolean(value, "requiresHello"),
            signature);
    }

    private static ClickParams ParseClick(JsonElement value)
    {
        Object(value, "x", "y", "button");
        return new ClickParams(
            (int)Integer(value, "x", 0, ProtocolConstants.CoordinateMax),
            (int)Integer(value, "y", 0, ProtocolConstants.CoordinateMax),
            OneOf(value, "button", ProtocolConstants.MouseButtons));
    }

    private static TypeParams ParseType(JsonElement value)
    {
        Object(value, "text");
        var text = Text(value, "text", ProtocolConstants.TypeTextMaxLength);
        return TypeableText.IsValid(text) ? new TypeParams(text) : throw new ProtocolViolationException("text cannot be typed");
    }
}
