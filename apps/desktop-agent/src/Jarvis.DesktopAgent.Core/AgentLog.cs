// ---------------------------------------------------------------------------
// Phase 19.6 — the agent's local log, value-free.
//
// An event name, then fields from a fixed list whose values are identifiers,
// codes, enums or counts. Anything else — typed text, a window title, a
// pairing code, a key, coordinates, a server's words — has no field to go in,
// and a value that is not the shape of its field is replaced, never written.
// A device appears only as a hash, the same one the API logs, so one device
// can be followed across both logs without either naming it.
// ---------------------------------------------------------------------------

using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Jarvis.DesktopAgent.Core;

public interface ILogSink
{
    void Append(string line);
}

public sealed partial class AgentLog(ILogSink sink, IClock clock)
{
    /// <summary>The only fields a log line may carry.</summary>
    public static readonly IReadOnlyList<string> Fields =
    [
        "commandId", "deviceIdHash", "grantId", "action", "outcome", "code", "reason", "status",
        "durationMinutes", "scopeCount", "attempt", "httpStatus", "retryInMs", "windowsBuild", "agentVersion",
    ];

    // \z, not $: in .NET, $ also matches before a final line break, and a value
    // that ends in one could start a line of its own.
    [GeneratedRegex(@"^[a-z][a-z0-9.]{0,63}\z")]
    private static partial Regex EventShape();

    [GeneratedRegex(@"^[A-Za-z0-9._:-]{1,64}\z")]
    private static partial Regex ValueShape();

    [GeneratedRegex(@"^[A-Z][A-Z0-9_]{0,63}\z")]
    private static partial Regex CodeShape();

    /// <summary>Words and dashes: with no digits, neither a pairing code nor an id fits.</summary>
    [GeneratedRegex(@"^[A-Za-z][A-Za-z_-]{0,63}\z")]
    private static partial Regex ReasonShape();

    [GeneratedRegex(@"^[0-9a-f]{16}\z")]
    private static partial Regex DeviceIdHashShape();

    public void Write(string name, params (string Field, object? Value)[] fields)
    {
        try
        {
            var line = new StringBuilder();
            line.Append(DateTimeOffset.FromUnixTimeMilliseconds(clock.NowMs).ToString("O", CultureInfo.InvariantCulture));
            line.Append(' ').Append(EventShape().IsMatch(name) ? name : "event.invalid");
            foreach (var (field, value) in fields)
            {
                if (value is null) continue;
                if (!Fields.Contains(field)) continue;
                line.Append(' ').Append(field).Append('=').Append(Render(field, value));
            }
            sink.Append(line.ToString());
        }
#pragma warning disable CA1031 // A log that cannot be written never stops the agent.
        catch (Exception)
#pragma warning restore CA1031
        {
        }
    }

    private static string Render(string field, object value) => value switch
    {
        int or long when Counts(field, Convert.ToInt64(value, CultureInfo.InvariantCulture)) => Convert.ToString(value, CultureInfo.InvariantCulture)!,
        bool b => b ? "true" : "false",
        string s when Shape(field)?.IsMatch(s) == true => s,
        _ => "[withheld]",
    };

    /// <summary>A number belongs only in a field that counts, and only in the range that field can hold.</summary>
    private static bool Counts(string field, long value) => field switch
    {
        "httpStatus" => value is >= 100 and <= 599,
        "attempt" or "retryInMs" or "durationMinutes" or "scopeCount" or "windowsBuild" => value >= 0,
        _ => false,
    };

    /// <summary>The strings a field can hold. A field that counts holds none.</summary>
    private static Regex? Shape(string field) => field switch
    {
        "httpStatus" or "attempt" or "retryInMs" or "durationMinutes" or "scopeCount" or "windowsBuild" => null,
        "code" => CodeShape(),
        "reason" => ReasonShape(),
        "deviceIdHash" => DeviceIdHashShape(),
        _ => ValueShape(),
    };

    /// <summary>A device in a log line: the first 16 hex characters of its id's SHA-256, as the API logs it.</summary>
    public static string DeviceIdHash(string deviceId) => Canonical.Sha256Hex(deviceId)[..16];

    /// <summary>Text made safe to show a person: printable characters only, bounded. For screens, never for the log.</summary>
    public static string Printable(string? text, int max)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var builder = new StringBuilder();
        foreach (var rune in text.EnumerateRunes())
        {
            if (builder.Length + rune.Utf16SequenceLength > max) break;
            var category = Rune.GetUnicodeCategory(rune);
            if (category is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator
                or UnicodeCategory.ParagraphSeparator or UnicodeCategory.Surrogate or UnicodeCategory.PrivateUse
                or UnicodeCategory.OtherNotAssigned)
                continue;
            builder.Append(rune.ToString());
        }
        return builder.ToString().Trim();
    }
}
