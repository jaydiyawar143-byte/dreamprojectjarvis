// ---------------------------------------------------------------------------
// Phase 19.6 — pairing, from the computer's side.
//
// The person types the server's https:// address and the code an Owner or
// Admin generated on the Computer Control page. After the server answers, the
// screen shows this computer's key fingerprint and the server's key id: the
// device stays inactive until its user confirms that same fingerprint in the
// web page. The code is sent once and never stored.
// ---------------------------------------------------------------------------

using Jarvis.DesktopAgent.Core;

namespace Jarvis.DesktopAgent.UI;

internal sealed class PairingForm : Form
{
    private readonly TextBox server = new() { Width = 360, PlaceholderText = "https://jarvis.example.com" };
    private readonly TextBox code = new() { Width = 360, PlaceholderText = "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", CharacterCasing = CharacterCasing.Upper };
    private readonly Button pair = new() { Text = "Pair", AutoSize = true };
    private readonly Label status = new() { AutoSize = true, MaximumSize = new Size(380, 0) };
    private readonly Func<Uri, string, Task<(PairResponse? Paired, string? Error)>> pairAsync;

    public PairingForm(Func<Uri, string, Task<(PairResponse? Paired, string? Error)>> pairAsync)
    {
        this.pairAsync = pairAsync;
        Text = "JARVIS — pair this computer";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(12);
        var layout = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
        layout.Controls.Add(new Label { Text = "Server address", AutoSize = true });
        layout.Controls.Add(server);
        layout.Controls.Add(new Label { Text = "Pairing code (from the Computer Control page)", AutoSize = true });
        layout.Controls.Add(code);
        layout.Controls.Add(pair);
        layout.Controls.Add(status);
        Controls.Add(layout);
        AcceptButton = pair;
        pair.Click += async (_, _) => await PairAsync().ConfigureAwait(true);
    }

    public PairResponse? Paired { get; private set; }

    /// <summary>The https:// origin the pairing was made with.</summary>
    public Uri? Server { get; private set; }

    private async Task PairAsync()
    {
        if (!Uri.TryCreate(server.Text.Trim(), UriKind.Absolute, out var origin) || origin.Scheme != Uri.UriSchemeHttps)
        {
            status.Text = "Enter the server's https:// address.";
            return;
        }
        if (PairingCode.Normalize(code.Text) is null)
        {
            status.Text = "That is not a pairing code. It has 32 letters and digits.";
            return;
        }
        pair.Enabled = false;
        status.Text = "Pairing…";
        var root = new Uri(origin.GetLeftPart(UriPartial.Authority) + "/");
        var (paired, error) = await pairAsync(root, code.Text).ConfigureAwait(true);
        code.Text = "";
        if (paired is null)
        {
            pair.Enabled = true;
            status.Text = error switch
            {
                "PAIRING_CODE_INVALID" => "The code was not accepted. Codes work once and for ten minutes; ask for a new one.",
                "RATE_LIMITED" => "Too many attempts. Wait a few minutes.",
                "WINDOWS_VERSION_UNSUPPORTED" or "AGENT_VERSION_UNSUPPORTED" => "This computer or this agent version is not supported by the server. Update Windows or the agent.",
                null => "The server could not be reached, or its answer could not be verified.",
                _ => "Pairing was refused.",
            };
            return;
        }
        Paired = paired;
        Server = root;
        status.Text =
            $"Paired, and waiting for confirmation.{Environment.NewLine}{Environment.NewLine}" +
            $"On the Computer Control page, confirm this fingerprint:{Environment.NewLine}{Fingerprint.Display(paired.Fingerprint)}{Environment.NewLine}{Environment.NewLine}" +
            $"Server key: {paired.ServerKeyId}{Environment.NewLine}" +
            $"Requested by {AgentLogText(paired.UserLabel)} for {AgentLogText(paired.OrganizationLabel)}.";
    }

    private static string AgentLogText(string value) => AgentLog.Printable(value, 80);
}
