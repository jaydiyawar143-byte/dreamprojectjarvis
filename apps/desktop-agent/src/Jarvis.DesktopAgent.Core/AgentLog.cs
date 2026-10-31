// ---------------------------------------------------------------------------
// Phase 19.6 — the agent's local log, value-free.
//
// An event name, then fields from a fixed list whose values are identifiers,
// codes, enums or counts. Anything else — typed text, a window title, a
// pairing code, a key, coordinates, a server's words — has no field to go in,
// and a value that does not look like an identifier is replaced, never
// written.
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
        "commandId", "deviceId", "grantId", "action", "outcome", "code", "reason", "status",
        "durationMinutes", "scopeCount", "attempt", "windowsBuild", "agentVersion",
    ];

    [GeneratedRegex("^[a-z][a-z0-9.]{0,63}$")]
    private static partial Regex EventShape();

    [GeneratedRegex("^[A-Za-z0-9._:-]{1,64}$")]
    private static partial Regex ValueShape();

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
                line.Append(' ').Append(field).Append('=').Append(Render(value));
            }
            sink.Append(line.ToString());
        }
#pragma warning disable CA1031 // A log that cannot be written never stops the agent.
        catch (Exception)
#pragma warning restore CA1031
        {
        }
    }

    private static string Render(object value) => value switch
    {
        int or long => Convert.ToString(value, CultureInfo.InvariantCulture)!,
        bool b => b ? "true" : "false",
        string s when ValueShape().IsMatch(s) => s,
        _ => "[withheld]",
    };

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
