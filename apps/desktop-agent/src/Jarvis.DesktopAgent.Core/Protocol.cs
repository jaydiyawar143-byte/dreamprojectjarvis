// ---------------------------------------------------------------------------
// Phase 19.6 — the desktop agent protocol, on the agent's side.
//
// The same contract as packages/core/src/desktop-agent.ts, written again in C#
// and held to it by the shared contract in apps/desktop-agent/contract:
// constants.json (these lists and limits), schemas.json (every message) and
// vectors.json (canonical strings, consent texts and signatures both sides must
// derive byte for byte). The contract tests fail on any drift.
// ---------------------------------------------------------------------------

using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Jarvis.DesktopAgent.Core;

public static class ProtocolConstants
{
    public const string ProtocolVersion = "jarvis-desktop/1";
    public const string AgentVersion = "1.0.0";
    public const string ConsentTextVersion = "desktop-consent/1";
    public const string KillSwitch = "Ctrl+Alt+Shift+F12";
    public const string PairingDevice = "pairing";

    public const string Click = "desktop.input.click";
    public const string Key = "desktop.input.key";
    public const string Type = "desktop.input.type";

    /// <summary>The v1 command set (D1, D4, D5): no screen reading, nothing that runs, opens or reads.</summary>
    public static readonly IReadOnlyList<string> CommandActions = [Click, Key, Type];

    /// <summary>D1: Windows Hello at the device, for each command, on top of the in-app approval.</summary>
    public static readonly IReadOnlyList<string> HelloActions = [Type];

    public static readonly IReadOnlyList<string> KeyNames =
        ["enter", "tab", "escape", "backspace", "delete", "arrowup", "arrowdown", "arrowleft", "arrowright"];

    public static readonly IReadOnlyList<string> MouseButtons = ["left", "right", "middle"];

    public static readonly IReadOnlyList<string> ErrorCodes =
    [
        "INVALID_REQUEST", "UNSUPPORTED_VERSION", "UNAUTHENTICATED", "REQUEST_EXPIRED", "REPLAY_DETECTED",
        "PAIRING_CODE_INVALID", "RATE_LIMITED", "DEVICE_PENDING", "DEVICE_REVOKED", "NOT_AUTHORIZED",
        "AGENT_VERSION_UNSUPPORTED", "WINDOWS_VERSION_UNSUPPORTED", "GRANT_INVALID", "GRANT_CONFLICT",
        "CONSENT_MISMATCH", "NOT_FOUND", "CONFLICT", "UNAVAILABLE",
    ];

    public static readonly IReadOnlyList<string> NotExecutedCodes =
    [
        "HELLO_UNAVAILABLE", "HELLO_FAILED", "ELEVATED_TARGET", "NO_TARGET", "OUT_OF_BOUNDS",
        "SESSION_LOCKED", "GRANT_INACTIVE", "COMMAND_EXPIRED", "INVALID_COMMAND", "BUSY",
    ];

    public static readonly IReadOnlyList<string> SessionEndReasons =
        ["user", "kill-switch", "lock", "sign-out", "shutdown", "expired", "disconnected"];

    public const long PairingCodeTtlMs = 10 * 60_000;
    public const long CommandTtlMs = 30_000;
    public const long ClockSkewMs = 60_000;
    public const int GrantDefaultMinutes = 15;
    public const int GrantMaxMinutes = 60;
    public const long ReconnectGraceMs = 30_000;
    public const long PollHoldMs = 20_000;
    public const int CoordinateMax = 100_000;
    public const int TypeTextMaxLength = 10_000;
    public const int Windows11FirstBuild = 22_000;
}

/// <summary>One command's parameters. Exactly one per action; nothing else can be expressed.</summary>
public abstract record CommandParams(string Action);

public sealed record ClickParams(int X, int Y, string Button) : CommandParams(ProtocolConstants.Click);

public sealed record KeyParams(string Key) : CommandParams(ProtocolConstants.Key);

public sealed record TypeParams(string Text) : CommandParams(ProtocolConstants.Type);

/// <summary>A command as the server signed it.</summary>
public sealed record CommandEnvelope(
    string CommandId,
    string DeviceId,
    string GrantId,
    CommandParams Params,
    long IssuedAt,
    long ExpiresAt,
    bool RequiresHello,
    string Signature)
{
    public string Action => Params.Action;
}

/// <summary>The signed strings. Fixed ASCII fields joined by LF: no JSON escaping to disagree about.</summary>
public static class Canonical
{
    public static string Request(string method, string path, string timestamp, string nonce, string device, string bodySha256) =>
        string.Join('\n', "jarvis-desktop-request/1", method.ToUpperInvariant(), path, timestamp, nonce, device, bodySha256);

    public static string Response(string requestNonce, int status, string bodySha256) =>
        string.Join('\n', "jarvis-desktop-response/1", requestNonce, status.ToString(CultureInfo.InvariantCulture), bodySha256);

    public static string Params(CommandParams parameters) => parameters switch
    {
        ClickParams c => $"x={c.X.ToString(CultureInfo.InvariantCulture)}&y={c.Y.ToString(CultureInfo.InvariantCulture)}&button={c.Button}",
        KeyParams k => $"key={k.Key}",
        TypeParams t => $"text={Base64Url.EncodeToString(Encoding.UTF8.GetBytes(t.Text))}",
        _ => throw new ArgumentException("Unknown command parameters.", nameof(parameters)),
    };

    public static string Command(CommandEnvelope e) =>
        string.Join(
            '\n',
            "jarvis-desktop-command/1",
            e.CommandId,
            e.DeviceId,
            e.GrantId,
            e.Action,
            Params(e.Params),
            e.IssuedAt.ToString(CultureInfo.InvariantCulture),
            e.ExpiresAt.ToString(CultureInfo.InvariantCulture),
            e.RequiresHello ? "1" : "0");

    public static string Sha256Hex(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    public static string Sha256Hex(string text) => Sha256Hex(Encoding.UTF8.GetBytes(text));
}

/// <summary>Key fingerprints, and the part a person compares on both screens.</summary>
public static class Fingerprint
{
    public static string Of(string spkiBase64) => Canonical.Sha256Hex(Convert.FromBase64String(spkiBase64));

    /// <summary>The first 96 bits as six groups of four, e.g. 3F2A-9C01-….</summary>
    public static string Display(string fingerprint) =>
        string.Join('-', Enumerable.Range(0, 6).Select(i => fingerprint.Substring(i * 4, 4).ToUpperInvariant()));

    public static string ServerKeyId(string spkiBase64) => Of(spkiBase64)[..16];
}

/// <summary>Pairing codes as typed: case, spaces and hyphens forgiven; I and L read as 1, O as 0.</summary>
public static class PairingCode
{
    private const string Crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    public static string? Normalize(string? input)
    {
        if (input is null || input.Length > 64) return null;
        var compact = new StringBuilder();
        foreach (var c in input.ToUpperInvariant())
        {
            if (char.IsWhiteSpace(c) || c == '-') continue;
            compact.Append(c switch { 'I' or 'L' => '1', 'O' => '0', _ => c });
        }
        if (compact.Length != 32) return null;
        foreach (var c in compact.ToString()) if (!Crockford.Contains(c, StringComparison.Ordinal)) return null;
        return compact.ToString();
    }

    public static string Hash(string normalized) => Canonical.Sha256Hex($"jarvis-desktop-pairing/1\n{normalized}");
}

/// <summary>
/// The consent wording (U5c), rendered exactly as the server renders it, so the
/// server can check the hash of the text the person saw.
/// </summary>
public static class ConsentText
{
    private static readonly Dictionary<string, string> ScopeLines = new()
    {
        [ProtocolConstants.Click] = "- click at positions on this screen",
        [ProtocolConstants.Key] = "- press Enter, Tab, Escape, Backspace, Delete and the arrow keys",
        [ProtocolConstants.Type] = "- type text, only after you verify each time with Windows Hello",
    };

    /// <summary>A grant's scope in the one order it is shown and signed in; null when it is not a valid scope.</summary>
    public static IReadOnlyList<string>? CanonicalScope(IReadOnlyCollection<string> scope)
    {
        if (scope.Count == 0 || scope.Distinct(StringComparer.Ordinal).Count() != scope.Count) return null;
        if (!scope.All(s => ProtocolConstants.CommandActions.Contains(s))) return null;
        return ProtocolConstants.CommandActions.Where(scope.Contains).ToList();
    }

    public static string Render(string userLabel, string organizationLabel, int durationMinutes, IReadOnlyCollection<string> scope)
    {
        var minutes = $"{durationMinutes.ToString(CultureInfo.InvariantCulture)} minute{(durationMinutes == 1 ? "" : "s")}";
        var lines = new List<string>
        {
            "Allow JARVIS to control this computer?",
            "",
            $"Requested by: {userLabel}",
            $"Organization: {organizationLabel}",
            $"Duration: {minutes}, starting when you choose Allow.",
            "",
            "JARVIS may:",
        };
        lines.AddRange(ProtocolConstants.CommandActions.Where(scope.Contains).Select(s => ScopeLines[s]));
        lines.Add("");
        lines.Add("JARVIS cannot see your screen, run programs or scripts, open, read or change files, use the clipboard, change settings, or act in windows that run as administrator.");
        lines.Add("");
        lines.Add($"Control ends after {minutes}, when you lock this computer, sign out or restart, or when you press {ProtocolConstants.KillSwitch}.");
        return string.Join('\n', lines);
    }

    public static string Sha256(string text) => Canonical.Sha256Hex(text);
}

/// <summary>Text a command may type: not empty, bounded, no control characters, well-formed.</summary>
public static class TypeableText
{
    public static bool IsValid(string? text)
    {
        if (string.IsNullOrEmpty(text) || text.Length > ProtocolConstants.TypeTextMaxLength) return false;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 >= text.Length || !char.IsLowSurrogate(text[i + 1])) return false;
                i++;
                continue;
            }
            if (char.IsLowSurrogate(c)) return false;
            if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c == '\u2028' || c == '\u2029') return false;
        }
        return true;
    }
}
