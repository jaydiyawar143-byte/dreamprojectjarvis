// ---------------------------------------------------------------------------
// Phase 19.6 — what the tray says and allows, decided here so it can be tested
// without a tray. The tray only draws it.
// ---------------------------------------------------------------------------

namespace Jarvis.DesktopAgent.Core;

public sealed record TrayView(string Status, bool CanPair, bool CanAllow, bool CanExtend, bool CanStop)
{
    public static TrayView Of(bool paired, string? deviceStatus, bool connected, bool halted, bool hasGrant, bool pairingOpen = false) => new(
        !paired ? "Not paired"
            : halted ? "Stopped — quit and start the agent again"
            : deviceStatus == "pending" ? "Waiting for confirmation in JARVIS"
            : !connected ? "Not connected"
            : !hasGrant ? "Paired — control not allowed"
            : "Control allowed",
        CanPair: !hasGrant && !pairingOpen,
        CanAllow: paired && !halted && deviceStatus == "active" && connected && !hasGrant,
        CanExtend: hasGrant,
        CanStop: hasGrant);

    /// <summary>What the person is told when the agent stops for good.</summary>
    public static string StoppedMessage(string reason) => reason switch
    {
        "revoked" => "This computer was removed from JARVIS. Pair it again to use it.",
        "unsupported" => "This agent or this version of Windows is no longer supported. Update to continue.",
        "failed" => "JARVIS stopped contacting the server after repeated errors. Any control has ended. Quit and start the agent again.",
        _ => "This computer's owner can no longer use it with JARVIS.",
    };
}
